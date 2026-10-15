/** Read only artifacts inside a site's current or explicitly selected archive. */
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveLocalOutputDir } from './localOutput.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

/** Resolve symlinks as well as '..', refusing targets outside the allowed folder. */
async function inside(folder: string, relative: string): Promise<string | undefined> {
  try {
    const target = await realpath(path.resolve(folder, relative));
    return target.startsWith(`${folder}${path.sep}`) ? target : undefined;
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

export async function readLocalPublicSite(siteKey: string, candidates: string[], archive?: string, outputDir?: string) {
  if (!siteKey || /[/\\]/.test(siteKey) || siteKey === '.' || siteKey === '..') return;
  let root: string;
  try { root = await realpath(resolveLocalOutputDir(outputDir)); }
  catch (error) { if (missing(error)) return; throw error; }
  const siteFolder = await inside(root, path.join('sites', siteKey));
  if (!siteFolder || siteFolder !== path.join(root, 'sites', siteKey)) return;
  const generation = await inside(siteFolder, archive === undefined ? 'current' : path.join('archive', archive));
  if (!generation) return;
  for (const file of [...new Set(candidates)]) {
    const target = await inside(generation, file);
    if (!target) continue;
    try {
      if (!(await stat(target)).isFile()) continue;
      const body = await readFile(target);
      const mime = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      let routes: Record<string, string> = {};
      if (/text\/(html|css|javascript)|ecmascript/.test(mime)) {
        const manifest = await inside(generation, 'public-routes.json');
        if (manifest) routes = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, string>;
      }
      return { body, mime, file, routes };
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
  }
}
