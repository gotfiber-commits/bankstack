// Plan billing: one Stripe subscription per institution, priced by how many postings are active.
//
//   1–5 active postings    $99.00 / month
//   6–10                   $159.99 / month
//   11 and up              $159.99 + a set amount for each posting over 10
//
// It's one Stripe price with graduated tiers (flat $99 for the first 5, a flat $60.99 more once a
// 6th is active, then per posting past 10), and the subscription's quantity is the number of active
// postings (at least 1). The amounts are read from Stripe, so the site always shows what Stripe charges.
//
// Rules (so nobody is charged twice or surprised):
//   - Moving up a tier is charged right away, prorated for the rest of the month, after the
//     employer confirms. If the card is declined, nothing changes and the posting stays unpublished.
//   - Closing postings never refunds part of a month; the lower price starts at the next bill.
//   - plan_paid_quantity remembers the most postings already paid for this month, so closing and
//     reopening (or replacing) postings within the month costs nothing extra.
//   - Every change runs under a per-employer lock, so two tabs can't double-charge or miscount.
import { db, stripe, periodEnd, siteUrl } from "./shared.mjs";

export const PLAN_LOOKUP_KEY = "bankjobz_hiring_plan";
const LIVE = ["active", "trialing", "past_due"];
const GRACE_DAYS = 3; // postings stay up this long past the paid-through date while a renewal retries

export class BillingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------- the price ----------
let cache = { at: 0, price: undefined };

export async function planPrice({ fresh = false } = {}) {
  if (!fresh && cache.price !== undefined && Date.now() - cache.at < 10 * 60 * 1000) return cache.price;
  let price = null;
  if (process.env.STRIPE_PLAN_PRICE_ID) {
    price = await stripe().prices.retrieve(process.env.STRIPE_PLAN_PRICE_ID, { expand: ["tiers"] });
  } else {
    const list = await stripe().prices.list({ lookup_keys: [PLAN_LOOKUP_KEY], active: true, expand: ["data.tiers"], limit: 1 });
    price = list.data[0] || null;
  }
  cache = { at: Date.now(), price };
  return price;
}

// What `quantity` active postings cost per month, in cents, under a graduated price.
export function monthlyCents(price, quantity) {
  let total = 0, below = 0;
  for (const t of price.tiers) {
    const top = t.up_to == null || t.up_to === "inf" ? Infinity : Number(t.up_to);
    const units = Math.max(0, Math.min(quantity, top) - below);
    if (units > 0) total += Number(t.flat_amount || 0) + Number(t.unit_amount || 0) * units;
    below = top;
    if (quantity <= top) break;
  }
  return total;
}

// The plan as the site shows it.
export function describePrice(price) {
  if (!price?.tiers?.length) return null;
  const tiers = price.tiers;
  const baseLimit = Number(tiers[0].up_to);
  const plusLimit = Number(tiers[1]?.up_to) || null;
  return {
    price_id: price.id,
    base_limit: baseLimit,
    base_cents: monthlyCents(price, 1),
    plus_limit: plusLimit,
    plus_cents: plusLimit ? monthlyCents(price, baseLimit + 1) : null,
    extra_cents: plusLimit ? Number(tiers[2]?.unit_amount || 0) : null,
  };
}

// Creates the plan price in Stripe (admin console). Re-running it with a new per-posting amount makes
// a new price that new plans use; the lookup key moves to it.
export async function createPlanPrice(extraCents) {
  const extra = Math.round(Number(extraCents));
  if (!Number.isFinite(extra) || extra < 100 || extra > 100000) throw new BillingError("Enter a per-posting amount between $1 and $1,000.");
  const price = await stripe().prices.create({
    currency: "usd",
    nickname: `Hiring plan: $99 up to 5, $159.99 up to 10, +$${(extra / 100).toFixed(2)} each over 10`,
    product_data: { name: "BankJobz hiring plan" },
    recurring: { interval: "month" },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 5, flat_amount: 9900, unit_amount: 0 },
      { up_to: 10, flat_amount: 6099, unit_amount: 0 },
      { up_to: "inf", flat_amount: 0, unit_amount: extra },
    ],
    lookup_key: PLAN_LOOKUP_KEY,
    transfer_lookup_key: true,
    expand: ["tiers"],
  });
  cache = { at: Date.now(), price };
  return price;
}

