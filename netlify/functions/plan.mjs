// GET /api/plan — the hiring plan's prices, read from Stripe, for the pricing shown on the site.
//   → { configured, base_limit, base_cents, plus_limit, plus_cents, extra_cents }
import { planPrice, describePrice } from "../lib/billing.mjs";

export default async () => {
  let plan = null;
  try { plan = describePrice(await planPrice()); } catch { /* Stripe unreachable: the page shows its defaults */ }
  return new Response(JSON.stringify(plan ? { configured: true, ...plan } : { configured: false }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/plan" };
