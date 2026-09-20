/**
 * ROTATE_AND_UPLOAD stage
 *
 * Manages the Google Drive current/archive layout:
 *
 *   /sites/{siteKey}/current/      ← latest static output
 *   /sites/{siteKey}/archive/{ts}/ ← previous runs
 *
 * On the first run only `current` is created.
 * On subsequent runs the existing `current` folder is renamed/moved to
 * `archive/{iso-timestamp}` before a new `current` is populated.
 *
 * The archive rotation is retried up to MAX_ROTATION_RETRIES times because
 * Drive rename operations can be transiently flaky.
 *
 * Environment variables expected by the Drive adapter:
 *   GOOGLE_SERVICE_ACCOUNT_KEY   – JSON key of the service account (stringified)
 *   GOOGLE_DRIVE_ROOT_FOLDER_ID  – ID of the root folder in Drive that contains
 *                                   the `sites/` tree (must be pre-shared with
 *                                   the service account).
 */

import type { JobEvent } from '@wptossg/shared';
import { createJobEvent } from '@wptossg/shared';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UploadFile {
  /** Relative path within the `current` folder, e.g. `example.com/index.html` */
  relativePath: string;
  /** File content as a Buffer */
  content: Buffer;
  /** MIME type, e.g. `text/html` */
  mimeType: string;
}

export interface RotateAndUploadOptions {
  /** Key that identifies the site, used as the folder name under `sites/`. */
  siteKey: string;
  /** Files to upload into the new `current`. */
  files: UploadFile[];
  /** ISO timestamp string used as the archive sub-folder name (default: now). */
  archiveTimestamp?: string;
  /** Maximum number of rotation retry attempts (default: 3). */
  maxRotationRetries?: number;
  /** Delay in ms between rotation retries (default: 1000). */
  retryDelayMs?: number;
  /**
   * Optionally inject a pre-authenticated Drive client (useful for testing).
   * When omitted the adapter reads GOOGLE_SERVICE_ACCOUNT_KEY from the environment.
   */
  driveClient?: drive_v3.Drive;
  /**
   * ID of the root Drive folder that contains the `sites/` hierarchy.
   * Defaults to the GOOGLE_DRIVE_ROOT_FOLDER_ID environment variable.
   */
  rootFolderId?: string;
}

export interface RotateAndUploadResult {
  /** Drive folder ID of the newly created `current` folder. */
  currentFolderId: string;
  /** Drive folder ID of the archived folder, if rotation occurred. */
  archiveFolderId?: string;
  /** Number of files successfully uploaded. */
  uploadedCount: number;
  /** Files that failed to upload (path + reason). */
  uploadFailures: Array<{ relativePath: string; reason: string }>;
  events: JobEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_FOLDER_NAME = 'current';
const ARCHIVE_PARENT_FOLDER_NAME = 'archive';
const SITES_FOLDER_NAME = 'sites';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_MAX_ROTATION_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createUploadEvent(
  jobId: string,
  type: JobEvent['type'],
  message: string,
  details?: Record<string, unknown>,
): JobEvent {
  return createJobEvent({
    jobId,
    stage: 'ROTATE_AND_UPLOAD',
    type,
    message,
    details,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bufferToStream(buffer: Buffer): Readable {
  return Readable.from(buffer);
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

/**
 * Find a folder with the given name inside `parentId`, or return undefined.
 */
async function findFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<string | undefined> {
  // Escape backslashes first, then single quotes, to build a safe Drive query string.
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  return response.data.files?.[0]?.id ?? undefined;
}

/**
 * Create a folder with the given name inside `parentId` and return its ID.
 */
async function createFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<string> {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    },
    fields: 'id',
  });
  const id = response.data.id;
  if (!id) {
    throw new Error(`Drive folder creation returned no ID (name: ${name})`);
  }
  return id;
}

/**
 * Ensure a folder exists under `parentId` (create if absent) and return its ID.
 *
 * When an optional `cache` map is provided the promise for each `parentId:name`
 * key is stored in it, so concurrent callers that share a path prefix will
 * await the same promise rather than each performing their own
 * find-then-create pair (which would create duplicate folders).
 */
async function ensureFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  cache?: Map<string, Promise<string>>,
): Promise<string> {
  const cacheKey = `${parentId}:${name}`;
  if (cache) {
    const inflight = cache.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const promise = (async (): Promise<string> => {
    const existing = await findFolder(drive, parentId, name);
    if (existing) {
      return existing;
    }
    return createFolder(drive, parentId, name);
  })();

  if (cache) {
    cache.set(cacheKey, promise);
    // Remove poisoned entries so a subsequent caller can retry.
    promise.catch(() => {
      cache.delete(cacheKey);
    });
  }
  return promise;
}

/**
 * Move a Drive file/folder to a new parent and optionally rename it.
 * Uses the Drive files.update endpoint with `addParents`/`removeParents`.
 */
async function moveFolder(
  drive: drive_v3.Drive,
  fileId: string,
  oldParentId: string,
  newParentId: string,
  newName?: string,
): Promise<void> {
  await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: oldParentId,
    requestBody: newName ? { name: newName } : undefined,
    fields: 'id',
  });
}

