/**
 * Local filesystem storage adapter for ROTATE_AND_UPLOAD.
 *
 * Used when GOOGLE_DRIVE_ENABLED=false so local runs still produce a
 * browsable result with the same layout and rotation as Drive:
 *
 *   {outputDir}/sites/{siteKey}/current/
 *   {outputDir}/sites/{siteKey}/archive/{timestamp}/
 */

import type { JobEvent } from '@wptossg/shared';
import { createJobEvent } from '@wptossg/shared';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RotateAndUploadResult, UploadFile } from './driveUpload.js';

export interface LocalRotateAndWriteOptions {
  siteKey: string;
  files: UploadFile[];
  /** Root directory that contains `sites/` (default: LOCAL_OUTPUT_DIR or ./output). */
  outputDir?: string;
  archiveTimestamp?: string;
}

export function resolveLocalOutputDir(outputDir?: string): string {
  return path.resolve(outputDir ?? process.env['LOCAL_OUTPUT_DIR'] ?? 'output');
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `relativePath` under `folder`, refusing paths that escape it. */
function resolveInside(folder: string, relativePath: string): string {
  const target = path.resolve(folder, relativePath.replace(/^\/+/, ''));
  if (target !== folder && !target.startsWith(`${folder}${path.sep}`)) {
    throw new Error(`Path escapes output folder: ${relativePath}`);
  }
  return target;
}

/** Write files into an existing folder; per-file failures are collected, not thrown. */
export async function writeFilesToLocalFolder(
  folder: string,
  files: UploadFile[],
): Promise<{ uploadedCount: number; failures: Array<{ relativePath: string; reason: string }> }> {
  const failures: Array<{ relativePath: string; reason: string }> = [];
  let uploadedCount = 0;

  for (const file of files) {
    try {
      const target = resolveInside(folder, file.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      uploadedCount += 1;
    } catch (error) {
      failures.push({ relativePath: file.relativePath, reason: normalizeError(error) });
    }
  }

  return { uploadedCount, failures };
}

export async function rotateAndWriteLocal(
  jobId: string,
  options: LocalRotateAndWriteOptions,
): Promise<RotateAndUploadResult> {
  const events: JobEvent[] = [];
  const emit = (type: JobEvent['type'], message: string, details?: Record<string, unknown>): void => {
    events.push(createJobEvent({ jobId, stage: 'ROTATE_AND_UPLOAD', type, message, details }));
  };

  const siteFolder = path.join(resolveLocalOutputDir(options.outputDir), 'sites', options.siteKey);
  const currentFolder = path.join(siteFolder, 'current');
  // `:` is not portable in directory names (Windows hosts via bind mounts).
  const archiveName = (options.archiveTimestamp ?? new Date().toISOString()).replace(/[:.]/g, '-');

  emit('stage_progress', 'ROTATE_AND_UPLOAD stage started (local output)', {
    siteKey: options.siteKey,
    fileCount: options.files.length,
    siteFolder,
  });

  let archiveFolder: string | undefined;
  if (await exists(currentFolder)) {
    archiveFolder = path.join(siteFolder, 'archive', archiveName);
    await mkdir(path.dirname(archiveFolder), { recursive: true });
    await rename(currentFolder, archiveFolder);
    emit('stage_progress', 'Existing current folder archived', { archiveFolder });
  } else {
    emit('stage_progress', 'No existing current folder found; skipping rotation');
  }

  await mkdir(currentFolder, { recursive: true });
  const { uploadedCount, failures } = await writeFilesToLocalFolder(currentFolder, options.files);

  for (const failure of failures) {
    emit('warning', 'File write failed', { relativePath: failure.relativePath, reason: failure.reason });
  }
  emit('stage_progress', 'ROTATE_AND_UPLOAD stage finished (local output)', {
    uploadedCount,
    failedCount: failures.length,
    currentFolder,
  });

  return {
    currentFolderId: currentFolder,
    archiveFolderId: archiveFolder,
    uploadedCount,
    uploadFailures: failures,
    events,
  };
}
