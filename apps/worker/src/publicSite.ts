/** Public artifact reader. Storage access stays inside the worker. */
import { load } from 'cheerio';
import { listSavedSites } from '@wptossg/shared/site-store';
import { pageUrlToRelativePath, type SavedSite } from '@wptossg/shared';
import { buildDriveClient, findFolder } from './driveUpload.js';
import type { drive_v3 } from 'googleapis';
import { readLocalPublicSite } from './localPublicSite.js';

export function safeSegments(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..' || /[\\\u0000-\u001f]/.test(p))) throw new Error('Invalid path');
  return parts;
}

export function rewritePublicContent(content: string, mime: string, domain: string, file: string, archive?: string, routes: Record<string, string> = {}): string {
  const prefix = `/sites/${domain}/`;
  const rewrite = (raw: string): string => {
    if (!raw || raw.startsWith('#') || /^(data:|mailto:|tel:|javascript:)/i.test(raw)) return raw;
    let url: URL;
    try { url = new URL(raw, `https://${domain}/${file}`); } catch { return raw; }
    if (url.hostname !== domain || !['https:', 'http:'].includes(url.protocol)) return raw;
    let path = url.pathname.replace(/^\//, '');
    if (Object.hasOwn(routes, path) && typeof routes[path] === 'string') path = routes[path]!.replace(/^\//, '');
    if (path.startsWith(`${domain}/`)) path = path.slice(domain.length + 1);
    url.searchParams.delete('archive');
    if (archive) url.searchParams.set('archive', archive);
    return `${prefix}${path}${url.search}${url.hash}`;
  };
  const css = (text: string) => text.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, quote: string, value: string) => `url(${quote}${rewrite(value)}${quote})`)
    .replace(/(@import\s+)(['"])(.*?)\2/gi, (_, start: string, quote: string, value: string) => `${start}${quote}${rewrite(value)}${quote}`);
  if (mime.includes('text/css')) return css(content);
  if (/(javascript|ecmascript)/.test(mime)) {
    return content.replace(/((?:\bfrom\s*|\bimport\s*\(?\s*)['"])([^'"]+)(['"])/g,
      (_, start: string, value: string, end: string) => {
        // Bare module specifiers are resolved by import maps, not URL paths.
        if (!/^(\.|\/|https?:)/.test(value)) return start + value + end;
        return start + rewrite(value) + end;
      });
  }
  if (!mime.includes('text/html')) return content;
  const $ = load(content);
  $('base').remove();
  $('[href], [src], [poster], [action], [data-src]').each((_, el) => {
    for (const attr of ['href', 'src', 'poster', 'action', 'data-src']) {
      const value = $(el).attr(attr);
      if (value) {
        const replacement = rewrite(value);
        $(el).attr(attr, replacement);
        // CSS and module scripts can change when their generation URLs are rewritten.
        if (replacement.startsWith(prefix)) $(el).removeAttr('integrity');
      }
    }
  });
  $('[srcset]').each((_, el) => {
    const value = $(el).attr('srcset')!;
    if (!value.includes('data:')) $(el).attr('srcset', value.split(',').map(part => {
      const [url, ...descriptor] = part.trim().split(/\s+/); return [rewrite(url!), ...descriptor].join(' ');
    }).join(', '));
  });
  $('[style]').each((_, el) => { $(el).attr('style', css($(el).attr('style')!)); });
  $('style').each((_, el) => { $(el).text(css($(el).text())); });
  $('meta[http-equiv="refresh"]').each((_, el) => {
    const value = $(el).attr('content'); if (value) $(el).attr('content', value.replace(/(url=)(.*)$/i, (_, key: string, url: string) => key + rewrite(url)));
  });
  return $.html();
}

async function child(drive: drive_v3.Drive, parent: string, name: string) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const result = await drive.files.list({ q: `'${parent}' in parents and name='${escaped}' and trashed=false`,
    fields: 'files(id,mimeType)', pageSize: 2, supportsAllDrives: true, includeItemsFromAllDrives: true });
  return result.data.files?.length === 1 ? result.data.files[0] : undefined;
}

export async function readPublicSite(domain: string, path: string, archive?: string, options: {
  driveClient?: drive_v3.Drive; sites?: SavedSite[]; rootFolderId?: string; localOutputDir?: string;
} = {}): Promise<{ body: Buffer; mime: string } | undefined> {
  if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) return;
  try { safeSegments(path); if (archive !== undefined && (!archive || safeSegments(archive).length !== 1)) return; } catch { return; }
  const site = (options.sites ?? await listSavedSites()).find(s => new URL(s.siteUrl).hostname === domain);
  if (!site) return;
  const normalized = path.replace(/^\/+/, '');
  const candidates = normalized.startsWith('assets/') ? [normalized] :
    [pageUrlToRelativePath(`https://${domain}/${normalized}`), `${domain}/${normalized}index.html`, normalized, `assets/${normalized}`];
  if (site.latest.artifactBackend === 'local') {
    const artifact = await readLocalPublicSite(site.siteKey, candidates, archive, options.localOutputDir);
    if (!artifact) return;
    const { mime, file, routes } = artifact;
    const body = /text\/(html|css|javascript)|ecmascript/.test(mime)
      ? Buffer.from(rewritePublicContent(artifact.body.toString('utf8'), mime, domain, file, archive, routes))
      : artifact.body;
    return { body, mime };
  }
  if (site.latest.artifactBackend !== 'google-drive') return;
  const drive = options.driveClient ?? buildDriveClient();
  const root = options.rootFolderId ?? process.env['GOOGLE_DRIVE_ROOT_FOLDER_ID'];
  if (!root) throw new Error('Drive is not configured');
  const sites = await findFolder(drive, root, 'sites');
  const folder = sites && await findFolder(drive, sites, site.siteKey);
  if (!folder) return;
  let generation: string | undefined;
  if (archive) {
    const archives = await findFolder(drive, folder, 'archive');
    generation = archives && await findFolder(drive, archives, archive);
  } else {
    const metadata = await drive.files.get({ fileId: folder, fields: 'appProperties', supportsAllDrives: true });
    generation = metadata.data.appProperties?.['publishedFolderId'];
    // Existing successful conversions remain browsable before their first new publication.
    if (!generation) generation = await findFolder(drive, folder, 'current');
  }
  if (!generation) return;
  for (const candidate of [...new Set(candidates)]) {
    let parent = generation;
    let entry: drive_v3.Schema$File | undefined;
    const parts = safeSegments(candidate);
    for (const [i, part] of parts.entries()) {
      entry = await child(drive, parent, part);
      if (!entry?.id) break;
      if (i < parts.length - 1 && entry.mimeType !== 'application/vnd.google-apps.folder') { entry = undefined; break; }
      parent = entry.id;
    }
    if (!entry?.id || entry.mimeType === 'application/vnd.google-apps.folder') continue;
    const result = await drive.files.get({ fileId: entry.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    let body = Buffer.from(result.data as ArrayBuffer);
    const mime = entry.mimeType ?? 'application/octet-stream';
    if (/text\/(html|css)|javascript|ecmascript/.test(mime)) {
      const manifest = await child(drive, generation, 'public-routes.json');
      let routes: Record<string, string> = {};
      if (manifest?.id) {
        const data = await drive.files.get({ fileId: manifest.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
        routes = JSON.parse(Buffer.from(data.data as ArrayBuffer).toString('utf8')) as Record<string, string>;
      }
      body = Buffer.from(rewritePublicContent(body.toString('utf8'), mime, domain, candidate, archive, routes));
    }
    return { body, mime };
  }
}
