// Employer sign-up and sign-in: password + second factor (email code or authenticator app).
//
// POST /api/auth/signup  { contact_name, contact_title?, company, institution_type, email, password }
//                        → { challenge, method: "email" }  (code + link emailed to confirm the address)
// POST /api/auth/login   { email, password, device_token? }
//                        → { token } on a trusted device, else { challenge, method: "email"|"totp" }
// POST /api/auth/verify  { challenge, code, remember_device? }
//                        → { token, device_token?, company }   (finishes sign-up OR sign-in)
// POST /api/auth/link    { link, password? }   the one-click link from an email: finishes sign-up or
//                        sign-in → { token, company }, or with a password sets it → { ok, reset: true }
// POST /api/auth/resend  { challenge }          → emails a fresh code and link (email challenges only)
// POST /api/auth/forgot  { email }              → { challenge }   (reset code emailed if the account exists)
// POST /api/auth/reset   { challenge, code, password } → { ok }  then sign in with the new password
// POST /api/auth/logout  (Bearer session)       → ends this session
//
// Enumeration-safe: when an email has no account (or, at sign-up, already has one), a decoy
// challenge is stored and every later step runs the same code path, with the same messages,
// throttling and response times.
import {
  db, json, fail, isEmail, clean, sha256, siteUrl, INSTITUTION_TYPES,
} from "../lib/shared.mjs";
import {
  hashPassword, verifyPassword, passwordProblem, createSession, trustDevice, isTrustedDevice,
  createChallenge, loadChallenge, claimAttempt, emailCodeMatches, consumeOnce, setChallengeCode, sixDigits,
  verifyTotp, isRecoveryCodeShape, normalizeRecoveryCode, bearer, emailTag, passwordKeys, emailCodeKeys,
  appCodeKeys, reserveAttempt, attemptPassed, clearAttempts, minDuration, LOCK_MINUTES, newSalt, matchPending,
  newLinkSecret, claimLink, peekLink,
} from "../lib/auth.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

const CODE_FAIL = "That code isn't right, or it has expired. Check it, or start again for a new one.";
const LOCKED = `Too many attempts. For your security, sign-in for this email is paused for ${LOCK_MINUTES} minutes.`;
const CODE_LOCKED = `Too many code attempts for this email. Use the button in the email we sent you, or try again in ${LOCK_MINUTES} minutes.`;
const BAD_LOGIN = "That email and password don't match. Never set a password? Use “Forgot or set password.”";
const LINK_FAIL = "That link has expired or was already used. Sign in again to get a new one.";

const PURPOSE_COPY = {
  verify: { subject: "Your BankJobz confirmation code", heading: "Confirm your email", line: "Enter this code to finish creating your employer account.", button: "Confirm my email" },
  login: { subject: "Your BankJobz sign-in code", heading: "Your sign-in code", line: "Enter this code to finish signing in.", button: "Finish signing in" },
  reset: { subject: "Reset your BankJobz password", heading: "Reset your password", line: "Enter this code to set a new password.", button: "Set a new password" },
};

// Links in sign-in emails always point at the configured site, never at whatever host a request named.
// The secret rides in the #fragment, which browsers never send to the server (so it stays out of logs).

async function emailCode(req, to, purpose, code, link) {
  const c = PURPOSE_COPY[purpose];
  const url = `${siteUrl()}/#auth=${link}`;
  await sendEmail({
    to,
    subject: `${c.subject}: ${code}`,
    text: `${c.line}\n\n${code}\n\nOr open this link on the device you want to use:\n${url}\n\nBoth expire in 10 minutes. If you didn't ask for this, ignore this email — your account stays protected by your password.`,
    html: layout({
      heading: c.heading,
      paragraphs: [
        c.line,
        `<span style="font:700 30px/1.2 'IBM Plex Mono',monospace;letter-spacing:6px">${esc(code)}</span>`,
        "Or use the button on the device you want to use. Both expire in 10 minutes. If you didn't ask for this, ignore this email — your account stays protected by your password.",
      ],
      button: { label: c.button, url },
    }),
  });
}

