// Weekly job alerts for candidates (double opt-in).
// POST /api/alerts { email, categories: [] }   → saves the subscription and emails a confirm link
// GET  /api/alerts/confirm?token=              → confirms, then redirects to the site
// GET  /api/alerts/unsubscribe?token=          → deletes the subscription, then redirects
import { db, json, fail, isEmail, clean, siteUrl, randomToken, redirect, CATEGORIES } from "../lib/shared.mjs";
import { sendEmail, layout } from "../lib/email.mjs";

export default async (req) => {
  const sql = db();
  const url = new URL(req.url);
  const base = siteUrl(req);

  if (req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!/^[a-f0-9]{48}$/.test(token)) return redirect(`${base}/?alerts=invalid#jobs`);
    if (url.pathname === "/api/alerts/confirm") {
      const rows = await sql`UPDATE alert_subscriptions SET confirmed = true, last_sent_at = COALESCE(last_sent_at, now())
                             WHERE token = ${token} RETURNING id`;
      return redirect(`${base}/?alerts=${rows.length ? "confirmed" : "invalid"}#jobs`);
    }
    if (url.pathname === "/api/alerts/unsubscribe") {
      await sql`DELETE FROM alert_subscriptions WHERE token = ${token}`;
      return redirect(`${base}/?alerts=unsubscribed#home`);
    }
    return fail("Not found", 404);
  }

  if (req.method !== "POST" || url.pathname !== "/api/alerts") return fail("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return fail("Send JSON."); }
  if (clean(body.company_website)) return json({ ok: true }); // honeypot

  const email = clean(body.email, 200).toLowerCase();
  if (!isEmail(email)) return fail("Enter a valid email address.");
  const categories = Array.isArray(body.categories) ? body.categories.filter((c) => CATEGORIES.includes(c)) : [];

  const [sub] = await sql`
    INSERT INTO alert_subscriptions (email, categories, token)
    VALUES (${email}, ${categories}, ${randomToken()})
    ON CONFLICT (email) DO UPDATE SET categories = EXCLUDED.categories
    RETURNING token, confirmed`;

  if (!sub.confirmed) {
    const link = `${base}/api/alerts/confirm?token=${sub.token}`;
    await sendEmail({
      to: email,
      subject: "Confirm your BankStack job alerts",
      text: `Confirm your weekly banking tech job alerts: ${link}`,
      html: layout({
        heading: "Confirm your job alerts",
        paragraphs: ["Confirm and we'll email you once a week with new tech and data roles at banks and credit unions.",
          "If you didn't sign up, ignore this email and you won't hear from us."],
        button: { label: "Confirm alerts", url: link },
      }),
    });
  }
  return json({ ok: true, confirmed: sub.confirmed });
};

export const config = { path: ["/api/alerts", "/api/alerts/confirm", "/api/alerts/unsubscribe"] };
