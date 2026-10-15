import { listSavedSites } from '@wptossg/shared/site-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return Response.json({ sites: await listSavedSites() }); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
    console.error(JSON.stringify({ level: 'error', operation: 'list_sites', code }));
    return Response.json({ error: 'サイト一覧を取得できませんでした。' }, { status: 503 });
  }
}
