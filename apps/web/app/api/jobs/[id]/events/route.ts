import { createJobEventEnvelope, serializeSseEvent } from '@wptossg/shared';
import { getJob, listEvents, subscribe } from '../../../../../lib/server/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed';
}

function sendChunk(controller: ReadableStreamDefaultController<Uint8Array>, value: string): void {
  controller.enqueue(encoder.encode(value));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const jobState = getJob(id);

  if (!jobState) {
    return Response.json({ error: 'Job not found.' }, { status: 404 });
  }

  const lastEventId = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('lastEventId');

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let latestEventId = lastEventId;
      const resources: {
        heartbeat?: ReturnType<typeof setInterval>;
        unsubscribe?: () => void;
      } = {};

      sendChunk(controller, ': connected\n\n');

      for (const event of listEvents(id, lastEventId)) {
        sendChunk(controller, serializeSseEvent(createJobEventEnvelope(event)));
        latestEventId = event.id;
      }

      if (isTerminalStatus(jobState.job.status)) {
        controller.close();
        return;
      }

      const close = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (resources.heartbeat) {
          clearInterval(resources.heartbeat);
        }
        resources.unsubscribe?.();
        controller.close();
      };

      resources.unsubscribe = subscribe(id, (event) => {
        latestEventId = event.id;
        sendChunk(controller, serializeSseEvent(createJobEventEnvelope(event)));
        if (event.type === 'completed' || event.type === 'failed') {
          close();
        }
      });

      for (const event of listEvents(id, latestEventId)) {
        latestEventId = event.id;
        sendChunk(controller, serializeSseEvent(createJobEventEnvelope(event)));
      }

      const currentJobState = getJob(id);
      if (!resources.unsubscribe || !currentJobState || isTerminalStatus(currentJobState.job.status)) {
        close();
        return;
      }

      resources.heartbeat = setInterval(() => {
        sendChunk(controller, `: heartbeat ${new Date().toISOString()}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);

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
