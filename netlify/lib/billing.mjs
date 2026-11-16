// Plan billing: one Stripe subscription per institution, priced by how many postings are active.
//
//   1–5 active postings    $99.00 / month     ($990 / year: two months free)
//   6–10                   $159.99 / month    ($1,599.90 / year)
//   11 and up              $159.99 + a set amount for each posting over 10 (×10 on the yearly price)
//
// A plan is paid by card (Stripe Checkout, charged automatically) or by invoice (Stripe emails an
// invoice payable by ACH, wire, card or check, due in INVOICE_DAYS_DUE days, 30 by default; an invoice
// still unpaid after its due date takes the postings down). A bank that claims its listings gets a free
// trial (CLAIM_TRIAL_DAYS, 30 by default) with no card; it ends on its own unless they add a card or
// switch to invoice billing.
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
export const PLAN_ANNUAL_LOOKUP_KEY = "bankjobz_hiring_plan_annual";
const LIVE = ["active", "trialing", "past_due"];
export const trialDays = () => Math.max(1, Math.min(90, Math.round(Number(process.env.CLAIM_TRIAL_DAYS)) || 30));
export const invoiceDays = () => Math.max(1, Math.min(90, Math.round(Number(process.env.INVOICE_DAYS_DUE)) || 30));
const GRACE_DAYS = 3; // postings stay up this long past the paid-through date while a renewal retries

export class BillingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------- the price ----------
const TEN_MIN = 10 * 60 * 1000;
let cache = {}; // interval → { at, price }
const byId = new Map(); // price id → { at, price }

// The current plan price for new plans: monthly (default) or yearly.
export async function planPrice({ fresh = false, interval = "month" } = {}) {
  const yearly = interval === "year";
  const hit = cache[yearly ? "year" : "month"];
  if (!fresh && hit && Date.now() - hit.at < TEN_MIN) return hit.price;
  let price = null;
  const pinned = yearly ? process.env.STRIPE_PLAN_ANNUAL_PRICE_ID : process.env.STRIPE_PLAN_PRICE_ID;
  if (pinned) {
    price = await stripe().prices.retrieve(pinned, { expand: ["tiers"] });
  } else {
    const list = await stripe().prices.list({ lookup_keys: [yearly ? PLAN_ANNUAL_LOOKUP_KEY : PLAN_LOOKUP_KEY], active: true, expand: ["data.tiers"], limit: 1 });
    price = list.data[0] || null;
  }
  cache[yearly ? "year" : "month"] = { at: Date.now(), price };
  if (price) byId.set(price.id, { at: Date.now(), price });
  return price;
}

// The price an employer's plan is actually on (it keeps its price if a newer one is created later).
export async function priceFor(e) {
  const id = e?.plan_price_id;
  if (id) {
    const hit = byId.get(id);
    if (hit && Date.now() - hit.at < TEN_MIN) return hit.price;
    try {
      const price = await stripe().prices.retrieve(id, { expand: ["tiers"] });
      if (price?.tiers?.length) { byId.set(id, { at: Date.now(), price }); return price; }
    } catch { /* fall back to the current price for its interval */ }
  }
  return planPrice({ interval: e?.plan_interval === "year" ? "year" : "month" });
}

// What `quantity` active postings cost per billing period (month or year), in cents, under a graduated price.
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
    interval: price.recurring?.interval === "year" ? "year" : "month",
    base_limit: baseLimit,
    base_cents: monthlyCents(price, 1),
    plus_limit: plusLimit,
    plus_cents: plusLimit ? monthlyCents(price, baseLimit + 1) : null,
    extra_cents: plusLimit ? Number(tiers[2]?.unit_amount || 0) : null,
  };
}

// Creates the plan prices in Stripe (admin console): monthly, and yearly at ten months' price (two
// months free). Re-running it with a new per-posting amount makes new prices that new plans use; the
// lookup keys move to them, and existing plans stay on the price they started with.
export async function createPlanPrice(extraCents) {
  const extra = Math.round(Number(extraCents));
  if (!Number.isFinite(extra) || extra < 100 || extra > 100000) throw new BillingError("Enter a per-posting amount between $1 and $1,000.");
  const monthly = await stripe().prices.create({
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
  const yearly = await stripe().prices.create({
    currency: "usd",
    nickname: `Hiring plan, yearly: $990 up to 5, $1,599.90 up to 10, +$${(extra * 10 / 100).toFixed(2)} each over 10`,
    product: typeof monthly.product === "string" ? monthly.product : monthly.product?.id,
    recurring: { interval: "year" },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 5, flat_amount: 99000, unit_amount: 0 },
      { up_to: 10, flat_amount: 60990, unit_amount: 0 },
      { up_to: "inf", flat_amount: 0, unit_amount: extra * 10 },
    ],
    lookup_key: PLAN_ANNUAL_LOOKUP_KEY,
    transfer_lookup_key: true,
    expand: ["tiers"],
  });
  cache = { month: { at: Date.now(), price: monthly }, year: { at: Date.now(), price: yearly } };
  for (const p of [monthly, yearly]) byId.set(p.id, { at: Date.now(), price: p });
  return { monthly, yearly };
}

