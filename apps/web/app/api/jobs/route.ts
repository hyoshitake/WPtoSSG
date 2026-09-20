import type { JobCreateRequest } from '@wptossg/shared';
import { createJob } from '../../../lib/server/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeSiteUrl(siteUrl: string): string {
  const parsed = new URL(siteUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('http または https の URL を指定してください。');
  }
  return parsed.toString();
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as JobCreateRequest;
    if (!body.siteUrl?.trim()) {
      return Response.json({ error: 'siteUrl は必須です。' }, { status: 400 });
    }

    const siteUrl = normalizeSiteUrl(body.siteUrl.trim());
    const result = createJob(siteUrl);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'ジョブ作成に失敗しました。',
      },
      { status: 400 },
    );
  }
}
