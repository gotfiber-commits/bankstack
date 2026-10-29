// Site owner console. Every request needs "Authorization: Bearer <ADMIN_TOKEN>".
// GET  /api/admin                     → revenue and activity figures, all jobs, employers
// POST /api/admin/jobs                → add a sourced listing by hand
// POST /api/admin/jobs/:id/close      → take a listing down (cancels billing for a paid posting)
// POST /api/admin/jobs/:id/reopen     → put a sourced listing back up for 30 days
// POST /api/admin/maintenance         → run the expiry + dead-link check now
import {
  db, stripe, json, fail, safeEqual, validateJob, clean, isUrl, INSTITUTION_TYPES, PRICE_CENTS,
} from "../lib/shared.mjs";
import { runLinkCheck, closeExpired } from "../lib/tasks.mjs";

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
      SELECT (SELECT COUNT(*)::int FROM employers WHERE api_token IS NOT NULL)            AS employer_count,
             (SELECT COUNT(*)::int FROM applications)                                     AS applications,
             (SELECT COUNT(*)::int FROM applications WHERE created_at > now() - interval '7 days') AS applications_7d,
             (SELECT COUNT(*)::int FROM alert_subscriptions WHERE confirmed)              AS alert_subscribers`;
    const jobs = await sql`
      SELECT j.id, j.title, j.company, j.status, j.employer_id IS NOT NULL AS direct, j.source_name,
             j.posted_at, j.expires_at, j.cancel_at_period_end, COUNT(a.id)::int AS applications
      FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
      GROUP BY j.id ORDER BY (j.employer_id IS NOT NULL) DESC, j.posted_at DESC LIMIT 500`;
    const employers = await sql`
      SELECT e.id, e.company, e.email, e.created_at,
             COUNT(j.id) FILTER (WHERE j.status = 'open')::int AS live_postings
      FROM employers e LEFT JOIN jobs j ON j.employer_id = e.id
      WHERE e.api_token IS NOT NULL GROUP BY e.id ORDER BY e.created_at DESC`;
    return json({ ...stats, ...counts, mrr_cents: stats.renewing * PRICE_CENTS, jobs, employers });
  }

  if (req.method !== "POST") return fail("Method not allowed", 405);

  if (path === "/api/admin/maintenance") {
    const expired = await closeExpired();
    return json({ expired, ...(await runLinkCheck()) });
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
    const type = INSTITUTION_TYPES.includes(b.institution_type) ? b.institution_type : "bank";
    const rows = await sql`
      INSERT INTO jobs (title, company, institution_type, location, work_mode, employment_type, category,
                        salary_min, salary_max, summary, description, apply_url, source_name, source_url, expires_at)
      VALUES (${job.title}, ${company}, ${type}, ${job.location}, ${job.work_mode}, ${job.employment_type},
              ${job.category}, ${job.salary_min}, ${job.salary_max}, ${job.summary}, ${job.description},
              ${sourceUrl}, ${clean(b.source_name, 80) || new URL(sourceUrl).hostname}, ${sourceUrl},
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
      try { await stripe().subscriptions.cancel(job.stripe_subscription_id); }
      catch (err) { return fail(`Stripe wouldn't cancel the subscription: ${err.message}`, 502); }
    }
    await sql`UPDATE jobs SET status = 'closed', updated_at = now() WHERE id = ${job.id}`;
    return json({ ok: true });
  }

  if (job.employer_id) return fail("Paid postings come back when the employer posts again.");
  await sql`UPDATE jobs SET status = 'open', expires_at = now() + interval '30 days', updated_at = now()
            WHERE id = ${job.id}`;
  return json({ ok: true });
};

export const config = { path: ["/api/admin", "/api/admin/*"] };