// ---------- the employer's plan ----------
export const planLive = (e) => !!e?.plan_subscription_id && LIVE.includes(e.plan_status)
  && (!e.plan_paid_through || new Date(e.plan_paid_through).getTime() + GRACE_DAYS * 864e5 > Date.now());

// Postings that count toward the plan (old per-posting subscriptions don't).
export async function activePostings(sql, employerId) {
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM jobs
    WHERE employer_id = ${employerId} AND status = 'open' AND stripe_subscription_id IS NULL`;
  return n;
}

async function withBillingLock(sql, employerId, fn) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const got = await sql`UPDATE employers SET billing_lock_at = now()
      WHERE id = ${employerId} AND (billing_lock_at IS NULL OR billing_lock_at < now() - interval '60 seconds') RETURNING id`;
    if (got.length) break;
    if (Date.now() > deadline) throw new BillingError("Your plan is being updated in another window. Try again in a moment.", 409);
    await new Promise((r) => setTimeout(r, 150));
  }
  try { return await fn(); }
  finally { await sql`UPDATE employers SET billing_lock_at = NULL WHERE id = ${employerId}`; }
}

const setQuantity = (e, quantity, extra) => stripe().subscriptions.update(e.plan_subscription_id, {
  items: [{ id: e.plan_item_id, quantity }], ...extra,
});

// Applies a plan subscription from Stripe to the employer and their postings. Used by the webhook,
// the checkout return and the daily reconcile.
export async function syncPlan(sub, employerId = null) {
  const sql = db();
  const [emp] = employerId
    ? await sql`SELECT * FROM employers WHERE id = ${employerId}`
    : await sql`SELECT * FROM employers WHERE plan_subscription_id = ${sub.id}`;
  if (!emp) return null;
  // An old plan's late events never overwrite a newer plan.
  if (emp.plan_subscription_id && emp.plan_subscription_id !== sub.id && planLive(emp) && !LIVE.includes(sub.status)) return emp;

  const item = sub.items?.data?.[0];
  const quantity = Number(item?.quantity || 1);
  const startTs = sub.current_period_start ?? item?.current_period_start;
  const start = startTs ? new Date(startTs * 1000) : null;
  const through = periodEnd(sub);
  const newPeriod = emp.plan_subscription_id !== sub.id || !emp.plan_period_start || !start
    || new Date(emp.plan_period_start).getTime() !== start.getTime();
  const paid = newPeriod ? quantity : Math.max(Number(emp.plan_paid_quantity || 0), quantity);

  const [updated] = await sql`
    UPDATE employers SET plan_subscription_id = ${sub.id}, plan_item_id = ${item?.id || null}, plan_status = ${sub.status},
      plan_quantity = ${quantity}, plan_paid_quantity = ${paid}, plan_period_start = ${start},
      plan_paid_through = ${through}, plan_cancel_at_period_end = ${!!sub.cancel_at_period_end},
      stripe_customer_id = COALESCE(stripe_customer_id, ${sub.customer || null})
    WHERE id = ${emp.id} RETURNING *`;

  if (planLive(updated)) {
    const expires = through ? new Date(through.getTime() + GRACE_DAYS * 864e5) : null;
    await sql`UPDATE jobs SET paid_through = ${through}, expires_at = COALESCE(${expires}, expires_at),
                cancel_at_period_end = ${!!sub.cancel_at_period_end}, updated_at = now()
              WHERE employer_id = ${emp.id} AND status = 'open' AND stripe_subscription_id IS NULL`;
  } else {
    await sql`UPDATE jobs SET status = 'closed', closed_by = 'plan', updated_at = now()
              WHERE employer_id = ${emp.id} AND status = 'open' AND stripe_subscription_id IS NULL`;
  }
  return updated;
}

// Puts postings live under the plan. Returns one of:
//   { ok: true, opened, monthly_cents, upgraded }
//   { needs_checkout: true }                     no live plan yet: send them to Stripe Checkout
//   { needs_confirm: true, count, from_cents, to_cents }   this would move the plan up a tier
// Throws BillingError when the upgrade charge fails.
export async function publishPostings(employerId, jobIds, { confirm = false } = {}) {
  const sql = db();
  return withBillingLock(sql, employerId, async () => {
    const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
    const jobs = await sql`SELECT id FROM jobs WHERE employer_id = ${employerId} AND id = ANY(${jobIds.map(Number)})
      AND stripe_subscription_id IS NULL
      AND (status = 'pending' OR (status = 'closed' AND COALESCE(closed_by, 'employer') <> 'admin'))`;
    if (!jobs.length) return { ok: true, opened: [], monthly_cents: null, upgraded: false };
    if (!planLive(e)) return { needs_checkout: true };

    const price = await planPrice();
    if (!price) throw new BillingError("Billing isn't set up yet. Please try again later.", 503);
    const active = await activePostings(sql, employerId);
    const want = active + jobs.length;
    const current = Number(e.plan_quantity || 1);
    let paid = Math.max(Number(e.plan_paid_quantity || 0), current);
    const paidCents = monthlyCents(price, paid), wantCents = monthlyCents(price, want);
    const upgrade = want > paid && wantCents > paidCents;
    if (upgrade && !confirm) return { needs_confirm: true, count: want, from_cents: paidCents, to_cents: wantCents };

    if (upgrade) {
      // Charge only the difference between what's already paid this month and the new tier.
      if (current !== paid) await setQuantity(e, paid, { proration_behavior: "none" });
      try {
        await setQuantity(e, want, { proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete" });
      } catch (err) {
        if (current !== paid) await setQuantity(e, current, { proration_behavior: "none" }).catch(() => {});
        throw new BillingError(`Your card wasn't charged for the larger plan${err?.message ? ` (${err.message.replace(/\.$/, "")})` : ""}. Update your card under Cards & invoices, then try again.`, 402);
      }
      paid = want;
    } else if (want !== current) {
      await setQuantity(e, want, { proration_behavior: "none" });
      paid = Math.max(paid, want);
    }

    await sql`UPDATE employers SET plan_quantity = ${want}, plan_paid_quantity = ${paid} WHERE id = ${employerId}`;
    const through = e.plan_paid_through ? new Date(e.plan_paid_through) : null;
    const expires = through ? new Date(through.getTime() + GRACE_DAYS * 864e5) : new Date(Date.now() + 33 * 864e5);
    const opened = await sql`
      UPDATE jobs SET status = 'open', closed_by = NULL, paid_through = ${through}, expires_at = ${expires},
        cancel_at_period_end = ${!!e.plan_cancel_at_period_end},
        posted_at = CASE WHEN status = 'pending' THEN now() ELSE posted_at END, updated_at = now()
      WHERE id = ANY(${jobs.map((j) => j.id)}) RETURNING id`;
    return { ok: true, opened: opened.map((j) => j.id), monthly_cents: wantCents, upgraded: upgrade };
  });
}

