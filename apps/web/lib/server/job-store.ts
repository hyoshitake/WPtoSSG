import 'server-only';

import {
  JOB_STAGES,
  createJobEvent,
  getJobStageIndex,
  type DiagnosticResult,
  type Job,
  type JobEvent,
  type JobReport,
  type PageReport,
  type JobStage,
} from '@wptossg/shared';

type JobListener = (event: JobEvent) => void;

interface JobRecord {
  job: Job;
  events: JobEvent[];
  listeners: Set<JobListener>;
  running: boolean;
  pageReports: PageReport[];
  visitedStages: Set<JobStage>;
  warningCount: number;
}

interface JobStoreState {
  jobs: Map<string, JobRecord>;
}

const HEARTBEAT_SAFE_DELAY_MS = 450;
const SIMULATED_GRAPH_NODES_PER_PAGE = 2;
const SIMULATED_GRAPH_EDGES_PER_PAGE = 3;
const SIMULATED_INTERNAL_ASSETS_PER_PAGE = 4;
const SIMULATED_EXTERNAL_ASSETS_PER_JOB = 2;
const STAGE_PROGRESS: Record<JobStage, number> = {
  PRECHECK: 5,
  CRAWL_GRAPH: 20,
  RENDER_AND_SNAPSHOT: 42,
  ASSET_FETCH_AND_REWRITE: 63,
  DIAGNOSTIC: 78,
  ROTATE_AND_UPLOAD: 90,
  FINALIZE: 96,
};

function createStoreState(): JobStoreState {
  return {
    jobs: new Map<string, JobRecord>(),
  };
}

const globalStore = globalThis as typeof globalThis & {
  __WPTOSSG_JOB_STORE__?: JobStoreState;
};

const store = globalStore.__WPTOSSG_JOB_STORE__ ?? createStoreState();
globalStore.__WPTOSSG_JOB_STORE__ = store;

function pause(durationMs = HEARTBEAT_SAFE_DELAY_MS): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createSiteKey(siteUrl: string): string {
  const hostname = new URL(siteUrl).hostname;
  return hostname.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'site';
}

function createInitialJob(siteUrl: string): Job {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    siteUrl,
    status: 'pending',
    currentStage: 'PRECHECK',
    createdAt: timestamp,
    updatedAt: timestamp,
    percent: 0,
  };
}

function toJobSnapshot(job: Job): Job {
  return clone(job);
}

function toJobResponse(record: JobRecord): { job: Job; events: JobEvent[] } {
  return {
    job: toJobSnapshot(record.job),
    events: record.events.map((entry) => clone(entry)),
  };
}

