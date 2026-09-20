import type {
  DiagnosticResult,
  Job,
  JobEvent,
  JobReport,
  JobReportFailure,
  JobStage,
  JobStageReport,
  PageReport,
} from '@wptossg/shared';
import { JOB_STAGES, createJobEvent } from '@wptossg/shared';
import type { AssetFetchAndRewriteResult } from './assetFetch.js';
import type { RotateAndUploadResult, UploadFile } from './driveUpload.js';
import type { RenderAndSnapshotResult } from './index.js';

export interface FinalizeFatalError {
  stage?: JobStage;
  target?: string;
  reason: string;
}

export interface FinalizeOptions {
  job: Job;
  previousEvents?: JobEvent[];
  renderResult?: Pick<RenderAndSnapshotResult, 'snapshots' | 'failures'>;
  assetResult?: Pick<AssetFetchAndRewriteResult, 'assets'>;
  diagnostic?: DiagnosticResult;
  uploadResult?: Pick<RotateAndUploadResult, 'currentFolderId' | 'archiveFolderId' | 'uploadedCount' | 'uploadFailures'>;
  stageBreakdown?: Partial<Record<JobStage, { successCount: number; failedCount: number }>>;
  failures?: JobReportFailure[];
  fatalError?: FinalizeFatalError;
}

export interface FinalizeResult {
  job: Job;
  report: JobReport;
  reportFile: UploadFile;
  events: JobEvent[];
}

const REPORT_PATH = 'report.json';

function createFinalizeEvent(
  jobId: string,
  type: JobEvent['type'],
  message: string,
  details?: Record<string, unknown>,
): JobEvent {
  return createJobEvent({
    jobId,
    stage: 'FINALIZE',
    type,
    message,
    details,
  });
}

function countWarnings(events: JobEvent[]): number {
  return events.filter((event) => event.type === 'warning').length;
}

function buildPageReports(options: FinalizeOptions): PageReport[] {
  const successfulPages =
    options.renderResult?.snapshots.map<PageReport>((snapshot) => ({
      url: snapshot.finalUrl || snapshot.url,
      status: 'success',
      snapshotPath: snapshot.snapshotPath,
    })) ?? [];

  const failedPages =
    options.renderResult?.failures.map<PageReport>((failure) => ({
      url: failure.url,
      status: 'failed',
      reason: failure.reason,
    })) ?? [];

  return [...successfulPages, ...failedPages];
}

function buildFailures(options: FinalizeOptions): JobReportFailure[] {
  const failures: JobReportFailure[] = [...(options.failures ?? [])];

  for (const failure of options.renderResult?.failures ?? []) {
    failures.push({
      stage: failure.stage,
      target: failure.url,
      reason: failure.reason,
    });
  }

  for (const asset of options.assetResult?.assets ?? []) {
    if (!asset.isCdnMapped && asset.fetchError) {
      failures.push({
        stage: 'ASSET_FETCH_AND_REWRITE',
        target: asset.originalUrl,
        reason: asset.fetchError,
      });
    }
  }

  for (const failure of options.uploadResult?.uploadFailures ?? []) {
    failures.push({
      stage: 'ROTATE_AND_UPLOAD',
      target: failure.relativePath,
      reason: failure.reason,
    });
  }

  if (options.fatalError) {
    failures.push({
      stage: options.fatalError.stage ?? 'FINALIZE',
      target: options.fatalError.target ?? options.job.id,
      reason: options.fatalError.reason,
    });
  }

  return failures;
}

function buildStageBreakdown(options: FinalizeOptions): JobStageReport[] {
  const assetFailures = (options.assetResult?.assets ?? []).filter(
    (asset) => !asset.isCdnMapped && Boolean(asset.fetchError),
  ).length;
  const successfulAssets = (options.assetResult?.assets ?? []).filter(
    (asset) => asset.isCdnMapped || !asset.fetchError,
  ).length;

  const derived: Partial<Record<JobStage, { successCount: number; failedCount: number }>> = {
    RENDER_AND_SNAPSHOT: {
      successCount: options.renderResult?.snapshots.length ?? 0,
      failedCount: options.renderResult?.failures.length ?? 0,
    },
    ASSET_FETCH_AND_REWRITE: {
      successCount: successfulAssets,
      failedCount: assetFailures,
    },
    DIAGNOSTIC: {
      successCount: options.diagnostic ? 1 : 0,
      failedCount: 0,
    },
    ROTATE_AND_UPLOAD: {
      successCount: options.uploadResult?.uploadedCount ?? 0,
      failedCount: options.uploadResult?.uploadFailures.length ?? 0,
    },
    FINALIZE: {
      successCount: options.fatalError ? 0 : 1,
      failedCount: options.fatalError ? 1 : 0,
    },
  };

  return JOB_STAGES.map((stage) => {
    const summary = options.stageBreakdown?.[stage] ?? derived[stage] ?? { successCount: 0, failedCount: 0 };
    return {
      stage,
      successCount: summary.successCount,
      failedCount: summary.failedCount,
    };
  });
}

export function finalizeJob(options: FinalizeOptions): FinalizeResult {
  const { job } = options;
  const previousEvents = options.previousEvents ?? [];
  const generatedAt = new Date().toISOString();
  const pages = buildPageReports(options);
  const failures = buildFailures(options);
  const stageBreakdown = buildStageBreakdown(options);
  const warnings = countWarnings(previousEvents);
  const status = options.fatalError ? 'failed' : 'completed';

  const report: JobReport = {
    id: `${job.id}:report`,
    jobId: job.id,
    generatedAt,
    successCount: pages.filter((page) => page.status === 'success').length,
    failedCount: pages.filter((page) => page.status === 'failed').length,
    warnings,
    pages,
    stageBreakdown,
    failures,
    diagnostic: options.diagnostic,
    storage: {
      reportPath: REPORT_PATH,
      currentFolderId: options.uploadResult?.currentFolderId,
      archiveFolderId: options.uploadResult?.archiveFolderId,
    },
  };

  const updatedJob: Job = {
    ...job,
    status,
    currentStage: 'FINALIZE',
    percent: 100,
    updatedAt: generatedAt,
    diagnostic: options.diagnostic ?? job.diagnostic,
    report,
  };

  const events: JobEvent[] = [
    createFinalizeEvent(job.id, 'stage_progress', 'FINALIZE stage started', {
      warningCount: warnings,
      reportPath: REPORT_PATH,
    }),
    createFinalizeEvent(job.id, 'job_state_changed', 'Job status updated', {
      status,
      currentStage: 'FINALIZE',
      percent: 100,
    }),
    createFinalizeEvent(
      job.id,
      status === 'completed' ? 'completed' : 'failed',
      status === 'completed' ? 'Job finalized successfully' : 'Job finalized with failure',
      {
        successCount: report.successCount,
        failedCount: report.failedCount,
        warningCount: warnings,
        reportPath: REPORT_PATH,
        reason: options.fatalError?.reason,
      },
    ),
  ];

  const reportFile: UploadFile = {
    relativePath: REPORT_PATH,
    content: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    mimeType: 'application/json; charset=utf-8',
  };

  return {
    job: updatedJob,
    report,
    reportFile,
    events,
  };
}
