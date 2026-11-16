// Claim your listings: a bank or credit union takes over the listings BankJobz gathered from its own
// careers site, manages them from its dashboard, and gets a free trial of the plan (no card needed).
//
// Who can claim: a signed-in employer account. If the account's email is on the institution's own web
// domain (from FDIC/NCUA data), the claim is approved at once. Anything else (a different domain, no
// website on file) waits for the site owner to approve it in the admin console.
// One approved claim per institution, and one institution per employer account.
import { db, siteUrl } from "./shared.mjs";
import { publishPostings, startPlan, planLive, trialDays, invoiceDays, createPlanCheckout, BillingError } from "./billing.mjs";
import { sendEmail, layout, esc } from "./email.mjs";

// Free and personal mailboxes never prove anything about an employer.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "gmx.us", "mail.com", "zoho.com", "yandex.com", "fastmail.com", "hey.com",
  "comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "verizon.net", "charter.net", "cox.net",
]);
// Website hosts shared by many sites: a domain match on these proves nothing.
const SHARED_HOSTS = new Set([
  "wixsite.com", "wordpress.com", "google.com", "godaddysites.com", "squarespace.com", "weebly.com",
  "facebook.com", "blogspot.com", "webflow.io", "netlify.app", "github.io", "linkedin.com", "site123.me",
]);

// The registrable part of a host name, close enough for US bank sites: the last two labels
// (www.firstbank.com → firstbank.com, mail.fmb.bank → fmb.bank).
export function baseDomain(host) {
  const h = String(host || "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!h || !h.includes(".")) return "";
  return h.split(".").slice(-2).join(".");
}

export function siteHost(website) {
  const w = String(website || "").trim();
  if (!w) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(w) ? w : `https://${w}`).hostname; } catch { return ""; }
}

// Does this email address belong to the institution's own domain?
export function domainMatches(email, website) {
  const at = String(email || "").toLowerCase().split("@");
  const mailDomain = at.length === 2 ? at[1] : "";
  if (!mailDomain || FREE_MAIL.has(mailDomain)) return false;
  const site = baseDomain(siteHost(website));
  if (!site || SHARED_HOSTS.has(site)) return false;
  return baseDomain(mailDomain) === site;
}

// Open listings we gathered for this institution (not yet anybody's postings).
export async function claimableJobs(sql, inst) {
  return sql`
    SELECT id, title, location, work_mode, employment_type, category, salary_min, salary_max, posted_at, apply_url
    FROM jobs
    WHERE employer_id IS NULL AND status = 'open' AND expires_at > now()
      AND (institution_id = ${inst.id} OR lower(company) = lower(${inst.name}))
    ORDER BY posted_at DESC LIMIT 200`;
}

export async function institutionBySlug(sql, slug) {
  if (!/^[a-z0-9-]{1,120}$/.test(String(slug || ""))) return null;
  const [inst] = await sql`SELECT id, slug, name, institution_type, city, state, website, employees
    FROM institutions WHERE slug = ${slug} AND active`;
  return inst || null;
}

// Public: what claiming this institution involves. viewer (optional) is the signed-in employer.
export async function claimInfo(slug, viewer = null) {
  const sql = db();
  const inst = await institutionBySlug(sql, slug);
  if (!inst) return null;
  const jobs = await claimableJobs(sql, inst);
  const [approved] = await sql`SELECT employer_id FROM institution_claims WHERE institution_id = ${inst.id} AND status = 'approved'`;
  const [mine] = viewer ? await sql`SELECT status FROM institution_claims
    WHERE institution_id = ${inst.id} AND employer_id = ${viewer.id} ORDER BY created_at DESC LIMIT 1` : [];
  const site = baseDomain(siteHost(inst.website));
  return {
    institution: { slug: inst.slug, name: inst.name, institution_type: inst.institution_type, city: inst.city, state: inst.state,
      domain: site && !SHARED_HOSTS.has(site) ? site : null },
    jobs: jobs.map(({ apply_url, ...j }) => j),
    trial_days: trialDays(),
    claimed: !!approved,
    claimed_by_you: !!(approved && viewer && String(approved.employer_id) === String(viewer.id)),
    your_claim: mine?.status || null,
    instant: viewer ? domainMatches(viewer.email, inst.website) : null,
  };
}

