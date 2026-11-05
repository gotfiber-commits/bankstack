// POST /api/stripe-webhook — keeps each employer's hiring plan (and its postings) in sync with Stripe.
// Events to enable in Stripe: checkout.session.completed, customer.subscription.updated,
// customer.subscription.deleted
import { db, stripe, json, fail, siteUrl, syncJobFromSubscription } from "../lib/shared.mjs";
import { completePlanCheckout, syncPlan, planSummary } from "../lib/billing.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

const money = (c) => `$${(c / 100).toFixed(2)}`;

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return fail("STRIPE_WEBHOOK_SECRET is not set", 500);

  const payload = await req.text();
  let event;
  try {
    event = stripe().webhooks.constructEvent(payload, req.headers.get("stripe-signature"), secret);
  } catch (err) {
    return fail(`Signature check failed: ${err.message}`, 400);
  }

  const obj = event.data.object;
  const sql = db();

  switch (event.type) {
    case "checkout.session.completed": {
      const employerId = obj.metadata?.employer_id || obj.client_reference_id;
      await sql`UPDATE employers SET stripe_customer_id = COALESCE(stripe_customer_id, ${obj.customer}) WHERE id = ${employerId}`;
      if (obj.metadata?.kind === "plan") {
        const emp = await completePlanCheckout(obj);
        const [row] = obj.metadata.job_id
          ? await sql`SELECT j.id, j.title, j.status FROM jobs j WHERE j.id = ${obj.metadata.job_id} AND j.employer_id = ${employerId}` : [];
        if (emp && row?.status === "open") {
          const plan = await planSummary(sql, emp);
          const base = siteUrl();
          const t = plan.tiers;
          const terms = t ? `Your plan is ${money(t.base_cents)}/month for up to ${t.base_limit} active postings and ${money(t.plus_cents)}/month for up to ${t.plus_limit}${t.extra_cents ? `, plus ${money(t.extra_cents)} for each posting over ${t.plus_limit}` : ""}. It renews monthly until you cancel it from your dashboard.` : "It renews monthly until you cancel it from your dashboard.";
          await sendEmail({
            to: emp.email,
            subject: `Your posting is live: ${row.title}`,
            text: `${row.title} is live on BankJobz.\n\n${terms}\n\nView it: ${base}/jobs/${row.id}\nDashboard: ${base}/#dashboard`,
            html: layout({
              heading: "Your posting is live",
              paragraphs: [`<b>${esc(row.title)}</b> is now listed for ${esc(emp.company)} as a Direct posting.`, esc(terms),
                "Applications arrive by email and in your dashboard. Sign in from any device with your email and password via <i>Employer sign in</i>."],
              button: { label: "Open your dashboard", url: `${base}/#dashboard` },
            }),
          });
        }
      } else if (obj.subscription && obj.metadata?.job_id) {
        // An older per-posting checkout.
        await syncJobFromSubscription(await stripe().subscriptions.retrieve(obj.subscription), obj.metadata.job_id);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (obj.metadata?.kind === "plan") {
        await syncPlan(obj, null);
        break;
      }
      // Older per-posting subscriptions: linked by subscription id, or the job id stored on it.
      const synced = await syncJobFromSubscription(obj);
      if (!synced && obj.metadata?.job_id) await syncJobFromSubscription(obj, obj.metadata.job_id);
      break;
    }
  }
  return json({ received: true });
};

export const config = { path: "/api/stripe-webhook" };
