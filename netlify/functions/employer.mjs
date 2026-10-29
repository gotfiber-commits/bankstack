// Employer area. Every request needs "Authorization: Bearer <posting key>".
// GET  /api/employer                          → account, postings (billing + application counts), applications
// GET  /api/employer/jobs/:id                 → one posting, for the edit form
// PUT  /api/employer/jobs/:id                 → edit a posting
// POST /api/employer/jobs/:id/pay             → new checkout link for a posting still awaiting payment
// POST /api/employer/jobs/:id/cancel          → stop renewing; stays live until its paid-through date
// POST /api/employer/jobs/:id/resume          → undo a cancellation before it takes effect
// POST /api/employer/applications/:id/status  → { status } new | reviewing | interview | offer | hired | rejected
// GET  /api/employer/applications/:id/resume  → download the uploaded résumé
// POST /api/employer/billing                  → Stripe billing portal (cards, invoices)
import {
  db, stripe, json, fail, siteUrl, employerFromRequest, createJobCheckout, syncJobFromSubscription,
  validateJob, APPLICATION_STATUSES,
} from "../lib/shared.mjs";
import { loadFile } from "../lib/files.mjs";

export default async (req) => {
  const employer = await employerFromRequest(req);
  if (!employer) return fail("Your sign-in has expired or the key wasn't recognized. Sign in again on the Post a job page.", 401);
  const sql = db();
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  // Overview
  if (req.method === "GET" && path === "/api/employer") {
    const jobs = await sql`
      SELECT j.id, j.title, j.location, j.status, j.posted_at, j.paid_through, j.cancel_at_period_end,
             COUNT(a.id)::int AS applications,
             COUNT(a.id) FILTER (WHERE a.status = 'new')::int AS new_applications
      FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
      WHERE j.employer_id = ${employer.id}
      GROUP BY j.id ORDER BY j.posted_at DESC`;
    const applications = await sql`
      SELECT a.id, a.job_id, j.title AS job_title, a.name, a.email, a.phone, a.linkedin_url, a.resume_url,
             a.resume_name, a.resume_size, (a.resume_key IS NOT NULL) AS has_resume, a.cover_note, a.status, a.created_at
      FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE j.employer_id = ${employer.id}
      ORDER BY a.created_at DESC LIMIT 500`;
    return json({ company: employer.company, email: employer.email, jobs, applications });
  }

  // Billing portal
  if (req.method === "POST" && path === "/api/employer/billing") {
    if (!employer.stripe_customer_id) return fail("No billing account yet.", 404);
    const portal = await stripe().billingPortal.sessions.create({
      customer: employer.stripe_customer_id,
      return_url: `${siteUrl(req)}/#dashboard`,
    });
    return json({ url: portal.url });
  }

  // Applications
  const appMatch = path.match(/^\/api\/employer\/applications\/(\d+)\/(status|resume)$/);
  if (appMatch) {
    const [app] = await sql`
      SELECT a.* FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ${appMatch[1]} AND j.employer_id = ${employer.id}`;
    if (!app) return fail("Application not found", 404);

    if (appMatch[2] === "status" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return fail("Send JSON."); }
      if (!APPLICATION_STATUSES.includes(b.status)) return fail("Pick a valid stage.");
      await sql`UPDATE applications SET status = ${b.status} WHERE id = ${app.id}`;
      return json({ ok: true, status: b.status });
    }
    if (appMatch[2] === "resume" && req.method === "GET") {
      if (!app.resume_key) return fail("This candidate didn't upload a résumé.", 404);
      const file = await loadFile(app.resume_key);
      if (!file) return fail("The résumé file is missing.", 404);
      const name = (app.resume_name || "resume").replace(/"/g, "");
      return new Response(file.data, {
        headers: {
          "content-type": app.resume_type || "application/octet-stream",
          "content-disposition": `attachment; filename="${name}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return fail("Method not allowed", 405);
  }

  // Postings
  const jobMatch = path.match(/^\/api\/employer\/jobs\/(\d+)(?:\/(pay|cancel|resume))?$/);
  if (!jobMatch) return fail("Not found", 404);
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobMatch[1]} AND employer_id = ${employer.id}`;
  if (!job) return fail("Job not found", 404);
  const action = jobMatch[2];

  if (!action && req.method === "GET") {
    const { stripe_subscription_id, ...rest } = job;
    return json(rest);
  }

  if (!action && req.method === "PUT") {
    if (job.status === "closed") return fail("This posting is closed. Post it again to relist it.");
    let b;
    try { b = await req.json(); } catch { return fail("Send JSON."); }
    const { job: v, error } = validateJob(b);
    if (error) return fail(error);
    await sql`
      UPDATE jobs SET title = ${v.title}, location = ${v.location}, work_mode = ${v.work_mode},
        employment_type = ${v.employment_type}, category = ${v.category}, salary_min = ${v.salary_min},
        salary_max = ${v.salary_max}, summary = ${v.summary}, description = ${v.description},
        apply_url = ${v.apply_url}, updated_at = now()
      WHERE id = ${job.id}`;
    return json({ ok: true });
  }

  if (req.method !== "POST" || !action) return fail("Method not allowed", 405);

  if (action === "pay") {
    if (job.status !== "pending") return fail("This posting is already paid for.");
    try { return json({ url: await createJobCheckout(req, employer, job.id) }); }
    catch (err) { return fail(err.message, 500); }
  }

  if (!job.stripe_subscription_id) return fail("This posting has no active billing.");
  const sub = await stripe().subscriptions.update(job.stripe_subscription_id, {
    cancel_at_period_end: action === "cancel",
  });
  await syncJobFromSubscription(sub, job.id);
  return json({ ok: true });
};

export const config = { path: ["/api/employer", "/api/employer/*"] };
