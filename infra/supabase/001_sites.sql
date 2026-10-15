-- Run once against DATABASE_URL before starting web/worker.
CREATE TABLE IF NOT EXISTS saved_sites (
  site_key text PRIMARY KEY,
  name text NOT NULL,
  site_url text NOT NULL,
  latest_version_id text
);
CREATE TABLE IF NOT EXISTS site_versions (
  id text PRIMARY KEY,
  site_key text NOT NULL REFERENCES saved_sites(site_key),
  job_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('conversion', 'ai-edit')),
  saved_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS site_versions_history ON site_versions(site_key, saved_at DESC);
-- No browser/anon access. Only server connections may read/write these tables.
ALTER TABLE saved_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_versions ENABLE ROW LEVEL SECURITY;
