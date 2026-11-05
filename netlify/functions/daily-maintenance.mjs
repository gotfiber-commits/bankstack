// Scheduled: daily at 10:00 UTC. Re-checks hiring plans with Stripe, closes expired listings and sourced listings whose original posting is gone,
// and clears out expired sign-in codes, sessions and trusted devices.
import { runLinkCheck, closeExpired, pruneAuth } from "../lib/tasks.mjs";
import { reconcilePlans } from "../lib/billing.mjs";

export default async () => {
  // First catch up on any plan renewals whose webhook was missed, so live postings aren't expired.
  const plans = await reconcilePlans().catch((err) => ({ error: err.message }));
  const expired = await closeExpired();
  const links = await runLinkCheck();
  const pruned = await pruneAuth().catch((err) => ({ error: err.message }));
  console.log("daily maintenance", { plans, expired, ...links, pruned });
  return new Response(JSON.stringify({ plans, expired, ...links, pruned }));
};

export const config = { schedule: "0 10 * * *" };
