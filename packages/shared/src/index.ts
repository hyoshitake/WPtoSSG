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

export function normalizeGraphUrl(
  url: string,
  siteUrl?: string,
  options: { normalizeQueryStrings?: boolean; preserveHash?: boolean } = {},
): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const finalUrl = siteUrl ? new URL(trimmed, siteUrl) : new URL(trimmed);
    const normalized = new URL(finalUrl.toString());

    normalized.hash = options.preserveHash ? normalized.hash : '';

    if (options.normalizeQueryStrings) {
      normalized.search = '';
    }

    if (normalized.pathname === '') {
      normalized.pathname = '/';
    }

    if (normalized.pathname.length > 1 && normalized.pathname.endsWith('/')) {
      normalized.pathname = normalized.pathname.replace(/\/+$/, '');
    }

    return normalized.toString().replace(/\/$/, '') || `${normalized.origin}/`;
  } catch {
    return trimmed;
  }
}

export function createGraphNodeId(url: string): string {
  return encodeURIComponent(normalizeGraphUrl(url));
}

export function isGraphCandidateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname;
  } catch {
    return false;
  }
}

export function classifyGraphNodeKind(url: string, siteUrl: string): GraphNodeKind {
  try {
    const parsed = new URL(url, siteUrl);
    const pathname = parsed.pathname.toLowerCase();

    if (parsed.origin !== new URL(siteUrl).origin && !['http:', 'https:'].includes(parsed.protocol)) {
      return 'external';
    }

    if (/\.(css|js|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|ico|pdf|zip|mp4|mp3)(?:[?#]|$)/i.test(pathname)) {
      return 'asset';
    }

    if (/\/wp-json\b|\/api\b|graphql|api\./i.test(pathname + parsed.search)) {
      return 'api';
    }

    if (parsed.searchParams.has('s') || /\bform\b|wp-login|login/i.test(pathname + parsed.search)) {
      return 'form';
    }

    return 'page';
  } catch {
    return 'external';
  }
}

export function isUrlWithinSiteScope(url: string, siteUrl: string): boolean {
  try {
    const base = new URL(siteUrl);
    const target = new URL(url, siteUrl);

    if (target.origin === base.origin) {
      return true;
    }

    const baseHost = base.hostname.toLowerCase().replace(/^www\./, '');
    const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');

    return targetHost === baseHost || targetHost.endsWith(`.${baseHost}`);
  } catch {
    return false;
  }
}

export function createGraphNode(
  url: string,
  kind: GraphNodeKind = 'page',
  metadata: Record<string, unknown> = {},
  title?: string,
): GraphNode {
  const normalized = normalizeGraphUrl(url);
  return {
    id: createGraphNodeId(normalized),
    url: normalized,
    kind,
    title,
    status: 'pending',
    metadata,
  };
}

export function createGraphEdge(
  from: string,
  to: string,
  type: EdgeType = 'links_to',
  metadata: Record<string, unknown> = {},
): GraphEdge {
  const fromId = createGraphNodeId(from);
  const toId = createGraphNodeId(to);

  return {
    id: `${fromId}:${type}:${toId}`,
    from: fromId,
    to: toId,
    type,
    metadata,
  };
}

export function createEmptySiteGraph(siteUrl: string): SiteGraph {
  const timestamp = new Date().toISOString();
  return {
    id: createGraphNodeId(siteUrl || 'site'),
    siteUrl: normalizeGraphUrl(siteUrl),
    nodes: [],
    edges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function addGraphNode(graph: SiteGraph, node: GraphNode): GraphNode {
  if (graph.nodes.some((existing) => existing.id === node.id)) {
    const current = graph.nodes.find((existing) => existing.id === node.id);
    if (current) {
      Object.assign(current, node);
      graph.updatedAt = new Date().toISOString();
      return current;
    }
  }

  graph.nodes.push(node);
  graph.updatedAt = new Date().toISOString();
  return node;
}

export function addGraphEdge(graph: SiteGraph, fromUrl: string, toUrl: string, type: EdgeType = 'links_to', metadata: Record<string, unknown> = {}): GraphEdge | undefined {
  if (!fromUrl || !toUrl) {
    return undefined;
  }

  const fromNode = addGraphNode(
    graph,
    createGraphNode(fromUrl, classifyGraphNodeKind(fromUrl, graph.siteUrl), { source: 'crawl' }),
  );
  const toNode = addGraphNode(
    graph,
    createGraphNode(toUrl, classifyGraphNodeKind(toUrl, graph.siteUrl), { source: 'crawl' }),
  );

  const edge = createGraphEdge(fromNode.url, toNode.url, type, metadata);
  const exists = graph.edges.some((existing) => existing.id === edge.id);
  if (exists) {
    return graph.edges.find((existing) => existing.id === edge.id);
  }

  graph.edges.push(edge);
  graph.updatedAt = new Date().toISOString();
  return edge;
}

export function buildSiteGraph(
  siteUrl: string,
  discoveredUrls: Iterable<string> = [],
  options: {
    normalizeQueryStrings?: boolean;
    includeExternalLinks?: boolean;
  } = {},
): SiteGraph {
  const graph = createEmptySiteGraph(siteUrl);
  const rootNode = createGraphNode(siteUrl, 'page', { source: 'root' }, 'Home');
  addGraphNode(graph, rootNode);

  const normalizedOptions = {
    normalizeQueryStrings: Boolean(options.normalizeQueryStrings),
    includeExternalLinks: Boolean(options.includeExternalLinks),
  };

  const seen = new Set<string>();

  for (const candidate of discoveredUrls) {
    if (!candidate) {
      continue;
    }

    const normalizedCandidate = normalizeGraphUrl(candidate, siteUrl, {
      normalizeQueryStrings: normalizedOptions.normalizeQueryStrings,
    });
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue;
    }

    seen.add(normalizedCandidate);
    const kind = isUrlWithinSiteScope(normalizedCandidate, siteUrl)
      ? classifyGraphNodeKind(normalizedCandidate, siteUrl)
      : 'external';
    const node = createGraphNode(normalizedCandidate, kind, { source: 'crawl' });
    addGraphNode(graph, node);

    if (normalizedOptions.includeExternalLinks || kind !== 'external') {
      addGraphEdge(graph, siteUrl, normalizedCandidate, kind === 'external' ? 'references' : 'links_to', {
        discoveredFrom: siteUrl,
      });
    }
  }

  return graph;
}

export const createSiteGraph = buildSiteGraph;
export const buildCrawlGraph = buildSiteGraph;
export const createCrawlGraph = buildSiteGraph;
export const addSiteGraphNode = addGraphNode;
export const linkGraphNodes = addGraphEdge;
export const normalizeUrlForGraph = normalizeGraphUrl;
export const isUrlInSiteScope = isUrlWithinSiteScope;
