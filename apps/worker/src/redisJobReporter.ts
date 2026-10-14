/**
 * Redis adapter for job state and the job event log.
 *
 * - `jobStateKey(id)`  : latest `Job` snapshot (JSON string)
 * - `jobEventsKey(id)` : Redis stream of `JobEvent`s. The web SSE endpoint
 *   reads this stream, and stream entry IDs become SSE event IDs so
 *   `Last-Event-ID` reconnects resume exactly where they left off.
 */

import type { Job, JobEvent } from '@wptossg/shared';
import { JOB_STATE_TTL_SECONDS, jobEventsKey, jobStateKey } from '@wptossg/shared';
import type { Redis } from 'ioredis';

export interface JobReporter {
  saveJob(job: Job): Promise<void>;
  publish(event: JobEvent): Promise<void>;
}

export class RedisJobReporter implements JobReporter {
  constructor(private readonly redis: Redis) {}

  async saveJob(job: Job): Promise<void> {
    await this.redis.set(jobStateKey(job.id), JSON.stringify(job), 'EX', JOB_STATE_TTL_SECONDS);
  }

  async publish(event: JobEvent): Promise<void> {
    const key = jobEventsKey(event.jobId);
    await this.redis.multi().xadd(key, '*', 'event', JSON.stringify(event)).expire(key, JOB_STATE_TTL_SECONDS).exec();
  }
}
