// POST /api/stripe-webhook — keeps each job posting in sync with its Stripe subscription.
// Events to enable in Stripe: checkout.session.completed, customer.subscription.updated,
// customer.subscription.deleted
import { db, stripe, json, fail, newToken, siteUrl, syncJobFromSubscription } from "../lib/shared.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

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

  switch (event.type) {
    case "checkout.session.completed": {
      const employerId = obj.metadata?.employer_id || obj.client_reference_id;
      await db()`
        UPDATE employers SET
          stripe_customer_id = COALESCE(stripe_customer_id, ${obj.customer}),
          api_token          = COALESCE(api_token, ${newToken()})
        WHERE id = ${employerId}`;
      if (obj.subscription && obj.metadata?.job_id) {
        const sub = await stripe().subscriptions.retrieve(obj.subscription);
        await syncJobFromSubscription(sub, obj.metadata.job_id);
        const [row] = await db()`
          SELECT j.id, j.title, j.status, e.email, e.company FROM jobs j JOIN employers e ON e.id = j.employer_id
          WHERE j.id = ${obj.metadata.job_id}`;
        if (row?.status === "open") {
          const base = siteUrl(req);
          await sendEmail({
            to: row.email,
            subject: `Your posting is live: ${row.title}`,
            text: `${row.title} is live on BankStack and renews monthly at $99 until you cancel it.\n\nView it: ${base}/jobs/${row.id}\nDashboard: ${base}/#dashboard\n\nLost your posting key? Use "Email me a sign-in link" on ${base}/#post`,
            html: layout({
              heading: "Your posting is live",
              paragraphs: [`<b>${esc(row.title)}</b> is now listed for ${esc(row.company)} as a Direct posting.`,
                "It renews monthly at $99 until you cancel it from your dashboard. Applications arrive by email and in the dashboard.",
                `Signing in on another device? Use <i>Email me a sign-in link</i> on the Post a job page.`],
              button: { label: "Open your dashboard", url: `${base}/#dashboard` },
            }),
          });
        }
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // Linked by subscription id; fall back to the job id stored on the subscription.
      const synced = await syncJobFromSubscription(obj);
      if (!synced && obj.metadata?.job_id) await syncJobFromSubscription(obj, obj.metadata.job_id);
      break;
    }
  }
  return json({ received: true });
};

export const config = { path: "/api/stripe-webhook" };