function updateJob(record: JobRecord, updates: Partial<Job>): void {
  record.job = {
    ...record.job,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

function appendEvent(record: JobRecord, event: JobEvent): void {
  record.events.push(event);
  if (event.type === 'warning') {
    record.warningCount += 1;
  }
  for (const listener of record.listeners) {
    listener(event);
  }
}

function emitEvent(
  record: JobRecord,
  type: JobEvent['type'],
  message: string,
  details: Record<string, unknown> = {},
): JobEvent {
  const event = createJobEvent({
    jobId: record.job.id,
    stage: record.job.currentStage,
    type,
    message,
    details: {
      ...details,
      job: toJobSnapshot(record.job),
    },
  });
  appendEvent(record, event);
  return event;
}

function setStage(record: JobRecord, stage: JobStage, message: string): void {
  record.visitedStages.add(stage);
  updateJob(record, {
    currentStage: stage,
    status: 'running',
    percent: STAGE_PROGRESS[stage],
  });
  emitEvent(record, 'job_state_changed', message, {
    stageIndex: getJobStageIndex(stage),
  });
}

function createDiagnostic(siteUrl: string): DiagnosticResult {
  const normalizedUrl = new URL(siteUrl);

  if (/login|account|member/i.test(normalizedUrl.hostname) || /login|account|member/i.test(normalizedUrl.pathname)) {
    return {
      riskLevel: 'high',
      reasons: ['ログイン導線の兆候があり、完全静的化では機能欠落の可能性があります。'],
      evidence: [
        {
          type: 'url',
          location: new URL('/wp-login.php', normalizedUrl).toString(),
        },
        {
          type: 'selector',
          location: 'input[type="password"]',
        },
      ],
    };
  }

  return {
    riskLevel: 'medium',
    reasons: ['フォームや API 呼び出しの有無を継続確認できるよう、根拠付きでレビューが必要です。'],
    evidence: [
      {
        type: 'api',
        location: new URL('/wp-json', normalizedUrl).toString(),
      },
      {
        type: 'selector',
        location: 'form[action]',
      },
    ],
  };
}

function createPageTargets(siteUrl: string): string[] {
  const normalizedUrl = new URL(siteUrl);
  const basePath = normalizedUrl.pathname === '/' ? '' : normalizedUrl.pathname.replace(/\/$/, '');

  return [
    normalizedUrl.toString(),
    new URL(`${basePath}/index`, normalizedUrl).toString(),
    new URL(`${basePath}/contact`, normalizedUrl).toString(),
  ];
}

function toSnapshotPath(pageUrl: string, siteUrl: string): string {
  const pathname = new URL(pageUrl, siteUrl).pathname.replace(/\/$/, '');
  return pathname === '' || pathname === '/' ? '/snapshots/index.html' : `/snapshots${pathname}/index.html`;
}

function createReport(record: JobRecord): JobReport {
  const siteKey = createSiteKey(record.job.siteUrl);
  const successCount = record.pageReports.filter((page) => page.status === 'success').length;
  const failedCount = record.pageReports.filter((page) => page.status === 'failed').length;

  return {
    id: crypto.randomUUID(),
    jobId: record.job.id,
    generatedAt: new Date().toISOString(),
    successCount,
    failedCount,
    warnings: record.warningCount,
    pages: record.pageReports.map((page) => clone(page)),
    stageBreakdown: JOB_STAGES.map((stage) => ({
      stage,
      successCount: record.visitedStages.has(stage) ? 1 : 0,
      failedCount: 0,
    })),
    failures: [],
    diagnostic: record.job.diagnostic,
    storage: {
      reportPath: `/sites/${siteKey}/current/report.json`,
      currentFolderId: `${siteKey}-current`,
      archiveFolderId: `${siteKey}-archive`,
    },
  };
}

async function runJob(record: JobRecord): Promise<void> {
  if (record.running) {
    return;
  }

  record.running = true;

  try {
    setStage(record, 'PRECHECK', 'PRECHECK stage started');
    emitEvent(record, 'stage_progress', 'Site URL validated', {
      siteUrl: record.job.siteUrl,
    });
    await pause();

    setStage(record, 'CRAWL_GRAPH', 'CRAWL_GRAPH stage started');
    const pageTargets = createPageTargets(record.job.siteUrl);
    emitEvent(record, 'stage_progress', 'Graph discovery completed', {
      discoveredNodes: pageTargets.length * SIMULATED_GRAPH_NODES_PER_PAGE,
      discoveredEdges: pageTargets.length * SIMULATED_GRAPH_EDGES_PER_PAGE,
    });
    await pause();

    setStage(record, 'RENDER_AND_SNAPSHOT', 'RENDER_AND_SNAPSHOT stage started');
    emitEvent(record, 'stage_progress', 'Rendering queue prepared', {
      totalPages: pageTargets.length,
    });
    for (const page of pageTargets) {
      const snapshotPath = toSnapshotPath(page, record.job.siteUrl);
      record.pageReports.push({
        url: page,
        status: 'success',
        snapshotPath,
      });
      emitEvent(record, 'page_done', 'Page rendered and snapshotted', {
        url: page,
        snapshotPath,
      });
      await pause(220);
    }
    await pause();

    setStage(record, 'ASSET_FETCH_AND_REWRITE', 'ASSET_FETCH_AND_REWRITE stage started');
    emitEvent(record, 'stage_progress', 'Internal assets fetched and rewritten', {
      fetchedAssets: pageTargets.length * SIMULATED_INTERNAL_ASSETS_PER_PAGE,
      externalAssetsKept: Math.max(SIMULATED_EXTERNAL_ASSETS_PER_JOB, pageTargets.length - 1),
    });
    await pause();

    setStage(record, 'DIAGNOSTIC', 'DIAGNOSTIC stage started');
    const diagnostic = createDiagnostic(record.job.siteUrl);
    updateJob(record, { diagnostic, percent: STAGE_PROGRESS.DIAGNOSTIC });
    emitEvent(record, 'warning', 'Diagnostic review suggests manual verification for interactive behavior', {
      riskLevel: diagnostic.riskLevel,
    });
    emitEvent(record, 'diagnostic_ready', 'Diagnostic result is ready', {
      diagnostic,
    });
    await pause();

    setStage(record, 'ROTATE_AND_UPLOAD', 'ROTATE_AND_UPLOAD stage started');
    emitEvent(record, 'stage_progress', 'current/archive rotation completed', {
      archiveCreated: true,
    });
    await pause();

    setStage(record, 'FINALIZE', 'FINALIZE stage started');
    const report = createReport(record);
    updateJob(record, {
      report,
      status: 'completed',
      percent: 100,
    });
    emitEvent(record, 'completed', 'Job completed successfully', {
      report,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateJob(record, {
      status: 'failed',
    });
    emitEvent(record, 'failed', 'Job failed', {
      reason,
    });
  }
}

export function createJob(siteUrl: string): { job: Job; events: JobEvent[] } {
  const record: JobRecord = {
    job: createInitialJob(siteUrl),
    events: [],
    listeners: new Set<JobListener>(),
    running: false,
    pageReports: [],
    visitedStages: new Set<JobStage>(),
    warningCount: 0,
  };

  store.jobs.set(record.job.id, record);
  emitEvent(record, 'job_state_changed', 'Job accepted and queued', {
    stageIndex: getJobStageIndex(record.job.currentStage),
  });
  void runJob(record);
  return toJobResponse(record);
}

export function getJob(jobId: string): { job: Job; events: JobEvent[] } | undefined {
  const record = store.jobs.get(jobId);
  return record ? toJobResponse(record) : undefined;
}

export function listEvents(jobId: string, lastEventId?: string | null): JobEvent[] {
  const record = store.jobs.get(jobId);
  if (!record) {
    return [];
  }

  if (!lastEventId) {
    return record.events.map((event) => clone(event));
  }

  const lastSeenIndex = record.events.findIndex((event) => event.id === lastEventId);
  const slice = lastSeenIndex >= 0 ? record.events.slice(lastSeenIndex + 1) : record.events;
  return slice.map((event) => clone(event));
}

export function subscribe(jobId: string, listener: JobListener): (() => void) | undefined {
  const record = store.jobs.get(jobId);
  if (!record) {
    return undefined;
  }

  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
  };
}
