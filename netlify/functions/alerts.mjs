// Weekly job alerts for candidates (double opt-in).
// POST /api/alerts { email, categories: [] }   → saves the subscription and emails a confirm link
// GET  /api/alerts/confirm?token=              → confirms (and applies any changed choices), then redirects
// A confirmed subscriber's new choices are held until they click an emailed link, so knowing
// someone's email isn't enough to change their alerts. The answer is the same either way.
// GET  /api/alerts/unsubscribe?token=          → deletes the subscription, then redirects
import { db, json, fail, isEmail, clean, siteUrl, randomToken, redirect, CATEGORIES } from "../lib/shared.mjs";
import { sendEmail, layout } from "../lib/email.mjs";
import { withinLimits, LIMITS, TOO_MANY } from "../lib/limits.mjs";

export default async (req) => {
  const sql = db();
  const url = new URL(req.url);
  const base = siteUrl(req);

  if (req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!/^[a-f0-9]{48}$/.test(token)) return redirect(`${base}/?alerts=invalid#jobs`);
    if (url.pathname === "/api/alerts/confirm") {
      const rows = await sql`UPDATE alert_subscriptions SET confirmed = true, last_sent_at = COALESCE(last_sent_at, now()),
                               categories = COALESCE(pending_categories, categories), pending_categories = NULL
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

  if (!(await withinLimits(sql, LIMITS.alertMail(req, email)))) return fail(TOO_MANY, 429);

  // New subscribers (and unconfirmed ones signing up again) set their choices directly: nothing is
  // sent until they confirm. A confirmed subscriber's choices wait in pending_categories.
  const [sub] = await sql`
    INSERT INTO alert_subscriptions (email, categories, token)
    VALUES (${email}, ${categories}, ${randomToken()})
    ON CONFLICT (email) DO UPDATE SET
      categories = CASE WHEN alert_subscriptions.confirmed THEN alert_subscriptions.categories ELSE EXCLUDED.categories END,
      pending_categories = CASE WHEN alert_subscriptions.confirmed THEN EXCLUDED.categories ELSE NULL END
    RETURNING token, confirmed`;

  const link = `${base}/api/alerts/confirm?token=${sub.token}`;
  await sendEmail(sub.confirmed
    ? {
        to: email,
        subject: "Confirm your new BankJobz alert choices",
        text: `Someone (hopefully you) asked to change the specialties in your weekly banking job alerts. Confirm the change: ${link}\n\nIf it wasn't you, ignore this email and nothing changes.`,
        html: layout({
          heading: "Confirm your new alert choices",
          paragraphs: ["Someone (hopefully you) asked to change the specialties in your weekly job alerts.",
            "If it wasn't you, ignore this email and nothing changes."],
          button: { label: "Confirm the change", url: link },
        }),
      }
    : {
        to: email,
        subject: "Confirm your BankJobz job alerts",
        text: `Confirm your weekly banking job alerts: ${link}`,
        html: layout({
          heading: "Confirm your job alerts",
          paragraphs: ["Confirm and we'll email you once a week with new jobs at banks and credit unions.",
            "If you didn't sign up, ignore this email and you won't hear from us."],
          button: { label: "Confirm alerts", url: link },
        }),
      });
  // Same answer whether or not the email was already subscribed.
  return json({ ok: true });
};

export const config = { path: ["/api/alerts", "/api/alerts/confirm", "/api/alerts/unsubscribe"] };
