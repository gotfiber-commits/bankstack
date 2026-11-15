// The AI writing assistant.
//   POST /api/ai/posting       → drafts a full job posting from a title (and any notes). With
//                                 { stream: true } the text streams back as it's written (text/plain,
//                                 "SUMMARY:" then "DESCRIPTION:"); otherwise one JSON answer.
//   POST /api/ai/apply-assist  → tailored cover note + résumé angle tips (signed-in candidates, résumé required)
// Both are rate-limited per user/IP per day, and the whole feature is off until
// ANTHROPIC_API_KEY is set. Drafts are suggestions: a person always reviews before using them.
import {
  db, json, fail, clean, employerFromRequest, candidateFromRequest, CATEGORIES,
} from "../lib/shared.mjs";
import { aiEnabled, askClaude, streamClaude, underAiLimit, parseSections } from "../lib/ai.mjs";

const ip = (req) => req.headers.get("x-nf-client-connection-ip")
  || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";

const money = (n) => (n ? "$" + Number(n).toLocaleString() : null);

const DEPARTMENTS = {
  "branch-retail": "Branch & retail", "lending-credit": "Lending & credit", "commercial-banking": "Commercial banking",
  operations: "Operations", "risk-compliance": "Risk & compliance", "finance-accounting": "Finance & accounting",
  "wealth-trust": "Wealth & trust", technology: "Technology & IT", "data-analytics": "Data & analytics",
  "leadership-admin": "Leadership & support",
};

// Marks an error that happens after a streamed draft has started (the page shows it as an error).
const STREAM_ERROR = "[[BANKJOBZ_ERROR]] ";

// The posting writer. It may draw on what the role normally involves at a US bank or credit union
// (that's what makes a title-only draft useful), but never on facts only the employer can know.
const POSTING_SYSTEM = `You write complete, professional job postings for BankJobz, a job board for US banks and credit unions.

The employer may give you only a job title. Build a full posting from your knowledge of how that role works at a US bank or credit union: its real day-to-day duties, the controls and regulations it touches (for example cash and vault controls, BSA/AML, CTRs, OFAC, Reg CC, Reg E, fair lending, privacy, where they genuinely apply to the role), who it typically reports to and works with, and the experience and skills it usually requires. Be specific to the role and its level: a head teller supervises tellers, balances and audits the vault and the line, handles overrides and large transactions and coaches the team, which a teller does not. Avoid filler like "provide excellent service" unless you say how.

Use "customers" for a bank and "members" for a credit union. If the institution type isn't given, use "customers".

Facts the employer gives always win, and their notes come first. The one exception is the department: the form starts on a default, so if the department doesn't fit the job title (an AI engineer listed under "Branch & retail"), follow the title and don't mention the department. Never invent facts only the employer can know: pay, bonuses, benefits, schedule or hours, team size, number of branches, the name of their core system or software, start dates, or anything about the institution's history or size. If pay is given, include it once near the end; if not, say nothing about pay. Never write about benefits and never add a Benefits section: the employer ticks their benefits on the form and the site adds them. No placeholders in brackets.

Keep wording consistent with equal-opportunity employment: describe the work and the qualifications, never the kind of person (no age, family-status, nationality, physical-appearance or similar cues). Physical requirements, where the role really has them, describe the task (standing at a teller line, counting currency), never a body.

Write plainly, as a working banker would. No buzzwords, exclamation marks, emoji or markdown symbols (#, *, **).

Output EXACTLY these two sections and nothing else:
SUMMARY:
one or two sentences, under 350 characters, that say what the job is and why it's worth applying for. This shows in the job list.
DESCRIPTION:
the full posting, 450 to 750 words, laid out with these headings, each on its own line with nothing else on it, and bullet lines that start with "- ":
About the role
(2 to 3 sentences: what the role is for, where it sits and who it reports to)
What you'll do
(8 to 12 bullets, the most important duties first, specific to this role)
What you'll bring
(5 to 8 bullets: required experience with years where the role normally calls for them, education, skills, and knowledge of the rules the role works under)
Nice to have
(3 to 5 bullets)
Working conditions
(2 to 4 bullets, only if the role has real physical, travel or schedule demands that are typical of it; otherwise leave this heading out)
Then one closing paragraph inviting the application, and, when the institution's name is given, a final line: "<Institution> is an equal opportunity employer."`;

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
      CATEGORIES.includes(b.category) ? `Department picked on the form: ${DEPARTMENTS[b.category]}` : null,
      b.salary_min || b.salary_max ? `Pay range: ${[money(b.salary_min), money(b.salary_max)].filter(Boolean).join(" to ")} per year` : null,
      b.notes ? `The employer's rough notes:\n${clean(b.notes, 2000)}` : null,
    ].filter(Boolean).join("\n");

    const pieces = await streamClaude({ maxTokens: 2400, system: POSTING_SYSTEM, user: facts });

    if (b.stream === true) {
      // Stream the draft into the form as it's written. An error after the first byte can't change
      // the status any more, so it's sent as a marked line the page knows to show as an error.
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          try {
            for await (const t of pieces) controller.enqueue(encoder.encode(t));
          } catch (err) {
            controller.enqueue(encoder.encode(`\n${STREAM_ERROR}${err?.status ? err.message : "The writing assistant stopped partway. Try again."}`));
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }

    let text = "";
    for await (const t of pieces) text += t;
    const parts = parseSections(text, ["SUMMARY", "DESCRIPTION"]);
    if (!parts.SUMMARY || !parts.DESCRIPTION) {
      return fail("The assistant gave an answer in the wrong shape. Try again.", 502);
    }
    return json({ summary: parts.SUMMARY.slice(0, 400), description: parts.DESCRIPTION.slice(0, 12000) });
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
