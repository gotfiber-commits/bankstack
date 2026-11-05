// Employer authentication: passwords, sessions, one-time codes, authenticator apps (TOTP),
// trusted devices and recovery codes. Built on node:crypto only — no auth vendor needed.
//
// Design:
// - Passwords: scrypt (N=2^15, r=8, p=1), per-user salt, constant-time compare.
// - Sign-in = password + a second factor every time, on any device not marked trusted:
//   a 6-digit code by email (default) or from an authenticator app (RFC 6238 TOTP).
// - Sessions: random bearer tokens, stored only as SHA-256 hashes, 30-day absolute and
//   14-day idle expiry, individually revocable.
// - Codes live in auth_challenges: hashed, 10-minute expiry, 5 attempts, single use.
import crypto from "node:crypto";
import { db, sha256 } from "./shared.mjs";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 30;
export const SESSION_IDLE_DAYS = 14;
export const DEVICE_DAYS = 30;
export const CODE_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const LOCK_AFTER = 8;          // failed passwords before a temporary lock
export const LOCK_MINUTES = 15;

const randomHex = (bytes) => crypto.randomBytes(bytes).toString("hex");

// ---------- passwords ----------
export function hashPassword(password, saltB64 = null) {
  const salt = saltB64 ? Buffer.from(saltB64, "base64") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password).normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// A fixed hash to compare against when the account doesn't exist, so a wrong email
// takes as long as a wrong password and response time doesn't reveal which emails exist.
const DUMMY_HASH = hashPassword(randomHex(16));

export const newSalt = () => crypto.randomBytes(16).toString("base64");
const DUMMY_SALT = newSalt();

// Unconfirmed sign-ups hash their password with the account's one pending_salt, so checking a
// password against ALL of them costs a single scrypt. Every sign-in runs exactly two scrypts
// (account password + this), whether the email is unconfirmed, confirmed or unknown: no timing tell.
export function matchPending(password, pendingSalt, pendingHashes) {
  const mine = hashPassword(password, pendingSalt || DUMMY_SALT);
  let found = -1;
  pendingHashes.forEach((h, i) => { if (pendingSalt && safeHexEqual(h, mine) && found < 0) found = i; });
  return found;
}

export function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || DUMMY_HASH).split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(String(password).normalize("NFKC"), Buffer.from(salt, "base64"), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(expected, actual) && !!stored;
}

const COMMON = new Set(["password", "password1", "password123", "123456789", "1234567890", "qwerty123",
  "letmein123", "welcome123", "bankjobz", "iloveyou", "administrator", "passw0rd", "changeme"]);

export function passwordProblem(password, email = "") {
  const pw = String(password || "");
  if (pw.length < 10) return "Use at least 10 characters for your password.";
  if (pw.length > 200) return "That password is too long.";
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, ""))) return "That password is too common. Pick something less guessable.";
  const local = String(email).toLowerCase().split("@")[0];
  if (local && local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password.";
  if (/^(.)\1+$/.test(pw)) return "That password is too easy to guess.";
  return null;
}

// ---------- sessions ----------
export async function createSession(sql, employerId, req) {
  const token = "bss_" + randomHex(32);
  await sql`
    INSERT INTO employer_sessions (employer_id, token_hash, expires_at, user_agent, ip)
    VALUES (${employerId}, ${sha256(token)}, now() + make_interval(days => ${SESSION_DAYS}),
            ${(req.headers.get("user-agent") || "").slice(0, 300) || null}, ${clientIp(req)})`;
  return token;
}

export function clientIp(req) {
  // Only Netlify's own header: X-Forwarded-For is set by the client and can't be trusted.
  return req.headers.get("x-nf-client-connection-ip") || null;
}

