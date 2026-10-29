// Scheduled: daily at 10:00 UTC. Closes expired listings and sourced listings whose original posting is gone.
import { runLinkCheck, closeExpired } from "../lib/tasks.mjs";

export default async () => {
  const expired = await closeExpired();
  const links = await runLinkCheck();
  console.log("daily maintenance", { expired, ...links });
  return new Response(JSON.stringify({ expired, ...links }));
};

export const config = { schedule: "0 10 * * *" };
