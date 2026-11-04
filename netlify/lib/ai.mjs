// The AI writing assistant: one thin client for Anthropic's Messages API plus the two
// prompts the site uses. Off by default — everything checks aiEnabled() and the front
// end hides the buttons when the key isn't set. ANTHROPIC_API_BASE exists so tests can
// point at a local stand-in; never set it in production.
import { db } from "./shared.mjs";

const BASE = () => process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;

const aiError = (message, status = 502) => Object.assign(new Error(message), { status });

// Netlify stops a function at 10 seconds and answers with its own non-JSON error page,
// which the browser can only report as "server isn't reachable". So the AI call gets its
// own deadline a little under that, and we always answer with a clear JSON error instead.
export async function askClaude({ system, user, maxTokens = 1200 }) {
  const timeoutMs = Number(process.env.ANTHROPIC_TIMEOUT_MS || 8500);
  let res;
  try {
    res = await fetch(`${BASE()}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      console.error("Anthropic timeout after", timeoutMs, "ms");
      throw aiError("The writing assistant took too long this time. Click it again — it's usually quick.", 504);
    }
    console.error("Anthropic network error", err?.message);
    throw aiError("Couldn't reach the writing assistant. Try again in a minute.");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    console.error("Anthropic error", res.status, detail);
    // Name the cause the site owner can fix; keep it generic for everything else.
    if (res.status === 401 || res.status === 403) {
      throw aiError("The writing assistant's API key was rejected. (Site owner: check ANTHROPIC_API_KEY in Netlify.)", 502);
    }
    if (res.status === 400 && /credit|billing|balance/i.test(detail)) {
      throw aiError("The writing assistant is out of credit. (Site owner: add credit in the Anthropic console.)", 502);
    }
    if (res.status === 404 && /model/i.test(detail)) {
      throw aiError("The writing assistant's model name isn't recognized. (Site owner: check ANTHROPIC_MODEL.)", 502);
    }
    if (res.status === 429 || res.status === 529) {
      throw aiError("The writing assistant is busy right now. Try again in a minute.", 503);
    }
    throw aiError("The writing assistant hit a problem. Try again in a minute.");
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Simple, honest rate limiting: N uses per user (or IP) per day, so one person
// can't spend the site's whole AI budget. Returns true when the call may proceed.
// If the usage table is missing (schema.sql not re-run after deploying), it creates it
// rather than failing — the feature should never break over a skipped migration.
export async function underAiLimit(who, kind) {
  const sql = db();
  const limit = Number(process.env.AI_DAILY_LIMIT || 20);
  const count = () => sql`
    SELECT COUNT(*)::int AS n FROM ai_usage
    WHERE who = ${who} AND created_at > now() - interval '24 hours'`;
  let rows;
  try {
    rows = await count();
  } catch (err) {
    if (err?.code !== "42P01" && !/ai_usage.*does not exist/i.test(err?.message || "")) throw err;
    await sql`CREATE TABLE IF NOT EXISTS ai_usage (
      id BIGSERIAL PRIMARY KEY, who TEXT NOT NULL, kind TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE INDEX IF NOT EXISTS ai_usage_who_idx ON ai_usage (who, created_at)`;
    rows = await count();
  }
  if (rows[0].n >= limit) return false;
  await sql`INSERT INTO ai_usage (who, kind) VALUES (${who}, ${kind})`;
  return true;
}

// Pulls "SECTION:" blocks out of a response, so we never depend on the model emitting JSON.
export function parseSections(text, names) {
  const out = {};
  let current = null, buf = [];
  const flush = () => { if (current) out[current] = buf.join("\n").trim(); buf = []; };
  for (const line of String(text).split("\n")) {
    const m = line.match(new RegExp(`^\\s*(${names.join("|")})\\s*:\\s*(.*)$`, "i"));
    if (m) {
      flush();
      current = names.find((n) => n.toLowerCase() === m[1].toLowerCase());
      if (m[2]) buf.push(m[2]);
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
