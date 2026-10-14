import 'server-only';

import {
  CONVERT_SITE_QUEUE,
  JOB_STATE_TTL_SECONDS,
  createJobEvent,
  createSiteKey,
  jobEventsKey,
  jobStateKey,
  type ConvertSiteJobData,
  type Job,
  type JobEvent,
} from '@wptossg/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Job store backed by Redis.
 *
 * The web app only enqueues `convert-site` jobs; the worker runs the stages
 * and writes the job snapshot (`jobStateKey`) and events (`jobEventsKey`,
 * a Redis stream). Stream entry IDs are used as event IDs so SSE clients
 * can resume with `Last-Event-ID`.
 */

interface JobStoreState {
  redis: Redis;
  queue: Queue<ConvertSiteJobData>;
}

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const globalStore = globalThis as typeof globalThis & {
  __WPTOSSG_JOB_STORE__?: JobStoreState;
};

// Reuse connections across Next.js dev hot reloads.
function getStore(): JobStoreState {
  if (!globalStore.__WPTOSSG_JOB_STORE__) {
    globalStore.__WPTOSSG_JOB_STORE__ = {
      redis: new Redis(redisUrl, { maxRetriesPerRequest: 3 }),
      queue: new Queue<ConvertSiteJobData>(CONVERT_SITE_QUEUE, {
        connection: { url: redisUrl },
        defaultJobOptions: {
          // A retry would re-run the whole pipeline, including archive rotation;
          // re-submit from the UI instead.
          attempts: 1,
          removeOnComplete: { age: JOB_STATE_TTL_SECONDS },
          removeOnFail: { age: JOB_STATE_TTL_SECONDS },
        },
      }),
    };
  }
  return globalStore.__WPTOSSG_JOB_STORE__;
}

type StreamEntry = [id: string, fields: string[]];

function parseStreamEntry([id, fields]: StreamEntry): JobEvent | undefined {
  const index = fields.indexOf('event');
  const raw = index >= 0 ? fields[index + 1] : undefined;
  if (!raw) {
    return undefined;
  }
  try {
    return { ...(JSON.parse(raw) as JobEvent), id };
  } catch {
    return undefined;
  }
}

function parseStreamEntries(entries: StreamEntry[]): JobEvent[] {
  return entries.map(parseStreamEntry).filter((event): event is JobEvent => Boolean(event));
}

/** Stream IDs look like `1700000000000-0`; anything else (e.g. a stale client ID) restarts from the beginning. */
function toStreamCursor(lastEventId: string | null | undefined): string {
  return lastEventId && /^\d+-\d+$/.test(lastEventId) ? lastEventId : '0';
}

export async function createJob(siteUrl: string): Promise<{ job: Job; events: JobEvent[] }> {
  const { redis, queue } = getStore();
  const timestamp = new Date().toISOString();
  const job: Job = {
    id: crypto.randomUUID(),
    siteUrl,
    status: 'pending',
    currentStage: 'PRECHECK',
    createdAt: timestamp,
    updatedAt: timestamp,
    percent: 0,
  };
  const siteKey = createSiteKey(siteUrl);

  const acceptedEvent = createJobEvent({
    jobId: job.id,
    stage: 'PRECHECK',
    type: 'job_state_changed',
    message: 'Job accepted and queued',
    details: { siteKey, job },
  });

  const eventsKey = jobEventsKey(job.id);
  await redis
    .multi()
    .set(jobStateKey(job.id), JSON.stringify(job), 'EX', JOB_STATE_TTL_SECONDS)
    .xadd(eventsKey, '*', 'event', JSON.stringify(acceptedEvent))
    .expire(eventsKey, JOB_STATE_TTL_SECONDS)
    .exec();

  await queue.add(CONVERT_SITE_QUEUE, { jobId: job.id, siteUrl, siteKey }, { jobId: job.id });

  return { job, events: await listEvents(job.id) };
}

export async function getJob(jobId: string): Promise<{ job: Job; events: JobEvent[] } | undefined> {
  const { redis } = getStore();
  const raw = await redis.get(jobStateKey(jobId));
  if (!raw) {
    return undefined;
  }
  return { job: JSON.parse(raw) as Job, events: await listEvents(jobId) };
}

/** Events after `lastEventId` (exclusive), or all events when omitted. */
export async function listEvents(jobId: string, lastEventId?: string | null): Promise<JobEvent[]> {
  const { redis } = getStore();
  const cursor = toStreamCursor(lastEventId);
  const start = cursor === '0' ? '-' : `(${cursor}`;
  const entries = (await redis.xrange(jobEventsKey(jobId), start, '+')) as StreamEntry[];
  return parseStreamEntries(entries);
}

/**
 * Follow a job's event stream with blocking reads.
 *
 * Calls `onEvent` for each new event after `lastEventId` and `onIdle` when no
 * event arrived within `blockMs` (used for heartbeats). Resolves when
 * `signal` aborts. Uses a dedicated connection because XREAD BLOCK holds it.
 */
export async function followEvents(
  jobId: string,
  lastEventId: string | null | undefined,
  handlers: { onEvent: (event: JobEvent) => void; onIdle: () => void },
  options: { signal: AbortSignal; blockMs: number },
): Promise<void> {
  const connection = getStore().redis.duplicate();
  const stop = () => connection.disconnect();
  options.signal.addEventListener('abort', stop, { once: true });

  let cursor = toStreamCursor(lastEventId);
  try {
    while (!options.signal.aborted) {
      const result = (await connection.xread('BLOCK', options.blockMs, 'STREAMS', jobEventsKey(jobId), cursor)) as
        | Array<[key: string, entries: StreamEntry[]]>
        | null;

      const entries = result?.[0]?.[1] ?? [];
      if (entries.length === 0) {
        handlers.onIdle();
        continue;
      }

      for (const entry of entries) {
        cursor = entry[0];
        const event = parseStreamEntry(entry);
        if (event) {
          handlers.onEvent(event);
        }
      }
    }
  } catch (error) {
    // Disconnecting on abort rejects the pending XREAD; that is the normal exit.
    if (!options.signal.aborted) {
      throw error;
    }
  } finally {
    options.signal.removeEventListener('abort', stop);
    connection.disconnect();
  }
}
