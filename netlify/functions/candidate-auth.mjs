// Candidate sign-in by email: passwordless, same pattern as employer sign-in.
// POST /api/candidate-auth/request { email, name? } → creates the profile if new and emails
//                                     a single-use link, valid 30 minutes. Always answers ok.
// POST /api/candidate-auth/verify  { token } → { token: ck_…, name, has_resume }
import { db, json, fail, isEmail, clean, siteUrl, randomToken, sha256 } from "../lib/shared.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return fail("Send JSON."); }
  const sql = db();
  const path = new URL(req.url).pathname;

  if (path === "/api/candidate-auth/request") {
    if (clean(body.company_website)) return json({ ok: true }); // honeypot
    const email = clean(body.email, 200).toLowerCase();
    if (!isEmail(email)) return fail("Enter a valid email address.");
    const name = clean(body.name, 120);
    const [cand] = await sql`
      INSERT INTO candidates (email, name) VALUES (${email}, ${name})
      ON CONFLICT (email) DO UPDATE
        SET name = CASE WHEN candidates.name = '' THEN EXCLUDED.name ELSE candidates.name END
      RETURNING id, name`;
    const token = randomToken();
    await sql`UPDATE candidates SET login_token_hash = ${sha256(token)},
              login_token_expires = now() + interval '30 minutes' WHERE id = ${cand.id}`;
    const url = `${siteUrl(req)}/?clogin=${token}#profile`;
    await sendEmail({
      to: email,
      subject: "Your BankJobz sign-in link",
      text: `Sign in to your BankJobz profile: ${url}\n\nThe link works once and expires in 30 minutes.`,
      html: layout({
        heading: "Sign in to your profile",
        paragraphs: [
          `Use this link to open your BankJobz profile${cand.name ? `, <b>${esc(cand.name)}</b>` : ""}. It works once and expires in 30 minutes.`,
          "If you didn't ask for it, you can ignore this email.",
        ],
        button: { label: "Open my profile", url },
      }),
    });
    return json({ ok: true });
  }

  if (path === "/api/candidate-auth/verify") {
    const token = clean(body.token, 100);
    if (!/^[a-f0-9]{48}$/.test(token)) return fail("That sign-in link isn't valid.", 400);
    const [cand] = await sql`
      UPDATE candidates SET login_token_hash = NULL, login_token_expires = NULL,
             api_token = COALESCE(api_token, ${"ck_" + randomToken()})
      WHERE login_token_hash = ${sha256(token)} AND login_token_expires > now()
      RETURNING api_token, name, (resume_key IS NOT NULL) AS has_resume`;
    if (!cand) return fail("That sign-in link has expired or was already used. Request a new one.", 401);
    return json({ token: cand.api_token, name: cand.name, has_resume: cand.has_resume });
  }

  return fail("Not found", 404);
};

export const config = { path: ["/api/candidate-auth/request", "/api/candidate-auth/verify"] };
