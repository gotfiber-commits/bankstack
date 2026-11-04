// End-to-end test of every job-board function against a real Postgres database.
// Needs a Postgres server; set TEST_DATABASE_ADMIN_URL (defaults to postgres://postgres@127.0.0.1:5432/postgres).
// A fresh database "bankstack_e2e" is created for each run. Stripe is the local fake in fake-stripe.mjs.
//   npm run test:e2e
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL || "postgres://postgres@127.0.0.1:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, "/bankstack_e2e");
const PORT = 8899, STRIPE_PORT = 12111, REGISTRY_PORT = 8977, AI_PORT = 8978, BASE = `http://localhost:${PORT}`;

Object.assign(process.env, {
  DATABASE_URL: DB_URL, DB_DRIVER: "pg", URL: BASE,
  STRIPE_SECRET_KEY: "sk_test_e2e", STRIPE_PRICE_ID: "price_e2e_99", STRIPE_WEBHOOK_SECRET: "whsec_e2e_secret",
  STRIPE_API_HOST: "localhost", STRIPE_API_PORT: String(STRIPE_PORT), STRIPE_API_PROTOCOL: "http",
  ADMIN_TOKEN: "admin_e2e_token", LOCAL_BLOBS_DIR: mkdtempSync(path.join(os.tmpdir(), "bankstack-blobs-")),
  FDIC_API_BASE: `http://localhost:${REGISTRY_PORT}`, NCUA_API_BASE: `http://localhost:${REGISTRY_PORT}`,
  ANTHROPIC_API_KEY: "sk-ant-test-e2e", ANTHROPIC_API_BASE: `http://localhost:${AI_PORT}`,
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
const { startFakeRegistries, FAKE_BANKS, FAKE_CUS } = await import("./fake-registries.mjs");
const { startFakeAnthropic } = await import("./fake-anthropic.mjs");
const fakeStripe = await startFakeStripe(STRIPE_PORT);
const registries = await startFakeRegistries(REGISTRY_PORT);
const fakeAi = await startFakeAnthropic(AI_PORT);
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
// expected counts come from the seed file, so adding listings never breaks the suite
const SEED = JSON.parse(readFileSync(new URL("../public/seed-jobs.json", import.meta.url), "utf8"));
const seedText = (j) => [j.title, j.company, j.location, j.summary].join(" ").toLowerCase();
const SEED_LEN = SEED.length;
const REGIONS_DA = SEED.filter((j) => j.category === "data-analytics" && seedText(j).includes("regions")).length;
const SEED_CU = SEED.filter((j) => j.institution_type === "credit-union").length;

const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const fakePdf = Buffer.from("MZ this is not a pdf");

// A tiny but valid PDF with real extractable text, for the matching tests.
function makePdf(text) {
  const escPdf = (x) => x.replace(/[\\()]/g, (c) => "\\" + c);
  const words = text.split(/\s+/); const lines = [];
  for (let i = 0; i < words.length; i += 10) lines.push(words.slice(i, i + 10).join(" "));
  const content = "BT /F1 12 Tf 14 TL 72 720 Td\n" + lines.map((l) => `(${escPdf(l)}) Tj T*`).join("\n") + "\nET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

try {
  // ================================================================
  section("Browsing");
  let r = await call("GET", "/");
  check("home page serves the app", r.status === 200 && String(r.data).includes('id="view"'));
  r = await call("GET", "/api/jobs");
  check("seeded listings are public", r.data.jobs?.length === SEED_LEN, `${r.data.jobs?.length} vs ${SEED_LEN}`);
  r = await call("GET", "/api/jobs?q=regions&category=data-analytics");
  check("search + department filter", r.data.jobs.length === REGIONS_DA && r.data.jobs.every((j) => j.company === "Regions Bank"), r.data.jobs.map((j) => j.title));
  r = await call("GET", "/api/jobs?institution_type=credit-union");
  check("institution filter (credit unions)", r.data.jobs.length === SEED_CU, `${r.data.jobs.length} vs ${SEED_CU}`);
  r = await call("GET", "/api/jobs/99999");
  check("unknown job returns 404", r.status === 404);

  // ================================================================
  section("Employer accounts, then posting a job at $99/month");
  // Creates an account the way a hiring manager does: sign up, click the emailed link.
  const signUp = async (fields) => {
    const res = await call("POST", "/api/auth/signup", { body: fields });
    const email = fields.email.toLowerCase();
    const token = lastEmailTo(email)?.text.match(/login=([a-f0-9]{48})/)?.[1];
    const verified = token ? await call("POST", "/api/auth/verify", { body: { token } }) : null;
    return { res, mail: lastEmailTo(email), key: verified?.data?.token };
  };

  r = await call("POST", "/api/checkout", { body: { ...jobFields, company: "Shoals Community Bank", email: "hr@shoalsbank.test" } });
  check("posting without an account is refused", r.status === 401 && /account/i.test(r.data.error), r.data);
  r = await call("POST", "/api/auth/signup", { body: { company: "Shoals Community Bank", email: "hr@shoalsbank.test" } });
  check("sign-up needs the manager's name", r.status === 400 && /name/i.test(r.data.error));
  outbox().length = 0;
  const shoalsAcct = await signUp({ contact_name: "Morgan Hale", contact_title: "HR Manager", company: "Shoals Community Bank",
    email: "HR@shoalsbank.test", institution_type: "bank" });
  check("sign-up emails a confirmation link", shoalsAcct.res.status === 200 && !!shoalsAcct.mail?.subject.includes("Confirm"), shoalsAcct.mail?.subject);
  const keyA = shoalsAcct.key;
  check("confirming the email opens the account", /^bsk_/.test(keyA || ""), keyA);
  r = await call("GET", "/api/employer", { token: keyA });
  check("new account has its own empty dashboard with the manager's details",
    r.status === 200 && r.data.jobs.length === 0 && r.data.account.contact_name === "Morgan Hale"
    && r.data.account.contact_title === "HR Manager" && r.data.account.has_billing === false, r.data.account);

  outbox().length = 0;
  r = await call("POST", "/api/auth/signup", { body: { contact_name: "Impostor", company: "Impostor Bank", email: "hr@shoalsbank.test" } });
  check("signing up again with a taken email just sends that inbox a sign-in link",
    r.status === 200 && !!lastEmailTo("hr@shoalsbank.test")?.subject.includes("sign-in"));
  r = await call("GET", "/api/employer", { token: keyA });
  check("…and can't overwrite the account", r.data.company === "Shoals Community Bank" && r.data.account.contact_name === "Morgan Hale");

  r = await call("PUT", "/api/employer/account", { token: keyA, body: { contact_name: "", company: "Shoals Community Bank" } });
  check("account edit requires a name", r.status === 400);
  r = await call("PUT", "/api/employer/account", { token: keyA, body: { contact_name: "Morgan Hale", contact_title: "VP, Human Resources",
    company: "Shoals Community Bank", institution_type: "bank", phone: "256-555-0100" } });
  r = await call("GET", "/api/employer", { token: keyA });
  check("account edits save", r.data.account.contact_title === "VP, Human Resources" && r.data.account.phone === "256-555-0100");

  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "" } });
  check("missing title is rejected", r.status === 400 && /title/i.test(r.data.error), r.data);
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, salary_min: 200000, salary_max: 100000 } });
  check("salary min > max is rejected", r.status === 400, r.data);
  r = await call("POST", "/api/checkout", { token: keyA, body: jobFields });
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
  check("paid posting is live under the account's institution", r.status === 200 && r.data.direct === true
    && r.data.salary_min === 115000 && r.data.company === "Shoals Community Bank", r.data);
  check("employer gets a 'posting is live' email", !!lastEmailTo("hr@shoalsbank.test")?.subject.includes("live"));

  r = await call("GET", `/api/session?session_id=${sessA.id}`);
  check("returning from Stripe keeps the same account", r.status === 200 && r.data.token === keyA && r.data.job?.status === "open", r.data);
  r = await call("GET", "/api/jobs");
  check("direct posting is listed first", r.data.jobs[0].id === jobA && r.data.jobs.length === SEED_LEN + 1);
  r = await call("GET", "/api/employer", { token: keyA });
  check("billing appears on the account once paid", r.data.account.has_billing === true && r.data.jobs.length === 1);

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
  const tvcu = await signUp({ contact_name: "Riley Shaw", company: "Tennessee Valley CU", email: "jobs@tvcu.test", institution_type: "credit-union" });
  const keyB = tvcu.key;
  r = await call("POST", "/api/checkout", { token: keyB, body: { ...jobFields, title: "Mortgage Loan Officer", category: "lending-credit" } });
  const jobB = r.data.job_id;
  await pay(lastSession());
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
  section("Candidate profiles, matching and quick apply");
  outbox().length = 0;
  r = await call("POST", "/api/candidate-auth/request", { body: { email: "casey@example.test", name: "Casey Banks" } });
  const clink = lastEmailTo("casey@example.test")?.text.match(/clogin=([a-f0-9]{48})/)?.[1];
  check("profile sign-in link emailed", r.status === 200 && !!clink);
  r = await call("POST", "/api/candidate-auth/verify", { body: { token: clink } });
  const ck = r.data.token;
  check("sign-in issues a candidate token", r.status === 200 && /^ck_/.test(ck || ""), r.data);
  r = await call("POST", "/api/candidate-auth/verify", { body: { token: clink } });
  check("candidate link can't be used twice", r.status === 401);

  r = await call("PUT", "/api/candidate", { token: ck, body: { name: "Casey Banks", location: "Florence, AL",
    work_mode_pref: "hybrid", categories: ["lending-credit", "nonsense"], summary: "", phone: "256-555-0100",
    linkedin_url: "https://linkedin.com/in/caseybanks" } });
  check("profile saves", r.status === 200, r.data);

  const resumePdf = makePdf("Casey Banks, Florence Alabama. Senior mortgage loan officer: ten years of consumer lending, underwriting and loan origination at a community bank. NMLS licensed. Credit analysis, HELOC portfolios, closing disclosures and coaching a team of processors.");
  form = new FormData();
  form.append("resume", new Blob([resumePdf], { type: "application/pdf" }), "Casey Banks Resume.pdf");
  r = await call("POST", "/api/candidate/resume", { token: ck, form });
  check("résumé uploads and its text is read", r.status === 200 && r.data.text_extracted === true, r.data);

  r = await call("GET", "/api/candidate/matches", { token: ck });
  const matches = r.data.matches;
  check("matches ranked high to low", r.data.basis === "resume" && matches.length >= 20
    && matches.every((m, i) => i === 0 || matches[i - 1].score >= m.score), matches?.length);
  check("lending jobs rank first for a lending résumé", matches[0].category === "lending-credit",
    matches.slice(0, 3).map((m) => `${m.title}:${m.score}`));
  const mloRank = matches.findIndex((m) => m.title === "Mortgage Loan Officer");
  check("the bank's own lending posting is in the top 3", mloRank > -1 && mloRank < 3, mloRank);
  check("lending clearly beats the data jobs", matches[0].score - matches.find((m) => m.category === "data-analytics").score >= 15,
    matches.slice(0, 5).map((m) => `${m.title}:${m.score}`));
  check("match explains itself", matches[0].reasons.join(" ").toLowerCase().includes("underwriting"), matches[0].reasons);

  const mlo = matches[mloRank];
  r = await call("POST", "/api/candidate/apply", { token: ck, body: { job_id: mlo.id, cover_note: "Happy to talk." } });
  check("quick apply sends", r.status === 200 && r.data.ok && !r.data.duplicate, r.data);
  check("employer emailed about the quick apply", !!lastEmailTo("jobs@tvcu.test")?.subject.includes("Casey Banks"));
  check("candidate gets a confirmation", !!lastEmailTo("casey@example.test")?.subject.includes("Your application"));
  r = await call("POST", "/api/candidate/apply", { token: ck, body: { job_id: mlo.id } });
  check("second quick apply caught", r.data.duplicate === true);
  r = await call("GET", "/api/candidate/matches", { token: ck });
  check("applied flag shows on matches", r.data.matches.find((m) => m.id === mlo.id)?.applied === true);

  const empB = await call("GET", "/api/employer", { token: keyB });
  const qa = empB.data.applications.find((a) => a.email === "casey@example.test");
  check("quick apply lands in the employer dashboard with résumé", qa?.has_resume === true && qa.name === "Casey Banks", qa);
  r = await call("GET", `/api/employer/applications/${qa.id}/resume`, { token: keyB, raw: true });
  check("employer downloads the quick-apply résumé byte for byte",
    r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(resumePdf));

  const sourcedMatch = matches.find((m) => !m.direct);
  r = await call("POST", "/api/candidate/apply", { token: ck, body: { job_id: sourcedMatch.id } });
  check("quick apply on a sourced job hands back the original link", r.data.external === true && /^https?:/.test(r.data.apply_url || ""), r.data);

  r = await call("GET", "/api/candidate", { token: "ck_wrong" });
  check("wrong candidate token refused", r.status === 401);
  r = await call("GET", "/api/candidate", { token: ck });
  check("profile lists their applications", r.data.applications.length >= 2 && r.data.candidate.resume_name === "Casey Banks Resume.pdf",
    r.data.applications?.length);

  // Saved jobs (bookmarks on the profile)
  r = await call("POST", "/api/candidate/save", { token: ck, body: { job_id: sourcedMatch.id } });
  check("candidate saves a job", r.status === 200 && r.data.saved === true, r.data);
  r = await call("POST", "/api/candidate/save", { token: ck, body: { job_id: sourcedMatch.id } });
  check("saving the same job twice is fine", r.status === 200 && r.data.saved === true);
  r = await call("POST", "/api/candidate/save", { token: ck, body: { job_id: 999999 } });
  check("saving an unknown job is refused", r.status === 404);
  r = await call("GET", "/api/candidate", { token: ck });
  check("one bookmark on the profile, with the job's details", r.data.saved.length === 1
    && String(r.data.saved[0].job_id) === String(sourcedMatch.id) && r.data.saved[0].open === true
    && !!r.data.saved[0].title && !!r.data.saved[0].saved_at, r.data.saved);
  r = await call("GET", "/api/candidate/matches", { token: ck });
  check("saved flag shows on matches", r.data.matches.find((m) => m.id === sourcedMatch.id)?.saved === true);
  r = await call("POST", "/api/candidate/save", { token: ck, body: { job_id: sourcedMatch.id, saved: false } });
  check("unsave removes the bookmark", r.status === 200 && r.data.saved === false);
  r = await call("GET", "/api/candidate", { token: ck });
  check("removed bookmark is gone", r.data.saved.length === 0);

  // ================================================================
  section("Banking-native filters: core systems and licenses");
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token", body: {
    ...jobFields, title: "Consumer Loan Officer", category: "lending-credit", company: "Muscle Shoals National Bank",
    source_url: `${BASE}/app.css`, source_name: "Test",
    core_systems: ["jack-henry-silverlake", "bogus-core"], licenses: ["nmls", "fake-license"] } });
  const nmlsJobId = r.data.id;
  check("listing accepts banking specifics", r.status === 201);
  r = await call("GET", `/api/jobs/${nmlsJobId}`);
  check("unknown ids are dropped, valid ones kept", r.data.core_systems.length === 1
    && r.data.core_systems[0] === "jack-henry-silverlake" && r.data.licenses.length === 1 && r.data.licenses[0] === "nmls", r.data);
  r = await call("GET", "/api/jobs?core_system=jack-henry-silverlake");
  check("core-system filter finds exactly the tagged job", r.data.jobs.length === 1 && r.data.jobs[0].id === nmlsJobId);
  r = await call("GET", "/api/jobs?license=nmls");
  check("license filter works", r.data.jobs.some((j) => j.id === nmlsJobId));
  r = await call("GET", "/api/jobs?core_system=not-a-system");
  check("an unknown filter value is ignored, not an error", r.status === 200 && r.data.jobs.length > 1);
  r = await call("PUT", `/api/employer/jobs/${jobA2}`, { token: keyA, body: {
    ...jobFields, title: "Branch Manager", category: "branch-retail", core_systems: ["fiserv-dna"], licenses: [] } });
  check("employer edit saves banking specifics", r.status === 200, r.data);
  r = await call("GET", `/api/employer/jobs/${jobA2}`, { token: keyA });
  check("…and they show on the posting", r.data.core_systems?.length === 1 && r.data.core_systems[0] === "fiserv-dna", r.data);
  r = await call("GET", "/api/candidate/matches", { token: ck });
  const nmlsMatch = r.data.matches.find((m) => m.id === nmlsJobId);
  check("a held license is the first reason on a match", nmlsMatch?.reasons[0] === "You hold NMLS (MLO)", nmlsMatch?.reasons);

  // ================================================================
  section("Talent pool: anonymity, blocking and invites");
  r = await call("GET", "/api/employer/talent", { token: keyB });
  check("pool opens for an employer with a live posting; empty before anyone opts in",
    r.status === 200 && r.data.candidates.length === 0, r.data);
  check("their open postings come along for the invite picker", r.data.jobs.some((j) => j.title === "Mortgage Loan Officer"));

  const caseyProfile = { name: "Casey Banks", location: "Florence, AL", work_mode_pref: "hybrid",
    categories: ["lending-credit"], summary: "Ten years in consumer lending at a community bank.",
    licenses: ["nmls"], core_systems: [], linkedin_url: "https://linkedin.com/in/caseybanks" };
  r = await call("PUT", "/api/candidate", { token: ck, body: { ...caseyProfile, pool_visible: true, blocked_employers: "" } });
  check("candidate opts into the pool", r.status === 200);

  r = await call("GET", "/api/employer/talent", { token: keyB });
  const card = r.data.candidates[0];
  check("their anonymous card appears", r.data.candidates.length === 1 && card.location === "Florence, AL", r.data.candidates);
  check("the card carries no identifying details", card && !("name" in card) && !("email" in card)
    && !("phone" in card) && !("linkedin_url" in card) && card.has_resume === true, card);
  r = await call("GET", "/api/employer/talent?category=lending-credit&state=al&license=nmls", { token: keyB });
  check("category, state and license filters match the card", r.data.candidates.length === 1);
  r = await call("GET", "/api/employer/talent?core_system=jack-henry-silverlake", { token: keyB });
  check("a core system they don't have excludes them", r.data.candidates.length === 0);

  outbox().length = 0;
  r = await call("POST", `/api/employer/talent/${card.id}/invite`, { token: keyB, body: { job_id: jobB, note: "Your lending background fits this role." } });
  check("invite sends", r.status === 200 && r.data.ok === true && r.data.duplicate === false, r.data);
  const inviteMail = lastEmailTo("casey@example.test");
  check("invite email names the employer and protects the candidate",
    !!inviteMail?.subject.includes("Tennessee Valley CU") && inviteMail.text.includes("have not seen your name"));
  r = await call("POST", `/api/employer/talent/${card.id}/invite`, { token: keyB, body: { job_id: jobB } });
  check("inviting twice to the same job is caught", r.data.duplicate === true);
  r = await call("POST", `/api/employer/talent/${card.id}/invite`, { token: keyB, body: { job_id: jobA } });
  check("can't invite to another employer's posting", r.status === 400);
  r = await call("GET", "/api/candidate", { token: ck });
  check("candidate sees the invite with its note", r.data.invites.length === 1
    && r.data.invites[0].company === "Tennessee Valley CU" && r.data.invites[0].note === "Your lending background fits this role.", r.data.invites);

  r = await call("PUT", "/api/candidate", { token: ck, body: { ...caseyProfile, pool_visible: true, blocked_employers: "tennessee valley, Some Other Bank" } });
  r = await call("GET", "/api/employer/talent", { token: keyB });
  check("a partial name on the block list hides the card from that employer", r.data.candidates.length === 0);
  r = await call("POST", `/api/employer/talent/${card.id}/invite`, { token: keyB, body: { job_id: jobB } });
  check("a blocked employer can't invite them either", r.status === 404);
  r = await call("PUT", "/api/candidate", { token: ck, body: { ...caseyProfile, pool_visible: false, blocked_employers: "" } });
  r = await call("GET", "/api/employer/talent", { token: keyB });
  check("leaving the pool removes the card", r.data.candidates.length === 0);

  // ================================================================
  section("AI writing assistant");
  const savedAiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  r = await call("GET", "/api/jobs");
  check("without a key the site says AI is off", r.data.ai === false);
  r = await call("POST", "/api/ai/posting", { body: { title: "Teller" } });
  check("…and the assistant declines politely", r.status === 503);
  process.env.ANTHROPIC_API_KEY = savedAiKey;
  r = await call("GET", "/api/jobs");
  check("with a key the site advertises AI", r.data.ai === true);

  r = await call("POST", "/api/ai/posting", { body: {} });
  check("posting draft needs a title", r.status === 400);
  r = await call("POST", "/api/ai/posting", { body: {
    title: "Deposit Operations Specialist", location: "Florence, AL", category: "operations",
    work_mode: "onsite", salary_min: "48000", salary_max: "60000",
    company: "Shoals Community Bank", notes: "wires and ACH, team of 4, Jack Henry shop" } });
  check("posting draft returns a summary and description", r.status === 200
    && r.data.summary.startsWith("Run daily deposit operations") && r.data.description.includes("What you'll bring"), r.data);
  let aiReq = fakeAi.requests.at(-1);
  check("draft prompt carries the employer's facts and the EEO rule",
    aiReq.headers["x-api-key"] === "sk-ant-test-e2e" && aiReq.headers["anthropic-version"] === "2023-06-01"
    && aiReq.body.system.includes("equal-opportunity") && aiReq.body.messages[0].content.includes("Deposit Operations Specialist")
    && aiReq.body.messages[0].content.includes("wires and ACH") && aiReq.body.messages[0].content.includes("$48,000"));

  r = await call("POST", "/api/ai/apply-assist", { body: { job_id: nmlsJobId } });
  check("apply assist needs a signed-in candidate", r.status === 401);
  r = await call("POST", "/api/ai/apply-assist", { token: ck, body: { job_id: 999999 } });
  check("apply assist refuses a closed or unknown job", r.status === 404);
  r = await call("POST", "/api/ai/apply-assist", { token: ck, body: { job_id: nmlsJobId } });
  check("apply assist returns a tailored note and tips", r.status === 200
    && r.data.cover_note.startsWith("I've spent ten years") && r.data.tips.length === 3, r.data);
  aiReq = fakeAi.requests.at(-1);
  check("assist prompt carries the résumé, the job, and the no-inventing rule",
    aiReq.body.system.includes("never invent") && aiReq.body.messages[0].content.includes("consumer lending")
    && aiReq.body.messages[0].content.includes("Consumer Loan Officer"));

  process.env.AI_DAILY_LIMIT = "2";
  r = await call("POST", "/api/ai/apply-assist", { token: ck, body: { job_id: nmlsJobId } });
  check("second use within the limit still works", r.status === 200);
  r = await call("POST", "/api/ai/apply-assist", { token: ck, body: { job_id: nmlsJobId } });
  check("the daily limit stops the third use", r.status === 429);
  delete process.env.AI_DAILY_LIMIT;
  const [{ n: aiRows }] = await sql`SELECT COUNT(*)::int n FROM ai_usage WHERE who LIKE 'candidate:%'`;
  check("usage is logged for the budget", aiRows >= 2, aiRows);

  // The failure modes that once surfaced as "server isn't reachable": each must now be a clear JSON message.
  await sql`DROP TABLE ai_usage`;
  r = await call("POST", "/api/ai/posting", { body: { title: "Teller", notes: "self-heal check" } });
  check("a missing usage table heals itself instead of crashing", r.status === 200
    && (await sql`SELECT to_regclass('ai_usage') AS t`)[0].t !== null, r.data);
  process.env.ANTHROPIC_TIMEOUT_MS = "500";
  r = await call("POST", "/api/ai/posting", { body: { title: "Teller", notes: "SLOW_TEST" } });
  check("a slow AI answer comes back as a clear JSON timeout, not a crash",
    r.status === 504 && /took too long/.test(r.data?.error || ""), { status: r.status, data: r.data });
  delete process.env.ANTHROPIC_TIMEOUT_MS;
  r = await call("POST", "/api/ai/posting", { body: { title: "Teller", notes: "BADKEY_TEST" } });
  check("a rejected API key names the fix for the site owner", /ANTHROPIC_API_KEY/.test(r.data?.error || ""), r.data);
  r = await call("POST", "/api/ai/posting", { body: { title: "Teller", notes: "NOCREDIT_TEST" } });
  check("an out-of-credit account says so", /out of credit/.test(r.data?.error || ""), r.data);


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
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token", body: {
    ...jobFields, title: "Teller II", company: "Agg Bank", source_url: "https://www.tealhq.com/job/teller-ii_abc123" } });
  check("a third-party job-board link is refused outright", r.status === 400 && /third-party/.test(r.data.error), r.data);
  const [{ id: aggId }] = await sql`
    INSERT INTO jobs (title, company, institution_type, location, work_mode, employment_type, category, summary,
                      apply_url, source_name, source_url, expires_at)
    VALUES ('Legacy Teller', 'Agg Bank', 'bank', 'Nowhere, AL', 'onsite', 'full-time', 'branch-retail', 'Old aggregator row.',
            'https://tallo.com/talent/job/legacy-1', 'Tallo', 'https://tallo.com/talent/job/legacy-1', now() + interval '30 days')
    RETURNING id`;
  await sql`UPDATE jobs SET last_checked_at = now() WHERE id <> ${aggId}`;
  r = await runLinkCheck({ limit: 1 });
  check("the daily check closes aggregator-hosted leftovers without even fetching",
    r.aggregator === 1 && r.closed.includes(aggId)
    && (await sql`SELECT status FROM jobs WHERE id = ${aggId}`)[0].status === "closed", r);
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token", body: {
    ...jobFields, title: "Senior Teller", category: "branch-retail", company: "Soft Gone Bank", source_url: `${BASE}/test/gone-posting`, source_name: "Test" } });
  const softId = r.data.id;
  await sql`UPDATE jobs SET last_checked_at = now() WHERE id NOT IN (${goneId}, ${liveId}, ${softId})`;
  r = await runLinkCheck({ limit: 3 });
  const statuses = Object.fromEntries((await sql`SELECT id, status FROM jobs WHERE id IN (${goneId}, ${liveId}, ${softId})`).map((x) => [x.id, x.status]));
  check("dead-link check closes a removed posting", r.closed.includes(goneId) && statuses[goneId] === "closed", r);
  check("…and a page that loads but says the job is gone", r.closed.includes(softId) && statuses[softId] === "closed", r);
  check("…and leaves a working one open", statuses[liveId] === "open");
  r = await call("POST", `/api/admin/jobs/${goneId}/reopen`, { token: "admin_e2e_token" });
  check("admin can reopen a sourced listing", r.status === 200 && (await sql`SELECT status FROM jobs WHERE id = ${goneId}`)[0].status === "open");
  const subB = (await sql`SELECT stripe_subscription_id FROM jobs WHERE id = ${jobB}`)[0].stripe_subscription_id;
  r = await call("POST", `/api/admin/jobs/${jobB}/close`, { token: "admin_e2e_token" });
  check("admin take-down of a paid posting also cancels its billing", r.status === 200 && fakeStripe.subs.get(subB).status === "canceled");
  r = await call("GET", "/api/employer/talent", { token: keyB });
  check("the talent pool closes when the employer's last posting ends", r.status === 403);

  // ================================================================
  section("Institution directory (FDIC + NCUA)");
  r = await call("POST", "/api/admin/institutions/sync", { body: { source: "fdic", offset: 0 } });
  check("directory sync needs the admin key", r.status === 401);
  r = await call("POST", "/api/admin/institutions/sync", { token: "admin_e2e_token", body: { source: "fdic", offset: 0 } });
  check("FDIC sync imports every active bank in one pass",
    r.status === 200 && r.data.imported === FAKE_BANKS.length && r.data.total === FAKE_BANKS.length && r.data.next_offset === null, r.data);
  r = await call("POST", "/api/admin/institutions/sync", { token: "admin_e2e_token", body: { source: "ncua", offset: 0 } });
  check("NCUA sync imports the credit unions", r.data.imported === FAKE_CUS.length && r.data.next_offset === null, r.data);
  r = await call("POST", "/api/admin/institutions/sync", { token: "admin_e2e_token", body: { source: "fdic", offset: 0 } });
  const [{ n: instCount }] = await sql`SELECT COUNT(*)::int n FROM institutions`;
  check("re-running the sync refreshes instead of duplicating",
    r.data.imported === FAKE_BANKS.length && instCount === FAKE_BANKS.length + FAKE_CUS.length, { imported: r.data.imported, instCount });
  const slugs = (await sql`SELECT slug FROM institutions WHERE name = 'First State Bank' ORDER BY regulator_id`).map((x) => x.slug);
  check("two same-named institutions get distinct, stable slugs",
    slugs[0] === "first-state-bank-springfield-il" && slugs[1] === "first-state-bank-springfield-il-1003", slugs);
  const [shoals] = await sql`SELECT * FROM institutions WHERE institution_type = 'bank' AND regulator_id = '1001'`;
  check("ALL-CAPS regulator names become readable", shoals.name === "Shoals Community Bank" && shoals.state === "AL" && shoals.city === "Florence");
  const [linkedJob] = await sql`SELECT institution_id FROM jobs WHERE id = ${jobA}`;
  check("existing postings link to their institution by name", String(linkedJob.institution_id) === String(shoals.id));

  r = await call("GET", "/banks");
  check("directory front page lists institutions and states",
    r.status === 200 && String(r.data).includes("Shoals Community Bank") && String(r.data).includes("/banks/al")
    && String(r.data).includes(`${FAKE_BANKS.length + FAKE_CUS.length} institutions`));
  r = await call("GET", "/banks/al");
  check("state page shows that state's institutions, largest first",
    r.status === 200 && String(r.data).includes("River City National Bank") && String(r.data).includes("$1.9B")
    && String(r.data).includes("Tennessee Valley Credit Union")
    && String(r.data).indexOf("River City National Bank") < String(r.data).indexOf("Shoals Community Bank"));
  r = await call("GET", "/banks/shoals-community-bank-florence-al");
  const shoalsPage = String(r.data);
  check("institution page: facts, FDIC cert, and the bank's open roles via name match",
    r.status === 200 && shoalsPage.includes("Jobs at Shoals Community Bank") && shoalsPage.includes("FDIC cert 1001")
    && shoalsPage.includes("$742M") && shoalsPage.includes("Teller") && !shoalsPage.includes("Branch Manager"),
    { status: r.status, jobs: [...shoalsPage.matchAll(/class="t">([^<]+)/g)].map((x) => x[1]) });
  r = await call("GET", "/banks/muscle-shoals-national-bank-muscle-shoals-al");
  check("an institution's open listings appear on its page",
    r.status === 200 && String(r.data).includes("Consumer Loan Officer"));
  r = await call("GET", "/banks/tennessee-valley-credit-union-muscle-shoals-al");
  check("credit union page renders cleanly without optional figures",
    r.status === 200 && String(r.data).includes("NCUA charter 60001") && !String(r.data).includes("total assets"));
  r = await call("GET", "/banks/not-a-real-bank");
  check("unknown institution 404s with noindex", r.status === 404 && String(r.data).includes("noindex"));
  r = await call("GET", "/sitemap.xml");
  check("sitemap carries the directory pages",
    String(r.data).includes("/banks/al</loc>") && String(r.data).includes("/banks/shoals-community-bank-florence-al</loc>"));
  r = await call("GET", "/api/admin", { token: "admin_e2e_token" });
  check("admin console shows directory counts",
    r.data.directory.banks === FAKE_BANKS.length && r.data.directory.credit_unions === FAKE_CUS.length, r.data.directory);
} catch (err) {
  failed++;
  results.push(`\n  ✗ crashed: ${err.stack}`);
} finally {
  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); fakeStripe.server.close(); registries.server.close(); fakeAi.server.close(); await sql.end?.();
  process.exit(failed ? 1 : 0);
}
