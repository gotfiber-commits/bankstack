// The institution directory, server-rendered for search engines and people alike:
//   GET /banks            → the directory: states with counts, largest institutions
//   GET /banks/:state     → every institution in a state (slug is the 2-letter code)
//   GET /banks/:slug      → one institution: facts from FDIC/NCUA data + its open jobs
// Every page is plain HTML with real links, which is exactly what Google wants to crawl.
import { db, siteUrl, BRAND } from "../lib/shared.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "Washington, D.C.", FL: "Florida", GA: "Georgia", HI: "Hawaii",
  ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands",
};

// asset_thousands → "$1.2B" / "$740M" / "$850K"
export function assets(thousands) {
  const n = Number(thousands);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = n * 1000;
  if (d >= 1e9) return "$" + (d / 1e9).toFixed(d >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (d >= 1e6) return "$" + Math.round(d / 1e6) + "M";
  return "$" + Math.round(d / 1e3) + "K";
}

const TYPE_LABEL = { bank: "Bank", "credit-union": "Credit union" };

function page({ title, description, canonical, body, noindex = false, status = 200 }) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
${noindex ? `<meta name="robots" content="noindex, follow">` : ""}
<link rel="stylesheet" href="/app.css">
<style>
  .dir { max-width: 60rem; margin: 0 auto; padding: 2rem 16px 4rem; }
  .dir h1 { font-size: 1.9rem; margin: 0 0 0.35rem; }
  .dir .sub { color: var(--muted); margin: 0 0 1.5rem; }
  .dir h2 { font-size: 1.15rem; margin: 2rem 0 0.6rem; }
  .state-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.4rem; list-style: none; padding: 0; margin: 0; }
  .state-grid a { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; text-decoration: none; color: inherit; }
  .state-grid a:hover { border-color: var(--accent); color: var(--accent); }
  .state-grid b { color: var(--muted); font-weight: 500; }
  .inst-table { width: 100%; border-collapse: collapse; }
  .inst-table th, .inst-table td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--line); }
  .inst-table th { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .inst-table td.num, .inst-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .facts-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.9rem; list-style: none; padding: 1rem; margin: 1rem 0; border: 1px solid var(--line); border-radius: 8px; }
  .facts-list b { display: block; font-size: 1.15rem; }
  .facts-list span { color: var(--muted); font-size: 0.82rem; }
  .claim { margin-top: 2rem; padding: 1rem; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 0.9rem; }
  .crumbs { font-size: 0.85rem; margin-bottom: 1rem; }
  .dir .job-link { display: block; padding: 0.7rem 0; border-bottom: 1px solid var(--line); text-decoration: none; color: inherit; }
  .dir .job-link:hover .t { color: var(--accent); }
  .dir .job-link .t { font-weight: 600; }
  .dir .job-link .m { color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<header class="site-head"><div class="wrap"><a class="brand" href="/">${BRAND}</a>
<nav class="nav"><a href="/#jobs">Current positions</a><a href="/banks">Bank directory</a><a class="cta" href="/#post">Post a job</a></nav></div></header>
<main class="dir">
${body}
</main>
<footer class="site-foot"><div class="wrap">
<span>${BRAND}. Jobs at banks and credit unions. <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/banks">Directory</a></span>
<span>Directory figures come from public FDIC and NCUA data and may lag the institution's own reporting. ${BRAND} is not affiliated with or endorsed by the institutions shown.</span>
</div></footer>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

const jobLink = (j) => `<a class="job-link" href="/jobs/${j.id}"><span class="t">${esc(j.title)}</span><br>
<span class="m">${esc(j.location)} · ${esc(j.category)}${j.salary_min || j.salary_max ? " · pay listed" : ""}</span></a>`;

export default async (req, context) => {
  const base = siteUrl(req);
  const sql = db();
  const slug = (context.params?.slug || "").toLowerCase();

  try {
    // ---- /banks — the directory front page ----
    if (!slug) {
      const states = await sql`
        SELECT state, COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE institution_type = 'bank')::int AS banks
        FROM institutions WHERE active AND state IS NOT NULL
        GROUP BY state ORDER BY state`;
      const biggest = await sql`
        SELECT slug, name, city, state, institution_type, asset_thousands
        FROM institutions WHERE active ORDER BY asset_thousands DESC NULLS LAST LIMIT 25`;
      const total = states.reduce((s, r) => s + r.n, 0);
      const body = `
        <h1>Every bank and credit union in America</h1>
        <p class="sub">${total ? `${total.toLocaleString()} institutions from public FDIC and NCUA data — each with its open jobs on ${BRAND}.` : `The directory is being loaded. Check back shortly.`}</p>
        ${states.length ? `<h2>Browse by state</h2>
        <ul class="state-grid">${states.map((s) => `<li><a href="/banks/${s.state.toLowerCase()}">${esc(STATE_NAMES[s.state] || s.state)} <b>${s.n}</b></a></li>`).join("")}</ul>` : ""}
        ${biggest.length ? `<h2>Largest institutions</h2>
        <table class="inst-table"><thead><tr><th>Institution</th><th>Headquarters</th><th class="num">Assets</th></tr></thead>
        <tbody>${biggest.map((b) => `<tr><td><a href="/banks/${esc(b.slug)}">${esc(b.name)}</a></td>
          <td>${esc(b.city || "")}${b.city && b.state ? ", " : ""}${esc(b.state || "")}</td>
          <td class="num">${assets(b.asset_thousands)}</td></tr>`).join("")}</tbody></table>` : ""}
        <div class="claim">Work in banking? <a href="/#jobs">Browse open positions</a> or <a href="/#profile">create a free profile</a> and get every role ranked against your résumé.</div>`;
      return page({
        title: `Bank & Credit Union Directory · ${BRAND}`,
        description: `Every FDIC-insured bank and NCUA credit union in the US, with jobs at each. Browse by state or institution.`,
        canonical: `${base}/banks`, body,
      });
    }

    // ---- /banks/:state — one state's institutions ----
    if (/^[a-z]{2}$/.test(slug)) {
      const st = slug.toUpperCase();
      const insts = await sql`
        SELECT slug, name, city, institution_type, asset_thousands, branches
        FROM institutions WHERE active AND state = ${st}
        ORDER BY asset_thousands DESC NULLS LAST LIMIT 1200`;
      const stateName = STATE_NAMES[st] || st;
      if (!insts.length) {
        return page({ title: `${stateName} · ${BRAND}`, description: "", noindex: true, status: 404,
          body: `<h1>No institutions listed for ${esc(stateName)} yet</h1><p class="sub"><a href="/banks">Back to the directory</a></p>` });
      }
      const body = `
        <p class="crumbs"><a href="/banks">Directory</a> → ${esc(stateName)}</p>
        <h1>Banks and credit unions in ${esc(stateName)}</h1>
        <p class="sub">${insts.length.toLocaleString()} institutions, largest first. Each page shows its open jobs on ${BRAND}.</p>
        <table class="inst-table"><thead><tr><th>Institution</th><th>City</th><th>Type</th><th class="num">Assets</th><th class="num">Branches</th></tr></thead>
        <tbody>${insts.map((b) => `<tr><td><a href="/banks/${esc(b.slug)}">${esc(b.name)}</a></td>
          <td>${esc(b.city || "")}</td><td>${TYPE_LABEL[b.institution_type]}</td>
          <td class="num">${assets(b.asset_thousands)}</td><td class="num">${b.branches ?? ""}</td></tr>`).join("")}</tbody></table>`;
      return page({
        title: `Banks & Credit Unions in ${stateName} — Jobs at Each · ${BRAND}`,
        description: `All ${insts.length} FDIC and NCUA institutions in ${stateName}, with banking jobs at each. Assets, branches and open roles.`,
        canonical: `${base}/banks/${slug}`, body,
      });
    }

    // ---- /banks/:slug — one institution ----
    const [inst] = await sql`SELECT * FROM institutions WHERE slug = ${slug}`;
    if (!inst) {
      return page({ title: `Not found · ${BRAND}`, description: "", noindex: true, status: 404,
        body: `<h1>We don't have a page for that institution</h1><p class="sub">It may have merged or changed names. <a href="/banks">Browse the directory</a>.</p>` });
    }
    const jobs = await sql`
      SELECT id, title, location, category, salary_min, salary_max FROM jobs
      WHERE status = 'open' AND expires_at > now()
        AND (institution_id = ${inst.id} OR lower(company) = lower(${inst.name}))
      ORDER BY (employer_id IS NOT NULL) DESC, posted_at DESC LIMIT 50`;
    const where = [inst.city, inst.state].filter(Boolean).join(", ");
    const facts = [
      inst.asset_thousands ? `<li><b>${assets(inst.asset_thousands)}</b><span>total assets</span></li>` : "",
      inst.branches ? `<li><b>${inst.branches}</b><span>${inst.branches === 1 ? "office" : "offices"}</span></li>` : "",
      inst.employees ? `<li><b>${inst.employees.toLocaleString()}</b><span>employees</span></li>` : "",
      inst.members ? `<li><b>${inst.members.toLocaleString()}</b><span>members</span></li>` : "",
      `<li><b>${TYPE_LABEL[inst.institution_type]}</b><span>${inst.institution_type === "bank" ? `FDIC cert ${esc(inst.regulator_id)}` : `NCUA charter ${esc(inst.regulator_id)}`}</span></li>`,
    ].filter(Boolean).join("");
    const body = `
      <p class="crumbs"><a href="/banks">Directory</a>${inst.state ? ` → <a href="/banks/${inst.state.toLowerCase()}">${esc(STATE_NAMES[inst.state] || inst.state)}</a>` : ""} → ${esc(inst.name)}</p>
      <h1>Jobs at ${esc(inst.name)}</h1>
      <p class="sub">${esc(TYPE_LABEL[inst.institution_type])}${where ? ` headquartered in ${esc(where)}` : ""}.${inst.website ? ` <a href="${esc(/^https?:/.test(inst.website) ? inst.website : "https://" + inst.website)}" rel="nofollow noopener" target="_blank">Website ↗</a>` : ""}</p>
      <ul class="facts-list">${facts}</ul>
      <h2>${jobs.length ? `Open ${jobs.length === 1 ? "position" : "positions"} (${jobs.length})` : "Open positions"}</h2>
      ${jobs.length ? jobs.map(jobLink).join("")
        : `<p class="sub">No openings from ${esc(inst.name)} on ${BRAND} right now. <a href="/#home">Set a job alert</a> and we'll email you when banking roles${inst.state ? ` in ${esc(STATE_NAMES[inst.state] || inst.state)}` : ""} appear, or <a href="/#jobs">browse every open role</a>.</p>`}
      <div class="claim"><b>Work for ${esc(inst.name)}?</b> Post your openings for $99/month and reach candidates who already know banking: <a href="/#post">post a job</a>. To claim or correct this page, email <a href="mailto:listings@bankjobz.com">listings@bankjobz.com</a>. Figures are from public ${inst.institution_type === "bank" ? "FDIC" : "NCUA"} data${inst.data_as_of ? ` (as of ${esc(inst.data_as_of)})` : ""}.</div>`;
    return page({
      title: `Jobs at ${inst.name}${where ? ` — ${where}` : ""} · ${BRAND}`,
      description: `${inst.name}: ${TYPE_LABEL[inst.institution_type].toLowerCase()}${where ? ` in ${where}` : ""}${inst.asset_thousands ? `, ${assets(inst.asset_thousands)} in assets` : ""}. See open jobs and get alerts for new banking roles.`,
      canonical: `${base}/banks/${esc(inst.slug)}`, body,
    });
  } catch {
    // Directory tables not migrated yet: a plain page rather than an error.
    return page({ title: `Bank Directory · ${BRAND}`, description: "", noindex: true, status: 503,
      body: `<h1>The directory is warming up</h1><p class="sub">Try again in a minute, or <a href="/#jobs">browse open positions</a>.</p>` });
  }
};

export const config = { path: ["/banks", "/banks/:slug"] };
