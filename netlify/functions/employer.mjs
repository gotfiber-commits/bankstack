// Employer area. Every request needs "Authorization: Bearer <session token>" from a full sign-in.
// Also: GET/POST /api/employer/security[/…] (password, authenticator app, recovery codes, sessions,
// trusted devices, notifications), GET /api/employer/applications.csv, POST /applications/:id/notes.
// GET  /api/employer                          → account, postings (billing + application counts), applications
// GET  /api/employer/jobs/:id                 → one posting, for the edit form
// PUT  /api/employer/jobs/:id                 → edit a posting
// POST /api/employer/jobs/:id/publish         → { confirm? } put a saved or closed posting live under the plan
//                                               (may return { url } for Checkout, or { needs_confirm, … })
// POST /api/employer/jobs/:id/close           → take a posting down; the plan's next bill drops to match
// POST /api/employer/plan/cancel | resume     → end the plan at the end of this month / keep it
// POST /api/employer/applications/:id/status  → { status } new | reviewing | interview | offer | hired | rejected
// GET  /api/employer/applications/:id/resume  → download the uploaded résumé
// POST /api/employer/billing                  → Stripe billing portal (cards, invoices)
import {
  db, stripe, json, fail, siteUrl, employerFromRequest, syncJobFromSubscription,
  validateJob, APPLICATION_STATUSES, clean, normalizeName, INSTITUTION_TYPES,
} from "../lib/shared.mjs";
import { CORE_SYSTEMS, LICENSES } from "../lib/banking.mjs";
import { loadFile } from "../lib/files.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";
import {
  hashPassword, verifyPassword, passwordProblem, newTotpSecret, otpauthUrl, verifyTotp, newRecoveryCodes,
  emailTag, passwordKeys, reserveAttempt, attemptPassed, clearAttempts,
} from "../lib/auth.mjs";
import QRCode from "qrcode";
import { planSummary, publishPostings, closePostings, setPlanCancel, createPlanCheckout, BillingError } from "../lib/billing.mjs";

