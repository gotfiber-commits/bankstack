// GET /api/plan — the hiring plan's prices, read from Stripe, for the pricing shown on the site.
//   → { configured, base_limit, base_cents, plus_limit, plus_cents, extra_cents, yearly: {…same, per year} | null }
import { planPrice, describePrice } from "../lib/billing.mjs";
import { API_HEADERS } from "../lib/shared.mjs";

export default async () => {
  let plan = null, yearly = null;
  try { plan = describePrice(await planPrice()); } catch { /* Stripe unreachable: the page shows its defaults */ }
  try { yearly = describePrice(await planPrice({ interval: "year" })); } catch { /* monthly only */ }
  return new Response(JSON.stringify(plan ? { configured: true, ...plan, yearly } : { configured: false }), {
    headers: { ...API_HEADERS, "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/plan" };
