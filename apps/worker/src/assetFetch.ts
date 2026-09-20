import type { JobEvent } from '@wptossg/shared';
import { createJobEvent } from '@wptossg/shared';
import { isWithinSiteDomain, resolveCdnMapping, STATIC_CONVERSION_RULE } from '@wptossg/config';
import { load } from 'cheerio';
import type { RenderedPageSnapshot } from './index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AssetEntry {
  /** Absolute URL as found in the original HTML */
  originalUrl: string;
  /** Local relative path used after rewriting (e.g. assets/foo.css) */
  localPath: string;
  /** Fetched binary content – undefined when fetch failed */
  content?: Buffer;
  /** Content-Type from the response, if available */
  contentType?: string;
  fetchError?: string;
}

export interface RewrittenPageSnapshot extends RenderedPageSnapshot {
  /** HTML after URL rewriting */
  rewrittenHtml: string;
}

export interface AssetFetchAndRewriteOptions {
  /** Base URL of the site being converted */
  siteUrl: string;
  /** Root directory where rewritten snapshots will be stored */
  snapshotRootDir?: string;
  /** Fetch timeout in milliseconds (default: 30 000) */
  fetchTimeoutMs?: number;
  /** Maximum number of concurrent asset fetches (default: 5) */
  concurrency?: number;
}

