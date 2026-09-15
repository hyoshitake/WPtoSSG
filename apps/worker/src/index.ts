import type { JobEvent } from '@wptossg/shared';
import { createJobEvent } from '@wptossg/shared';
import { load } from 'cheerio';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type LaunchOptions, type Page } from 'playwright';

export interface SnapshotJobPage {
  url: string;
  nodeId?: string;
}

export interface SnapshotRuntimeOptions {
  launchOptions?: LaunchOptions;
  contextOptions?: BrowserContextOptions;
  viewport?: { width: number; height: number };
  navigationTimeoutMs?: number;
  afterScrollWaitMs?: number;
  maxScrollIterations?: number;
  stableHeightThreshold?: number;
  maxPages?: number;
  lazyLoadAttributes?: string[];
  snapshotRootDir?: string;
}

export interface RenderedPageSnapshot {
  url: string;
  finalUrl: string;
  html: string;
  title: string;
  snapshotPath: string;
  scrollIterations: number;
  expandedLazyLoadCount: number;
}

export interface PageRenderFailure {
  url: string;
  nodeId?: string;
  reason: string;
  stage: 'RENDER_AND_SNAPSHOT';
}

export interface RenderAndSnapshotResult {
  snapshots: RenderedPageSnapshot[];
  failures: PageRenderFailure[];
  events: JobEvent[];
}

const DEFAULT_VIEWPORT = { width: 1440, height: 1024 };
const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_AFTER_SCROLL_WAIT_MS = 300;
const DEFAULT_MAX_SCROLL_ITERATIONS = 8;
const DEFAULT_STABLE_HEIGHT_THRESHOLD = 2;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_LAZY_LOAD_ATTRIBUTES = ['data-src', 'data-srcset', 'data-lazy-src', 'data-original'];

function resolveLazyLoadDestination(attributeName: string): 'src' | 'srcset' {
  return attributeName.toLowerCase().includes('srcset') ? 'srcset' : 'src';
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toSnapshotPath(url: string, snapshotRootDir = '/snapshots'): string {
  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname === '/' ? '/index' : parsed.pathname.replace(/\/+$/, '');
    const sanitizedPath = normalizedPath
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9/_-]/g, '_')
      .replace(/\/{2,}/g, '/');
    const suffix = parsed.search ? `_${encodeURIComponent(parsed.search).replace(/%/g, '_')}` : '';
    const pathname = sanitizedPath ? `${sanitizedPath}` : 'index';

    return `${snapshotRootDir}/${parsed.hostname}/${pathname}${suffix}.html`.replace(/\/{2,}/g, '/');
  } catch {
    const fallback = encodeURIComponent(url).replace(/%/g, '_');
    return `${snapshotRootDir}/${fallback}.html`;
  }
}

async function waitForStableDom(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle');
}

async function performAutoScroll(
  page: Page,
  maxIterations: number,
  stableHeightThreshold: number,
  waitAfterScrollMs: number,
): Promise<number> {
  let previousHeight = -1;
  let stableRounds = 0;
  let executed = 0;

  for (let index = 0; index < maxIterations; index += 1) {
    executed += 1;

    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight));
    await page.waitForTimeout(waitAfterScrollMs);

    const nextHeight = await page.evaluate(() => document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    if (nextHeight === currentHeight && currentHeight === previousHeight) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    previousHeight = nextHeight;

    if (stableRounds >= stableHeightThreshold) {
      break;
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return executed;
}

async function expandLazyLoadContent(page: Page, lazyLoadAttributes: string[]): Promise<number> {
  const attributeTargets = lazyLoadAttributes.map((attribute) => ({
    attribute,
    destination: resolveLazyLoadDestination(attribute),
  }));

  return page.evaluate((targets) => {
    let updated = 0;

    const applyAttribute = (selector: string, source: string, destination: 'src' | 'srcset'): void => {
      const elements = document.querySelectorAll<HTMLElement>(selector);
      elements.forEach((element) => {
        const sourceValue = element.getAttribute(source);
        if (!sourceValue) {
          return;
        }

        if (element.getAttribute(destination) !== sourceValue) {
          element.setAttribute(destination, sourceValue);
          updated += 1;
        }
      });
    };

    for (const target of targets) {
      applyAttribute(`[${target.attribute}]`, target.attribute, target.destination);
    }

    return updated;
  }, attributeTargets);
}

function normalizeSnapshotHtml(html: string, lazyLoadAttributes: string[]): string {
  const $ = load(html);

  for (const attribute of lazyLoadAttributes) {
    const destination = resolveLazyLoadDestination(attribute);
    $(`[${attribute}]`).each((_, element) => {
      const lazyValue = $(element).attr(attribute);
      if (!lazyValue) {
        return;
      }

      if (!$(element).attr(destination)) {
        $(element).attr(destination, lazyValue);
      }
    });
  }

  return $.html();
}

async function renderSinglePage(
  context: BrowserContext,
  target: SnapshotJobPage,
  options: Required<Pick<SnapshotRuntimeOptions, 'navigationTimeoutMs' | 'afterScrollWaitMs' | 'maxScrollIterations' | 'stableHeightThreshold' | 'lazyLoadAttributes' | 'snapshotRootDir'>>,
): Promise<RenderedPageSnapshot> {
  const page = await context.newPage();

  try {
    await page.goto(target.url, {
      waitUntil: 'networkidle',
      timeout: options.navigationTimeoutMs,
    });
    await waitForStableDom(page);

    const scrollIterations = await performAutoScroll(
      page,
      options.maxScrollIterations,
      options.stableHeightThreshold,
      options.afterScrollWaitMs,
    );

    const expandedLazyLoadCount = await expandLazyLoadContent(page, options.lazyLoadAttributes);
    await page.waitForTimeout(options.afterScrollWaitMs);

    const finalUrl = page.url();
    const title = await page.title();
    const html = normalizeSnapshotHtml(await page.content(), options.lazyLoadAttributes);

    return {
      url: target.url,
      finalUrl,
      html,
      title,
      scrollIterations,
      expandedLazyLoadCount,
      snapshotPath: toSnapshotPath(finalUrl, options.snapshotRootDir),
    };
  } finally {
    await page.close();
  }
}

async function withBrowser<T>(options: SnapshotRuntimeOptions, callback: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true, ...options.launchOptions });
  try {
    return await callback(browser);
  } finally {
    await browser.close();
  }
}

