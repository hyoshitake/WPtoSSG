import type { JobEvent } from '@wptossg/shared';
import { createJobEvent, pageUrlToRelativePath } from '@wptossg/shared';
import { isWithinSiteDomain, resolveCdnMapping, STATIC_CONVERSION_RULE } from '@wptossg/config';
import { load } from 'cheerio';
import type { RenderedPageSnapshot } from './index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Represents a single asset discovered in the HTML.
 *
 * `isCdnMapped` distinguishes two cases:
 *  - `false` (default): `localPath` is a relative on-disk path (e.g. `assets/wp-content/style.css`).
 *  - `true`: `cdnUrl` holds the canonical CDN URL to use as-is; no download is needed.
 */
export type AssetEntry =
  | {
      isCdnMapped: false;
      originalUrl: string;
      localPath: string;
      content?: Buffer;
      contentType?: string;
      fetchError?: string;
    }
  | {
      isCdnMapped: true;
      originalUrl: string;
      cdnUrl: string;
    };

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

/**
 * URL schemes that must never be fetched or rewritten.
 * This list covers the schemes flagged by the js/incomplete-url-scheme-check rule.
 */
const UNSAFE_SCHEMES = ['data:', 'javascript:', 'vbscript:'];

// Attributes that contain asset or link URLs, grouped by tag.
// `link[href]` is intentionally limited to stylesheet relations to avoid
// rewriting canonical, alternate, preconnect, and other metadata hrefs.
const ASSET_SELECTORS: Array<{ selector: string; attr: string }> = [
  { selector: 'script[src]', attr: 'src' },
  { selector: 'link[rel~="stylesheet"][href]', attr: 'href' },
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
 *
 * Path traversal sequences (`..`) are removed to prevent writing outside ASSET_DIR.
 */
function assetUrlToLocalPath(assetUrl: string): string {
  try {
    const parsed = new URL(assetUrl);
    // Sanitize individual path segments; filter out empty segments and traversal attempts.
    const segments = parsed.pathname
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
      .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '_'));
    const sanitised = segments.join('/');
    return `${ASSET_DIR}/${sanitised || 'asset'}`;
  } catch {
    const fallback = encodeURIComponent(assetUrl).replace(/%/g, '_');
    return `${ASSET_DIR}/${fallback}`;
  }
}

/**
 * Given a local asset path and the snapshot file path, compute the relative
 * reference so the rewritten HTML can load the asset from disk.
 * Both paths are normalised to root-relative form (leading slashes and any
 * leading root directory segment are stripped) before computing the relative path.
 */
