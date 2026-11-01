// End-to-end test of every job-board function against a real Postgres database.
// Needs a Postgres server; set TEST_DATABASE_ADMIN_URL (defaults to postgres://postgres@127.0.0.1:5432/postgres).
// A fresh database "bankstack_e2e" is created for each run. Stripe is the local fake in fake-stripe.mjs.
//   npm run test:e2e
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL || "postgres://postgres@127.0.0.1:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, "/bankstack_e2e");
const PORT = 8899, STRIPE_PORT = 12111, BASE = `http://localhost:${PORT}`;

Object.assign(process.env, {
  DATABASE_URL: DB_URL, DB_DRIVER: "pg", URL: BASE,
  STRIPE_SECRET_KEY: "sk_test_e2e", STRIPE_PRICE_ID: "price_e2e_99", STRIPE_WEBHOOK_SECRET: "whsec_e2e_secret",
  STRIPE_API_HOST: "localhost", STRIPE_API_PORT: String(STRIPE_PORT), STRIPE_API_PROTOCOL: "http",
  ADMIN_TOKEN: "admin_e2e_token", LOCAL_BLOBS_DIR: mkdtempSync(path.join(os.tmpdir(), "bankstack-blobs-")),
});
delete process.env.RESEND_API_KEY;

// ---------- tiny test runner ----------
let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else { failed++; results.push(`  ✗ ${name}${detail ? `  →  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const section = (t) => results.push(`\n${t}`);
const outbox = () => (globalThis.__outbox ||= []);
const lastEmailTo = (to) => [...outbox()].reverse().find((m) => m.to === to);

async function call(method, url, { body, token, form, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload, redirect: "manual" });
  if (raw) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

// ---------- fresh database ----------
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query("DROP DATABASE IF EXISTS bankstack_e2e WITH (FORCE)");
await admin.query("CREATE DATABASE bankstack_e2e");
await admin.end();
execFileSync(process.execPath, ["scripts/seed.mjs"], { env: process.env, stdio: "inherit" });

const { startFakeStripe } = await import("./fake-stripe.mjs");
const { startLocalServer } = await import("./local-server.mjs");
const fakeStripe = await startFakeStripe(STRIPE_PORT);
const { server, routes } = await startLocalServer(PORT);
const { db } = await import("../netlify/lib/shared.mjs");
const { runAlertDigest, runLinkCheck } = await import("../netlify/lib/tasks.mjs");
const Stripe = (await import("stripe")).default;
const stripeLib = new Stripe("sk_test_e2e");
const sql = db();
console.log(`Routes: ${routes.map((r) => r.file).filter((f, i, a) => a.indexOf(f) === i).join(", ")}`);

async function sendWebhook(type, object) {
  const payload = JSON.stringify({ id: `evt_${Date.now()}`, object: "event", type, data: { object } });
  const sig = stripeLib.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await fetch(`${BASE}/api/stripe-webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: payload });
  return { status: res.status, data: await res.json() };
}
const lastSession = () => [...fakeStripe.sessions.values()].at(-1);
async function pay(session) {
  const r = await fetch(`http://localhost:${STRIPE_PORT}/test/complete/${session.id}`, { method: "POST" });
  const { session: s } = await r.json();
  return sendWebhook("checkout.session.completed", s);
}

const jobFields = {
  title: "Senior Data Architect", location: "Florence, AL", work_mode: "hybrid", employment_type: "full-time",
  category: "data-analytics", salary_min: "115,000", salary_max: "140000",
  summary: "Own the enterprise data model across core, lending and the call report pipeline.",
  description: "You'll lead our move to a lakehouse.\nExperience with Jack Henry or Fiserv cores is a plus.",
};

// pdf / docx fixtures
const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const fakePdf = Buffer.from("MZ this is not a pdf");

try {
  // ================================================================
  section("Browsing");
  let r = await call("GET", "/");
  check("home page serves the app", r.status === 200 && String(r.data).includes('id="view"'));
  r = await call("GET", "/api/jobs");
  check("25 seeded listings are public", r.data.jobs?.length === 25, r.data.jobs?.length);
  r = await call("GET", "/api/jobs?q=regions&category=data-analytics");
  check("search + specialty filter", r.data.jobs.length === 4 && r.data.jobs.every((j) => j.company === "Regions Bank"), r.data.jobs.map((j) => j.title));
  r = await call("GET", "/api/jobs?institution_type=credit-union");
  check("institution filter (credit unions)", r.data.jobs.length === 6, r.data.jobs.length);
  r = await call("GET", "/api/jobs/99999");
  check("unknown job returns 404", r.status === 404);

  // ================================================================
  section("Posting a job and paying $99/month");
  r = await call("POST", "/api/checkout", { body: { ...jobFields, title: "" , company: "Shoals Community Bank", email: "hr@shoalsbank.test" } });
  check("missing title is rejected", r.status === 400 && /title/i.test(r.data.error), r.data);
  r = await call("POST", "/api/checkout", { body: { ...jobFields, salary_min: 200000, salary_max: 100000, company: "Shoals Community Bank", email: "hr@shoalsbank.test" } });
  check("salary min > max is rejected", r.status === 400, r.data);
  r = await call("POST", "/api/checkout", { body: { ...jobFields, company: "Shoals Community Bank", email: "HR@shoalsbank.test", institution_type: "bank" } });
  check("checkout starts and returns a Stripe URL", r.status === 200 && r.data.url?.startsWith("https://checkout.stripe.test"), r.data);
  const jobA = r.data.job_id;
  const sessA = lastSession();
  check("checkout uses the $99 price, subscription mode", sessA._price === "price_e2e_99" && sessA.mode === "subscription");
  check("job id travels with the subscription", sessA._subscription_metadata.job_id === String(jobA));
  r = await call("GET", `/api/jobs/${jobA}`);
  check("unpaid posting is not public", r.status === 404);

  r = await pay(sessA);
  check("signed checkout webhook accepted", r.status === 200 && r.data.received);
  r = await call("GET", `/api/jobs/${jobA}`);
  check("paid posting is live", r.status === 200 && r.data.direct === true && r.data.salary_min === 115000, r.data);
  check("employer gets a 'posting is live' email", !!lastEmailTo("hr@shoalsbank.test")?.subject.includes("live"));

  r = await call("GET", `/api/session?session_id=${sessA.id}`);
  check("checkout return issues a posting key", r.status === 200 && /^bsk_/.test(r.data.token) && r.data.job?.status === "open", r.data);
  const keyA = r.data.token;
  r = await call("GET", "/api/jobs");
  check("direct posting is listed first", r.data.jobs[0].id === jobA && r.data.jobs.length === 26);

  r = await call("POST", "/api/checkout", { body: { ...jobFields, company: "Impostor", email: "hr@shoalsbank.test" } });
  check("someone else can't post (and get the key) with an existing email", r.status === 409, r.data);
  r = await call("POST", "/api/stripe-webhook", { body: { type: "checkout.session.completed" } });
  check("webhook without a valid signature is rejected", r.status === 400);

  // ================================================================
  section("Signing in by email");
  outbox().length = 0;
  r = await call("POST", "/api/auth/request", { body: { email: "nobody@nowhere.test" } });
  check("unknown email still answers ok (no account probing)", r.status === 200 && outbox().length === 0);
  r = await call("POST", "/api/auth/request", { body: { email: "hr@shoalsbank.test" } });
  const link = lastEmailTo("hr@shoalsbank.test")?.text.match(/login=([a-f0-9]{48})/)?.[1];
  check("sign-in link is emailed", r.status === 200 && !!link);
  r = await call("POST", "/api/auth/verify", { body: { token: link } });
  check("link returns the same posting key", r.status === 200 && r.data.token === keyA);
  r = await call("POST", "/api/auth/verify", { body: { token: link } });
  check("link can't be used twice", r.status === 401);

  // ================================================================
  section("SEO and sharing");
  r = await call("GET", `/jobs/${jobA}`);
  const ld = String(r.data).match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
  const parsed = ld ? JSON.parse(ld) : {};
  check("job page has its own title", r.status === 200 && String(r.data).includes("<title>Senior Data Architect at Shoals Community Bank"));
  check("Google JobPosting data is complete", parsed["@type"] === "JobPosting" && parsed.hiringOrganization?.name === "Shoals Community Bank"
    && parsed.jobLocation?.address?.addressLocality === "Florence" && parsed.jobLocation?.address?.addressRegion === "AL"
    && parsed.baseSalary?.value?.minValue === 115000 && parsed.directApply === true, parsed);
  r = await call("GET", "/jobs/1");
  check("sourced job page is noindex (not our posting)", String(r.data).includes('content="noindex, follow"') && !String(r.data).includes("ld+json"));
  r = await call("GET", "/sitemap.xml");
  check("sitemap lists the paid posting", String(r.data).includes(`/jobs/${jobA}</loc>`) && !String(r.data).includes("/jobs/1</loc>"));
  r = await call("GET", "/robots.txt");
  check("robots.txt points to the sitemap", String(r.data).includes(`Sitemap: ${BASE}/sitemap.xml`));

  // ================================================================
  section("Applying");
  outbox().length = 0;
  let form = new FormData();
  Object.entries({ job_id: jobA, name: "Dana Whitfield", email: "dana@example.test", phone: "256-555-0142",
    linkedin_url: "https://linkedin.com/in/danaw", cover_note: "Twelve years on Jack Henry SilverLake." })
    .forEach(([k, v]) => form.append(k, String(v)));
  form.append("resume", new Blob([pdfBytes], { type: "application/pdf" }), "Dana Whitfield Resume.pdf");
  r = await call("POST", "/api/apply", { form });
  check("application with PDF résumé accepted", r.status === 200 && r.data.ok && !r.data.duplicate, r.data);
  check("employer is emailed about the applicant", !!lastEmailTo("hr@shoalsbank.test")?.subject.includes("Dana Whitfield"));
  check("employer can reply straight to the candidate", lastEmailTo("hr@shoalsbank.test")?.replyTo === "dana@example.test");
  check("candidate gets a confirmation", !!lastEmailTo("dana@example.test"));

  form = new FormData(); form.append("job_id", String(jobA)); form.append("name", "Dana"); form.append("email", "dana@example.test");
  r = await call("POST", "/api/apply", { form });
  check("applying twice is caught", r.data.duplicate === true);

  form = new FormData(); form.append("job_id", String(jobA)); form.append("name", "Eve"); form.append("email", "eve@example.test");
  form.append("resume", new Blob([fakePdf]), "resume.pdf");
  r = await call("POST", "/api/apply", { form });
  check("a fake PDF is rejected", r.status === 400 && /real PDF/.test(r.data.error), r.data);
  form = new FormData(); form.append("job_id", String(jobA)); form.append("name", "Eve"); form.append("email", "eve@example.test");
  form.append("resume", new Blob([Buffer.alloc(6 * 1024 * 1024)]), "huge.pdf");
  r = await call("POST", "/api/apply", { form });
  check("files over 5 MB are rejected", r.status === 400, r.data);
  form = new FormData(); form.append("job_id", String(jobA)); form.append("name", "Eve"); form.append("email", "eve@example.test");
  form.append("resume", new Blob(["#!/bin/sh"]), "resume.exe");
  r = await call("POST", "/api/apply", { form });
  check("other file types are rejected", r.status === 400, r.data);

  r = await call("POST", "/api/apply", { body: { job_id: jobA, name: "Bot", email: "bot@spam.test", company_website: "http://spam" } });
  const [{ n: botApps }] = await sql`SELECT COUNT(*)::int n FROM applications WHERE email = 'bot@spam.test'`;
  check("spam bots are silently dropped", r.status === 200 && botApps === 0);

  r = await call("POST", "/api/apply", { body: { job_id: 1, name: "Sam Ortiz", email: "sam@example.test" } });
  check("sourced job: interest saved, original link returned", r.data.external === true && r.data.apply_url?.startsWith("https://"), r.data);

  // ================================================================
  section("Employer dashboard");
  r = await call("GET", "/api/employer", { token: keyA });
  const appRow = r.data.applications?.[0];
  check("dashboard shows the posting with 1 applicant", r.data.jobs?.length === 1 && r.data.jobs[0].applications === 1 && r.data.jobs[0].new_applications === 1, r.data.jobs);
  check("dashboard shows the candidate and résumé", appRow?.name === "Dana Whitfield" && appRow.has_resume && appRow.resume_name === "Dana Whitfield Resume.pdf", appRow);
  r = await call("GET", `/api/employer/applications/${appRow.id}/resume`, { token: keyA, raw: true });
  const downloaded = Buffer.from(await r.arrayBuffer());
  check("résumé downloads byte-for-byte", r.status === 200 && downloaded.equals(pdfBytes) && r.headers.get("content-disposition").includes("Dana Whitfield Resume.pdf"));
  r = await call("POST", `/api/employer/applications/${appRow.id}/status`, { token: keyA, body: { status: "interview" } });
  check("move candidate to Interview", r.status === 200);
  r = await call("POST", `/api/employer/applications/${appRow.id}/status`, { token: keyA, body: { status: "maybe" } });
  check("unknown stage is rejected", r.status === 400);
  r = await call("GET", "/api/employer", { token: keyA });
  check("stage is saved", r.data.applications[0].status === "interview" && r.data.jobs[0].new_applications === 0);

  r = await call("GET", `/api/employer/jobs/${jobA}`, { token: keyA });
  check("edit form loads the posting", r.data.title === "Senior Data Architect" && !("stripe_subscription_id" in r.data));
  r = await call("PUT", `/api/employer/jobs/${jobA}`, { token: keyA, body: { ...jobFields, title: "Lead Data Architect", work_mode: "remote" } });
  check("edit saves", r.status === 200, r.data);
  r = await call("GET", `/api/jobs/${jobA}`);
  check("edit shows publicly", r.data.title === "Lead Data Architect" && r.data.work_mode === "remote");
  r = await call("GET", `/jobs/${jobA}`);
  check("remote job is marked telecommute for Google", String(r.data).includes('"jobLocationType":"TELECOMMUTE"'));

  r = await call("POST", "/api/employer/billing", { token: keyA });
  check("cards & invoices opens the Stripe portal", r.status === 200 && r.data.url?.includes("billing.stripe.test"));

  // second posting by a signed-in employer, left unpaid, then paid from the dashboard
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Branch Manager", category: "branch-retail" } });
  const jobA2 = r.data.job_id;
  check("signed-in employer posts a second job", r.status === 200 && !!jobA2);
  r = await call("POST", `/api/employer/jobs/${jobA2}/pay`, { token: keyA });
  check("unpaid posting can be paid later from the dashboard", r.status === 200 && r.data.url);
  r = await call("POST", `/api/employer/jobs/${jobA}/pay`, { token: keyA });
  check("can't pay twice for a live posting", r.status === 400);

  // ================================================================
  section("Privacy between employers");
  r = await call("POST", "/api/checkout", { body: { ...jobFields, title: "Mortgage Loan Officer", category: "lending-credit", company: "Tennessee Valley CU", email: "jobs@tvcu.test", institution_type: "credit-union" } });
  const jobB = r.data.job_id;
  await pay(lastSession());
  const keyB = (await call("GET", `/api/session?session_id=${lastSession().id}`)).data.token;
  check("second employer is set up", /^bsk_/.test(keyB) && keyB !== keyA);
  r = await call("GET", `/api/employer/applications/${appRow.id}/resume`, { token: keyB });
  check("employer B can't download A's applicant résumé", r.status === 404);
  r = await call("PUT", `/api/employer/jobs/${jobA}`, { token: keyB, body: jobFields });
  check("employer B can't edit A's job", r.status === 404);
  r = await call("GET", "/api/employer", { token: keyB });
  check("employer B sees only their own postings", r.data.jobs.length === 1 && r.data.jobs[0].id === jobB && r.data.applications.length === 0);
  r = await call("GET", "/api/employer", { token: "bsk_wrong" });
  check("a wrong key is refused", r.status === 401);

  // ================================================================
  section("Renewals and cancellation");
  const subA = (await sql`SELECT stripe_subscription_id FROM jobs WHERE id = ${jobA}`)[0].stripe_subscription_id;
  r = await call("POST", `/api/employer/jobs/${jobA}/cancel`, { token: keyA });
  let row = (await sql`SELECT status, cancel_at_period_end FROM jobs WHERE id = ${jobA}`)[0];
  check("cancel: stops renewal but stays live this month", r.status === 200 && row.status === "open" && row.cancel_at_period_end === true);
  check("cancel is sent to Stripe", fakeStripe.subs.get(subA).cancel_at_period_end === true);
  r = await call("POST", `/api/employer/jobs/${jobA}/resume`, { token: keyA });
  row = (await sql`SELECT cancel_at_period_end FROM jobs WHERE id = ${jobA}`)[0];
  check("keep renewing undoes it", row.cancel_at_period_end === false && fakeStripe.subs.get(subA).cancel_at_period_end === false);

  const before = (await sql`SELECT paid_through FROM jobs WHERE id = ${jobA}`)[0].paid_through;
  await fetch(`http://localhost:${STRIPE_PORT}/test/subscriptions/${subA}`, { method: "POST", body: JSON.stringify({ renew: true }) });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(subA));
  const after = (await sql`SELECT paid_through, expires_at FROM jobs WHERE id = ${jobA}`)[0];
  check("monthly renewal extends the listing", after.paid_through > before && after.expires_at > after.paid_through);

  await fetch(`http://localhost:${STRIPE_PORT}/test/subscriptions/${subA}`, { method: "POST", body: JSON.stringify({ status: "past_due" }) });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(subA));
  r = await call("GET", `/api/jobs/${jobA}`);
  check("failed card (past due): stays up while Stripe retries", r.status === 200);

  await fetch(`http://localhost:${STRIPE_PORT}/test/subscriptions/${subA}`, { method: "POST", body: JSON.stringify({ status: "canceled" }) });
  await sendWebhook("customer.subscription.deleted", fakeStripe.subs.get(subA));
  r = await call("GET", `/api/jobs/${jobA}`);
  check("subscription ends: posting comes down", r.status === 404);
  r = await call("GET", `/jobs/${jobA}`);
  check("ended posting's page is 404 + noindex", r.status === 404 && String(r.data).includes('content="noindex"'));
  r = await call("POST", "/api/apply", { body: { job_id: jobA, name: "Late", email: "late@example.test" } });
  check("can't apply to a closed posting", r.status === 404);
  r = await call("PUT", `/api/employer/jobs/${jobA}`, { token: keyA, body: jobFields });
  check("closed posting can't be edited", r.status === 400);

  // ================================================================
  section("Job alerts");
  outbox().length = 0;
  r = await call("POST", "/api/alerts", { body: { email: "alex@example.test", categories: ["data-analytics", "software"] } });
  const confirmLink = lastEmailTo("alex@example.test")?.text.match(/https?:\S+confirm\?token=\w+/)?.[0];
  check("alert signup sends a confirmation email", r.status === 200 && !!confirmLink);
  r = await runAlertDigest(BASE);
  check("unconfirmed subscribers get nothing", r.sent === 0);
  r = await fetch(confirmLink.replace(BASE, BASE), { redirect: "manual" });
  check("confirm link works and redirects to the site", r.status === 303 && r.headers.get("location").includes("alerts=confirmed"));
  await new Promise((s) => setTimeout(s, 20));
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Data Governance Architect" } });
  const jobA3 = r.data.job_id;
  await pay(lastSession());
  await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Teller", category: "branch-retail" } });
  await pay(lastSession());
  outbox().length = 0;
  r = await runAlertDigest(BASE);
  const digest = lastEmailTo("alex@example.test");
  check("weekly digest sends new matching roles", r.sent === 1 && digest?.text.includes("Data Governance Architect"));
  check("digest leaves out departments they didn't pick", !digest?.text.includes("Teller"));
  check("digest links to real job pages", digest?.text.includes(`${BASE}/jobs/${jobA3}`));
  r = await runAlertDigest(BASE);
  check("same jobs aren't sent twice", r.sent === 0);
  const unsub = digest.text.match(/https?:\S+unsubscribe\?token=\w+/)?.[0];
  r = await fetch(unsub, { redirect: "manual" });
  const [{ n: subsLeft }] = await sql`SELECT COUNT(*)::int n FROM alert_subscriptions WHERE email = 'alex@example.test'`;
  check("unsubscribe link removes them", r.status === 303 && subsLeft === 0);

  // ================================================================
  section("Admin console and maintenance");
  r = await call("GET", "/api/admin");
  check("admin needs the admin key", r.status === 401);
  r = await call("GET", "/api/admin", { token: "admin_e2e_token" });
  check("admin figures: live paid postings and monthly revenue",
    r.status === 200 && r.data.paid_live === 3 && r.data.mrr_cents === 3 * 9900 && r.data.unpaid === 1 && r.data.employer_count === 2, {
      paid_live: r.data.paid_live, mrr: r.data.mrr_cents, unpaid: r.data.unpaid, employers: r.data.employer_count });
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token", body: {
    ...jobFields, title: "BSA Analyst", category: "risk-compliance", company: "Gone Bank", source_url: `${BASE}/no-such-posting`, source_name: "Test" } });
  const goneId = r.data.id;
  check("admin adds a sourced listing", r.status === 201);
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token", body: {
    ...jobFields, title: "Staff Accountant", category: "finance-accounting", company: "Live Bank", source_url: `${BASE}/index.html` } });
  const liveId = r.data.id;
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token", body: { ...jobFields, company: "Live Bank", source_url: `${BASE}/index.html` } });
  check("duplicate source link is refused", r.status === 409);
  await sql`UPDATE jobs SET last_checked_at = now() WHERE id NOT IN (${goneId}, ${liveId})`;
  r = await runLinkCheck({ limit: 2 });
  const statuses = Object.fromEntries((await sql`SELECT id, status FROM jobs WHERE id IN (${goneId}, ${liveId})`).map((x) => [x.id, x.status]));
  check("dead-link check closes a removed posting", r.closed.includes(goneId) && statuses[goneId] === "closed", r);
  check("…and leaves a working one open", statuses[liveId] === "open");
  r = await call("POST", `/api/admin/jobs/${goneId}/reopen`, { token: "admin_e2e_token" });
  check("admin can reopen a sourced listing", r.status === 200 && (await sql`SELECT status FROM jobs WHERE id = ${goneId}`)[0].status === "open");
  const subB = (await sql`SELECT stripe_subscription_id FROM jobs WHERE id = ${jobB}`)[0].stripe_subscription_id;
  r = await call("POST", `/api/admin/jobs/${jobB}/close`, { token: "admin_e2e_token" });
  check("admin take-down of a paid posting also cancels its billing", r.status === 200 && fakeStripe.subs.get(subB).status === "canceled");
} catch (err) {
  failed++;
  results.push(`\n  ✗ crashed: ${err.stack}`);
} finally {
  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); fakeStripe.server.close(); await sql.end?.();
  process.exit(failed ? 1 : 0);
}
