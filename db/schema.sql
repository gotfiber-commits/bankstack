-- BankJobz schema (Postgres / Neon). Safe to run repeatedly.
-- Billing model: $99 per job posting per month. Each employer-posted job has its own Stripe subscription.

CREATE TABLE IF NOT EXISTS employers (
  id                  BIGSERIAL PRIMARY KEY,
  company             TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  institution_type    TEXT NOT NULL DEFAULT 'bank'
                        CHECK (institution_type IN ('bank','credit-union','fintech','other')),
  api_token           TEXT UNIQUE,      -- posting key, issued after the first paid posting
  stripe_customer_id  TEXT UNIQUE,
  login_token_hash    TEXT,             -- emailed sign-in link (sha256 of the token), single use
  login_token_expires TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id                     BIGSERIAL PRIMARY KEY,
  employer_id            BIGINT REFERENCES employers(id) ON DELETE CASCADE,  -- NULL for sourced listings
  title                  TEXT NOT NULL,
  company                TEXT NOT NULL,
  institution_type       TEXT NOT NULL DEFAULT 'bank',
  location               TEXT NOT NULL,
  work_mode              TEXT NOT NULL DEFAULT 'onsite' CHECK (work_mode IN ('onsite','hybrid','remote')),
  employment_type        TEXT NOT NULL DEFAULT 'full-time'
                           CHECK (employment_type IN ('full-time','part-time','contract','internship')),
  category               TEXT NOT NULL,  -- allowed values: see jobs_category_check below
  salary_min             INTEGER,
  salary_max             INTEGER,
  summary                TEXT NOT NULL,
  description            TEXT,
  apply_url              TEXT,          -- external apply link (sourced jobs) or employer's own ATS
  source_name            TEXT,          -- where a sourced listing was found
  source_url             TEXT UNIQUE,   -- dedupe key for sourced listings
  is_featured            BOOLEAN NOT NULL DEFAULT false,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('pending','open','closed')),
  -- billing for employer-posted jobs
  stripe_subscription_id TEXT UNIQUE,
  paid_through           TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  last_checked_at        TIMESTAMPTZ,   -- dead-link checker for sourced listings
  posted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT now() + interval '60 days'
);

CREATE INDEX IF NOT EXISTS jobs_open_idx ON jobs (status, posted_at DESC);
CREATE INDEX IF NOT EXISTS jobs_category_idx ON jobs (category);
CREATE INDEX IF NOT EXISTS jobs_employer_idx ON jobs (employer_id);

CREATE TABLE IF NOT EXISTS applications (
  id           BIGSERIAL PRIMARY KEY,
  job_id       BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  linkedin_url TEXT,
  resume_url   TEXT,
  resume_key   TEXT,                    -- uploaded file in Netlify Blobs
  resume_name  TEXT,
  resume_type  TEXT,
  resume_size  INTEGER,
  cover_note   TEXT,
  status       TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','reviewing','interview','offer','hired','rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, email)
);

CREATE INDEX IF NOT EXISTS applications_job_idx ON applications (job_id);

CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  categories   TEXT[] NOT NULL DEFAULT '{}',   -- empty means every specialty
  token        TEXT NOT NULL UNIQUE,           -- confirm / unsubscribe links
  confirmed    BOOLEAN NOT NULL DEFAULT false,
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrades for databases created by earlier versions of this file
ALTER TABLE employers    ADD COLUMN IF NOT EXISTS login_token_hash TEXT;
ALTER TABLE employers    ADD COLUMN IF NOT EXISTS login_token_expires TIMESTAMPTZ;
ALTER TABLE jobs         ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'full-time';
ALTER TABLE jobs         ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE jobs         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE applications ADD COLUMN IF NOT EXISTS resume_key TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS resume_name TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS resume_type TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS resume_size INTEGER;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';

-- Departments (Nov 2026): the board covers every bank and credit union job, not only tech.
-- Maps the original tech-only categories onto the new departments. Safe to re-run.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_category_check;
UPDATE jobs SET category = CASE category WHEN 'data-engineering' THEN 'data-analytics' WHEN 'analytics' THEN 'data-analytics' WHEN 'architecture' THEN 'data-analytics' WHEN 'software' THEN 'technology' WHEN 'security' THEN 'technology' WHEN 'risk-tech' THEN 'risk-compliance' ELSE category END WHERE category IN ('data-engineering','analytics','architecture','software','security','risk-tech');
ALTER TABLE jobs ADD CONSTRAINT jobs_category_check CHECK (category IN ('branch-retail','lending-credit','commercial-banking','operations','risk-compliance','finance-accounting','wealth-trust','technology','data-analytics','leadership-admin'));
UPDATE alert_subscriptions
   SET categories = ARRAY(SELECT DISTINCT CASE c WHEN 'data-engineering' THEN 'data-analytics' WHEN 'analytics' THEN 'data-analytics' WHEN 'architecture' THEN 'data-analytics' WHEN 'software' THEN 'technology' WHEN 'security' THEN 'technology' WHEN 'risk-tech' THEN 'risk-compliance' ELSE c END FROM unnest(categories) AS c)
 WHERE categories && ARRAY['data-engineering','analytics','architecture','software','security','risk-tech']::text[];

-- Candidate profiles (Nov 2026): one profile, résumé on file, quick apply, ranked matches.
CREATE TABLE IF NOT EXISTS candidates (
  id                  BIGSERIAL PRIMARY KEY,
  name                TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL UNIQUE,
  phone               TEXT,
  linkedin_url        TEXT,
  location            TEXT,
  work_mode_pref      TEXT NOT NULL DEFAULT 'any' CHECK (work_mode_pref IN ('any','onsite','hybrid','remote')),
  categories          TEXT[] NOT NULL DEFAULT '{}',   -- departments they'd work in
  summary             TEXT,                           -- experience in their own words
  api_token           TEXT UNIQUE,                    -- ck_… bearer token
  login_token_hash    TEXT,                           -- emailed sign-in link (sha256), single use
  login_token_expires TIMESTAMPTZ,
  resume_key          TEXT,                           -- file in Netlify Blobs
  resume_name         TEXT,
  resume_type         TEXT,
  resume_size         INTEGER,
  resume_text         TEXT,                           -- extracted at upload, used for matching
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS candidate_id BIGINT REFERENCES candidates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS applications_candidate_idx ON applications (candidate_id);
