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
  // Set TEST_FONTS_CSS / TEST_FONTS_DIR to serve the real fonts locally for screenshots.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => {
    const u = new URL(r.request().url());
    if (process.env.TEST_FONTS_CSS && u.hostname === "fonts.googleapis.com") return r.fulfill({ status: 200, contentType: "text/css", body: readFileSync(process.env.TEST_FONTS_CSS) });
    if (process.env.TEST_FONTS_DIR && u.pathname.startsWith("/__local/")) return r.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(process.env.TEST_FONTS_DIR + u.pathname.slice(8)) });
    return r.fulfill({ status: 200, contentType: "text/css", body: "" });
  });
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
  // The Content-Security-Policy is live (served from netlify.toml): the boot script ran, the web fonts
  // loaded through it, and a script injected into the page is refused.
  const csp = await emp.evaluate(async () => {
    await document.fonts.ready;
    const blocked = new Promise((res) => {
      document.addEventListener("securitypolicyviolation", (e) => res(e.violatedDirective), { once: true });
      setTimeout(() => res(null), 1500);
    });
    const el = document.createElement("script");
    el.textContent = "window.__injected = true";
    document.body.appendChild(el);
    return { violated: await blocked, injected: !!window.__injected, boot: document.documentElement.getAttribute("data-boot"),
      fontsLink: !!document.querySelector('link[rel=stylesheet][href*="fonts.googleapis.com"]') };
  });
  check("CSP: the hashed boot script runs and loads the web fonts", csp.boot === "home" && csp.fontsLink, csp);
  check("CSP: an injected inline script is blocked", csp.injected === false && /script-src/.test(csp.violated || ""), csp);
  pageErrors.length = 0; // that refusal is logged as a console error on purpose
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
  check("work schedule shows On-site, Remote and Hybrid buttons, On-site picked to start",
    JSON.stringify(await emp.$$eval("#p-mode .mode-opt b", (els) => els.map((e) => e.textContent))) === '["On-site","Remote","Hybrid"]'
    && await emp.isChecked("#p-mode-onsite"));
  await emp.click('#p-mode label:has(#p-mode-remote)');
  check("clicking a work schedule button selects it", await emp.isChecked("#p-mode-remote") && !(await emp.isChecked("#p-mode-onsite")));
  await emp.click('#p-mode label:has(#p-mode-hybrid)');
  await emp.waitForTimeout(250); // let the color transition finish
  const modeLook = await emp.$eval("#p-mode-hybrid + span", (el) => getComputedStyle(el).backgroundColor);
  check("the picked work schedule button is filled in navy", modeLook === "rgb(10, 42, 94)", modeLook);
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
  // Benefits: tick boxes, standard lines appear in the description; untick and they go.
  await emp.fill("#p-desc", "Lead our lakehouse migration.\nJack Henry or Fiserv core experience is a plus.");
  await emp.check('input[name="benefit"][value="medical"]');
  await emp.check('input[name="benefit"][value="dental"]');
  check("ticking benefits adds a Benefits section with standard lines", (await emp.inputValue("#p-desc"))
    === "Lead our lakehouse migration.\nJack Henry or Fiserv core experience is a plus.\n\nBenefits\n- Medical insurance\n- Dental insurance");
  await emp.uncheck('input[name="benefit"][value="dental"]');
  check("…unticking takes its line out", !(await emp.inputValue("#p-desc")).includes("Dental insurance") && (await emp.inputValue("#p-desc")).includes("- Medical insurance"));
  await emp.click('[data-benefit-preset="common"][data-prefix="p"]');
  check("'Tick the usual package' adds the common nine", (await emp.locator('input[name="benefit"][data-prefix="p"]:checked').count()) === 9
    && (await emp.inputValue("#p-desc")).includes("- Employer match on 401(k) contributions") && (await emp.inputValue("#p-desc")).includes("- Paid sick leave"));
  await shot(emp, "03c-benefits");
  // Deleting a line by hand unticks its box.
  await emp.fill("#p-desc", (await emp.inputValue("#p-desc")).replace("- Vision insurance\n", ""));
  check("…and deleting a line by hand unticks its box", !(await emp.isChecked('input[name="benefit"][value="vision"]')) && await emp.isChecked('input[name="benefit"][value="medical"]'));

  await emp.click("#ai-draft");
  await emp.waitForSelector("#ai-preview:not([hidden])");
  check("the draft appears right under the Draft it button", await emp.evaluate(() => {
    const b = document.getElementById("ai-draft").getBoundingClientRect(), p = document.getElementById("ai-preview").getBoundingClientRect();
    return p.top > b.bottom && p.top - b.bottom < 120;
  }));
  await emp.waitForSelector("#ai-actions:not([hidden])", { timeout: 15000 });
  check("…formatted with headings and lists while the form is left alone until you choose", (await emp.locator("#ai-preview-body h3").count()) >= 3
    && (await emp.textContent("#ai-preview-summary")).startsWith("Run daily deposit operations")
    && (await emp.inputValue("#p-desc")).startsWith("Lead our lakehouse migration.")
    && (await emp.textContent("#ai-use")).startsWith("Replace"));
  await shot(emp, "03d-ai-preview");
  await emp.click("#ai-use");
  const drafted = await emp.inputValue("#p-desc");
  check("AI drafts the posting into the form", (await emp.inputValue("#p-summary")).startsWith("Run daily deposit operations")
    && drafted.includes("What you'll bring") && drafted.startsWith("About the role") && await emp.isHidden("#ai-preview"));
  check("…keeping the ticked benefits, after the last list and before the closing line", /- Experience with Fedwire\n\nBenefits\n- Medical insurance[\s\S]*- Paid sick leave\n\nReady\? Apply/.test(drafted), drafted);
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
  check("the description shows as headings and bullet lists", (await cand.locator(".detail .prose h3").count()) >= 3
    && (await cand.locator(".detail .prose li").count()) >= 5 && (await cand.textContent(".detail .prose h3 >> nth=1")) === "What you'll do");
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
  check("edit form keeps the Hybrid work schedule", await emp.isChecked("#e-mode-hybrid") && !(await emp.isChecked("#e-mode-onsite")));
  check("…with the benefit boxes ticked from the description", await emp.isChecked('input[name="benefit"][data-prefix="e"][value="medical"]')
    && !(await emp.isChecked('input[name="benefit"][data-prefix="e"][value="vision"]')) && !(await emp.isChecked('input[name="benefit"][data-prefix="e"][value="esop"]')));
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
  await adm.fill("#ad-key", "admin_e2e_token_0123456789abcdef0123");
  await adm.click("text=Open console");
  await adm.waitForSelector(".admin-figures");
  check("admin figures show $159.99 MRR from one plan with 6 postings", (await adm.textContent(".admin-figures strong")) === "$159.99"
    && (await adm.textContent(".admin-figures")).includes("1paying plans"));
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

  // ============================================================
  section("Early careers: new grads and internships");
  const grad = await newPage();
  await grad.goto(BASE + "/");
  await grad.waitForSelector(".early-card");
  const entryCount = (await stack.sql`SELECT COUNT(*)::int n FROM jobs WHERE status = 'open' AND expires_at > now() AND entry_level AND employment_type <> 'internship'`)[0].n;
  check("home has the new-grads and internships banners, right under the hero", (await grad.locator(".early-card").count()) === 2
    && await grad.evaluate(() => document.querySelector(".home-hero").nextElementSibling.classList.contains("early")));
  check("…the new-grads banner counts the entry-level roles", (await grad.textContent(".early-card >> nth=0")).includes(`${entryCount} entry-level roles`), entryCount);
  await grad.fill('form[data-early="new-grads"] input', "universal");
  await grad.click('form[data-early="new-grads"] button');
  await grad.waitForSelector("h1:has-text('Entry-level jobs for new graduates')");
  const gradRows = await grad.locator(".ledger .job-row").count();
  check("searching from the banner opens the new-grads page with the search applied", gradRows > 0
    && (await grad.inputValue("#f-q")) === "universal" && (await grad.inputValue("#f-level")) === "entry");
  check("…every result is tagged Entry level", (await grad.locator(".ledger .job-row .tag.early:has-text('Entry level')").count()) === gradRows);
  await shot(grad, "12-new-grads");
  await grad.click("nav >> text=Current positions");
  await grad.waitForSelector("h1:has-text('Current positions')");
  const liveAll = (await stack.sql`SELECT COUNT(*)::int n FROM jobs WHERE status = 'open' AND expires_at > now()`)[0].n;
  check("going to Current positions shows everything again", (await grad.inputValue("#f-level")) === "" && (await grad.inputValue("#f-q")) === ""
    && (await grad.locator(".ledger .job-row").count()) === liveAll);

  // A bank posts an internship from the home banner.
  await emp.goto(BASE + "/");
  await emp.waitForSelector("[data-post-internship]");
  await emp.click(".early [data-post-internship]");
  await emp.waitForSelector("#post-form");
  check("'Post an internship' opens the form set up as an internship", (await emp.inputValue("#p-emp")) === "internship"
    && await emp.isChecked("#p-entry") && (await emp.textContent("#post-form .step-title >> nth=0")).endsWith("The internship"));
  await emp.fill("#p-title", "Summer Banking Internship");
  await emp.fill("#p-location", "Florence, AL");
  await emp.selectOption("#p-cat", "branch-retail");
  await emp.fill("#p-summary", "Ten weeks across our branches, lending and operations teams, with a capstone project.");
  await emp.click("#post-form button[type=submit]");
  await emp.waitForSelector(".plan-panel");
  check("the internship goes live under the plan", (await emp.textContent("#flash")).includes("Your posting is live"));
  await grad.goto(BASE + "/");
  await grad.reload();
  await grad.waitForSelector(".intern-ads.interns");
  check("the internships banner shows it, marked Direct", (await grad.textContent(".intern-ads.interns")).includes("Summer Banking Internship")
    && (await grad.locator(".intern-ads.interns .tag.direct").count()) >= 1);
  await grad.evaluate(() => window.scrollTo(0, 0));
  await grad.screenshot({ path: `${SHOTS}/01b-early-careers.png`, fullPage: true, clip: { x: 0, y: 560, width: 1280, height: 640 } });
  await grad.click('form[data-early="internships"] button');
  await grad.waitForSelector("h1:has-text('Banking internships')");
  check("Find internships lists only internships", (await grad.locator(".ledger .job-row").count()) === 1
    && (await grad.textContent(".ledger")).includes("Summer Banking Internship") && (await grad.locator(".hero [data-post-internship]").count()) === 1);
  await shot(grad, "13-internships");
  // Typing a new-grad box when choosing Internship.
  await emp.goto(BASE + "/#post");
  await emp.waitForSelector("#p-entry");
  check("the new-grads box starts unticked for an ordinary posting", !(await emp.isChecked("#p-entry")));
  await emp.selectOption("#p-emp", "internship");
  check("…and choosing Internship ticks it", await emp.isChecked("#p-entry"));

  const phoneHome = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phoneHome.goto(BASE + "/");
  await phoneHome.waitForSelector(".early-card");
  const phoneOverflow = await phoneHome.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1);
  const stacked = await phoneHome.evaluate(() => { const [a, b] = document.querySelectorAll(".early-card"); return b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom; });
  check("on a phone the banners stack, with no sideways scrolling", stacked && !phoneOverflow);
  await shot(phoneHome, "14-early-phone");

  section("Contact us");
  const visitor = await newPage();
  await visitor.goto(BASE + "/");
  await visitor.click('.site-head nav a[href="#contact"]');
  await visitor.waitForSelector("#contact-form");
  check("Contact link in the header opens the contact page, marked current",
    (await visitor.textContent(".contact-head h1")) === "Contact us"
    && (await visitor.getAttribute('.site-head nav a[href="#contact"]', "aria-current")) === "page");
  check("footer links to the contact page", await visitor.locator('.site-foot a[href="/#contact"]').count() === 1);
  check("email button opens a message to administrator@bankjobz.com",
    (await visitor.getAttribute("#contact-mailto", "href")).startsWith("mailto:administrator@bankjobz.com?subject=")
    && (await visitor.textContent("#contact-mailto")).trim() === "Email administrator@bankjobz.com");
  check("a visitor who isn't signed in picks a topic themselves", (await visitor.inputValue("#c-topic")) === "");
  await visitor.click("#contact-form button[type=submit]");
  check("sending an empty form explains what's missing and focuses the name",
    (await visitor.textContent("#contact-msg")) === "Add your name." && await visitor.evaluate(() => document.activeElement.id === "c-name"));
  await visitor.fill("#c-name", "Morgan Pike");
  await visitor.fill("#c-email", "morgan@valleycu.test");
  await visitor.fill("#c-org", "Valley Credit Union");
  await visitor.click("#contact-form button[type=submit]");
  check("…then asks for a topic", (await visitor.textContent("#contact-msg")) === "Pick what your message is about.");
  await visitor.selectOption("#c-topic", "partnership");
  await visitor.fill("#c-message", "We'd like to sponsor the internships section next spring.");
  await shot(visitor, "15-contact");
  await visitor.click("#contact-form button[type=submit]");
  await visitor.waitForSelector("text=Message sent");
  const contactMail = stack.outbox().findLast((m) => m.to === "administrator@bankjobz.com");
  check("the message reaches administrator@bankjobz.com, ready to reply to",
    contactMail && contactMail.replyTo === "morgan@valleycu.test" && contactMail.subject.includes("Partnerships and advertising: Morgan Pike, Valley Credit Union")
    && contactMail.text.includes("sponsor the internships section"));
  check("the visitor sees a confirmation with their address", (await visitor.textContent("#contact-form")).includes("We'll reply to morgan@valleycu.test"));

  await emp.goto(BASE + "/#contact");
  await emp.waitForSelector("#contact-form");
  check("a signed-in employer starts on the employer topic", (await emp.inputValue("#c-topic")) === "employer");

  await adm.reload(); // the console was opened earlier, before this message existed
  await adm.waitForSelector("#admin-messages");
  const inbox = await adm.textContent("#admin-messages");
  check("admin console lists the message with a reply link", inbox.includes("Morgan Pike") && inbox.includes("Valley Credit Union")
    && inbox.includes("Partnerships and advertising")
    && (await adm.getAttribute('#admin-messages a[href^="mailto:morgan@valleycu.test"]', "href")) !== null);

  const phoneContact = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phoneContact.goto(BASE + "/#contact");
  await phoneContact.waitForSelector("#contact-form");
  const contactOverflow = await phoneContact.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1);
  check("contact page fits a phone with no sideways scrolling", !contactOverflow);
  await shot(phoneContact, "16-contact-phone");
  const phoneHead = await phoneContact.evaluate(() => { const h = document.querySelector(".site-head"); return h.getBoundingClientRect().height; });
  check("header nav with Contact still fits on a phone", phoneHead < 200, phoneHead);

  check("contact page says BankJobz is veteran-owned", (await visitor.textContent(".vet-note")).includes("Veteran-owned small business"));
  check("footer says veteran-owned and that a percentage of sales helps veterans",
    (await visitor.textContent(".site-foot .vet-line")) === "A veteran-owned small business. A percentage of every sale goes to help veterans in need.");
  await visitor.goto(BASE + "/privacy.html");
  const privacyText = await visitor.textContent("main.legal");
  check("privacy policy has a Who we are section on the veteran-owned business",
    privacyText.includes("Who we are") && privacyText.includes("veteran-owned small business") && privacyText.includes("don't share your information with any veterans' organization"));
  await visitor.goto(BASE + "/terms.html");
  check("terms page footer carries the veteran-owned line", (await visitor.locator(".site-foot .vet-line").count()) === 1);

  // ---------- helpers for the sections below: accounts made through the real API ----------
  const apiJson = async (method, path, body, token) => {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const employerToken = async (email, company) => {
    const r = await apiJson("POST", "/api/auth/signup", { contact_name: "Pat Lee", contact_title: "HR Director", company, email, password: "Shoals-Teller-Window-42", institution_type: "bank" });
    const code = [...stack.outbox()].reverse().find((m) => m.to === email.toLowerCase())?.subject.match(/(\d{6})$/)?.[1];
    const v = await apiJson("POST", "/api/auth/verify", { challenge: r.data?.challenge, code });
    if (!v.data?.token) throw new Error(`sign-up failed for ${email}: ${JSON.stringify(r.data)} ${JSON.stringify(v.data)}`);
    return v.data.token;
  };
  const pageAs = async (storageKey, token, opts) => {
    const pg = await newPage(opts);
    await pg.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* none */ } }, [storageKey, token]);
    return pg;
  };

  section("First paint: the page draws before its data arrives");
  const slow = await newPage();
  // Hold the job list and plan prices back for 3 seconds, like a cold database and Stripe.
  await slow.route(/\/api\/(jobs|plan)(\?|$)/, async (rt) => { await new Promise((res) => setTimeout(res, 3000)); await rt.continue(); });
  const t0 = Date.now();
  await slow.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await slow.waitForSelector(".home-hero h1", { timeout: 1500 });
  const drawnIn = Date.now() - t0;
  const footTop = await slow.evaluate(() => document.querySelector(".site-foot").getBoundingClientRect().top);
  const vh = await slow.evaluate(() => window.innerHeight);
  check("home page draws within a second while the data is still loading", drawnIn < 1000, `${drawnIn} ms`);
  check("…and the footer stays below the fold meanwhile", footTop >= vh, { footTop, vh });
  check("…with placeholders where the numbers go", (await slow.textContent(".statement-head")).includes("Loading") && await slow.locator(".statement li.skel").count() === 4);
  await slow.fill('form[data-early="new-grads"] input', "teller");
  await slow.waitForSelector(".statement li a", { timeout: 6000 });
  check("when the data arrives the numbers fill in", /\d+ open/.test(await slow.textContent(".statement-head")));
  check("…keeping anything already typed in a search box", (await slow.inputValue('form[data-early="new-grads"] input')) === "teller");
  const slowJobs = await newPage();
  await slowJobs.route(/\/api\/jobs(\?|$)/, async (rt) => { await new Promise((res) => setTimeout(res, 2000)); await rt.continue(); });
  await slowJobs.goto(BASE + "/#jobs", { waitUntil: "domcontentloaded" });
  await slowJobs.waitForSelector(".boot-wait", { timeout: 1500 });
  const jfoot = await slowJobs.evaluate(() => document.querySelector(".site-foot").getBoundingClientRect().top >= window.innerHeight);
  check("a page built from the job list shows a placeholder, footer below the fold, until the list arrives", jfoot);
  await slowJobs.waitForSelector("#job-list li, .job-list li, .job-row, [data-job]", { timeout: 6000 }).catch(() => {});
  check("…then the list draws", await slowJobs.locator(".boot-wait").count() === 0);

  section("Site statistics");
  const REAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  await stack.sql`DELETE FROM page_hits`;
  const visitorPage = await newPage({ userAgent: REAL_UA });
  await visitorPage.goto(BASE + "/?utm_source=email&utm_medium=outreach&utm_campaign=hr-intro-nov#home");
  await visitorPage.waitForSelector(".home-hero h1");
  await visitorPage.click('a[href="#jobs"] >> nth=0');
  await visitorPage.waitForSelector(".boot-wait, #jobs-list, .job-list, .results", { timeout: 5000 }).catch(() => {});
  await visitorPage.waitForTimeout(600);
  const views = await stack.sql`SELECT path, landing, utm_source, utm_campaign, device FROM page_hits ORDER BY id`;
  check("a real visit sends one view per page, the first carrying its campaign", views.length === 2 && views[0].path === "home" && views[0].landing
    && views[0].utm_campaign === "hr-intro-nov" && views[1].path === "jobs" && !views[1].landing, views);
  check("no cookies are set", (await visitorPage.context().cookies()).length === 0);
  const gpcPage = await newPage({ userAgent: REAL_UA });
  await gpcPage.addInitScript(() => { Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }); });
  await gpcPage.goto(BASE + "/#jobs");
  await gpcPage.waitForTimeout(800);
  check("a browser sending Global Privacy Control isn't counted", (await stack.sql`SELECT COUNT(*)::int AS n FROM page_hits`)[0].n === 2);
  const admPageViews = (await stack.sql`SELECT COUNT(*)::int AS n FROM page_hits`)[0].n;
  await adm.reload();
  await adm.waitForSelector("#admin-traffic .traffic-figures", { timeout: 8000 });
  const trafficText = await adm.textContent("#admin-traffic");
  check("admin console: Site traffic with visitors, sources and the campaign", trafficText.includes("Where visitors come from") && trafficText.includes("hr-intro-nov")
    && trafficText.includes("page views") && trafficText.includes("How to see which emails and ads work"));
  check("the site owner's own console visits aren't counted", (await stack.sql`SELECT COUNT(*)::int AS n FROM page_hits`)[0].n === admPageViews);
  await adm.click('#admin-traffic [data-days="7"]');
  await adm.waitForSelector('#admin-traffic [data-days="7"][aria-pressed="true"]');
  check("the range switches to 7 days", (await adm.textContent("#admin-traffic .traffic-axis")).length > 0);
  await shot(adm, "23-admin-traffic");

  section("Pay-transparency check on the post form");
  const ptKey = await employerToken("pat@paycheck.test", "Paycheck Savings Bank");
  const pt = await pageAs("bankstack.key", ptKey);
  await pt.goto(BASE + "/#post");
  await pt.waitForSelector("#post-form");
  check("no note for a state without a pay-range law", await pt.locator("#p-paylaw").isHidden());
  const settle = () => pt.waitForTimeout(80); // the note updates just after each change
  await pt.fill("#p-location", "Denver, CO");
  await settle();
  const warnText = await pt.textContent("#p-paylaw");
  check("Colorado location with no pay: a warning naming the law and threshold",
    (await pt.getAttribute("#p-paylaw", "class")).includes("warn") && warnText.includes("Colorado requires a pay range") && warnText.includes("employers of any size")
    && warnText.includes("not legal advice"), warnText);
  await pt.fill("#p-min", "52,000");
  await pt.fill("#p-max", "61,000");
  await settle();
  check("with a range it turns to a confirmation, plus Colorado's benefits note",
    (await pt.textContent("#p-paylaw")).includes("Pay range included") && (await pt.textContent("#p-paylaw")).includes("description of benefits"));
  await pt.check('input[name="benefit"][value="medical"]');
  await settle();
  check("ticking a benefit satisfies the benefits note",
    (await pt.getAttribute("#p-paylaw", "class")).includes("ok") && !(await pt.textContent("#p-paylaw")).includes("description of benefits"));
  await pt.fill("#p-min", "");
  await pt.fill("#p-location", "Anywhere in the US");
  await pt.click('#p-mode label:has(#p-mode-remote)');
  await settle();
  check("remote with no pay: reminds that CA, CO, NY and WA laws can reach remote roles",
    (await pt.textContent("#p-paylaw")).includes("Remote roles") && (await pt.textContent("#p-paylaw")).includes("Washington"));
  await pt.fill("#p-location", "Denver, CO");
  await pt.click('#p-mode label:has(#p-mode-onsite)');
  await shot(pt, "17-pay-transparency");

  section("Billing choices: yearly and pay by invoice");
  check("no plan yet: Monthly / Yearly and Card / Invoice choices",
    await pt.locator('input[name="billing_interval"][value="year"]').count() === 1 && await pt.locator('input[name="pay_by"][value="invoice"]').count() === 1
    && (await pt.textContent(".billing-pick")).includes("2 months free") && await pt.locator(".invoice-fields").isHidden());
  check("monthly card is the default: $99 due today", (await pt.textContent("#checkout-line")).includes("due today, then monthly") && (await pt.textContent("#post-submit")).trim() === "Continue to payment");
  await pt.click('label.mode-opt:has(input[name="billing_interval"][value="year"])');
  check("yearly: $990", (await pt.textContent("#checkout-line")).includes("$990"));
  await pt.click('label.mode-opt:has(input[name="pay_by"][value="invoice"])');
  check("invoice: billing email and PO fields appear; the button says it publishes and invoices",
    await pt.locator(".invoice-fields").isVisible() && (await pt.textContent("#post-submit")).trim() === "Publish and send invoice"
    && (await pt.textContent("#checkout-line")).includes("pat@paycheck.test") && (await pt.textContent("#checkout-line")).includes("due in 30 days"));
  await pt.fill("#p-billing-email", "ap@paycheck.test");
  await pt.fill("#p-po", "PO-881");
  check("the line follows the billing email as it's typed", (await pt.textContent("#checkout-line")).includes("ap@paycheck.test"));
  await pt.fill("#p-title", "Teller");
  await pt.fill("#p-min", "38,000");
  await pt.fill("#p-max", "44,000");
  await pt.fill("#p-summary", "Serve members at our downtown Denver branch.");
  await shot(pt, "18-billing-choices");
  const ptSessions = stack.fakeStripe.sessions.size;
  await pt.click("#post-submit");
  await pt.waitForSelector(".plan-panel");
  check("publishing by invoice goes straight to the dashboard, live, with no Stripe Checkout",
    stack.fakeStripe.sessions.size === ptSessions && (await pt.textContent("body")).includes("Stripe will email your invoice"));
  const ptPlan = await pt.textContent(".plan-panel");
  check("plan panel: yearly, paid by invoice, priced per year", ptPlan.includes("Yearly · paid by invoice") && ptPlan.includes("$990") && ptPlan.includes("/yr"), ptPlan.slice(0, 300));
  check("…and offers card billing instead (no yearly switch: it's already yearly)",
    await pt.locator('[data-billing="card"]').count() === 1 && await pt.locator('[data-billing="year"]').count() === 0);

  // A monthly card plan switches to yearly from the dashboard.
  const swKey = await employerToken("pat@switchui.test", "Switch UI Bank");
  const sw = await pageAs("bankstack.key", swKey);
  await sw.goto(BASE + "/#post");
  await sw.waitForSelector("#post-form");
  await sw.fill("#p-title", "Loan Processor");
  await sw.fill("#p-location", "Florence, AL");
  await sw.fill("#p-summary", "Process consumer and mortgage loans from application to close.");
  await sw.click("#post-submit");
  await sw.waitForURL(/checkout\.stripe\.test|#welcome|#dashboard/);
  await sw.goto(BASE + "/#dashboard");
  await sw.waitForSelector(".dash-tabs, .kpis");
  await sw.click('text=Postings');
  await sw.waitForSelector('[data-billing="year"]');
  await sw.click('[data-billing="year"]');
  check("switching to yearly asks for a second click, saying what's billed", (await sw.textContent("body")).includes("Click again to confirm"));
  await sw.click('[data-billing="year"]');
  await sw.waitForSelector(".plan-how:has-text('Yearly')");
  check("…then the plan is yearly", (await sw.textContent(".plan-panel")).includes("Yearly · paid by card"));
  await sw.click('[data-billing="invoice"]');
  check("Pay by invoice instead opens the billing email form", await sw.locator(".invoice-switch").isVisible());
  await sw.fill("#sw-billing-email", "ap@switchui.test");
  await sw.click('.invoice-switch button[type=submit]');
  await sw.waitForSelector(".plan-how:has-text('invoice')");
  check("…and switches to invoice billing", (await sw.textContent(".plan-panel")).includes("Yearly · paid by invoice"));

  section("Claim your listings");
  const [claimInst] = await stack.sql`INSERT INTO institutions (slug, name, normalized_name, institution_type, regulator_id, city, state, website)
    VALUES ('claim-test-bank-austin-tx', 'Claim Test Bank', 'claim test bank', 'bank', '9901', 'Austin', 'TX', 'https://www.claimbank.test') RETURNING *`;
  const claimJobs = [];
  for (const [title, i] of [["Personal Banker", 0], ["Credit Analyst", 1]]) {
    const [j] = await stack.sql`INSERT INTO jobs (title, company, institution_type, location, category, summary, apply_url, source_name, source_url, institution_id, salary_min, salary_max, expires_at)
      VALUES (${title}, 'Claim Test Bank', 'bank', 'Austin, TX', 'branch-retail', ${title + " at Claim Test Bank."}, ${"https://claimbank.test/jobs/" + i}, 'Claim Test careers',
              ${"https://claimbank.test/jobs/" + i}, ${claimInst.id}, 50000, 60000, now() + interval '30 days') RETURNING id`;
    claimJobs.push(j.id);
  }
  const anon = await newPage();
  await anon.goto(BASE + "/#job-" + claimJobs[0]);
  await anon.waitForSelector(".claim-strip");
  check("a gathered listing invites its bank to claim it", (await anon.textContent(".claim-strip")).includes("Hiring at Claim Test Bank?"));
  await anon.click(".claim-strip a");
  await anon.waitForSelector(".claim-page");
  check("claim page, signed out: the listings, the free trial, and a sign-up prefilled with the bank's name",
    (await anon.textContent(".claim-head h1")) === "Claim Test Bank" && (await anon.textContent(".claim-page")).includes("Free for 30 days")
    && await anon.locator(".claim-job").count() === 2 && (await anon.textContent(".claim-step")).includes("claimbank.test"));
  await anon.click('[data-auth-tab="signup"]').catch(() => {});
  const prefill = await anon.inputValue("#su-company").catch(() => "");
  check("the sign-up form is prefilled with the institution", prefill === "Claim Test Bank", prefill);
  await shot(anon, "19-claim-signed-out");
  const ctKey = await employerToken("pat@claimbank.test", "Claim Test Bank");
  const ct = await pageAs("bankstack.key", ctKey);
  await ct.goto(BASE + "/#claim-claim-test-bank-austin-tx");
  await ct.waitForSelector("#claim-form");
  check("signed in with a work email on the bank's domain: approved instantly", (await ct.textContent(".claim-instant")).includes("claimbank.test"));
  await ct.uncheck(`input[name="job_ids"][value="${claimJobs[1]}"]`);
  check("the button counts what's picked", (await ct.textContent("#claim-form button[type=submit]")).trim() === "Claim 1 listing");
  await ct.check(`input[name="job_ids"][value="${claimJobs[1]}"]`);
  await shot(ct, "20-claim-signed-in");
  await ct.click("#claim-form button[type=submit]");
  await ct.waitForSelector(".plan-panel");
  const ctBody = await ct.textContent("body");
  check("claimed: both listings are theirs and live, on a free trial", ctBody.includes("2 listings are now yours and live") && ctBody.includes("Free until"));
  check("plan panel shows the trial and how to keep going", (await ct.textContent(".plan-panel")).includes("Free trial until") && (await ct.textContent(".plan-panel")).includes("add a card"));
  check("the postings list shows them", (await ct.textContent("body")).includes("Personal Banker") && (await ct.textContent("body")).includes("Credit Analyst"));
  await shot(ct, "21-claimed-dashboard");

  section("NMLS-verified candidates");
  stack.outbox().length = 0;
  await apiJson("POST", "/api/candidate-auth/request", { email: "nmls.nora@example.test", name: "Nora Lane" });
  const nl = [...stack.outbox()].reverse().find((m) => m.to === "nmls.nora@example.test")?.text.match(/clogin=([a-f0-9]{48})/)?.[1];
  const nk = (await apiJson("POST", "/api/candidate-auth/verify", { token: nl })).data.token;
  const nora = await pageAs("bankjobz.ck", nk);
  await nora.goto(BASE + "/#profile");
  await nora.waitForSelector("#profile-form");
  check("profile has an NMLS ID field explaining the badge", (await nora.textContent(".nmls-field")).includes("badge"));
  await nora.fill("#pr-name", "Nora Lane");
  await nora.fill("#pr-nmls", "12x");
  await nora.click("#profile-form button[type=submit]");
  check("a malformed NMLS ID is caught in the form", (await nora.textContent("#pr-msg")).includes("up to 10 digits"));
  await nora.fill("#pr-nmls", "1234567");
  await nora.click("#profile-form button[type=submit]");
  await nora.waitForURL(/#matches/);
  await nora.goto(BASE + "/#profile");
  await nora.waitForSelector("#pr-nmls-status");
  check("after saving: being checked", (await nora.textContent("#pr-nmls-status")).includes("Being checked"));
  await adm.reload();
  await adm.waitForSelector("#admin-nmls");
  check("admin queue links straight to the NMLS Consumer Access record",
    (await adm.getAttribute('#admin-nmls a[href*="nmlsconsumeraccess.org"]', "href")) === "https://www.nmlsconsumeraccess.org/EntityDetails.aspx/INDIVIDUAL/1234567");
  check("admin sees claims and the pitch list", await adm.locator("#admin-claims").count() === 1 && await adm.locator("#admin-claimable").count() === 1);
  await shot(adm, "22-admin-queues");
  await adm.click('#admin-nmls [data-decide="verify"]');
  await adm.waitForSelector("#admin-nmls >> text=Nothing waiting");
  await nora.reload();
  await nora.waitForSelector("#pr-nmls-status .nmls-ok");
  check("the candidate's profile shows NMLS verified", (await nora.textContent("#pr-nmls-status")).includes("NMLS verified"));

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