async function securityNotice(to, what) {
  await sendEmail({
    to,
    subject: `BankJobz security notice: ${what}`,
    text: `${what} on your BankJobz employer account just now. If this was you, there's nothing to do. If it wasn't, reset your password right away from the sign-in page.`,
    html: layout({
      heading: "Security notice",
      paragraphs: [`<b>${esc(what)}</b> on your BankJobz employer account just now.`,
        "If this was you, there's nothing to do. If it wasn't, reset your password right away from the sign-in page."],
    }),
  });
}

// Sent once when a wrong attempt trips the email-wide limit — usually someone else guessing.
async function lockNotice(employer, seen) {
  if (!seen?.emailLock || !employer?.verified_at) return;
  await sendEmail({
    to: employer.email,
    subject: "BankJobz security notice: many failed sign-in attempts",
    text: `There have been many failed attempts to sign in to your BankJobz employer account, so password sign-in is paused for ${LOCK_MINUTES} minutes on new devices. Your trusted devices still work. If this wasn't you, nobody got in — but consider changing your password, and turning on an authenticator app under Dashboard → Account & security. To get in now, use "Forgot or set password" and the button in that email.`,
    html: layout({
      heading: "Many failed sign-in attempts",
      paragraphs: [`There have been many failed attempts to sign in to your BankJobz employer account, so password sign-in is paused for ${LOCK_MINUTES} minutes on new devices. Your trusted devices still work.`,
        "If this wasn't you, nobody got in — but consider changing your password and turning on an authenticator app under <b>Dashboard → Account &amp; security</b>.",
        "To get in right now, use <i>Forgot or set password</i> on the sign-in page and the button in that email."],
    }),
  });
}

// Starts an emailed-code challenge for a real account, or an identical decoy when employer is null.
async function startEmailChallenge(sql, req, { employer, email, purpose, pending = null }) {
  const code = sixDigits();
  const link = newLinkSecret();
  const token = await createChallenge(sql, { employerId: employer?.id ?? null, purpose, method: "email", code, email, pending, link });
  if (employer) await emailCode(req, employer.email, purpose, code, link);
  return token;
}

async function signedIn(sql, req, employer, rememberDevice) {
  const token = await createSession(sql, employer.id, req);
  const device_token = rememberDevice ? await trustDevice(sql, employer.id, req) : undefined;
  return json({ token, device_token, company: employer.company });
}

// The second factor passed (code or link): finish a sign-up or a sign-in.
async function finishChallenge(sql, req, ch, employer, rememberDevice) {
  let account = employer;
  if (ch.purpose === "verify") {
    // A confirmed account is never "confirmed" again: a leftover sign-up (perhaps someone else's)
    // can't replace its details or password.
    if (employer.verified_at) return fail(CODE_FAIL, 401);
    const p = ch.pending; // a sign-up's details apply now that its code proved the inbox
    [account] = p
      ? await sql`UPDATE employers SET company = ${p.company}, institution_type = ${p.institution_type},
                    contact_name = ${p.contact_name}, contact_title = ${p.contact_title},
                    password_hash = ${p.password_hash}, password_changed_at = now(),
                    verified_at = COALESCE(verified_at, now())
                  WHERE id = ${employer.id} RETURNING *`
      : await sql`UPDATE employers SET verified_at = COALESCE(verified_at, now()) WHERE id = ${employer.id} RETURNING *`;
    // Every other outstanding code and link for this email stops working.
    await sql`UPDATE auth_challenges SET consumed_at = now() WHERE employer_id = ${employer.id} AND consumed_at IS NULL`;
  }
  return signedIn(sql, req, account, rememberDevice);
}

