import assert from 'node:assert/strict';
import pg from 'pg';
import { recordSavedSite, listSavedSites, getSavedSite } from '../packages/shared/dist/site-store.js';
const key = `test-${Date.now()}`;
const connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
await connection.connect();
function job(id, time, overrides = {}) {
  return { id: `${key}-${id}`, siteUrl: `https://${key}.example/path`, status: 'completed',
    report: { generatedAt: time, successCount: 1, failedCount: 0, warnings: 0,
      stageBreakdown: [{ stage: 'ROTATE_AND_UPLOAD', failedCount: 0, successCount: 1 }],
      storage: { backend: 'local', currentFolderId: '/current', currentLocation: '/current' } }, ...overrides };
}
try {
  const first = job('a', '2026-01-01T00:00:00Z');
  await recordSavedSite(first, key);
  await recordSavedSite(first, key);
  assert.equal((await getSavedSite(key)).versions.length, 1);
  const second = job('b', '2026-01-02T00:00:00Z');
  second.report.storage.archiveFolderId = '/archive/a';
  await recordSavedSite(second, key);
  let detail = await getSavedSite(key);
  assert.equal(detail.latest.id, second.id);
  assert.equal(detail.versions[1].artifactLocation, '/archive/a');
  const failed = job('c', '2026-01-03T00:00:00Z', { status: 'failed' });
  failed.report.storage.archiveFolderId = '/archive/b';
  await recordSavedSite(failed, key);
  assert.equal((await getSavedSite(key)).latest.id, second.id);
  const third = job('d', '2026-01-04T00:00:00Z');
  third.diagnostic = { riskLevel: 'medium', reasons: ['form'], evidence: [{ type: 'selector', location: 'form' }] };
  third.graph = { nodes: [], edges: [] };
  third.report.storage.archiveFolderId = '/archive/failed';
  await recordSavedSite(third, key);
  detail = await getSavedSite(key);
  assert.equal(detail.versions.find(v => v.id === second.id).artifactLocation, '/archive/b');
  const unstored = job('e', '2026-01-05T00:00:00Z');
  await recordSavedSite(unstored, key, false);
  assert.equal((await getSavedSite(key)).latest.id, third.id);
  const partial = job('f', '2026-01-06T00:00:00Z');
  partial.report.stageBreakdown[0].failedCount = 1;
  await recordSavedSite(partial, key);
  assert.equal((await getSavedSite(key)).versions.length, 3);
  const other = job('other', '2026-01-07T00:00:00Z');
  await recordSavedSite(other, `${key}-other`);
  const sites = (await listSavedSites()).filter(s => s.siteKey.startsWith(key));
  assert.deepEqual(sites.map(s => s.siteKey), [`${key}-other`, key]);
  assert.deepEqual((await getSavedSite(key)).latest.diagnostic, third.diagnostic);
  assert.deepEqual((await getSavedSite(key)).latest.graph, third.graph);
  const stale = job('stale', '2025-01-01T00:00:00Z');
  await recordSavedSite(stale, key);
  assert.equal((await getSavedSite(key)).latest.id, third.id);
  assert.equal((await listSavedSites()).filter(s => s.siteKey === key).length, 1);
  assert.equal(await getSavedSite(`${key}-missing`), undefined);
  console.log('site-store integration: passed');
} finally {
  await connection.query('DELETE FROM site_versions WHERE site_key IN ($1,$2)', [key, `${key}-other`]);
  await connection.query('DELETE FROM saved_sites WHERE site_key IN ($1,$2)', [key, `${key}-other`]);
  await connection.end();
}
process.exit(0);