// Turns the institution's selected sourced listings into the employer's own postings and puts them
// live: under the employer's plan if they have one, or a new free trial if they've never had one.
// Returns { converted, live, trial_end, needs_confirm?, needs_plan? }.
async function takeOver(sql, employerId, inst, jobIds) {
  const [e] = await sql`SELECT * FROM employers WHERE id = ${employerId}`;
  const ids = (jobIds || []).map(Number).filter(Number.isFinite);
  const converted = await sql`
    UPDATE jobs SET employer_id = ${e.id}, company = ${e.company}, institution_type = ${e.institution_type},
      institution_id = ${inst.id}, source_name = NULL, status = 'pending', closed_by = NULL, is_featured = true,
      updated_at = now()
    WHERE employer_id IS NULL AND status = 'open' AND expires_at > now()
      AND (institution_id = ${inst.id} OR lower(company) = lower(${inst.name}))
      AND (${ids.length === 0} OR id = ANY(${ids}))
    RETURNING id`;
  const convertedIds = converted.map((j) => j.id);
  const out = { converted: convertedIds.length, live: 0, trial_end: null };
  if (!convertedIds.length) return out;

  let emp = e;
  if (!planLive(emp)) {
    if (emp.trial_used_at) return { ...out, needs_plan: true };
    emp = await startPlan(e.id, { trial: true, quantity: convertedIds.length });
    out.trial_end = emp.plan_trial_end;
  }
  const r = await publishPostings(e.id, convertedIds, { confirm: !!out.trial_end });
  if (r.needs_confirm) return { ...out, needs_confirm: true, count: r.count, from_cents: r.from_cents, to_cents: r.to_cents, interval: r.interval };
  return { ...out, live: (r.opened || []).length };
}

async function approve(sql, claim, inst) {
  const [e] = await sql`SELECT * FROM employers WHERE id = ${claim.employer_id}`;
  try {
    await sql`UPDATE institution_claims SET status = 'approved', decided_at = now() WHERE id = ${claim.id}`;
  } catch (err) {
    if (err.code === "23505") {
      await sql`UPDATE institution_claims SET status = 'rejected', note = 'Already claimed by another account', decided_at = now() WHERE id = ${claim.id}`;
      throw new BillingError("This institution has already been claimed by another account.", 409);
    }
    throw err;
  }
  await sql`UPDATE employers SET institution_id = ${inst.id} WHERE id = ${e.id}`;
  return takeOver(sql, e.id, inst, claim.job_ids);
}

