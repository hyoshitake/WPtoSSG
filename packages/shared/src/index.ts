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
