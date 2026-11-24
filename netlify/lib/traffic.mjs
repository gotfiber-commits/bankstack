// Site statistics: first-party, cookieless page counting, and where sign-ups came from.
import { randomBytes, createHash } from "node:crypto";
import { clientIp } from "./auth.mjs";

const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|node-fetch|axios|go-http|java\/|facebookexternalhit|embedly|whatsapp|discord|slack|telegram/i;
export const isBot = (ua) => !ua || BOT.test(ua);

const tidy = (v, max = 80) => {
  const s = String(v ?? "").replace(/[\u0000-\u001f<>"'`]/g, "").trim().slice(0, max);
  return s || null;
};

// Approximate location: Netlify gives functions context.geo, and sends the same as a base64 header.
export function geoFrom(req, context) {
  let g = context?.geo;
  if (!g) {
    const h = req.headers.get("x-nf-geo");
    if (h) { try { g = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { g = null; } }
  }
  if (!g) return { country: null, region: null, city: null };
  return {
    country: tidy(g.country?.code, 2),
    region: tidy(g.subdivision?.code || g.subdivision?.name, 40),
    city: tidy(g.city, 60),
  };
}

export function deviceOf(ua = "") {
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return "mobile";
  return "desktop";
}
export function browserOf(ua = "") {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  return "Other";
}

// The referring site's host, without "www." and only if it's another site.
export function refHost(ref, ownHost = "") {
  try {
    const h = new URL(String(ref)).hostname.toLowerCase().replace(/^www\./, "");
    const own = String(ownHost).toLowerCase().replace(/^www\./, "");
    return h && h !== own && h.includes(".") ? h.slice(0, 100) : null;
  } catch { return null; }
}

// Where a visit came from, from what the page sends: { r, us, um, uc, lp }.
export function sourceFrom(s, req) {
  if (!s || typeof s !== "object") return null;
  const own = (() => { try { return new URL(req.url).hostname; } catch { return ""; } })();
  const out = {
    ref: refHost(s.r, own),
    utm_source: tidy(s.us), utm_medium: tidy(s.um), utm_campaign: tidy(s.uc),
    landing: /^[a-z][a-z0-9-]{0,29}$/.test(String(s.lp || "")) ? s.lp : null,
  };
  return Object.values(out).some(Boolean) ? out : null;
}

// Today's salt (Central time), made on first use; old ones are deleted by daily maintenance.
let saltCache = { day: null, salt: null };
async function todaysSalt(sql) {
  const [{ day }] = await sql`SELECT (now() AT TIME ZONE 'America/Chicago')::date::text AS day`;
  if (saltCache.day === day) return { day, salt: saltCache.salt };
  await sql`INSERT INTO traffic_salts (day, salt) VALUES (${day}, ${randomBytes(24).toString("hex")}) ON CONFLICT (day) DO NOTHING`;
  const [{ salt }] = await sql`SELECT salt FROM traffic_salts WHERE day = ${day}`;
  saltCache = { day, salt };
  return { day, salt };
}

export async function visitorId(sql, req) {
  const { day, salt } = await todaysSalt(sql);
  const ip = clientIp(req) || "unknown";
  const ua = req.headers.get("user-agent") || "";
  return { day, visitor: createHash("sha256").update(`${salt}|${ip}|${ua}`).digest("hex").slice(0, 32) };
}

// What a new account records about where it came from.
export function signupSource(req, context, s) {
  const src = sourceFrom(s, req) || {};
  const geo = geoFrom(req, context);
  const out = { ...src, ...Object.fromEntries(Object.entries(geo).filter(([, v]) => v)) };
  return Object.keys(out).length ? out : null;
}
