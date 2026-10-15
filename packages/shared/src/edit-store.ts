/** PostgreSQL adapter shared by BFF and worker; contains no provider credentials. */
import type { JobEvent, SiteVersion, StoredEdit } from './index.js';
import pg from 'pg';
import { pool } from './site-store.js';

export async function getEdit(id: string): Promise<StoredEdit | undefined> {
  const result = await pool().query('SELECT data FROM site_edits WHERE id=$1', [id]);
  return result.rows[0]?.data;
}
export async function insertEdit(edit: StoredEdit): Promise<void> {
  await pool().query('INSERT INTO site_edits(id,site_key,status,data) VALUES($1,$2,$3,$4)', [edit.id, edit.siteKey, edit.status, edit]);
}
export async function updateEdit(edit: StoredEdit): Promise<void> {
  edit.updatedAt = new Date().toISOString();
  await pool().query('UPDATE site_edits SET status=$2,data=$3,updated_at=now() WHERE id=$1', [edit.id, edit.status, edit]);
}
export async function transitionEdit(id: string, from: string[], to: StoredEdit['status']): Promise<StoredEdit | undefined> {
  const { rows } = await pool().query(`UPDATE site_edits SET status=$3,
    data=jsonb_set(jsonb_set(CASE WHEN $3='discarded' THEN data-'files'-'previewToken'-'previewUrl' ELSE data END,'{status}',to_jsonb($3::text)),'{updatedAt}',to_jsonb(now()::text)),updated_at=now()
    WHERE id=$1 AND status=ANY($2::text[]) RETURNING data`, [id, from, to]);
  return rows[0]?.data;
}
export async function recordEditEvent(event: JobEvent): Promise<void> {
  await pool().query('INSERT INTO edit_job_events(job_id,data) VALUES($1,$2)', [event.jobId, event]);
}
export async function listEditEvents(id: string): Promise<JobEvent[]> {
  const { rows }=await pool().query('SELECT data FROM (SELECT sequence,data FROM edit_job_events WHERE job_id=$1 ORDER BY sequence DESC LIMIT 50) e ORDER BY sequence',[id]);
  return rows.map(row=>row.data as JobEvent);
}
/** Session advisory lock is shared by conversions and edits, including multiple workers. */
export async function withSiteLock<T>(siteKey: string, work: () => Promise<T>, allowEditId?: string): Promise<T> {
  // Dedicated lock session: waiting locks must not exhaust the metadata pool
  // while its owner needs a pooled connection to finish publication.
  const client = new pg.Client({connectionString:process.env['DATABASE_URL'],connectionTimeoutMillis:5000});
  await client.connect();
  try {
    // Wait for in-flight duplicate saves instead of letting their error handler
    // overwrite the active operation's state. PostgreSQL releases this lock on disconnect.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [siteKey]);
    const pending = await client.query(`SELECT id FROM site_edits WHERE site_key=$1 AND
      (status='saving' OR data->'publication' IS NOT NULL AND status <> 'saved') AND id<>$2 LIMIT 1`, [siteKey, allowEditId ?? '']);
    if (pending.rowCount) throw new Error('未完了の編集保存があります。編集画面から保存を再試行してください。');
    return await work();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [siteKey]); }
    finally { await client.end(); }
  }
}
/** One transaction updates history, latest pointer, and the idempotent save result. */
export async function commitEditVersion(edit: StoredEdit, version: SiteVersion, previousLocation: string | undefined): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT latest_version_id FROM saved_sites WHERE site_key=$1 FOR UPDATE', [edit.siteKey]);
    if (rows[0]?.latest_version_id === version.id) { await client.query('COMMIT'); return; }
    if (rows[0]?.latest_version_id !== edit.baseVersionId) throw new Error('基準版が更新されています。再読み込みして再生成してください。');
    await client.query(`UPDATE site_versions SET data=jsonb_set(data,'{artifactLocation}',$2::jsonb) WHERE id=$1`,
      [edit.baseVersionId, JSON.stringify(previousLocation ?? null)]);
    await client.query('INSERT INTO site_versions(id,site_key,job_id,source,saved_at,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
      [version.id, edit.siteKey, edit.id, 'ai-edit', version.savedAt, version]);
    await client.query('UPDATE saved_sites SET latest_version_id=$2 WHERE site_key=$1', [edit.siteKey, version.id]);
    edit.status = 'saved'; edit.versionId = version.id;
    await client.query('UPDATE site_edits SET status=$2,data=$3,updated_at=now() WHERE id=$1', [edit.id, edit.status, edit]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
