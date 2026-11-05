// Drives the real site in headless Chromium: the same clicks and form fills a person makes.
//   npx playwright install chromium   (once)
//   npm run test:browser
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const SEED = JSON.parse(readFileSync(new URL("../public/seed-jobs.json", import.meta.url), "utf8"));
const SEED_LEN = SEED.length;
const DA_LEN = SEED.filter((j) => j.category === "data-analytics").length;
// the "mission" search runs while the Data & analytics chip is active, so count within that department
const MISSION_LEN = SEED.filter((j) => j.category === "data-analytics" && [j.title, j.company, j.location, j.summary].join(" ").toLowerCase().includes("mission")).length;
import { startStack, BASE } from "./stack.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const SHOTS = process.env.SCREENSHOT_DIR || "tests/screenshots";
mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
const lines = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed++; lines.push(`  ✓ ${name}`); }
  else { failed++; lines.push(`  ✗ ${name}${detail ? "  →  " + detail : ""}`); }
};
const section = (t) => lines.push(`\n${t}`);

const stack = await startStack("bankstack_browser");
const { totpAt, currentStep } = await import("../netlify/lib/auth.mjs");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const pageErrors = [];
const newPage = async (ctxOpts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });
  // Google Fonts are unreachable in the sandbox; answer with empty CSS so pages don't wait on them.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  // Stripe's hosted checkout page: "pay" through the fake Stripe, then follow Stripe's redirect back.
  await ctx.route("https://checkout.stripe.test/**", async (route) => {
    const session = stack.lastSession();
    await stack.pay(session);
    await route.fulfill({ status: 302, headers: { location: session.success_url.replace("{CHECKOUT_SESSION_ID}", session.id) } });
  });
  await ctx.route("https://billing.stripe.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>Stripe billing portal</h1>" }));
  return page;
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
writeFileSync("/tmp/Jordan_Lee_Resume.pdf", pdf);

