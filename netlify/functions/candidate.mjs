// Candidate area. Every request needs "Authorization: Bearer <ck_ token>".
// GET  /api/candidate           → profile + jobs they've applied to
// PUT  /api/candidate           → update profile fields
// POST /api/candidate/resume    → upload résumé (multipart field "resume"); extracts text for matching
// GET  /api/candidate/resume    → download their own résumé
// GET  /api/candidate/matches   → every open job ranked against the résumé + profile
// POST /api/candidate/apply     → one-click apply { job_id, cover_note? }
import crypto from "node:crypto";
import { db, json, fail, clean, isUrl, siteUrl, candidateFromRequest, CATEGORIES } from "../lib/shared.mjs";
import { checkResume, saveFile, loadFile } from "../lib/files.mjs";
import { extractResumeText } from "../lib/extract.mjs";
import { rankJobs } from "../lib/match.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

const MODES = ["any", "onsite", "hybrid", "remote"];

export default async (req) => {
  const me = await candidateFromRequest(req);
  if (!me) return fail("Your sign-in has expired. Request a new link from the profile page.", 401);
  const sql = db();
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (req.method === "GET" && path === "/api/candidate") {
    const applications = await sql`
      SELECT a.job_id, j.title AS job_title, j.company, j.status, a.created_at
      FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE a.candidate_id = ${me.id} OR a.email = ${me.email}
      ORDER BY a.created_at DESC LIMIT 100`;
    return json({
      candidate: {
        name: me.name, email: me.email, phone: me.phone, linkedin_url: me.linkedin_url,
        location: me.location, work_mode_pref: me.work_mode_pref, categories: me.categories,
        summary: me.summary, resume_name: me.resume_name, resume_size: me.resume_size,
        text_ok: !!me.resume_text,
      },
      applications,
    });
  }

  if (req.method === "PUT" && path === "/api/candidate") {
    let b;
    try { b = await req.json(); } catch { return fail("Send JSON."); }
    const name = clean(b.name, 120);
    if (!name) return fail("Enter your name.");
    const linkedin = clean(b.linkedin_url, 300);
    if (linkedin && !isUrl(linkedin)) return fail("The LinkedIn link should start with https://");
    const categories = Array.isArray(b.categories) ? b.categories.filter((c) => CATEGORIES.includes(c)) : [];
    await sql`UPDATE candidates SET
        name = ${name}, phone = ${clean(b.phone, 40) || null}, linkedin_url = ${linkedin || null},
        location = ${clean(b.location, 120) || null},
        work_mode_pref = ${MODES.includes(b.work_mode_pref) ? b.work_mode_pref : "any"},
        summary = ${clean(b.summary, 4000) || null}, categories = ${categories}
      WHERE id = ${me.id}`;
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/api/candidate/resume") {
    let form;
    try { form = await req.formData(); } catch { return fail("Send the file as a form upload."); }
    const file = form.get("resume");
    if (!file || typeof file === "string" || !file.size) return fail("Choose a résumé file.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const check = checkResume(file.name, bytes);
    if (check.error) return fail(check.error);
    const safeName = clean(file.name, 120).replace(/[^\w.\- ]+/g, "_") || `resume.${check.ext}`;
    const key = `profiles/${me.id}/${crypto.randomUUID()}.${check.ext}`;
    await saveFile(key, bytes, { name: safeName, type: check.type, candidate_id: String(me.id) });
    const text = await extractResumeText(bytes, check.ext);
    await sql`UPDATE candidates SET resume_key = ${key}, resume_name = ${safeName}, resume_type = ${check.type},
              resume_size = ${bytes.length}, resume_text = ${text} WHERE id = ${me.id}`;
    return json({ ok: true, text_extracted: !!text });
  }

  if (req.method === "GET" && path === "/api/candidate/resume") {
    if (!me.resume_key) return fail("No résumé on file.", 404);
    const file = await loadFile(me.resume_key);
    if (!file) return fail("The résumé file is missing.", 404);
    return new Response(file.data, {
      headers: {
        "content-type": me.resume_type || "application/octet-stream",
        "content-disposition": `attachment; filename="${(me.resume_name || "resume").replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
      },
    });
  }

  if (req.method === "GET" && path === "/api/candidate/matches") {
    const jobs = await sql`
      SELECT id, title, company, location, work_mode, category, salary_min, salary_max, summary, description,
             (employer_id IS NOT NULL) AS direct
      FROM jobs WHERE status = 'open' AND expires_at > now()`;
    const applied = new Set(
      (await sql`SELECT job_id FROM applications WHERE candidate_id = ${me.id} OR email = ${me.email}`)
        .map((r) => String(r.job_id))
    );
    const { basis, matches } = rankJobs(me, jobs);
    return json({
      basis,
      matches: matches.map(({ job, score, tier, reasons }) => ({
        id: job.id, title: job.title, company: job.company, location: job.location,
        work_mode: job.work_mode, category: job.category, salary_min: job.salary_min,
        salary_max: job.salary_max, direct: job.direct, score, tier, reasons,
        applied: applied.has(String(job.id)),
      })),
    });
  }

  if (req.method === "POST" && path === "/api/candidate/apply") {
    let b;
    try { b = await req.json(); } catch { return fail("Send JSON."); }
    const jobId = String(b.job_id || "");
    if (!/^\d+$/.test(jobId)) return fail("Pick a job to apply for.");
    const [job] = await sql`
      SELECT j.id, j.title, j.company, j.employer_id, j.apply_url, e.email AS employer_email
      FROM jobs j LEFT JOIN employers e ON e.id = j.employer_id
      WHERE j.id = ${jobId} AND j.status = 'open' AND j.expires_at > now()`;
    if (!job) return fail("This job is no longer open.", 404);

    const [existing] = await sql`SELECT id FROM applications WHERE job_id = ${job.id} AND email = ${me.email}`;
    if (existing) {
      return job.employer_id
        ? json({ ok: true, external: false, duplicate: true })
        : json({ ok: true, external: true, apply_url: job.apply_url, duplicate: true });
    }
    if (job.employer_id && !me.resume_key) return fail("Add a résumé to your profile first.");

    // Copy the résumé, so replacing it on the profile later doesn't change past applications.
    let resume = null;
    if (job.employer_id) {
      const file = await loadFile(me.resume_key);
      if (!file) return fail("Your résumé file is missing. Upload it again on your profile.", 409);
      resume = {
        key: `${job.id}/${crypto.randomUUID()}.${me.resume_key.split(".").pop()}`,
        name: me.resume_name, type: me.resume_type, size: me.resume_size,
      };
      await saveFile(resume.key, file.data, { name: me.resume_name, type: me.resume_type, job_id: String(job.id) });
    }

    const rows = await sql`
      INSERT INTO applications (job_id, candidate_id, name, email, phone, linkedin_url,
                                resume_key, resume_name, resume_type, resume_size, cover_note)
      VALUES (${job.id}, ${me.id}, ${me.name || me.email}, ${me.email}, ${me.phone}, ${me.linkedin_url},
              ${resume?.key ?? null}, ${resume?.name ?? null}, ${resume?.type ?? null}, ${resume?.size ?? null},
              ${clean(b.cover_note, 4000) || null})
      ON CONFLICT (job_id, email) DO NOTHING RETURNING id`;

    if (!job.employer_id) return json({ ok: true, external: true, apply_url: job.apply_url });
    if (!rows.length) return json({ ok: true, external: false, duplicate: true });

    const base = siteUrl(req);
    const who = me.name || me.email;
    await Promise.all([
      sendEmail({
        to: job.employer_email,
        replyTo: me.email,
        subject: `New applicant for ${job.title}: ${who}`,
        text: `${who} (${me.email}) applied for ${job.title} with their saved profile and résumé.\n\nReview it in your dashboard: ${base}/#dashboard`,
        html: layout({
          heading: `New applicant for ${job.title}`,
          paragraphs: [
            `<b>${esc(who)}</b> (${esc(me.email)}) applied with their saved profile and résumé.`,
            "Reply to this email to reach the candidate directly.",
          ],
          button: { label: "Review in your dashboard", url: `${base}/#dashboard` },
        }),
      }),
      sendEmail({
        to: me.email,
        subject: `Your application to ${job.company}`,
        text: `Thanks, ${who}. Your application for ${job.title} at ${job.company} was sent with your résumé. The hiring team will contact you directly.`,
        html: layout({
          heading: "Application sent",
          paragraphs: [
            `Thanks, ${esc(who)}. Your application for <b>${esc(job.title)}</b> at ${esc(job.company)} was sent with your résumé.`,
            "The hiring team will contact you directly if they'd like to talk.",
          ],
        }),
      }),
    ]);
    return json({ ok: true, external: false, duplicate: false });
  }

  return fail("Not found", 404);
};

export const config = { path: ["/api/candidate", "/api/candidate/*"] };
