/** Server-only PostgreSQL adapter. Never import this entry point into client components. */
import pg from 'pg';
import type { Job } from './index.js';
import { savedVersion, type SavedSite, type SiteDetail, type SiteVersion } from './sites.js';

const globalPool = globalThis as typeof globalThis & { __sitePool?: pg.Pool };
function pool(): pg.Pool {
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
  return globalPool.__sitePool ??= new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 4, connectionTimeoutMillis: 5000 });
}
export async function recordSavedSite(job: Job, siteKey: string, reportStored = true): Promise<void> {
  const version = reportStored ? savedVersion(job, siteKey) : undefined;
  if (!job.report?.storage) return;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO saved_sites(site_key,name,site_url) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [siteKey, new URL(job.siteUrl).hostname, job.siteUrl]);
    // Serialize metadata updates for a site. Storage itself retains its existing locking policy.
    const { rows } = await client.query('SELECT latest_version_id FROM saved_sites WHERE site_key=$1 FOR UPDATE', [siteKey]);
    const existing = await client.query('SELECT 1 FROM site_versions WHERE id=$1', [job.id]);
    if (!existing.rowCount) {
      const previousId = rows[0]?.latest_version_id;
      if (previousId) {
        const archive = job.report.storage.archiveFolderId;
        const location = archive ? (job.report.storage.backend === 'google-drive' ? `https://drive.google.com/drive/folders/${archive}` : archive) : null;
        await client.query(`UPDATE site_versions SET data=jsonb_set(data,'{artifactLocation}',$2::jsonb) WHERE id=$1 AND saved_at <= $3::timestamptz AND data->>'artifactLocation'=$4`, [previousId, JSON.stringify(location), job.report.generatedAt, job.report.storage.currentLocation]);
      }
      if (version) {
        await client.query('INSERT INTO site_versions(id,site_key,job_id,source,saved_at,data) VALUES($1,$2,$3,$4,$5,$6)',
        [version.id, siteKey, job.id, version.source, version.savedAt, version]);
        await client.query(`UPDATE saved_sites SET latest_version_id=$2,site_url=$3 WHERE site_key=$1 AND
        (latest_version_id IS NULL OR (SELECT saved_at FROM site_versions WHERE id=latest_version_id) <= $4::timestamptz)`,
        [siteKey, version.id, job.siteUrl, version.savedAt]);
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function listSavedSites(): Promise<SavedSite[]> {
  const { rows } = await pool().query(`SELECT s.site_key AS "siteKey",s.name,s.site_url AS "siteUrl",v.data AS latest
    FROM saved_sites s JOIN site_versions v ON v.id=s.latest_version_id ORDER BY v.saved_at DESC,s.site_key`);
  return rows;
}
export async function getSavedSite(siteKey: string): Promise<SiteDetail | undefined> {
  const { rows } = await pool().query(`SELECT s.site_key AS "siteKey",s.name,s.site_url AS "siteUrl",v.data AS latest
    FROM saved_sites s JOIN site_versions v ON v.id=s.latest_version_id WHERE s.site_key=$1`, [siteKey]);
  if (!rows[0]) return;
  const history = await pool().query('SELECT data FROM site_versions WHERE site_key=$1 ORDER BY saved_at DESC,id', [siteKey]);
  return { ...rows[0], versions: history.rows.map((r: { data: SiteVersion }) => r.data) };
}