// ---------- the employer's plan ----------
// Live: an active, trialing or retrying plan inside its paid period (plus a few days' grace for a card
// renewal that's retrying). An invoice plan whose invoice has gone past due is not live.
export const planLive = (e) => !!e?.plan_subscription_id && LIVE.includes(e.plan_status)
  && !(e.plan_collection === "send_invoice" && e.plan_status === "past_due")
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

  const price = item?.price || null;
  const interval = price?.recurring?.interval === "year" ? "year" : "month";
  const collection = sub.collection_method === "send_invoice" ? "send_invoice" : "charge_automatically";
  const trialEnd = sub.status === "trialing" && sub.trial_end ? new Date(sub.trial_end * 1000) : null;
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;

  const [updated] = await sql`
    UPDATE employers SET plan_subscription_id = ${sub.id}, plan_item_id = ${item?.id || null}, plan_status = ${sub.status},
      plan_quantity = ${quantity}, plan_paid_quantity = ${paid}, plan_period_start = ${start},
      plan_paid_through = ${through}, plan_cancel_at_period_end = ${!!sub.cancel_at_period_end},
      plan_price_id = ${price?.id || null}, plan_interval = ${interval}, plan_collection = ${collection},
      plan_trial_end = ${trialEnd},
      stripe_customer_id = COALESCE(stripe_customer_id, ${customer})
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
//   { ok: true, opened, monthly_cents, upgraded, interval }
//   { needs_checkout: true }                     no live plan yet: start one (Checkout, invoice or trial)
//   { needs_confirm: true, count, from_cents, to_cents, interval, trialing, invoice }
//                                                this would move the plan up a tier
// Throws BillingError when the upgrade charge fails.
// (monthly_cents / from_cents / to_cents are per billing period: per year on a yearly plan.)
export async function publishPostings(employerId, jobIds, { confirm = false } = {}) {
  const sql = db();
  return withBillingLock(sql, employerId, async () => {
    const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
    const jobs = await sql`SELECT id FROM jobs WHERE employer_id = ${employerId} AND id = ANY(${jobIds.map(Number)})
      AND stripe_subscription_id IS NULL
      AND (status = 'pending' OR (status = 'closed' AND COALESCE(closed_by, 'employer') <> 'admin'))`;
    if (!jobs.length) return { ok: true, opened: [], monthly_cents: null, upgraded: false };
    if (!planLive(e)) return { needs_checkout: true };

    const price = await priceFor(e);
    if (!price) throw new BillingError("Billing isn't set up yet. Please try again later.", 503);
    const interval = e.plan_interval === "year" ? "year" : "month";
    const trialing = e.plan_status === "trialing";
    const invoice = e.plan_collection === "send_invoice";
    const active = await activePostings(sql, employerId);
    const want = active + jobs.length;
    const current = Number(e.plan_quantity || 1);
    let paid = Math.max(Number(e.plan_paid_quantity || 0), current);
    const paidCents = monthlyCents(price, paid), wantCents = monthlyCents(price, want);
    const upgrade = want > paid && wantCents > paidCents;
    if (upgrade && !confirm) return { needs_confirm: true, count: want, from_cents: paidCents, to_cents: wantCents, interval, trialing, invoice };

    if (upgrade && trialing) {
      // Nothing is charged during a free trial; the larger plan applies when it ends.
      await setQuantity(e, want, { proration_behavior: "none" });
      paid = want;
    } else if (upgrade) {
      // Charge (or invoice) only the difference between what's already paid this period and the new tier.
      if (current !== paid) await setQuantity(e, paid, { proration_behavior: "none" });
      try {
        await setQuantity(e, want, invoice
          ? { proration_behavior: "always_invoice" }
          : { proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete" });
      } catch (err) {
        if (current !== paid) await setQuantity(e, current, { proration_behavior: "none" }).catch(() => {});
        throw new BillingError(invoice
          ? `We couldn't update your plan${err?.message ? ` (${err.message.replace(/\.$/, "")})` : ""}. Nothing was invoiced; try again in a moment.`
          : `Your card wasn't charged for the larger plan${err?.message ? ` (${err.message.replace(/\.$/, "")})` : ""}. Update your card under Cards & invoices, then try again.`, 402);
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
    return { ok: true, opened: opened.map((j) => j.id), monthly_cents: wantCents, upgraded: upgrade && !trialing, interval, trialing, invoice };
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

