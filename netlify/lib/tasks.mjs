// Background jobs, shared by the scheduled functions and the admin console.
import { db, siteUrl, BRAND, isAggregatorUrl } from "./shared.mjs";
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

// Closes sourced listings whose original posting is gone. Two ways a posting dies:
//  - hard: the page returns 404 or 410
//  - soft: the page loads fine (200) but says the job is gone — aggregators and most ATSes do this
// Sites that block bots (403, 429, 5xx) or time out are left open rather than guessed at.
const GONE_PHRASES = [
  "no longer available", "no longer active", "no longer accepting applications",
  "no longer open", "position has been filled", "job has been filled",
  "job has expired", "job posting has expired", "posting has expired", "this job has expired",
  "this job is no longer", "this position is no longer", "this posting is no longer",
  "job has closed", "this position has been closed", "requisition is closed",
  "job not found", "position not found", "posting not found", "position no longer exists",
];

export async function runLinkCheck({ limit = 40, timeoutMs = 6000 } = {}) {
  const sql = db();
  const jobs = await sql`
    SELECT id, source_url FROM jobs
    WHERE employer_id IS NULL AND status = 'open' AND source_url IS NOT NULL
    ORDER BY last_checked_at NULLS FIRST, id LIMIT ${limit}`;
  const results = { checked: 0, closed: [], unreachable: 0, aggregator: 0 };
  const check = async (job) => {
    // Third-party job-board links aren't allowed on the board at all: close on sight.
    if (isAggregatorUrl(job.source_url)) {
      await sql`UPDATE jobs SET status = 'closed', last_checked_at = now(), updated_at = now() WHERE id = ${job.id}`;
      results.checked++;
      results.aggregator++;
      results.closed.push(job.id);
      return;
    }
    let status = 0, gone = false;
    try {
      const res = await fetch(job.source_url, {
        redirect: "follow", signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "BankJobzLinkCheck/1.0 (+job board link checker)", accept: "text/html,*/*" },
      });
      status = res.status;
      if (status === 200 && (res.headers.get("content-type") || "").includes("html")) {
        // Strip tags so "no longer <b>available</b>" still matches, then look for the giveaway phrases.
        const body = (await res.text()).slice(0, 500000)
          .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ").toLowerCase();
        gone = GONE_PHRASES.some((p) => body.includes(p));
      }
    } catch { status = 0; }
    results.checked++;
    if (status === 404 || status === 410 || gone) {
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

// Sign-in housekeeping: drop used/expired codes, dead sessions and lapsed trusted devices.
export async function pruneAuth() {
  const sql = db();
  const challenges = await sql`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day' RETURNING id`;
  const sessions = await sql`DELETE FROM employer_sessions
    WHERE expires_at < now() OR revoked_at < now() - interval '30 days' OR last_seen_at < now() - interval '30 days' RETURNING id`;
  const devices = await sql`DELETE FROM employer_devices WHERE expires_at < now() RETURNING id`;
  const usage = await sql`DELETE FROM ai_usage WHERE created_at < now() - interval '30 days' RETURNING id`;
  return { challenges: challenges.length, sessions: sessions.length, devices: devices.length, ai_usage: usage.length };
}

export { siteUrl };
