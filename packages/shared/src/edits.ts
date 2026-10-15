import type { DiagnosticResult, JobReport, SiteGraph, StorageBackend } from './index.js';

export const EDIT_STAGES = ['LOAD_BASE', 'GENERATE', 'VALIDATE', 'PREVIEW_READY', 'SAVE'] as const;
export type EditStage = typeof EDIT_STAGES[number];
export type EditStatus = 'queued' | 'generating' | 'ready' | 'saving' | 'saved' | 'failed' | 'discarded';
export interface EditFile { relativePath: string; content: string; mimeType: string }
export interface EditChange { path: string; action: 'add' | 'modify' | 'delete'; beforeHash?: string; afterHash?: string }
export interface EditUsage { model: string; inputTokens: number; outputTokens: number; inputMode: 'inline' | 'on-demand' }
export interface EditDraft {
  id: string;
  siteKey: string;
  siteUrl: string;
  baseVersionId: string;
  sourceJobId: string;
  parentDraftId?: string;
  instruction: string;
  status: EditStatus;
  stage: EditStage | 'FINALIZE';
  createdAt: string;
  updatedAt: string;
  summary?: string;
  changes?: EditChange[];
  usage?: EditUsage;
  diagnostic?: DiagnosticResult;
  graph?: SiteGraph;
  report?: JobReport;
  error?: string;
  previewUrl?: string;
  versionId?: string;
}
/** Worker-only payload. Never serialize files or publication state into UI responses. */
export interface StoredEdit extends EditDraft {
  previewToken?: string;
  files?: EditFile[];
  publication?: EditPublication;
}
export interface EditPublication {
  backend: StorageBackend;
  siteFolder: string;
  pending: string;
  current: string;
  previous?: string;
  archive?: string;
  archiveName?: string;
  archiveParent?: string;
  phase: 'prepared' | 'archived' | 'published';
}
export interface EditJobData { kind: 'ai-edit'; jobId: string; siteKey: string; action: 'generate' | 'save'; operationId?: string }
export function publicEdit(edit: StoredEdit): EditDraft {
  const { files: _files, publication: _publication, previewToken: _token, ...draft } = edit;
  return draft;
}
