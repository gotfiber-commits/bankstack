// Drives the real site in headless Chromium: the same clicks and form fills a person makes.
//   npx playwright install chromium   (once)
//   npm run test:browser
import { mkdirSync, writeFileSync } from "node:fs";
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
  check("headline shows", (await emp.textContent(".home-hero h1")).includes("banking technology"));
  check("live figures come from the database", (await emp.textContent(".figures-grid strong")) === "25");
  await shot(emp, "01-home");
  await emp.click("text=View current positions");
  await emp.waitForSelector(".ledger li");
  check("View current positions opens the board", (await emp.locator(".ledger .job-row").count()) === 25);
  await emp.click('.cat-chip[data-cat="architecture"]');
  check("specialty chip filters the list", (await emp.locator(".ledger .job-row").count()) === 5);
  await emp.fill("#f-q", "mission");
  check("search narrows it further", (await emp.locator(".ledger .job-row").count()) === 1);
  await shot(emp, "02-jobs");

  // ============================================================
  section("Employer posts a job and pays");
  await emp.click("nav >> text=Post a job");
  await emp.waitForSelector("#post-form");
  await emp.fill("#c-company", "Shoals Community Bank");
  await emp.fill("#c-email", "hr@shoalsbank.test");
  await emp.selectOption("#c-type", "bank");
  await emp.fill("#p-title", "Senior Data Architect");
  await emp.fill("#p-location", "Florence, AL");
  await emp.selectOption("#p-mode", "hybrid");
  await emp.selectOption("#p-cat", "architecture");
  await emp.fill("#p-min", "115,000");
  await emp.fill("#p-max", "140,000");
  await emp.fill("#p-summary", "Own the enterprise data model across core, lending and call reporting.");
  await emp.fill("#p-desc", "Lead our lakehouse migration.\nJack Henry or Fiserv core experience is a plus.");
  await shot(emp, "03-post-form");
  await emp.click("text=Continue to payment");
  await emp.waitForSelector("#welcome h2:has-text('Your job is live')", { timeout: 15000 });
  check("Stripe checkout returns to a 'job is live' page", true);
  const key = (await emp.textContent("#the-key")).trim();
  check("posting key shown", /^bsk_/.test(key));
  await shot(emp, "04-welcome");
  await emp.click("text=Go to dashboard");
  await emp.waitForSelector(".dash-head h1");
  check("dashboard shows the paid posting", (await emp.textContent(".dash")).includes("Senior Data Architect") && (await emp.textContent(".status-pill")).startsWith("Renews"));
  const jobId = (await stack.sql`SELECT id FROM jobs WHERE title = 'Senior Data Architect'`)[0].id;

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
  check("nav from a /jobs page goes back to the board", (await cand.locator(".ledger .job-row").count()) === 26 && new URL(cand.url()).pathname === "/");
  await cand.locator("#alerts-form .chip-check", { hasText: "Data architecture" }).click();
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
  await emp.reload();
  await emp.waitForSelector("select.stage");
  check("applicant appears, flagged new", (await emp.textContent("tr.is-new")).includes("Jordan Lee"));
  const [download] = await Promise.all([emp.waitForEvent("download"), emp.click("text=Jordan_Lee_Resume.pdf")]);
  const saved = await download.path();
  const { readFileSync } = await import("node:fs");
  check("résumé downloads intact", readFileSync(saved).equals(pdf) && download.suggestedFilename() === "Jordan_Lee_Resume.pdf");
  await emp.selectOption("select.stage", "interview");
  await emp.waitForSelector("#act-msg:has-text('Moved to Interview')");
  check("stage changed to Interview", (await stack.sql`SELECT status FROM applications`)[0].status === "interview");
  await shot(emp, "06-dashboard");

  await emp.click("td.acts >> text=Edit");
  await emp.waitForSelector("#edit-form");
  check("edit form is prefilled", (await emp.inputValue("#e-title")) === "Senior Data Architect" && (await emp.inputValue("#e-min")) === "115000");
  await emp.fill("#e-title", "Lead Data Architect");
  await emp.click("text=Save changes");
  await emp.waitForSelector("#flash:not([hidden])");
  await emp.waitForSelector(".dash td a:has-text('Lead Data Architect')");
  check("edit saves with a confirmation", (await emp.textContent("#flash")).includes("Posting updated"));

  await emp.click("text=Cancel posting");
  await emp.waitForSelector(".status-pill:has-text('Ends')");
  check("cancel posting: shows when it ends, offers Keep renewing", (await emp.locator("text=Keep renewing").count()) === 1);
  await emp.click("text=Keep renewing");
  await emp.waitForSelector(".status-pill:has-text('Renews')");
  check("keep renewing restores it", true);
  await emp.click("text=Cards & invoices");
  await emp.waitForSelector("text=Stripe billing portal");
  check("Cards & invoices opens Stripe's billing portal", true);

  // ============================================================
  section("Signing in on another device");
  const other = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await other.goto(BASE + "/#dashboard");
  await other.waitForSelector("#link-form");
  check("signed-out dashboard asks to sign in", true);
  await other.fill("#l-email", "hr@shoalsbank.test");
  await other.click("text=Email me a sign-in link");
  await other.waitForSelector("#link-msg:not([hidden])");
  const loginUrl = stack.outbox().findLast((m) => m.subject.includes("sign-in link"))?.text.match(/https?:\S+/)?.[0];
  await other.goto(loginUrl);
  await other.waitForSelector("#flash:not([hidden])");
  check("email link signs them in on a phone", (await other.textContent("#flash")).includes("Signed in as Shoals Community Bank"));
  await other.waitForSelector("select.stage");
  await shot(other, "07-dashboard-phone");
  const overflow = await other.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, ...[...document.querySelectorAll("main *")].map((e) => e.getBoundingClientRect().right)) > window.innerWidth + 1);
  check("no sideways scrolling at phone width", !overflow);
  await other.goto(BASE + "/");
  await other.waitForSelector(".home-hero h1");
  await shot(other, "08-home-phone");
  check("home page fits a phone screen", !(await other.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));

  // ============================================================
  section("Admin console");
  const adm = await newPage();
  await adm.goto(BASE + "/#admin");
  await adm.fill("#ad-key", "admin_e2e_token");
  await adm.click("text=Open console");
  await adm.waitForSelector(".admin-figures");
  check("admin figures show $99 MRR from one paid posting", (await adm.textContent(".admin-figures strong")) === "$99");
  const firstSourced = adm.locator('[data-admin="close"][data-direct="false"]').first();
  await firstSourced.click();
  check("take down asks for confirmation first", (await firstSourced.textContent()).includes("Confirm"));
  await firstSourced.click();
  await adm.waitForTimeout(300);
  const [{ n: closed }] = await stack.sql`SELECT COUNT(*)::int n FROM jobs WHERE status = 'closed'`;
  check("confirmed take down closes the listing", closed === 1);
  await shot(adm, "09-admin");

  check("no JavaScript errors on any page", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
  failed++;
  lines.push(`\n  ✗ crashed: ${err.stack}`);
} finally {
  console.log(lines.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${SHOTS}/`);
  await browser.close();
  await stack.stop();
  process.exit(failed ? 1 : 0);
}