// An employer claims an institution (and some or all of its listings).
// → { status: 'approved', ...takeOver result } | { status: 'pending' }
export async function submitClaim(employer, slug, jobIds = []) {
  const sql = db();
  const inst = await institutionBySlug(sql, slug);
  if (!inst) throw new BillingError("We couldn't find that institution.", 404);
  if (employer.institution_id && String(employer.institution_id) !== String(inst.id)) {
    throw new BillingError("Your account already manages another institution. Each account manages one; contact us if that's wrong.", 409);
  }
  const ids = (Array.isArray(jobIds) ? jobIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);

  const [approved] = await sql`SELECT * FROM institution_claims WHERE institution_id = ${inst.id} AND status = 'approved'`;
  if (approved && String(approved.employer_id) !== String(employer.id)) {
    throw new BillingError(`${inst.name} has already been claimed by another account. Ask your colleague to add you, or contact us.`, 409);
  }
  if (approved) {
    // Already theirs: bring over listings gathered since.
    return { status: "approved", ...(await takeOver(sql, employer.id, inst, ids)) };
  }

  const instant = domainMatches(employer.email, inst.website);
  const [pending] = await sql`SELECT * FROM institution_claims
    WHERE institution_id = ${inst.id} AND employer_id = ${employer.id} AND status = 'pending'`;
  let claim = pending;
  if (claim) {
    await sql`UPDATE institution_claims SET job_ids = ${ids}, method = ${instant ? "domain" : "review"} WHERE id = ${claim.id}`;
    claim = { ...claim, job_ids: ids };
  } else {
    [claim] = await sql`INSERT INTO institution_claims (institution_id, employer_id, method, job_ids)
      VALUES (${inst.id}, ${employer.id}, ${instant ? "domain" : "review"}, ${ids}) RETURNING *`;
  }
  if (instant) return { status: "approved", ...(await approve(sql, claim, inst)) };

  if (!pending) {
    const base = siteUrl();
    await sendEmail({
      to: process.env.CONTACT_TO || "administrator@bankjobz.com",
      replyTo: employer.email,
      subject: `[BankJobz] Claim to review: ${inst.name}`,
      text: `${employer.contact_name || employer.email} (${employer.email}, account "${employer.company}") asked to claim ${inst.name}${inst.city ? `, ${inst.city}, ${inst.state}` : ""}.\nTheir email isn't on the institution's website domain (${inst.website || "none on file"}), so it needs your review.\n\nApprove or reject it in the admin console: ${base}/#admin`,
      html: layout({
        heading: `Claim to review: ${inst.name}`,
        paragraphs: [
          `<b>${esc(employer.contact_name || employer.email)}</b> (${esc(employer.email)}, account “${esc(employer.company)}”) asked to claim <b>${esc(inst.name)}</b>${inst.city ? `, ${esc(inst.city)}, ${esc(inst.state)}` : ""}.`,
          `Their email isn't on the institution's website domain (${esc(inst.website || "none on file")}), so it needs your review. Reply to this email to ask them anything.`,
        ],
        button: { label: "Review in the admin console", url: `${base}/#admin` },
      }),
    });
  }
  return { status: "pending" };
}

// Admin: approve or reject a claim waiting for review.
export async function decideClaim(claimId, approveIt, note = "") {
  const sql = db();
  const [claim] = await sql`SELECT * FROM institution_claims WHERE id = ${claimId}`;
  if (!claim) throw new BillingError("Claim not found.", 404);
  if (claim.status !== "pending") throw new BillingError(`This claim was already ${claim.status}.`, 409);
  const [inst] = await sql`SELECT * FROM institutions WHERE id = ${claim.institution_id}`;
  const [e] = await sql`SELECT * FROM employers WHERE id = ${claim.employer_id}`;
  const base = siteUrl();
  if (!approveIt) {
    await sql`UPDATE institution_claims SET status = 'rejected', note = ${note || null}, decided_at = now() WHERE id = ${claim.id}`;
    await sendEmail({
      to: e.email,
      subject: `Your BankJobz claim for ${inst.name}`,
      text: `We couldn't confirm that your account works for ${inst.name}, so we haven't moved its listings to your dashboard.${note ? `\n\n${note}` : ""}\n\nThe quickest fix is to sign up with your work email on ${inst.name}'s own domain. Questions? Reply to this email or write to administrator@bankjobz.com.`,
      html: layout({ heading: `Your claim for ${inst.name}`, paragraphs: [
        `We couldn't confirm that your account works for <b>${esc(inst.name)}</b>, so we haven't moved its listings to your dashboard.`,
        ...(note ? [esc(note)] : []),
        `The quickest fix is to sign up with your work email on ${esc(inst.name)}'s own domain. Questions? Write to administrator@bankjobz.com.`] }),
    });
    return { status: "rejected" };
  }
  const result = await approve(sql, claim, inst);
  const when = result.trial_end ? new Date(result.trial_end).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
  const what = result.live
    ? `${result.live} listing${result.live === 1 ? " is" : "s are"} now yours and live in your dashboard${when ? `, free until ${when}` : ""}.`
    : result.converted ? `${result.converted} listing${result.converted === 1 ? " is" : "s are"} now in your dashboard, saved and ready to publish.`
    : "There are no open listings to move right now; anything you post is listed as yours.";
  await sendEmail({
    to: e.email,
    subject: `Approved: you now manage ${inst.name} on BankJobz`,
    text: `Your claim for ${inst.name} is approved. ${what}\n\nOpen your dashboard: ${base}/#dashboard`,
    html: layout({ heading: `You now manage ${inst.name}`, paragraphs: [`Your claim is approved. ${esc(what)}`],
      button: { label: "Open your dashboard", url: `${base}/#dashboard` } }),
  });
  return { status: "approved", ...result };
}

