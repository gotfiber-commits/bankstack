// Rate limits for anything that sends email or writes on behalf of an anonymous visitor.
//
// Each rule is [key, max, minutes]: at most `max` requests per fixed window of `minutes`.
// Keys are hashes (of the recipient's email, the sender's network, or an account id), so the
// table never holds an address or an IP. One atomic upsert per rule means a burst of parallel
// requests can't slip past the count. Rows are pruned daily (pruneAuth in tasks.mjs).
//
// Limits are the same whether or not an email has an account, so a 429 never reveals that.
import { sha256 } from "./shared.mjs";
import { clientIp } from "./auth.mjs";

export const netKey = (req) => sha256(clientIp(req) || "unknown").slice(0, 24);
export const mailKey = (email) => sha256(String(email || "").trim().toLowerCase()).slice(0, 24);

// Counts this request against every rule; true only if every rule is still within its limit.
export async function withinLimits(sql, rules) {
  let ok = true;
  for (const [key, max, minutes] of rules) {
    const [row] = await sql`
      INSERT INTO rate_limits (key, window_start, hits) VALUES (${key}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN rate_limits.window_start <= now() - make_interval(mins => ${minutes})
                    THEN 1 ELSE rate_limits.hits + 1 END,
        window_start = CASE WHEN rate_limits.window_start <= now() - make_interval(mins => ${minutes})
                            THEN now() ELSE rate_limits.window_start END
      RETURNING hits`;
    if (row.hits > max) ok = false;
  }
  return ok;
}

// Three kinds of rule:
//   recipient + network  tight: one source can't flood one inbox
//   recipient            looser: caps what even many networks together can send to one inbox
//   network              generous: one source rotating through addresses (a campus or a bank's
//                        office can put many real people behind one address)
// Someone trying to keep an owner from getting a sign-in or reset email would have to keep
// sending those emails to the owner, and the newest one always works, so the owner still gets in.
const mailRules = (prefix, req, email, { pair, mail, net }) => [
  [`${prefix}:mn:${mailKey(email)}:${netKey(req)}`, pair, 60],
  [`${prefix}:m:${mailKey(email)}`, mail, 60],
  [`${prefix}:n:${netKey(req)}`, net, 60],
];

export const LIMITS = {
  employerMail: (req, email) => mailRules("em", req, email, { pair: 5, mail: 20, net: 60 }),
  candidateMail: (req, email) => mailRules("cm", req, email, { pair: 5, mail: 20, net: 60 }),
  alertMail: (req, email) => mailRules("al", req, email, { pair: 3, mail: 10, net: 60 }),
  apply: (req, email) => mailRules("ap", req, email, { pair: 25, mail: 40, net: 120 }),
  quickApply: (candidateId) => [[`qa:c:${candidateId}`, 40, 60]],
  invite: (employerId) => [[`iv:e:${employerId}`, 100, 1440]],
};

export const TOO_MANY = "Too many requests in a short time. Please wait a few minutes and try again.";