// Takes postings down. The plan's next bill drops to match; this month isn't refunded.
export async function closePostings(employerId, jobIds, closedBy = "employer") {
  const sql = db();
  return withBillingLock(sql, employerId, async () => {
    const closed = await sql`UPDATE jobs SET status = 'closed', closed_by = ${closedBy}, updated_at = now()
      WHERE employer_id = ${employerId} AND id = ANY(${jobIds.map(Number)}) AND status IN ('open', 'pending')
        AND stripe_subscription_id IS NULL RETURNING id`;
    const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
    const want = Math.max(1, await activePostings(sql, employerId));
    if (planLive(e) && want < Number(e.plan_quantity || 1)) {
      await setQuantity(e, want, { proration_behavior: "none" });
      await sql`UPDATE employers SET plan_quantity = ${want} WHERE id = ${employerId}`;
    }
    return { closed: closed.map((j) => j.id) };
  });
}

// Stop at the end of this month / keep going.
export async function setPlanCancel(employerId, cancel) {
  const sql = db();
  const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
  if (!e?.plan_subscription_id || !planLive(e)) throw new BillingError("You don't have an active plan.", 404);
  const sub = await stripe().subscriptions.update(e.plan_subscription_id, { cancel_at_period_end: !!cancel });
  return syncPlan(sub, employerId);
}