/**
 * Upload a single file into a Drive folder, creating intermediate sub-folders
 * as needed for nested relative paths (e.g. `example.com/assets/style.css`).
 *
 * `folderCache` is a shared map used to deduplicate concurrent sub-folder
 * creation across parallel workers (see `ensureFolder`).
 *
 * Returns the Drive file ID on success, or throws on failure.
 */
async function uploadFile(
  drive: drive_v3.Drive,
  rootFolderId: string,
  file: UploadFile,
  folderCache: Map<string, Promise<string>>,
): Promise<string> {
  const parts = file.relativePath.split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('relativePath must not be empty');
  }

  // Ensure all intermediate sub-folders exist, using the shared cache to
  // avoid creating duplicate folders when concurrent workers share a prefix.
  let parentId = rootFolderId;
  for (const segment of parts.slice(0, -1)) {
    parentId = await ensureFolder(drive, parentId, segment, folderCache);
  }

  const fileName = parts[parts.length - 1]!;

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      mimeType: file.mimeType,
      body: bufferToStream(file.content),
    },
    fields: 'id',
  });

  const id = response.data.id;
  if (!id) {
    throw new Error(`Drive file upload returned no ID (path: ${file.relativePath})`);
  }
  return id;
}

/** Upload files in batches bounded by `concurrency`. */
async function uploadFiles(
  drive: drive_v3.Drive,
  currentFolderId: string,
  files: UploadFile[],
  concurrency: number,
): Promise<{ uploadedCount: number; failures: Array<{ relativePath: string; reason: string }> }> {
  const failures: Array<{ relativePath: string; reason: string }> = [];
  let uploadedCount = 0;
  let nextIndex = 0;
  // Shared folder-creation cache prevents duplicate folder creation when
  // concurrent workers resolve the same intermediate path prefix.
  const folderCache = new Map<string, Promise<string>>();

  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index]!;
      try {
        await uploadFile(drive, currentFolderId, file, folderCache);
        uploadedCount++;
      } catch (error) {
        failures.push({ relativePath: file.relativePath, reason: normalizeError(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return { uploadedCount, failures };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function buildDriveClient(): drive_v3.Drive {
  const rawKey = process.env['GOOGLE_SERVICE_ACCOUNT_KEY'];
  if (!rawKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');
  }

  let parsedKey: Record<string, unknown>;
  try {
    parsedKey = JSON.parse(rawKey) as Record<string, unknown>;
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: parsedKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

// ---------------------------------------------------------------------------
// Archive rotation (with retry)
// ---------------------------------------------------------------------------

/**
 * If a `current` folder already exists under `siteFolder`, move it to
 * `archive/{archiveTimestamp}` and return the new archive folder ID.
 *
 * Returns undefined when there is no existing `current` (first run).
 * Retries up to `maxRetries` times on transient Drive errors.
 */
async function rotateCurrentToArchive(
  drive: drive_v3.Drive,
  siteFolderId: string,
  archiveTimestamp: string,
  maxRetries: number,
  retryDelayMs: number,
): Promise<string | undefined> {
  const currentId = await findFolder(drive, siteFolderId, CURRENT_FOLDER_NAME);
  if (!currentId) {
    return undefined;
  }

  const archiveParentId = await ensureFolder(drive, siteFolderId, ARCHIVE_PARENT_FOLDER_NAME);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await moveFolder(drive, currentId, siteFolderId, archiveParentId, archiveTimestamp);
      return currentId;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await sleep(retryDelayMs);
      }
    }
  }

  throw new Error(
    `Failed to rotate current to archive after ${maxRetries} attempt(s): ${normalizeError(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * ROTATE_AND_UPLOAD stage entry point.
 *
 * 1. Resolve/create the Drive folder hierarchy:
 *    `{rootFolderId}/sites/{siteKey}/`
 * 2. If a `current` folder exists, archive it to
 *    `{rootFolderId}/sites/{siteKey}/archive/{archiveTimestamp}`.
 * 3. Create a fresh `current` folder.
 * 4. Upload all provided files into `current`, creating sub-folders as needed.
 *
 * Emits `JobEvent` records throughout for the event log / SSE stream.
 */
export async function rotateAndUpload(
  jobId: string,
  options: RotateAndUploadOptions,
): Promise<RotateAndUploadResult> {
  const {
    siteKey,
    files,
    archiveTimestamp = new Date().toISOString(),
    maxRotationRetries = DEFAULT_MAX_ROTATION_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    rootFolderId: rootFolderIdOverride,
  } = options;

  const events: JobEvent[] = [];

  events.push(
    createUploadEvent(jobId, 'stage_progress', 'ROTATE_AND_UPLOAD stage started', {
      siteKey,
      fileCount: files.length,
    }),
  );

  // --- Build or reuse Drive client ---
  let drive: drive_v3.Drive;
  try {
    drive = options.driveClient ?? buildDriveClient();
  } catch (error) {
    const reason = normalizeError(error);
    events.push(createUploadEvent(jobId, 'failed', 'Drive authentication failed', { reason }));
    throw new Error(`Drive authentication failed: ${reason}`);
  }

  // --- Resolve root folder ID ---
  const rootFolderId = rootFolderIdOverride ?? process.env['GOOGLE_DRIVE_ROOT_FOLDER_ID'];
  if (!rootFolderId) {
    const reason = 'GOOGLE_DRIVE_ROOT_FOLDER_ID environment variable is not set';
    events.push(createUploadEvent(jobId, 'failed', 'Missing root folder ID', { reason }));
    throw new Error(reason);
  }

  // --- Ensure sites/{siteKey} hierarchy ---
  let siteFolderId: string;
  try {
    const sitesFolderId = await ensureFolder(drive, rootFolderId, SITES_FOLDER_NAME);
    siteFolderId = await ensureFolder(drive, sitesFolderId, siteKey);
    events.push(
      createUploadEvent(jobId, 'stage_progress', 'Drive folder hierarchy resolved', {
        siteFolderId,
      }),
    );
  } catch (error) {
    const reason = normalizeError(error);
    events.push(createUploadEvent(jobId, 'failed', 'Failed to resolve Drive folder hierarchy', { reason }));
    throw new Error(`Failed to resolve Drive folder hierarchy: ${reason}`);
  }

  // --- Rotate existing current to archive ---
  let archiveFolderId: string | undefined;
  try {
    archiveFolderId = await rotateCurrentToArchive(
      drive,
      siteFolderId,
      archiveTimestamp,
      maxRotationRetries,
      retryDelayMs,
    );

    if (archiveFolderId) {
      events.push(
        createUploadEvent(jobId, 'stage_progress', 'Existing current folder archived', {
          archiveFolderId,
          archiveTimestamp,
        }),
      );
    } else {
      events.push(
        createUploadEvent(jobId, 'stage_progress', 'No existing current folder found; skipping rotation'),
      );
    }
  } catch (error) {
    const reason = normalizeError(error);
    events.push(
      createUploadEvent(jobId, 'failed', 'Archive rotation failed', {
        reason,
        archiveTimestamp,
      }),
    );
    throw new Error(`Archive rotation failed: ${reason}`);
  }

  // --- Create fresh current folder ---
  let currentFolderId: string;
  try {
    currentFolderId = await createFolder(drive, siteFolderId, CURRENT_FOLDER_NAME);
    events.push(
      createUploadEvent(jobId, 'stage_progress', 'New current folder created', {
        currentFolderId,
      }),
    );
  } catch (error) {
    const reason = normalizeError(error);
    events.push(createUploadEvent(jobId, 'failed', 'Failed to create current folder', { reason }));
    throw new Error(`Failed to create current folder: ${reason}`);
  }

  // --- Upload files ---
  if (files.length === 0) {
    events.push(createUploadEvent(jobId, 'warning', 'No files provided for upload; current folder is empty'));
    return { currentFolderId, archiveFolderId, uploadedCount: 0, uploadFailures: [], events };
  }

  events.push(
    createUploadEvent(jobId, 'stage_progress', 'Uploading files to current', {
      fileCount: files.length,
    }),
  );

  const { uploadedCount, failures: uploadFailures } = await uploadFiles(
    drive,
    currentFolderId,
    files,
    DEFAULT_CONCURRENCY,
  );

  for (const failure of uploadFailures) {
    events.push(
      createUploadEvent(jobId, 'warning', 'File upload failed', {
        relativePath: failure.relativePath,
        reason: failure.reason,
      }),
    );
  }

  events.push(
    createUploadEvent(jobId, 'stage_progress', 'ROTATE_AND_UPLOAD stage finished', {
      uploadedCount,
      failedCount: uploadFailures.length,
      archiveTimestamp: archiveFolderId ? archiveTimestamp : undefined,
    }),
  );

  return {
    currentFolderId,
    archiveFolderId,
    uploadedCount,
    uploadFailures,
    events,
  };
}
