import { getJob } from '../../../../lib/server/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = getJob(id);

  if (!job) {
    return Response.json({ error: 'Job not found.' }, { status: 404 });
  }

  return Response.json(job);
}
