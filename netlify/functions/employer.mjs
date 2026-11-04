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
  validateJob, APPLICATION_STATUSES, clean, normalizeName, INSTITUTION_TYPES,
} from "../lib/shared.mjs";
import { CORE_SYSTEMS, LICENSES } from "../lib/banking.mjs";
import { loadFile } from "../lib/files.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

// A candidate's block list ("First Metro Bank, Acme CU") hides them from those employers,
// matching loosely in both directions so "First Metro" still blocks "First Metro Bank".
function blockedFrom(candidate, employerCompany) {
  const emp = normalizeName(employerCompany);
  if (!emp) return false;
  return String(candidate.blocked_employers || "").split(",").some((entry) => {
    const b = normalizeName(entry);
    return b && (emp.includes(b) || b.includes(emp));
  });
}

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
    return json({
      company: employer.company, email: employer.email,
      account: {
        company: employer.company, email: employer.email, institution_type: employer.institution_type,
        contact_name: employer.contact_name, contact_title: employer.contact_title, phone: employer.phone,
        member_since: employer.created_at, has_billing: !!employer.stripe_customer_id,
      },
      jobs, applications,
    });
  }

  // Account details: the hiring manager's name, title, phone, and the institution.
  // Changing the institution name applies to future postings; live ones keep the name they were posted under.
  if (path === "/api/employer/account" && req.method === "PUT") {
    let b;
    try { b = await req.json(); } catch { return fail("Send JSON."); }
    const contactName = clean(b.contact_name, 120);
    const company = clean(b.company, 160);
    if (!contactName) return fail("Enter your name.");
    if (!company) return fail("Enter your institution's name.");
    const type = INSTITUTION_TYPES.includes(b.institution_type) ? b.institution_type : employer.institution_type;
    await sql`UPDATE employers SET contact_name = ${contactName}, contact_title = ${clean(b.contact_title, 120) || null},
                phone = ${clean(b.phone, 40) || null}, company = ${company}, institution_type = ${type}
              WHERE id = ${employer.id}`;
    return json({ ok: true });
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

  // Talent pool: anonymous browsing and invites. Included while the employer has a live posting.
  const inviteMatch = path.match(/^\/api\/employer\/talent\/(\d+)\/invite$/);
  if (path === "/api/employer/talent" || inviteMatch) {
    const openJobs = await sql`
      SELECT id, title FROM jobs
      WHERE employer_id = ${employer.id} AND status = 'open' AND expires_at > now() ORDER BY posted_at DESC`;
    if (!openJobs.length) {
      return fail("The talent pool comes with an active posting. Post a job to browse candidates.", 403);
    }

    if (path === "/api/employer/talent" && req.method === "GET") {
      const p = new URL(req.url).searchParams;
      const rows = await sql`
        SELECT id, location, work_mode_pref, categories, core_systems, licenses, summary,
               blocked_employers, (resume_key IS NOT NULL) AS has_resume, created_at
        FROM candidates
        WHERE pool_visible AND (resume_key IS NOT NULL OR summary IS NOT NULL OR cardinality(categories) > 0)
        ORDER BY created_at DESC LIMIT 500`;
      const invited = await sql`SELECT candidate_id, job_id FROM invites WHERE employer_id = ${employer.id}`;
      const byCand = {};
      for (const r of invited) (byCand[r.candidate_id] ||= []).push(r.job_id);
      const cat = p.get("category"), state = (p.get("state") || "").toUpperCase();
      const core = p.get("core_system"), lic = p.get("license");
      const out = rows
        .filter((c) => !blockedFrom(c, employer.company))
        .filter((c) => !cat || (c.categories || []).includes(cat))
        .filter((c) => !state || new RegExp(`\\b${state}\\b`).test(c.location || ""))
        .filter((c) => !CORE_SYSTEMS[core] || (c.core_systems || []).includes(core))
        .filter((c) => !LICENSES[lic] || (c.licenses || []).includes(lic))
        .map((c) => ({
          // Anonymous on purpose: no name, email, phone, LinkedIn or résumé here.
          id: c.id, location: c.location, work_mode_pref: c.work_mode_pref,
          categories: c.categories || [], core_systems: c.core_systems || [], licenses: c.licenses || [],
          summary: c.summary, has_resume: c.has_resume, member_since: c.created_at,
          invited_job_ids: byCand[c.id] || [],
        }));
      return json({ candidates: out, jobs: openJobs });
    }

    if (inviteMatch && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return fail("Send JSON."); }
      const job = openJobs.find((j) => String(j.id) === String(b.job_id));
      if (!job) return fail("Pick one of your live postings to invite them to.");
      const [cand] = await sql`SELECT * FROM candidates WHERE id = ${inviteMatch[1]} AND pool_visible`;
      if (!cand || blockedFrom(cand, employer.company)) return fail("This candidate isn't available.", 404);
      const note = clean(b.note, 1000);
      const rows = await sql`
        INSERT INTO invites (employer_id, candidate_id, job_id, note)
        VALUES (${employer.id}, ${cand.id}, ${job.id}, ${note || null})
        ON CONFLICT (employer_id, candidate_id, job_id) DO NOTHING RETURNING id`;
      if (!rows.length) return json({ ok: true, duplicate: true });
      const base = siteUrl(req);
      await sendEmail({
        to: cand.email,
        replyTo: employer.email,
        subject: `${employer.company} would like you to apply: ${job.title}`,
        text: `${employer.company} saw your anonymous talent-pool profile on BankJobz and invites you to apply for ${job.title}.`
          + `${note ? `\n\nTheir note: ${note}` : ""}\n\nView the job: ${base}/jobs/${job.id}`
          + `\n\nThey have not seen your name or contact details. Applying or replying to this email shares your details with them. Not interested? Just ignore this.`,
        html: layout({
          heading: `A bank wants you to apply`,
          paragraphs: [
            `<b>${esc(employer.company)}</b> saw your anonymous talent-pool profile and invites you to apply for <b>${esc(job.title)}</b>.`,
            ...(note ? [`Their note: “${esc(note)}”`] : []),
            `They have not seen your name or contact details. Applying — or replying to this email — shares your details with them. Not interested? Just ignore this.`,
          ],
          button: { label: "View the job", url: `${base}/jobs/${job.id}` },
        }),
      });
      return json({ ok: true, duplicate: false });
    }
    return fail("Method not allowed", 405);
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
        apply_url = ${v.apply_url}, core_systems = ${v.core_systems}, licenses = ${v.licenses}, updated_at = now()
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
