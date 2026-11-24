// POST /api/hit — one page view, sent by the page as a beacon. No cookies; the IP address is not stored.
//   { p: page, j?: job id, l?: 1 on the first page of a visit, r?: referrer, us/um/uc?: utm tags }
// Bots, and pages sent with Do Not Track or Global Privacy Control, aren't counted (the page doesn't
// send those at all). At most 400 page views per visitor per day are kept.
import { db, API_HEADERS } from "../lib/shared.mjs";
import { isBot, geoFrom, deviceOf, browserOf, sourceFrom, visitorId } from "../lib/traffic.mjs";

const ok = () => new Response(null, { status: 204, headers: { ...API_HEADERS, "cache-control": "no-store" } });

export default async (req, context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: API_HEADERS });
  const ua = req.headers.get("user-agent") || "";
  if (isBot(ua) || req.headers.get("sec-gpc") === "1" || req.headers.get("dnt") === "1") return ok();
  let b;
  try { b = JSON.parse((await req.text()).slice(0, 2000)); } catch { return ok(); }
  const path = String(b?.p || "");
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(path)) return ok();
  const jobId = Number.isInteger(b.j) && b.j > 0 && b.j < 1e12 ? b.j : null;

  const sql = db();
  const { day, visitor } = await visitorId(sql, req);
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM page_hits WHERE day = ${day} AND visitor = ${visitor}`;
  if (n >= 400) return ok();
  const landing = b.l === 1;
  const src = landing ? sourceFrom({ r: b.r, us: b.us, um: b.um, uc: b.uc }, req) : null;
  const geo = geoFrom(req, context);
  await sql`INSERT INTO page_hits (day, path, job_id, landing, ref_host, utm_source, utm_medium, utm_campaign, country, region, city, device, browser, visitor)
    VALUES (${day}, ${path}, ${jobId}, ${landing}, ${src?.ref || null}, ${src?.utm_source || null}, ${src?.utm_medium || null}, ${src?.utm_campaign || null},
            ${geo.country}, ${geo.region}, ${geo.city}, ${deviceOf(ua)}, ${browserOf(ua)}, ${visitor})`;
  return ok();
};

export const config = { path: "/api/hit" };
