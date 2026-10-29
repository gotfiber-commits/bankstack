// Employer sign-in by email, so a lost posting key is never a dead end.
// POST /api/auth/request { email } → emails a single-use link, valid 30 minutes. Always answers ok,
//                                      so the form can't be used to discover which emails have accounts.
// POST /api/auth/verify  { token } → { token: <posting key>, company }
import { db, json, fail, isEmail, clean, siteUrl, randomToken, sha256 } from "../lib/shared.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return fail("Send JSON."); }
  const sql = db();
  const path = new URL(req.url).pathname;

  if (path === "/api/auth/request") {
    const email = clean(body.email, 200).toLowerCase();
    if (!isEmail(email)) return fail("Enter a valid email address.");
    const [employer] = await sql`SELECT id, company FROM employers WHERE email = ${email} AND api_token IS NOT NULL`;
    if (employer) {
      const token = randomToken();
      await sql`UPDATE employers SET login_token_hash = ${sha256(token)},
                login_token_expires = now() + interval '30 minutes' WHERE id = ${employer.id}`;
      const url = `${siteUrl(req)}/?login=${token}#dashboard`;
      await sendEmail({
        to: email,
        subject: "Your BankStack sign-in link",
        text: `Sign in to your ${employer.company} dashboard: ${url}\n\nThe link works once and expires in 30 minutes.`,
        html: layout({
          heading: "Sign in to your dashboard",
          paragraphs: [`Use this link to sign in as <b>${esc(employer.company)}</b>. It works once and expires in 30 minutes.`,
            "If you didn't ask for it, you can ignore this email."],
          button: { label: "Sign in", url },
        }),
      });
    }
    return json({ ok: true });
  }

  if (path === "/api/auth/verify") {
    const token = clean(body.token, 100);
    if (!/^[a-f0-9]{48}$/.test(token)) return fail("That sign-in link isn't valid.", 400);
    const [employer] = await sql`
      UPDATE employers SET login_token_hash = NULL, login_token_expires = NULL
      WHERE login_token_hash = ${sha256(token)} AND login_token_expires > now()
      RETURNING company, api_token`;
    if (!employer) return fail("That sign-in link has expired or was already used. Request a new one.", 401);
    return json({ token: employer.api_token, company: employer.company });
  }

  return fail("Not found", 404);
};

export const config = { path: ["/api/auth/request", "/api/auth/verify"] };
