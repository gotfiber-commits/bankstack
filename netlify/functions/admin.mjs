// Site owner console. Every request needs "Authorization: Bearer <ADMIN_TOKEN>".
// GET  /api/admin                     → revenue and activity figures, all jobs, employers
// POST /api/admin/jobs                → add a sourced listing by hand
// POST /api/admin/jobs/:id/close      → take a listing down (cancels billing for a paid posting)
// POST /api/admin/jobs/:id/reopen     → put a sourced listing back up for 30 days
// POST /api/admin/maintenance         → run the expiry + dead-link check now
// POST /api/admin/claims/:id/approve | reject   → { note? } decide a claim waiting for review
// POST /api/admin/candidates/:id/nmls/verify | reject → { note? } after checking NMLS Consumer Access by hand
import {
  db, stripe, json, fail, safeEqual, validateJob, clean, isUrl, INSTITUTION_TYPES, isEntryLevel, siteUrl,
  findInstitutionId, isAggregatorUrl,
} from "../lib/shared.mjs";
import { runLinkCheck, closeExpired } from "../lib/tasks.mjs";
import { planPrice, describePrice, monthlyCents, createPlanPrice, closePostings, planLive, reconcilePlans, remindTrials, BillingError } from "../lib/billing.mjs";
import { decideClaim } from "../lib/claims.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";
import { syncInstitutions } from "../lib/institutions.mjs";

