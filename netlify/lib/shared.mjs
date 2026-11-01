import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import pg from "pg";
import Stripe from "stripe";

let _sql, _stripe;

// Both drivers expose the same shape: sql`...${v}` and sql.query(text, params), each returning rows.
// Neon's HTTP driver is used for Neon URLs; any other Postgres (local, Docker, RDS) goes through pg.
function pgClient(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const sql = async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + "$" + i + s);
    return (await pool.query(text, values)).rows;
  };
  sql.query = async (text, params = []) => (await pool.query(text, params)).rows;
  sql.end = () => pool.end();
  return sql;
}

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const useNeon = process.env.DB_DRIVER ? process.env.DB_DRIVER === "neon" : /neon\.tech/.test(url);
    _sql = useNeon ? neon(url) : pgClient(url);
  }
  return _sql;
}

export function stripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
    // STRIPE_API_HOST is only for pointing at a local Stripe test server.
    const host = process.env.STRIPE_API_HOST;
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, host
      ? { host, port: Number(process.env.STRIPE_API_PORT || 443), protocol: process.env.STRIPE_API_PROTOCOL || "https" }
      : {});
  }
  return _stripe;
}

export const PRICE_CENTS = 9900;
export const BRAND = "BankJobz";

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const fail = (message, status = 400) => json({ error: message }, status);

export function siteUrl(req) {
  return process.env.URL || new URL(req.url).origin;
}

export const CATEGORIES = [
  "branch-retail", "lending-credit", "commercial-banking", "operations", "risk-compliance", "finance-accounting", "wealth-trust", "technology", "data-analytics", "leadership-admin",
];
export const WORK_MODES = ["onsite", "hybrid", "remote"];
export const INSTITUTION_TYPES = ["bank", "credit-union", "fintech", "other"];
export const EMPLOYMENT_TYPES = ["full-time", "part-time", "contract", "internship"];
export const APPLICATION_STATUSES = ["new", "reviewing", "interview", "offer", "hired", "rejected"];

export const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
export const isUrl = (s) => {
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:"; }
  catch { return false; }
};
export const clean = (s, max = 500) => (typeof s === "string" ? s.trim().slice(0, max) : "");
export const newToken = () => "bsk_" + crypto.randomBytes(24).toString("hex");
export const randomToken = () => crypto.randomBytes(24).toString("hex");
export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// Constant-time string comparison for secrets.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { location } });
}

// Resolves the employer from "Authorization: Bearer <token>". Returns null when missing or unknown.
export async function employerFromRequest(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const rows = await db()`SELECT * FROM employers WHERE api_token = ${token} LIMIT 1`;
  return rows[0] || null;
}

// Stripe moved current_period_end onto subscription items in newer API versions; read either.
export function periodEnd(sub) {
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}

// Validates a job posted by an employer. Returns { job } or { error }.
export function validateJob(b) {
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const job = {
    title: clean(b.title, 160),
    location: clean(b.location, 160),
    work_mode: WORK_MODES.includes(b.work_mode) ? b.work_mode : "onsite",
    employment_type: EMPLOYMENT_TYPES.includes(b.employment_type) ? b.employment_type : "full-time",
    category: b.category,
    salary_min: num(b.salary_min),
    salary_max: num(b.salary_max),
    summary: clean(b.summary, 400),
    description: clean(b.description, 20000) || null,
    apply_url: clean(b.apply_url, 500) || null,
  };
  if (!job.title) return { error: "Add a job title." };
  if (!job.location) return { error: "Add a location." };
  if (!CATEGORIES.includes(job.category)) return { error: "Pick a department." };
  if (!job.summary) return { error: "Add a one- or two-sentence summary." };
  if (job.apply_url && !isUrl(job.apply_url)) return { error: "The apply link should start with https://" };
  if (job.salary_min && job.salary_max && job.salary_min > job.salary_max) {
    return { error: "The salary minimum is higher than the maximum." };
  }
  return { job };
}

// Applies a subscription's state to its job. Used by the checkout return and the webhook.
// Paid jobs stay listed until 3 days past the paid-through date, covering renewal retries.
export async function syncJobFromSubscription(sub, jobId) {
  const sql = db();
  const through = periodEnd(sub);
  const live = ["active", "trialing", "past_due"].includes(sub.status);
  const status = live ? "open" : sub.status === "incomplete" ? "pending" : "closed";
  const expires = through ? new Date(through.getTime() + 3 * 864e5) : new Date();
  const rows = await sql.query(
    `UPDATE jobs SET
       stripe_subscription_id = $1,
       status                 = $2::text,
       paid_through           = $3,
       cancel_at_period_end   = $4,
       expires_at             = $5,
       posted_at              = CASE WHEN status = 'pending' AND $2::text = 'open' THEN now() ELSE posted_at END
     WHERE ${jobId ? "id = $6" : "stripe_subscription_id = $1"}
     RETURNING id, employer_id`,
    jobId
      ? [sub.id, status, through, !!sub.cancel_at_period_end, expires, jobId]
      : [sub.id, status, through, !!sub.cancel_at_period_end, expires]
  );
  return rows[0] || null;
}

// Starts a Stripe Checkout session for one job posting ($99/month price in STRIPE_PRICE_ID).
export async function createJobCheckout(req, employer, jobId) {
  if (!process.env.STRIPE_PRICE_ID) throw new Error("Billing isn't configured yet (STRIPE_PRICE_ID).");
  const base = siteUrl(req);
  const meta = { employer_id: String(employer.id), job_id: String(jobId) };
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: String(employer.id),
    ...(employer.stripe_customer_id ? { customer: employer.stripe_customer_id } : { customer_email: employer.email }),
    subscription_data: { metadata: meta, description: `Job posting #${jobId}` },
    metadata: meta,
    allow_promotion_codes: true,
    success_url: `${base}/?session_id={CHECKOUT_SESSION_ID}#welcome`,
    cancel_url: `${base}/#post`,
  });
  return session.url;
}
