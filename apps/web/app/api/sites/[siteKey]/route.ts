import { getSavedSite } from '@wptossg/shared/site-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ siteKey: string }> }) {
  try {
    const { siteKey } = await context.params;
    const site = await getSavedSite(siteKey);
    return site ? Response.json(site) : Response.json({ error: 'サイトが見つかりません。' }, { status: 404 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
    console.error(JSON.stringify({ level: 'error', operation: 'get_site', code }));
    return Response.json({ error: 'サイト詳細を取得できませんでした。' }, { status: 503 });
  }
}
