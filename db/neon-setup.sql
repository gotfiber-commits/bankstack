-- BankJobz: complete database setup for Neon.
-- Paste this whole file into the Neon SQL Editor and click Run. Safe to run more than once.

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

-- 25 real seed listings (sourced October 2026). Re-running skips ones already loaded.
INSERT INTO jobs (title, company, institution_type, location, work_mode, employment_type, category, salary_min, salary_max, summary, apply_url, source_name, source_url, expires_at) VALUES
  ('Assistant Vice President, Data Engineer', 'Bank of America', 'bank', 'Charlotte, NC', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Builds and delivers complex data solutions for technology and business teams in a 1st-shift, full-time role. Requisition JR-26021243.', 'https://www.themuse.com/jobs/bankofamerica/assistant-vice-president-data-engineer-762d0b', 'The Muse', 'https://www.themuse.com/jobs/bankofamerica/assistant-vice-president-data-engineer-762d0b', now() + interval '30 days'),
  ('Assistant Vice President, Data Engineer', 'Bank of America', 'bank', 'Charlotte, NC', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Full-time data engineering role supporting analytical data systems. Requisition JR-26009670.', 'https://www.themuse.com/jobs/bankofamerica/assistant-vice-president-data-engineer-445da7', 'The Muse', 'https://www.themuse.com/jobs/bankofamerica/assistant-vice-president-data-engineer-445da7', now() + interval '30 days'),
  ('Lead Data Engineer', 'Wells Fargo', 'bank', 'Charlotte, NC', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Lead engineer on data platforms behind Wells Fargo''s online, ATM and branch channels. Multiple positions available (#002306).', 'https://www.builtinla.com/job/lead-graph-data-engineer/8798917', 'Built In', 'https://www.builtinla.com/job/lead-graph-data-engineer/8798917', now() + interval '30 days'),
  ('Senior Data Engineer', 'U.S. Bank', 'bank', 'Charlotte, NC', 'onsite', 'full-time', 'data-analytics', 105400, 124000, 'Senior data engineering role on U.S. Bank''s Charlotte technology team.', 'https://catalitium.com/jobs/183415-senior-data-engineer', 'Catalitium', 'https://catalitium.com/jobs/183415-senior-data-engineer', now() + interval '30 days'),
  ('VP, Data Engineer', 'Sumitomo Mitsui Banking Corporation (SMBC)', 'bank', 'Charlotte, NC', 'hybrid', 'full-time', 'data-analytics', NULL, NULL, 'Technical leader for SMBC''s data engineers, setting standards and best practices and mentoring the team.', 'https://www.tealhq.com/job/vp-data-engineer_7ea1a0933769901c41b056cff5746269d85eb', 'Teal', 'https://www.tealhq.com/job/vp-data-engineer_7ea1a0933769901c41b056cff5746269d85eb', now() + interval '30 days'),
  ('Associate Data Engineer, AML', 'Truist', 'bank', 'Charlotte, NC', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Entry-level data engineer supporting anti-money-laundering data and reporting.', 'https://www.tealhq.com/job/associate-data-engineer-aml_7ea1ac78f77e2e6676dc8eeb5e89a5dffe8f0', 'Teal', 'https://www.tealhq.com/job/associate-data-engineer-aml_7ea1ac78f77e2e6676dc8eeb5e89a5dffe8f0', now() + interval '30 days'),
  ('Data Engineer', 'TowneBank', 'bank', 'Charlotte, NC', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Designs and maintains banking data pipelines on Databricks using Spark, PySpark and Delta Lake.', 'https://talents.vaia.com/companies/townebank/charlotte/data-engineer-99315421/', 'Vaia Talents', 'https://talents.vaia.com/companies/townebank/charlotte/data-engineer-99315421/', now() + interval '30 days'),
  ('Senior Data Engineer, Compliance Technology', 'SMBC MANUBANK', 'bank', 'Charlotte, NC (also LA or Phoenix)', 'hybrid', 'full-time', 'data-analytics', NULL, NULL, 'Builds scalable data infrastructure and pipelines for financial compliance and risk management.', 'https://easterseals.dejobs.org/charlotte-nc/senior-data-engineer-compliance-technology/129A6B1E41064002BAE25C98372AB875/job', 'DE Jobs', 'https://easterseals.dejobs.org/charlotte-nc/senior-data-engineer-compliance-technology/129A6B1E41064002BAE25C98372AB875/job', now() + interval '30 days'),
  ('Software Engineer', 'JPMorgan Chase', 'bank', 'Columbus, OH', 'onsite', 'full-time', 'technology', NULL, NULL, 'Microservices engineer for the bank''s portfolio management system: tax lot integration, trading restriction logic, AWS infrastructure and CI/CD with CloudFormation and Terraform.', 'https://www.tealhq.com/job/software-engineer_7ea1a8d376c2689b4c9a6598e6f8b0b694603', 'Teal', 'https://www.tealhq.com/job/software-engineer_7ea1a8d376c2689b4c9a6598e6f8b0b694603', now() + interval '30 days'),
  ('Software Engineer', 'JPMorgan Chase', 'bank', 'Plano, TX', 'onsite', 'full-time', 'technology', NULL, NULL, 'Builds and maintains performance-critical Java backend services; handles releases, design docs and security frameworks.', 'https://www.tealhq.com/job/software-engineer_7ea1af6b8a8d6ef986966b5be22d883b75b77', 'Teal', 'https://www.tealhq.com/job/software-engineer_7ea1af6b8a8d6ef986966b5be22d883b75b77', now() + interval '30 days'),
  ('Software Engineer', 'JPMorgan Chase', 'bank', 'Chicago, IL', 'onsite', 'full-time', 'technology', 153317, 155000, 'Designs and ships software solutions, including AI and machine-learning chatbots.', 'https://www.tealhq.com/job/software-engineer_7ea1a2d73a1a32b65ad3ed718334f599644f1', 'Teal', 'https://www.tealhq.com/job/software-engineer_7ea1a2d73a1a32b65ad3ed718334f599644f1', now() + interval '30 days'),
  ('Senior Analytics Consultant, Customer Intelligence', 'Wells Fargo', 'bank', 'San Francisco, CA', 'hybrid', 'full-time', 'data-analytics', 85000, 145000, 'Turns customer behavior and financial health data into insights for high-visibility Consumer Banking initiatives.', 'https://www.mediabistro.com/jobs/3506227097-customer-intelligence-senior-analytics-consultant', 'Mediabistro', 'https://www.mediabistro.com/jobs/3506227097-customer-intelligence-senior-analytics-consultant', now() + interval '30 days'),
  ('Cloud Data Engineer III', 'Regions Bank', 'bank', 'Birmingham, AL', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Builds data pipelines and supports machine-learning models in Regions'' cloud big-data environment (EMR, Glue, BigQuery or Snowflake).', 'https://jobs.recruiter.com/jobs/14713003630-cloud-data-engineer-iii-see-location-in-posting', 'Recruiter.com', 'https://jobs.recruiter.com/jobs/14713003630-cloud-data-engineer-iii-see-location-in-posting', now() + interval '30 days'),
  ('Data Engineer', 'Regions Bank', 'bank', 'Birmingham, AL', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Builds Spark pipelines that feed Regions'' AI and machine-learning models. Birmingham only; no relocation assistance.', 'https://tietalent.com/de/jobs/p-654222/alabama-data-engineer-birmingham-al-only', 'TieTalent', 'https://tietalent.com/de/jobs/p-654222/alabama-data-engineer-birmingham-al-only', now() + interval '30 days'),
  ('Software Engineer, Data', 'Regions Bank', 'bank', 'Birmingham, AL or Atlanta, GA', 'onsite', 'full-time', 'data-analytics', 110947, NULL, 'Data-focused software engineer working with SSIS, T-SQL, database optimization and AWS.', 'https://tallo.com/talent/job/software-engineer-data-birm-6648fec8', 'Tallo', 'https://tallo.com/talent/job/software-engineer-data-birm-6648fec8', now() + interval '30 days'),
  ('Principal Data Visualization Developer', 'Regions Bank', 'bank', 'Birmingham, AL', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Hands-on technical lead for Regions'' data visualization and BI team using Tableau, Power BI, Looker and related tools.', 'https://jobs.jobg8.com/jobs/principal-data-visualization-developer-in-birmingham-alabama-united-states/4658-2947397854DE', 'JobG8', 'https://jobs.jobg8.com/jobs/principal-data-visualization-developer-in-birmingham-alabama-united-states/4658-2947397854DE', now() + interval '30 days'),
  ('Software Engineer, MuleSoft', 'Regions Bank', 'bank', 'Birmingham, AL', 'onsite', 'full-time', 'technology', 105000, 137000, 'Senior engineer developing and maintaining integration applications at Regions Center.', 'https://builtin.com/job/software-engineer-mulesoft/3140161', 'Built In', 'https://builtin.com/job/software-engineer-mulesoft/3140161', now() + interval '30 days'),
  ('Cyber Security Engineer, Data Loss Prevention', 'Regions Bank', 'bank', 'Birmingham, AL or Atlanta, GA', 'onsite', 'full-time', 'technology', 86459, 118990, 'Security engineer focused on preventing sensitive data from leaving the bank.', 'https://careers.fayettechamber.org/companies/regions-bank-2/jobs/60020663-cyber-security-engineer-data-loss-prevention-birmingham-or-atlanta', 'Fayette County Careers', 'https://careers.fayettechamber.org/companies/regions-bank-2/jobs/60020663-cyber-security-engineer-data-loss-prevention-birmingham-or-atlanta', now() + interval '30 days'),
  ('Technology, Data, and Digital Risk Group Manager', 'Regions Bank', 'bank', 'Multiple locations', 'onsite', 'full-time', 'risk-compliance', 201979, 256260, 'Leads a first-line risk team covering IT and data risk: KRIs, control dashboards and regulatory exam support.', 'https://careers.fayettechamber.org/companies/regions-bank-2/jobs/62785271-technology-data-and-digital-risk-group-manager-see-locations', 'Fayette County Careers', 'https://careers.fayettechamber.org/companies/regions-bank-2/jobs/62785271-technology-data-and-digital-risk-group-manager-see-locations', now() + interval '30 days'),
  ('Data Architect', 'Hudson Valley Credit Union', 'credit-union', 'Hudson Valley, NY', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Owns enterprise information and data architecture design and development for the credit union.', 'https://app.qureos.com/jobs/data-architect-1774092247317', 'Qureos', 'https://app.qureos.com/jobs/data-architect-1774092247317', now() + interval '30 days'),
  ('Enterprise Data & Analytics Data Architect', 'Mission Fed Credit Union', 'credit-union', 'San Diego, CA', 'onsite', 'full-time', 'data-analytics', 120000, 140000, 'Sets the technical direction for Mission Fed''s Enterprise Data & Analytics team, including core processor data.', 'https://www.tealhq.com/job/enterprise-data-analytics-architect_7ea1a96bd45c62b657eb23b4f751f68a0fbec', 'Teal', 'https://www.tealhq.com/job/enterprise-data-analytics-architect_7ea1a96bd45c62b657eb23b4f751f68a0fbec', now() + interval '30 days'),
  ('Data Architect', 'Corporate One Federal Credit Union', 'credit-union', 'Columbus, OH or Jacksonville, FL', 'hybrid', 'full-time', 'data-analytics', NULL, NULL, 'Data architect for a corporate credit union serving other credit unions. Columbus and Jacksonville areas preferred.', 'https://www.wearedevelopers.com/en/jobs/ext/6378797/data-architect', 'WeAreDevelopers', 'https://www.wearedevelopers.com/en/jobs/ext/6378797/data-architect', now() + interval '30 days'),
  ('Vice President, Data Architecture', 'Mid Minnesota Federal Credit Union', 'credit-union', 'Baxter, MN', 'onsite', 'full-time', 'data-analytics', 124000, 186000, 'Senior leader who designs and builds a modern, scalable, compliant enterprise data environment.', 'https://www.career.com/job/mid-minnesota-federal-credit-union/vice-president-data-architecture/j202604022300524250003', 'Career.com', 'https://www.career.com/job/mid-minnesota-federal-credit-union/vice-president-data-architecture/j202604022300524250003', now() + interval '30 days'),
  ('Enterprise Data Architect', 'Black Hills Federal Credit Union', 'credit-union', 'Rapid City, SD', 'hybrid', 'full-time', 'data-analytics', NULL, NULL, 'Sets the credit union''s data technical vision and leads architecture work. Salesforce and MuleSoft architecture certifications preferred.', 'https://tealhq.com/job/enterprise-data-architect_7ea1ad87d61006a1d5cbc51b06be9029833cb', 'Teal', 'https://tealhq.com/job/enterprise-data-architect_7ea1ad87d61006a1d5cbc51b06be9029833cb', now() + interval '30 days'),
  ('Data Engineer', 'Hudson River Community Credit Union', 'credit-union', 'Rensselaer County, NY', 'onsite', 'full-time', 'data-analytics', NULL, NULL, 'Designs, builds and tunes the credit union''s data infrastructure and integration processes on a growing analytics team.', 'https://www.renscochamber.com/job-board/data-engineer', 'Rensselaer County Chamber', 'https://www.renscochamber.com/job-board/data-engineer', now() + interval '30 days')
ON CONFLICT (source_url) DO NOTHING;

-- Check: should show 25 (or more if you've added listings).
SELECT COUNT(*) AS open_jobs FROM jobs WHERE status = 'open';
