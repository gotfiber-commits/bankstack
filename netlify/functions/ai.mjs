// The AI writing assistant.
//   POST /api/ai/posting       → drafts a job posting from rough notes (employers; signed-in or not)
//   POST /api/ai/apply-assist  → tailored cover note + résumé angle tips (signed-in candidates, résumé required)
// Both are rate-limited per user/IP per day, and the whole feature is off until
// ANTHROPIC_API_KEY is set. Drafts are suggestions: a person always reviews before using them.
import {
  db, json, fail, clean, employerFromRequest, candidateFromRequest, CATEGORIES,
} from "../lib/shared.mjs";
import { aiEnabled, askClaude, underAiLimit, parseSections } from "../lib/ai.mjs";

const ip = (req) => req.headers.get("x-nf-client-connection-ip")
  || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";

const money = (n) => (n ? "$" + Number(n).toLocaleString() : null);

export default async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("AI assistant error:", err?.status || "", err?.message, err?.stack?.split("\n")[1] || "");
    return fail(err?.status ? err.message : "The writing assistant hit a problem. Try again in a minute.", err?.status || 500);
  }
};

async function handle(req) {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  if (!aiEnabled()) return fail("The writing assistant isn't set up on this site yet.", 503);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  let b;
  try { b = await req.json(); } catch { return fail("Send JSON."); }
  if (clean(b.company_website)) return fail("Something went wrong. Try again."); // honeypot
  const sql = db();

  if (path === "/api/ai/posting") {
    const title = clean(b.title, 160);
    if (!title) return fail("Add the job title first — the assistant builds around it.");
    const employer = await employerFromRequest(req);
    const who = employer ? `employer:${employer.id}` : `ip:${ip(req)}`;
    if (!(await underAiLimit(who, "posting"))) {
      return fail("You've hit today's limit for the writing assistant. It resets tomorrow.", 429);
    }
    const facts = [
      `Job title: ${title}`,
      b.company ? `Institution: ${clean(b.company, 160)}` : null,
      b.institution_type ? `Institution type: ${clean(b.institution_type, 30)}` : null,
      b.location ? `Location: ${clean(b.location, 160)}` : null,
      b.work_mode ? `Arrangement: ${clean(b.work_mode, 20)}` : null,
      CATEGORIES.includes(b.category) ? `Department: ${b.category}` : null,
      b.salary_min || b.salary_max ? `Pay range: ${[money(b.salary_min), money(b.salary_max)].filter(Boolean).join(" to ")} per year` : null,
      b.notes ? `The employer's rough notes:\n${clean(b.notes, 2000)}` : null,
    ].filter(Boolean).join("\n");

    const text = await askClaude({
      maxTokens: 700,
      system: `You write job postings for BankJobz, a job board for US banks and credit unions. Write in plain, specific language a working banker respects — no buzzwords, no exclamation marks. Use only the facts provided; never invent benefits, requirements, systems or figures that weren't given. Keep wording consistent with equal-opportunity employment: describe the work and the qualifications, never the kind of person (no age, family-status, nationality or similar cues). Output EXACTLY two sections, nothing else:
SUMMARY:
one or two sentences (under 350 characters) selling the role honestly — this shows in the job list.
DESCRIPTION:
the full posting: a short intro paragraph, then "What you'll do" with 4-6 bullet lines starting with "- ", then "What you'll bring" with 3-5 bullet lines, then one closing line inviting the application. Plain text, no markdown headings besides those two literal labels.`,
      user: facts,
    });
    const parts = parseSections(text, ["SUMMARY", "DESCRIPTION"]);
    if (!parts.SUMMARY || !parts.DESCRIPTION) {
      return fail("The assistant gave an answer in the wrong shape. Try again.", 502);
    }
    return json({ summary: parts.SUMMARY.slice(0, 400), description: parts.DESCRIPTION.slice(0, 8000) });
  }

  if (path === "/api/ai/apply-assist") {
    const me = await candidateFromRequest(req);
    if (!me) return fail("Sign in to your profile to use the application assistant.", 401);
    if (!me.resume_text && !me.summary) {
      return fail("Upload a résumé (or fill in your experience summary) first — the assistant only works from what's really in your background.");
    }
    const jobId = String(b.job_id || "");
    if (!/^\d+$/.test(jobId)) return fail("Pick a job first.");
    const [job] = await sql`
      SELECT id, title, company, location, category, summary, description
      FROM jobs WHERE id = ${jobId} AND status = 'open' AND expires_at > now()`;
    if (!job) return fail("This job is no longer open.", 404);
    if (!(await underAiLimit(`candidate:${me.id}`, "apply-assist"))) {
      return fail("You've hit today's limit for the application assistant. It resets tomorrow.", 429);
    }

    const text = await askClaude({
      maxTokens: 900,
      system: `You help a job seeker apply for a specific role at a US bank or credit union. You may use ONLY facts that appear in their résumé text or profile summary below — never invent employers, titles, dates, credentials, licenses or systems they did not mention. If their background is thin for this role, be honest and lean on what's transferable. Output EXACTLY two sections, nothing else:
COVER NOTE:
a note to the hiring team, first person, 100-170 words, specific to this job, professional and warm, no salutation line and no signature block.
TIPS:
3 to 5 lines, each starting with "- ", telling the candidate how to angle their résumé for THIS job: which of their real experiences to lead with, which keywords from the posting they genuinely match, and anything worth addressing. Plain text.`,
      user: `THE JOB:
${job.title} at ${job.company} (${job.location}) — department: ${job.category}
${job.summary || ""}
${(job.description || "").slice(0, 6000)}

THE CANDIDATE:
Name: ${me.name || "(not given)"}
Location: ${me.location || "(not given)"}
Profile summary: ${me.summary || "(none)"}
Résumé text:
${(me.resume_text || "").slice(0, 12000)}`,
    });
    const parts = parseSections(text, ["COVER NOTE", "TIPS"]);
    if (!parts["COVER NOTE"]) return fail("The assistant gave an answer in the wrong shape. Try again.", 502);
    return json({
      cover_note: parts["COVER NOTE"].slice(0, 4000),
      tips: (parts.TIPS || "").split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean).slice(0, 5),
    });
  }

  return fail("Not found", 404);
}

export const config = { path: ["/api/ai/*"] };
