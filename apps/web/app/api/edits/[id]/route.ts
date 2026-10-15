import { getEdit, listEditEvents } from '@wptossg/shared/edit-store';
import { editAction, editResponse, EditRequestError, sameOrigin } from '../../../../lib/server/edit-service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request: Request, context: {params:Promise<{id:string}>}) {
  const {id}=await context.params;
  try {
    const edit=await getEdit(id);
    return edit?Response.json({edit:editResponse(edit,request),events:await listEditEvents(id)},{headers:{'Cache-Control':'no-store'}}):Response.json({error:'修正案がありません。'},{status:404});
  } catch { return Response.json({error:'修正案を取得できませんでした。'},{status:503}); }
}
export async function POST(request: Request, context: {params:Promise<{id:string}>}) {
  try {
    sameOrigin(request);
    const {id}=await context.params;
    const {action}=await request.json();
    const edit=await editAction(id,action);
    return Response.json({edit:editResponse(edit,request)},{status:edit.status==='saved'||edit.status==='discarded'?200:202});
  } catch(error) {
    return Response.json({error:error instanceof EditRequestError?error.message:'操作に失敗しました。時間をおいて再試行してください。'},
      {status:error instanceof EditRequestError?error.status:503});
  }
}
