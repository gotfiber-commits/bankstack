-- BankJobz: switch from tech-only categories to every bank and credit union department.
-- Paste into the Neon SQL Editor and click Run. Safe to run more than once.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_category_check;
UPDATE jobs SET category = CASE category WHEN 'data-engineering' THEN 'data-analytics' WHEN 'analytics' THEN 'data-analytics' WHEN 'architecture' THEN 'data-analytics' WHEN 'software' THEN 'technology' WHEN 'security' THEN 'technology' WHEN 'risk-tech' THEN 'risk-compliance' ELSE category END WHERE category IN ('data-engineering','analytics','architecture','software','security','risk-tech');
ALTER TABLE jobs ADD CONSTRAINT jobs_category_check CHECK (category IN ('branch-retail','lending-credit','commercial-banking','operations','risk-compliance','finance-accounting','wealth-trust','technology','data-analytics','leadership-admin'));
UPDATE alert_subscriptions
   SET categories = ARRAY(SELECT DISTINCT CASE c WHEN 'data-engineering' THEN 'data-analytics' WHEN 'analytics' THEN 'data-analytics' WHEN 'architecture' THEN 'data-analytics' WHEN 'software' THEN 'technology' WHEN 'security' THEN 'technology' WHEN 'risk-tech' THEN 'risk-compliance' ELSE c END FROM unnest(categories) AS c)
 WHERE categories && ARRAY['data-engineering','analytics','architecture','software','security','risk-tech']::text[];

-- Check: every job now has one of the new departments.
SELECT category, COUNT(*) AS jobs FROM jobs GROUP BY category ORDER BY jobs DESC;
