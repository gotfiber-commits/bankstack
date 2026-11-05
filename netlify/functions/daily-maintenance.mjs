// Scheduled: daily at 10:00 UTC. Closes expired listings and sourced listings whose original posting is gone,
// and clears out expired sign-in codes, sessions and trusted devices.
import { runLinkCheck, closeExpired, pruneAuth } from "../lib/tasks.mjs";

export default async () => {
  const expired = await closeExpired();
  const links = await runLinkCheck();
  const pruned = await pruneAuth().catch((err) => ({ error: err.message }));
  console.log("daily maintenance", { expired, ...links, pruned });
  return new Response(JSON.stringify({ expired, ...links, pruned }));
};

export const config = { schedule: "0 10 * * *" };