// New password (by emailed code or link): every session and trusted device is signed out, and
// every earlier guess at the old password stops counting.
async function applyReset(sql, req, employer, password) {
  await sql`UPDATE employers SET password_hash = ${hashPassword(password)}, password_changed_at = now(),
              verified_at = COALESCE(verified_at, now())
            WHERE id = ${employer.id}`;
  await sql`UPDATE employer_sessions SET revoked_at = now() WHERE employer_id = ${employer.id} AND revoked_at IS NULL`;
  await sql`DELETE FROM employer_devices WHERE employer_id = ${employer.id}`;
  await sql`UPDATE auth_challenges SET consumed_at = now() WHERE employer_id = ${employer.id} AND consumed_at IS NULL`;
  await clearAttempts(sql, passwordKeys(emailTag(employer.email), req));
  await securityNotice(employer.email, "Your password was changed");
}

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const sql = db();
  const startedAt = Date.now();

  if (path === "/api/auth/logout") {
    const token = bearer(req);
    if (token.startsWith("bss_")) {
      await sql`UPDATE employer_sessions SET revoked_at = now() WHERE token_hash = ${sha256(token)} AND revoked_at IS NULL`;
    }
    return json({ ok: true });
  }

  let b;
  try { b = await req.json(); } catch { return fail("Send JSON."); }

  // ---------- create an account ----------
  if (path === "/api/auth/signup") {
    if (clean(b.company_website)) return fail("Something went wrong. Try again."); // honeypot
    const contactName = clean(b.contact_name, 120);
    const company = clean(b.company, 160);
    const email = clean(b.email, 200).toLowerCase();
    const type = INSTITUTION_TYPES.includes(b.institution_type) ? b.institution_type : "bank";
    if (!contactName) return fail("Enter your name.");
    if (!company) return fail("Enter your institution's name.");
    if (!isEmail(email)) return fail("Enter a valid work email.");
    const problem = passwordProblem(b.password, email);
    if (problem) return fail(problem);

    // The account's details and password take effect only when this sign-up's code is entered,
    // so a second sign-up for the same unconfirmed email can't change anything.
    const details = {
      company, institution_type: type, contact_name: contactName, contact_title: clean(b.contact_title, 120) || null,
    };
    const [existing] = await sql`SELECT * FROM employers WHERE email = ${email}`;
    let challenge;
    if (existing?.verified_at) {
      hashPassword(b.password); // same work as a real sign-up
      // Already registered: tell the real owner, and answer exactly like a new sign-up.
      await sendEmail({
        to: email,
        subject: "Someone tried to create a BankJobz account with your email",
        text: "Your email already has a BankJobz employer account, so nothing was changed. Sign in with your password, or use 'Forgot or set password' on the sign-in page if you need to reset it.",
        html: layout({ heading: "You already have an account",
          paragraphs: ["Someone tried to create a BankJobz employer account with this email. It already has one, so nothing was changed.",
            "Sign in with your password, or use <i>Forgot or set password</i> on the sign-in page."] }),
      });
      challenge = await startEmailChallenge(sql, req, { employer: null, email, purpose: "verify" });
    } else {
      const [row] = existing
        ? [existing]
        : await sql`INSERT INTO employers (company, email, institution_type, contact_name, contact_title)
                    VALUES (${company}, ${email}, ${type}, ${contactName}, ${details.contact_title})
                    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING *`;
      const [employer] = await sql`UPDATE employers SET pending_salt = COALESCE(pending_salt, ${newSalt()})
                                   WHERE id = ${row.id} RETURNING *`;
      const pending = { ...details, password_hash: hashPassword(b.password, employer.pending_salt) };
      challenge = await startEmailChallenge(sql, req, { employer, email, purpose: "verify", pending });
    }
    await minDuration(startedAt);
    return json({ challenge, method: "email" });
  }

  // ---------- sign in: step 1, password ----------
  if (path === "/api/auth/login") {
    const email = clean(b.email, 200).toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (!isEmail(email) || !password) return fail("Enter your email and password.");
    const [employer] = await sql`SELECT * FROM employers WHERE email = ${email}`;
    // On the owner's trusted device, only that network's counter applies: a flood of guesses
    // from elsewhere can't lock them out of their own laptop.
    // A trusted device gets its own counter in place of the email-wide one; a device that racks up
    // wrong passwords stops being trusted, so a stolen device token isn't a free pass to guess.
    const trusted = employer ? await isTrustedDevice(sql, employer.id, b.device_token) : false;
    const allKeys = passwordKeys(emailTag(email), req);
    const keys = trusted ? [allKeys[0], [`pwdev:${emailTag(email)}:${sha256(b.device_token).slice(0, 24)}`, 10]] : allKeys;
    const seen = {};
    // Counted before anything is checked, so parallel guesses can't slip past the limit.
    if (!(await reserveAttempt(sql, keys, seen))) {
      if (trusted) await sql`DELETE FROM employer_devices WHERE employer_id = ${employer.id} AND token_hash = ${sha256(b.device_token)}`;
      await minDuration(startedAt);
      return fail(LOCKED, 429);
    }
    // Exactly two password hashes run for every email (account password + unconfirmed sign-ups),
    // so response time says nothing about whether, or how, an email is registered.
    let ok = verifyPassword(password, employer?.password_hash);
    const pendings = employer && !employer.verified_at
      ? await sql`SELECT pending FROM auth_challenges
                  WHERE employer_id = ${employer.id} AND purpose = 'verify' AND pending IS NOT NULL
                    AND created_at > now() - interval '7 days'
                  ORDER BY created_at DESC LIMIT 25`
      : [];
    const hit = matchPending(password, employer?.pending_salt, pendings.map((r) => r.pending.password_hash || ""));
    let resume = null;
    if (!ok && hit >= 0) { resume = pendings[hit].pending; ok = true; }
    if (!employer || !ok) {
      await lockNotice(employer, seen);
      await minDuration(startedAt);
      return fail(BAD_LOGIN, 401);
    }
    await attemptPassed(sql, keys);
    if (!employer.verified_at) {
      const challenge = await startEmailChallenge(sql, req, { employer, email, purpose: "verify", pending: resume });
      return json({ challenge, method: "email", purpose: "verify" });
    }
    if (trusted) return signedIn(sql, req, employer, false);
    if (employer.mfa_method === "totp" && employer.totp_secret) {
      const challenge = await createChallenge(sql, { employerId: employer.id, purpose: "login", method: "totp", email });
      return json({ challenge, method: "totp" });
    }
    return json({ challenge: await startEmailChallenge(sql, req, { employer, email, purpose: "login" }), method: "email" });
  }

  // ---------- step 2: the code (finishes sign-up or sign-in) ----------
  if (path === "/api/auth/verify") {
    const code = clean(String(b.code ?? ""), 20);
    const ch = await claimAttempt(sql, b.challenge, ["login", "verify"]); // spends one of 5 tries, atomically
    if (!ch) return fail(CODE_FAIL, 401);
    const [employer] = ch.employer_id ? await sql`SELECT * FROM employers WHERE id = ${ch.employer_id}` : [];
    const app = ch.method === "totp";
    const keys = (app ? appCodeKeys : emailCodeKeys)(ch.throttle_key, req);
    const seen = {};
    if (!(await reserveAttempt(sql, keys, seen))) return fail(app ? LOCKED : CODE_LOCKED, 429);

    let passed = false;
    if (!app) {
      passed = !!employer && emailCodeMatches(ch, b.challenge, code);
    } else if (employer) {
      const step = verifyTotp(employer.totp_secret, code, -1);
      if (step !== null) {
        // Record the step only if it's newer than the last one used: a code can't be replayed,
        // even by two requests at the same moment.
        const won = await sql`UPDATE employers SET totp_last_step = ${step}
                              WHERE id = ${employer.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`;
        passed = won.length === 1;
      } else if (isRecoveryCodeShape(code)) {
        const hash = sha256(normalizeRecoveryCode(code));
        const used = await sql`
          UPDATE employers SET recovery_codes = array_remove(recovery_codes, ${hash})
          WHERE id = ${employer.id} AND ${hash} = ANY(recovery_codes) RETURNING id`;
        if (used.length) {
          passed = true;
          await securityNotice(employer.email, "A recovery code was used to sign in");
        }
      }
    }
    if (!passed || !(await consumeOnce(sql, ch))) { await lockNotice(employer, seen); return fail(CODE_FAIL, 401); }
    await attemptPassed(sql, keys);
    return finishChallenge(sql, req, ch, employer, b.remember_device === true);
  }

  // ---------- the one-click link from an email ----------
  // 192 random bits that only ever went to the inbox: unguessable, so no attempt limits apply.
  // The page first asks what the link is for (it shows the account's email, so nobody can pass off
  // their own sign-in link as something else), then needs a click, so mail scanners can't use it.
  // Confirming a sign-up also needs the password that sign-up chose, so the inbox owner can't be
  // tricked into confirming an impostor's sign-up; a reset needs the new password.
  if (path === "/api/auth/link/peek") {
    const peek = await peekLink(sql, b.link);
    if (!peek) return fail(LINK_FAIL, 401);
    const [employer] = await sql`SELECT email, company FROM employers WHERE id = ${peek.employer_id}`;
    return json({ purpose: peek.purpose, email: employer.email, company: employer.company });
  }

  if (path === "/api/auth/link") {
    const peek = await peekLink(sql, b.link);
    if (!peek) return fail(LINK_FAIL, 401);
    const [employer] = await sql`SELECT * FROM employers WHERE id = ${peek.employer_id}`;
    if (peek.purpose === "reset") {
      const problem = passwordProblem(b.password); // checked before the link is used up
      if (problem) return fail(problem);
    }
    if (peek.purpose === "verify") {
      if (employer.verified_at) return fail("This email is already confirmed. Sign in with your password.", 409);
      // The password must match the one chosen in the sign-up this link belongs to.
      const [row] = await sql`SELECT pending FROM auth_challenges WHERE link_hash = ${sha256(b.link)}`;
      const ok = row?.pending
        ? matchPending(String(b.password || ""), employer.pending_salt, [row.pending.password_hash || ""]) === 0
        : verifyPassword(String(b.password || ""), employer.password_hash);
      if (!ok) return fail("That isn't the password you chose when you signed up. If you didn't sign up just now, ignore the email — nothing has changed.", 401);
    }
    const ch = await claimLink(sql, b.link);
    if (!ch) return fail(LINK_FAIL, 401);
    if (ch.purpose === "reset") {
      await applyReset(sql, req, employer, b.password);
      return json({ ok: true, reset: true });
    }
    return finishChallenge(sql, req, ch, employer, false);
  }

  // ---------- new code by email ----------
  if (path === "/api/auth/resend") {
    const ch = await loadChallenge(sql, b.challenge, ["login", "verify", "reset"]);
    if (!ch || ch.method !== "email") return json({ ok: true });
    if (ch.sends >= 5) return fail("We've sent several codes already. Start again in a few minutes.", 429);
    if (ch.last_sent_at && Date.now() - new Date(ch.last_sent_at).getTime() < 30000) {
      return fail("A code is on its way. You can ask for another in 30 seconds.", 429);
    }
    const code = sixDigits();
    const link = newLinkSecret();
    await setChallengeCode(sql, ch, b.challenge, code, link); // decoys get a new (useless) code too
    if (ch.employer_id) {
      const [employer] = await sql`SELECT email FROM employers WHERE id = ${ch.employer_id}`;
      await emailCode(req, employer.email, ch.purpose, code, link);
    }
    await minDuration(startedAt);
    return json({ ok: true });
  }

  // ---------- forgot / set password ----------
  if (path === "/api/auth/forgot") {
    const email = clean(b.email, 200).toLowerCase();
    if (!isEmail(email)) return fail("Enter a valid email address.");
    const [employer] = await sql`SELECT * FROM employers WHERE email = ${email}`;
    const challenge = await startEmailChallenge(sql, req, { employer: employer || null, email, purpose: "reset" });
    await minDuration(startedAt);
    return json({ challenge });
  }

  if (path === "/api/auth/reset") {
    const problem = passwordProblem(b.password); // checked before the code, the same for everyone
    if (problem) return fail(problem);
    const ch = await claimAttempt(sql, b.challenge, ["reset"]);
    if (!ch) return fail(CODE_FAIL, 401);
    const [employer] = ch.employer_id ? await sql`SELECT * FROM employers WHERE id = ${ch.employer_id}` : [];
    // Codes have their own counters: a flood of wrong passwords can't stop the owner resetting.
    const keys = emailCodeKeys(ch.throttle_key, req);
    const seen = {};
    if (!(await reserveAttempt(sql, keys, seen))) return fail(CODE_LOCKED, 429);
    const code = clean(String(b.code ?? ""), 20);
    if (!employer || !emailCodeMatches(ch, b.challenge, code) || !(await consumeOnce(sql, ch))) {
      await lockNotice(employer, seen);
      return fail(CODE_FAIL, 401);
    }
    await attemptPassed(sql, keys);
    await applyReset(sql, req, employer, b.password);
    return json({ ok: true });
  }

  return fail("Not found", 404);
};

export const config = { path: "/api/auth/*" };
