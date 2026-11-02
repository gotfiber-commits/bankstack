-- BankJobz: saved jobs (Nov 2026).
-- Paste this whole file into the Neon SQL Editor and click Run. Safe to run more than once.
-- Lets candidates bookmark listings; they show under My profile → Saved jobs.

CREATE TABLE IF NOT EXISTS saved_jobs (
  id           BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id       BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, job_id)
);
CREATE INDEX IF NOT EXISTS saved_jobs_candidate_idx ON saved_jobs (candidate_id);

-- Shows 'saved_jobs' once it exists.
SELECT tablename FROM pg_tables WHERE tablename = 'saved_jobs';
