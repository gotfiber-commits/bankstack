// POST /api/checkout — create a job posting and send the employer to Stripe to pay for it ($99/month).
// New employers send { company, email, institution_type, ...job }.
// Returning employers send "Authorization: Bearer <posting key>" and just the job fields.
import {
  db, json, fail, isEmail, clean, validateJob, createJobCheckout, employerFromRequest, INSTITUTION_TYPES,
} from "../lib/shared.mjs";

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return fail("Send the form as JSON."); }

  if (clean(body.company_website)) return fail("Something went wrong. Try again."); // honeypot
  const { job, error } = validateJob(body);
  if (error) return fail(error);

  const sql = db();
  let employer = await employerFromRequest(req);

  if (!employer) {
    const company = clean(body.company, 160);
    const email = clean(body.email, 200).toLowerCase();
    const type = INSTITUTION_TYPES.includes(body.institution_type) ? body.institution_type : "bank";
    if (!company) return fail("Enter your institution's name.");
    if (!isEmail(email)) return fail("Enter a valid work email.");

    const [existing] = await sql`SELECT * FROM employers WHERE email = ${email}`;
    if (existing?.api_token) {
      return fail("This email already has an account. Sign in with your posting key to add another job.", 409);
    }
    [employer] = existing
      ? await sql`UPDATE employers SET company = ${company}, institution_type = ${type}
                  WHERE id = ${existing.id} RETURNING *`
      : await sql`INSERT INTO employers (company, email, institution_type)
                  VALUES (${company}, ${email}, ${type}) RETURNING *`;
  }

  const [row] = await sql`
    INSERT INTO jobs (employer_id, title, company, institution_type, location, work_mode, employment_type,
                      category, salary_min, salary_max, summary, description, apply_url, is_featured, status)
    VALUES (${employer.id}, ${job.title}, ${employer.company}, ${employer.institution_type}, ${job.location},
            ${job.work_mode}, ${job.employment_type}, ${job.category}, ${job.salary_min}, ${job.salary_max},
            ${job.summary}, ${job.description}, ${job.apply_url}, true, 'pending')
    RETURNING id`;

  try {
    const url = await createJobCheckout(req, employer, row.id);
    return json({ url, job_id: row.id });
  } catch (err) {
    return fail(err.message, 500);
  }
};

export const config = { path: "/api/checkout" };
