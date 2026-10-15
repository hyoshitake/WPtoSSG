import { timingSafeEqual } from 'node:crypto';
import { getEdit } from '@wptossg/shared/edit-store';
import { rewritePublicContent, safeSegments } from './publicSite.js';
import { resolveEditFile, routeMap } from './editValidation.js';

export async function readEditPreview(id: string, token: string, relative: string) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{48}$/.test(token)) return;
  try { safeSegments(relative); } catch { return; }
  const edit=await getEdit(id);
  if(!edit?.previewToken || !edit.files || !['ready','saving','saved','failed'].includes(edit.status)) return;
  const expected=Buffer.from(edit.previewToken); const supplied=Buffer.from(token);
  if(expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) return;
  // Private metadata and publication markers are never preview resources.
  if(relative.split('/').some(p=>p.startsWith('.')) || /(^|\/)(report|graph|public-routes)\.json$/.test(relative)) return;
  const file=resolveEditFile(edit.files,edit.siteUrl,relative);
  if(!file) return;
  let body=Buffer.from(file.content,'base64');
  if(/text\/(html|css|javascript)|ecmascript/.test(file.mimeType)) {
    const host=new URL(edit.siteUrl).hostname;
    const text=rewritePublicContent(body.toString('utf8'),file.mimeType,host,file.relativePath,undefined,routeMap(edit.files));
    body=Buffer.from(text.split(`/sites/${host}/`).join(`/edit-preview/${id}/${token}/`));
  }
  return {body,mime:file.mimeType};
}