export interface AssetFetchAndRewriteResult {
  pages: RewrittenPageSnapshot[];
  assets: AssetEntry[];
  events: JobEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 5;
const ASSET_DIR = 'assets';

// Attributes that contain asset or link URLs, grouped by tag.
// We only follow known patterns to avoid polluting the asset list.
const ASSET_SELECTORS: Array<{ selector: string; attr: string }> = [
  { selector: 'script[src]', attr: 'src' },
  { selector: 'link[href]', attr: 'href' },
  { selector: 'img[src]', attr: 'src' },
  { selector: 'img[srcset]', attr: 'srcset' },
  { selector: 'source[src]', attr: 'src' },
  { selector: 'source[srcset]', attr: 'srcset' },
  { selector: 'video[src]', attr: 'src' },
  { selector: 'audio[src]', attr: 'src' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAssetEvent(
  jobId: string,
  type: JobEvent['type'],
  message: string,
  details?: Record<string, unknown>,
): JobEvent {
  return createJobEvent({
    jobId,
    stage: 'ASSET_FETCH_AND_REWRITE',
    type,
    message,
    details,
  });
}

/**
 * Derive a deterministic local path for an asset URL.
 * Example: https://example.com/wp-content/themes/main.css → assets/wp-content/themes/main.css
 */
function assetUrlToLocalPath(assetUrl: string): string {
  try {
    const parsed = new URL(assetUrl);
    // strip leading slash, remove query/hash, sanitise
    const sanitised = parsed.pathname
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9/._-]/g, '_');
    return `${ASSET_DIR}/${sanitised || 'asset'}`;
  } catch {
    const fallback = encodeURIComponent(assetUrl).replace(/%/g, '_');
    return `${ASSET_DIR}/${fallback}`;
  }
}

/**
 * Given a local asset path and the snapshot file path, compute the relative
 * reference so the rewritten HTML can load the asset from disk.
 * Both paths are relative to snapshotRootDir.
 */
function relativePathFromSnapshot(snapshotPath: string, localAssetPath: string): string {
  // snapshotPath: example.com/some/page.html
  // localAssetPath: assets/wp-content/style.css
  // result: ../../assets/wp-content/style.css
  const snapshotSegments = snapshotPath.split('/').slice(0, -1); // directory parts
  const assetSegments = localAssetPath.split('/');

  let commonLength = 0;
  const minLen = Math.min(snapshotSegments.length, assetSegments.length);
  for (let i = 0; i < minLen; i++) {
    if (snapshotSegments[i] === assetSegments[i]) {
      commonLength = i + 1;
    } else {
      break;
    }
  }

  const ups = snapshotSegments.length - commonLength;
  const down = assetSegments.slice(commonLength);
  return [...Array(ups).fill('..'), ...down].join('/') || '.';
}

/**
 * Extract all unique asset URLs from srcset values.
 * "image-320w.jpg 320w, image-640w.jpg 640w" → ["image-320w.jpg", "image-640w.jpg"]
 */
function parseSrcset(srcset: string, base: string): string[] {
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim().split(/\s+/)[0];
      if (!trimmed) return '';
      try {
        return new URL(trimmed, base).toString();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * Resolve an attribute value to an absolute URL.
 * Returns undefined if the value is empty, a data: URI, or cannot be resolved.
 */
function resolveUrl(value: string | undefined | null, base: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) {
    return undefined;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

/** Run up to `concurrency` promises in parallel using a simple queue. */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Collect all internal asset URLs from a list of rendered snapshots.
 * External URLs are kept intact (not returned for downloading).
 * Known CDN libraries are mapped to their CDN URL (no download required).
 */
export function collectAssetUrls(
  snapshots: RenderedPageSnapshot[],
  siteUrl: string,
): Map<string, AssetEntry> {
  const entries = new Map<string, AssetEntry>();

  for (const snapshot of snapshots) {
    const $ = load(snapshot.html);
    const base = snapshot.finalUrl || snapshot.url;

    for (const { selector, attr } of ASSET_SELECTORS) {
      $(selector).each((_, element) => {
        const rawValue = $(element).attr(attr);

        if (attr === 'srcset' && rawValue) {
          for (const url of parseSrcset(rawValue, base)) {
            processAssetUrl(url, siteUrl, entries);
          }
          return;
        }

        const resolved = resolveUrl(rawValue, base);
        if (resolved) {
          processAssetUrl(resolved, siteUrl, entries);
        }
      });
    }
  }

  return entries;
}

function processAssetUrl(
  url: string,
  siteUrl: string,
  entries: Map<string, AssetEntry>,
): void {
  if (entries.has(url)) return;

  // CDN conversion: known libraries are remapped regardless of origin
  const cdnUrl = resolveCdnMapping(url);
  if (cdnUrl) {
    // We record the mapping but do not download the CDN resource
    entries.set(url, { originalUrl: url, localPath: cdnUrl });
    return;
  }

  // Only download same-domain assets
  if (!isWithinSiteDomain(url, siteUrl)) {
    return; // external – leave intact
  }

  // Check extension allowlist
  if (!STATIC_CONVERSION_RULE.allowedExtensions.some((ext) => {
    try {
      return new URL(url).pathname.toLowerCase().endsWith(ext);
    } catch {
      return false;
    }
  })) {
    return;
  }

  entries.set(url, {
    originalUrl: url,
    localPath: assetUrlToLocalPath(url),
  });
}

/**
 * Fetch the binary content of a single asset.
 */
async function fetchAsset(entry: AssetEntry, timeoutMs: number): Promise<AssetEntry> {
  // CDN-mapped entries (localPath is a full https:// URL) are not fetched
  if (entry.localPath.startsWith('http')) {
    return entry;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(entry.originalUrl, { signal: controller.signal });
      if (!response.ok) {
        return { ...entry, fetchError: `HTTP ${response.status} ${response.statusText}` };
      }
      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') ?? undefined;
      return { ...entry, content: Buffer.from(arrayBuffer), contentType };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ...entry, fetchError: normalizeError(error) };
  }
}

/**
 * Rewrite the HTML of a single snapshot so that:
 * - Internal asset URLs become relative local paths
 * - Known CDN library URLs are replaced with their canonical CDN URLs
 * - External URLs are left untouched
 */
export function rewriteSnapshotHtml(
  snapshot: RenderedPageSnapshot,
  assetEntries: Map<string, AssetEntry>,
  siteUrl: string,
): string {
  const $ = load(snapshot.html);
  const base = snapshot.finalUrl || snapshot.url;
  const snapshotDir = snapshot.snapshotPath;

  for (const { selector, attr } of ASSET_SELECTORS) {
    $(selector).each((_, element) => {
      const rawValue = $(element).attr(attr);

      if (attr === 'srcset' && rawValue) {
        const rewritten = rawValue
          .split(',')
          .map((part) => {
            const trimmed = part.trim();
            const parts = trimmed.split(/\s+/);
            const urlPart = parts[0] ?? '';
            const descriptor = parts.slice(1).join(' ');
            const resolved = resolveUrl(urlPart, base);
            if (!resolved) return part;
            const entry = assetEntries.get(resolved);
            if (!entry) return part;
            const replacement = entry.localPath.startsWith('http')
              ? entry.localPath
              : relativePathFromSnapshot(snapshotDir, entry.localPath);
            return descriptor ? `${replacement} ${descriptor}` : replacement;
          })
          .join(', ');
        $(element).attr(attr, rewritten);
        return;
      }

      const resolved = resolveUrl(rawValue, base);
      if (!resolved) return;

      const entry = assetEntries.get(resolved);
      if (!entry) return;

      const replacement = entry.localPath.startsWith('http')
        ? entry.localPath
        : relativePathFromSnapshot(snapshotDir, entry.localPath);
      $(element).attr(attr, replacement);
    });
  }

  // Rewrite <a href> for internal pages (keep asset hrefs already handled above)
  $('a[href]').each((_, element) => {
    const rawHref = $(element).attr('href');
    if (!rawHref) return;
    const trimmed = rawHref.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
      return;
    }
    const resolved = resolveUrl(trimmed, base);
    if (!resolved) return;

    // Only rewrite same-site page links; leave external links intact
    if (!isWithinSiteDomain(resolved, siteUrl)) return;

    // If it was already rewritten as an asset, skip
    if (assetEntries.has(resolved)) return;

    // Compute relative path for the linked HTML page
    const linkedSnapshotPath = toLocalHtmlPath(resolved);
    const relative = relativePathFromSnapshot(snapshotDir, linkedSnapshotPath);
    $(element).attr('href', relative);
  });

  return $.html();
}

/** Mirror of the worker's toSnapshotPath logic, producing a root-relative path. */
function toLocalHtmlPath(url: string): string {
  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname === '/' ? '/index' : parsed.pathname.replace(/\/+$/, '');
    const sanitized = normalizedPath
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9/_-]/g, '_')
      .replace(/\/{2,}/g, '/');
    const suffix = parsed.search ? `_${encodeURIComponent(parsed.search).replace(/%/g, '_')}` : '';
    const pathname = sanitized || 'index';
    return `${parsed.hostname}/${pathname}${suffix}.html`.replace(/\/{2,}/g, '/');
  } catch {
    return encodeURIComponent(url).replace(/%/g, '_') + '.html';
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * ASSET_FETCH_AND_REWRITE stage.
 *
 * 1. Collect all internal asset URLs from the provided HTML snapshots.
 * 2. Fetch internal assets (skipping CDN remaps and external URLs).
 * 3. Rewrite each snapshot's HTML so asset references point to local paths.
 *
 * Per the AGENTS.md spec: "外部参照は原則維持する" – external URLs are never
 * rewritten (unless they match a CDN mapping rule).
 */
export async function fetchAndRewriteAssets(
  jobId: string,
  snapshots: RenderedPageSnapshot[],
  options: AssetFetchAndRewriteOptions,
): Promise<AssetFetchAndRewriteResult> {
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const events: JobEvent[] = [];

  events.push(
    createAssetEvent(jobId, 'stage_progress', 'Asset fetch and rewrite started', {
      pageCount: snapshots.length,
    }),
  );

  if (snapshots.length === 0) {
    events.push(createAssetEvent(jobId, 'warning', 'No snapshots provided; skipping asset stage'));
    return { pages: [], assets: [], events };
  }

  // Step 1: collect asset URLs
  const assetMap = collectAssetUrls(snapshots, options.siteUrl);

  events.push(
    createAssetEvent(jobId, 'stage_progress', 'Asset URLs collected', {
      internalAssetCount: [...assetMap.values()].filter((e) => !e.localPath.startsWith('http')).length,
      cdnRemappedCount: [...assetMap.values()].filter((e) => e.localPath.startsWith('http')).length,
    }),
  );

  // Step 2: fetch internal assets concurrently
  const entriesToFetch = [...assetMap.values()].filter((e) => !e.localPath.startsWith('http'));
  const fetchTasks = entriesToFetch.map((entry) => () => fetchAsset(entry, timeoutMs));
  const fetched = await runWithConcurrency(fetchTasks, concurrency);

  let successCount = 0;
  let failCount = 0;
  for (const result of fetched) {
    assetMap.set(result.originalUrl, result);
    if (result.fetchError) {
      failCount++;
      events.push(
        createAssetEvent(jobId, 'warning', 'Asset fetch failed', {
          url: result.originalUrl,
          reason: result.fetchError,
        }),
      );
    } else {
      successCount++;
    }
  }

  events.push(
    createAssetEvent(jobId, 'stage_progress', 'Assets fetched', {
      successCount,
      failCount,
    }),
  );

  // Step 3: rewrite HTML
  const pages: RewrittenPageSnapshot[] = snapshots.map((snapshot) => ({
    ...snapshot,
    rewrittenHtml: rewriteSnapshotHtml(snapshot, assetMap, options.siteUrl),
  }));

  events.push(
    createAssetEvent(jobId, 'stage_progress', 'Asset fetch and rewrite finished', {
      pageCount: pages.length,
      assetCount: assetMap.size,
    }),
  );

  return {
    pages,
    assets: [...assetMap.values()],
    events,
  };
}
