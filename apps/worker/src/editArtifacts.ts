/** Static artifact adapters used only in the worker. Drafts live in PostgreSQL. */
import { readdir, readFile, lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EditFile, EditPublication, SiteDetail, StoredEdit } from '@wptossg/shared';
import type { drive_v3 } from 'googleapis';
import { updateEdit } from '@wptossg/shared/edit-store';
import { buildDriveClient, findFolder, uploadFilesToDriveFolder, type UploadFile } from './driveUpload.js';
import { resolveLocalOutputDir, writeFilesToLocalFolder } from './localOutput.js';

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export function safeFile(name: string): string {
  if (!name || name.length > 500 || name.startsWith('/') || /[\\\u0000-\u001f?#%:]/.test(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('不正な成果物パスです。');
  return name;
}
export function mimeFor(name: string): string {
  const types: Record<string,string> = { '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
    '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
    '.webp':'image/webp', '.avif':'image/avif', '.gif':'image/gif', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.pdf':'application/pdf' };
  return types[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
export function uploadFiles(files: EditFile[]): UploadFile[] {
  return files.map(f => ({...f,content:Buffer.from(f.content,'base64')}));
}
export async function readBaseFiles(site: SiteDetail): Promise<EditFile[]> {
  const files: EditFile[] = [];
  let bytes = 0;
  const add = (name: string, content: Buffer, mimeType: string) => {
    safeFile(name); bytes += content.length;
    if (bytes > MAX_ARTIFACT_BYTES || files.length >= 3000) throw new Error('編集対象は50 MiB・3,000ファイルまでです。');
    files.push({ relativePath:name,content:content.toString('base64'),mimeType });
  };
  if (site.latest.artifactBackend === 'local') {
    const root = path.join(resolveLocalOutputDir(), 'sites', safeFile(site.siteKey), 'current');
    const walk = async (folder: string, prefix = ''): Promise<void> => {
      if ((await lstat(folder)).isSymbolicLink()) throw new Error('シンボリックリンクは編集できません。');
      for (const entry of await readdir(folder, { withFileTypes:true })) {
        const relative = `${prefix}${entry.name}`; const target = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new Error('シンボリックリンクは編集できません。');
        if (entry.isDirectory()) await walk(target, `${relative}/`);
        else if (entry.isFile()) add(relative, await readFile(target), mimeFor(relative));
      }
    };
    await walk(root);
  } else if (site.latest.artifactBackend === 'google-drive') {
    const drive = buildDriveClient();
    const folderId = site.latest.report.storage?.currentFolderId;
    if (!folderId) throw new Error('基準版のDriveフォルダが不明です。再変換してください。');
    const walk = async (parent: string, prefix = ''): Promise<void> => {
      let pageToken: string | undefined;
      do {
        const response = await drive.files.list({ q:`'${parent}' in parents and trashed=false`, fields:'nextPageToken,files(id,name,mimeType,size)',
          pageToken, pageSize:1000,supportsAllDrives:true,includeItemsFromAllDrives:true });
        for (const f of response.data.files ?? []) {
          if (!f.id || !f.name) throw new Error('Drive成果物のメタデータが不完全です。');
          const name = `${prefix}${f.name}`; safeFile(name);
          if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id, `${name}/`);
          else {
            if (bytes + Number(f.size ?? 0) > MAX_ARTIFACT_BYTES) throw new Error('編集対象は50 MiBまでです。');
            const result = await drive.files.get({fileId:f.id,alt:'media',supportsAllDrives:true},{responseType:'arraybuffer'});
            add(name,Buffer.from(result.data as ArrayBuffer),f.mimeType ?? mimeFor(name));
          }
        }
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
    };
    await walk(folderId);
  } else throw new Error('基準版の保存先が不明です。再変換してください。');
  if (new Set(files.map(f => f.relativePath)).size !== files.length) throw new Error('成果物パスが重複しています。');
  return files;
}
async function exists(target: string) {
  try { await lstat(target); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
/** Persist intent before any rotation; the same IDs are reused after crashes. */
export async function prepareEditPublication(edit: StoredEdit, site: SiteDetail, driveClient?: drive_v3.Drive): Promise<EditPublication> {
  if (edit.publication) return edit.publication;
  const archiveName=`${new Date().toISOString().replace(/[:.]/g,'-')}-${edit.id}`;
  if (site.latest.artifactBackend === 'local') {
    const siteFolder = path.join(resolveLocalOutputDir(),'sites',safeFile(edit.siteKey));
    const plan: EditPublication = {backend:'local',siteFolder,pending:path.join(siteFolder,`pending-edit-${edit.id}`),
      current:path.join(siteFolder,'current'),previous:path.join(siteFolder,'current'),archive:path.join(siteFolder,'archive',archiveName),archiveName,phase:'prepared'};
    edit.publication = plan; await updateEdit(edit);
    return plan;
  }
  const drive = driveClient ?? buildDriveClient();
  const root = process.env['GOOGLE_DRIVE_ROOT_FOLDER_ID'];
  if (!root) throw new Error('Driveの設定がありません。');
  const sites = await findFolder(drive,root,'sites');
  const siteFolder = sites && await findFolder(drive,sites,edit.siteKey);
  if (!siteFolder) throw new Error('Driveサイトフォルダがありません。');
  const make = async (parent: string,name: string) => {
    const previous = await findFolder(drive,parent,name); if (previous) return previous;
    const result = await drive.files.create({requestBody:{name,mimeType:'application/vnd.google-apps.folder',parents:[parent]},fields:'id',supportsAllDrives:true});
    if (!result.data.id) throw new Error('Driveフォルダを準備できませんでした。');
    return result.data.id;
  };
  const previous = site.latest.report.storage?.currentFolderId;
  const pending = await make(siteFolder,`pending-edit-${edit.id}`);
  const archiveParent = await make(siteFolder,'archive');
  const plan: EditPublication = {backend:'google-drive',siteFolder,pending,current:pending,previous,archive:previous,archiveParent,archiveName,phase:'prepared'};
  edit.publication = plan; await updateEdit(edit);
  return plan;
}
export async function publishEditArtifacts(edit: StoredEdit, driveClient?: drive_v3.Drive): Promise<void> {
  const plan = edit.publication!;
  if (plan.phase === 'published') return;
  const files = uploadFiles(edit.files!);
  // The final report records the durable, idempotent publication targets.
  if (edit.report) {
    edit.report.storage = { backend:plan.backend,reportPath:`/sites/${edit.siteKey}/current/report.json`,currentFolderId:plan.current,
      currentLocation:plan.backend === 'local' ? plan.current : `https://drive.google.com/drive/folders/${plan.current}`, archiveFolderId:plan.archive };
    const file = {relativePath:'report.json',content:Buffer.from(JSON.stringify(edit.report,null,2)),mimeType:'application/json'};
    const index = files.findIndex(f => f.relativePath === file.relativePath);
    if (index >= 0) files[index] = file; else files.push(file);
    await updateEdit(edit);
  }
  if (plan.backend === 'local') {
    // Marker makes rename-success/DB-failure detectable after restart.
    const marker = '.wptossg-edit-version';
    const isPublished = async () => {
      try { return (await readFile(path.join(plan.current,marker),'utf8')) === edit.id; } catch { return false; }
    };
    if (await isPublished()) { plan.phase = 'published'; await updateEdit(edit); return; }
    if (plan.phase === 'archived' && await exists(plan.current) && !await exists(plan.archive!)) {
      // Recovery was completed on disk but its DB update was interrupted.
      plan.phase = 'prepared'; await updateEdit(edit);
    }
    if (plan.phase === 'prepared') {
      await mkdir(plan.pending,{recursive:true});
      const result = await writeFilesToLocalFolder(plan.pending,files);
      if (result.failures.length) throw new Error('新版ファイルの準備に失敗しました。保存を再試行してください。');
      await writeFile(path.join(plan.pending,marker),edit.id);
      await mkdir(path.dirname(plan.archive!),{recursive:true});
      if (!await exists(plan.archive!)) await rename(plan.current,plan.archive!);
      plan.phase = 'archived'; await updateEdit(edit);
    }
    try { await rename(plan.pending,plan.current); }
    catch (error) {
      // Keep the previous version readable; the plan is retained for retry.
      if (!await exists(plan.current) && await exists(plan.archive!)) {
        await rename(plan.archive!,plan.current); plan.phase = 'prepared'; await updateEdit(edit);
      }
      throw error;
    }
  } else {
    const drive = driveClient ?? buildDriveClient();
    const metadata = await drive.files.get({fileId:plan.siteFolder,fields:'appProperties',supportsAllDrives:true});
    if (metadata.data.appProperties?.['publishedFolderId'] === plan.current) {
      plan.phase = 'published'; await updateEdit(edit); return;
    }
    if (plan.phase === 'prepared') {
      // Clear partial uploads in the private pending generation before retrying.
      let token: string | undefined;
      const partialIds: string[]=[];
      do {
        const response = await drive.files.list({q:`'${plan.pending}' in parents and trashed=false`,fields:'nextPageToken,files(id)',pageSize:1000,
          pageToken:token,supportsAllDrives:true,includeItemsFromAllDrives:true});
        for (const file of response.data.files ?? []) if (file.id) partialIds.push(file.id);
        token = response.data.nextPageToken ?? undefined;
      } while (token);
      // Do not mutate a paginated result set while its remaining pages are read.
      for(const fileId of partialIds) await drive.files.update({fileId,requestBody:{trashed:true},supportsAllDrives:true});
      const result = await uploadFilesToDriveFolder(plan.pending,files,{driveClient:drive});
      if (result.failures.length) throw new Error('Driveへの準備に失敗しました。保存を再試行してください。');
      if (plan.previous) {
        // Pin old published generation so readers survive the archive move.
        await drive.files.update({fileId:plan.siteFolder,requestBody:{appProperties:{publishedFolderId:plan.previous}},supportsAllDrives:true});
        const old = await drive.files.get({fileId:plan.previous,fields:'parents',supportsAllDrives:true});
        if (!old.data.parents?.includes(plan.archiveParent!)) await drive.files.update({fileId:plan.previous,
          addParents:plan.archiveParent,removeParents:plan.siteFolder,requestBody:{name:plan.archiveName ?? `edit-${edit.id}`},supportsAllDrives:true});
      }
      plan.phase = 'archived'; await updateEdit(edit);
    }
    await drive.files.update({fileId:plan.pending,requestBody:{name:'current'},supportsAllDrives:true});
    await drive.files.update({fileId:plan.siteFolder,requestBody:{appProperties:{publishedFolderId:plan.current}},supportsAllDrives:true});
  }
  plan.phase = 'published'; await updateEdit(edit);
}
