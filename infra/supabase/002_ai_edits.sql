-- Apply after 001_sites.sql. Draft payloads are private to server/worker.
CREATE TABLE IF NOT EXISTS site_edits (
  id text PRIMARY KEY,
  site_key text NOT NULL REFERENCES saved_sites(site_key),
  status text NOT NULL CHECK (status IN ('queued','generating','ready','saving','saved','failed','discarded')),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_edits_site ON site_edits(site_key, updated_at DESC);
CREATE TABLE IF NOT EXISTS edit_job_events (
  sequence bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES site_edits(id),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edit_events_job ON edit_job_events(job_id,sequence);
ALTER TABLE site_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE edit_job_events ENABLE ROW LEVEL SECURITY;
