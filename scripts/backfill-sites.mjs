// Input: verified historical Job snapshots as a JSON array. Does not read/move artifacts.
import { readFile } from 'node:fs/promises';
import { createSiteKey, savedVersion } from '../packages/shared/dist/index.js';
import { recordSavedSite } from '../packages/shared/dist/site-store.js';
const jobs = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const job of jobs.sort((a, b) => a.report.generatedAt.localeCompare(b.report.generatedAt))) {
  const key = createSiteKey(job.siteUrl);
  if (!savedVersion(job, key)) throw new Error(`Not a verified saved version: ${job.id}`);
  await recordSavedSite(job, key);
  console.log(JSON.stringify({ jobId: job.id, siteKey: key }));
}
process.exit(0);