export function bearer(req) {
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

// ---------- trusted devices ("don't ask for a code on this device for 30 days") ----------
export async function trustDevice(sql, employerId, req) {
  const token = "bsd_" + randomHex(32);
  const ua = (req.headers.get("user-agent") || "").slice(0, 300) || null;
  await sql`
    INSERT INTO employer_devices (employer_id, token_hash, expires_at, user_agent)
    VALUES (${employerId}, ${sha256(token)}, now() + make_interval(days => ${DEVICE_DAYS}), ${ua})`;
  return token;
}

export async function isTrustedDevice(sql, employerId, deviceToken) {
  if (!String(deviceToken || "").startsWith("bsd_")) return false;
  const [row] = await sql`
    SELECT id FROM employer_devices
    WHERE employer_id = ${employerId} AND token_hash = ${sha256(deviceToken)} AND expires_at > now()`;
  return !!row;
}

// ---------- one-time codes ----------
// A challenge pairs a random token (held by the browser) with a 6-digit code (sent by email,
// or produced by the authenticator app). Both are needed; codes are stored only as hashes.
// Every attempt and every use is a single atomic UPDATE, so parallel requests can't get extra
// guesses or use one code twice.
const codeHash = (challengeToken, code) => sha256(`${challengeToken}:${String(code).replace(/\D/g, "")}`);
export const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

// employerId may be null: a decoy for an email with no account, which must behave exactly
// like a real challenge at every later step (and simply never succeed).
// Emailed challenges also carry a one-click link with its own 192-bit secret. Nobody can guess it,
// so it needs no attempt limits — the owner can always get in from their inbox, even while
// someone is burning through the code limits for their email.
export const newLinkSecret = () => "bsl_" + randomHex(24);

export async function createChallenge(sql, { employerId, purpose, method, code, email, pending = null, link = null }) {
  const token = "bsc_" + randomHex(24);
  // Decoys (and app-code challenges) still get a random code hash, so code checks run the same path.
  const hash = codeHash(token, code ?? sixDigits());
  await sql`
    INSERT INTO auth_challenges (token_hash, employer_id, purpose, method, code_hash, expires_at, last_sent_at, sends,
                                 throttle_key, pending, link_hash)
    VALUES (${sha256(token)}, ${employerId}, ${purpose}, ${method}, ${hash},
            now() + make_interval(mins => ${CODE_MINUTES}), now(), 1, ${emailTag(email)},
            ${pending ? JSON.stringify(pending) : null}::jsonb, ${link ? sha256(link) : null})`;
  return token;
}

// Reads a live challenge without spending an attempt (used by "send a new code").
export async function loadChallenge(sql, token, purposes) {
  if (!String(token || "").startsWith("bsc_")) return null;
  const [ch] = await sql`
    SELECT * FROM auth_challenges
    WHERE token_hash = ${sha256(token)} AND purpose = ANY(${purposes})
      AND consumed_at IS NULL AND expires_at > now() AND attempts < ${MAX_CODE_ATTEMPTS}`;
  return ch || null;
}

// Spends one attempt and returns the challenge, or null once it's used up, expired or unknown.
export async function claimAttempt(sql, token, purposes) {
  if (!String(token || "").startsWith("bsc_")) return null;
  const [ch] = await sql`
    UPDATE auth_challenges SET attempts = attempts + 1
    WHERE token_hash = ${sha256(token)} AND purpose = ANY(${purposes})
      AND consumed_at IS NULL AND expires_at > now() AND attempts < ${MAX_CODE_ATTEMPTS}
    RETURNING *`;
  return ch || null;
}

export const emailCodeMatches = (challenge, token, code) =>
  !!challenge.code_hash && safeHexEqual(challenge.code_hash, codeHash(token, code));

// Marks a challenge used; true only for the one request that wins.
export async function consumeOnce(sql, challenge) {
  const rows = await sql`UPDATE auth_challenges SET consumed_at = now()
                         WHERE id = ${challenge.id} AND consumed_at IS NULL RETURNING id`;
  return rows.length === 1;
}

// Claims an emailed link: returns the live challenge and consumes it, or null.
export async function claimLink(sql, link) {
  if (!/^bsl_[0-9a-f]{48}$/.test(String(link || ""))) return null;
  const [ch] = await sql`
    UPDATE auth_challenges SET consumed_at = now()
    WHERE link_hash = ${sha256(link)} AND consumed_at IS NULL AND expires_at > now() AND employer_id IS NOT NULL
    RETURNING *`;
  return ch || null;
}

// Reads a live link without using it (so the page can say what it's for before the click).
export async function peekLink(sql, link) {
  if (!/^bsl_[0-9a-f]{48}$/.test(String(link || ""))) return null;
  const [ch] = await sql`SELECT purpose, employer_id FROM auth_challenges
    WHERE link_hash = ${sha256(link)} AND consumed_at IS NULL AND expires_at > now() AND employer_id IS NOT NULL`;
  return ch || null;
}

export async function setChallengeCode(sql, challenge, token, code, link = null) {
  await sql`
    UPDATE auth_challenges SET code_hash = ${codeHash(token, code)}, link_hash = ${link ? sha256(link) : null},
      attempts = 0, last_sent_at = now(),
      sends = sends + 1, expires_at = now() + make_interval(mins => ${CODE_MINUTES})
    WHERE id = ${challenge.id}`;
}

// ---------- throttling: passwords and codes ----------
// Every attempt is counted BEFORE it's checked, in one atomic statement, so a burst of parallel
// requests gets no more checks than the limit. Each kind of secret has its own counters, kept per
// (email, network) and per email:
//   passwords     8 per network, 40 per email
//   emailed codes 8 per network, 10 per email   (the emailed link always works, see newLinkSecret)
//   app codes     8 per network, 10 per email   (only reachable after the right password)
// A check that passes clears its network's counter and takes its own attempt back off the email's,
// so the email-wide counters only ever hold failures. A trusted device skips the email-wide password
// counter, so a flood of guesses from elsewhere can't lock the owner out of their own laptop.
// Keys use a hash of the email, so emails with and without accounts behave identically.
export const emailTag = (email) => sha256(String(email || "").trim().toLowerCase());
const netTag = (req) => sha256(clientIp(req) || "unknown").slice(0, 24);
export const PER_IP_LIMIT = LOCK_AFTER;

export const passwordKeys = (tag, req) => [[`pw:${tag}:${netTag(req)}`, PER_IP_LIMIT], [`pwall:${tag}`, 40]];
export const emailCodeKeys = (tag, req) => [[`code:${tag}:${netTag(req)}`, PER_IP_LIMIT], [`codeall:${tag}`, 10]];
export const appCodeKeys = (tag, req) => [[`app:${tag}:${netTag(req)}`, PER_IP_LIMIT], [`appall:${tag}`, 10]];

// Counts one attempt against each key; true only if every key is still under its limit.
// A key that reaches its limit locks for 15 minutes; an expired lock (or an hour's quiet) starts fresh.
// If `seen` is given, seen.emailLock is set when this attempt is the one that locks an email-wide
// counter — the caller warns the owner only if the attempt then turns out to be wrong.
export async function reserveAttempt(sql, keys, seen = null) {
  let allowed = true;
  for (const [i, [key, limit]] of keys.entries()) {
    const [row] = await sql`
      INSERT INTO auth_throttle (key, failures, updated_at) VALUES (${key}, 1, now())
      ON CONFLICT (key) DO UPDATE SET
        failures = CASE WHEN auth_throttle.locked_until <= now() OR auth_throttle.updated_at < now() - interval '1 hour'
                        THEN 1 ELSE auth_throttle.failures + 1 END,
        locked_until = CASE
          WHEN auth_throttle.locked_until > now() THEN auth_throttle.locked_until
          WHEN (CASE WHEN auth_throttle.locked_until <= now() OR auth_throttle.updated_at < now() - interval '1 hour'
                     THEN 1 ELSE auth_throttle.failures + 1 END) >= ${limit}
            THEN now() + make_interval(mins => ${LOCK_MINUTES})
          ELSE NULL END,
        updated_at = now()
      RETURNING failures`;
    if (row.failures > limit) allowed = false;
    if (i > 0 && row.failures === limit && seen) seen.emailLock = true;
  }
  return allowed;
}

// The check passed: clear this network's counter and give the attempt back on the email-wide one
// (lifting a lock only if this very attempt is what set it).
export async function attemptPassed(sql, keys) {
  const [[ipKey], ...wide] = keys;
  await sql`DELETE FROM auth_throttle WHERE key = ${ipKey}`;
  for (const [key, limit] of wide) {
    await sql`UPDATE auth_throttle SET failures = GREATEST(failures - 1, 0),
                locked_until = CASE WHEN failures - 1 < ${limit} THEN NULL ELSE locked_until END
              WHERE key = ${key}`;
  }
}

// The password itself was replaced, so every earlier guess at it is worthless: clear all its counters.
export async function clearAttempts(sql, keys) {
  for (const [key] of keys) await sql`DELETE FROM auth_throttle WHERE key = ${key}`;
}

export async function minDuration(startedAt, ms = Number(process.env.AUTH_MIN_MS ?? 1200)) {
  const left = ms - (Date.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

function safeHexEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- authenticator apps (RFC 6238 TOTP, SHA-1, 6 digits, 30 s) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 30000);

// Accepts the code for the current 30-second window or one either side (clock drift).
// Returns the matched step, or null. Steps at or before lastStep are refused, so a code
// can't be replayed.
export function verifyTotp(secret, code, lastStep = -1, nowMs = Date.now()) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6 || !secret) return null;
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= Number(lastStep ?? -1)) continue;
    if (safeHexEqual(totpAt(secret, step), c)) return step;
  }
  return null;
}

export const otpauthUrl = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`BankJobz:${email}`)}?secret=${secret}&issuer=BankJobz&algorithm=SHA1&digits=6&period=30`;

// ---------- recovery codes ----------
export function newRecoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(c)) };
}
export const isRecoveryCodeShape = (s) => /^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(String(s || "").trim());
export const normalizeRecoveryCode = (s) => {
  const t = String(s).trim().toLowerCase().replace("-", "");
  return `${t.slice(0, 5)}-${t.slice(5)}`;
};
