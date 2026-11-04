// Employer accounts and sign-in, all by emailed link (no passwords to forget or leak).
// POST /api/auth/signup  { contact_name, contact_title?, company, institution_type, email }
//                        → creates the account and emails a confirmation link that opens the dashboard.
// POST /api/auth/request { email } → emails a single-use sign-in link, valid 30 minutes.
// POST /api/auth/verify  { token } → { token: <account key>, company }; confirms the email on first use.
// signup and request always answer ok, so neither form reveals which emails have accounts.
import {
  db, json, fail, isEmail, clean, siteUrl, randomToken, sha256, newToken, INSTITUTION_TYPES,
} from "../lib/shared.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

async function sendLink(req, sql, employer, { welcome = false } = {}) {
  const token = randomToken();
  await sql`UPDATE employers SET login_token_hash = ${sha256(token)},
            login_token_expires = now() + interval '30 minutes' WHERE id = ${employer.id}`;
  const url = `${siteUrl(req)}/?login=${token}#dashboard`;
  if (welcome) {
    await sendEmail({
      to: employer.email,
      subject: "Confirm your BankJobz employer account",
      text: `Welcome to BankJobz. Confirm your email and open your ${employer.company} dashboard: ${url}\n\nThe link works once and expires in 30 minutes. If you didn't sign up, ignore this email.`,
      html: layout({
        heading: "Confirm your employer account",
        paragraphs: [
          `Welcome${employer.contact_name ? `, ${esc(employer.contact_name.split(" ")[0])}` : ""}. Confirm your email to open the <b>${esc(employer.company)}</b> dashboard, where you'll post jobs and review applicants.`,
          "The link works once and expires in 30 minutes. If you didn't sign up, you can ignore this email.",
        ],
        button: { label: "Confirm and open my dashboard", url },
      }),
    });
  } else {
    await sendEmail({
      to: employer.email,
      subject: "Your BankJobz sign-in link",
      text: `Sign in to your ${employer.company} dashboard: ${url}\n\nThe link works once and expires in 30 minutes.`,
      html: layout({
        heading: "Sign in to your dashboard",
        paragraphs: [`Use this link to sign in as <b>${esc(employer.company)}</b>. It works once and expires in 30 minutes.`,
          "If you didn't ask for it, you can ignore this email."],
        button: { label: "Sign in", url },
      }),
    });
  }
}

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return fail("Send JSON."); }
  const sql = db();
  const path = new URL(req.url).pathname;

  if (path === "/api/auth/signup") {
    if (clean(body.company_website)) return fail("Something went wrong. Try again."); // honeypot
    const contactName = clean(body.contact_name, 120);
    const company = clean(body.company, 160);
    const email = clean(body.email, 200).toLowerCase();
    const type = INSTITUTION_TYPES.includes(body.institution_type) ? body.institution_type : "bank";
    if (!contactName) return fail("Enter your name.");
    if (!company) return fail("Enter your institution's name.");
    if (!isEmail(email)) return fail("Enter a valid work email.");

    const [existing] = await sql`SELECT * FROM employers WHERE email = ${email}`;
    if (existing && (existing.verified_at || existing.api_token)) {
      // Already has an account: send a sign-in link rather than overwriting their details.
      await sendLink(req, sql, existing);
      return json({ ok: true });
    }
    const [employer] = existing
      ? await sql`UPDATE employers SET company = ${company}, institution_type = ${type},
                    contact_name = ${contactName}, contact_title = ${clean(body.contact_title, 120) || null}
                  WHERE id = ${existing.id} RETURNING *`
      : await sql`INSERT INTO employers (company, email, institution_type, contact_name, contact_title)
                  VALUES (${company}, ${email}, ${type}, ${contactName}, ${clean(body.contact_title, 120) || null})
                  RETURNING *`;
    await sendLink(req, sql, employer, { welcome: true });
    return json({ ok: true });
  }

  if (path === "/api/auth/request") {
    const email = clean(body.email, 200).toLowerCase();
    if (!isEmail(email)) return fail("Enter a valid email address.");
    const [employer] = await sql`SELECT * FROM employers WHERE email = ${email}`;
    if (employer) await sendLink(req, sql, employer, { welcome: !employer.verified_at && !employer.api_token });
    return json({ ok: true });
  }

  if (path === "/api/auth/verify") {
    const token = clean(body.token, 100);
    if (!/^[a-f0-9]{48}$/.test(token)) return fail("That sign-in link isn't valid.", 400);
    const [employer] = await sql`
      UPDATE employers SET login_token_hash = NULL, login_token_expires = NULL,
        api_token = COALESCE(api_token, ${newToken()}), verified_at = COALESCE(verified_at, now())
      WHERE login_token_hash = ${sha256(token)} AND login_token_expires > now()
      RETURNING company, api_token`;
    if (!employer) return fail("That sign-in link has expired or was already used. Request a new one.", 401);
    return json({ token: employer.api_token, company: employer.company });
  }

  return fail("Not found", 404);
};

export const config = { path: ["/api/auth/signup", "/api/auth/request", "/api/auth/verify"] };
