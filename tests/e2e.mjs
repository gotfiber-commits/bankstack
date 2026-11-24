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
  STRIPE_SECRET_KEY: "sk_test_e2e", STRIPE_WEBHOOK_SECRET: "whsec_e2e_secret",
  STRIPE_API_HOST: "localhost", STRIPE_API_PORT: String(STRIPE_PORT), STRIPE_API_PROTOCOL: "http",
  ADMIN_TOKEN: "admin_e2e_token_0123456789abcdef0123", LOCAL_BLOBS_DIR: mkdtempSync(path.join(os.tmpdir(), "bankstack-blobs-")),
  FDIC_API_BASE: `http://localhost:${REGISTRY_PORT}`, NCUA_API_BASE: `http://localhost:${REGISTRY_PORT}`,
  AUTH_MIN_MS: "150",
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

async function call(method, url, { body, token, form, raw, ip } = {}) {
  const headers = {};
  if (ip) headers["x-nf-client-connection-ip"] = ip; // Netlify sets this header itself in production
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
const { runAlertDigest, runLinkCheck, pruneAuth } = await import("../netlify/lib/tasks.mjs");
const { totpAt, currentStep, emailTag } = await import("../netlify/lib/auth.mjs");
// Every throttle counter for an email (per-IP and email-wide, passwords and codes).
const clearThrottle = (email) => sql`DELETE FROM auth_throttle WHERE key LIKE ${"%" + emailTag(email) + "%"}`;
const expireLocks = (email) => sql`UPDATE auth_throttle SET locked_until = now() - interval '1 minute' WHERE key LIKE ${"%" + emailTag(email) + "%"}`;
const { sha256 } = await import("../netlify/lib/shared.mjs");
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
// Posts a job; if the employer has no plan yet, completes the Stripe Checkout that starts one.
async function postJob(token, fields, extra = {}) {
  const r = await call("POST", "/api/checkout", { token, body: { ...fields, ...extra } });
  if (r.data?.url) await pay(lastSession());
  return r;
}
const fakeStripeCall = (p, body) => fetch(`http://localhost:${STRIPE_PORT}${p}`, { method: "POST", body: JSON.stringify(body || {}) });
const invoicesFor = (subId) => fakeStripe.invoices.filter((i) => i.subscription === subId);

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
  section("Employer accounts: sign-up with password + emailed code");
  const PW_A = "Shoals-Teller-Window-42";
  const codeIn = (email) => lastEmailTo(email)?.subject.match(/(\d{6})$/)?.[1];
  // Creates an account the way a hiring manager does: details + password, then the emailed code.
  const signUp = async (fields) => {
    const res = await call("POST", "/api/auth/signup", { body: { password: PW_A, ...fields } });
    const email = fields.email.toLowerCase();
    const verified = res.data?.challenge
      ? await call("POST", "/api/auth/verify", { body: { challenge: res.data.challenge, code: codeIn(email) } }) : null;
    return { res, mail: lastEmailTo(email), key: verified?.data?.token };
  };

  r = await call("POST", "/api/checkout", { body: { ...jobFields, company: "Shoals Community Bank", email: "hr@shoalsbank.test" } });
  check("posting without an account is refused", r.status === 401 && /sign/i.test(r.data.error), r.data);
  r = await call("POST", "/api/auth/signup", { body: { company: "Shoals Community Bank", email: "hr@shoalsbank.test", password: PW_A } });
  check("sign-up needs the manager's name", r.status === 400 && /name/i.test(r.data.error));
  for (const [pw, why] of [["short", "at least 10"], ["password123", "too common"], ["hrshoals-is-me", null]]) {
    r = await call("POST", "/api/auth/signup", { body: { contact_name: "M", company: "S", email: "hrshoals@shoalsbank.test", password: pw } });
    if (why) check(`weak password refused: "${pw}"`, r.status === 400 && r.data.error.includes(why), r.data);
    else check("a password containing the email name is refused", r.status === 400 && /email/i.test(r.data.error), r.data);
  }

  outbox().length = 0;
  r = await call("POST", "/api/auth/signup", { body: { contact_name: "Morgan Hale", contact_title: "HR Manager",
    company: "Shoals Community Bank", email: "HR@shoalsbank.test", institution_type: "bank", password: PW_A } });
  const signupChallenge = r.data.challenge;
  check("sign-up emails a 6-digit confirmation code", r.status === 200 && r.data.method === "email"
    && /^bsc_/.test(signupChallenge) && /^\d{6}$/.test(codeIn("hr@shoalsbank.test") || ""), lastEmailTo("hr@shoalsbank.test")?.subject);
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  check("an unconfirmed account is sent back to confirm its email", r.status === 200 && r.data.purpose === "verify" && r.data.method === "email");
  const freshVerify = r.data.challenge;
  r = await call("POST", "/api/auth/verify", { body: { challenge: freshVerify, code: "000000" } });
  check("a wrong code is refused", r.status === 401);
  r = await call("POST", "/api/auth/verify", { body: { challenge: freshVerify, code: codeIn("hr@shoalsbank.test"), remember_device: true } });
  let keyA = r.data.token;
  const deviceA = r.data.device_token;
  check("the right code confirms the account and signs in", /^bss_/.test(keyA || "") && /^bsd_/.test(deviceA || ""), r.data);
  r = await call("POST", "/api/auth/verify", { body: { challenge: freshVerify, code: codeIn("hr@shoalsbank.test") } });
  check("a code can't be used twice", r.status === 401);
  r = await call("GET", "/api/employer", { token: keyA });
  check("new account has its own empty dashboard with the manager's details",
    r.status === 200 && r.data.jobs.length === 0 && r.data.account.contact_name === "Morgan Hale"
    && r.data.account.contact_title === "HR Manager" && r.data.account.has_billing === false && r.data.account.mfa_method === "email", r.data.account);

  outbox().length = 0;
  r = await call("POST", "/api/auth/signup", { body: { contact_name: "Impostor", company: "Impostor Bank", email: "hr@shoalsbank.test", password: "Totally-New-Password-9" } });
  check("signing up with a taken email looks normal but changes nothing",
    r.status === 200 && /^bsc_/.test(r.data.challenge) && !!lastEmailTo("hr@shoalsbank.test")?.subject.includes("tried to create"));
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: "Totally-New-Password-9" } });
  check("…the impostor's password doesn't work", r.status === 401);
  r = await call("GET", "/api/employer", { token: keyA });
  check("…and the account is untouched", r.data.company === "Shoals Community Bank" && r.data.account.contact_name === "Morgan Hale");

  r = await call("PUT", "/api/employer/account", { token: keyA, body: { contact_name: "", company: "Shoals Community Bank" } });
  check("account edit requires a name", r.status === 400);
  r = await call("PUT", "/api/employer/account", { token: keyA, body: { contact_name: "Morgan Hale", contact_title: "VP, Human Resources",
    company: "Shoals Community Bank", institution_type: "bank", phone: "256-555-0100" } });
  r = await call("GET", "/api/employer", { token: keyA });
  check("account edits save", r.data.account.contact_title === "VP, Human Resources" && r.data.account.phone === "256-555-0100");

  // ================================================================
  section("Attacks found in the security review stay fixed");
  const attackPW = "Prairie-Vault-Lantern-8";
  outbox().length = 0;
  const victim = await signUp({ contact_name: "Pat Reyes", company: "Prairie State Bank", email: "pat@prairie.test", password: attackPW });
  let keyV = victim.key;
  check("a second test employer signs up", /^bss_/.test(keyV || ""));

  // Parallel code guessing: still only 5 tries, and the right code can't be squeezed in afterwards.
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  const raceCh = r.data.challenge, raceCode = codeIn("pat@prairie.test");
  await Promise.all(Array.from({ length: 30 }, (_, i) => call("POST", "/api/auth/verify", { body: { challenge: raceCh, code: String(200000 + i) } })));
  const [{ attempts: raceAttempts }] = await sql`SELECT attempts FROM auth_challenges WHERE token_hash = ${sha256(raceCh)}`;
  r = await call("POST", "/api/auth/verify", { body: { challenge: raceCh, code: raceCode } });
  check("30 parallel guesses at a code are still capped at 5 tries", raceAttempts === 5 && r.status === 401, { raceAttempts, status: r.status });
  check("…and every code try counts toward the email's code limit",
    (await sql`SELECT failures FROM auth_throttle WHERE key LIKE ${"code:" + emailTag("pat@prairie.test") + ":%"}`)[0]?.failures >= 5);
  await clearThrottle("pat@prairie.test");

  // A correct code sent twice at once only makes one session.
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  const twinCh = r.data.challenge, twinCode = codeIn("pat@prairie.test");
  const twins = await Promise.all([1, 2].map(() => call("POST", "/api/auth/verify", { body: { challenge: twinCh, code: twinCode } })));
  check("one code used twice at the same moment signs in only once", twins.filter((x) => x.status === 200).length === 1, twins.map((x) => x.status));

  // Parallel password guessing: every attempt is counted before it's checked, so a burst gets no extra tries.
  await clearThrottle("pat@prairie.test");
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: `Guess-number-${i}-x` } })));
  const checked = burst.filter((x) => x.status === 401).length;
  check("40 parallel wrong passwords: at most 8 are actually checked", checked <= 8 && burst.filter((x) => x.status === 429).length === 40 - checked, checked);
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  check("…and then even the right password is paused", r.status === 429, r.data);
  // The owner can still reset with the emailed code while their password sign-in is paused.
  outbox().length = 0;
  r = await call("POST", "/api/auth/forgot", { body: { email: "pat@prairie.test" } });
  r = await call("POST", "/api/auth/reset", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test"), password: attackPW + "x" } });
  check("a correct reset code works even while password sign-in is paused", r.status === 200, r.data);
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW + "x" } });
  check("…and the reset clears the pause for that device", r.status === 200 && !!r.data.challenge, r.data);
  // Put the original password back (the reset signed every session out, so sign in fresh).
  outbox().length = 0;
  r = await call("POST", "/api/auth/forgot", { body: { email: "pat@prairie.test" } });
  await call("POST", "/api/auth/reset", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test"), password: attackPW } });
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test") } });
  keyV = r.data.token;
  check("…the original password goes back and signs in", /^bss_/.test(keyV || ""), r.data);
  // Someone hammering from elsewhere doesn't lock the owner out of their own network.
  await clearThrottle("pat@prairie.test");
  for (let i = 0; i < 12; i++) await call("POST", "/api/auth/login", { ip: "203.0.113.9", body: { email: "pat@prairie.test", password: `Guess-number-${i}-y` } });
  r = await call("POST", "/api/auth/login", { ip: "203.0.113.9", body: { email: "pat@prairie.test", password: attackPW } });
  const ownerElsewhere = await call("POST", "/api/auth/login", { ip: "198.51.100.20", body: { email: "pat@prairie.test", password: attackPW } });
  check("guessing from one network pauses that network only", r.status === 429 && ownerElsewhere.status === 200, [r.status, ownerElsewhere.status]);
  // …but there's an email-wide ceiling across all networks.
  await clearThrottle("pat@prairie.test");
  for (let i = 0; i < 41; i++) await call("POST", "/api/auth/login", { ip: `203.0.113.${i + 1}`, body: { email: "pat@prairie.test", password: `Guess-number-${i}-z` } });
  r = await call("POST", "/api/auth/login", { ip: "198.51.100.21", body: { email: "pat@prairie.test", password: attackPW } });
  check("guesses spread over 41 networks hit the email-wide ceiling", r.status === 429, r.data);
  await clearThrottle("pat@prairie.test");
  for (let i = 0; i < 9; i++) await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: `Guess-number-${i}-x` } });
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  // The lock looks the same for an email with no account.
  for (let i = 0; i < 8; i++) await call("POST", "/api/auth/login", { body: { email: "ghost@nowhere.test", password: `Guess-number-${i}-x` } });
  const ghost = await call("POST", "/api/auth/login", { body: { email: "ghost@nowhere.test", password: "Anything-at-all-1" } });
  check("an email with no account locks identically (no probing via lockouts)", ghost.status === 429 && ghost.data.error === r.data.error);
  // After a lock expires, one more mistake doesn't instantly re-lock.
  await expireLocks("pat@prairie.test");
  await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: "One-more-mistake-1" } });
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  check("an expired lock starts the count fresh", r.status === 200 && !!r.data.challenge, r.data);
  await clearThrottle("pat@prairie.test");

  // ---- third review: lockouts can't be turned against the owner ----
  const linkIn = (email) => (lastEmailTo(email)?.text || "").match(/#auth=(bsl_[0-9a-f]{48})/)?.[1];
  // E: a client-supplied X-Forwarded-For doesn't buy extra guesses.
  await clearThrottle("pat@prairie.test");
  const spoofed = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${i}.1` },
    body: JSON.stringify({ email: "pat@prairie.test", password: `Spoof-guess-${i}-xx` }) })));
  check("a forged X-Forwarded-For header gets no extra guesses", spoofed.filter((x) => x.status === 401).length <= 8,
    spoofed.filter((x) => x.status === 401).length);
  await clearThrottle("pat@prairie.test");

  // F: successful sign-ins don't fill the email-wide counters.
  for (let i = 0; i < 6; i++) {
    const ok = await call("POST", "/api/auth/login", { ip: `198.51.100.${40 + i}`, body: { email: "pat@prairie.test", password: attackPW } });
    if (ok.status !== 200) check(`successful sign-in ${i}`, false, ok.data);
  }
  const [pwall] = await sql`SELECT failures FROM auth_throttle WHERE key = ${"pwall:" + emailTag("pat@prairie.test")}`;
  check("six successful sign-ins leave the email-wide count at zero", !pwall || pwall.failures === 0, pwall);

  // B: an attacker on many networks maxes out every email-wide counter...
  await clearThrottle("pat@prairie.test");
  outbox().length = 0;
  for (let n = 0; n < 6; n++) {
    const ip = `203.0.114.${n + 1}`;
    for (let i = 0; i < 8; i++) await call("POST", "/api/auth/login", { ip, body: { email: "pat@prairie.test", password: `Spread-guess-${n}-${i}` } });
    for (let c = 0; c < 2; c++) {
      const f = await call("POST", "/api/auth/forgot", { ip, body: { email: "pat@prairie.test" } });
      for (let i = 0; i < 4; i++) await call("POST", "/api/auth/reset", { ip, body: { challenge: f.data.challenge, code: String(300000 + i), password: "Attacker-Pass-123" } });
    }
  }
  const home = "198.51.100.77";
  r = await call("POST", "/api/auth/login", { ip: home, body: { email: "pat@prairie.test", password: attackPW } });
  check("…which pauses password sign-in on new devices", r.status === 429, r.data);
  check("…and the owner is told by email", outbox().some((m) => m.to === "pat@prairie.test" && /many failed sign-in attempts/.test(m.subject)));
  outbox().length = 0;
  const ownerForgot = await call("POST", "/api/auth/forgot", { ip: home, body: { email: "pat@prairie.test" } });
  r = await call("POST", "/api/auth/reset", { ip: home, body: { challenge: ownerForgot.data.challenge, code: codeIn("pat@prairie.test"), password: attackPW } });
  check("…typing the emailed code is paused too, and says to use the email's button", r.status === 429 && /button in the email/.test(r.data.error), r.data);
  const resetLink = linkIn("pat@prairie.test");
  check("reset emails carry a one-click link", /^bsl_/.test(resetLink || ""));
  r = await call("POST", "/api/auth/link", { ip: home, body: { link: resetLink, password: "short" } });
  check("the link refuses a weak password without being used up", r.status === 400);
  r = await call("POST", "/api/auth/link", { ip: home, body: { link: resetLink, password: attackPW } });
  check("…but the owner's emailed link works straight through the lockout", r.status === 200 && r.data.reset === true, r.data);
  r = await call("POST", "/api/auth/link", { ip: home, body: { link: resetLink, password: attackPW } });
  check("…once only", r.status === 401);
  r = await call("POST", "/api/auth/login", { ip: home, body: { email: "pat@prairie.test", password: attackPW } });
  check("…and the reset lifts the password pause", r.status === 200 && !!r.data.challenge, r.data);
  const signInLink = linkIn("pat@prairie.test");
  check("sign-in emails carry a link too", /^bsl_/.test(signInLink || "") && signInLink !== resetLink);
  r = await call("POST", "/api/auth/link", { ip: home, body: { link: signInLink } });
  check("…which signs in on the device that opens it", /^bss_/.test(r.data.token || ""), r.data);
  keyV = r.data.token;
  r = await call("POST", "/api/auth/link", { body: { link: "bsl_" + "0".repeat(48) } });
  check("a made-up link is refused", r.status === 401);

  // A trusted device keeps working while the email-wide password counter is maxed out.
  await clearThrottle("pat@prairie.test");
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test"), remember_device: true } });
  const patDevice = r.data.device_token;
  for (let n = 0; n < 6; n++) for (let i = 0; i < 8; i++) {
    await call("POST", "/api/auth/login", { ip: `203.0.115.${n + 1}`, body: { email: "pat@prairie.test", password: `Spread-guess-${n}-${i}` } });
  }
  r = await call("POST", "/api/auth/login", { ip: home, body: { email: "pat@prairie.test", password: attackPW } });
  const onTrusted = await call("POST", "/api/auth/login", { ip: home, body: { email: "pat@prairie.test", password: attackPW, device_token: patDevice } });
  check("with sign-in paused for new devices, the owner's trusted laptop still gets in",
    r.status === 429 && /^bss_/.test(onTrusted.data.token || ""), [r.status, onTrusted.data]);
  await clearThrottle("pat@prairie.test");

  // A resent code replaces the old link.
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  const firstLink = linkIn("pat@prairie.test");
  await sql`UPDATE auth_challenges SET last_sent_at = now() - interval '1 minute' WHERE token_hash = ${sha256(r.data.challenge)}`;
  await call("POST", "/api/auth/resend", { body: { challenge: r.data.challenge } });
  const secondLink = linkIn("pat@prairie.test");
  const oldLink = await call("POST", "/api/auth/link", { body: { link: firstLink } });
  const newLink = await call("POST", "/api/auth/link", { body: { link: secondLink } });
  check("sending a new code retires the old link", oldLink.status === 401 && newLink.status === 200, [oldLink.status, newLink.status]);

  // ---- fourth review: the email button can't be turned against the owner ----
  r = await call("POST", "/api/auth/link/peek", { body: { link: "bsl_" + "1".repeat(48) } });
  check("checking a made-up link reveals nothing", r.status === 401);
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  const peekLinkVal = linkIn("pat@prairie.test");
  r = await call("POST", "/api/auth/link/peek", { body: { link: peekLinkVal } });
  check("the page learns what a link is for, and whose it is, from the server", r.data.purpose === "login" && r.data.email === "pat@prairie.test", r.data);
  check("links in emails always use the configured site and keep the secret in the #fragment",
    lastEmailTo("pat@prairie.test").text.includes(`${BASE}/#auth=bsl_`));
  const forged = await fetch(`${BASE}/api/auth/forgot`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": "evil.example" },
    body: JSON.stringify({ email: "pat@prairie.test" }) });
  await forged.json();
  check("…even when a request names another host", !lastEmailTo("pat@prairie.test").text.includes("evil.example") && lastEmailTo("pat@prairie.test").text.includes(BASE));

  // An impostor signs up with the owner's email mid-sign-up: the impostor's button can't be confirmed by the owner.
  outbox().length = 0;
  await call("POST", "/api/auth/signup", { body: { contact_name: "Real Rita", company: "Rita Savings", email: "rita@ritabank.test", password: "Copper-Kettle-Morning-4" } });
  const ritaOwnLink = linkIn("rita@ritabank.test");
  await call("POST", "/api/auth/signup", { body: { contact_name: "Mallory", company: "Mallory Fake Bank", email: "rita@ritabank.test", password: "Mallory-Pass-1234" } });
  const malloryLink = linkIn("rita@ritabank.test");
  r = await call("POST", "/api/auth/link/peek", { body: { link: malloryLink } });
  check("a confirmation button shows the account it's for", r.data.purpose === "verify" && r.data.email === "rita@ritabank.test");
  r = await call("POST", "/api/auth/link", { body: { link: malloryLink } });
  check("a confirmation button needs the sign-up's password", r.status === 401);
  r = await call("POST", "/api/auth/link", { body: { link: malloryLink, password: "Copper-Kettle-Morning-4" } });
  check("the owner clicking the impostor's button (with her own password) is refused", r.status === 401 && /didn't sign up/.test(r.data.error), r.data);
  r = await call("POST", "/api/auth/link", { body: { link: ritaOwnLink, password: "Copper-Kettle-Morning-4" } });
  const ritaKey = r.data.token;
  r = await call("GET", "/api/employer", { token: ritaKey });
  check("her own button confirms her own details", r.data?.company === "Rita Savings" && r.data.account.contact_name === "Real Rita", r.data);
  r = await call("POST", "/api/auth/link", { body: { link: malloryLink, password: "Mallory-Pass-1234" } });
  check("…after which the impostor's button is dead, even with the impostor's password", r.status === 401 || r.status === 409);
  r = await call("POST", "/api/auth/login", { body: { email: "rita@ritabank.test", password: "Mallory-Pass-1234" } });
  check("…and the impostor's password doesn't sign in", r.status === 401);

  // An attacker's leftover sign-up can't overwrite an account confirmed later through "forgot password".
  outbox().length = 0;
  const lurk = await call("POST", "/api/auth/signup", { body: { contact_name: "Mallory", company: "Mallory Fake Bank", email: "sam@sambank.test", password: "Mallory-Pass-1234" } });
  r = await call("POST", "/api/auth/forgot", { body: { email: "sam@sambank.test" } });
  r = await call("POST", "/api/auth/reset", { body: { challenge: r.data.challenge, code: codeIn("sam@sambank.test"), password: "Granite-Harbor-Sunrise-6" } });
  check("the real owner confirms through 'forgot password'", r.status === 200);
  await sql`UPDATE auth_challenges SET last_sent_at = now() - interval '1 minute' WHERE token_hash = ${sha256(lurk.data.challenge)}`;
  outbox().length = 0;
  await call("POST", "/api/auth/resend", { body: { challenge: lurk.data.challenge } });
  check("the attacker can't revive their leftover sign-up email", !lastEmailTo("sam@sambank.test"));
  const [{ live: liveCh }] = await sql`SELECT COUNT(*)::int live FROM auth_challenges c JOIN employers e ON e.id = c.employer_id
                              WHERE e.email = 'sam@sambank.test' AND c.consumed_at IS NULL`;
  check("…because a new password retires every outstanding code and link", liveCh === 0, liveCh);
  r = await call("POST", "/api/auth/login", { body: { email: "sam@sambank.test", password: "Granite-Harbor-Sunrise-6" } });
  check("…and the owner's password stands", r.status === 200 && !!r.data.challenge);

  // A stolen trusted-device token gets its own small allowance, then stops being trusted.
  await clearThrottle("pat@prairie.test");
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test"), remember_device: true } });
  const stolenDevice = r.data.device_token;
  let devChecked = 0;
  for (let n = 0; n < 4; n++) for (let i = 0; i < 6; i++) {
    const g = await call("POST", "/api/auth/login", { ip: `203.0.116.${n + 1}`, body: { email: "pat@prairie.test", password: `Device-guess-${n}-${i}`, device_token: stolenDevice } });
    if (g.status === 401) devChecked++;
  }
  const [{ n: devRows }] = await sql`SELECT COUNT(*)::int n FROM employer_devices WHERE token_hash = ${sha256(stolenDevice)}`;
  const [pwallAfter] = await sql`SELECT failures FROM auth_throttle WHERE key = ${"pwall:" + emailTag("pat@prairie.test")}`;
  check("a stolen device token stops being trusted after 10 wrong passwords", devRows === 0, devRows);
  check("…so later guesses count toward the email-wide limit again", (pwallAfter?.failures || 0) >= devChecked - 10 && devChecked - 10 <= 40,
    { devChecked, pwall: pwallAfter?.failures });
  await clearThrottle("pat@prairie.test");
  r = await call("POST", "/api/auth/login", { ip: "198.51.100.90", body: { email: "pat@prairie.test", password: attackPW, device_token: stolenDevice } });
  check("…and that device is no longer trusted (it's asked for a code)", !r.data.token && r.data.method === "email", r.data);

  // The owner's own right code on the attempt that reaches the limit doesn't raise a false alarm.
  await clearThrottle("pat@prairie.test");
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  await sql`INSERT INTO auth_throttle (key, failures, updated_at) VALUES (${"codeall:" + emailTag("pat@prairie.test")}, 9, now())`;
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test") } });
  check("a right code landing on the limit signs in without a false alarm", /^bss_/.test(r.data.token || "")
    && !outbox().some((m) => /many failed/.test(m.subject)), r.data);
  await clearThrottle("pat@prairie.test");

  // C: a wrong password takes the same time whether the email is unconfirmed (many sign-ups), confirmed or unknown.
  for (let i = 0; i < 10; i++) await call("POST", "/api/auth/signup", { ip: `192.0.2.${100 + i}`, body: { contact_name: "Pend", company: "Pend Bank", email: "intake@pendbank.test", password: `Pending-Pass-${i}-abc` } });
  // Five tries each, compared by the middle one, so a busy test machine doesn't cause a false alarm.
  const timeIt = async (email) => { const t = []; for (let i = 0; i < 5; i++) { const s0 = Date.now(); await call("POST", "/api/auth/login", { ip: `192.0.2.${i}`, body: { email, password: "Wrong-Password-xyz" } }); t.push(Date.now() - s0); } return t.sort((a, b) => a - b)[2]; };
  // With a response floor above the real work (production uses 1.2 s), every answer takes the floor.
  process.env.AUTH_MIN_MS = "500";
  const tPend = await timeIt("intake@pendbank.test"), tNone = await timeIt("nobody-at-all@none.test"), tReal = await timeIt("pat@prairie.test");
  process.env.AUTH_MIN_MS = "150";
  check("wrong-password timing matches for unconfirmed, confirmed and unknown emails",
    Math.abs(tPend - tNone) < 60 && Math.abs(tReal - tNone) < 60, { tPend, tNone, tReal });
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "intake@pendbank.test", password: "Pending-Pass-0-abc" } });
  check("the oldest of ten pending sign-ups can still resume confirming", r.status === 200 && r.data.purpose === "verify", r.data);
  await clearThrottle("pat@prairie.test");

  // Decoys behave exactly like real challenges.
  r = await call("POST", "/api/auth/signup", { ip: "198.51.100.200", body: { contact_name: "X", company: "X", email: "pat@prairie.test", password: "Some-Other-Pass-99" } });
  const decoyCh = r.data.challenge;
  r = await call("POST", "/api/auth/forgot", { ip: "198.51.100.200", body: { email: "pat@prairie.test" } });
  const realResetCh = r.data.challenge;
  const decoyVerify = await call("POST", "/api/auth/verify", { body: { challenge: decoyCh, code: "000000" } });
  const realLogin = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  const realVerify = await call("POST", "/api/auth/verify", { body: { challenge: realLogin.data.challenge, code: "000000" } });
  check("a decoy's wrong-code answer matches a real one word for word", decoyVerify.status === realVerify.status
    && decoyVerify.data.error === realVerify.data.error, [decoyVerify.data, realVerify.data]);
  const decoyResend = await call("POST", "/api/auth/resend", { body: { challenge: decoyCh } });
  const realResend = await call("POST", "/api/auth/resend", { body: { challenge: realResetCh } });
  check("…and so does 'send a new code' right away", decoyResend.status === 429 && realResend.status === 429);
  r = await call("POST", "/api/auth/forgot", { body: { email: "nobody-here@nowhere.test" } });
  const ghostReset = await call("POST", "/api/auth/reset", { body: { challenge: r.data.challenge, code: "123456", password: "Brand-New-Pass-123" } });
  const realReset = await call("POST", "/api/auth/reset", { body: { challenge: realResetCh, code: "123456", password: "Brand-New-Pass-123" } });
  check("reset with a wrong code answers the same for real and missing accounts",
    ghostReset.status === realReset.status && ghostReset.data.error === realReset.data.error);
  let t0 = Date.now();
  await call("POST", "/api/auth/forgot", { body: { email: "nobody-else@nowhere.test" } });
  const tGhost = Date.now() - t0;
  check("forgot-password takes at least the fixed minimum time either way", tGhost >= 150, tGhost);
  await clearThrottle("pat@prairie.test");

  // Sign-up for an email that's mid-confirmation can't change it: only the entered code's details apply.
  outbox().length = 0;
  r = await call("POST", "/api/auth/signup", { body: { contact_name: "Real Owner", company: "Owner Savings Bank", email: "owner@owner.test", password: "Harbor-Gate-Lantern-11" } });
  const ownerCh = r.data.challenge, ownerCode = codeIn("owner@owner.test");
  await call("POST", "/api/auth/signup", { body: { contact_name: "Mallory", company: "Mallory Fake Bank", email: "owner@owner.test", password: "Mallory-Pass-1234" } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: ownerCh, code: ownerCode } });
  const keyOwner = r.data.token;
  r = await call("GET", "/api/employer", { token: keyOwner });
  check("an impostor sign-up mid-confirmation changes nothing", r.data.company === "Owner Savings Bank" && r.data.account.contact_name === "Real Owner", r.data.account);
  r = await call("POST", "/api/auth/login", { body: { email: "owner@owner.test", password: "Mallory-Pass-1234" } });
  check("…the impostor's password doesn't work", r.status === 401);
  r = await call("POST", "/api/auth/login", { body: { email: "owner@owner.test", password: "Harbor-Gate-Lantern-11" } });
  check("…the owner's does", r.status === 200 && !!r.data.challenge);

  // Signed up, never entered the code, came back later: the sign-up password resumes confirmation.
  outbox().length = 0;
  await call("POST", "/api/auth/signup", { body: { contact_name: "Late Larry", company: "Late Bank", email: "late@late.test", password: "Quiet-River-Stone-77" } });
  r = await call("POST", "/api/auth/login", { body: { email: "late@late.test", password: "Quiet-River-Stone-77" } });
  check("an unconfirmed sign-up can sign in to finish confirming", r.status === 200 && r.data.purpose === "verify", r.data);
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("late@late.test") } });
  check("…and the new code completes it", /^bss_/.test(r.data.token || ""), r.data);

  // A stolen session can't add its own authenticator app, and two app sign-ins can't share a code.
  r = await call("POST", "/api/employer/security/totp/start", { token: keyV, body: {} });
  check("a session alone can't start authenticator setup", r.status === 401);
  r = await call("POST", "/api/employer/security/totp/start", { token: keyV, body: { current_password: attackPW } });
  const vSecret = r.data.secret;
  r = await call("POST", "/api/employer/security/totp/confirm", { token: keyV, body: { code: totpAt(vSecret, currentStep()) } });
  r = await call("POST", "/api/employer/security/totp/start", { token: keyV, body: { current_password: attackPW } });
  check("an app that's on can't be silently replaced", r.status === 409);
  const twoCh = await Promise.all([1, 2].map(() => call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } })));
  const sameCode = totpAt(vSecret, currentStep() + 1);
  const pair = await Promise.all(twoCh.map((x) => call("POST", "/api/auth/verify", { body: { challenge: x.data.challenge, code: sameCode } })));
  check("one app code sent to two sign-ins at once works only once", pair.filter((x) => x.status === 200).length === 1, pair.map((x) => x.status));
  await clearThrottle("pat@prairie.test");

  // Guessing the current password from inside a session counts toward the lock.
  for (let i = 0; i < 8; i++) await call("POST", "/api/employer/security/recovery-codes", { token: keyV, body: { current_password: `nope-${i}` } });
  r = await call("POST", "/api/employer/security/recovery-codes", { token: keyV, body: { current_password: attackPW } });
  check("8 wrong current-password guesses lock even a signed-in session", r.status === 429);
  await clearThrottle("pat@prairie.test");
  const settingsBurst = await Promise.all(Array.from({ length: 20 }, (_, i) => call("POST", "/api/employer/security/recovery-codes", { token: keyV, body: { current_password: `nope-${i}` } })));
  check("…and a parallel burst there gets at most 8 checks too", settingsBurst.filter((x) => x.status === 401).length <= 8);
  await clearThrottle("pat@prairie.test");

  // Changing the password forgets trusted devices.
  await call("POST", "/api/employer/security/totp/disable", { token: keyV, body: { current_password: attackPW } });
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("pat@prairie.test"), remember_device: true } });
  const vDevice = r.data.device_token;
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: attackPW, device_token: vDevice } });
  check("a trusted device skips the code…", !!r.data.token);
  await call("POST", "/api/employer/security/password", { token: keyV, body: { current_password: attackPW, new_password: "Prairie-Vault-Lantern-9" } });
  r = await call("POST", "/api/auth/login", { body: { email: "pat@prairie.test", password: "Prairie-Vault-Lantern-9", device_token: vDevice } });
  check("…until the password changes; then it asks for a code again", !r.data.token && r.data.method === "email", r.data);

  // ================================================================
  section("Hiring plan: setup and the first posting");
  const tokenOwner = { A: (await sql`SELECT id FROM employers WHERE email = 'hr@shoalsbank.test'`)[0].id, otherKey: keyV };
  r = await call("POST", "/api/checkout", { token: keyA, body: jobFields });
  check("posting before billing is set up says so, and saves nothing", r.status === 503 && /set up/.test(r.data.error)
    && (await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id IS NOT NULL`)[0].n === 0, r.data);
  r = await call("GET", "/api/plan");
  check("the public plan says it isn't configured yet", r.status === 200 && r.data.configured === false);
  r = await call("POST", "/api/admin/billing/plan", { body: { extra_dollars: 15 } });
  check("only the admin can set up billing", r.status === 401);
  r = await call("POST", "/api/admin/billing/plan", { token: "admin_e2e_token_0123456789abcdef0123", body: { extra_dollars: 0.5 } });
  check("a silly per-posting amount is refused", r.status === 400, r.data);
  r = await call("POST", "/api/admin/billing/plan", { token: "admin_e2e_token_0123456789abcdef0123", body: { extra_dollars: 15 } });
  check("admin creates the plan price in Stripe", r.status === 200 && r.data.plan.base_cents === 9900 && r.data.plan.base_limit === 5
    && r.data.plan.plus_cents === 15999 && r.data.plan.plus_limit === 10 && r.data.plan.extra_cents === 1500, r.data);
  const planPriceId = r.data.plan.price_id;
  const pr = fakeStripe.prices.get(planPriceId);
  check("…as one graduated monthly price: $99 for 1–5, $159.99 for 6–10, +$15 each after",
    pr.tiers_mode === "graduated" && pr.recurring.interval === "month"
    && [1, 5, 6, 10, 11, 13].map((q) => fakeStripe.amountFor(pr, q)).join() === "9900,9900,15999,15999,17499,20499");
  r = await call("GET", "/api/plan");
  check("the site reads the prices straight from Stripe", r.data.configured && r.data.plus_cents === 15999 && r.data.extra_cents === 1500, r.data);

  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "" } });
  check("missing title is rejected", r.status === 400 && /title/i.test(r.data.error), r.data);
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, salary_min: 200000, salary_max: 100000 } });
  check("salary min > max is rejected", r.status === 400, r.data);
  r = await call("POST", "/api/checkout", { token: keyA, body: jobFields });
  check("the first posting starts a plan in Stripe Checkout", r.status === 200 && r.data.url?.startsWith("https://checkout.stripe.test"), r.data);
  const jobA = r.data.job_id;
  const sessA = lastSession();
  check("checkout is the plan price, quantity 1, subscription mode", sessA._price === planPriceId && sessA._quantity === 1 && sessA.mode === "subscription");
  check("the subscription is marked as the employer's plan", sessA._subscription_metadata.kind === "plan"
    && sessA._subscription_metadata.employer_id === String(tokenOwner.A) && sessA.metadata.job_id === String(jobA));
  r = await call("GET", `/api/jobs/${jobA}`);
  check("unpaid posting is not public", r.status === 404);

  r = await pay(sessA);
  check("signed checkout webhook accepted", r.status === 200 && r.data.received);
  r = await call("GET", `/api/jobs/${jobA}`);
  check("paid posting is live under the account's institution", r.status === 200 && r.data.direct === true
    && r.data.salary_min === 115000 && r.data.company === "Shoals Community Bank", r.data);
  const liveMail = lastEmailTo("hr@shoalsbank.test");
  check("employer gets a 'posting is live' email that explains the plan", !!liveMail?.subject.includes("live")
    && liveMail.text.includes("$99.00/month for up to 5") && liveMail.text.includes("$159.99/month for up to 10") && liveMail.text.includes("$15.00"), liveMail?.text);

  r = await call("GET", `/api/session?session_id=${sessA.id}`);
  check("returning from Stripe confirms the posting without handing out credentials", r.status === 200 && !("token" in r.data) && r.data.job?.status === "open" && r.data.plan === true, r.data);
  r = await call("GET", `/api/session?session_id=${sessA.id}`, { token: tokenOwner.otherKey });
  check("…and another signed-in account can't use someone else's checkout", r.status === 403);
  r = await call("GET", "/api/jobs");
  check("direct posting is listed first", r.data.jobs[0].id === jobA && r.data.jobs.length === SEED_LEN + 1);
  r = await call("GET", "/api/employer", { token: keyA });
  check("billing appears on the account once paid", r.data.account.has_billing === true && r.data.jobs.length === 1);
  check("the dashboard shows the plan: 1 of 5, $99 a month", r.data.plan.live && r.data.plan.active_postings === 1
    && r.data.plan.this_month_cents === 9900 && r.data.plan.next_bill_cents === 9900 && r.data.plan.tiers.base_limit === 5, r.data.plan);
  const subA = (await sql`SELECT plan_subscription_id FROM employers WHERE email = 'hr@shoalsbank.test'`)[0].plan_subscription_id;
  check("one plan subscription for the institution, charged $99 once", !!subA && invoicesFor(subA).length === 1 && invoicesFor(subA)[0].amount === 9900);

  r = await call("POST", "/api/stripe-webhook", { body: { type: "checkout.session.completed" } });
  check("webhook without a valid signature is rejected", r.status === 400);

  // ================================================================
  section("Signing in: password, then a second factor");
  r = await call("POST", "/api/auth/login", { body: { email: "nobody@nowhere.test", password: PW_A } });
  const unknownMsg = r.data.error;
  check("unknown email is refused", r.status === 401);
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: "Wrong-Password-123" } });
  check("…with the same message as a wrong password (no account probing)", r.status === 401 && r.data.error === unknownMsg);
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A, device_token: deviceA } });
  check("a trusted device signs straight in", r.status === 200 && /^bss_/.test(r.data.token || ""), r.data);
  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  check("a new device needs a code, sent by email", r.status === 200 && r.data.method === "email" && /^\d{6}$/.test(codeIn("hr@shoalsbank.test") || ""));
  const loginCh = r.data.challenge;
  r = await call("POST", "/api/auth/resend", { body: { challenge: loginCh } });
  check("resending right away is throttled", r.status === 429);
  r = await call("POST", "/api/auth/verify", { body: { challenge: loginCh, code: codeIn("hr@shoalsbank.test") } });
  const keyA2 = r.data.token;
  check("password + code signs in", /^bss_/.test(keyA2 || "") && keyA2 !== keyA && !r.data.device_token);

  // Guessing codes: five strikes and the code is dead.
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  const guessCh = r.data.challenge;
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/verify", { body: { challenge: guessCh, code: String(100000 + i) } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: guessCh, code: codeIn("hr@shoalsbank.test") } });
  check("after 5 wrong codes even the right one is refused", r.status === 401);

  // Guessing passwords: a temporary lock.
  const [{ id: shoalsEmpId }] = await sql`SELECT id FROM employers WHERE email = 'hr@shoalsbank.test'`;
  for (let i = 0; i < 8; i++) await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: `Nope-guess-${i}-xx` } });
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  check("8 wrong passwords pause sign-in, even with the right one", r.status === 429 && /paused/.test(r.data.error), r.data);
  await expireLocks("hr@shoalsbank.test");
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A, device_token: deviceA } });
  check("once the pause ends, the right password works and clears the count", r.status === 200
    && (await sql`SELECT COUNT(*)::int n FROM auth_throttle WHERE key LIKE ${"pw:" + emailTag("hr@shoalsbank.test") + ":%"}`)[0].n === 0);

  r = await call("GET", "/api/employer", { token: "bsk_" + "a".repeat(48) });
  check("old-style posting keys no longer work", r.status === 401);
  r = await call("POST", "/api/auth/logout", { token: keyA2 });
  r = await call("GET", "/api/employer", { token: keyA2 });
  check("signing out ends that session", r.status === 401);
  r = await call("GET", "/api/employer", { token: keyA });
  check("…without touching the others", r.status === 200);
  await sql`UPDATE employer_sessions SET last_seen_at = now() - interval '15 days' WHERE token_hash = ${sha256(keyA)}`;
  r = await call("GET", "/api/employer", { token: keyA });
  check("a session idle for 15 days expires", r.status === 401);
  await sql`UPDATE employer_sessions SET last_seen_at = now(), revoked_at = NULL WHERE token_hash = ${sha256(keyA)}`;

  await sql`UPDATE auth_challenges SET expires_at = now() - interval '2 days' WHERE consumed_at IS NOT NULL`;
  const live = (await sql`SELECT COUNT(*)::int n FROM employer_sessions WHERE revoked_at IS NULL AND expires_at > now()`)[0].n;
  r = await pruneAuth();
  check("daily housekeeping clears used codes but keeps live sessions", r.challenges > 0
    && (await sql`SELECT COUNT(*)::int n FROM employer_sessions WHERE revoked_at IS NULL AND expires_at > now()`)[0].n === live, r);

  // ================================================================
  section("Authenticator app, recovery codes and security settings");
  r = await call("GET", "/api/employer/security", { token: keyA });
  check("security page lists this session as current", r.status === 200 && r.data.mfa_method === "email"
    && r.data.sessions.some((x) => x.current) && r.data.trusted_devices >= 1, r.data);
  r = await call("POST", "/api/employer/security/totp/start", { token: keyA });
  check("setting up an authenticator app needs the current password", r.status === 401);
  r = await call("POST", "/api/employer/security/totp/start", { token: keyA, body: { current_password: PW_A } });
  const totpSecret = r.data.secret;
  check("authenticator setup returns a QR code and secret", /^[A-Z2-7]{32}$/.test(totpSecret || "")
    && r.data.qr_svg?.startsWith("<svg") && r.data.otpauth.includes("issuer=BankJobz"), r.data.otpauth);
  r = await call("POST", "/api/employer/security/totp/confirm", { token: keyA, body: { code: "123456" } });
  check("a wrong app code doesn't turn it on", r.status === 400);
  r = await call("POST", "/api/employer/security/totp/confirm", { token: keyA, body: { code: totpAt(totpSecret, currentStep()) } });
  const recovery = r.data.recovery_codes || [];
  check("the right app code turns it on and returns 10 recovery codes", r.status === 200 && recovery.length === 10
    && recovery.every((c) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(c)), r.data);
  check("…and the owner is emailed a security notice", !!lastEmailTo("hr@shoalsbank.test")?.subject.includes("security notice"));

  outbox().length = 0;
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  check("now sign-in asks for the app code, and emails nothing", r.data.method === "totp" && outbox().length === 0, r.data);
  const appCh = r.data.challenge;
  r = await call("POST", "/api/auth/verify", { body: { challenge: appCh, code: totpAt(totpSecret, currentStep()) } });
  check("the app code was already used to set up, so it's refused as a replay", r.status === 401);
  r = await call("POST", "/api/auth/verify", { body: { challenge: appCh, code: totpAt(totpSecret, currentStep() + 1) } });
  check("the next app code signs in (30-second clock drift allowed)", r.status === 200 && /^bss_/.test(r.data.token || ""), r.data);
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: recovery[0].toUpperCase() } });
  check("a recovery code works once (any case)", r.status === 200, r.data);
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: recovery[0] } });
  check("…and never again", r.status === 401);
  r = await call("GET", "/api/employer/security", { token: keyA });
  check("security page shows 9 recovery codes left", r.data.mfa_method === "totp" && r.data.recovery_codes_left === 9);

  r = await call("POST", "/api/employer/security/recovery-codes", { token: keyA, body: { current_password: "nope" } });
  check("new recovery codes need the current password", r.status === 401);
  r = await call("POST", "/api/employer/security/recovery-codes", { token: keyA, body: { current_password: PW_A } });
  check("…and replace the old set", r.data.recovery_codes?.length === 10 && !r.data.recovery_codes.includes(recovery[1]));

  r = await call("GET", "/api/employer/security", { token: keyA });
  const otherSession = r.data.sessions.find((x) => !x.current);
  r = await call("POST", `/api/employer/security/sessions/${otherSession.id}/revoke`, { token: keyA });
  r = await call("GET", "/api/employer/security", { token: keyA });
  check("one other session can be signed out", r.data.sessions.every((x) => String(x.id) !== String(otherSession.id)));
  r = await call("POST", "/api/employer/security/sessions/revoke-others", { token: keyA });
  r = await call("GET", "/api/employer/security", { token: keyA });
  check("'sign out everywhere else' leaves only this session", r.data.sessions.length === 1 && r.data.sessions[0].current);
  r = await call("POST", "/api/employer/security/devices/forget", { token: keyA });
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A, device_token: deviceA } });
  check("forgotten devices have to pass the second factor again", r.data.method === "totp" && !r.data.token);

  r = await call("POST", "/api/employer/security/totp/disable", { token: keyA, body: { current_password: PW_A } });
  r = await call("GET", "/api/employer/security", { token: keyA });
  check("turning the app off falls back to email codes", r.data.mfa_method === "email" && r.data.recovery_codes_left === 0);

  r = await call("POST", "/api/employer/security/password", { token: keyA, body: { current_password: "wrong", new_password: "Another-Strong-Pass-77" } });
  check("password change needs the current password", r.status === 401);
  r = await call("POST", "/api/employer/security/password", { token: keyA, body: { current_password: PW_A, new_password: "short" } });
  check("…and a strong new one", r.status === 400);
  const PW_A_NEW = "Another-Strong-Pass-77";
  r = await call("POST", "/api/employer/security/password", { token: keyA, body: { current_password: PW_A, new_password: PW_A_NEW } });
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A } });
  check("after a change the old password stops working", r.status === 401);
  r = await call("GET", "/api/employer", { token: keyA });
  check("…and this session stays signed in", r.status === 200);

  // Forgot password: emailed code, then a new password. Also how pre-update accounts set one.
  outbox().length = 0;
  r = await call("POST", "/api/auth/forgot", { body: { email: "nobody@nowhere.test" } });
  check("forgot-password for an unknown email looks the same and sends nothing", r.status === 200 && /^bsc_/.test(r.data.challenge) && outbox().length === 0);
  r = await call("POST", "/api/auth/forgot", { body: { email: "hr@shoalsbank.test" } });
  const resetCh = r.data.challenge;
  const resetCode = codeIn("hr@shoalsbank.test");
  check("a reset code is emailed", /^\d{6}$/.test(resetCode || ""));
  r = await call("POST", "/api/auth/reset", { body: { challenge: resetCh, code: resetCode, password: "weak" } });
  check("reset still requires a strong password", r.status === 400);
  const PW_A_RESET = "Reset-Branch-Vault-2026";
  r = await call("POST", "/api/auth/reset", { body: { challenge: resetCh, code: resetCode, password: PW_A_RESET } });
  check("reset sets the new password", r.status === 200);
  r = await call("GET", "/api/employer", { token: keyA });
  check("…and signs out every session, for safety", r.status === 401);
  r = await call("POST", "/api/auth/login", { body: { email: "hr@shoalsbank.test", password: PW_A_RESET } });
  r = await call("POST", "/api/auth/verify", { body: { challenge: r.data.challenge, code: codeIn("hr@shoalsbank.test") } });
  keyA = r.data.token;
  check("then the new password + code signs in", /^bss_/.test(keyA || ""));

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
  check("overview counts views, applicants and the pipeline", r.data.jobs[0].views >= 1 && r.data.stats.applicants === 1
    && r.data.stats.live_postings === 1 && r.data.stats.monthly_cents === 9900 && r.data.pipeline.interview === 1
    && r.data.stats.views === r.data.jobs[0].views, { stats: r.data.stats, pipeline: r.data.pipeline });
  const viewsBefore = r.data.jobs[0].views;
  await call("GET", `/api/jobs/${jobA}`);
  r = await call("GET", "/api/employer", { token: keyA });
  check("each job-page view is counted", r.data.jobs[0].views === viewsBefore + 1);

  r = await call("POST", `/api/employer/applications/${appRow.id}/notes`, { token: keyA, body: { notes: "Strong SQL; ask about =SUM leadership", rating: 4 } });
  check("private notes and a rating save", r.status === 200);
  r = await call("POST", `/api/employer/applications/${appRow.id}/notes`, { token: keyA, body: { notes: "x", rating: 9 } });
  check("ratings outside 1-5 are refused", r.status === 400);
  r = await call("GET", "/api/employer", { token: keyA });
  check("notes and rating come back on the applicant", r.data.applications[0].notes.startsWith("Strong SQL") && r.data.applications[0].rating === 4);

  r = await call("GET", "/api/employer/applications.csv?status=interview", { token: keyA, raw: true });
  const csv = await r.text();
  check("applicants export as CSV, filtered by stage", r.status === 200 && r.headers.get("content-type").includes("text/csv")
    && csv.includes("Dana Whitfield") && csv.includes(",interview,4,") && csv.split("\r\n").filter(Boolean).length === 2, csv.slice(0, 300));
  r = await call("GET", "/api/employer/applications.csv?status=offer", { token: keyA, raw: true });
  check("…an empty filter gives just the header row", (await r.text()).split("\r\n").filter(Boolean).length === 1);
  await call("POST", `/api/employer/applications/${appRow.id}/notes`, { token: keyA, body: { notes: "=HYPERLINK(\"http://evil\")", rating: 4 } });
  r = await call("GET", "/api/employer/applications.csv", { token: keyA, raw: true });
  check("the export defuses spreadsheet formulas", (await r.text()).includes("'=HYPERLINK"));
  await call("POST", `/api/employer/applications/${appRow.id}/notes`, { token: keyA, body: { notes: "Strong SQL", rating: 4 } });
  r = await call("GET", "/api/employer/applications.csv", { raw: true });
  check("the export needs a signed-in employer", r.status === 401);

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

  // A second posting goes straight live under the plan: no checkout, no charge.
  const invBefore = invoicesFor(subA).length;
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Branch Manager", category: "branch-retail" } });
  const jobA2 = r.data.job_id;
  check("a second posting goes live right away under the plan", r.status === 200 && r.data.live === true && !r.data.url && !!jobA2, r.data);
  check("…with no new charge (up to 5 postings is $99)", invoicesFor(subA).length === invBefore && fakeStripe.subs.get(subA).items.data[0].quantity === 2);
  r = await call("GET", `/api/jobs/${jobA2}`);
  check("…and it's public", r.status === 200);
  r = await call("POST", `/api/employer/jobs/${jobA}/publish`, { token: keyA });
  check("publishing a live posting again is refused", r.status === 400);

  // ================================================================
  section("Privacy between employers");
  const tvcu = await signUp({ contact_name: "Riley Shaw", company: "Tennessee Valley CU", email: "jobs@tvcu.test", institution_type: "credit-union" });
  const keyB = tvcu.key;
  r = await postJob(keyB, { ...jobFields, title: "Mortgage Loan Officer", category: "lending-credit" });
  const jobB = r.data.job_id;
  check("second employer is set up", /^bss_/.test(keyB) && keyB !== keyA);
  r = await call("GET", `/api/employer/applications/${appRow.id}/resume`, { token: keyB });
  check("employer B can't download A's applicant résumé", r.status === 404);
  r = await call("PUT", `/api/employer/jobs/${jobA}`, { token: keyB, body: jobFields });
  check("employer B can't edit A's job", r.status === 404);
  r = await call("GET", "/api/employer", { token: keyB });
  check("employer B sees only their own postings", r.data.jobs.length === 1 && r.data.jobs[0].id === jobB && r.data.applications.length === 0);
  r = await call("GET", "/api/employer", { token: "bsk_wrong" });
  check("a wrong key is refused", r.status === 401);
  r = await call("POST", `/api/employer/applications/${appRow.id}/notes`, { token: keyB, body: { notes: "snooping", rating: 1 } });
  check("employer B can't write notes on A's applicant", r.status === 404);
  r = await call("GET", "/api/employer/applications.csv", { token: keyB, raw: true });
  check("employer B's export holds none of A's applicants", !(await r.text()).includes("Dana Whitfield"));
  r = await call("GET", "/api/employer/security", { token: keyA });
  const aSession = r.data.sessions[0].id;
  r = await call("POST", `/api/employer/security/sessions/${aSession}/revoke`, { token: keyB });
  r = await call("GET", "/api/employer", { token: keyA });
  check("employer B can't sign out A's sessions", r.status === 200);

  // Applicant emails can be turned off; applicants still land in the dashboard.
  r = await call("POST", "/api/employer/security/notifications", { token: keyB, body: { notify_each_applicant: false } });
  outbox().length = 0;
  const quietForm = new FormData();
  Object.entries({ job_id: jobB, name: "Quiet Applicant", email: "quiet@example.test" }).forEach(([k, v]) => quietForm.append(k, String(v)));
  r = await call("POST", "/api/apply", { form: quietForm });
  check("with emails off, the employer isn't emailed per applicant", r.status === 200 && !outbox().some((m) => m.to === "jobs@tvcu.test"));
  r = await call("GET", "/api/employer", { token: keyB });
  check("…but the applicant is in their dashboard", r.data.applications.some((a) => a.name === "Quiet Applicant"));
  await call("POST", "/api/employer/security/notifications", { token: keyB, body: { notify_each_applicant: true } });

  // ================================================================
  section("Hiring plan: tiers, upgrades and the next bill");
  const planA = async () => (await call("GET", "/api/employer", { token: keyA })).data.plan;
  const qtyA = () => fakeStripe.subs.get(subA).items.data[0].quantity;
  const custA = fakeStripe.subs.get(subA).customer;
  const roles = (n, tag) => Array.from({ length: n }, (_, i) => ({ ...jobFields, title: `${tag} ${i + 1}` }));
  let inv = invoicesFor(subA).length;

  // Up to 5 active postings: all on the $99 plan.
  const extraA = [];
  for (const f of roles(3, "Teller")) { r = await call("POST", "/api/checkout", { token: keyA, body: f }); extraA.push(r.data.job_id); }
  check("postings 3–5 go live with no charge", extraA.every(Boolean) && invoicesFor(subA).length === inv && qtyA() === 5);
  let plan = await planA();
  check("…the plan shows 5 of 5 at $99", plan.active_postings === 5 && plan.this_month_cents === 9900 && plan.next_bill_cents === 9900, plan);

  // The 6th asks first, because it moves the plan to $159.99.
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Universal Banker" } });
  const sixth = r.data.job_id;
  check("a 6th posting asks before moving the plan to $159.99", r.status === 200 && r.data.needs_confirm === true
    && r.data.count === 6 && r.data.from_cents === 9900 && r.data.to_cents === 15999, r.data);
  check("…and until they confirm it's saved but not live, and nothing is charged", (await call("GET", `/api/jobs/${sixth}`)).status === 404
    && (await sql`SELECT status FROM jobs WHERE id = ${sixth}`)[0].status === "pending" && invoicesFor(subA).length === inv && qtyA() === 5);
  r = await call("POST", `/api/employer/jobs/${sixth}/publish`, { token: keyA, body: { confirm: true } });
  const upCharge = invoicesFor(subA).at(-1);
  check("confirming puts it live and charges the prorated difference today", r.status === 200 && r.data.live && r.data.upgraded === true
    && invoicesFor(subA).length === inv + 1 && upCharge.amount > 0 && upCharge.amount <= 6099 && qtyA() === 6, { r: r.data, upCharge });
  inv = invoicesFor(subA).length;
  plan = await planA();
  check("…the plan shows $159.99 this month and next", plan.active_postings === 6 && plan.this_month_cents === 15999 && plan.next_bill_cents === 15999, plan);

  // Closing postings: no refund for this month, the next bill drops.
  r = await call("POST", `/api/employer/jobs/${extraA[0]}/close`, { token: keyA });
  await call("POST", `/api/employer/jobs/${extraA[1]}/close`, { token: keyA });
  plan = await planA();
  check("closing two postings drops the next bill to $99, with no refund now", r.status === 200 && qtyA() === 4
    && invoicesFor(subA).length === inv && plan.this_month_cents === 15999 && plan.next_bill_cents === 9900 && plan.active_postings === 4, plan);
  check("…and closed postings come off the site", (await call("GET", `/api/jobs/${extraA[0]}`)).status === 404);
  r = await call("POST", `/api/employer/jobs/${extraA[0]}/publish`, { token: keyA });
  check("reopening within the month costs nothing (already paid for 6)", r.status === 200 && r.data.live && !r.data.needs_confirm
    && invoicesFor(subA).length === inv && qtyA() === 5, r.data);
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Replacement role" } });
  check("…and so does getting back to 6 with a new posting", r.data.live === true && !r.data.needs_confirm && invoicesFor(subA).length === inv && qtyA() === 6, r.data);
  for (const f of roles(4, "Analyst")) { r = await call("POST", "/api/checkout", { token: keyA, body: f }); }
  check("7–10 postings stay at $159.99 with no further charge", r.data.live === true && invoicesFor(subA).length === inv && qtyA() === 10);

  // Over 10: $15 for each posting past 10.
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Eleventh role" } });
  check("an 11th posting asks first: $159.99 → $174.99", r.data.needs_confirm && r.data.from_cents === 15999 && r.data.to_cents === 17499, r.data);
  const eleventh = r.data.job_id;
  r = await call("POST", `/api/employer/jobs/${eleventh}/publish`, { token: keyA, body: { confirm: true } });
  check("…and confirming charges up to $15, prorated", r.status === 200 && invoicesFor(subA).at(-1).amount > 0
    && invoicesFor(subA).at(-1).amount <= 1500 && qtyA() === 11);
  inv = invoicesFor(subA).length;

  // A declined card changes nothing.
  await fakeStripeCall(`/test/customers/${custA}/decline`, { decline: true });
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "Declined role" } }, );
  const declinedJob = r.data.job_id;
  r = await call("POST", `/api/employer/jobs/${declinedJob}/publish`, { token: keyA, body: { confirm: true } });
  check("a declined card: the posting stays unpublished, with a clear message", r.status === 402 && /card wasn't charged/.test(r.data.error)
    && (await sql`SELECT status FROM jobs WHERE id = ${declinedJob}`)[0].status === "pending", r.data);
  check("…and the plan is untouched", qtyA() === 11 && invoicesFor(subA).length === inv);
  await fakeStripeCall(`/test/customers/${custA}/decline`, { decline: false });
  r = await call("POST", `/api/employer/jobs/${declinedJob}/publish`, { token: keyA, body: { confirm: true } });
  check("…after updating the card, publishing works", r.status === 200 && qtyA() === 12);

  // Several tabs at once can't miscount or double-charge.
  const burstJobs = await Promise.all(roles(4, "Parallel").map((f) => call("POST", "/api/checkout", { token: keyA, body: { ...f, confirm_upgrade: true } })));
  const activeNow = (await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id = ${tokenOwner.A} AND status = 'open'`)[0].n;
  check("4 postings at once: every one goes live and Stripe's count matches exactly", burstJobs.every((x) => x.data.live) && activeNow === 16 && qtyA() === 16,
    { statuses: burstJobs.map((x) => x.status), activeNow, qty: qtyA() });
  const burstCharged = invoicesFor(subA).slice(inv + 1).reduce((t, i) => t + i.amount, 0);
  check("…and together they're charged no more than 4 × $15", burstCharged > 0 && burstCharged <= 6000, burstCharged);

  // The next month bills what's active then.
  const openIds = (await sql`SELECT id FROM jobs WHERE employer_id = ${tokenOwner.A} AND status = 'open' ORDER BY id`).map((x) => x.id);
  for (const id of openIds.slice(3)) await call("POST", `/api/employer/jobs/${id}/close`, { token: keyA });
  plan = await planA();
  check("closing down to 3 postings: next bill $99, this month still as paid", qtyA() === 3 && plan.next_bill_cents === 9900
    && plan.this_month_cents === fakeStripe.amountFor(fakeStripe.prices.get(planPriceId), 16), plan);
  const before = (await sql`SELECT paid_through FROM jobs WHERE id = ${openIds[0]}`)[0].paid_through;
  await fakeStripeCall(`/test/subscriptions/${subA}`, { renew: true });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(subA));
  check("the renewal bills $99 for the 3 active postings", invoicesFor(subA).at(-1).reason === "subscription_cycle" && invoicesFor(subA).at(-1).amount === 9900);
  plan = await planA();
  const after = (await sql`SELECT paid_through, expires_at FROM jobs WHERE id = ${openIds[0]}`)[0];
  check("…the new month starts at 3 paid, and live postings run through it", plan.paid_postings === 3 && plan.this_month_cents === 9900
    && after.paid_through > before && after.expires_at > after.paid_through, { plan, after });
  r = await call("POST", "/api/checkout", { token: keyA, body: { ...jobFields, title: "New month role" } });
  check("…so in the new month, a 4th posting is free again", r.data.live === true && qtyA() === 4);

  // Ending and keeping the plan.
  r = await call("POST", "/api/employer/plan/cancel", { token: keyA });
  check("cancel the plan: it runs to the end of the month", r.status === 200 && r.data.plan.cancel_at_period_end && fakeStripe.subs.get(subA).cancel_at_period_end === true);
  r = await call("GET", "/api/employer", { token: keyA });
  check("…the dashboard flags it, and postings show their end date", r.data.attention[0]?.reason === "ending" && r.data.plan.next_bill_cents === 0
    && r.data.jobs.filter((j) => j.status === "open").every((j) => j.cancel_at_period_end), r.data.attention);
  r = await call("POST", "/api/employer/plan/resume", { token: keyA });
  check("keep the plan undoes it", r.status === 200 && !r.data.plan.cancel_at_period_end && fakeStripe.subs.get(subA).cancel_at_period_end === false);

  await fakeStripeCall(`/test/subscriptions/${subA}`, { status: "past_due" });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(subA));
  r = await call("GET", `/api/jobs/${jobA}`);
  check("failed card (past due): postings stay up while Stripe retries", r.status === 200);

  await fakeStripeCall(`/test/subscriptions/${subA}`, { status: "canceled" });
  await sendWebhook("customer.subscription.deleted", fakeStripe.subs.get(subA));
  r = await call("GET", `/api/jobs/${jobA}`);
  check("the plan ends: every posting comes down", r.status === 404
    && (await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id = ${tokenOwner.A} AND status = 'open'`)[0].n === 0);
  r = await call("GET", `/jobs/${jobA}`);
  check("ended posting's page is 404 + noindex", r.status === 404 && String(r.data).includes('content="noindex"'));
  r = await call("POST", "/api/apply", { body: { job_id: jobA, name: "Late", email: "late@example.test" } });
  check("can't apply to a closed posting", r.status === 404);
  r = await call("PUT", `/api/employer/jobs/${jobA}`, { token: keyA, body: jobFields });
  check("a closed posting can still be edited before reopening", r.status === 200);

  r = await call("POST", `/api/employer/jobs/${jobA}/publish`, { token: keyA });
  check("reopening with no plan starts a new one in Checkout", r.status === 200 && r.data.url?.startsWith("https://checkout.stripe.test"), r.data);
  await pay(lastSession());
  const subA2 = (await sql`SELECT plan_subscription_id FROM employers WHERE id = ${tokenOwner.A}`)[0].plan_subscription_id;
  r = await call("GET", `/api/jobs/${jobA}`);
  check("…and paying puts it back up on a fresh plan", r.status === 200 && subA2 && subA2 !== subA);
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(subA));
  r = await call("GET", "/api/employer", { token: keyA });
  check("a late event from the old plan doesn't disturb the new one", r.data.plan.live && r.data.plan.active_postings === 1, r.data.plan);

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
  r = await postJob(keyA, { ...jobFields, title: "Data Governance Architect" });
  const jobA3 = r.data.job_id;
  await postJob(keyA, { ...jobFields, title: "Teller", category: "branch-retail" });
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
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: {
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
  section("Early careers: new grads and internships");
  const { isEntryLevel } = await import("../netlify/lib/shared.mjs");
  const seedRows = await sql`SELECT id, title, employment_type, entry_level FROM jobs WHERE source_url IS NOT NULL AND employer_id IS NULL`;
  check("sourced listings are tagged entry level from their title", seedRows.some((j) => j.entry_level)
    && seedRows.every((j) => j.entry_level === isEntryLevel(j.title, j.employment_type)),
    seedRows.filter((j) => j.entry_level !== isEntryLevel(j.title, j.employment_type)).map((j) => j.title));
  check("…teller-type roles in, senior and officer roles out", ["Internal Auditor", "Senior Teller", "Loan Officer", "Analyst II"].every((t) => !isEntryLevel(t))
    && ["Universal Banker I", "Summer Intern", "Graduate Rotational Program", "Member Service Representative"].every((t) => isEntryLevel(t)));
  // The database rule (used once to tag listings already live) agrees with the code's rule.
  const schemaUpdate = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8").match(/UPDATE jobs SET entry_level = true[\s\S]*?;\n/)[0];
  await sql`UPDATE jobs SET entry_level = false WHERE employer_id IS NULL`;
  await sql.query(schemaUpdate);
  const afterSql = await sql`SELECT title, employment_type, entry_level FROM jobs WHERE employer_id IS NULL`;
  check("the schema's tagging of existing listings matches the code exactly", afterSql.every((j) => j.entry_level === isEntryLevel(j.title, j.employment_type)),
    afterSql.filter((j) => j.entry_level !== isEntryLevel(j.title, j.employment_type)).map((j) => j.title));

  r = await postJob(keyA, { ...jobFields, title: "Summer Banking Internship", employment_type: "internship", category: "branch-retail" });
  const internJob = r.data.job_id;
  check("an employer posts an internship under their plan", r.data.live === true, r.data);
  r = await call("GET", `/api/jobs/${internJob}`);
  check("…and it's early-career even without ticking the box", r.data.entry_level === true && r.data.employment_type === "internship");
  r = await postJob(keyA, { ...jobFields, title: "Graduate Analyst", entry_level: "on" });
  const gradJob = r.data.job_id;
  r = await call("GET", `/api/jobs/${gradJob}`);
  check("an employer marks a role 'good for new graduates'", r.data.entry_level === true);
  r = await call("GET", "/api/jobs?level=entry");
  check("?level=entry: entry-level roles only, no internships", r.data.jobs.length > 1 && r.data.jobs.some((j) => j.id === gradJob)
    && r.data.jobs.every((j) => j.entry_level && j.employment_type !== "internship"));
  r = await call("GET", "/api/jobs?level=internship");
  check("?level=internship: internships only", r.data.jobs.length >= 1 && r.data.jobs.every((j) => j.employment_type === "internship")
    && r.data.jobs.some((j) => j.id === internJob));
  r = await call("GET", `/jobs/${gradJob}`);
  check("an entry-level job page tells Google no experience is needed", String(r.data).includes('"experienceRequirements":"no requirements"'));
  r = await call("GET", `/jobs/${jobA}`);
  check("…and other job pages don't", !String(r.data).includes("experienceRequirements"));
  r = await call("PUT", `/api/employer/jobs/${gradJob}`, { token: keyA, body: { ...jobFields, title: "Graduate Analyst" } });
  check("unticking the box on edit takes it off the new-grad list", r.status === 200 && (await call("GET", `/api/jobs/${gradJob}`)).data.entry_level === false);
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: {
    ...jobFields, title: "Universal Banker I", category: "branch-retail", company: "Cherokee Bank", source_url: `${BASE}/terms.html`, source_name: "Test" } });
  check("a sourced listing the admin adds is tagged from its title", r.status === 201 && (await call("GET", `/api/jobs/${r.data.id}`)).data.entry_level === true);

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

  check("the posting writer has room for a full posting and is allowed to use what the role normally involves",
    aiReq.body.max_tokens >= 2000 && aiReq.body.stream === true
    && aiReq.body.system.includes("Build a full posting from your knowledge of how that role works")
    && aiReq.body.system.includes("Never invent facts only the employer can know")
    && aiReq.body.system.includes("8 to 12 bullets"));

  // Streamed drafts: the page fills in as the text arrives.
  const streamDraft = async (body) => {
    const res = await fetch(`${BASE}/api/ai/posting`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, ...body }) });
    return { status: res.status, type: res.headers.get("content-type") || "", text: await res.text() };
  };
  let sd = await streamDraft({ title: "Head Teller" });
  check("a title alone streams back a full posting", sd.status === 200 && sd.type.startsWith("text/plain")
    && /SUMMARY:/.test(sd.text) && /DESCRIPTION:/.test(sd.text) && sd.text.includes("What you'll do") && sd.text.includes("Nice to have"), sd);
  aiReq = fakeAi.requests.at(-1);
  check("…the request carries just the title, and asks for the stream", aiReq.body.stream === true && aiReq.body.messages[0].content.trim() === "Job title: Head Teller");
  sd = await streamDraft({ title: "Member Service Representative", institution_type: "credit-union", company: "TVA Community Credit Union" });
  aiReq = fakeAi.requests.at(-1);
  check("credit unions get member wording", aiReq.body.messages[0].content.includes("Institution type: credit-union")
    && aiReq.body.system.includes('Use "customers" for a bank and "members" for a credit union'));
  sd = await streamDraft({ title: "Teller", notes: "MIDSTREAM_ERR_TEST" });
  check("an error partway through arrives as a marked line the page shows", sd.status === 200
    && sd.text.includes("[[BANKJOBZ_ERROR]] The writing assistant is busy right now"), sd.text.slice(-120));
  process.env.ANTHROPIC_TIMEOUT_MS = "500";
  sd = await streamDraft({ title: "Teller", notes: "SLOW_TEST" });
  check("a slow first byte is still a clear JSON error with the right status", sd.status === 504 && sd.type.includes("application/json") && /took too long/.test(sd.text), sd);
  delete process.env.ANTHROPIC_TIMEOUT_MS;
  sd = await streamDraft({});
  check("a streamed draft still needs a title", sd.status === 400 && sd.type.includes("application/json"));

  const { descriptionHtml } = await import("../netlify/lib/shared.mjs");
  const dh = descriptionHtml("About the role\nYou lead the teller line.\n\nWhat you'll do\n- Audit the vault\n- Approve <overrides>\nApply today.");
  check("descriptions become headings, lists and paragraphs, with everything escaped",
    dh === "<h3>About the role</h3><p>You lead the teller line.</p><h3>What you&#39;ll do</h3><ul><li>Audit the vault</li><li>Approve &lt;overrides&gt;</li></ul><p>Apply today.</p>", dh);

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
  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  const livePlans = await sql`SELECT e.id, (SELECT COUNT(*)::int FROM jobs j WHERE j.employer_id = e.id AND j.status = 'open') AS n
    FROM employers e WHERE e.plan_status IN ('active', 'past_due', 'trialing') AND NOT e.plan_cancel_at_period_end`;
  const expectMrr = livePlans.reduce((t, e) => t + fakeStripe.amountFor(fakeStripe.prices.get(planPriceId), Math.max(1, e.n)), 0);
  const [{ n: paidLiveNow }] = await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id IS NOT NULL AND status = 'open' AND expires_at > now()`;
  const [{ n: unpaidNow }] = await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id IS NOT NULL AND status = 'pending'`;
  check("admin figures: live postings, plans and monthly revenue from Stripe's prices",
    r.status === 200 && r.data.paid_live === paidLiveNow && r.data.mrr_cents === expectMrr && expectMrr > 0 && r.data.unpaid === unpaidNow
    && r.data.live_plans === livePlans.length && r.data.billing.plan.extra_cents === 1500
    && r.data.employer_count === (await sql`SELECT COUNT(*)::int n FROM employers WHERE verified_at IS NOT NULL`)[0].n, {
      paid_live: r.data.paid_live, mrr: r.data.mrr_cents, unpaid: r.data.unpaid, employers: r.data.employer_count });
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: {
    ...jobFields, title: "BSA Analyst", category: "risk-compliance", company: "Gone Bank", source_url: `${BASE}/no-such-posting`, source_name: "Test" } });
  const goneId = r.data.id;
  check("admin adds a sourced listing", r.status === 201);
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: {
    ...jobFields, title: "Staff Accountant", category: "finance-accounting", company: "Live Bank", source_url: `${BASE}/index.html` } });
  const liveId = r.data.id;
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: { ...jobFields, company: "Live Bank", source_url: `${BASE}/index.html` } });
  check("duplicate source link is refused", r.status === 409);
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: {
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
  r = await call("POST", "/api/admin/jobs", { token: "admin_e2e_token_0123456789abcdef0123", body: {
    ...jobFields, title: "Senior Teller", category: "branch-retail", company: "Soft Gone Bank", source_url: `${BASE}/test/gone-posting`, source_name: "Test" } });
  const softId = r.data.id;
  await sql`UPDATE jobs SET last_checked_at = now() WHERE id NOT IN (${goneId}, ${liveId}, ${softId})`;
  r = await runLinkCheck({ limit: 3 });
  const statuses = Object.fromEntries((await sql`SELECT id, status FROM jobs WHERE id IN (${goneId}, ${liveId}, ${softId})`).map((x) => [x.id, x.status]));
  check("dead-link check closes a removed posting", r.closed.includes(goneId) && statuses[goneId] === "closed", r);
  check("…and a page that loads but says the job is gone", r.closed.includes(softId) && statuses[softId] === "closed", r);
  check("…and leaves a working one open", statuses[liveId] === "open");
  r = await call("POST", `/api/admin/jobs/${goneId}/reopen`, { token: "admin_e2e_token_0123456789abcdef0123" });
  check("admin can reopen a sourced listing", r.status === 200 && (await sql`SELECT status FROM jobs WHERE id = ${goneId}`)[0].status === "open");
  const subB = (await sql`SELECT plan_subscription_id FROM employers WHERE email = 'jobs@tvcu.test'`)[0].plan_subscription_id;
  r = await call("POST", `/api/admin/jobs/${jobB}/close`, { token: "admin_e2e_token_0123456789abcdef0123" });
  const takenDown = (await sql`SELECT status, closed_by FROM jobs WHERE id = ${jobB}`)[0];
  check("admin take-down of a plan posting closes it and keeps the plan's count right", r.status === 200 && takenDown.status === "closed"
    && takenDown.closed_by === "admin" && fakeStripe.subs.get(subB).status === "active"
    && fakeStripe.subs.get(subB).items.data[0].quantity === Math.max(1, (await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id = (SELECT id FROM employers WHERE email = 'jobs@tvcu.test') AND status = 'open'`)[0].n));
  r = await call("POST", `/api/employer/jobs/${jobB}/publish`, { token: keyB });
  check("…and the employer can't put a taken-down posting back up", r.status === 400 && /taken down/.test(r.data.error));
  r = await call("GET", "/api/employer/talent", { token: keyB });
  check("the talent pool closes when the employer's last posting ends", r.status === 403);

  // ================================================================
  section("Contact us");
  outbox().length = 0;
  const contactMsg = { name: "Dana Reyes", email: "Dana@FirstShoals.test", organization: "First Shoals Bank", topic: "billing",
    message: "Can we pay annually instead of monthly?\nThanks <b>team</b>" };
  r = await call("POST", "/api/contact", { body: contactMsg, ip: "203.0.113.70" });
  let mail = lastEmailTo("administrator@bankjobz.com");
  check("contact form emails administrator@bankjobz.com with the sender as Reply-To",
    r.status === 200 && r.data.ok && mail && mail.replyTo === "dana@firstshoals.test"
    && mail.subject === "[BankJobz contact] Billing and my plan: Dana Reyes, First Shoals Bank"
    && mail.text.includes("Can we pay annually instead of monthly?\nThanks <b>team</b>") && mail.text.includes("Organization: First Shoals Bank"), { r, mail });
  check("contact email HTML escapes the message", mail && mail.html.includes("Thanks &lt;b&gt;team&lt;/b&gt;") && !mail.html.includes("<b>team</b>"));
  check("nothing is emailed to the address typed in the form", !outbox().some((m) => m.to === "dana@firstshoals.test"));
  let [savedMsg] = await sql`SELECT * FROM contact_messages ORDER BY id DESC LIMIT 1`;
  check("contact message is saved", savedMsg && savedMsg.email === "dana@firstshoals.test" && savedMsg.topic === "billing"
    && savedMsg.organization === "First Shoals Bank" && !savedMsg.net_tag.includes("203.0.113.70"), savedMsg);

  for (const [label, body, want] of [
    ["missing name", { ...contactMsg, name: "  " }, "Add your name."],
    ["bad email", { ...contactMsg, email: "dana@" }, "Add an email address we can reply to."],
    ["unknown topic", { ...contactMsg, topic: "hack" }, "Pick what your message is about."],
    ["too-short message", { ...contactMsg, message: "hi" }, "Add a little more detail to your message."],
  ]) {
    r = await call("POST", "/api/contact", { body, ip: "203.0.113.71" });
    check(`contact form rejects ${label}`, r.status === 400 && r.data.error === want, r);
  }
  r = await call("POST", "/api/contact", { body: "not json{", ip: "203.0.113.71" });
  check("contact form rejects a non-JSON body", r.status === 400);
  r = await call("GET", "/api/contact");
  check("contact endpoint only takes POST", r.status === 405);

  outbox().length = 0;
  const msgsBefore = (await sql`SELECT COUNT(*)::int AS n FROM contact_messages`)[0].n;
  r = await call("POST", "/api/contact", { body: { ...contactMsg, company_website: "http://spam.test" }, ip: "203.0.113.72" });
  check("honeypot: a bot gets ok but nothing is saved or sent", r.status === 200 && r.data.ok && outbox().length === 0
    && (await sql`SELECT COUNT(*)::int AS n FROM contact_messages`)[0].n === msgsBefore);

  r = await call("POST", "/api/contact", { body: { ...contactMsg, name: "Line\r\nBcc: x@evil.test", message: "x".repeat(6000) }, ip: "203.0.113.73" });
  [savedMsg] = await sql`SELECT * FROM contact_messages ORDER BY id DESC LIMIT 1`;
  mail = lastEmailTo("administrator@bankjobz.com");
  check("contact form strips line breaks from the name and caps the message at 5,000 characters",
    r.status === 200 && savedMsg.name === "Line Bcc: x@evil.test" && savedMsg.message.length === 5000 && !/[\r\n]/.test(mail.subject), savedMsg.name);

  // Five an hour per network...
  for (let i = 0; i < 4; i++) await call("POST", "/api/contact", { body: { ...contactMsg, email: `n${i}@rate.test` }, ip: "203.0.113.74" });
  r = await call("POST", "/api/contact", { body: { ...contactMsg, email: "n4@rate.test" }, ip: "203.0.113.74" });
  check("contact form: 5th message from one network is accepted", r.status === 200, r);
  r = await call("POST", "/api/contact", { body: { ...contactMsg, email: "n5@rate.test" }, ip: "203.0.113.74" });
  check("contact form: 6th message in an hour from one network is refused", r.status === 429 && /administrator@bankjobz.com/.test(r.data.error), r);
  // ...and per sender address, across networks.
  for (let i = 0; i < 5; i++) await call("POST", "/api/contact", { body: { ...contactMsg, email: "same@rate.test" }, ip: `198.51.100.${10 + i}` });
  r = await call("POST", "/api/contact", { body: { ...contactMsg, email: "SAME@rate.test" }, ip: "198.51.100.40" });
  check("contact form: 6th message in an hour from one address is refused", r.status === 429, r);
  await sql`UPDATE contact_messages SET created_at = now() - interval '2 hours' WHERE email = 'same@rate.test'`;
  r = await call("POST", "/api/contact", { body: { ...contactMsg, email: "same@rate.test" }, ip: "198.51.100.41" });
  check("contact form: the limit resets after an hour", r.status === 200, r);

  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  check("admin console lists contact messages, newest first",
    r.status === 200 && r.data.messages.length >= 10 && r.data.messages[0].email === "same@rate.test"
    && r.data.messages.some((m) => m.organization === "First Shoals Bank") && !("net_tag" in r.data.messages[0]), r.data.messages?.[0]);
  r = await call("GET", "/api/admin");
  check("contact messages need the admin key", r.status === 401 || r.status === 403, r.status);

  await sql`UPDATE contact_messages SET created_at = now() - interval '400 days' WHERE email = 'dana@firstshoals.test'`;
  r = await pruneAuth();
  check("maintenance deletes contact messages older than a year",
    r.contact >= 1 && (await sql`SELECT COUNT(*)::int AS n FROM contact_messages WHERE email = 'dana@firstshoals.test'`)[0].n === 0, r);

  section("Institution directory (FDIC + NCUA)");
  r = await call("POST", "/api/admin/institutions/sync", { body: { source: "fdic", offset: 0 } });
  check("directory sync needs the admin key", r.status === 401);
  r = await call("POST", "/api/admin/institutions/sync", { token: "admin_e2e_token_0123456789abcdef0123", body: { source: "fdic", offset: 0 } });
  check("FDIC sync imports every active bank in one pass",
    r.status === 200 && r.data.imported === FAKE_BANKS.length && r.data.total === FAKE_BANKS.length && r.data.next_offset === null, r.data);
  r = await call("POST", "/api/admin/institutions/sync", { token: "admin_e2e_token_0123456789abcdef0123", body: { source: "ncua", offset: 0 } });
  check("NCUA sync imports the credit unions", r.data.imported === FAKE_CUS.length && r.data.next_offset === null, r.data);
  r = await call("POST", "/api/admin/institutions/sync", { token: "admin_e2e_token_0123456789abcdef0123", body: { source: "fdic", offset: 0 } });
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
  check("directory pages carry the veteran-owned footer line", String(r.data).includes("A veteran-owned small business. A percentage of every sale goes to help veterans in need."));
  check("credit union page renders cleanly without optional figures",
    r.status === 200 && String(r.data).includes("NCUA charter 60001") && !String(r.data).includes("total assets"));
  r = await call("GET", "/banks/not-a-real-bank");
  check("unknown institution 404s with noindex", r.status === 404 && String(r.data).includes("noindex"));
  r = await call("GET", "/sitemap.xml");
  check("sitemap carries the directory pages",
    String(r.data).includes("/banks/al</loc>") && String(r.data).includes("/banks/shoals-community-bank-florence-al</loc>"));
  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  check("admin console shows directory counts",
    r.data.directory.banks === FAKE_BANKS.length && r.data.directory.credit_unions === FAKE_CUS.length, r.data.directory);

  // ================================================================
  section("Site statistics (no cookies)");
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const geoHeader = (city, code) => Buffer.from(JSON.stringify({ city, country: { code: "US", name: "United States" }, subdivision: { code, name: code } })).toString("base64");
  const hit = (body, { ua = CHROME, ip = "198.51.100.200", geo = geoHeader("Florence", "AL"), extra = {} } = {}) =>
    fetch(BASE + "/api/hit", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "text/plain", "user-agent": ua, "x-nf-client-connection-ip": ip, "x-nf-geo": geo, ...extra } });
  await sql`DELETE FROM page_hits`;
  let hitRes = await hit({ p: "home", l: 1, r: "https://www.linkedin.com/feed/", us: null, um: null, uc: null });
  check("a page view is accepted with 204 and no cookie", hitRes.status === 204 && !hitRes.headers.get("set-cookie"));
  await hit({ p: "jobs" });
  await hit({ p: "job", j: 42 });
  await hit({ p: "home", l: 1, r: BASE + "/#jobs", us: "email", um: "outreach", uc: "hr-intro-nov" }, { ip: "203.0.113.9", ua: IPHONE, geo: geoHeader("Huntsville", "AL") });
  await hit({ p: "home", l: 1, r: "https://www.google.com/" }, { ip: "203.0.113.10", geo: geoHeader("Atlanta", "GA") });
  let hitRows = await sql`SELECT * FROM page_hits ORDER BY id`;
  check("each view stores page, source, approximate location and device, but no IP address",
    hitRows.length === 5 && hitRows[0].ref_host === "linkedin.com" && hitRows[0].landing && hitRows[0].city === "Florence" && hitRows[0].region === "AL"
    && hitRows[0].device === "desktop" && hitRows[0].browser === "Chrome" && hitRows[2].job_id == 42 && !hitRows[1].landing
    && hitRows[3].utm_campaign === "hr-intro-nov" && hitRows[3].ref_host === null && hitRows[3].device === "mobile" && hitRows[3].browser === "Safari"
    && !JSON.stringify(hitRows).includes("198.51.100.200") && !JSON.stringify(hitRows).includes("203.0.113"), hitRows.map((x) => [x.path, x.ref_host, x.city, x.device]));
  check("one person's views share a daily visitor code; different people get different codes",
    hitRows[0].visitor === hitRows[1].visitor && hitRows[1].visitor === hitRows[2].visitor && hitRows[3].visitor !== hitRows[0].visitor && /^[0-9a-f]{32}$/.test(hitRows[0].visitor));
  check("the visitor code is a salted hash, not the IP", !hitRows[0].visitor.includes("198") && (await sql`SELECT COUNT(*)::int n FROM traffic_salts`)[0].n >= 1);
  const hitsBefore = hitRows.length;
  await hit({ p: "home", l: 1 }, { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" });
  await hit({ p: "home", l: 1 }, { ua: "Mozilla/5.0 HeadlessChrome/131.0" });
  await hit({ p: "home", l: 1 }, { extra: { "sec-gpc": "1" } });
  await hit({ p: "home", l: 1 }, { extra: { dnt: "1" } });
  await hit({ p: "<script>" });
  await hit("not json");
  await hit({ p: "home", l: 1, r: "javascript:alert(1)", us: "x".repeat(500) }, { ip: "203.0.113.11" });
  hitRows = await sql`SELECT * FROM page_hits ORDER BY id`;
  check("bots, Global Privacy Control, Do Not Track and junk aren't counted", hitRows.length === hitsBefore + 1, hitRows.length - hitsBefore);
  check("odd referrers are dropped and long tags cut", hitRows.at(-1).ref_host === null && hitRows.at(-1).utm_source.length === 80);
  hitRes = await fetch(BASE + "/api/hit");
  check("the hit endpoint only takes POST", hitRes.status === 405);

  // Sign-ups record where they came from.
  const srcSignup = await call("POST", "/api/auth/signup", { body: { password: PW_A, contact_name: "Lee Park", contact_title: "HR Manager", company: "Source Test Bank", email: "lee@sourcetest.test", institution_type: "bank",
    source: { r: "https://www.linkedin.com/in/x", us: "email", um: "outreach", uc: "hr-intro-nov", lp: "home" } }, ip: "203.0.113.30" });
  await call("POST", "/api/auth/verify", { body: { challenge: srcSignup.data.challenge, code: codeIn("lee@sourcetest.test") } });
  let [srcEmp] = await sql`SELECT signup_source FROM employers WHERE email = 'lee@sourcetest.test'`;
  check("an employer sign-up records its campaign and landing page", srcEmp.signup_source?.utm_campaign === "hr-intro-nov" && srcEmp.signup_source.ref === "linkedin.com"
    && srcEmp.signup_source.landing === "home", srcEmp.signup_source);
  await fetch(BASE + "/api/candidate-auth/request", { method: "POST", headers: { "content-type": "application/json", "x-nf-geo": geoHeader("Tuscaloosa", "AL") },
    body: JSON.stringify({ email: "student@ua.test", name: "Sam Student", source: { us: "career-center", uc: "culverhouse", lp: "new-grads" } }) });
  const [stuRow] = await sql`SELECT signup_source FROM candidates WHERE email = 'student@ua.test'`;
  check("a candidate sign-up records its source and approximate location", stuRow.signup_source?.utm_source === "career-center" && stuRow.signup_source.city === "Tuscaloosa"
    && stuRow.signup_source.region === "AL" && stuRow.signup_source.landing === "new-grads", stuRow.signup_source);

  r = await call("GET", "/api/admin/traffic?days=7", { token: "admin_e2e_token_0123456789abcdef0123" });
  check("admin traffic report: totals and a day-by-day series", r.status === 200 && r.data.days === 7 && r.data.daily.length === 7
    && r.data.totals.views === hitsBefore + 1 && r.data.totals.visitors === 4 && r.data.daily.at(-1).visitors === 4, r.data);
  check("…where visitors come from, with campaigns", r.data.sources.some((x) => x.source === "linkedin.com" && x.visits === 1) && r.data.sources.some((x) => x.source === "email")
    && r.data.sources.some((x) => x.source === "google.com") && r.data.campaigns.some((x) => x.campaign === "hr-intro-nov" && x.source === "email"), r.data.sources);
  check("…top pages, states, cities and devices", r.data.pages[0].path === "home" && r.data.states.some((x) => x.region === "AL" && x.visitors === 3)
    && r.data.cities.some((x) => x.city === "Huntsville") && r.data.devices.some((x) => x.device === "mobile" && x.visitors === 1), { states: r.data.states, devices: r.data.devices });
  check("…and who signed up, with where they came from", r.data.signups.some((e) => e.company === "Source Test Bank" && e.signup_source?.utm_campaign === "hr-intro-nov")
    && r.data.conversions.employer_signups >= 1 && r.data.candidate_sources.some((x) => x.source === "career-center"), r.data.conversions);
  r = await call("GET", "/api/admin/traffic?days=999", { token: "admin_e2e_token_0123456789abcdef0123" });
  check("odd ranges fall back to 30 days", r.data.days === 30 && r.data.daily.length === 30);
  r = await call("GET", "/api/admin/traffic");
  check("the traffic report needs the admin key", r.status === 401);
  await sql`INSERT INTO traffic_salts (day, salt) VALUES (now()::date - 5, 'old')`;
  await sql`INSERT INTO page_hits (day, path, visitor) VALUES (now()::date - 420, 'home', 'x')`;
  const prunedStats = await pruneAuth();
  check("daily maintenance deletes old salts (so codes can't be linked) and views older than 13 months",
    prunedStats.page_hits === 1 && (await sql`SELECT COUNT(*)::int n FROM traffic_salts WHERE salt = 'old'`)[0].n === 0, prunedStats);

  section("Job list caching");
  let jr = await fetch(BASE + "/api/jobs");
  check("the plain job list is cached at the edge briefly; browsers always revalidate",
    /s-maxage=30/.test(jr.headers.get("netlify-cdn-cache-control") || "") && /max-age=0/.test(jr.headers.get("cache-control") || ""), [...jr.headers]);
  jr = await fetch(BASE + "/api/jobs?fresh=123");
  check("a fresh or filtered request is never cached", !jr.headers.get("netlify-cdn-cache-control") && jr.headers.get("cache-control") === "no-store");
  jr = await fetch(BASE + "/api/jobs?category=compliance-risk");
  check("…filtered too", !jr.headers.get("netlify-cdn-cache-control"));

  section("Yearly plans and pay-by-invoice");
  const { remindTrials } = await import("../netlify/lib/billing.mjs");
  const signedUp = async (email, company, extra = {}) => {
    const out = await signUp({ contact_name: "Pat Lee", contact_title: "HR Director", company, email, institution_type: "bank", ...extra });
    if (!out.key) throw new Error(`sign-up failed for ${email}: ${JSON.stringify(out.res.data)}`);
    return out.key;
  };
  const empRow = async (email) => (await sql`SELECT * FROM employers WHERE email = ${email}`)[0];
  r = await call("GET", "/api/plan");
  check("public plan includes the yearly price: ten months' cost, two months free",
    r.data.yearly && r.data.yearly.interval === "year" && r.data.yearly.base_cents === 99000 && r.data.yearly.plus_cents === 159990
    && r.data.yearly.extra_cents === 15000 && r.data.interval === "month", r.data.yearly);

  const keyInv = await signedUp("pat@invoicebank.test", "Invoice Savings Bank");
  const sessionsBefore = fakeStripe.sessions.size;
  r = await call("POST", "/api/checkout", { token: keyInv, body: { ...jobFields, title: "Branch Manager", pay_by: "invoice", billing_interval: "year", billing_email: "nope@" } });
  check("invoice billing needs a valid billing email; the posting stays saved, unpublished",
    r.status === 400 && /email/i.test(r.data.error) && (await sql`SELECT status FROM jobs WHERE title = 'Branch Manager' AND company = 'Invoice Savings Bank'`)[0]?.status === "pending", r.data);
  outbox().length = 0;
  r = await call("POST", "/api/checkout", { token: keyInv, body: { ...jobFields, title: "Universal Banker", pay_by: "invoice", billing_interval: "year",
    billing_email: "AP@InvoiceBank.test", po_number: "PO-2026-77\nx" } });
  let invEmp = await empRow("pat@invoicebank.test");
  let invSub = fakeStripe.subs.get(invEmp.plan_subscription_id);
  check("pay by invoice: the posting goes live at once, with no Checkout", r.status === 200 && r.data.live === true && r.data.invoice === true
    && fakeStripe.sessions.size === sessionsBefore && (await sql`SELECT status FROM jobs WHERE id = ${r.data.job_id}`)[0].status === "open", r.data);
  check("…on a yearly, invoice-billed Stripe subscription due in 30 days",
    invSub?.collection_method === "send_invoice" && invSub.days_until_due === 30 && invSub.items.data[0].price.recurring.interval === "year"
    && invEmp.plan_interval === "year" && invEmp.plan_collection === "send_invoice" && invEmp.plan_status === "active", { invSub, emp: { i: invEmp.plan_interval, c: invEmp.plan_collection } });
  const invCustomer = fakeStripe.customers.get(invEmp.stripe_customer_id);
  check("invoices go to the billing email with the PO number on them",
    invCustomer?.email === "ap@invoicebank.test" && invCustomer.invoice_settings.custom_fields?.[0]?.name === "PO number"
    && invCustomer.invoice_settings.custom_fields[0].value === "PO-2026-77 x", invCustomer);
  check("Stripe invoices the first year: $990", invoicesFor(invSub.id).some((i) => i.reason === "subscription_create" && i.amount === 99000 && i.collection === "send_invoice"));
  let pmail = lastEmailTo("pat@invoicebank.test");
  check("the employer is told the posting is live and where the invoice goes",
    pmail && /live/.test(pmail.subject) && pmail.text.includes("ap@invoicebank.test") && pmail.text.includes("PO-2026-77") && pmail.text.includes("30 days") && /ACH/.test(pmail.text), pmail?.text);
  r = await call("GET", "/api/employer", { token: keyInv });
  check("dashboard plan: yearly, invoice, priced per year",
    r.data.plan.live && r.data.plan.interval === "year" && r.data.plan.collection === "invoice" && r.data.plan.tiers.interval === "year"
    && r.data.plan.this_month_cents === 99000 && r.data.plan.next_bill_cents === 99000, r.data.plan);
  // Publish the saved Branch Manager too, then fill up to 5 and go to a 6th: an invoiced upgrade.
  const bm = (await sql`SELECT id FROM jobs WHERE title = 'Branch Manager' AND company = 'Invoice Savings Bank'`)[0].id;
  r = await call("POST", `/api/employer/jobs/${bm}/publish`, { token: keyInv, body: {} });
  check("a saved posting publishes under the invoice plan at no extra charge", r.status === 200 && r.data.live === true && r.data.interval === "year", r.data);
  for (let i = 3; i <= 5; i++) await call("POST", "/api/checkout", { token: keyInv, body: { ...jobFields, title: `Teller ${i}` } });
  r = await call("POST", "/api/checkout", { token: keyInv, body: { ...jobFields, title: "Teller 6" } });
  check("the 6th posting on a yearly invoice plan asks to confirm the larger yearly price",
    r.data.needs_confirm && r.data.count === 6 && r.data.from_cents === 99000 && r.data.to_cents === 159990 && r.data.interval === "year" && r.data.invoice === true, r.data);
  const updBefore = fakeStripe.updates.length;
  r = await call("POST", `/api/employer/jobs/${r.data.job_id}/publish`, { token: keyInv, body: { confirm: true } });
  const upd = fakeStripe.updates.slice(updBefore).find((u) => u.proration_behavior === "always_invoice");
  check("…and the prorated difference is invoiced, not charged to a card",
    r.status === 200 && r.data.upgraded === true && upd && !upd.payment_behavior
    && invoicesFor(invSub.id).some((i) => i.reason === "subscription_update" && i.amount > 0 && i.collection === "send_invoice"), { r: r.data, upd });
  r = await call("POST", "/api/employer/plan/billing", { token: keyInv, body: { interval: "month" } });
  check("a yearly plan can't switch to monthly mid-term", r.status === 400 && /renews/.test(r.data.error), r.data);
  // The invoice goes past due: postings come down.
  await fakeStripeCall(`/test/subscriptions/${invSub.id}`, { status: "past_due" });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(invSub.id));
  invEmp = await empRow("pat@invoicebank.test");
  const invOpen = (await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id = ${invEmp.id} AND status = 'open'`)[0].n;
  check("an invoice past its due date takes the postings down", invOpen === 0 && invEmp.plan_status === "past_due", { invOpen, status: invEmp.plan_status });
  await fakeStripeCall(`/test/subscriptions/${invSub.id}`, { status: "active" });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(invSub.id));
  r = await call("GET", "/api/employer", { token: keyInv });
  check("once it's paid the plan is live again (postings reopen from the dashboard)", r.data.plan.live === true, r.data.plan);

  // Card, monthly → yearly, → invoice → card.
  const keySw = await signedUp("pat@switchbank.test", "Switch Federal Savings");
  r = await postJob(keySw, { ...jobFields, title: "Loan Processor" });
  let sw = await empRow("pat@switchbank.test");
  check("a card plan starts monthly through Checkout", sw.plan_interval === "month" && sw.plan_collection === "charge_automatically" && sw.plan_status === "active", sw.plan_interval);
  await fakeStripeCall(`/test/customers/${sw.stripe_customer_id}/decline`, { decline: true });
  r = await call("POST", "/api/employer/plan/billing", { token: keySw, body: { interval: "year" } });
  sw = await empRow("pat@switchbank.test");
  check("switching to yearly with a declined card changes nothing", r.status === 402 && sw.plan_interval === "month" && /card/i.test(r.data.error), r.data);
  await fakeStripeCall(`/test/customers/${sw.stripe_customer_id}/decline`, { decline: false });
  r = await call("POST", "/api/employer/plan/billing", { token: keySw, body: { interval: "year" } });
  sw = await empRow("pat@switchbank.test");
  const swInv = invoicesFor(sw.plan_subscription_id).filter((i) => i.reason === "subscription_update").at(-1);
  check("switch to yearly: billed the year now, less credit for the unused month",
    r.status === 200 && r.data.plan.interval === "year" && sw.plan_interval === "year" && swInv && swInv.amount > 99000 - 9900 - 100 && swInv.amount < 99000, { plan: r.data.plan?.interval, swInv });
  r = await call("POST", "/api/employer/plan/billing", { token: keySw, body: { collection: "invoice", billing_email: "ap@switchbank.test", po_number: "" } });
  sw = await empRow("pat@switchbank.test");
  check("switch to invoice billing", r.status === 200 && r.data.plan.collection === "invoice" && fakeStripe.subs.get(sw.plan_subscription_id).collection_method === "send_invoice"
    && fakeStripe.customers.get(sw.stripe_customer_id).email === "ap@switchbank.test", r.data);
  r = await call("POST", "/api/employer/plan/billing", { token: keySw, body: { collection: "card" } });
  check("…and back to card", r.status === 200 && r.data.plan.collection === "card" && fakeStripe.subs.get(sw.plan_subscription_id).collection_method === "charge_automatically", r.data);
  r = await call("POST", "/api/employer/plan/billing", { token: keySw, body: { collection: "invoice", billing_email: "not-an-email" } });
  check("a bad invoice email is refused", r.status === 400, r.data);
  r = await call("POST", "/api/employer/plan/billing", { token: keyV, body: { interval: "year" } });
  check("switching billing needs a live plan", r.status === 404 || r.status === 400, r.data);

  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  const swRow = r.data.employers.find((e) => e.email === "pat@switchbank.test");
  check("admin shows yearly plans as a monthly figure (÷12) and flags invoice billing",
    swRow?.plan?.interval === "year" && swRow.plan.monthly_cents === Math.round(99000 / 12) && r.data.billing.yearly?.base_cents === 99000
    && r.data.employers.find((e) => e.email === "pat@invoicebank.test")?.plan?.invoice === true, swRow?.plan);

  // ================================================================
  section("Claim your listings");
  const [river] = await sql`SELECT * FROM institutions WHERE name = 'River City National Bank'`;
  const [msnb] = await sql`SELECT * FROM institutions WHERE name = 'Muscle Shoals National Bank'`;
  const [fsb1003] = await sql`SELECT * FROM institutions WHERE regulator_id = '1003' AND institution_type = 'bank'`;
  const gathered = [];
  for (const [title, loc] of [["Head Teller", "Decatur, AL"], ["Commercial Lender", "Huntsville, AL"], ["BSA Analyst", "Decatur, AL"]]) {
    const [row] = await sql`INSERT INTO jobs (title, company, institution_type, location, category, summary, apply_url, source_name, source_url, institution_id, expires_at)
      VALUES (${title}, 'River City National Bank', 'bank', ${loc}, 'branch-retail', ${title + " at River City."}, ${"https://rivercity.test/careers/" + gathered.length},
              'River City careers', ${"https://rivercity.test/careers/" + gathered.length}, ${river.id}, now() + interval '30 days') RETURNING id`;
    gathered.push(row.id);
  }
  await sql`INSERT INTO jobs (title, company, institution_type, location, category, summary, apply_url, source_name, source_url, institution_id, status, expires_at)
    VALUES ('Old Closed Role', 'River City National Bank', 'bank', 'Decatur, AL', 'operations', 'Closed.', 'https://rivercity.test/careers/x', 'River City careers',
            'https://rivercity.test/careers/x', ${river.id}, 'closed', now() + interval '30 days')`;
  const riverSlug = river.slug;
  r = await call("GET", `/api/claim/${riverSlug}`);
  check("claim info (public): the institution's open gathered listings, its domain and the trial length",
    r.status === 200 && r.data.institution.name === "River City National Bank" && r.data.institution.domain === "rivercity.test"
    && r.data.jobs.length === 3 && r.data.trial_days === 30 && r.data.claimed === false && r.data.instant === null
    && !r.data.jobs.some((j) => "apply_url" in j), r.data);
  r = await call("GET", "/api/claim/no-such-bank-zz");
  check("unknown institution: 404", r.status === 404);
  r = await call("GET", "/api/claim/BAD%20slug!");
  check("odd slugs are refused", r.status === 404);
  r = await call("POST", `/api/claim/${riverSlug}`, { body: {} });
  check("claiming needs an employer account", r.status === 401 && /sign in/i.test(r.data.error));
  r = await call("GET", `/api/jobs/${gathered[0]}`);
  check("a gathered listing carries its institution's claim slug", r.data.institution_slug === riverSlug && r.data.direct === false, r.data);
  r = await call("GET", `/banks/${riverSlug}`);
  check("institution page invites the bank to claim its listings", String(r.data).includes(`/#claim-${riverSlug}`) && String(r.data).includes("We list 3 of your openings"));

  // A personal email: needs review.
  const keyGm = await signedUp("riverhr.pat@gmail.com", "River City National Bank");
  r = await call("GET", `/api/claim/${riverSlug}`, { token: keyGm });
  check("a personal email is never an instant match", r.data.instant === false, r.data);
  outbox().length = 0;
  r = await call("POST", `/api/claim/${riverSlug}`, { token: keyGm, body: { job_ids: gathered } });
  const adminMail = lastEmailTo("administrator@bankjobz.com");
  check("…so the claim waits for review and the site owner is emailed",
    r.status === 200 && r.data.status === "pending" && adminMail && /Claim to review: River City National Bank/.test(adminMail.subject) && adminMail.replyTo === "riverhr.pat@gmail.com"
    && (await sql`SELECT COUNT(*)::int n FROM jobs WHERE id = ANY(${gathered}) AND employer_id IS NULL`)[0].n === 3, { r: r.data, adminMail: adminMail?.subject });
  r = await call("POST", `/api/claim/${riverSlug}`, { token: keyGm, body: {} });
  check("asking again doesn't duplicate the review or the email", r.data.status === "pending"
    && (await sql`SELECT COUNT(*)::int n FROM institution_claims WHERE institution_id = ${river.id} AND status = 'pending'`)[0].n === 1
    && outbox().filter((m) => m.to === "administrator@bankjobz.com").length === 1);
  r = await call("GET", `/api/claim/${riverSlug}`, { token: keyGm });
  check("their claim shows as pending", r.data.your_claim === "pending");

  // A work email on the bank's own domain: instant, with a free trial.
  const keyRc = await signedUp("pat@rivercity.test", "River City National Bank");
  r = await call("GET", `/api/claim/${riverSlug}`, { token: keyRc });
  check("a work email on the bank's domain is an instant match", r.data.instant === true);
  const subsBefore = fakeStripe.subs.size;
  r = await call("POST", `/api/claim/${riverSlug}`, { token: keyRc, body: { job_ids: [gathered[0], gathered[1], 999999] } });
  let rc = await empRow("pat@rivercity.test");
  const rcSub = fakeStripe.subs.get(rc.plan_subscription_id);
  check("instant claim: the chosen listings become theirs and go live on a free trial",
    r.status === 200 && r.data.status === "approved" && r.data.converted === 2 && r.data.live === 2 && !!r.data.trial_end, r.data);
  check("…a real Stripe trial: no card, ends on its own without one, nothing invoiced",
    fakeStripe.subs.size === subsBefore + 1 && rcSub.status === "trialing" && rcSub.trial_settings?.end_behavior?.missing_payment_method === "cancel"
    && rcSub.items.data[0].quantity === 2 && invoicesFor(rcSub.id).length === 0 && rc.plan_status === "trialing" && !!rc.trial_used_at
    && String(rc.institution_id) === String(river.id), { status: rcSub?.status, q: rcSub?.items.data[0].quantity });
  const moved = await sql`SELECT * FROM jobs WHERE id = ANY(${gathered}) ORDER BY id`;
  check("claimed listings: their account, Direct, live, original link kept for dedupe; the unchosen one stays gathered",
    moved[0].employer_id == rc.id && moved[1].employer_id == rc.id && moved[2].employer_id === null
    && moved[0].status === "open" && moved[0].source_name === null && moved[0].source_url === "https://rivercity.test/careers/0"
    && moved[0].apply_url === "https://rivercity.test/careers/0" && moved[0].is_featured === true, moved.map((j) => [j.employer_id, j.status, j.source_name]));
  r = await call("GET", `/api/jobs/${gathered[0]}`);
  check("a claimed listing shows as Direct with no claim link", r.data.direct === true && r.data.institution_slug === null, r.data);
  r = await call("GET", "/api/employer", { token: keyRc });
  check("their dashboard: the trial, its end date, and the institution",
    r.data.plan.trialing === true && !!r.data.plan.trial_end && r.data.plan.this_month_cents === 0 && r.data.plan.next_bill_cents === 9900
    && r.data.account.institution?.slug === riverSlug && r.data.attention.some((a) => a.reason === "trial"), r.data.plan);
  r = await call("POST", `/api/claim/${riverSlug}`, { token: keyRc, body: {} });
  check("claiming again brings over listings gathered since, under the same trial",
    r.data.status === "approved" && r.data.converted === 1 && r.data.live === 1 && !r.data.trial_end
    && fakeStripe.subs.get(rc.plan_subscription_id).items.data[0].quantity === 3, r.data);
  r = await call("GET", `/api/claim/${riverSlug}`, { token: keyRc });
  check("now it's theirs", r.data.claimed === true && r.data.claimed_by_you === true && r.data.jobs.length === 0);
  r = await call("POST", `/api/claim/${riverSlug}`, { token: keyInv, body: {} });
  check("another account can't claim it", r.status === 409 && /already been claimed/.test(r.data.error), r.data);
  r = await call("POST", `/api/claim/${msnb.slug}`, { token: keyRc, body: {} });
  check("one institution per account", r.status === 409 && /another institution/.test(r.data.error), r.data);
  r = await call("GET", `/banks/${riverSlug}`);
  check("the institution page now says it's managed by the bank", String(r.data).includes("managed by River City National Bank") && !String(r.data).includes(`/#claim-${riverSlug}`));

  // The earlier pending claim can no longer be approved.
  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  const gmClaim = r.data.claims.find((c) => c.email === "riverhr.pat@gmail.com");
  check("admin sees the claim waiting for review, with who and why (asking again with no picks means every listing)", gmClaim && gmClaim.institution === "River City National Bank" && gmClaim.job_count === 0
    && !r.data.claimable.some((c) => c.slug === riverSlug), { gmClaim, claimable: r.data.claimable });
  r = await call("POST", `/api/admin/claims/${gmClaim.id}/approve`, { token: "admin_e2e_token_0123456789abcdef0123", body: {} });
  check("approving a claim for an institution someone else now manages fails cleanly",
    r.status === 409 && (await sql`SELECT status FROM institution_claims WHERE id = ${gmClaim.id}`)[0].status === "rejected", r.data);
  r = await call("POST", `/api/admin/claims/${gmClaim.id}/approve`, { token: "admin_e2e_token_0123456789abcdef0123", body: {} });
  check("a decided claim can't be decided again", r.status === 409);

  // No website on file: reviewed and approved by the site owner.
  const msnbJobs = await sql`SELECT id FROM jobs WHERE employer_id IS NULL AND status = 'open' AND (institution_id = ${msnb.id} OR lower(company) = lower(${msnb.name}))`;
  const keyMs = await signedUp("pat@msnb.test", "Muscle Shoals National Bank");
  r = await call("POST", `/api/claim/${msnb.slug}`, { token: keyMs, body: {} });
  check("no website on file: the claim waits for review", r.data.status === "pending", r.data);
  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  check("admin's pitch list shows unclaimed institutions with listings, and their claim link slug",
    r.data.claimable.some((c) => c.slug === msnb.slug && c.listings >= 1), r.data.claimable);
  const msClaim = r.data.claims.find((c) => c.email === "pat@msnb.test");
  outbox().length = 0;
  r = await call("POST", `/api/admin/claims/${msClaim.id}/approve`, { token: "admin_e2e_token_0123456789abcdef0123", body: {} });
  const ms = await empRow("pat@msnb.test");
  pmail = lastEmailTo("pat@msnb.test");
  check("admin approves: listings move, the trial starts, and they're emailed",
    r.status === 200 && r.data.status === "approved" && r.data.converted === msnbJobs.length && r.data.live === msnbJobs.length
    && ms.plan_status === "trialing" && pmail && /Approved/.test(pmail.subject) && /free until/.test(pmail.text), { r: r.data, mail: pmail?.text });

  // Rejected with a note.
  const keyFs = await signedUp("pat@notfsbil.test", "First State Bank");
  r = await call("POST", `/api/claim/${fsb1003.slug}`, { token: keyFs, body: {} });
  const fsClaim = (await sql`SELECT id FROM institution_claims WHERE institution_id = ${fsb1003.id} AND status = 'pending'`)[0];
  outbox().length = 0;
  r = await call("POST", `/api/admin/claims/${fsClaim.id}/reject`, { token: "admin_e2e_token_0123456789abcdef0123", body: { note: "We couldn't reach you at the bank's main number." } });
  pmail = lastEmailTo("pat@notfsbil.test");
  check("admin rejects with a note: they're told why", r.data.status === "rejected" && pmail && pmail.text.includes("main number"), pmail?.text);
  r = await call("POST", "/api/admin/claims/1/approve", {});
  check("deciding claims needs the admin key", r.status === 401);

  // A claimed institution with nothing gathered: the first posting starts the trial, no Checkout.
  const [fsb1002] = await sql`SELECT * FROM institutions WHERE regulator_id = '1002' AND institution_type = 'bank'`;
  const keyF2 = await signedUp("pat@fsb1002.test", "First State Bank of Springfield");
  r = await call("POST", `/api/claim/${fsb1002.slug}`, { token: keyF2, body: {} });
  const f2Claim = (await sql`SELECT id FROM institution_claims WHERE institution_id = ${fsb1002.id} AND status = 'pending'`)[0];
  r = await call("POST", `/api/admin/claims/${f2Claim.id}/approve`, { token: "admin_e2e_token_0123456789abcdef0123", body: {} });
  check("approved with no listings to move: nothing starts yet", r.data.status === "approved" && r.data.converted === 0 && !(await empRow("pat@fsb1002.test")).plan_subscription_id, r.data);
  r = await call("GET", "/api/employer", { token: keyF2 });
  check("their plan panel offers the free trial", r.data.plan.trial_available === true && r.data.plan.trial_days === 30, r.data.plan);
  const sessCount = fakeStripe.sessions.size;
  r = await call("POST", "/api/checkout", { token: keyF2, body: { ...jobFields, title: "Mortgage Loan Officer" } });
  const f2 = await empRow("pat@fsb1002.test");
  check("…and their first posting starts it: live, no Checkout, no card",
    r.status === 200 && r.data.live === true && r.data.trial === true && fakeStripe.sessions.size === sessCount && f2.plan_status === "trialing", r.data);

  // Trial reminder, then the trial ends without a card.
  await fakeStripeCall(`/test/subscriptions/${rc.plan_subscription_id}`, { trial_ending_in_days: 2 });
  await sendWebhook("customer.subscription.updated", fakeStripe.subs.get(rc.plan_subscription_id));
  outbox().length = 0;
  const sentReminders = await remindTrials();
  pmail = lastEmailTo("pat@rivercity.test");
  check("a few days before a trial ends, the employer is reminded what happens next",
    sentReminders >= 1 && pmail && /free trial ends/.test(pmail.subject) && /add a card/.test(pmail.text) && /won't be charged/.test(pmail.text) && pmail.text.includes("$99/month"), pmail?.text);
  check("…once", (await remindTrials()) === 0);
  await fakeStripeCall(`/test/subscriptions/${rc.plan_subscription_id}`, { status: "canceled" });
  await sendWebhook("customer.subscription.deleted", fakeStripe.subs.get(rc.plan_subscription_id));
  const rcOpen = (await sql`SELECT COUNT(*)::int n FROM jobs WHERE employer_id = ${rc.id} AND status = 'open'`)[0].n;
  r = await call("GET", "/api/employer", { token: keyRc });
  check("a trial that ends without a card takes the postings down and isn't offered again",
    rcOpen === 0 && r.data.plan.live === false && r.data.plan.trial_available === false, { rcOpen, plan: r.data.plan });
  r = await call("POST", "/api/employer/jobs/" + gathered[0] + "/publish", { token: keyRc, body: {} });
  check("…reopening a posting then starts a paid plan through Checkout", r.status === 200 && !!r.data.url, r.data);

  // ================================================================
  section("NMLS-verified candidates");
  outbox().length = 0;
  await call("POST", "/api/candidate-auth/request", { body: { email: "nora@example.test", name: "Nora Lane" } });
  const nlink = lastEmailTo("nora@example.test")?.text.match(/clogin=([a-f0-9]{48})/)?.[1];
  const ckN = (await call("POST", "/api/candidate-auth/verify", { body: { token: nlink } })).data.token;
  const nProfile = { name: "Nora Lane", location: "Decatur, AL", work_mode_pref: "any", categories: ["lending-credit"], summary: "Mortgage loan originator, 8 years.", pool_visible: true };
  r = await call("PUT", "/api/candidate", { token: ckN, body: { ...nProfile, nmls_id: "12ab" } });
  check("an NMLS ID must be a number", r.status === 400 && /NMLS/.test(r.data.error));
  r = await call("PUT", "/api/candidate", { token: ckN, body: { ...nProfile, nmls_id: " NMLS# 0123-456 " } });
  r = await call("GET", "/api/candidate", { token: ckN });
  check("a new NMLS ID is cleaned up and waits for review", r.data.candidate.nmls_id === "123456" && r.data.candidate.nmls_status === "pending", r.data.candidate);
  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  const nRow = r.data.nmls.find((c) => c.email === "nora@example.test");
  check("admin's NMLS queue lists it", nRow && nRow.nmls_id === "123456" && nRow.name === "Nora Lane", r.data.nmls);
  outbox().length = 0;
  r = await call("POST", `/api/admin/candidates/${nRow.id}/nmls/verify`, { token: "admin_e2e_token_0123456789abcdef0123", body: {} });
  pmail = lastEmailTo("nora@example.test");
  check("admin verifies after checking NMLS by hand; the candidate is emailed", r.status === 200 && pmail && /verified/.test(pmail.subject));
  r = await call("POST", `/api/admin/candidates/${nRow.id}/nmls/verify`, { token: "admin_e2e_token_0123456789abcdef0123", body: {} });
  check("it can't be verified twice", r.status === 409);
  r = await call("GET", "/api/candidate", { token: ckN });
  check("the profile shows it verified, with the date", r.data.candidate.nmls_status === "verified" && !!r.data.candidate.nmls_checked_at);
  r = await call("PUT", "/api/candidate", { token: ckN, body: { ...nProfile } });
  check("saving the profile without the field leaves the badge alone",
    (await call("GET", "/api/candidate", { token: ckN })).data.candidate.nmls_status === "verified");
  // Apply to a direct posting: the employer sees the badge and can check NMLS themselves.
  const [msJob] = await sql`SELECT id FROM jobs WHERE employer_id = ${ms.id} AND status = 'open' LIMIT 1`;
  await sql`UPDATE jobs SET apply_url = NULL WHERE id = ${msJob.id}`;
  form = new FormData();
  form.append("resume", new Blob([makePdf("Nora Lane, Decatur Alabama. Mortgage loan originator, eight years, NMLS licensed.")], { type: "application/pdf" }), "Nora Lane.pdf");
  await call("POST", "/api/candidate/resume", { token: ckN, form });
  r = await call("POST", "/api/candidate/apply", { token: ckN, body: { job_id: msJob.id } });
  check("verified candidate applies", r.status === 200, r.data);
  r = await call("GET", "/api/employer", { token: keyMs });
  const nApp = r.data.applications.find((a) => a.email === "nora@example.test");
  check("the employer sees the NMLS ID and its verified status", nApp?.nmls_id === "123456" && nApp.nmls_status === "verified", nApp);
  r = await call("GET", "/api/employer/applications.csv", { token: keyMs });
  check("…and it's in the applicant export", String(r.data).includes("NMLS ID") && String(r.data).includes("123456 (verified)"));
  r = await call("GET", "/api/employer/talent?nmls=verified", { token: keyMs });
  const nCard = r.data.candidates?.find((c) => c.summary === "Mortgage loan originator, 8 years.");
  check("talent pool: filter to NMLS verified; the card shows the badge but not the ID (it would identify them)",
    r.status === 200 && nCard?.nmls_verified === true && !JSON.stringify(nCard).includes("123456") && r.data.candidates.every((c) => c.nmls_verified), r.data.candidates?.length);
  r = await call("PUT", "/api/candidate", { token: ckN, body: { ...nProfile, name: "Nora Lane-Smith" } });
  r = await call("GET", "/api/candidate", { token: ckN });
  check("changing the name on a verified ID sends it back for review", r.data.candidate.nmls_status === "pending", r.data.candidate.nmls_status);
  r = await call("GET", "/api/admin", { token: "admin_e2e_token_0123456789abcdef0123" });
  const nRow2 = r.data.nmls.find((c) => c.email === "nora@example.test");
  outbox().length = 0;
  r = await call("POST", `/api/admin/candidates/${nRow2.id}/nmls/reject`, { token: "admin_e2e_token_0123456789abcdef0123", body: { note: "Name on NMLS is Nora Lane" } });
  pmail = lastEmailTo("nora@example.test");
  r = await call("GET", "/api/candidate", { token: ckN });
  check("a mismatch is rejected with a note the candidate sees", r.data.candidate.nmls_status === "rejected" && r.data.candidate.nmls_note === "Name on NMLS is Nora Lane"
    && pmail && pmail.text.includes("Name on NMLS is Nora Lane"), r.data.candidate);
  r = await call("PUT", "/api/candidate", { token: ckN, body: { ...nProfile, nmls_id: "" } });
  r = await call("GET", "/api/candidate", { token: ckN });
  check("clearing the ID clears the status", r.data.candidate.nmls_id === "" && r.data.candidate.nmls_status === "none");
  r = await call("POST", `/api/admin/candidates/${nRow2.id}/nmls/verify`, {});
  check("NMLS review needs the admin key", r.status === 401);

  // ================================================================
  section("Security headers and rate limits");
  const shared = await import("../netlify/lib/shared.mjs");
  const { staticHeaders } = await import("./local-server.mjs");
  const tomlHeaders = Object.fromEntries(Object.entries(await staticHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
  check("netlify.toml sends exactly the page headers the functions send",
    JSON.stringify(Object.entries(tomlHeaders).sort()) === JSON.stringify(Object.entries(shared.PAGE_HEADERS).sort()), tomlHeaders);
  const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const inlineScripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const bootHash = "sha256-" + (await import("node:crypto")).createHash("sha256").update(inlineScripts[0] || "").digest("base64");
  check("index.html has exactly one inline script, and the CSP allows it by its hash",
    inlineScripts.length === 1 && bootHash === shared.BOOT_SCRIPT_HASH && shared.PAGE_CSP.includes(`'${bootHash}'`), bootHash);
  check("no inline event handlers or javascript: links in the HTML (the CSP would block them)",
    !/\son[a-z]+\s*=/i.test(indexHtml.replace(/<script>[\s\S]*?<\/script>/g, "")) && !/javascript:/i.test(indexHtml));
  check("the CSP allows no inline or eval'd script", !/unsafe-inline[^;]*;/.test(shared.PAGE_CSP.split("script-src")[1].split(";")[0] + ";") && !shared.PAGE_CSP.includes("unsafe-eval"));
  const hdr = (res, name) => res.headers.get(name) || "";
  r = await fetch(`${BASE}/`);
  check("the static site is served with CSP, HSTS, nosniff and no framing",
    hdr(r, "content-security-policy") === shared.PAGE_CSP && /max-age=31536000/.test(hdr(r, "strict-transport-security"))
    && hdr(r, "x-content-type-options") === "nosniff" && hdr(r, "x-frame-options") === "DENY" && hdr(r, "cross-origin-opener-policy") === "same-origin");
  r = await fetch(`${BASE}/api/jobs`);
  check("API answers carry the locked-down policy too", hdr(r, "content-security-policy") === "default-src 'none'; frame-ancestors 'none'"
    && hdr(r, "x-content-type-options") === "nosniff" && hdr(r, "x-frame-options") === "DENY" && /max-age/.test(hdr(r, "strict-transport-security")));
  const [openJob] = await sql`SELECT id FROM jobs WHERE status = 'open' AND expires_at > now() AND employer_id IS NOT NULL LIMIT 1`;
  r = await fetch(`${BASE}/jobs/${openJob.id}`);
  check("server-rendered job pages carry the page CSP (Netlify doesn't add headers to functions)",
    r.status === 200 && hdr(r, "content-security-policy") === shared.PAGE_CSP && hdr(r, "x-frame-options") === "DENY");
  r = await fetch(`${BASE}/jobs/99999999`);
  check("…and so does a job page that's gone", r.status === 404 && hdr(r, "content-security-policy") === shared.PAGE_CSP);
  r = await fetch(`${BASE}/banks`);
  check("bank directory pages carry the page CSP", hdr(r, "content-security-policy") === shared.PAGE_CSP);
  r = await call("GET", "/api/alerts/confirm?token=nope", { raw: true });
  check("redirects carry the base headers", r.status === 303 && hdr(r, "x-content-type-options") === "nosniff");

  // Search engines: the home page carries real text, a descriptive title, brand data and icons;
  // job pages carry only their own canonical, share tags and data.
  r = await fetch(`${BASE}/`);
  const homeHtml = await r.text();
  const ldBlocks = [...homeHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const site = ldBlocks.flat().find((x) => x["@type"] === "WebSite");
  check("home page: descriptive title and one canonical", /<title>BankJobz \| Jobs at Banks &amp; Credit Unions<\/title>/.test(homeHtml)
    && (homeHtml.match(/rel="canonical"/g) || []).length === 1);
  check("home page: the headline and intro are in the HTML itself, before any script runs",
    /<h1>The job board for <em>banks and credit unions<\/em>.<\/h1>/.test(homeHtml) && /tellers and loan officers/.test(homeHtml));
  check("home page: WebSite data names the site BankJobz, also known as Bank Jobz", site?.name === "BankJobz" && site.alternateName.includes("Bank Jobz"), site);
  check("home page: share image and favicon tags", /og:image" content="https:\/\/bankjobz.com\/og-image.png"/.test(homeHtml) && /rel="icon" href="\/favicon.svg"/.test(homeHtml));
  for (const f of ["/favicon.svg", "/favicon-48.png", "/apple-touch-icon.png", "/icon-192.png", "/og-image.png"]) {
    const fr = await fetch(BASE + f);
    check(`${f} is served`, fr.status === 200 && (await fr.arrayBuffer()).byteLength > 300);
  }
  const jobHtml = await (await fetch(`${BASE}/jobs/${openJob.id}`)).text();
  check("job pages: exactly one canonical, their own", (jobHtml.match(/rel="canonical"/g) || []).length === 1 && jobHtml.includes(`rel="canonical" href="${BASE}/jobs/${openJob.id}"`));
  check("job pages: no home hero, no site-wide data, one set of share tags",
    !jobHtml.includes("HOME-STATIC") && !jobHtml.includes('"WebSite"') && (jobHtml.match(/og:title/g) || []).length === 1
    && (jobHtml.match(/og:image/g) || []).length === 1 && /"JobPosting"/.test(jobHtml));
  check("job pages keep the favicon", /rel="icon" href="\/favicon.svg"/.test(jobHtml));

  // The admin console stays shut with a short key.
  const realAdmin = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "short-key-123";
  r = await call("GET", "/api/admin", { token: "short-key-123" });
  process.env.ADMIN_TOKEN = realAdmin;
  check("a short ADMIN_TOKEN keeps the admin console shut", r.status === 503 && /32 characters/.test(r.data.error), r.data);

  // Candidate sign-in links: 5 per inbox per network an hour, 20 per inbox, 60 per network.
  const rlIp = "203.0.113.90";
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call("POST", "/api/candidate-auth/request", { ip: rlIp, body: { email: "flood@example.test" } })).status);
  check("sign-in links: a 6th request for one inbox from one network is refused", codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429, codes);
  r = await call("POST", "/api/candidate-auth/request", { ip: "203.0.113.91", body: { email: "flood@example.test" } });
  check("…another network can still ask (so a flood from elsewhere can't lock the owner out)", r.status === 200);
  for (let i = 0; i < 14; i++) await call("POST", "/api/candidate-auth/request", { ip: `203.0.113.${100 + i}`, body: { email: "flood@example.test" } });
  r = await call("POST", "/api/candidate-auth/request", { ip: "203.0.113.200", body: { email: "flood@example.test" } });
  check("…but one inbox gets at most 20 an hour from all networks together", r.status === 429, r.status);
  outbox().length = 0;
  const netCodes = [];
  for (let i = 0; i < 61; i++) netCodes.push((await call("POST", "/api/candidate-auth/request", { ip: "203.0.113.95", body: { email: `rotate${i}@example.test` } })).status);
  check("…and one network gets at most 60 an hour across addresses", netCodes.filter((c) => c === 429).length === 1 && netCodes[60] === 429, netCodes.filter((c) => c === 429).length);
  check("…refused requests send nothing", outbox().length === 60, outbox().length);
  const [{ n: rawKeys }] = await sql`SELECT COUNT(*)::int AS n FROM rate_limits WHERE key LIKE '%@%' OR key LIKE '%203.0.113%'`;
  check("rate-limit rows hold hashes, never an address or an IP", rawKeys === 0);
  r = await call("POST", "/api/candidate-auth/request", { ip: rlIp, body: { email: "not-an-email" } });
  check("a bad address is turned away before it counts", r.status === 400);

  // Employer sign-up and reset emails share one limit, the same for existing and unknown emails.
  const eCodes = [];
  for (let i = 0; i < 6; i++) eCodes.push((await call("POST", "/api/auth/forgot", { ip: rlIp, body: { email: "hr@shoalsbank.test" } })).status);
  const uCodes = [];
  for (let i = 0; i < 6; i++) uCodes.push((await call("POST", "/api/auth/forgot", { ip: rlIp, body: { email: "nobody-rl@nowhere.test" } })).status);
  check("reset emails: limited the same way whether or not the account exists", JSON.stringify(eCodes) === JSON.stringify(uCodes) && eCodes[5] === 429, [eCodes, uCodes]);
  r = await call("POST", "/api/auth/signup", { ip: rlIp, body: { contact_name: "R", company: "R Bank", email: "hr@shoalsbank.test", password: "Limit-Test-Pass-77" } });
  check("…and sign-up counts against the same limit", r.status === 429, r.data);

  // Job alerts: 3 confirmation emails per inbox per network an hour.
  const aCodes = [];
  for (let i = 0; i < 4; i++) aCodes.push((await call("POST", "/api/alerts", { ip: rlIp, body: { email: "alerts-rl@example.test" } })).status);
  check("alert confirmations: a 4th from one network is refused", JSON.stringify(aCodes) === "[200,200,200,429]", aCodes);

  // Applications: 25 per address per network an hour (counted even for jobs that are gone).
  const apCodes = [];
  for (let i = 0; i < 26; i++) apCodes.push((await call("POST", "/api/apply", { ip: rlIp, body: { job_id: "99999999", name: "Spam", email: "spam-apply@example.test" } })).status);
  check("applications: the 26th from one address and network is refused", apCodes.slice(0, 25).every((c) => c === 404) && apCodes[25] === 429, apCodes.slice(-3));

  // Alerts can't be changed by someone who only knows the subscriber's email.
  outbox().length = 0;
  await call("POST", "/api/alerts", { ip: "203.0.113.150", body: { email: "sub-guard@example.test", categories: ["lending-credit"] } });
  const guardLink = lastEmailTo("sub-guard@example.test")?.text.match(/https?:\S+confirm\?token=\w+/)?.[0];
  await fetch(guardLink, { redirect: "manual" });
  outbox().length = 0;
  r = await call("POST", "/api/alerts", { ip: "203.0.113.151", body: { email: "sub-guard@example.test", categories: ["technology"] } });
  let [guard] = await sql`SELECT categories, pending_categories FROM alert_subscriptions WHERE email = 'sub-guard@example.test'`;
  const changeMail = lastEmailTo("sub-guard@example.test");
  check("a confirmed subscriber's alerts don't change just because someone posts their email",
    r.status === 200 && r.data.confirmed === undefined && guard.categories.join() === "lending-credit" && guard.pending_categories.join() === "technology", guard);
  check("…the subscriber is emailed a link to confirm the change", /Confirm your new BankJobz alert choices/.test(changeMail?.subject || ""));
  await fetch(changeMail.text.match(/https?:\S+confirm\?token=\w+/)[0], { redirect: "manual" });
  [guard] = await sql`SELECT categories, pending_categories FROM alert_subscriptions WHERE email = 'sub-guard@example.test'`;
  check("…and clicking it applies the change", guard.categories.join() === "technology" && guard.pending_categories === null, guard);

  // Old counters are pruned.
  await sql`UPDATE rate_limits SET window_start = now() - interval '3 days' WHERE key LIKE 'al:%'`;
  const prunedLimits = await pruneAuth();
  const [{ n: alLeft }] = await sql`SELECT COUNT(*)::int AS n FROM rate_limits WHERE key LIKE 'al:%'`;
  check("old rate-limit counters are cleared by the daily prune", prunedLimits.rate_limits > 0 && alLeft === 0, prunedLimits);
} catch (err) {
  failed++;
  results.push(`\n  ✗ crashed: ${err.stack}`);
} finally {
  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); fakeStripe.server.close(); registries.server.close(); fakeAi.server.close(); await sql.end?.();
  process.exit(failed ? 1 : 0);
}