try {
  // ============================================================
  section("Landing page");
  const emp = await newPage();
  await emp.goto(BASE + "/");
  await emp.waitForSelector(".home-hero h1");
  check("headline shows", (await emp.textContent(".home-hero h1")).includes("banks and credit unions"));
  check("live figures come from the database", (await emp.textContent(".figures-grid strong")) === String(SEED_LEN));
  await shot(emp, "01-home");
  await emp.click("text=View current positions");
  await emp.waitForSelector(".ledger li");
  check("View current positions opens the board", (await emp.locator(".ledger .job-row").count()) === SEED_LEN);
  await emp.click('.cat-chip[data-cat="data-analytics"]');
  check("department chip filters the list", (await emp.locator(".ledger .job-row").count()) === DA_LEN);
  await emp.fill("#f-q", "mission");
  check("search narrows it further", (await emp.locator(".ledger .job-row").count()) === MISSION_LEN);
  await shot(emp, "02-jobs");

  // ============================================================
  section("New hiring manager creates an account");
  const PW = "Shoals-Teller-Window-42";
  const codeFor = (to, kind) => stack.outbox().findLast((m) => m.to === to && m.subject.includes(kind))?.subject.match(/(\d{6})$/)?.[1];
  await emp.click("nav >> text=Post a job");
  await emp.waitForSelector("#signup-form");
  check("Post a job asks a new employer to create an account first",
    (await emp.locator("#post-form").count()) === 0 && (await emp.getAttribute("#auth-card", "data-mode")) === "signup");
  await emp.fill("#su-name", "Morgan Hale");
  await emp.fill("#su-title", "HR Manager");
  await emp.fill("#su-company", "Shoals Community Bank");
  await emp.selectOption("#su-type", "bank");
  await emp.fill("#su-email", "hr@shoalsbank.test");
  await emp.fill("#a-newpw", "short");
  await emp.click("#signup-form button[type=submit]");
  await emp.waitForSelector("#auth-msg:not([hidden])");
  check("a short password is caught before sending", (await emp.textContent("#auth-msg")).includes("10 characters"));
  await emp.fill("#a-newpw", PW);
  await emp.click("#signup-form [data-toggle]");
  check("show-password reveals what was typed", (await emp.getAttribute("#a-newpw", "type")) === "text");
  await shot(emp, "03a-create-account");
  await emp.click("#signup-form button[type=submit]");
  await emp.waitForSelector("#code-form");
  check("sign-up asks for the emailed confirmation code", (await emp.textContent("#code-form h2")).includes("Confirm your email"));
  await emp.fill("#a-code", "000000");
  await emp.waitForSelector("#auth-msg:not([hidden])");
  check("a wrong code is refused on screen", (await emp.textContent("#auth-msg")).includes("isn't right"));
  await emp.fill("#a-code", codeFor("hr@shoalsbank.test", "confirmation code"));
  await emp.waitForSelector("#post-form");
  check("confirming continues straight to what they came for: the post form",
    (await emp.textContent(".post-intro")).includes("Posting as Shoals Community Bank"));
  await emp.click("nav >> text=Dashboard");
  await emp.waitForSelector(".first-run");
  check("the code opens their own empty dashboard with a welcome",
    (await emp.textContent(".dash-head")).includes("Shoals Community Bank") && (await emp.textContent(".first-run")).includes("Morgan"));
  check("this browser is remembered as a trusted device", !!(await emp.evaluate(() => localStorage.getItem("bankjobz.device"))));
  await shot(emp, "03b-new-dashboard");

  section("Employer posts a job and pays");
  await emp.click(".first-run a.btn");
  await emp.waitForSelector("#post-form");
  check("signed-in post form skips the institution questions",
    (await emp.locator("#c-company, #c-email").count()) === 0 && (await emp.textContent(".post-intro")).includes("Posting as Shoals Community Bank"));
  await emp.fill("#p-title", "Senior Data Architect");
  await emp.fill("#p-location", "Florence, AL");
  await emp.selectOption("#p-mode", "hybrid");
  await emp.selectOption("#p-cat", "data-analytics");
  await emp.fill("#p-min", "115,000");
  await emp.fill("#p-max", "140,000");
  await emp.fill("#p-summary", "Own the enterprise data model across core, lending and call reporting.");
  await emp.fill("#p-desc", "Lead our lakehouse migration.\nJack Henry or Fiserv core experience is a plus.");
  await emp.click(".banking-extra:not(.ai-box) summary");
  await emp.click('.banking-extra:not(.ai-box) .chip-check:has-text("Fiserv DNA")');
  check("AI draft box sits open directly below the job title",
    await emp.evaluate(() => {
      const box = document.querySelector(".ai-box");
      const titleField = document.getElementById("p-title").closest(".field");
      return box?.open === true && titleField.nextElementSibling === box;
    }));
  await emp.fill("#ai-notes", "wires and ACH, team of four");
  await emp.click("#ai-draft");
  await emp.waitForSelector("#ai-msg:not([hidden])");
  check("AI drafts the posting into the form", (await emp.inputValue("#p-summary")).startsWith("Run daily deposit operations")
    && (await emp.inputValue("#p-desc")).includes("What you'll bring"));
  await emp.fill("#p-summary", "Own the enterprise data model across core, lending and call reporting.");
  await shot(emp, "03-post-form");
  check("the first posting's checkout line explains the plan", (await emp.textContent(".checkout-line")).includes("covers up to 5 postings")
    && (await emp.textContent(".checkout-line strong")) === "$99");
  await emp.click("text=Continue to payment");
  await emp.waitForSelector("#welcome h2:has-text('Your job is live')", { timeout: 15000 });
  check("Stripe checkout returns to a 'job is live' page with no keys to copy", (await emp.locator("#the-key").count()) === 0);
  await shot(emp, "04-welcome");
  await emp.click("text=Go to dashboard");
  await emp.waitForSelector(".kpis");
  check("overview shows the live posting", (await emp.textContent(".kpis")).includes("1live posting"));
  await emp.click("[data-dtab=postings]");
  await emp.waitForSelector("td:has-text('Senior Data Architect')");
  check("postings tab shows it live", (await emp.textContent(".stack-table .status-pill")) === "Live");
  check("…under a plan panel: 1 of 5 live postings, next bill $99", (await emp.textContent(".plan-panel .plan-use")).includes("1 of 5")
    && (await emp.textContent(".plan-panel")).includes("Next bill $99") && (await emp.locator(".plan-panel .ladder li.on").count()) === 1);

  // Postings 2–5 go straight live; the 6th shows the new price on the button before charging.
  const empKey = await emp.evaluate(() => localStorage.getItem("bankstack.key"));
  for (let i = 2; i <= 5; i++) {
    const res = await fetch(`${BASE}/api/checkout`, { method: "POST", headers: { authorization: `Bearer ${empKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: `Teller ${i}`, location: "Florence, AL", category: "branch-retail", summary: "Serve members at the Florence branch." }) });
    const out = await res.json();
    if (!out.live) check(`posting ${i} goes live under the plan`, false, out);
  }
  await emp.goto(BASE + "/#post");
  await emp.waitForSelector("#post-form");
  check("with 5 live, the post form says the 6th moves the plan to $159.99", (await emp.textContent(".checkout-line")).includes("$159.99/month")
    && (await emp.textContent("#post-form button[type=submit]")) === "Publish and upgrade plan");
  await emp.fill("#p-title", "Universal Banker");
  await emp.fill("#p-location", "Muscle Shoals, AL");
  await emp.selectOption("#p-cat", "branch-retail");
  await emp.fill("#p-summary", "Open accounts, process loans and help members at our busiest branch.");
  await shot(emp, "03b-post-upgrade");
  await emp.click("#post-form button[type=submit]");
  await emp.waitForSelector(".plan-panel");
  check("publishing the 6th lands on Postings with the new price", (await emp.textContent("#flash")).includes("$159.99/month")
    && (await emp.textContent(".plan-panel .plan-use")).includes("6 of 10"));
  await shot(emp, "06a-plan-panel");
  // Closing one: next bill drops, this month stays as paid, and the row offers Reopen.
  const closeBtn = emp.locator("tr:has-text('Teller 5') [data-act=close]");
  await closeBtn.click();
  await closeBtn.click();
  await emp.waitForSelector("tr:has-text('Teller 5') [data-act=publish]");
  check("closing a posting drops the next bill to $99 and offers Reopen", (await emp.textContent(".plan-panel")).includes("Next bill $99")
    && (await emp.textContent(".plan-panel")).includes("covers up to 6 postings"));
  await emp.click("tr:has-text('Teller 5') [data-act=publish]");
  await emp.waitForSelector("tr:has-text('Teller 5') [data-act=close]");
  check("reopening it this month needs no confirmation (already paid)", (await emp.textContent(".plan-panel .plan-use")).includes("6 of 10"));
  const jobId = (await stack.sql`SELECT id FROM jobs WHERE title = 'Senior Data Architect'`)[0].id;
  await emp.goto(BASE + "/#jobs");
  await emp.waitForSelector("#f-core");
  await emp.selectOption("#f-core", "fiserv-dna");
  check("core-system filter finds the tagged posting", (await emp.locator(".ledger .job-row").count()) === 1);

  // ============================================================
  section("Returning employer on a new device: password, then a code");
  const back = await newPage(); // fresh browser: no saved sign-in, not a trusted device
  await back.goto(BASE + "/");
  await back.waitForSelector(".home-hero h1");
  check("signed-out visitors see 'Employer sign in' in the top nav", (await back.textContent("#nav-dashboard")) === "Employer sign in");
  await back.click("#nav-dashboard");
  await back.waitForSelector("#signin-form");
  await back.fill("#a-email", "hr@shoalsbank.test");
  await back.fill("#a-password", "Wrong-Password-1");
  await back.click("#signin-form button[type=submit]");
  await back.waitForSelector("#auth-msg:not([hidden])");
  check("a wrong password is refused", (await back.textContent("#auth-msg")).includes("don't match"));
  await back.fill("#a-password", PW);
  await back.click("#signin-form button[type=submit]");
  await back.waitForSelector("#code-form");
  check("a new device is asked for an emailed code", (await back.textContent("#code-form")).includes("We emailed a 6-digit code"));
  await shot(back, "04b-sign-in-code");
  await back.uncheck("#a-remember");
  await back.fill("#a-code", codeFor("hr@shoalsbank.test", "sign-in code"));
  await back.waitForSelector(".kpis");
  check("password + code lands on their dashboard", (await back.textContent(".dash-head")).includes("Shoals Community Bank")
    && (await back.textContent("#nav-dashboard")) === "Dashboard");
  check("…without trusting this device, as asked", !(await back.evaluate(() => localStorage.getItem("bankjobz.device"))));

  // The button in the email works too: sign in on one device, finish from the email on another.
  const linkFor = (to, kind) => stack.outbox().findLast((m) => m.to === to && m.subject.includes(kind))?.text.match(/https?:\S+#auth=bsl_[0-9a-f]{48}/)?.[0];
  const viaLink = await newPage();
  await viaLink.goto(BASE + "/#dashboard");
  await viaLink.waitForSelector("#signin-form");
  await viaLink.fill("#a-email", "hr@shoalsbank.test");
  await viaLink.fill("#a-password", PW);
  await viaLink.click("#signin-form button[type=submit]");
  await viaLink.waitForSelector("#code-form");
  check("the code step mentions the email's button", (await viaLink.textContent("#code-form")).includes("button in that email"));
  const signInUrl = linkFor("hr@shoalsbank.test", "sign-in code");
  check("the sign-in email has a one-click button", !!signInUrl, signInUrl);
  const mailApp = await newPage();
  await mailApp.goto(signInUrl.replace(/^https?:\/\/[^/]+/, BASE));
  await mailApp.waitForSelector("#link-form");
  check("opening the button asks for one click (mail scanners can't use it up)", (await mailApp.textContent("#link-form")).includes("Finish signing in")
    && !(await mailApp.evaluate(() => location.search)));
  check("…and the secret is gone from the address bar", !(await mailApp.evaluate(() => location.href)).includes("bsl_"));
  await shot(mailApp, "04c-email-button");
  await mailApp.click("#link-form button[type=submit]");
  await mailApp.waitForSelector(".kpis");
  check("one click signs in from the email", (await mailApp.textContent(".dash-head")).includes("Shoals Community Bank"));
  await mailApp.goto(signInUrl.replace(/^https?:\/\/[^/]+/, BASE));
  await mailApp.waitForSelector("#link-card .msg.error");
  check("the same button can't be used twice, and says so straight away", (await mailApp.textContent("#link-card")).includes("already used"));
  // The reset email's button opens a new-password form.
  await viaLink.click("#a-back");
  await viaLink.waitForSelector("#signin-form");
  await viaLink.click("#a-forgot");
  await viaLink.fill("#f-email", "hr@shoalsbank.test");
  await viaLink.click("#forgot-form button[type=submit]");
  await viaLink.waitForSelector("#reset-form");
  const resetUrl = linkFor("hr@shoalsbank.test", "Reset");
  await mailApp.goto(resetUrl.replace(/^https?:\/\/[^/]+/, BASE));
  await mailApp.waitForSelector("#link-form #a-linkpw");
  check("the reset button opens a set-new-password form", (await mailApp.textContent("#link-form h2")) === "Set a new password");
  check("…naming the account it's for", (await mailApp.textContent("#link-form")).includes("hr@shoalsbank.test"));
  await shot(mailApp, "04d-reset-button");

  // ============================================================
  section("Candidate finds the job and applies");
  const cand = await newPage();
  await cand.goto(`${BASE}/jobs/${jobId}`);
  await cand.waitForSelector(".detail h1");
  check("real /jobs/:id URL opens the job", (await cand.textContent(".detail h1")) === "Senior Data Architect");
  check("browser tab title names the job", (await cand.title()).startsWith("Senior Data Architect at Shoals Community Bank"));
  await cand.fill("#a-name", "Jordan Lee");
  await cand.fill("#a-email", "jordan@example.test");
  await cand.fill("#a-phone", "256-555-0199");
  await cand.setInputFiles("#a-file", "/tmp/Jordan_Lee_Resume.pdf");
  await cand.fill("#a-note", "Ten years on SilverLake and a Fabric lakehouse rollout.");
  await shot(cand, "05-apply");
  await cand.click("text=Send application");
  await cand.waitForSelector("#apply-form .msg, .panel .msg:has-text('Application sent')");
  check("application sent message", (await cand.textContent(".panel")).includes("Application sent to Shoals Community Bank"));
  check("employer was emailed", stack.outbox().some((m) => m.to === "hr@shoalsbank.test" && m.subject.includes("Jordan Lee")));
  await cand.click("text=← All positions");
  await cand.waitForSelector(".ledger .job-row");
  const liveOnBoard = (await stack.sql`SELECT COUNT(*)::int n FROM jobs WHERE status = 'open' AND expires_at > now()`)[0].n;
  check("nav from a /jobs page goes back to the board", (await cand.locator(".ledger .job-row").count()) === liveOnBoard && liveOnBoard === SEED_LEN + 6 && new URL(cand.url()).pathname === "/");
  await cand.locator("#alerts-form .chip-check", { hasText: "Data & analytics" }).click();
  await cand.fill("#al-email", "jordan@example.test");
  await cand.click("text=Send me alerts");
  await cand.waitForSelector("#alerts-msg:not([hidden])");
  check("job alert signup asks to confirm by email", (await cand.textContent("#alerts-msg")).includes("click the link to confirm"));
  const confirm = stack.outbox().findLast((m) => m.to === "jordan@example.test" && m.subject.includes("Confirm"))?.text.match(/https?:\S+/)?.[0];
  await cand.goto(confirm);
  await cand.waitForSelector("#flash:not([hidden])");
  check("confirm link lands on the board with a notice", (await cand.textContent("#flash")).includes("You're subscribed"));

  // ============================================================
  section("Employer reviews the applicant");
  await emp.goto(BASE + "/#dashboard");
  await emp.click("[data-dtab=overview]");
  await emp.waitForSelector(".recent-apps");
  check("overview flags the new applicant", (await emp.textContent(".kpis")).includes("1 new") && (await emp.textContent(".recent-apps")).includes("Jordan Lee"));
  await emp.click(".pipe-step[data-goto-stage=new]");
  await emp.waitForSelector(".app-card");
  check("the pipeline jumps to that stage's applicants", (await emp.inputValue("#ap-stage")) === "new"
    && (await emp.locator(".app-card.is-new").count()) === 1 && (await emp.textContent(".app-card")).includes("Jordan Lee"));
  const [download] = await Promise.all([emp.waitForEvent("download"), emp.click(".app-card [data-resume]")]);
  check("résumé downloads intact", readFileSync(await download.path()).equals(pdf) && download.suggestedFilename() === "Jordan_Lee_Resume.pdf");
  await emp.click(".app-card [data-rate='4']");
  await emp.waitForSelector("#act-msg:has-text('Rated Jordan Lee 4/5')");
  check("a 4-star rating saves", (await stack.sql`SELECT rating FROM applications WHERE name = 'Jordan Lee'`)[0].rating === 4
    && (await emp.locator(".app-card .stars button.on").count()) === 4);
  await emp.click(".app-card summary:has-text('Your private notes')");
  await emp.fill(".app-card [data-notes]", "Strong on SilverLake. Schedule a panel.");
  await emp.click(".app-card [data-save-notes]");
  await emp.waitForSelector("#act-msg:has-text('Notes saved')");
  check("private notes save", (await stack.sql`SELECT notes FROM applications WHERE name = 'Jordan Lee'`)[0].notes.startsWith("Strong on SilverLake"));
  await emp.selectOption(".app-card select.stage", "interview");
  await emp.waitForSelector("#act-msg:has-text('moved to Interview')");
  check("stage changed to Interview", (await stack.sql`SELECT status FROM applications WHERE name = 'Jordan Lee'`)[0].status === "interview");
  await emp.selectOption("#ap-stage", "");
  await emp.fill("#ap-q", "nobody-matches");
  check("search filters the list", (await emp.locator(".app-card").count()) === 0);
  await emp.fill("#ap-q", "jordan");
  check("…and finds by name", (await emp.locator(".app-card").count()) === 1);
  const [csvDl] = await Promise.all([emp.waitForEvent("download"), emp.click("#ap-export")]);
  const csvText = readFileSync(await csvDl.path(), "utf8");
  check("Export CSV downloads the applicants with notes and rating", csvText.includes("Jordan Lee") && csvText.includes("interview,4,Strong on SilverLake"));
  await shot(emp, "06-dashboard");

  await emp.click("[data-dtab=postings]");
  await emp.click("tr:has-text('Senior Data Architect') td.acts >> text=Edit");
  await emp.waitForSelector("#edit-form");
  check("edit form is prefilled", (await emp.inputValue("#e-title")) === "Senior Data Architect" && (await emp.inputValue("#e-min")) === "115000");
  await emp.fill("#e-title", "Lead Data Architect");
  await emp.click("text=Save changes");
  await emp.waitForSelector("#flash:not([hidden])");
  await emp.waitForSelector("td:has-text('Lead Data Architect')");
  check("edit saves and returns to Postings", (await emp.textContent("#flash")).includes("Posting updated"));
  check("postings show views and apply rate", /\d+%/.test(await emp.textContent("tr:has-text('Lead Data Architect') td[data-label='Apply rate']")));

  await emp.click("[data-plan=cancel]");
  check("cancelling the plan asks for a second click instead of a pop-up", (await emp.textContent("[data-plan=cancel]")).includes("Click again to confirm"));
  await emp.click("[data-plan=cancel]");
  await emp.waitForSelector("[data-plan=resume]");
  check("a cancelled plan shows when it ends and offers to keep it", (await emp.textContent(".plan-panel")).includes("Ends")
    && (await emp.locator(".status-pill:has-text('Ends')").count()) === 6);
  await emp.click("[data-plan=resume]");
  await emp.waitForSelector("[data-plan=cancel]");
  check("keep my plan restores it", (await emp.textContent(".plan-panel")).includes("Next bill"));
  await emp.click("tr:has-text('Lead Data Architect') td.acts >> text=Duplicate");
  await emp.waitForSelector("#post-form");
  check("Duplicate opens a new posting prefilled from the old one", (await emp.inputValue("#p-title")) === "Lead Data Architect"
    && (await emp.inputValue("#p-location")) === "Florence, AL");
  await emp.goto(BASE + "/#dashboard");
  await emp.waitForSelector(".dash-head");
  await emp.click("text=Cards & invoices");
  await emp.waitForSelector("text=Stripe billing portal");
  check("Cards & invoices opens Stripe's billing portal", true);

  // ============================================================
  section("Account & security: authenticator app");
  await emp.goto(BASE + "/#dashboard");
  await emp.waitForSelector("[data-dtab=account]");
  await emp.click("[data-dtab=account]");
  await emp.waitForSelector("#sec-totp-on");
  check("security shows email codes as the current second step", (await emp.textContent("#security-box")).includes("Email code"));
  await emp.click("#sec-totp-on");
  await emp.waitForSelector("#a-confirmpw");
  check("setting up the app asks for the current password first", true);
  await emp.fill("#a-confirmpw", PW);
  await emp.click(".inline-confirm button[type=submit]");
  await emp.waitForSelector(".totp-setup .qr svg");
  const secret = (await emp.textContent(".totp-setup .secret")).replace(/\s/g, "");
  check("setup shows a scannable QR code and the key", /^[A-Z2-7]{32}$/.test(secret));
  await emp.fill("#totp-code", totpAt(secret, currentStep()));
  await emp.click("#totp-confirm button[type=submit]");
  await emp.waitForSelector(".codes-box");
  check("turning it on shows 10 one-time recovery codes", (await emp.locator(".codes li").count()) === 10);
  await shot(emp, "06b-recovery-codes");
  await emp.click("#codes-done");
  await emp.waitForSelector("#security-box .status-pill:has-text('Authenticator app')");
  await emp.waitForSelector("#security-box:has-text('10 recovery codes left')", { timeout: 5000 }).catch(() => {});
  check("security now shows the authenticator app", (await emp.textContent("#security-box")).includes("10 recovery codes left"), (await emp.textContent("#security-box")).slice(0, 300));
  await shot(emp, "06c-security");

  // ============================================================
  section("Signing in on a phone with the authenticator app");
  const other = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await other.goto(BASE + "/#dashboard");
  await other.waitForSelector("#signin-form");
  check("signed-out dashboard asks to sign in", true);
  await other.fill("#a-email", "hr@shoalsbank.test");
  await other.fill("#a-password", PW);
  await other.click("#signin-form button[type=submit]");
  await other.waitForSelector("#code-form");
  check("with the app on, the phone asks for the app's code", (await other.textContent("#code-form")).includes("authenticator app"));
  await shot(other, "07a-app-code-phone");
  await other.fill("#a-code", totpAt(secret, currentStep() + 1));
  await other.click("#code-form button[type=submit]");
  await other.waitForSelector(".kpis");
  check("app code signs in on the phone", (await other.textContent(".dash-head")).includes("Shoals Community Bank"));
  await other.click("[data-dtab=applicants]");
  await other.waitForSelector(".app-card");
  await shot(other, "07-dashboard-phone");
  const overflow = await other.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, ...[...document.querySelectorAll("main *:not(.dash-tabs *)")].map((e) => e.getBoundingClientRect().right)) > window.innerWidth + 1);
  check("no sideways scrolling at phone width", !overflow);
  await other.goto(BASE + "/");
  await other.waitForSelector(".home-hero h1");
  await shot(other, "08-home-phone");
  check("home page fits a phone screen", !(await other.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));

  // ============================================================
  section("Candidate profile hub: sign-up, save a job, tabs");
  const candP = await newPage();
  await candP.goto(BASE + "/");
  await candP.waitForSelector(".home-hero h1");
  await candP.click("nav >> text=My profile");
  await candP.waitForSelector("#cstart-form");
  check("My profile asks new candidates to create a profile", (await candP.textContent(".post-intro h1")).includes("One profile"));
  await candP.fill("#cs-name", "Casey Banks");
  await candP.fill("#cs-email", "casey@example.test");
  await candP.click("text=Email me a sign-in link");
  await candP.waitForSelector("#cs-msg:not([hidden])");
  const cloginUrl = stack.outbox().findLast((m) => m.to === "casey@example.test")?.text.match(/https?:\S+clogin=\w+\S*/)?.[0];
  check("candidate sign-in link emailed", !!cloginUrl);
  await candP.goto(cloginUrl);
  await candP.waitForSelector(".profile-tabs");
  check("email link opens the profile hub with its tabs", (await candP.locator(".profile-tabs a").count()) === 4);
  await shot(candP, "09-profile-hub");

  await candP.fill("#pr-location", "Florence, AL");
  await candP.fill("#pr-summary", "Fifteen years running consumer lending teams at community banks.");
  await candP.locator("#profile-form .chip-check", { hasText: "Lending & credit" }).first().click();
  await candP.locator("#profile-form .chip-check", { hasText: "talent pool" }).click();
  await candP.setInputFiles("#pr-file", "/tmp/Jordan_Lee_Resume.pdf");
  await candP.click("text=Save profile");
  await candP.waitForSelector(".dash-head h1:has-text('Your matches')");
  const flashText = await candP.textContent("#flash");
  check("profile saves and opens matches", /saved/i.test(flashText), flashText);

  await candP.goto(`${BASE}/jobs/${jobId}`);
  await candP.waitForSelector("#qa-slot .qa-box, #qa-slot .source-note"); // candidate bits initialized
  await candP.click("#save-job");
  await candP.waitForSelector("#save-job:has-text('★ Saved')");
  check("save button on a job page bookmarks it", true);
  await candP.click("nav >> text=My profile");
  await candP.click(".profile-tabs >> text=Saved jobs");
  await candP.waitForSelector(".match-list .match-row");
  check("saved job shows under Saved jobs", (await candP.textContent(".match-list")).includes("Lead Data Architect"));
  await shot(candP, "10-saved-jobs");
  await candP.click("[data-unsave]");
  await candP.waitForSelector(".match-list .match-row", { state: "detached" });
  check("remove clears the saved list", (await candP.locator(".match-list .match-row").count()) === 0);
  await candP.click(".profile-tabs >> text=Applications");
  await candP.waitForSelector(".dash .panel");
  check("applications tab shows its empty state", (await candP.textContent(".dash .panel")).includes("No applications yet"));

  // ============================================================
  section("Talent pool from the employer's chair");
  await emp.goto(BASE + "/#dashboard");
  await emp.waitForSelector("[data-dtab=talent]");
  await emp.click("[data-dtab=talent]");
  await emp.waitForSelector("#t-load");
  await emp.click("#t-load");
  await emp.waitForSelector(".talent-card");
  const cardText = await emp.textContent(".talent-card");
  check("anonymous candidate card appears with their details", cardText.includes("Florence, AL") && cardText.includes("Lending & credit"));
  check("card never shows a name or email", !cardText.includes("Casey") && !cardText.includes("casey@example.test"));
  await emp.fill(".talent-card [data-tnote]", "Your lending background fits our team.");
  await emp.click(".talent-card [data-invite]");
  await emp.waitForSelector(".talent-card .status-pill");
  check("invite confirms in place", (await emp.textContent(".talent-card .status-pill")).includes("Invited"));
  check("candidate got the invite email", stack.outbox().some((m) => m.to === "casey@example.test" && m.subject.includes("would like you to apply")));
  await shot(emp, "12-talent-pool");

  // ============================================================
  section("AI tailors an application");
  await candP.goto(`${BASE}/jobs/${jobId}`);
  await candP.waitForSelector("#qa-tailor");
  await candP.click("#qa-tailor");
  await candP.waitForSelector("#qa-note");
  check("tailored note arrives prefilled and editable", (await candP.inputValue("#qa-note")).startsWith("I've spent ten years"));
  check("résumé angle tips show", (await candP.locator(".ai-tips li").count()) === 3);
  await shot(candP, "13-ai-tailor");
  await candP.click("#qa-send");
  await candP.waitForSelector(".detail .panel .msg");
  check("application sends with the note", (await candP.textContent(".detail .panel")).includes("Application sent"));
  const [caseyApp] = await stack.sql`SELECT cover_note FROM applications WHERE email = 'casey@example.test'`;
  check("the note lands on the employer's copy", !!caseyApp?.cover_note?.startsWith("I've spent ten years"));

  // ============================================================
  section("Admin console");
  const adm = await newPage();
  await adm.goto(BASE + "/#admin");
  await adm.fill("#ad-key", "admin_e2e_token");
  await adm.click("text=Open console");
  await adm.waitForSelector(".admin-figures");
  check("admin figures show $159.99 MRR from one plan with 6 postings", (await adm.textContent(".admin-figures strong")) === "$159.99"
    && (await adm.textContent(".admin-figures")).includes("1hiring plans live"));
  check("billing setup shows the plan Stripe is charging", (await adm.textContent(".billing-setup")).includes("+$15")
    && (await adm.inputValue("#bill-extra")) === "15.00");
  const firstSourced = adm.locator('[data-admin="close"][data-direct="false"]').first();
  await firstSourced.click();
  check("take down asks for confirmation first", (await firstSourced.textContent()).includes("Confirm"));
  await firstSourced.click();
  await adm.waitForTimeout(300);
  const [{ n: closed }] = await stack.sql`SELECT COUNT(*)::int n FROM jobs WHERE status = 'closed'`;
  check("confirmed take down closes the listing", closed === 1);
  await shot(adm, "11-admin");

  check("no JavaScript errors on any page", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
  failed++;
  lines.push(`\n  ✗ crashed: ${err.stack}${pageErrors.length ? `\n  page errors: ${pageErrors.join(" | ")}` : ""}`);
} finally {
  console.log(lines.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${SHOTS}/`);
  await browser.close();
  await stack.stop();
  process.exit(failed ? 1 : 0);
}
