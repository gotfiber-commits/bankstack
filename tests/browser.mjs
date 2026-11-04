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
  section("Employer posts a job and pays");
  await emp.click("nav >> text=Post a job");
  await emp.waitForSelector("#post-form");
  await emp.fill("#c-company", "Shoals Community Bank");
  await emp.fill("#c-email", "hr@shoalsbank.test");
  await emp.selectOption("#c-type", "bank");
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
  await emp.goto(BASE + "/#jobs");
  await emp.waitForSelector("#f-core");
  await emp.selectOption("#f-core", "fiserv-dna");
  check("core-system filter finds the tagged posting", (await emp.locator(".ledger .job-row").count()) === 1);
  await emp.goto(BASE + "/#dashboard");
  await emp.waitForSelector(".dash-head h1");

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
  check("nav from a /jobs page goes back to the board", (await cand.locator(".ledger .job-row").count()) === SEED_LEN + 1 && new URL(cand.url()).pathname === "/");
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
  await emp.reload();
  await emp.waitForSelector("select.stage");
  check("applicant appears, flagged new", (await emp.textContent("tr.is-new")).includes("Jordan Lee"));
  const [download] = await Promise.all([emp.waitForEvent("download"), emp.click("text=Jordan_Lee_Resume.pdf")]);
  const saved = await download.path();
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
  check("admin figures show $99 MRR from one paid posting", (await adm.textContent(".admin-figures strong")) === "$99");
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
  lines.push(`\n  ✗ crashed: ${err.stack}`);
} finally {
  console.log(lines.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${SHOTS}/`);
  await browser.close();
  await stack.stop();
  process.exit(failed ? 1 : 0);
}
