// The AI writing assistant: one thin client for Anthropic's Messages API plus the two
// prompts the site uses. Off by default — everything checks aiEnabled() and the front
// end hides the buttons when the key isn't set. ANTHROPIC_API_BASE exists so tests can
// point at a local stand-in; never set it in production.
import { db } from "./shared.mjs";

const BASE = () => process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;

export async function askClaude({ system, user, maxTokens = 1200 }) {
  const res = await fetch(`${BASE()}/v1/messages`, {
    method: "POST",
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
  if (!res.ok) {
    console.error("Anthropic error", res.status, (await res.text().catch(() => "")).slice(0, 300));
    throw Object.assign(new Error("The writing assistant is busy right now. Try again in a minute."), { status: 502 });
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Simple, honest rate limiting: N uses per user (or IP) per day, so one person
// can't spend the site's whole AI budget. Returns true when the call may proceed.
export async function underAiLimit(who, kind) {
  const sql = db();
  const limit = Number(process.env.AI_DAILY_LIMIT || 20);
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM ai_usage
    WHERE who = ${who} AND created_at > now() - interval '24 hours'`;
  if (n >= limit) return false;
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
