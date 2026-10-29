// Scheduled: Mondays at 13:00 UTC (8 a.m. Central). Sends the weekly job alert emails.
import { runAlertDigest } from "../lib/tasks.mjs";

export default async () => {
  const result = await runAlertDigest();
  console.log("alert digest", result);
  return new Response(JSON.stringify(result));
};

export const config = { schedule: "0 13 * * 1" };
