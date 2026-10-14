/**
 * PRECHECK and CRAWL_GRAPH stages.
 *
 * PRECHECK confirms the site is reachable (DNS/TLS/HTTP errors fail the job)
 * and loads robots.txt.  CRAWL_GRAPH walks same-domain `<a href>` links
 * breadth-first from the start URL and records every page, external link and
 * edge in a `SiteGraph`, so later stages work from the graph rather than a
 * flat URL list.
 *
 * Discovery uses plain HTTP + Cheerio (no JavaScript execution); pages are
 * rendered with Playwright later, in RENDER_AND_SNAPSHOT.
 */

import type { EdgeType, GraphNode, JobEvent, SiteGraph } from '@wptossg/shared';
import {
  classifyGraphNodeKind,
  createEmptySiteGraph,
  createGraphEdge,
  createGraphNode,
  createGraphNodeId,
  createJobEvent,
  normalizeGraphUrl,
} from '@wptossg/shared';
import { isWithinSiteDomain } from '@wptossg/config';
import { load } from 'cheerio';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrecheckResult {
  /** URL the site actually serves from after redirects; crawl starts here. */
  startUrl: string;
  robots: RobotsRules;
  events: JobEvent[];
}

export interface CrawlOptions {
  robots: RobotsRules;
  /** Maximum number of pages to discover (default: 99, i.e. "under 100"). */
  maxPages?: number;
  fetchTimeoutMs?: number;
  onEvent?: (event: JobEvent) => void;
}

export interface CrawlResult {
  graph: SiteGraph;
  /** Same-domain HTML pages that were fetched successfully, in discovery order. */
  pageUrls: string[];
  events: JobEvent[];
}

export interface RobotsRules {
  /** Whether rules are enforced (RESPECT_ROBOTS_TXT=false disables them). */
  enforced: boolean;
  allow: string[];
  disallow: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CRAWLER_USER_AGENT = 'WPtoSSG/0.1 (+static snapshot crawler)';
const DEFAULT_MAX_PAGES = 99;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const NON_PAGE_EXTENSION =
  /\.(css|js|mjs|json|xml|rss|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|webm|mov|mp3|wav|docx?|xlsx?|pptx?|csv|txt)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    // undici wraps DNS/TLS failures in `cause`; surface it so the reason is actionable.
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': CRAWLER_USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    });
  } finally {
    clearTimeout(timer);
  }
}

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

/** Normalise a page URL for graph identity: drop hash and query, trim trailing slash. */
function normalizePageUrl(url: string, base?: string): string {
  return normalizeGraphUrl(url, base, { normalizeQueryStrings: true });
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * Parse the `User-agent: *` group of a robots.txt body.
 * Supports `*` wildcards and `$` anchors; the longest matching rule wins,
 * with Allow preferred on ties (per RFC 9309).
 */
export function parseRobotsTxt(body: string): Omit<RobotsRules, 'enforced'> {
  const allow: string[] = [];
  const disallow: string[] = [];
  let inWildcardGroup = false;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      inWildcardGroup = (lastLineWasAgent && inWildcardGroup) || value === '*';
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;

    if (!inWildcardGroup || !value) continue;
    if (field === 'allow') allow.push(value);
    if (field === 'disallow') disallow.push(value);
  }

  return { allow, disallow };
}

function robotsPatternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function isAllowedByRobots(url: string, rules: RobotsRules): boolean {
  if (!rules.enforced) return true;

  const parsed = new URL(url);
  const target = parsed.pathname + parsed.search;
  const longestMatch = (patterns: string[]): number =>
    patterns.reduce((best, pattern) => (robotsPatternToRegExp(pattern).test(target) ? Math.max(best, pattern.length) : best), -1);

  const allowLength = longestMatch(rules.allow);
  const disallowLength = longestMatch(rules.disallow);
  return disallowLength === -1 || allowLength >= disallowLength;
}

async function loadRobots(siteOrigin: string, timeoutMs: number, enforced: boolean): Promise<RobotsRules> {
  if (!enforced) {
    return { enforced: false, allow: [], disallow: [] };
  }

  try {
    const response = await fetchWithTimeout(new URL('/robots.txt', siteOrigin).toString(), timeoutMs);
    // A missing robots.txt means everything is allowed.
    if (!response.ok) {
      return { enforced: true, allow: [], disallow: [] };
    }
    return { enforced: true, ...parseRobotsTxt(await response.text()) };
  } catch {
    return { enforced: true, allow: [], disallow: [] };
  }
}

// ---------------------------------------------------------------------------
// PRECHECK
// ---------------------------------------------------------------------------

/**
 * Verify the site answers with HTML. Throws when it does not, because an
 * unreachable start URL makes the whole job meaningless (AGENTS.md §9).
 */
export async function runPrecheck(
  jobId: string,
  siteUrl: string,
  options: { fetchTimeoutMs?: number; respectRobotsTxt?: boolean } = {},
): Promise<PrecheckResult> {
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const events: JobEvent[] = [];

  let response: Response;
  try {
    response = await fetchWithTimeout(siteUrl, timeoutMs);
  } catch (error) {
    throw new Error(`Site is unreachable (${siteUrl}): ${normalizeError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Site returned HTTP ${response.status} ${response.statusText} (${siteUrl})`);
  }
  if (!isHtmlResponse(response)) {
    throw new Error(`Site did not return HTML (content-type: ${response.headers.get('content-type') ?? 'unknown'})`);
  }
  await response.body?.cancel();

  const startUrl = normalizePageUrl(response.url || siteUrl);
  const robots = await loadRobots(new URL(startUrl).origin, timeoutMs, options.respectRobotsTxt ?? true);

  if (!isAllowedByRobots(startUrl, robots)) {
    throw new Error(`robots.txt disallows crawling the start URL (${startUrl})`);
  }

  events.push(
    createJobEvent({
      jobId,
      stage: 'PRECHECK',
      type: 'stage_progress',
      message: 'Site is reachable',
      details: {
        siteUrl,
        startUrl,
        status: response.status,
        robotsEnforced: robots.enforced,
        robotsDisallowRules: robots.disallow.length,
      },
    }),
  );

  return { startUrl, robots, events };
}

