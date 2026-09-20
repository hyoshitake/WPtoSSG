import { createJobEventEnvelope, serializeSseEvent } from '@wptossg/shared';
import { getJob, listEvents, subscribe } from '../../../../../lib/server/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;

function sendChunk(controller: ReadableStreamDefaultController<Uint8Array>, value: string): void {
  controller.enqueue(encoder.encode(value));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const job = getJob(id);

  if (!job) {
    return Response.json({ error: 'Job not found.' }, { status: 404 });
  }

  const lastEventId = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('lastEventId');

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sendChunk(controller, ': connected\n\n');

      for (const event of listEvents(id, lastEventId)) {
        sendChunk(controller, serializeSseEvent(createJobEventEnvelope(event)));
      }

      const unsubscribe = subscribe(id, (event) => {
        sendChunk(controller, serializeSseEvent(createJobEventEnvelope(event)));
      });

      const heartbeat = setInterval(() => {
        sendChunk(controller, `: heartbeat ${new Date().toISOString()}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        controller.close();
      };

      request.signal.addEventListener('abort', close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}