function createRenderEvent(jobId: string, type: JobEvent['type'], message: string, details?: Record<string, unknown>): JobEvent {
  return createJobEvent({
    jobId,
    stage: 'RENDER_AND_SNAPSHOT',
    type,
    message,
    details,
  });
}

export async function renderAndSnapshotPages(
  jobId: string,
  pages: SnapshotJobPage[],
  options: SnapshotRuntimeOptions = {},
): Promise<RenderAndSnapshotResult> {
  const limitedPages = pages.slice(0, options.maxPages ?? DEFAULT_MAX_PAGES);
  const normalizedOptions = {
    navigationTimeoutMs: options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    afterScrollWaitMs: options.afterScrollWaitMs ?? DEFAULT_AFTER_SCROLL_WAIT_MS,
    maxScrollIterations: options.maxScrollIterations ?? DEFAULT_MAX_SCROLL_ITERATIONS,
    stableHeightThreshold: options.stableHeightThreshold ?? DEFAULT_STABLE_HEIGHT_THRESHOLD,
    lazyLoadAttributes: options.lazyLoadAttributes ?? DEFAULT_LAZY_LOAD_ATTRIBUTES,
    snapshotRootDir: options.snapshotRootDir ?? '/snapshots',
  };

  const snapshots: RenderedPageSnapshot[] = [];
  const failures: PageRenderFailure[] = [];
  const events: JobEvent[] = [
    createRenderEvent(jobId, 'stage_progress', 'Rendering and snapshot started', {
      totalPages: limitedPages.length,
    }),
  ];

  if (limitedPages.length === 0) {
    events.push(createRenderEvent(jobId, 'warning', 'No pages were provided for rendering'));
    return { snapshots, failures, events };
  }

  await withBrowser(options, async (browser) => {
    const context = await browser.newContext({ viewport: options.viewport ?? DEFAULT_VIEWPORT, ...options.contextOptions });
    try {
      for (const [index, page] of limitedPages.entries()) {
        try {
          const snapshot = await renderSinglePage(context, page, normalizedOptions);
          snapshots.push(snapshot);
          events.push(
            createRenderEvent(jobId, 'page_done', 'Page rendered and snapshotted', {
              index,
              url: page.url,
              finalUrl: snapshot.finalUrl,
              snapshotPath: snapshot.snapshotPath,
              scrollIterations: snapshot.scrollIterations,
              expandedLazyLoadCount: snapshot.expandedLazyLoadCount,
            }),
          );
        } catch (error) {
          const reason = normalizeError(error);
          failures.push({
            url: page.url,
            nodeId: page.nodeId,
            reason,
            stage: 'RENDER_AND_SNAPSHOT',
          });
          events.push(
            createRenderEvent(jobId, 'warning', 'Page rendering failed and pipeline continued', {
              index,
              url: page.url,
              reason,
            }),
          );
        }
      }
    } finally {
      await context.close();
    }
  });

  events.push(
    createRenderEvent(jobId, 'stage_progress', 'Rendering and snapshot finished', {
      totalPages: limitedPages.length,
      successCount: snapshots.length,
      failedCount: failures.length,
    }),
  );

  return {
    snapshots,
    failures,
    events,
  };
}