async function notifySecurity(to, what) {
  await sendEmail({
    to,
    subject: `BankJobz security notice: ${what}`,
    text: `${what} on your BankJobz employer account just now. If this was you, there's nothing to do. If it wasn't, reset your password right away from the sign-in page.`,
    html: layout({ heading: "Security notice",
      paragraphs: [`<b>${esc(what)}</b> on your BankJobz employer account just now.`,
        "If this was you, there's nothing to do. If it wasn't, reset your password right away from the sign-in page."] }),
  });
}

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
  if (!employer) return fail("You've been signed out. Sign in again to continue.", 401);
  const sql = db();
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  // Overview
  if (req.method === "GET" && path === "/api/employer") {
    const jobs = await sql`
      SELECT j.id, j.title, j.location, j.category, j.status, j.posted_at, j.paid_through, j.expires_at,
             j.cancel_at_period_end, j.views, j.closed_by,
             COUNT(a.id)::int AS applications,
             COUNT(a.id) FILTER (WHERE a.status = 'new')::int AS new_applications,
             COUNT(a.id) FILTER (WHERE a.created_at > now() - interval '7 days')::int AS applications_7d
      FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
      WHERE j.employer_id = ${employer.id}
      GROUP BY j.id ORDER BY j.posted_at DESC`;
    const applications = await sql`
      SELECT a.id, a.job_id, j.title AS job_title, a.name, a.email, a.phone, a.linkedin_url, a.resume_url,
             a.resume_name, a.resume_size, (a.resume_key IS NOT NULL) AS has_resume, a.cover_note, a.status,
             a.notes, a.rating, a.created_at
      FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE j.employer_id = ${employer.id}
      ORDER BY a.created_at DESC LIMIT 1000`;
    const open = jobs.filter((j) => j.status === "open");
    const pipeline = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0]));
    for (const a of applications) pipeline[a.status] = (pipeline[a.status] || 0) + 1;
    const dayMs = 86400000;
    const plan = await planSummary(sql, employer);
    // Postings worth a look: saved but not live, or a week live with no applicants; plus a plan that's ending.
    const attention = jobs.flatMap((j) => {
      const age = (Date.now() - new Date(j.posted_at).getTime()) / dayMs;
      if (j.status === "pending") return [{ job_id: j.id, title: j.title, reason: "unpublished", text: "Saved but not live yet — publish it from Postings." }];
      if (j.status !== "open") return [];
      if (age >= 7 && j.applications === 0) return [{ job_id: j.id, title: j.title, reason: "quiet", text: `${Math.floor(age)} days live, no applicants yet — try adding pay, or sharpening the summary.` }];
      return [];
    });
    if (plan.live && plan.cancel_at_period_end) {
      attention.unshift({ job_id: null, title: "Your plan", reason: "ending",
        text: `Set to end ${new Date(plan.paid_through).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, and your postings come down with it. Keep your plan if you're still hiring.` });
    }
    return json({
      company: employer.company, email: employer.email,
      account: {
        company: employer.company, email: employer.email, institution_type: employer.institution_type,
        contact_name: employer.contact_name, contact_title: employer.contact_title, phone: employer.phone,
        member_since: employer.created_at, has_billing: !!employer.stripe_customer_id,
        mfa_method: employer.mfa_method === "totp" && employer.totp_secret ? "totp" : "email",
      },
      stats: {
        live_postings: open.length,
        monthly_cents: plan.next_bill_cents,
        applicants: applications.length,
        new_applicants: pipeline.new,
        applicants_7d: applications.filter((a) => Date.now() - new Date(a.created_at).getTime() < 7 * dayMs).length,
        views: open.reduce((s, j) => s + j.views, 0),
      },
      plan, pipeline, attention, jobs, applications,
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

  // ---------- Account & security ----------
  if (path === "/api/employer/security" && req.method === "GET") {
    const sessions = await sql`
      SELECT id, created_at, last_seen_at, user_agent, ip FROM employer_sessions
      WHERE employer_id = ${employer.id} AND revoked_at IS NULL AND expires_at > now()
        AND last_seen_at > now() - interval '14 days'
      ORDER BY last_seen_at DESC LIMIT 25`;
    const [{ n: devices }] = await sql`
      SELECT COUNT(*)::int AS n FROM employer_devices WHERE employer_id = ${employer.id} AND expires_at > now()`;
    return json({
      mfa_method: employer.mfa_method === "totp" && employer.totp_secret ? "totp" : "email",
      recovery_codes_left: (employer.recovery_codes || []).length,
      password_changed_at: employer.password_changed_at,
      trusted_devices: devices,
      notify_each_applicant: employer.notify_each_applicant,
      sessions: sessions.map((s) => ({ ...s, current: String(s.id) === String(employer.session_id) })),
    });
  }

  if (path.startsWith("/api/employer/security/") && req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch { /* some actions take no body */ }
    const action = path.slice("/api/employer/security/".length);
    // Sensitive changes need the current password, so a borrowed unlocked laptop or a stolen session
    // can't take the account over. Guesses here are counted per session and per account, separately
    // from sign-in, so outsiders guessing at the sign-in page can't stop the owner changing settings.
    const needPassword = ["password", "totp/start", "totp/disable", "recovery-codes"].includes(action);
    if (needPassword) {
      const keys = [[`set:${emailTag(employer.email)}:${employer.session_id}`, 8], [`setall:${emailTag(employer.email)}`, 20]];
      if (!(await reserveAttempt(sql, keys))) return fail("Too many wrong passwords. Try again in 15 minutes.", 429);
      if (!verifyPassword(b.current_password, employer.password_hash)) return fail("Your current password isn't right.", 401);
      await attemptPassed(sql, keys);
    }
    const appOn = employer.mfa_method === "totp" && !!employer.totp_secret;

    if (action === "password") {
      const problem = passwordProblem(b.new_password, employer.email);
      if (problem) return fail(problem);
      await sql`UPDATE employers SET password_hash = ${hashPassword(b.new_password)}, password_changed_at = now() WHERE id = ${employer.id}`;
      // Keep this session; sign out everywhere else, and every device asks for a code again.
      await sql`UPDATE employer_sessions SET revoked_at = now()
                WHERE employer_id = ${employer.id} AND id <> ${employer.session_id} AND revoked_at IS NULL`;
      await sql`DELETE FROM employer_devices WHERE employer_id = ${employer.id}`;
      await clearAttempts(sql, passwordKeys(emailTag(employer.email), req));
      await notifySecurity(employer.email, "Your password was changed");
      return json({ ok: true });
    }

    if (action === "totp/start") {
      if (appOn) return fail("An authenticator app is already on. Turn it off first to switch to a new one.", 409);
      const secret = newTotpSecret();
      await sql`UPDATE employers SET totp_pending_secret = ${secret} WHERE id = ${employer.id}`;
      const url = otpauthUrl(secret, employer.email);
      const qr_svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 200, errorCorrectionLevel: "M" });
      return json({ secret, otpauth: url, qr_svg });
    }

    if (action === "totp/confirm") {
      if (appOn) return fail("An authenticator app is already on. Turn it off first to switch to a new one.", 409);
      if (!employer.totp_pending_secret) return fail("Start the authenticator setup first.");
      const step = verifyTotp(employer.totp_pending_secret, b.code, -1);
      if (step === null) return fail("That code doesn't match. Check your phone's clock and try the newest code.", 400);
      const { codes, hashes } = newRecoveryCodes();
      await sql`UPDATE employers SET mfa_method = 'totp', totp_secret = totp_pending_secret, totp_pending_secret = NULL,
                  totp_last_step = ${step}, recovery_codes = ${hashes} WHERE id = ${employer.id}`;
      await notifySecurity(employer.email, "An authenticator app was turned on for sign-in");
      return json({ ok: true, recovery_codes: codes });
    }

    if (action === "totp/disable") {
      await sql`UPDATE employers SET mfa_method = 'email', totp_secret = NULL, totp_pending_secret = NULL,
                  totp_last_step = NULL, recovery_codes = '{}' WHERE id = ${employer.id}`;
      await sql`DELETE FROM employer_devices WHERE employer_id = ${employer.id}`;
      await notifySecurity(employer.email, "The authenticator app was turned off; sign-in codes now come by email");
      return json({ ok: true });
    }

    if (action === "recovery-codes") {
      if (employer.mfa_method !== "totp") return fail("Recovery codes come with an authenticator app. Turn that on first.");
      const { codes, hashes } = newRecoveryCodes();
      await sql`UPDATE employers SET recovery_codes = ${hashes} WHERE id = ${employer.id}`;
      return json({ ok: true, recovery_codes: codes });
    }

    if (action === "sessions/revoke-others") {
      await sql`UPDATE employer_sessions SET revoked_at = now()
                WHERE employer_id = ${employer.id} AND id <> ${employer.session_id} AND revoked_at IS NULL`;
      return json({ ok: true });
    }

    const revokeMatch = action.match(/^sessions\/(\d+)\/revoke$/);
    if (revokeMatch) {
      await sql`UPDATE employer_sessions SET revoked_at = now()
                WHERE id = ${revokeMatch[1]} AND employer_id = ${employer.id} AND revoked_at IS NULL`;
      return json({ ok: true, signed_out_here: revokeMatch[1] === String(employer.session_id) });
    }

    if (action === "devices/forget") {
      await sql`DELETE FROM employer_devices WHERE employer_id = ${employer.id}`;
      return json({ ok: true });
    }

    if (action === "notifications") {
      await sql`UPDATE employers SET notify_each_applicant = ${b.notify_each_applicant !== false} WHERE id = ${employer.id}`;
      return json({ ok: true });
    }
    return fail("Not found", 404);
  }

  // ---------- Applicants: export, notes and ratings ----------
  if (path === "/api/employer/applications.csv" && req.method === "GET") {
    const p = new URL(req.url).searchParams;
    const jobId = /^\d+$/.test(p.get("job_id") || "") ? p.get("job_id") : null;
    const status = APPLICATION_STATUSES.includes(p.get("status")) ? p.get("status") : null;
    const rows = await sql`
      SELECT a.created_at, j.title AS job, a.name, a.email, a.phone, a.linkedin_url, a.status, a.rating, a.notes, a.cover_note
      FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE j.employer_id = ${employer.id}
        AND (${jobId}::bigint IS NULL OR a.job_id = ${jobId}::bigint)
        AND (${status}::text IS NULL OR a.status = ${status}::text)
      ORDER BY a.created_at DESC`;
    const cell = (v) => {
      let s = v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Applied", "Job", "Name", "Email", "Phone", "LinkedIn", "Stage", "Rating", "Your notes", "Cover note"];
    const body = rows.map((r) => [r.created_at, r.job, r.name, r.email, r.phone, r.linkedin_url, r.status, r.rating, r.notes, r.cover_note]
      .map(cell).join(",")).join("\r\n");
    return new Response("﻿" + header.join(",") + "\r\n" + body + (body ? "\r\n" : ""), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="bankjobz-applicants-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  }

  // The hiring plan: end it at the end of this month, or keep it.
  const planMatch = path.match(/^\/api\/employer\/plan\/(cancel|resume)$/);
  if (planMatch && req.method === "POST") {
    try {
      await setPlanCancel(employer.id, planMatch[1] === "cancel");
      return json({ ok: true, plan: await planSummary(sql, (await sql`SELECT * FROM employers WHERE id = ${employer.id}`)[0]) });
    } catch (err) { return fail(err.message, err instanceof BillingError ? err.status : 502); }
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
  const appMatch = path.match(/^\/api\/employer\/applications\/(\d+)\/(status|resume|notes)$/);
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
    // Private to the employer: never shown to the candidate.
    if (appMatch[2] === "notes" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return fail("Send JSON."); }
      const rating = b.rating === null || b.rating === "" || b.rating === undefined ? null : Number(b.rating);
      if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return fail("Rate from 1 to 5 stars.");
      await sql`UPDATE applications SET notes = ${clean(b.notes, 5000) || null}, rating = ${rating} WHERE id = ${app.id}`;
      return json({ ok: true });
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
  const jobMatch = path.match(/^\/api\/employer\/jobs\/(\d+)(?:\/(publish|pay|close|cancel|resume))?$/);
  if (!jobMatch) return fail("Not found", 404);
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobMatch[1]} AND employer_id = ${employer.id}`;
  if (!job) return fail("Job not found", 404);
  const action = jobMatch[2];

  if (!action && req.method === "GET") {
    const { stripe_subscription_id, ...rest } = job;
    return json(rest);
  }

  if (!action && req.method === "PUT") {
    if (job.status === "closed" && job.closed_by === "admin") return fail("This posting was taken down by BankJobz. Email listings@bankjobz.com if you think that's a mistake.");
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

  // Older per-posting subscriptions keep their own stop/resume renewing.
  if (job.stripe_subscription_id) {
    if (!["cancel", "resume", "close"].includes(action)) return fail("This posting is billed on its own and is already paid for.");
    const sub = await stripe().subscriptions.update(job.stripe_subscription_id, { cancel_at_period_end: action !== "resume" });
    await syncJobFromSubscription(sub, job.id);
    return json({ ok: true });
  }

  let b = {};
  try { b = await req.json(); } catch { /* no body */ }
  try {
    if (action === "publish" || action === "pay") {
      if (job.status === "open") return fail("This posting is already live.");
      if (job.status === "closed" && job.closed_by === "admin") return fail("This posting was taken down by BankJobz and can't be reopened.");
      const r = await publishPostings(employer.id, [job.id], { confirm: b.confirm === true });
      if (r.needs_checkout) return json({ url: await createPlanCheckout(employer, job.id) });
      if (r.needs_confirm) return json({ ...r, job_id: job.id });
      return json({ ok: true, live: true, monthly_cents: r.monthly_cents, upgraded: r.upgraded });
    }
    if (action === "close" || action === "cancel") {
      if (job.status === "closed") return fail("This posting is already closed.");
      await closePostings(employer.id, [job.id]);
      return json({ ok: true });
    }
    return fail("Not found", 404);
  } catch (err) {
    return fail(err.message, err instanceof BillingError ? err.status : 502);
  }
};

export const config = { path: ["/api/employer", "/api/employer/*"] };
