import type { DiagnosticResult, Job, JobReport, SiteGraph } from './index.js';

export interface SiteVersion {
  id: string;
  siteKey: string;
  jobId: string;
  source: 'conversion' | 'ai-edit';
  sourceJobId?: string;
  baseVersionId?: string;
  editJobId?: string;
  draftId?: string;
  savedAt: string;
  report: JobReport;
  diagnostic?: DiagnosticResult;
  graph?: SiteGraph;
  artifactLocation?: string;
  artifactBackend?: 'local' | 'google-drive';
}
export interface SavedSite {
  siteKey: string;
  name: string;
  siteUrl: string;
  latest: SiteVersion;
}
export interface SiteDetail extends SavedSite { versions: SiteVersion[] }

export function savedVersion(job: Job, siteKey: string): SiteVersion | undefined {
  const report = job.report;
  if (job.status !== 'completed' || !report?.storage?.currentFolderId ||
      report.stageBreakdown.some(s => s.stage === 'ROTATE_AND_UPLOAD' && s.failedCount > 0)) return;
  return { id: job.id, jobId: job.id, siteKey, source: 'conversion', savedAt: report.generatedAt,
    report, diagnostic: job.diagnostic, graph: job.graph,
    artifactLocation: report.storage.currentLocation, artifactBackend: report.storage.backend };
}
