/**
 * BullMQ consumer for the `convert-site` queue.
 */

import type { ConvertSiteJobData, EditJobData, Job } from '@wptossg/shared';
import { runEditJob } from './editPipeline.js';
import { CONVERT_SITE_QUEUE } from '@wptossg/shared';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadPipelineConfig, runConvertSite } from './pipeline.js';
import { RedisJobReporter } from './redisJobReporter.js';

export interface QueueWorkerHandle {
  close(): Promise<void>;
}

export function startQueueWorker(redisUrl: string): QueueWorkerHandle {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const reporter = new RedisJobReporter(redis);
  const config = loadPipelineConfig();

  const worker = new Worker<ConvertSiteJobData | EditJobData, Job>(
    CONVERT_SITE_QUEUE,
    async (queueJob) => 'kind' in queueJob.data ? runEditJob(queueJob.data, reporter) : runConvertSite(queueJob.data, reporter, config),
    {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      // Playwright is memory-heavy, and concurrent runs for the same site
      // would race on the current/archive rotation.
      concurrency: 1,
      // Crawl + render of ~100 pages can hold the job for a long time.
      lockDuration: 5 * 60_000,
    },
  );

  worker.on('failed', (queueJob, error) => {
    console.log(
      JSON.stringify({ level: 'error', message: 'queue job failed', jobId: queueJob?.data.jobId, reason: error.message }),
    );
  });

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'convert-site queue worker started',
      queue: CONVERT_SITE_QUEUE,
      storageBackend: config.storageBackend,
      maxPages: config.maxPages,
      respectRobotsTxt: config.respectRobotsTxt,
    }),
  );

  return {
    async close() {
      await worker.close();
      redis.disconnect();
    },
  };
}