// A claimed institution's first posting starts the free trial instead of Checkout, if it's unused.
export async function startTrialIfEligible(employer) {
  if (!employer.institution_id || employer.trial_used_at || planLive(employer)) return false;
  const sql = db();
  const [ok] = await sql`SELECT 1 FROM institution_claims WHERE employer_id = ${employer.id} AND status = 'approved' LIMIT 1`;
  if (!ok) return false;
  await startPlan(employer.id, { trial: true, quantity: 1 });
  return true;
}

// A posting needs a plan and there isn't one: start the free trial (claimed institutions), a
// pay-by-invoice plan, or send them to Stripe Checkout to pay by card.
// → { live: true, trial: true } | { live: true, invoice: true } | { url }
export async function startPlanForPosting(employer, jobId, { interval = "month", payBy = "card", billingEmail = "", poNumber = "" } = {}) {
  const yearly = interval === "year";
  if (await startTrialIfEligible(employer)) {
    await publishPostings(employer.id, [jobId], { confirm: true });
    return { live: true, trial: true };
  }
  if (payBy === "invoice") {
    const to = String(billingEmail || "").trim().toLowerCase() || employer.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 200) throw new BillingError("Enter the email address invoices should go to (often accounts payable).");
    const po = String(poNumber || "").replace(/[\r\n]+/g, " ").trim().slice(0, 40);
    await startPlan(employer.id, { interval: yearly ? "year" : "month", invoice: true, billingEmail: to, poNumber: po });
    await publishPostings(employer.id, [jobId], { confirm: true });
    const sql = db();
    const [job] = await sql`SELECT title FROM jobs WHERE id = ${jobId}`;
    const base = siteUrl();
    await sendEmail({
      to: employer.email,
      subject: `Your posting is live: ${job?.title || "your job"}`,
      text: `${job?.title || "Your posting"} is live on BankJobz.\n\nYou chose to pay by invoice${yearly ? " (yearly plan)" : ""}. Stripe will email the invoice to ${to}${po ? ` with PO number ${po}` : ""}, due in ${invoiceDaysText()}. It can be paid by ACH bank transfer, wire, card or check. If it's still unpaid after the due date, your postings come down until it's paid.\n\nDashboard: ${base}/#dashboard`,
      html: layout({
        heading: "Your posting is live",
        paragraphs: [`<b>${esc(job?.title || "Your posting")}</b> is now listed for ${esc(employer.company)} as a Direct posting.`,
          `You chose to pay by invoice${yearly ? " (yearly plan)" : ""}. Stripe will email the invoice to <b>${esc(to)}</b>${po ? ` with PO number ${esc(po)}` : ""}, due in ${invoiceDaysText()}. It can be paid by ACH bank transfer, wire, card or check.`,
          "If it's still unpaid after the due date, your postings come down until it's paid."],
        button: { label: "Open your dashboard", url: `${base}/#dashboard` },
      }),
    });
    return { live: true, invoice: true };
  }
  return { url: await createPlanCheckout(employer, jobId, { interval: yearly ? "year" : "month" }) };
}

const invoiceDaysText = () => `${invoiceDays()} days`;
