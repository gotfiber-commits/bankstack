// Claim your listings.
// GET  /api/claim/:slug   → { institution, jobs, trial_days, claimed, claimed_by_you, your_claim, instant }
//                           (public; with an employer session it also says whether their claim is instant)
// POST /api/claim/:slug   → { job_ids?: [...] } (employer session required; empty = every open listing)
//                           → { status: 'approved', converted, live, trial_end, needs_confirm?, needs_plan? }
//                           | { status: 'pending' }   (waiting for the site owner to confirm)
import { json, fail, employerFromRequest } from "../lib/shared.mjs";
import { claimInfo, submitClaim } from "../lib/claims.mjs";
import { BillingError } from "../lib/billing.mjs";

export default async (req, context) => {
  const slug = String(context.params?.slug || "").toLowerCase();
  const viewer = await employerFromRequest(req);

  if (req.method === "GET") {
    const info = await claimInfo(slug, viewer);
    return info ? json(info) : fail("We couldn't find that institution.", 404);
  }
  if (req.method !== "POST") return fail("Method not allowed", 405);
  if (!viewer) return fail("Create your employer account, or sign in, to claim these listings.", 401);
  let b = {};
  try { b = await req.json(); } catch { /* no body: claim them all */ }
  try {
    return json(await submitClaim(viewer, slug, b.job_ids));
  } catch (err) {
    return fail(err.message, err instanceof BillingError ? err.status : 502);
  }
};

export const config = { path: "/api/claim/:slug" };
