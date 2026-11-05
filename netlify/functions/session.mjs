// GET /api/session?session_id=cs_...
// Called by the welcome page after Stripe Checkout. Confirms payment with Stripe and puts the plan and
// its first posting live, even if the webhook hasn't arrived yet. Only the signed-in owner of the
// checkout can confirm it, and no credentials are handed out here.
import { db, stripe, json, fail, employerFromRequest, syncJobFromSubscription } from "../lib/shared.mjs";
import { completePlanCheckout } from "../lib/billing.mjs";

export default async (req) => {
  if (req.method !== "GET") return fail("Method not allowed", 405);
  const sessionId = new URL(req.url).searchParams.get("session_id") || "";
  if (!sessionId.startsWith("cs_")) return fail("Missing checkout session.");

  let session;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  } catch {
    return fail("We couldn't find that checkout session.", 404);
  }
  if (session.status !== "complete") return fail("Checkout isn't finished yet.", 402);

  const employerId = session.metadata?.employer_id || session.client_reference_id;
  const jobId = session.metadata?.job_id;
  const sql = db();
  const me = await employerFromRequest(req);
  if (me && String(me.id) !== String(employerId)) return fail("This checkout belongs to a different account.", 403);

  const [employer] = await sql`
    UPDATE employers SET stripe_customer_id = COALESCE(stripe_customer_id, ${session.customer})
    WHERE id = ${employerId} RETURNING company, email`;
  if (!employer) return fail("We couldn't match this payment to an employer account.", 404);

  if (session.metadata?.kind === "plan") await completePlanCheckout(session);
  else if (session.subscription && jobId) await syncJobFromSubscription(session.subscription, jobId); // older per-posting checkouts
  const [job] = jobId ? await sql`SELECT id, title, status FROM jobs WHERE id = ${jobId}` : [];

  return json({ company: employer.company, email: employer.email, job: job || null, plan: session.metadata?.kind === "plan" });
};

export const config = { path: "/api/session" };
