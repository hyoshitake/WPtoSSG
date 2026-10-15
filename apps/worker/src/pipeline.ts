/**
 * `convert-site` pipeline: runs the seven stages in order and reports state
 * and events through a `JobReporter`.
 *
 *   PRECHECK → CRAWL_GRAPH → RENDER_AND_SNAPSHOT → ASSET_FETCH_AND_REWRITE
 *   → DIAGNOSTIC → ROTATE_AND_UPLOAD → FINALIZE
 *
 * Page/asset failures are collected and the pipeline continues; an
 * unreachable site or a stage-level error stops processing and jumps to
 * FINALIZE, which always produces a report (AGENTS.md §9).
 */

import { recordSavedSite } from '@wptossg/shared/site-store';
import { withSiteLock } from '@wptossg/shared/edit-store';
import type {
  ConvertSiteJobData,
  DiagnosticResult,
  Job,
  JobEvent,
  JobReport,
  JobReportFailure,
  JobStage,
  StorageBackend,
} from '@wptossg/shared';
import { createJobEvent } from '@wptossg/shared';
import type { AssetFetchAndRewriteResult } from './assetFetch.js';
import { fetchAndRewriteAssets } from './assetFetch.js';
import { crawlSiteGraph, runPrecheck, type CrawlResult } from './crawl.js';
import { runDiagnostic } from './diagnostic.js';
import {
  driveFolderUrl,
  rotateAndUpload,
  uploadFilesToDriveFolder,
  type RotateAndUploadResult,
  type UploadFile,
} from './driveUpload.js';
import { finalizeJob, type FinalizeFatalError } from './finalize.js';
import { renderAndSnapshotPages, type RenderAndSnapshotResult } from './index.js';
import { rotateAndWriteLocal, writeFilesToLocalFolder } from './localOutput.js';
import type { JobReporter } from './redisJobReporter.js';

export interface PipelineConfig {
  maxPages: number;
  respectRobotsTxt: boolean;
  storageBackend: StorageBackend;
}

const STAGE_PROGRESS: Partial<Record<JobStage, number>> = {
  PRECHECK: 5,
  CRAWL_GRAPH: 15,
  RENDER_AND_SNAPSHOT: 30,
  ASSET_FETCH_AND_REWRITE: 65,
  DIAGNOSTIC: 78,
  ROTATE_AND_UPLOAD: 85,
  FINALIZE: 96,
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadPipelineConfig(env: NodeJS.ProcessEnv = process.env): PipelineConfig {
  return {
    maxPages: parsePositiveInt(env['MAX_PAGES'], 99),
    respectRobotsTxt: env['RESPECT_ROBOTS_TXT']?.toLowerCase() !== 'false',
    // Same default as driveUpload: Drive is on unless explicitly disabled.
    storageBackend: env['GOOGLE_DRIVE_ENABLED']?.toLowerCase() === 'false' ? 'local' : 'google-drive',
  };
}

const MAX_REASON_LENGTH = 500;

/**
 * First line of the error plus the first later line that looks like the root
 * cause, capped. Playwright launch errors embed multi-KB browser logs.
 */
function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [firstLine = message, ...rest] = message.split('\n');
  const cause = rest.find((line) => /error while loading|executable doesn't exist|\berror:/i.test(line))?.trim();
  const reason = cause ? `${firstLine} (${cause})` : firstLine;
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}…` : reason;
}

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }));
}

/** Build the file set for `current/`: pages, local assets, graph.json and a root redirect. */
function buildOutputFiles(
  assetResult: AssetFetchAndRewriteResult,
  crawlResult: CrawlResult,
  startPagePath: string | undefined,
): UploadFile[] {
  const files = new Map<string, UploadFile>();
  const add = (relativePath: string, content: Buffer, mimeType: string): void => {
    const normalized = relativePath.replace(/^\/+/, '');
    // Two URLs can redirect to the same final page; keep the first.
    if (normalized && !files.has(normalized)) {
      files.set(normalized, { relativePath: normalized, content, mimeType });
    }
  };

  for (const page of assetResult.pages) {
    add(page.snapshotPath, Buffer.from(page.rewrittenHtml, 'utf8'), 'text/html; charset=utf-8');
  }

  for (const asset of assetResult.assets) {
    if (!asset.isCdnMapped && asset.content) {
      add(asset.localPath, asset.content, asset.contentType ?? 'application/octet-stream');
    }
  }

  if (startPagePath) {
    const target = startPagePath.replace(/^\/+/, '');
    add(
      'index.html',
      Buffer.from(
        `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=${target}">\n<a href="${target}">${target}</a>\n`,
        'utf8',
      ),
      'text/html; charset=utf-8',
    );
  }

  // Preserve original page URLs and map absolute asset references at serving time.
  const publicRoutes: Record<string, string> = {};
  for (const page of assetResult.pages) {
    publicRoutes[page.snapshotPath.replace(/^\/+/, '')] = new URL(page.finalUrl || page.url).pathname;
  }
  for (const asset of assetResult.assets) {
    if (!asset.isCdnMapped && asset.content) {
      publicRoutes[new URL(asset.originalUrl).pathname.replace(/^\/+/, '')] = `/${asset.localPath}`;
    }
  }
  add('public-routes.json', Buffer.from(JSON.stringify(publicRoutes)), 'application/json');

  add('graph.json', Buffer.from(`${JSON.stringify(crawlResult.graph, null, 2)}\n`, 'utf8'), 'application/json; charset=utf-8');

  return [...files.values()];
}

