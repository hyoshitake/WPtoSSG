import { createEdit, editResponse, EditRequestError, sameOrigin } from '../../../lib/server/edit-service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if(Number(request.headers.get('content-length') ?? 0)>20000) throw new EditRequestError('指示が長すぎます。');
    const text=await request.text();
    if(text.length>12000) throw new EditRequestError('指示が長すぎます。');
    const edit=await createEdit(JSON.parse(text));
    return Response.json({edit:editResponse(edit,request)},{status:202});
  } catch(error) {
    return Response.json({error:error instanceof EditRequestError?error.message:'編集の受付に失敗しました。再試行してください。'},
      {status:error instanceof EditRequestError?error.status:503});
  }
}
