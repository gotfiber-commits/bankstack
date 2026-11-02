-- BankJobz: institution directory, banking-native filters, and the talent pool (Nov 2026).
-- Paste this whole file into the Neon SQL Editor and click Run. Safe to run more than once.
-- After deploying the matching site code, open /#admin and click
-- "Load the institution directory" to fill the new institutions table from FDIC/NCUA data.

-- 1) Banking-native filters: core systems and licenses on jobs and candidates
ALTER TABLE jobs       ADD COLUMN IF NOT EXISTS core_systems TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs       ADD COLUMN IF NOT EXISTS licenses     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS core_systems TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS licenses     TEXT[] NOT NULL DEFAULT '{}';

-- 2) Talent pool: anonymous opt-in, per-candidate employer block list, invites
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS pool_visible      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS blocked_employers TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS invites (
  id           BIGSERIAL PRIMARY KEY,
  employer_id  BIGINT NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id       BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employer_id, candidate_id, job_id)
);
CREATE INDEX IF NOT EXISTS invites_candidate_idx ON invites (candidate_id);

-- 3) Institution directory: every active US bank (FDIC) and credit union (NCUA)
CREATE TABLE IF NOT EXISTS institutions (
  id               BIGSERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  institution_type TEXT NOT NULL CHECK (institution_type IN ('bank','credit-union')),
  regulator_id     TEXT NOT NULL,
  city             TEXT,
  state            TEXT,
  asset_thousands  BIGINT,
  branches         INTEGER,
  employees        INTEGER,
  members          INTEGER,
  website          TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  data_as_of       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_type, regulator_id)
);
CREATE INDEX IF NOT EXISTS institutions_state_idx ON institutions (state, asset_thousands DESC);
CREATE INDEX IF NOT EXISTS institutions_norm_idx ON institutions (normalized_name);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS institution_id BIGINT REFERENCES institutions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS jobs_institution_idx ON jobs (institution_id);

-- Check: should list core_systems, institution_id, invites and institutions
SELECT 'jobs.core_systems' AS added WHERE EXISTS
  (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'core_systems')
UNION ALL
SELECT 'jobs.institution_id' WHERE EXISTS
  (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'institution_id')
UNION ALL
SELECT 'candidates.pool_visible' WHERE EXISTS
  (SELECT 1 FROM information_schema.columns WHERE table_name = 'candidates' AND column_name = 'pool_visible')
UNION ALL
SELECT 'invites table' WHERE EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'invites')
UNION ALL
SELECT 'institutions table' WHERE EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'institutions');