// The plan summary for the dashboard.
export async function planSummary(sql, e) {
  const price = await planPrice().catch(() => null);
  const desc = describePrice(price);
  const active = await activePostings(sql, e.id);
  const live = planLive(e);
  return {
    configured: !!desc,
    live,
    status: e.plan_status || null,
    active_postings: active,
    paid_postings: live ? Math.max(Number(e.plan_paid_quantity || 0), Number(e.plan_quantity || 1)) : 0,
    paid_through: e.plan_paid_through,
    cancel_at_period_end: !!e.plan_cancel_at_period_end,
    this_month_cents: live && desc ? monthlyCents(price, Math.max(Number(e.plan_paid_quantity || 0), Number(e.plan_quantity || 1))) : 0,
    next_bill_cents: live && desc && !e.plan_cancel_at_period_end ? monthlyCents(price, Math.max(1, active)) : 0,
    tiers: desc,
  };
}

// Daily: re-read any plan whose paid-through date has passed, in case a webhook was missed.
export async function reconcilePlans() {
  const sql = db();
  const due = await sql`SELECT id, plan_subscription_id FROM employers
    WHERE plan_subscription_id IS NOT NULL AND plan_status = ANY(${LIVE}) AND plan_paid_through < now()`;
  let synced = 0;
  for (const e of due) {
    try { await syncPlan(await stripe().subscriptions.retrieve(e.plan_subscription_id), e.id); synced++; }
    catch (err) { console.error("reconcile plan", e.id, err.message); }
  }
  return synced;
}

// Stripe Checkout for a new plan (the first posting, or after a plan has ended).
export async function createPlanCheckout(employer, jobId) {
  const price = await planPrice();
  if (!price) throw new BillingError("Billing isn't set up yet. Please try again later.", 503);
  const base = siteUrl();
  const meta = { employer_id: String(employer.id), job_id: String(jobId), kind: "plan" };
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: String(employer.id),
    ...(employer.stripe_customer_id ? { customer: employer.stripe_customer_id } : { customer_email: employer.email }),
    subscription_data: { metadata: { employer_id: String(employer.id), kind: "plan" }, description: `BankJobz hiring plan: ${employer.company}` },
    metadata: meta,
    allow_promotion_codes: true,
    success_url: `${base}/?session_id={CHECKOUT_SESSION_ID}#welcome`,
    cancel_url: `${base}/#dashboard`,
  });
  return session.url;
}

// After Checkout (webhook or the return page, whichever is first): record the plan, publish the posting.
export async function completePlanCheckout(session) {
  const employerId = session.metadata?.employer_id || session.client_reference_id;
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!employerId || !subId) return null;
  const sub = typeof session.subscription === "object" && session.subscription ? session.subscription : await stripe().subscriptions.retrieve(subId);
  const emp = await syncPlan(sub, employerId);
  if (planLive(emp) && session.metadata?.job_id) await publishPostings(emp.id, [session.metadata.job_id], { confirm: true });
  return emp;
}