// The plan summary for the dashboard. *_cents figures are per billing period (interval).
export async function planSummary(sql, e) {
  const live = planLive(e);
  const price = await (live ? priceFor(e) : planPrice()).catch(() => null);
  const yearly = await planPrice({ interval: "year" }).catch(() => null);
  const desc = describePrice(price);
  const active = await activePostings(sql, e.id);
  const paidQty = Math.max(Number(e.plan_paid_quantity || 0), Number(e.plan_quantity || 1));
  const trialing = live && e.plan_status === "trialing";
  return {
    configured: !!desc,
    live,
    status: e.plan_status || null,
    interval: live && e.plan_interval === "year" ? "year" : "month",
    collection: live && e.plan_collection === "send_invoice" ? "invoice" : "card",
    trialing,
    trial_end: trialing ? e.plan_trial_end || e.plan_paid_through : null,
    trial_available: !live && !e.trial_used_at && !!e.institution_id,
    trial_days: trialDays(),
    active_postings: active,
    paid_postings: live ? paidQty : 0,
    paid_through: e.plan_paid_through,
    cancel_at_period_end: !!e.plan_cancel_at_period_end,
    this_month_cents: live && desc && !trialing ? monthlyCents(price, paidQty) : 0,
    next_bill_cents: live && desc && !e.plan_cancel_at_period_end ? monthlyCents(price, Math.max(1, active)) : 0,
    tiers: desc,
    yearly: describePrice(yearly),
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

// Stripe Checkout for a new card-paid plan (the first posting, or after a plan has ended).
export async function createPlanCheckout(employer, jobId, { interval = "month" } = {}) {
  const yearly = interval === "year";
  const price = await planPrice({ interval: yearly ? "year" : "month" });
  if (!price) throw new BillingError(yearly ? "Yearly billing isn't set up yet. Choose monthly, or try again later." : "Billing isn't set up yet. Please try again later.", 503);
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

// The employer's Stripe customer, created on first use. For invoice billing, the billing email (often
// accounts payable) is where Stripe sends invoices, and a PO number prints on every invoice.
async function ensureCustomer(sql, e, { billingEmail = null, poNumber = null } = {}) {
  const extras = {
    ...(billingEmail ? { email: billingEmail } : {}),
    ...(poNumber !== null ? { invoice_settings: { custom_fields: poNumber ? [{ name: "PO number", value: poNumber }] : "" } } : {}),
  };
  if (e.stripe_customer_id) {
    if (Object.keys(extras).length) await stripe().customers.update(e.stripe_customer_id, extras);
    return e.stripe_customer_id;
  }
  const c = await stripe().customers.create({
    email: billingEmail || e.email, name: e.company, metadata: { employer_id: String(e.id) },
    ...(poNumber ? { invoice_settings: { custom_fields: [{ name: "PO number", value: poNumber }] } } : {}),
  });
  await sql`UPDATE employers SET stripe_customer_id = ${c.id} WHERE id = ${e.id} AND stripe_customer_id IS NULL`;
  const [{ stripe_customer_id }] = await sql`SELECT stripe_customer_id FROM employers WHERE id = ${e.id}`;
  return stripe_customer_id;
}

// Starts a plan without Checkout: pay-by-invoice, or a free trial (claimed listings). quantity is how
// many postings it starts with. Returns the employer row after syncing.
export async function startPlan(employerId, { interval = "month", invoice = false, trial = false, quantity = 1,
  billingEmail = null, poNumber = null } = {}) {
  const sql = db();
  return withBillingLock(sql, employerId, async () => {
    const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
    if (planLive(e)) throw new BillingError("You already have an active plan.", 409);
    if (trial && e.trial_used_at) throw new BillingError("Your free trial has already been used.", 409);
    const yearly = interval === "year";
    const price = await planPrice({ interval: yearly ? "year" : "month" });
    if (!price) throw new BillingError(yearly ? "Yearly billing isn't set up yet. Choose monthly, or try again later." : "Billing isn't set up yet. Please try again later.", 503);
    const customer = await ensureCustomer(sql, e, invoice ? { billingEmail, poNumber: poNumber ?? "" } : {});
    const sub = await stripe().subscriptions.create({
      customer,
      items: [{ price: price.id, quantity: Math.max(1, Math.round(quantity) || 1) }],
      metadata: { employer_id: String(e.id), kind: "plan" },
      description: `BankJobz hiring plan: ${e.company}`,
      ...(invoice ? { collection_method: "send_invoice", days_until_due: invoiceDays() } : {}),
      ...(trial ? {
        trial_period_days: trialDays(),
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        payment_settings: { save_default_payment_method: "on_subscription" },
      } : {}),
    });
    if (trial) await sql`UPDATE employers SET trial_used_at = now() WHERE id = ${e.id}`;
    // syncPlan takes the lock-free path: it only writes the employer's plan columns.
    return syncPlan(sub, e.id);
  });
}

// Changes how a live plan is billed: monthly → yearly, and card ↔ invoice.
// Moving to yearly mid-month charges (or invoices) the year now, less credit for the unused part of the
// month; during a trial nothing is charged until the trial ends. Yearly → monthly happens at renewal,
// so it isn't offered here.
export async function setPlanBilling(employerId, { interval = null, collection = null, billingEmail = null, poNumber = null } = {}) {
  const sql = db();
  return withBillingLock(sql, employerId, async () => {
    const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
    if (!planLive(e)) throw new BillingError("You don't have an active plan.", 404);
    const update = {};
    const toInvoice = collection === "invoice" || collection === "send_invoice";
    const toCard = collection === "card" || collection === "charge_automatically";
    if (toInvoice) {
      await ensureCustomer(sql, e, { billingEmail, poNumber: poNumber ?? "" });
      if (e.plan_collection !== "send_invoice") Object.assign(update, { collection_method: "send_invoice", days_until_due: invoiceDays() });
    } else if (toCard && e.plan_collection === "send_invoice") {
      update.collection_method = "charge_automatically";
    }
    if (interval === "month" && e.plan_interval === "year") {
      throw new BillingError("A yearly plan can switch to monthly when it renews. Contact us and we'll set that up.");
    }
    if (interval === "year" && e.plan_interval !== "year") {
      const price = await planPrice({ interval: "year" });
      if (!price) throw new BillingError("Yearly billing isn't set up yet.", 503);
      const trialing = e.plan_status === "trialing";
      const invoiced = (update.collection_method || e.plan_collection) === "send_invoice";
      Object.assign(update, {
        items: [{ id: e.plan_item_id, price: price.id, quantity: Math.max(1, Number(e.plan_quantity || 1)) }],
        proration_behavior: trialing ? "none" : "always_invoice",
        ...(!trialing && !invoiced ? { payment_behavior: "error_if_incomplete" } : {}),
      });
    }
    if (!Object.keys(update).length) return e;
    let sub;
    try { sub = await stripe().subscriptions.update(e.plan_subscription_id, update); }
    catch (err) {
      throw new BillingError(`Your plan wasn't changed${err?.message ? ` (${err.message.replace(/\.$/, "")})` : ""}. ${update.payment_behavior ? "Update your card under Cards & invoices, then try again." : "Try again in a moment."}`, 402);
    }
    return syncPlan(sub, e.id);
  });
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

// Daily: a few days before a free trial ends, tell the employer what happens next (once per trial).
export async function remindTrials() {
  const sql = db();
  const due = await sql`SELECT * FROM employers
    WHERE plan_status = 'trialing' AND plan_trial_end IS NOT NULL AND trial_reminded_at IS NULL
      AND NOT plan_cancel_at_period_end AND plan_trial_end < now() + interval '4 days' AND plan_trial_end > now()`;
  const { sendEmail, layout, esc } = await import("./email.mjs");
  const base = siteUrl();
  let sent = 0;
  for (const e of due) {
    const price = await priceFor(e).catch(() => null);
    const active = await activePostings(sql, e.id);
    const per = e.plan_interval === "year" ? "year" : "month";
    const cost = price ? `$${(monthlyCents(price, Math.max(1, active)) / 100).toFixed(2).replace(/\.00$/, "")}/${per}` : null;
    const when = new Date(e.plan_trial_end).toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const invoiced = e.plan_collection === "send_invoice";
    const next = invoiced
      ? `After that, Stripe will email an invoice${cost ? ` for ${cost}` : ""} to your billing contact, and your ${active} posting${active === 1 ? " stays" : "s stay"} live.`
      : `To keep your ${active} posting${active === 1 ? "" : "s"} live after that${cost ? ` (${cost})` : ""}, add a card under Cards & invoices in your dashboard, or switch to invoice billing. If you've already added a card, there's nothing to do. Without one, the trial simply ends and your postings come down; you won't be charged.`;
    await sendEmail({
      to: e.email,
      subject: `Your BankJobz free trial ends ${when}`,
      text: `Your free trial ends ${when}. ${next}\n\nDashboard: ${base}/#dashboard`,
      html: layout({ heading: `Your free trial ends ${esc(when)}`, paragraphs: [esc(next)],
        button: { label: "Open your dashboard", url: `${base}/#dashboard` } }),
    });
    await sql`UPDATE employers SET trial_reminded_at = now() WHERE id = ${e.id}`;
    sent++;
  }
  return sent;
}
