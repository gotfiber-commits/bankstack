// POST /api/contact — the Contact us form.
//   { name, email, organization?, topic, message, company_website (honeypot, must be empty) } → { ok: true }
// The message is saved, then emailed to CONTACT_TO (default administrator@bankjobz.com) with the
// sender as Reply-To, so answering is just Reply. No email goes to the address typed in the form,
// so the form can't be used to send mail to strangers. Up to 5 messages an hour per network and per
// sender address.
// Retention: the daily maintenance job deletes messages older than a year.
import { db, json, fail, clean, isEmail, sha256, siteUrl } from "../lib/shared.mjs";
import { clientIp } from "../lib/auth.mjs";
import { sendEmail, layout, esc } from "../lib/email.mjs";

export const TOPICS = {
  general: "General question",
  employer: "Posting jobs or my employer account",
  billing: "Billing and my plan",
  candidate: "Job seeker help",
  listing: "A listing that's wrong or should come down",
  partnership: "Partnerships and advertising",
};
const PER_HOUR = 5;

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  let b;
  try { b = await req.json(); } catch { return fail("Send the form as JSON."); }
  if (clean(b.company_website) || clean(b.website)) return json({ ok: true }); // a bot filled the hidden field: pretend it worked

  const name = clean(b.name, 120).replace(/[\r\n]+/g, " ");
  const email = clean(b.email, 200).toLowerCase();
  const organization = clean(b.organization, 160).replace(/[\r\n]+/g, " ") || null;
  const topic = TOPICS[b.topic] ? b.topic : null;
  const message = String(b.message ?? "").replace(/\r/g, "").trim().slice(0, 5000);
  if (!name) return fail("Add your name.");
  if (!isEmail(email)) return fail("Add an email address we can reply to.");
  if (!topic) return fail("Pick what your message is about.");
  if (message.length < 10) return fail("Add a little more detail to your message.");

  const sql = db();
  const netTag = "net:" + sha256(clientIp(req) || "unknown").slice(0, 24);
  const mailTag = "mail:" + sha256(email).slice(0, 24);
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM contact_messages
    WHERE (net_tag = ${netTag} OR mail_tag = ${mailTag}) AND created_at > now() - interval '1 hour'`;
  if (n >= PER_HOUR) return fail("You've sent several messages in the last hour. Please wait a bit, or email administrator@bankjobz.com.", 429);

  const [row] = await sql`INSERT INTO contact_messages (name, email, organization, topic, message, net_tag, mail_tag)
    VALUES (${name}, ${email}, ${organization}, ${topic}, ${message}, ${netTag}, ${mailTag}) RETURNING id`;

  const to = process.env.CONTACT_TO || "administrator@bankjobz.com";
  const label = TOPICS[topic];
  const sent = await sendEmail({
    to,
    replyTo: email,
    subject: `[BankJobz contact] ${label}: ${name}${organization ? `, ${organization}` : ""}`.slice(0, 200),
    text: `${label}\n\nFrom: ${name} <${email}>${organization ? `\nOrganization: ${organization}` : ""}\n\n${message}\n\nReply to this email to answer ${name}.`,
    html: layout({
      heading: label,
      paragraphs: [
        `<b>From:</b> ${esc(name)} &lt;${esc(email)}&gt;${organization ? `<br><b>Organization:</b> ${esc(organization)}` : ""}`,
        `<span style="white-space:pre-wrap">${esc(message)}</span>`,
        `Reply to this email to answer ${esc(name)}.`,
      ],
      button: { label: "Open the admin console", url: `${siteUrl()}/#admin` },
    }),
  });
  if (sent && !sent.error && !sent.skipped) await sql`UPDATE contact_messages SET emailed = true WHERE id = ${row.id}`;
  return json({ ok: true });
};

export const config = { path: "/api/contact" };
