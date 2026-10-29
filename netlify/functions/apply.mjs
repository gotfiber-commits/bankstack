// POST /api/apply — multipart/form-data (or JSON without a file)
// Fields: job_id, name, email, phone?, linkedin_url?, resume_url?, cover_note?, resume (file, PDF/DOC/DOCX ≤ 5 MB)
// "company_website" is a honeypot: people never see it, bots fill it in.
// Direct (employer-posted) jobs store the application and notify the employer.
// Sourced jobs record the candidate's interest and return the original apply link.
import crypto from "node:crypto";
import { db, json, fail, isEmail, isUrl, clean, siteUrl, BRAND } from "../lib/shared.mjs";
import { checkResume, saveFile } from "../lib/files.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

async function readBody(req) {
  const type = req.headers.get("content-type") || "";
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    const fields = {};
    for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
    const file = form.get("resume");
    return { fields, file: file && typeof file === "object" && file.size > 0 ? file : null };
  }
  return { fields: await req.json(), file: null };
}

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let fields, file;
  try { ({ fields, file } = await readBody(req)); } catch { return fail("We couldn't read that application. Try again."); }

  if (clean(fields.company_website)) return json({ ok: true, external: false }); // honeypot: pretend success

  const jobId = String(fields.job_id || "");
  const name = clean(fields.name, 120);
  const email = clean(fields.email, 200).toLowerCase();
  const linkedin = clean(fields.linkedin_url, 300);
  const resumeUrl = clean(fields.resume_url, 500);

  if (!/^\d+$/.test(jobId)) return fail("Pick a job to apply for.");
  if (!name) return fail("Enter your name.");
  if (!isEmail(email)) return fail("Enter a valid email address.");
  if (linkedin && !isUrl(linkedin)) return fail("The LinkedIn link should start with https://");
  if (resumeUrl && !isUrl(resumeUrl)) return fail("The résumé link should start with https://");

  const sql = db();
  const [job] = await sql`
    SELECT j.id, j.title, j.company, j.employer_id, j.apply_url, e.email AS employer_email
    FROM jobs j LEFT JOIN employers e ON e.id = j.employer_id
    WHERE j.id = ${jobId} AND j.status = 'open' AND j.expires_at > now()`;
  if (!job) return fail("This job is no longer open.", 404);

  const [existing] = await sql`SELECT id FROM applications WHERE job_id = ${job.id} AND email = ${email}`;
  if (existing) {
    return job.employer_id
      ? json({ ok: true, external: false, duplicate: true })
      : json({ ok: true, external: true, apply_url: job.apply_url });
  }

  let resume = null;
  if (file && job.employer_id) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const check = checkResume(file.name, bytes);
    if (check.error) return fail(check.error);
    const safeName = clean(file.name, 120).replace(/[^\w.\- ]+/g, "_") || `resume.${check.ext}`;
    resume = { key: `${job.id}/${crypto.randomUUID()}.${check.ext}`, name: safeName, type: check.type, size: bytes.length };
    await saveFile(resume.key, bytes, { name: safeName, type: check.type, job_id: String(job.id) });
  }

  const rows = await sql`
    INSERT INTO applications (job_id, name, email, phone, linkedin_url, resume_url,
                              resume_key, resume_name, resume_type, resume_size, cover_note)
    VALUES (${job.id}, ${name}, ${email}, ${clean(fields.phone, 40) || null}, ${linkedin || null},
            ${resumeUrl || null}, ${resume?.key ?? null}, ${resume?.name ?? null}, ${resume?.type ?? null},
            ${resume?.size ?? null}, ${clean(fields.cover_note, 4000) || null})
    ON CONFLICT (job_id, email) DO NOTHING
    RETURNING id`;

  if (!job.employer_id) {
    return json({ ok: true, external: true, apply_url: job.apply_url });
  }

  if (rows.length) {
    const base = siteUrl(req);
    await Promise.all([
      sendEmail({
        to: job.employer_email,
        replyTo: email,
        subject: `New applicant for ${job.title}: ${name}`,
        text: `${name} (${email}) applied for ${job.title}.\n\nReview it in your dashboard: ${base}/#dashboard`,
        html: layout({
          heading: `New applicant for ${job.title}`,
          paragraphs: [
            `<b>${esc(name)}</b> (${esc(email)}) applied${resume ? " and attached a résumé" : ""}.`,
            "Reply to this email to reach the candidate directly.",
          ],
          button: { label: "Review in your dashboard", url: `${base}/#dashboard` },
        }),
      }),
      sendEmail({
        to: email,
        subject: `Your application to ${job.company}`,
        text: `Thanks, ${name}. Your application for ${job.title} at ${job.company} was sent. The hiring team will contact you directly.`,
        html: layout({
          heading: "Application sent",
          paragraphs: [
            `Thanks, ${esc(name)}. Your application for <b>${esc(job.title)}</b> at ${esc(job.company)} was sent to the hiring team.`,
            "They'll contact you directly if they'd like to talk.",
          ],
          footer: `Sent by ${esc(BRAND)} because you applied for a job on our site.`,
        }),
      }),
    ]);
  }
  return json({ ok: true, external: false, duplicate: rows.length === 0 });
};

export const config = { path: "/api/apply" };
