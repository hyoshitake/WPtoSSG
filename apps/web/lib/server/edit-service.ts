import 'server-only';
import { getSavedSite } from '@wptossg/shared/site-store';
import { getEdit, insertEdit, transitionEdit, withSiteLock } from '@wptossg/shared/edit-store';
import { publicEdit, type StoredEdit } from '@wptossg/shared';
import { enqueueEdit } from './job-store';

export class EditRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function requestOrigin(request: Request): string {
  const url=new URL(request.url);
  // Next's server URL may use its internal hostname; the browser uses Host.
  const host=request.headers.get('host') ?? url.host;
  const protocol=request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.slice(0,-1);
  return new URL(`${protocol}://${host}`).origin;
}
export function sameOrigin(request: Request): void {
  const origin=request.headers.get('origin');
  if (origin && origin !== requestOrigin(request)) throw new EditRequestError('別オリジンからの操作は許可されていません。',403);
}
export function editResponse(edit: StoredEdit, request: Request) {
  const result=publicEdit(edit);
  if(result.previewUrl && new URL(result.previewUrl).origin===requestOrigin(request)) delete result.previewUrl;
  return result;
}
export async function createEdit(body: {siteKey?:string;instruction?:string;parentDraftId?:string}) {
  if(typeof body.siteKey!=='string' || typeof body.instruction!=='string' || !body.instruction.trim() || body.instruction.length>4000) throw new EditRequestError('サイトと4,000文字以内の修正指示を指定してください。');
  const site=await getSavedSite(body.siteKey);
  if(!site) throw new EditRequestError('対象サイトがありません。',404);
  let parent;
  if(body.parentDraftId) {
    parent=await getEdit(body.parentDraftId);
    if(!parent || parent.status!=='ready' || parent.siteKey!==site.siteKey) throw new EditRequestError('再指示の対象が利用できません。',409);
    if(parent.baseVersionId!==site.latest.id) throw new EditRequestError('currentが更新されています。サイトを再読み込みして再生成してください。',409);
  }
  const now=new Date().toISOString();
  const edit: StoredEdit={id:crypto.randomUUID(),siteKey:site.siteKey,siteUrl:site.siteUrl,baseVersionId:site.latest.id,
    sourceJobId:site.latest.sourceJobId ?? site.latest.jobId,parentDraftId:parent?.id,instruction:body.instruction.trim(),status:'queued',stage:'LOAD_BASE',createdAt:now,updatedAt:now};
  await insertEdit(edit);
  try { await enqueueEdit({kind:'ai-edit',jobId:edit.id,siteKey:edit.siteKey,action:'generate'}); }
  catch { await transitionEdit(edit.id,['queued'],'failed'); throw new EditRequestError('生成をキューに登録できませんでした。再試行してください。',503); }
  return edit;
}
export async function editAction(id: string, action: string) {
  const draft=await getEdit(id);
  if(!draft) throw new EditRequestError('修正案がありません。',404);
  if(action==='discard') {
    return withSiteLock(draft.siteKey,async () => {
      const latest=await getEdit(id);
      if(latest?.publication) throw new EditRequestError('保存処理を開始した案は破棄できません。保存を再試行してください。',409);
      const result=await transitionEdit(id,['ready','failed','queued'],'discarded');
      if(!result && latest?.status!=='discarded') throw new EditRequestError('処理中の案は破棄できません。',409);
      return result ?? latest!;
    },id);
  }
  if(action!=='save') throw new EditRequestError('不明な操作です。');
  if(draft.status==='saved') return draft;
  if(!draft.files?.length || !draft.report || !draft.graph || !draft.diagnostic) throw new EditRequestError('検証済みの修正案がありません。再生成してください。',409);
  const site=await getSavedSite(draft.siteKey);
  if(site?.latest.id!==draft.baseVersionId) throw new EditRequestError('currentが更新されています。サイトを再読み込みして再生成してください。',409);
  const result=await transitionEdit(id,['ready','failed'],'saving');
  if(!result && draft.status!=='saving') throw new EditRequestError('この案は保存できません。',409);
  try { await enqueueEdit({kind:'ai-edit',jobId:id,siteKey:draft.siteKey,action:'save'}); }
  catch { throw new EditRequestError('保存をキューに登録できませんでした。保存を再試行してください。',503); }
  return result ?? draft;
}
