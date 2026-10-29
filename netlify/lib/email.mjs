// Transactional email through Resend (https://resend.com).
// Without RESEND_API_KEY (local dev, tests) messages are logged and kept in globalThis.__outbox instead of sent.
import { BRAND } from "./shared.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function sendEmail({ to, subject, text, html, replyTo }) {
  const from = process.env.EMAIL_FROM || `${BRAND} <jobs@example.com>`;
  if (!process.env.RESEND_API_KEY) {
    (globalThis.__outbox ||= []).push({ to, subject, text, html, replyTo });
    console.log(`[email not sent: RESEND_API_KEY unset] to=${to} subject=${subject}`);
    return { skipped: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!res.ok) {
    // Email problems are logged, never surfaced as a failed application or payment.
    console.error("Resend error", res.status, await res.text().catch(() => ""));
    return { error: res.status };
  }
  return res.json();
}

// Simple, readable layout that renders well in every mail client.
export function layout({ heading, paragraphs = [], button, footer }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f2f4f1;font-family:Arial,Helvetica,sans-serif;color:#14211c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d4dcd6;border-radius:6px">
    <tr><td style="padding:18px 24px;border-bottom:1px solid #d4dcd6;font-weight:bold;font-size:16px">${esc(BRAND)}</td></tr>
    <tr><td style="padding:24px">
      <h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
      ${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${p}</p>`).join("")}
      ${button ? `<p style="margin:20px 0 4px"><a href="${esc(button.url)}" style="display:inline-block;background:#1d6a4e;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:6px">${esc(button.label)}</a></p>
      <p style="font-size:12px;color:#5a6a63;margin:8px 0 0;word-break:break-all">${esc(button.url)}</p>` : ""}
    </td></tr>
    ${footer ? `<tr><td style="padding:14px 24px;border-top:1px solid #d4dcd6;font-size:12px;color:#5a6a63">${footer}</td></tr>` : ""}
  </table></td></tr></table></body></html>`;
  return html;
}

export { esc };
