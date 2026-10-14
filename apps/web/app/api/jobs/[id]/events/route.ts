import { createJobEventEnvelope, isTerminalJobStatus, serializeSseEvent, type JobEvent } from '@wptossg/shared';
import { followEvents, getJob } from '../../../../../lib/server/job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;

function isTerminalEvent(event: JobEvent): boolean {
  return event.type === 'completed' || event.type === 'failed';
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const jobState = await getJob(id);

  if (!jobState) {
    return Response.json({ error: 'Job not found.' }, { status: 404 });
  }

  const lastEventId = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('lastEventId');
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (value: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(value));
        }
      };
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        abort.abort();
        controller.close();
      };

      send(': connected\n\n');

      // Replays everything after Last-Event-ID, then blocks for new events.
      followEvents(
        id,
        lastEventId,
        {
          onEvent: (event) => {
            send(serializeSseEvent(createJobEventEnvelope(event)));
            if (isTerminalEvent(event)) {
              close();
            }
          },
          onIdle: () => {
            send(`: heartbeat ${new Date().toISOString()}\n\n`);
          },
        },
        { signal: abort.signal, blockMs: HEARTBEAT_INTERVAL_MS },
      )
        .catch((error: unknown) => {
          console.error(JSON.stringify({ level: 'error', message: 'SSE stream failed', jobId: id, reason: String(error) }));
        })
        .finally(close);

      // A job that already finished before the client connected has its terminal
      // event in the replay; this only guards against a missing terminal event.
      if (isTerminalJobStatus(jobState.job.status) && jobState.events.every((event) => !isTerminalEvent(event))) {
        close();
      }
    },
    cancel() {
      abort.abort();
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