export default async (req) => {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  if (!process.env.ADMIN_TOKEN) return fail("Set ADMIN_TOKEN to use the admin console.", 503);
  if (!safeEqual(auth, process.env.ADMIN_TOKEN)) return fail("Admin key not recognized.", 401);

  const sql = db();
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (req.method === "GET" && path === "/api/admin") {
    const [stats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open' AND expires_at > now())::int                         AS open_jobs,
        COUNT(*) FILTER (WHERE employer_id IS NOT NULL AND status = 'open' AND expires_at > now())::int AS paid_live,
        COUNT(*) FILTER (WHERE employer_id IS NOT NULL AND status = 'open' AND NOT cancel_at_period_end
                         AND expires_at > now())::int                                                AS renewing,
        COUNT(*) FILTER (WHERE employer_id IS NOT NULL AND status = 'pending')::int                  AS unpaid,
        COUNT(*) FILTER (WHERE employer_id IS NULL AND status = 'open' AND expires_at > now())::int   AS sourced_live
      FROM jobs`;
    const [counts] = await sql`
      SELECT (SELECT COUNT(*)::int FROM employers WHERE verified_at IS NOT NULL)            AS employer_count,
             (SELECT COUNT(*)::int FROM applications)                                     AS applications,
             (SELECT COUNT(*)::int FROM applications WHERE created_at > now() - interval '7 days') AS applications_7d,
             (SELECT COUNT(*)::int FROM alert_subscriptions WHERE confirmed)              AS alert_subscribers`;
    const jobs = await sql`
      SELECT j.id, j.title, j.company, j.status, j.employer_id IS NOT NULL AS direct, j.source_name,
             j.posted_at, j.expires_at, j.cancel_at_period_end, COUNT(a.id)::int AS applications
      FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
      GROUP BY j.id ORDER BY (j.employer_id IS NOT NULL) DESC, j.posted_at DESC LIMIT 500`;
    const employers = await sql`
      SELECT e.id, e.company, e.email, e.created_at, e.plan_subscription_id, e.plan_status, e.plan_paid_through,
             e.plan_cancel_at_period_end, e.plan_quantity, e.plan_interval, e.plan_collection, e.plan_trial_end,
             COUNT(j.id) FILTER (WHERE j.status = 'open')::int AS live_postings
      FROM employers e LEFT JOIN jobs j ON j.employer_id = e.id
      WHERE e.verified_at IS NOT NULL GROUP BY e.id ORDER BY e.created_at DESC`;
    // Revenue: each paying plan's next bill from its Stripe price, as a monthly figure (yearly ÷ 12).
    // Free trials aren't revenue yet; they're counted on their own.
    let price = null, yearPrice = null, priceError = null;
    try {
      price = await planPrice({ fresh: true });
      yearPrice = await planPrice({ fresh: true, interval: "year" });
    } catch (err) { priceError = err.message; }
    const plans = employers.filter((e) => planLive(e));
    const perMonth = (e) => {
      const p = e.plan_interval === "year" ? yearPrice : price;
      if (!p) return null;
      const c = monthlyCents(p, Math.max(1, Number(e.plan_quantity || 1)));
      return e.plan_interval === "year" ? Math.round(c / 12) : c;
    };
    const paying = plans.filter((e) => e.plan_status !== "trialing");
    const mrr = paying.filter((e) => !e.plan_cancel_at_period_end).reduce((sum, e) => sum + (perMonth(e) || 0), 0);
    for (const e of employers) {
      e.plan = planLive(e) ? { renewing: !e.plan_cancel_at_period_end, paid_through: e.plan_paid_through,
        monthly_cents: perMonth(e), interval: e.plan_interval === "year" ? "year" : "month",
        invoice: e.plan_collection === "send_invoice", trial_end: e.plan_status === "trialing" ? e.plan_trial_end : null } : null;
      for (const k of ["plan_subscription_id", "plan_status", "plan_paid_through", "plan_cancel_at_period_end", "plan_quantity",
        "plan_interval", "plan_collection", "plan_trial_end"]) delete e[k];
    }
    let directory = { banks: 0, credit_unions: 0 };
    try {
      [directory] = await sql`
        SELECT COUNT(*) FILTER (WHERE institution_type = 'bank')::int         AS banks,
               COUNT(*) FILTER (WHERE institution_type = 'credit-union')::int AS credit_unions
        FROM institutions WHERE active`;
    } catch { /* directory tables not migrated yet */ }
    let messages = [];
    try {
      messages = await sql`SELECT id, name, email, organization, topic, message, emailed, created_at
        FROM contact_messages ORDER BY created_at DESC LIMIT 50`;
    } catch { /* contact table not migrated yet */ }
    // Claims waiting for review, and institutions with gathered listings nobody has claimed yet
    // (the outreach list: each has a claim link to send).
    let claims = [], claimable = [], nmls = [];
    try {
      claims = await sql`
        SELECT c.id, c.created_at, c.method, cardinality(c.job_ids)::int AS job_count, i.name AS institution, i.slug,
               i.website, i.city, i.state, e.email, e.company, e.contact_name, e.contact_title
        FROM institution_claims c JOIN institutions i ON i.id = c.institution_id JOIN employers e ON e.id = c.employer_id
        WHERE c.status = 'pending' ORDER BY c.created_at`;
      claimable = await sql`
        SELECT i.name, i.slug, i.city, i.state, i.website, COUNT(j.id)::int AS listings
        FROM institutions i JOIN jobs j ON j.institution_id = i.id
        WHERE j.employer_id IS NULL AND j.status = 'open' AND j.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM institution_claims c WHERE c.institution_id = i.id AND c.status = 'approved')
        GROUP BY i.id ORDER BY listings DESC, i.name LIMIT 300`;
      nmls = await sql`SELECT id, name, email, nmls_id, location, created_at FROM candidates
        WHERE nmls_status = 'pending' ORDER BY created_at LIMIT 200`;
    } catch { /* claim / NMLS tables not migrated yet */ }
    return json({ ...stats, ...counts, directory, mrr_cents: mrr, live_plans: paying.length,
      renewing_plans: paying.filter((e) => !e.plan_cancel_at_period_end).length,
      trial_plans: plans.length - paying.length,
      billing: { plan: describePrice(price), yearly: describePrice(yearPrice), error: priceError },
      jobs, employers, messages, claims, claimable, nmls });
  }

  if (req.method !== "POST") return fail("Method not allowed", 405);

  if (path === "/api/admin/maintenance") {
    const plans = await reconcilePlans().catch(() => 0);
    const expired = await closeExpired();
    const trial_reminders = await remindTrials().catch(() => 0);
    return json({ plans, expired, trial_reminders, ...(await runLinkCheck()) });
  }

  // Creates the hiring-plan price in Stripe: $99 up to 5 postings, $159.99 up to 10, + extra_cents each over 10.
  if (path === "/api/admin/billing/plan") {
    let b = {};
    try { b = await req.json(); } catch { /* empty */ }
    try {
      const { monthly, yearly } = await createPlanPrice(Math.round(Number(b.extra_dollars) * 100));
      return json({ ok: true, plan: describePrice(monthly), yearly: describePrice(yearly) });
    } catch (err) {
      return fail(err.message, err instanceof BillingError ? err.status : 502);
    }
  }

  const claimMatch = path.match(/^\/api\/admin\/claims\/(\d+)\/(approve|reject)$/);
  if (claimMatch) {
    let b = {};
    try { b = await req.json(); } catch { /* no note */ }
    try { return json(await decideClaim(claimMatch[1], claimMatch[2] === "approve", clean(b.note, 600))); }
    catch (err) { return fail(err.message, err instanceof BillingError ? err.status : 502); }
  }

  // NMLS: the site owner looked the ID up on NMLS Consumer Access and confirmed (or couldn't confirm)
  // that it's an individual record matching the candidate's name.
  const nmlsMatch = path.match(/^\/api\/admin\/candidates\/(\d+)\/nmls\/(verify|reject)$/);
  if (nmlsMatch) {
    let b = {};
    try { b = await req.json(); } catch { /* no note */ }
    const verified = nmlsMatch[2] === "verify";
    const note = clean(b.note, 300) || null;
    const [c] = await sql`UPDATE candidates SET nmls_status = ${verified ? "verified" : "rejected"}, nmls_checked_at = now(),
        nmls_note = ${note}
      WHERE id = ${nmlsMatch[1]} AND nmls_status = 'pending' AND nmls_id IS NOT NULL RETURNING email, name, nmls_id`;
    if (!c) return fail("That NMLS ID isn't waiting for review (it may have changed or already been checked).", 409);
    const text = verified
      ? `Your NMLS ID ${c.nmls_id} is verified on BankJobz. Employers now see an NMLS verified badge on your applications and in the talent pool.`
      : `We couldn't match NMLS ID ${c.nmls_id} to the name on your BankJobz profile${note ? ` (${note})` : ""}. Check the number and that your profile name matches your NMLS record, then save your profile again.`;
    await sendEmail({
      to: c.email,
      subject: verified ? "Your NMLS ID is verified on BankJobz" : "We couldn't verify your NMLS ID",
      text: `${text}\n\nYour profile: ${siteUrl()}/#profile`,
      html: layout({ heading: verified ? "NMLS ID verified" : "We couldn't verify your NMLS ID", paragraphs: [esc(text)],
        button: { label: "Open your profile", url: `${siteUrl()}/#profile` } }),
    });
    return json({ ok: true, status: verified ? "verified" : "rejected" });
  }

  // Institution directory sync: one page per call; the admin page loops until next_offset is null.
  if (path === "/api/admin/institutions/sync") {
    let b;
    try { b = await req.json(); } catch { return fail("Send JSON."); }
    try { return json(await syncInstitutions(b.source, Number(b.offset) || 0)); }
    catch (err) { return fail(`Directory sync failed: ${err.message}`, 502); }
  }

  if (path === "/api/admin/jobs") {
    let b;
    try { b = await req.json(); } catch { return fail("Send JSON."); }
    const { job, error } = validateJob(b);
    if (error) return fail(error);
    const company = clean(b.company, 160);
    const sourceUrl = clean(b.source_url, 500);
    if (!company) return fail("Add the employer's name.");
    if (!isUrl(sourceUrl)) return fail("Add the original posting's link.");
    if (isAggregatorUrl(sourceUrl)) {
      return fail("That link is on a third-party job board — those pages go stale and break. Use the institution's own careers or ATS page instead.");
    }
    const type = INSTITUTION_TYPES.includes(b.institution_type) ? b.institution_type : "bank";
    const instId = await findInstitutionId(sql, company);
    const rows = await sql`
      INSERT INTO jobs (title, company, institution_type, location, work_mode, employment_type, category,
                        salary_min, salary_max, summary, description, apply_url, core_systems, licenses,
                        institution_id, source_name, source_url, expires_at, entry_level)
      VALUES (${job.title}, ${company}, ${type}, ${job.location}, ${job.work_mode}, ${job.employment_type},
              ${job.category}, ${job.salary_min}, ${job.salary_max}, ${job.summary}, ${job.description},
              ${sourceUrl}, ${job.core_systems}, ${job.licenses}, ${instId},
              ${clean(b.source_name, 80) || new URL(sourceUrl).hostname}, ${sourceUrl},
              now() + interval '30 days', ${job.entry_level || isEntryLevel(job.title, job.employment_type)})
      ON CONFLICT (source_url) DO NOTHING RETURNING id`;
    return rows.length ? json({ ok: true, id: rows[0].id }, 201) : fail("That posting is already on the board.", 409);
  }

  const m = path.match(/^\/api\/admin\/jobs\/(\d+)\/(close|reopen)$/);
  if (!m) return fail("Not found", 404);
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${m[1]}`;
  if (!job) return fail("Job not found", 404);

  if (m[2] === "close") {
    if (job.stripe_subscription_id) {
      // An older per-posting subscription: cancel it outright.
      try { await stripe().subscriptions.cancel(job.stripe_subscription_id); }
      catch (err) { return fail(`Stripe wouldn't cancel the subscription: ${err.message}`, 502); }
    } else if (job.employer_id) {
      // A plan posting: take it down and lower the employer's next bill to match.
      try { await closePostings(job.employer_id, [job.id], "admin"); }
      catch (err) { return fail(`Couldn't update the employer's plan: ${err.message}`, 502); }
    }
    await sql`UPDATE jobs SET status = 'closed', closed_by = 'admin', updated_at = now() WHERE id = ${job.id}`;
    return json({ ok: true });
  }

  if (job.employer_id) return fail("Paid postings come back when the employer posts again.");
  await sql`UPDATE jobs SET status = 'open', expires_at = now() + interval '30 days', updated_at = now()
            WHERE id = ${job.id}`;
  return json({ ok: true });
};

export const config = { path: ["/api/admin", "/api/admin/*"] };
