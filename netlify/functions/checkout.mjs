// POST /api/checkout — create a job posting under the employer's hiring plan.
// Requires a signed-in employer account ("Authorization: Bearer <session>"); the institution name and
// type come from the account, so the form only carries the job fields (plus confirm_upgrade).
//   → { live: true, job_id }                        published under the existing plan
//   → { url, job_id }                               no plan yet: Stripe Checkout starts one ($99/month)
//   → { needs_confirm, job_id, count, from_cents, to_cents }   this posting moves the plan up a tier;
//        it's saved, unpublished, until confirmed (POST /api/employer/jobs/:id/publish { confirm: true })
import {
  db, json, fail, clean, validateJob, employerFromRequest, findInstitutionId,
} from "../lib/shared.mjs";
import { publishPostings, createPlanCheckout, planPrice, BillingError } from "../lib/billing.mjs";

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return fail("Send the form as JSON."); }

  if (clean(body.company_website)) return fail("Something went wrong. Try again."); // honeypot
  const sql = db();
  const employer = await employerFromRequest(req);
  if (!employer) return fail("Create your employer account, or sign in, before posting a job.", 401);

  const { job, error } = validateJob(body);
  if (error) return fail(error);
  if (!(await planPrice().catch(() => null))) return fail("Billing isn't set up yet. Please try again later.", 503);

  const instId = await findInstitutionId(sql, employer.company);
  const [row] = await sql`
    INSERT INTO jobs (employer_id, title, company, institution_type, location, work_mode, employment_type,
                      category, salary_min, salary_max, summary, description, apply_url, core_systems, licenses,
                      institution_id, is_featured, status)
    VALUES (${employer.id}, ${job.title}, ${employer.company}, ${employer.institution_type}, ${job.location},
            ${job.work_mode}, ${job.employment_type}, ${job.category}, ${job.salary_min}, ${job.salary_max},
            ${job.summary}, ${job.description}, ${job.apply_url}, ${job.core_systems}, ${job.licenses},
            ${instId}, true, 'pending')
    RETURNING id`;

  try {
    const r = await publishPostings(employer.id, [row.id], { confirm: body.confirm_upgrade === true });
    if (r.needs_checkout) return json({ url: await createPlanCheckout(employer, row.id), job_id: row.id });
    if (r.needs_confirm) return json({ ...r, job_id: row.id });
    return json({ live: true, job_id: row.id, monthly_cents: r.monthly_cents, upgraded: r.upgraded });
  } catch (err) {
    return fail(err.message, err instanceof BillingError ? err.status : 500);
  }
};

export const config = { path: "/api/checkout" };