function relativePathFromSnapshot(snapshotPath: string, localAssetPath: string): string {
  // Strip leading slashes so absolute filesystem paths (/snapshots/example.com/page.html)
  // are treated the same as root-relative ones (example.com/page.html).
  const normalizeSegments = (p: string): string[] => p.replace(/^\/+/, '').split('/').filter(Boolean);

  const snapshotSegments = normalizeSegments(snapshotPath).slice(0, -1); // directory parts
  const assetSegments = normalizeSegments(localAssetPath);

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
 *
 * Splits on `,` followed by whitespace (`,\s+`) rather than a bare `,` to
 * avoid incorrectly splitting URLs that contain a comma in their query string
 * (e.g. `img.jpg?a=1,b=2 640w`).
 */
function parseSrcset(srcset: string, base: string): string[] {
  return srcset
    .split(/,\s*/)
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
 * Return true if the value starts with any of the unsafe schemes.
 * Normalised to lowercase before comparison.
 */
function hasUnsafeScheme(value: string): boolean {
  const lower = value.toLowerCase();
  return UNSAFE_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * Resolve an attribute value to an absolute URL.
 * Returns undefined if the value is empty, unsafe (data:, javascript:, vbscript:),
 * a fragment reference, or cannot be resolved.
 */
function resolveUrl(value: string | undefined | null, base: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#') || hasUnsafeScheme(trimmed)) {
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
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        // Tasks are expected to handle their own errors and return error results.
        // If a task unexpectedly rejects, record a placeholder so the results
        // array stays consistent and other workers can continue.
        results[index] = { fetchError: normalizeError(error) } as unknown as T;
      }
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
    entries.set(url, { isCdnMapped: true, originalUrl: url, cdnUrl });
    return;
  }

  // Only download same-domain assets
  if (!isWithinSiteDomain(url, siteUrl)) {
    return; // external – leave intact
  }

  // Check extension allowlist – parse URL once and reuse
  let parsedPathname: string;
  try {
    parsedPathname = new URL(url).pathname.toLowerCase();
  } catch {
    return;
  }

  const hasAllowedExtension = STATIC_CONVERSION_RULE.allowedExtensions.some((ext) =>
    parsedPathname.endsWith(ext),
  );
  if (!hasAllowedExtension) return;

  entries.set(url, {
    isCdnMapped: false,
    originalUrl: url,
    localPath: assetUrlToLocalPath(url),
  });
}

/**
 * Fetch the binary content of a single local asset entry.
 */
async function fetchAsset(
  entry: AssetEntry & { isCdnMapped: false },
  timeoutMs: number,
): Promise<AssetEntry & { isCdnMapped: false }> {
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

/** Resolve the replacement URL/path for a given asset entry. */
function resolveReplacement(entry: AssetEntry, snapshotPath: string): string {
  if (entry.isCdnMapped) {
    return entry.cdnUrl;
  }
  return relativePathFromSnapshot(snapshotPath, entry.localPath);
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
  // Guard against absent snapshotPath (e.g. snapshot not yet written to disk).
  const snapshotPath = snapshot.snapshotPath || pageUrlToRelativePath(base);

  for (const { selector, attr } of ASSET_SELECTORS) {
    $(selector).each((_, element) => {
      const rawValue = $(element).attr(attr);

      if (attr === 'srcset' && rawValue) {
        const rewritten = rawValue
          .split(/,\s*/)
          .map((part) => {
            const trimmed = part.trim();
            const parts = trimmed.split(/\s+/);
            const urlPart = parts[0] ?? '';
            const descriptor = parts.slice(1).join(' ');
            const resolved = resolveUrl(urlPart, base);
            if (!resolved) return part;
            const entry = assetEntries.get(resolved);
            if (!entry) return part;
            const replacement = resolveReplacement(entry, snapshotPath);
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

      $(element).attr(attr, resolveReplacement(entry, snapshotPath));
    });
  }

  // Rewrite <a href> for internal pages (keep asset hrefs already handled above)
  $('a[href]').each((_, element) => {
    const rawHref = $(element).attr('href');
    if (!rawHref) return;
    const trimmed = rawHref.trim();
    // Guard against unsafe and non-navigable schemes (data:, javascript:, vbscript:, mailto:, tel:, #…)
    if (trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:') || hasUnsafeScheme(trimmed)) {
      return;
    }
    const resolved = resolveUrl(trimmed, base);
    if (!resolved) return;

    // Only rewrite same-site page links; leave external links intact
    if (!isWithinSiteDomain(resolved, siteUrl)) return;

    // If it was already rewritten as an asset, skip
    if (assetEntries.has(resolved)) return;

    // Compute relative path for the linked HTML page using the shared utility
    const linkedRelativePath = pageUrlToRelativePath(resolved);
    const relative = relativePathFromSnapshot(snapshotPath, linkedRelativePath);
    $(element).attr('href', relative);
  });

  return $.html();
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

  const localEntries = [...assetMap.values()].filter(
    (e): e is AssetEntry & { isCdnMapped: false } => !e.isCdnMapped,
  );
  const cdnEntries = [...assetMap.values()].filter((e) => e.isCdnMapped);

  events.push(
    createAssetEvent(jobId, 'stage_progress', 'Asset URLs collected', {
      internalAssetCount: localEntries.length,
      cdnRemappedCount: cdnEntries.length,
    }),
  );

  // Step 2: fetch internal assets concurrently
  const fetchTasks = localEntries.map((entry) => () => fetchAsset(entry, timeoutMs));
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
