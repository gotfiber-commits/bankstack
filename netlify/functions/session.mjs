// GET /api/session?session_id=cs_...
// Called by the welcome page after Stripe Checkout. Confirms payment with Stripe, puts the job live
// and returns the employer's posting key. Works even if the webhook hasn't arrived yet.
import { db, stripe, json, fail, newToken, syncJobFromSubscription } from "../lib/shared.mjs";

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

  const [employer] = await sql`
    UPDATE employers SET
      stripe_customer_id = COALESCE(stripe_customer_id, ${session.customer}),
      api_token          = COALESCE(api_token, ${newToken()})
    WHERE id = ${employerId}
    RETURNING company, email, api_token`;
  if (!employer) return fail("We couldn't match this payment to an employer account.", 404);

  if (session.subscription && jobId) await syncJobFromSubscription(session.subscription, jobId);
  const [job] = jobId ? await sql`SELECT id, title, status FROM jobs WHERE id = ${jobId}` : [];

  return json({ company: employer.company, email: employer.email, token: employer.api_token, job: job || null });
};

export const config = { path: "/api/session" };
