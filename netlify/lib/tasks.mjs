// Background jobs, shared by the scheduled functions and the admin console.
import { db, siteUrl, BRAND } from "./shared.mjs";
import { sendEmail, layout, esc } from "./email.mjs";

const money = (n) => "$" + Math.round(n / 1000) + "k";
const pay = (j) => (j.salary_min && j.salary_max ? `${money(j.salary_min)}–${money(j.salary_max)}`
  : j.salary_min ? `${money(j.salary_min)}+` : j.salary_max ? `up to ${money(j.salary_max)}` : "");

// Weekly digest: each confirmed subscriber gets the open roles posted since their last email.
export async function runAlertDigest(base = process.env.URL || "http://localhost:8888") {
  const sql = db();
  const subs = await sql`SELECT * FROM alert_subscriptions WHERE confirmed`;
  let sent = 0;
  for (const s of subs) {
    const since = s.last_sent_at || s.created_at;
    const jobs = await sql`
      SELECT id, title, company, location, salary_min, salary_max FROM jobs
      WHERE status = 'open' AND expires_at > now() AND posted_at > ${since}
        AND (cardinality(${s.categories}::text[]) = 0 OR category = ANY(${s.categories}::text[]))
      ORDER BY is_featured DESC, posted_at DESC LIMIT 20`;
    if (!jobs.length) continue;
    const unsubscribe = `${base}/api/alerts/unsubscribe?token=${s.token}`;
    await sendEmail({
      to: s.email,
      subject: `${jobs.length} new banking ${jobs.length === 1 ? "role" : "roles"} this week`,
      text: jobs.map((j) => `${j.title} — ${j.company}, ${j.location}\n${base}/jobs/${j.id}`).join("\n\n")
        + `\n\nUnsubscribe: ${unsubscribe}`,
      html: layout({
        heading: `New roles this week`,
        paragraphs: jobs.map((j) =>
          `<a href="${base}/jobs/${j.id}" style="color:#1d6a4e;font-weight:bold">${esc(j.title)}</a><br>`
          + `${esc(j.company)} · ${esc(j.location)}${pay(j) ? ` · ${pay(j)}` : ""}`),
        button: { label: "See all positions", url: `${base}/#jobs` },
        footer: `You're getting this because you signed up for ${esc(BRAND)} alerts. <a href="${unsubscribe}">Unsubscribe</a>.`,
      }),
    });
    await sql`UPDATE alert_subscriptions SET last_sent_at = now() WHERE id = ${s.id}`;
    sent++;
  }
  return { subscribers: subs.length, sent };
}

// Closes sourced listings whose original posting is gone (404 or 410).
// Sites that block bots (403, 429, 5xx) are left open rather than guessed at.
export async function runLinkCheck({ limit = 40, timeoutMs = 6000 } = {}) {
  const sql = db();
  const jobs = await sql`
    SELECT id, source_url FROM jobs
    WHERE employer_id IS NULL AND status = 'open' AND source_url IS NOT NULL
    ORDER BY last_checked_at NULLS FIRST, id LIMIT ${limit}`;
  const results = { checked: 0, closed: [], unreachable: 0 };
  const check = async (job) => {
    let status = 0;
    for (const method of ["HEAD", "GET"]) {
      try {
        const res = await fetch(job.source_url, {
          method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": "BankJobzLinkCheck/1.0 (+job board link checker)" },
        });
        status = res.status;
        if (method === "HEAD" && (status === 405 || status === 501)) continue;
        break;
      } catch { status = 0; break; }
    }
    results.checked++;
    if (status === 404 || status === 410) {
      await sql`UPDATE jobs SET status = 'closed', last_checked_at = now(), updated_at = now() WHERE id = ${job.id}`;
      results.closed.push(job.id);
    } else {
      if (!status) results.unreachable++;
      await sql`UPDATE jobs SET last_checked_at = now() WHERE id = ${job.id}`;
    }
  };
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(check));
  return results;
}

// Closes anything past its expiry date so the public list and the admin counts agree.
export async function closeExpired() {
  const rows = await db()`UPDATE jobs SET status = 'closed', updated_at = now()
                          WHERE status = 'open' AND expires_at <= now() RETURNING id`;
  return rows.length;
}

export { siteUrl };