// ---------------------------------------------------------------------------
// CRAWL_GRAPH
// ---------------------------------------------------------------------------

/**
 * Graph builder that only adds missing nodes/edges.  (The shared
 * `addGraphEdge` re-assigns existing nodes, which would reset crawl status.)
 */
class GraphBuilder {
  readonly graph: SiteGraph;
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edgeIds = new Set<string>();

  constructor(startUrl: string) {
    this.graph = createEmptySiteGraph(startUrl);
    this.ensureNode(startUrl, 'page', { source: 'root' });
  }

  ensureNode(url: string, kind: GraphNode['kind'], metadata: Record<string, unknown> = {}): GraphNode {
    const id = createGraphNodeId(url);
    let node = this.nodes.get(id);
    if (!node) {
      node = createGraphNode(url, kind, metadata);
      this.nodes.set(id, node);
      this.graph.nodes.push(node);
    }
    return node;
  }

  addEdge(fromUrl: string, toUrl: string, type: EdgeType, toKind: GraphNode['kind']): void {
    this.ensureNode(toUrl, toKind, { source: 'crawl' });
    const edge = createGraphEdge(fromUrl, toUrl, type);
    if (!this.edgeIds.has(edge.id)) {
      this.edgeIds.add(edge.id);
      this.graph.edges.push(edge);
    }
  }

  setStatus(url: string, status: GraphNode['status'], metadata: Record<string, unknown> = {}): void {
    const node = this.nodes.get(createGraphNodeId(url));
    if (node) {
      node.status = status;
      node.metadata = { ...node.metadata, ...metadata };
    }
  }
}

export async function crawlSiteGraph(jobId: string, startUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const events: JobEvent[] = [];
  const emit = (type: JobEvent['type'], message: string, details?: Record<string, unknown>): void => {
    const event = createJobEvent({ jobId, stage: 'CRAWL_GRAPH', type, message, details });
    events.push(event);
    options.onEvent?.(event);
  };

  const builder = new GraphBuilder(startUrl);
  const { graph } = builder;

  const queue: string[] = [startUrl];
  const enqueued = new Set<string>([startUrl]);
  const pageUrls: string[] = [];
  let skippedByRobots = 0;
  let limitReached = false;

  emit('stage_progress', 'Crawl started', { startUrl, maxPages });

  while (queue.length > 0) {
    const pageUrl = queue.shift()!;

    let html: string;
    try {
      const response = await fetchWithTimeout(pageUrl, timeoutMs);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (!isHtmlResponse(response)) {
        await response.body?.cancel();
        builder.setStatus(pageUrl, 'success', { skipped: 'not html' });
        continue;
      }
      html = await response.text();
    } catch (error) {
      const reason = normalizeError(error);
      builder.setStatus(pageUrl, 'failed', { reason });
      emit('warning', 'Page fetch failed during crawl; continuing', { url: pageUrl, reason });
      continue;
    }

    const $ = load(html);
    builder.setStatus(pageUrl, 'success', { title: $('title').first().text().trim() || undefined });
    pageUrls.push(pageUrl);

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href')?.trim();
      if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) return;

      let resolved: URL;
      try {
        resolved = new URL(href, pageUrl);
      } catch {
        return;
      }
      if (!['http:', 'https:'].includes(resolved.protocol)) return;

      if (!isWithinSiteDomain(resolved.toString(), startUrl)) {
        // External links are kept as-is in the HTML; record them for the graph only.
        builder.addEdge(pageUrl, normalizeGraphUrl(resolved.toString()), 'references', 'external');
        return;
      }

      if (NON_PAGE_EXTENSION.test(resolved.pathname)) return;

      const target = normalizePageUrl(resolved.toString());
      builder.addEdge(pageUrl, target, 'links_to', classifyGraphNodeKind(target, startUrl));

      if (enqueued.has(target)) return;
      if (!isAllowedByRobots(target, options.robots)) {
        skippedByRobots += 1;
        builder.setStatus(target, 'failed', { reason: 'disallowed by robots.txt' });
        enqueued.add(target);
        return;
      }
      if (enqueued.size >= maxPages) {
        limitReached = true;
        return;
      }

      enqueued.add(target);
      queue.push(target);
    });

    emit('stage_progress', 'Page discovered', {
      url: pageUrl,
      discoveredPages: pageUrls.length,
      queuedPages: queue.length,
    });
  }

  if (limitReached) {
    emit('warning', `Page limit reached (${maxPages}); remaining links were not crawled`, { maxPages });
  }
  if (skippedByRobots > 0) {
    emit('warning', 'Some pages were skipped because robots.txt disallows them', { skippedByRobots });
  }

  emit('stage_progress', 'Crawl finished', {
    pageCount: pageUrls.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  });

  return { graph, pageUrls, events };
}