export async function runConvertSite(
  data: ConvertSiteJobData,
  reporter: JobReporter,
  config: PipelineConfig = loadPipelineConfig(),
): Promise<Job> {
  try { return await withSiteLock(data.siteKey, () => runLockedConvertSite(data, reporter, config)); }
  catch (error) {
    const now = new Date().toISOString();
    const reason = normalizeError(error);
    const job: Job = {id:data.jobId,siteUrl:data.siteUrl,status:'failed',currentStage:'PRECHECK',createdAt:now,updatedAt:now,percent:0,
      report:{id:data.jobId,jobId:data.jobId,generatedAt:now,successCount:0,failedCount:1,warnings:0,pages:[],stageBreakdown:[],failures:[{stage:'PRECHECK',target:data.siteUrl,reason}]}};
    await reporter.saveJob(job);
    await reporter.publish(createJobEvent({jobId:data.jobId,stage:'PRECHECK',type:'failed',message:reason}));
    return job;
  }
}

async function runLockedConvertSite(data: ConvertSiteJobData, reporter: JobReporter, config: PipelineConfig): Promise<Job> {
  const { jobId, siteUrl, siteKey } = data;
  const now = new Date().toISOString();
  let job: Job = {
    id: jobId,
    siteUrl,
    status: 'running',
    currentStage: 'PRECHECK',
    createdAt: now,
    updatedAt: now,
    percent: 0,
  };

  const publishedEvents: JobEvent[] = [];
  // Render emits events synchronously while it runs; chain writes to keep order.
  let publishChain: Promise<void> = Promise.resolve();
  const publish = (event: JobEvent, extraDetails: Record<string, unknown> = {}): Promise<void> => {
    const enriched: JobEvent = { ...event, details: { ...event.details, ...extraDetails, job } };
    publishedEvents.push(enriched);
    publishChain = publishChain
      .then(() => reporter.publish(enriched))
      .catch((error) => log('error', 'failed to publish job event', { jobId, reason: normalizeError(error) }));
    return publishChain;
  };
  const publishAll = async (events: JobEvent[]): Promise<void> => {
    for (const event of events) {
      void publish(event);
    }
    await publishChain;
  };

  const enterStage = async (stage: JobStage): Promise<void> => {
    job = { ...job, status: 'running', currentStage: stage, percent: STAGE_PROGRESS[stage] ?? 0, updatedAt: new Date().toISOString() };
    await reporter.saveJob(job);
    await publish(createJobEvent({ jobId, stage, type: 'job_state_changed', message: `${stage} stage started` }));
    log('info', 'stage started', { jobId, siteKey, stage });
  };

  let fatalError: FinalizeFatalError | undefined;
  let crawlResult: CrawlResult | undefined;
  let renderResult: RenderAndSnapshotResult | undefined;
  let assetResult: AssetFetchAndRewriteResult | undefined;
  let diagnostic: DiagnosticResult | undefined;
  let uploadResult: RotateAndUploadResult | undefined;

  try {
    await enterStage('PRECHECK');
    const precheck = await runPrecheck(jobId, siteUrl, { respectRobotsTxt: config.respectRobotsTxt });
    await publishAll(precheck.events);

    await enterStage('CRAWL_GRAPH');
    crawlResult = await crawlSiteGraph(jobId, precheck.startUrl, {
      robots: precheck.robots,
      maxPages: config.maxPages,
      onEvent: (event) => void publish(event),
    });
    await publishChain;
    if (crawlResult.pageUrls.length === 0) {
      throw new Error('No pages could be fetched during crawl');
    }

    await enterStage('RENDER_AND_SNAPSHOT');
    renderResult = await renderAndSnapshotPages(
      jobId,
      crawlResult.pageUrls.map((url) => ({ url })),
      {
        maxPages: config.maxPages,
        // Store pages as `{host}/{path}.html` at the root of `current/` so
        // relative links to `assets/` resolve (see assetFetch.relativePathFromSnapshot).
        snapshotRootDir: '',
        onEvent: (event) => void publish(event),
      },
    );
    await publishChain;
    if (renderResult.snapshots.length === 0) {
      throw new Error('No pages could be rendered');
    }

    await enterStage('ASSET_FETCH_AND_REWRITE');
    assetResult = await fetchAndRewriteAssets(jobId, renderResult.snapshots, { siteUrl: precheck.startUrl });
    await publishAll(assetResult.events);

    await enterStage('DIAGNOSTIC');
    const diagnosticRun = runDiagnostic(jobId, {
      siteUrl: precheck.startUrl,
      pages: renderResult.snapshots.map((snapshot) => ({ url: snapshot.finalUrl || snapshot.url, html: snapshot.html })),
    });
    diagnostic = diagnosticRun.diagnostic;
    job = { ...job, diagnostic };
    await reporter.saveJob(job);
    for (const event of diagnosticRun.events) {
      void publish(event, event.type === 'diagnostic_ready' ? { diagnostic } : {});
    }
    await publishChain;

    await enterStage('ROTATE_AND_UPLOAD');
    const files = buildOutputFiles(assetResult, crawlResult, renderResult.snapshots[0]?.snapshotPath);
    uploadResult =
      config.storageBackend === 'google-drive'
        ? await rotateAndUpload(jobId, { siteKey, files })
        : await rotateAndWriteLocal(jobId, { siteKey, files });
    await publishAll(uploadResult.events);
  } catch (error) {
    fatalError = { stage: job.currentStage, target: siteUrl, reason: normalizeError(error) };
    log('error', 'stage failed', { jobId, siteKey, stage: job.currentStage, reason: fatalError.reason });
    await publish(
      createJobEvent({
        jobId,
        stage: job.currentStage,
        type: 'warning',
        message: `${job.currentStage} failed; skipping to FINALIZE`,
        details: { reason: fatalError.reason },
      }),
    );
  }

  await enterStage('FINALIZE');

  const crawlFailures: JobReportFailure[] = (crawlResult?.graph.nodes ?? [])
    .filter((node) => node.status === 'failed')
    .map((node) => ({ stage: 'CRAWL_GRAPH', target: node.url, reason: String(node.metadata?.['reason'] ?? 'unknown') }));

  const finalized = finalizeJob({
    job,
    previousEvents: publishedEvents,
    renderResult,
    assetResult,
    diagnostic,
    uploadResult,
    failures: crawlFailures,
    fatalError,
  });

  const report: JobReport = {
    ...finalized.report,
    storage: uploadResult
      ? {
          backend: config.storageBackend,
          reportPath: `/sites/${siteKey}/current/report.json`,
          currentFolderId: uploadResult.currentFolderId,
          archiveFolderId: uploadResult.archiveFolderId,
          currentLocation:
            config.storageBackend === 'google-drive' ? driveFolderUrl(uploadResult.currentFolderId) : uploadResult.currentFolderId,
        }
      : undefined,
  };

  let reportStored = false;
  // report.json goes into the `current` folder created during ROTATE_AND_UPLOAD.
  if (uploadResult) {
    const reportFile: UploadFile = {
      ...finalized.reportFile,
      content: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    };
    try {
      const result =
        config.storageBackend === 'google-drive'
          ? await uploadFilesToDriveFolder(uploadResult.currentFolderId, [reportFile])
          : await writeFilesToLocalFolder(uploadResult.currentFolderId, [reportFile]);
      if (result.failures.length > 0) {
        throw new Error(result.failures.map((failure) => failure.reason).join('; '));
      }
      reportStored = true;
    } catch (error) {
      await publish(
        createJobEvent({
          jobId,
          stage: 'FINALIZE',
          type: 'warning',
          message: 'Failed to store report.json',
          details: { reason: normalizeError(error) },
        }),
      );
    }
  }

  let publicationSucceeded = config.storageBackend !== 'google-drive';
  if (config.storageBackend === 'google-drive' && finalized.job.status === 'completed' &&
      reportStored && uploadResult?.publish) {
    try {
      await uploadResult.publish();
      publicationSucceeded = true;
      if (report.storage) report.storage.archiveFolderId = uploadResult.archiveFolderId;
      await publish(createJobEvent({ jobId, stage: 'FINALIZE', type: 'stage_progress',
        message: 'Static site publication switched successfully' }));
    } catch {
      await publish(createJobEvent({ jobId, stage: 'FINALIZE', type: 'warning',
        message: 'Static site publication failed; previous publication retained' }));
    }
  }

  if (config.storageBackend === 'google-drive' && !publicationSucceeded) {
    await publish(createJobEvent({ jobId, stage: 'FINALIZE', type: 'warning',
      message: 'New artifacts were not published; previous publication retained' }));
  }
  job = { ...finalized.job, report };
  if (uploadResult && publicationSucceeded) {
    try { await recordSavedSite({ ...job, graph: crawlResult?.graph }, siteKey, reportStored); }
    catch {
      await publish(createJobEvent({ jobId, stage: 'FINALIZE', type: 'warning',
        message: 'Site history could not be saved to database; artifacts remain available in job report' }));
    }
  }
  await reporter.saveJob(job);
  for (const event of finalized.events) {
    const isTerminal = event.type === 'completed' || event.type === 'failed';
    void publish(event, isTerminal ? { report, reportPath: report.storage?.reportPath } : {});
  }
  await publishChain;

  log(job.status === 'completed' ? 'info' : 'warn', 'job finished', {
    jobId,
    siteKey,
    status: job.status,
    successCount: report.successCount,
    failedCount: report.failedCount,
    storage: report.storage?.currentLocation,
  });

  return job;
}
