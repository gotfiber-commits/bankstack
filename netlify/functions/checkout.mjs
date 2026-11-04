// POST /api/checkout — create a job posting and send the employer to Stripe to pay for it ($99/month).
// Requires a signed-in employer account ("Authorization: Bearer <account key>"); the institution
// name and type come from the account, so the form only carries the job fields.
import {
  db, json, fail, clean, validateJob, createJobCheckout, employerFromRequest, findInstitutionId,
} from "../lib/shared.mjs";

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
    const url = await createJobCheckout(req, employer, row.id);
    return json({ url, job_id: row.id });
  } catch (err) {
    return fail(err.message, 500);
  }
};

export const config = { path: "/api/checkout" };
