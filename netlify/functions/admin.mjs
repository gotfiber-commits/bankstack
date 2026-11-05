// Site owner console. Every request needs "Authorization: Bearer <ADMIN_TOKEN>".
// GET  /api/admin                     → revenue and activity figures, all jobs, employers
// POST /api/admin/jobs                → add a sourced listing by hand
// POST /api/admin/jobs/:id/close      → take a listing down (cancels billing for a paid posting)
// POST /api/admin/jobs/:id/reopen     → put a sourced listing back up for 30 days
// POST /api/admin/maintenance         → run the expiry + dead-link check now
import {
  db, stripe, json, fail, safeEqual, validateJob, clean, isUrl, INSTITUTION_TYPES,
  findInstitutionId, isAggregatorUrl,
} from "../lib/shared.mjs";
import { runLinkCheck, closeExpired } from "../lib/tasks.mjs";
import { planPrice, describePrice, monthlyCents, createPlanPrice, closePostings, planLive, reconcilePlans, BillingError } from "../lib/billing.mjs";
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
             e.plan_cancel_at_period_end, e.plan_quantity,
             COUNT(j.id) FILTER (WHERE j.status = 'open')::int AS live_postings
      FROM employers e LEFT JOIN jobs j ON j.employer_id = e.id
      WHERE e.verified_at IS NOT NULL GROUP BY e.id ORDER BY e.created_at DESC`;
    // Revenue: each live plan's next monthly bill, from the Stripe price.
    let price = null, priceError = null;
    try { price = await planPrice({ fresh: true }); } catch (err) { priceError = err.message; }
    const plans = employers.filter((e) => planLive(e));
    const mrr = price ? plans.filter((e) => !e.plan_cancel_at_period_end)
      .reduce((sum, e) => sum + monthlyCents(price, Math.max(1, Number(e.plan_quantity || 1))), 0) : 0;
    for (const e of employers) {
      e.plan = planLive(e) ? { renewing: !e.plan_cancel_at_period_end, paid_through: e.plan_paid_through,
        monthly_cents: price ? monthlyCents(price, Math.max(1, Number(e.plan_quantity || 1))) : null } : null;
      for (const k of ["plan_subscription_id", "plan_status", "plan_paid_through", "plan_cancel_at_period_end", "plan_quantity"]) delete e[k];
    }
    let directory = { banks: 0, credit_unions: 0 };
    try {
      [directory] = await sql`
        SELECT COUNT(*) FILTER (WHERE institution_type = 'bank')::int         AS banks,
               COUNT(*) FILTER (WHERE institution_type = 'credit-union')::int AS credit_unions
        FROM institutions WHERE active`;
    } catch { /* directory tables not migrated yet */ }
    return json({ ...stats, ...counts, directory, mrr_cents: mrr, live_plans: plans.length,
      renewing_plans: plans.filter((e) => !e.plan_cancel_at_period_end).length,
      billing: { plan: describePrice(price), error: priceError }, jobs, employers });
  }

  if (req.method !== "POST") return fail("Method not allowed", 405);

  if (path === "/api/admin/maintenance") {
    const plans = await reconcilePlans().catch(() => 0);
    const expired = await closeExpired();
    return json({ plans, expired, ...(await runLinkCheck()) });
  }

  // Creates the hiring-plan price in Stripe: $99 up to 5 postings, $159.99 up to 10, + extra_cents each over 10.
  if (path === "/api/admin/billing/plan") {
    let b = {};
    try { b = await req.json(); } catch { /* empty */ }
    try {
      const price = await createPlanPrice(Math.round(Number(b.extra_dollars) * 100));
      return json({ ok: true, plan: describePrice(price) });
    } catch (err) {
      return fail(err.message, err instanceof BillingError ? err.status : 502);
    }
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
                        institution_id, source_name, source_url, expires_at)
      VALUES (${job.title}, ${company}, ${type}, ${job.location}, ${job.work_mode}, ${job.employment_type},
              ${job.category}, ${job.salary_min}, ${job.salary_max}, ${job.summary}, ${job.description},
              ${sourceUrl}, ${job.core_systems}, ${job.licenses}, ${instId},
              ${clean(b.source_name, 80) || new URL(sourceUrl).hostname}, ${sourceUrl},
              now() + interval '30 days')
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
