// GET /jobs/:id — a real, shareable URL for every job.
// Serves the app's index.html with the job's title, description, social-preview tags and canonical link
// filled in server-side. Employer-posted jobs also get schema.org JobPosting data so they can appear in
// Google's job search. Sourced listings don't, because they duplicate someone else's posting.
import { db, siteUrl, BRAND } from "../lib/shared.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const EMPLOYMENT = { "full-time": "FULL_TIME", "part-time": "PART_TIME", contract: "CONTRACTOR", internship: "INTERN" };

function jobPostingLd(job, base) {
  // "Birmingham, AL or Atlanta, GA" → first place; "Charlotte, NC" → locality + region
  const first = String(job.location).split(/\s+or\s+|\(|;/i)[0].trim();
  const [locality, region] = first.split(",").map((s) => s.trim());
  const ld = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: `<p>${esc(job.summary)}</p>${job.description ? esc(job.description).replace(/\n/g, "<br>") : ""}`,
    identifier: { "@type": "PropertyValue", name: BRAND, value: `BSK-${String(job.id).padStart(4, "0")}` },
    datePosted: new Date(job.posted_at).toISOString(),
    validThrough: new Date(job.expires_at).toISOString(),
    employmentType: EMPLOYMENT[job.employment_type] || "FULL_TIME",
    hiringOrganization: { "@type": "Organization", name: job.company },
    directApply: !job.apply_url,
    url: `${base}/jobs/${job.id}`,
  };
  if (job.work_mode === "remote") {
    ld.jobLocationType = "TELECOMMUTE";
    ld.applicantLocationRequirements = { "@type": "Country", name: "USA" };
  } else {
    ld.jobLocation = {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: locality, addressRegion: region || undefined, addressCountry: "US" },
    };
  }
  if (job.salary_min || job.salary_max) {
    ld.baseSalary = {
      "@type": "MonetaryAmount", currency: "USD",
      value: { "@type": "QuantitativeValue", unitText: "YEAR",
        ...(job.salary_min ? { minValue: job.salary_min } : {}), ...(job.salary_max ? { maxValue: job.salary_max } : {}) },
    };
  }
  return ld;
}

export default async (req, context) => {
  const base = siteUrl(req);
  const id = context.params?.id;

  const shellRes = await fetch(`${base}/index.html`);
  let html = await shellRes.text();

  const [job] = /^\d+$/.test(id || "")
    ? await db()`SELECT * FROM jobs WHERE id = ${id} AND status = 'open' AND expires_at > now()`
    : [];

  if (!job) {
    html = html.replace("</head>", `<meta name="robots" content="noindex">\n</head>`);
    return new Response(html, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const title = `${job.title} at ${job.company} · ${BRAND}`;
  const desc = `${job.location}. ${job.summary}`.slice(0, 300);
  const url = `${base}/jobs/${job.id}`;
  const head = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta name="twitter:card" content="summary">`,
    job.employer_id
      ? `<script type="application/ld+json">${JSON.stringify(jobPostingLd(job, base)).replace(/</g, "\\u003c")}</script>`
      : `<meta name="robots" content="noindex, follow">`,
  ].join("\n");

  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
    .replace("</head>", `${head}\n</head>`);

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
};

export const config = { path: "/jobs/:id" };
