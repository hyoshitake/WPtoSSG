export type JobStage =
  | 'PRECHECK'
  | 'CRAWL_GRAPH'
  | 'RENDER_AND_SNAPSHOT'
  | 'ASSET_FETCH_AND_REWRITE'
  | 'DIAGNOSTIC'
  | 'ROTATE_AND_UPLOAD'
  | 'FINALIZE';

export type StageName = JobStage;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RiskLevel = 'low' | 'medium' | 'high';
export type GraphNodeKind = 'page' | 'asset' | 'api' | 'form' | 'external';
export type EdgeType =
  | 'links_to'
  | 'loads_asset'
  | 'calls_api'
  | 'has_form'
  | 'redirects_to'
  | 'references';

export interface GraphNode {
  id: string;
  url: string;
  kind: GraphNodeKind;
  title?: string;
  status?: 'pending' | 'success' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  metadata?: Record<string, unknown>;
}

export interface SiteGraph {
  id: string;
  siteUrl: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticEvidence {
  type: 'url' | 'selector' | 'api' | 'pattern' | 'response';
  location: string;
  details?: Record<string, unknown>;
}

export interface DiagnosticResult {
  riskLevel: RiskLevel;
  reasons: string[];
  evidence: DiagnosticEvidence[];
}

export type Diagnostic = DiagnosticResult;

export interface PageReport {
  url: string;
  status: 'success' | 'failed';
  reason?: string;
  snapshotPath?: string;
}

export interface JobReport {
  id: string;
  jobId: string;
  generatedAt: string;
  successCount: number;
  failedCount: number;
  warnings: number;
  pages: PageReport[];
}

export interface JobProgress {
  stage: JobStage;
  status: JobStatus;
  percent: number;
  message: string;
}

export interface Job {
  id: string;
  siteUrl: string;
  status: JobStatus;
  currentStage: JobStage;
  createdAt: string;
  updatedAt: string;
  percent: number;
  graph?: SiteGraph;
  diagnostic?: DiagnosticResult;
  report?: JobReport;
}

export interface JobCreateRequest {
  siteUrl: string;
  siteKey?: string;
  options?: Record<string, unknown>;
}

export interface JobEvent {
  id: string;
  jobId: string;
  stage: JobStage;
  type:
    | 'job_state_changed'
    | 'stage_progress'
    | 'page_done'
    | 'warning'
    | 'diagnostic_ready'
    | 'completed'
    | 'failed';
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export const JOB_STAGES: JobStage[] = [
  'PRECHECK',
  'CRAWL_GRAPH',
  'RENDER_AND_SNAPSHOT',
  'ASSET_FETCH_AND_REWRITE',
  'DIAGNOSTIC',
  'ROTATE_AND_UPLOAD',
  'FINALIZE',
];

export const STAGE_NAMES: StageName[] = JOB_STAGES;

export const JOB_EVENT_TYPES: JobEvent['type'][] = [
  'job_state_changed',
  'stage_progress',
  'page_done',
  'warning',
  'diagnostic_ready',
  'completed',
  'failed',
] as const;

export const DEFAULT_JOB_PROGRESS: JobProgress = {
  stage: 'PRECHECK',
  status: 'pending',
  percent: 0,
  message: 'Job queued',
};

export function isValidJobStage(stage: string): stage is JobStage {
  return JOB_STAGES.includes(stage as JobStage);
}

export function getJobStageIndex(stage: JobStage): number {
  const index = JOB_STAGES.indexOf(stage);
  if (index === -1) {
    throw new Error(`Unknown job stage: ${stage}`);
  }
  return index;
}

export function getNextStage(stage: JobStage): JobStage | undefined {
  const currentIndex = getJobStageIndex(stage);
  return JOB_STAGES[currentIndex + 1];
}

export function isTerminalStage(stage: JobStage): boolean {
  return stage === 'FINALIZE';
}

export function createJobProgress(
  stage: JobStage,
  status: JobStatus,
  percent: number,
  message: string,
): JobProgress {
  if (!isValidJobStage(stage)) {
    throw new Error(`Unknown job stage: ${stage}`);
  }

  const safePercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;

  return {
    stage,
    status,
    percent: safePercent,
    message,
  };
}

export function createJobEvent({
  jobId,
  stage,
  type,
  message,
  details,
  timestamp,
  id,
}: {
  jobId: string;
  stage: JobStage;
  type: JobEvent['type'];
  message: string;
  details?: Record<string, unknown>;
  timestamp?: string;
  id?: string;
}): JobEvent {
  if (!isValidJobStage(stage)) {
    throw new Error(`Unknown job stage: ${stage}`);
  }

  if (!JOB_EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown job event type: ${type}`);
  }

  return {
    id: id ?? `${jobId}:${stage}:${type}:${Date.now()}`,
    jobId,
    stage,
    type,
    message,
    details,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export interface JobEventEnvelope {
  id?: string;
  event: JobEvent['type'];
  data: JobEvent;
  retry?: number;
}

export function createJobEventEnvelope(event: JobEvent): JobEventEnvelope {
  return {
    id: event.id,
    event: event.type,
    data: event,
  };
}

export function serializeSseEvent(event: JobEventEnvelope): string {
  const payload = JSON.stringify(event.data);

  const lines = [`event: ${event.event}`];
  if (event.id) {
    lines.push(`id: ${event.id}`);
  }
  if (typeof event.retry === 'number') {
    lines.push(`retry: ${event.retry}`);
  }
  lines.push(`data: ${payload}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}
