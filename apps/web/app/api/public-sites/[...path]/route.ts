export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const source = new URL(request.url);
  const base = process.env.WORKER_PUBLIC_URL ?? 'http://localhost:4001';
  const url = new URL(`/public-sites/${path.map(encodeURIComponent).join('/')}`, base);
  const archive = source.searchParams.get('archive');
  if (archive !== null) url.searchParams.set('archive', archive);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    return new Response(response.body, { status: response.status, headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups",
    } });
  } catch {
    return new Response('artifact service unavailable', { status: 502 });
  }
}
