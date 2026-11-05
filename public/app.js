(() => {
  "use strict";

  // Display only. Stripe charges whatever STRIPE_PRICE_ID is set to ($99/month recurring).
  const PRICE = "$99";

  const CATEGORIES = {
    "branch-retail": "Branch & retail",
    "lending-credit": "Lending & credit",
    "commercial-banking": "Commercial banking",
    "operations": "Operations",
    "risk-compliance": "Risk & compliance",
    "finance-accounting": "Finance & accounting",
    "wealth-trust": "Wealth & trust",
    "technology": "Technology & IT",
    "data-analytics": "Data & analytics",
    "leadership-admin": "Leadership & support",
  };
  const CATEGORY_BLURB = {
    "branch-retail": "Tellers, member service reps, personal bankers and branch managers.",
    "lending-credit": "Loan officers, underwriters, processors and mortgage teams.",
    "commercial-banking": "Relationship managers, treasury management and business banking.",
    "operations": "Deposit operations, payments, card services and collections.",
    "risk-compliance": "BSA/AML, compliance, audit, fraud and enterprise risk.",
    "finance-accounting": "Accounting, treasury, financial reporting and planning.",
    "wealth-trust": "Financial advisors, trust officers and investment services.",
    "technology": "Software, infrastructure, cybersecurity and IT support.",
    "data-analytics": "Data engineering, reporting, BI and data architecture.",
    "leadership-admin": "Executives, HR, marketing, facilities and administration.",
  };
  const MODES = { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" };
  const EMPLOYMENT = { "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", internship: "Internship" };
  const INST = { bank: "Bank", "credit-union": "Credit union", fintech: "Fintech", other: "Other" };
  // Mirrors netlify/lib/banking.mjs — the ids must match.
  const CORE_SYSTEMS = {
    "jack-henry-silverlake": "Jack Henry SilverLake", "jack-henry-cif2020": "Jack Henry CIF 20/20",
    "symitar-episys": "Symitar Episys", "fiserv-dna": "Fiserv DNA", "fiserv-premier": "Fiserv Premier",
    "fiserv-signature": "Fiserv Signature", "fis-horizon": "FIS Horizon", "fis-ibs": "FIS IBS",
    "corelation-keystone": "Corelation KeyStone", "csi-nupoint": "CSI NuPoint",
    "finastra-phoenix": "Finastra Phoenix", "temenos-transact": "Temenos Transact",
  };
  const LICENSES = {
    "nmls": "NMLS (MLO)", "crcm": "CRCM", "cams": "CAMS", "cfe": "CFE", "ctfa": "CTFA", "cfa": "CFA",
    "cpa": "CPA", "aap": "AAP", "sie": "SIE", "series-6": "Series 6", "series-7": "Series 7",
    "series-63": "Series 63", "series-65": "Series 65/66",
  };
  const STAGES = { new: "New", reviewing: "Reviewing", interview: "Interview", offer: "Offer", hired: "Hired", rejected: "Not a fit" };

  const state = { jobs: [], demo: false, filters: { q: "", category: "", institution_type: "", work_mode: "", core_system: "", license: "" }, appFilter: "" };
  const view = document.getElementById("view");

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "$" + Math.round(n / 1000) + "k";
  const salary = (j) => {
    if (j.salary_min && j.salary_max) return `${money(j.salary_min)}–${money(j.salary_max)}`;
    if (j.salary_min) return `${money(j.salary_min)}+`;
    if (j.salary_max) return `up to ${money(j.salary_max)}`;
    return "";
  };
  const jobCode = (id) => "BSK-" + String(id).padStart(4, "0");
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
  const fmtMoney = (cents) => "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0 });
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  // Real, shareable URLs on the live site; hash links in the preview, which has no server.
  const jobHref = (id) => (state.demo ? `#job-${id}` : `/jobs/${id}`);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };
  const key = () => store.get("bankstack.key");
  const adminKey = () => store.get("bankstack.admin");
  const ckey = () => store.get("bankjobz.ck");

  async function api(path, opts = {}) {
    const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
    const headers = { ...(isForm ? {} : { "content-type": "application/json" }), ...(opts.headers || {}) };
    if (opts.auth && key()) headers.authorization = "Bearer " + key();
    if (opts.admin && adminKey()) headers.authorization = "Bearer " + adminKey();
    if (opts.cauth && ckey()) headers.authorization = "Bearer " + ckey();
    const res = await fetch(path, { ...opts, headers });
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      throw Object.assign(new Error(res.ok ? "The server sent an unexpected reply. Refresh and try again."
        : `The server hit a problem (error ${res.status}). Try again in a minute.`), { status: res.status });
    }
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: res.status });
    return data;
  }

  function showMsg(el, text, isError) {
    el.hidden = false;
    el.className = "msg" + (isError ? " error" : "");
    el.textContent = text;
  }

  function flash(text, isError) {
    const el = document.getElementById("flash");
    el.querySelector(".msg").className = "msg" + (isError ? " error" : "");
    el.querySelector(".msg").textContent = text;
    el.hidden = false;
  }

  // Hidden from people, irresistible to bots. Anything typed here makes the server drop the submission.
  const honeypot = `<div class="hp" aria-hidden="true"><label>Company website<input name="company_website" tabindex="-1" autocomplete="off"></label></div>`;

  // ---------- data ----------
  async function loadJobs() {
    try {
      const data = await api("/api/jobs");
      state.jobs = data.jobs;
      state.ai = !!data.ai;
      state.demo = false;
    } catch {
      const res = await fetch("seed-jobs.json");
      const seed = await res.json();
      state.jobs = seed.map((j, i) => ({ ...j, id: i + 1, apply_url: j.source_url, direct: false,
        core_systems: j.core_systems || [], licenses: j.licenses || [] }));
      state.demo = true;
    }
    document.getElementById("demo-banner").hidden = !state.demo;
    // The directory is served by the live site's functions; the static preview has no /banks.
    const banksLink = document.getElementById("nav-banks");
    if (banksLink) banksLink.hidden = state.demo;
  }

  function filtered() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    return state.jobs.filter((j) =>
      (!f.category || j.category === f.category) &&
      (!f.institution_type || j.institution_type === f.institution_type) &&
      (!f.work_mode || j.work_mode === f.work_mode) &&
      (!f.core_system || (j.core_systems || []).includes(f.core_system)) &&
      (!f.license || (j.licenses || []).includes(f.license)) &&
      (!q || [j.title, j.company, j.location, j.summary].join(" ").toLowerCase().includes(q)));
  }

  // ---------- guilloché (the engraved line pattern on banknotes) ----------
  function drawGuilloche(canvas, opts = {}) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    ctx.lineWidth = 0.7;
    ctx.globalAlpha = opts.alpha ?? 0.13;
    const narrow = w < 700;
    const cx = narrow ? w * 0.9 : w * (opts.x ?? 0.8), cy = h * (opts.y ?? 0.5);
    const R = Math.min(h * (opts.scale ?? 0.62), opts.max ?? 240);
    for (let k = 0; k < 20; k++) {
      ctx.beginPath();
      const phase = (k / 20) * Math.PI * 2;
      for (let t = 0; t <= Math.PI * 2 + 0.01; t += 0.008) {
        const r = R * (0.62 + 0.22 * Math.sin(7 * t + phase) + 0.1 * Math.cos(13 * t));
        const x = cx + r * Math.cos(t), y = cy + r * Math.sin(t);
        t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = (opts.alpha ?? 0.13) * 0.6;
    for (let k = 0; k < 9; k++) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = h - 18 - k * 3 + 6 * Math.sin(x / 26 + k * 0.7);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // ---------- shared pieces ----------
  function jobRow(j) {
    const pay = salary(j);
    return `<li><a class="job-row" href="${jobHref(j.id)}">
      <div class="job-main">
        <span class="job-title">${esc(j.title)}</span>
        <span class="job-meta">${esc(j.company)} · ${esc(j.location)}</span>
        <span class="tags">
          ${j.direct ? '<span class="tag direct">Direct</span>' : ""}
          <span class="tag">${esc(CATEGORIES[j.category] || j.category)}</span>
          <span class="tag">${esc(MODES[j.work_mode] || j.work_mode)}</span>
          <span class="tag">${esc(INST[j.institution_type] || j.institution_type)}</span>
        </span>
      </div>
      <div class="job-side">
        <span class="salary${pay ? "" : " none"}">${pay ? esc(pay) : "Pay not listed"}</span>
        <span class="job-id">${jobCode(j.id)}</span>
      </div>
    </a></li>`;
  }

  const options = (map, sel) => Object.entries(map).map(([k, v]) =>
    `<option value="${k}"${k === sel ? " selected" : ""}>${esc(v)}</option>`).join("");

  // Role fields shared by "Post a job", "Edit posting" and the admin's "Add a sourced listing".
  function roleFields(j = {}, prefix = "p", afterTitle = "") {
    return `
      <div class="field"><label for="${prefix}-title">Job title</label><input id="${prefix}-title" name="title" required placeholder="Senior Loan Officer" value="${esc(j.title)}"></div>
      ${afterTitle}
      <div class="row-2">
        <div class="field"><label for="${prefix}-location">Location</label><input id="${prefix}-location" name="location" required placeholder="Birmingham, AL" value="${esc(j.location)}"></div>
        <div class="field"><label for="${prefix}-mode">Arrangement</label><select id="${prefix}-mode" name="work_mode">${options(MODES, j.work_mode)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label for="${prefix}-cat">Department</label><select id="${prefix}-cat" name="category">${options(CATEGORIES, j.category)}</select></div>
        <div class="field"><label for="${prefix}-emp">Employment</label><select id="${prefix}-emp" name="employment_type">${options(EMPLOYMENT, j.employment_type)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label for="${prefix}-min">Salary from (USD/yr)</label><input id="${prefix}-min" name="salary_min" inputmode="numeric" placeholder="95,000" value="${esc(j.salary_min ?? "")}"></div>
        <div class="field"><label for="${prefix}-max">Salary to (USD/yr)</label><input id="${prefix}-max" name="salary_max" inputmode="numeric" placeholder="125,000" value="${esc(j.salary_max ?? "")}"></div>
      </div>
      <div class="field"><label for="${prefix}-summary">Summary</label><input id="${prefix}-summary" name="summary" maxlength="400" required placeholder="One or two sentences shown in the job list" value="${esc(j.summary)}"></div>
      <div class="field"><label for="${prefix}-desc">Full description</label><textarea id="${prefix}-desc" name="description" rows="7" placeholder="Responsibilities, qualifications, schedule and benefits">${esc(j.description)}</textarea></div>
      <div class="field"><label for="${prefix}-apply">Apply link (optional)</label><input id="${prefix}-apply" name="apply_url" type="url" placeholder="https://your-ats.example/job/123" value="${esc(j.apply_url)}"><span class="hint">Leave blank to collect applications here, with résumés, in your dashboard.</span></div>
      <details class="banking-extra"${(j.core_systems || []).length || (j.licenses || []).length ? " open" : ""}>
        <summary>Banking specifics (optional) — core system &amp; licenses</summary>
        <div class="field"><label>Core banking system this role touches</label>
          <div class="chip-set">${chipChecks("core_systems", CORE_SYSTEMS, j.core_systems)}</div>
          <span class="hint">Candidates with hands-on experience on your core rank higher and can filter straight to you.</span></div>
        <div class="field"><label>Licenses or certifications required or preferred</label>
          <div class="chip-set">${chipChecks("licenses", LICENSES, j.licenses)}</div></div>
      </details>`;
  }

  // A set of checkbox chips for an {id: label} map, with the given ids checked.
  function chipChecks(name, map, checked = []) {
    return Object.entries(map).map(([k, v]) =>
      `<label class="chip-check"><input type="checkbox" name="${name}" value="${k}"${(checked || []).includes(k) ? " checked" : ""}><span>${esc(v)}</span></label>`).join("");
  }

  // ---------- AI writing assistant (shown only when the site has a key configured) ----------
  function aiDraftBox() {
    if (!state.ai || state.demo) return "";
    return `
      <details class="banking-extra ai-box" open>
        <summary>✨ Skip the writing — let AI draft this posting</summary>
        <div class="field" style="margin-top:0.8rem"><label for="ai-notes">Rough notes (optional)</label>
          <textarea id="ai-notes" rows="3" maxlength="2000" placeholder="Shift hours, team size, must-have experience, benefits — fragments are fine."></textarea>
          <span class="hint">The job title above is all it needs. Notes here — or location, pay and department below — make the draft sharper. It writes the summary and description; you review and edit before posting.</span></div>
        <button class="btn secondary" id="ai-draft" type="button">Draft it</button>
        <div class="msg" id="ai-msg" hidden></div>
      </details>`;
  }

  function bindAiDraft(prefix, extra = () => ({})) {
    const btn = document.getElementById("ai-draft");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const msg = document.getElementById("ai-msg");
      const val = (id) => document.getElementById(`${prefix}-${id}`)?.value || "";
      if (!val("title").trim()) return showMsg(msg, "Give the role a title first — the assistant builds around it.", true);
      btn.disabled = true;
      btn.textContent = "Writing…";
      try {
        const r = await api("/api/ai/posting", { method: "POST", auth: !!key(), body: JSON.stringify({
          title: val("title"), location: val("location"), category: val("cat"),
          work_mode: val("mode"), salary_min: val("min"), salary_max: val("max"),
          notes: document.getElementById("ai-notes").value, ...extra() }) });
        document.getElementById(`${prefix}-summary`).value = r.summary;
        document.getElementById(`${prefix}-desc`).value = r.description;
        showMsg(msg, "Draft filled in below — read it and make it yours before continuing.", false);
      } catch (err) { showMsg(msg, err.message, true); }
      btn.disabled = false;
      btn.textContent = "Draft it";
    });
  }

  // ---------- job alerts ----------
  function alertsPanel(preselect = "") {
    return `
      <section class="alerts" aria-labelledby="alerts-title">
        <div>
          <p class="eyebrow">Job alerts</p>
          <h2 id="alerts-title">Get new roles by email, once a week.</h2>
          <p class="source-note">Pick the departments you care about, or leave them all off for everything. One click to unsubscribe.</p>
        </div>
        <form class="form" id="alerts-form" novalidate>
          <fieldset class="chip-set"><legend class="visually-hidden">Departments</legend>
            ${Object.entries(CATEGORIES).map(([k, v]) => `<label class="chip-check"><input type="checkbox" name="categories" value="${k}"${k === preselect ? " checked" : ""}><span>${esc(v)}</span></label>`).join("")}
          </fieldset>
          <div class="inline-form">
            <label class="visually-hidden" for="al-email">Email</label>
            <input id="al-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required>
            <button class="btn" type="submit">Send me alerts</button>
          </div>
          ${honeypot}
          <div class="msg" id="alerts-msg" hidden></div>
        </form>
      </section>`;
  }

  function bindAlerts() {
    const form = document.getElementById("alerts-form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("alerts-msg");
      const fd = new FormData(form);
      const email = String(fd.get("email") || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return showMsg(msg, "Enter a valid email address.", true);
      if (state.demo) return showMsg(msg, "Preview mode: on the live site this emails you a confirmation link.", false);
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        const r = await api("/api/alerts", { method: "POST", body: JSON.stringify({
          email, categories: fd.getAll("categories"), company_website: fd.get("company_website") }) });
        showMsg(msg, r.confirmed ? "Your alert specialties are updated." : `Check ${email} and click the link to confirm.`, false);
      } catch (err) { showMsg(msg, err.message, true); }
      btn.disabled = false;
    });
  }

  // ---------- home ----------
  function viewHome() {
    const jobs = state.jobs;
    const institutions = new Set(jobs.map((j) => j.company)).size;
    const counts = {};
    jobs.forEach((j) => (counts[j.category] = (counts[j.category] || 0) + 1));
    const withPay = jobs.filter((j) => j.salary_min || j.salary_max);
    // Show the board's breadth: prefer one role per department, best-paying first
    const ranked = [...jobs].sort((a, b) => (b.direct - a.direct) || ((b.salary_max || b.salary_min || 0) - (a.salary_max || a.salary_min || 0)));
    const preview = [];
    const seenCats = new Set();
    for (const j of ranked) if (!seenCats.has(j.category)) { preview.push(j); seenCats.add(j.category); if (preview.length === 4) break; }
    for (const j of ranked) { if (preview.length === 4) break; if (!preview.includes(j)) preview.push(j); }

    view.innerHTML = `
      <section class="home-hero">
        <canvas id="guilloche" aria-hidden="true"></canvas>
        <div class="wrap home-hero-grid">
          <div class="home-hero-copy">
            <p class="eyebrow">Banks · Credit unions · Every department</p>
            <h1>The job board for <em>banks and credit unions</em>.</h1>
            <p class="lede">BankJobz lists jobs at banks and credit unions only, from tellers and loan officers to compliance, operations, technology and leadership. Candidates find roles that value banking experience. Banks reach people who already know the industry.</p>
            <div class="cta-row">
              <a class="btn btn-lg" href="#jobs">View current positions</a>
              <a class="btn btn-lg secondary" href="#post">Post a job · ${PRICE}/mo</a>
            </div>
          </div>
          <aside class="statement" aria-label="Latest openings">
            <div class="statement-head"><span>Latest openings</span><span>${jobs.length} open</span></div>
            <ul>
              ${preview.map((j) => `<li><a href="${jobHref(j.id)}">
                <span class="st-title">${esc(j.title)}</span>
                <span class="st-meta">${esc(j.company)} · ${esc(j.location)}</span>
                <span class="st-pay">${salary(j) ? esc(salary(j)) : "—"}</span>
              </a></li>`).join("")}
            </ul>
            <a class="statement-foot" href="#jobs">See all ${jobs.length} positions →</a>
          </aside>
        </div>
      </section>

      <section class="figures">
        <div class="wrap figures-grid">
          <div><strong>${jobs.length}</strong><span>open banking jobs</span></div>
          <div><strong>${institutions}</strong><span>banks and credit unions hiring</span></div>
          <div><strong>${jobs.filter((j) => j.work_mode !== "onsite").length}</strong><span>remote or hybrid roles</span></div>
          <div><strong>${withPay.length}</strong><span>listings with posted pay</span></div>
        </div>
      </section>

      <section class="band">
        <div class="wrap two-up">
          <div class="audience">
            <p class="eyebrow">For job seekers</p>
            <h2>Roles that value banking experience.</h2>
            <p>Every listing is a job at a bank or credit union. Filter by department, institution type and on-site, hybrid or remote, then apply with your résumé in a couple of minutes.</p>
            <a class="text-link" href="#jobs">Browse positions →</a>
            <a class="text-link" href="#profile">Create a free profile and get jobs ranked for you →</a>
            ${state.demo ? "" : `<a class="text-link" href="/banks">Look up any bank or credit union in the directory →</a>`}
          </div>
          <div class="audience">
            <p class="eyebrow">For banks and credit unions</p>
            <h2>Reach candidates who already speak your language.</h2>
            <p>Skip general job boards full of applicants who've never worked in a bank. Post a role for ${PRICE} a month, review applicants and résumés in your dashboard, and stop whenever it's filled.</p>
            <a class="text-link" href="#post">Post a job →</a>
          </div>
        </div>
      </section>

      <section class="band alt">
        <div class="wrap">
          <p class="eyebrow">Departments</p>
          <h2 class="section-title">Browse by department</h2>
          <div class="spec-grid">
            ${Object.entries(CATEGORIES).map(([k, v]) => `
              <button class="spec" data-cat="${k}" type="button">
                <span class="spec-name">${esc(v)}</span>
                ${counts[k] ? `<span class="spec-count">${counts[k]} open</span>` : ""}
                <span class="spec-blurb">${esc(CATEGORY_BLURB[k])}</span>
              </button>`).join("")}
          </div>
        </div>
      </section>

      <section class="band">
        <div class="wrap pricing">
          <div>
            <p class="eyebrow">Posting a job</p>
            <h2 class="section-title">Three steps, about five minutes</h2>
            <ol class="steps">
              <li><b>Describe the role.</b> Title, location, pay range and what the team does.</li>
              <li><b>Pay by card through Stripe.</b> ${PRICE} for the first month of that posting.</li>
              <li><b>Go live and review applicants.</b> Your posting sits above sourced listings, marked Direct, and gets its own page in Google's job search. It renews monthly until you cancel it.</li>
            </ol>
          </div>
          <div class="price-card">
            <div class="price"><strong>${PRICE}</strong><span>per posting, per month</span></div>
            <ul>
              <li>Featured above sourced listings</li>
              <li>Applicants and résumés in your dashboard, with an email for each one</li>
              <li>Move candidates through stages from New to Hired</li>
              <li>Post as many roles as you need, each billed on its own</li>
              <li>Cancel a posting any time; it stays up through the month you paid for</li>
            </ul>
            <a class="btn btn-lg" href="#post">Post a job</a>
          </div>
        </div>
      </section>

      <section class="band alt"><div class="wrap">${alertsPanel()}</div></section>

      <section class="closing">
        <div class="wrap closing-inner">
          <h2>Looking for your next role in banking?</h2>
          <a class="btn btn-lg light" href="#jobs">View current positions</a>
        </div>
      </section>`;

    view.querySelectorAll(".spec").forEach((b) => b.addEventListener("click", () => {
      state.filters = { q: "", category: b.dataset.cat, institution_type: "", work_mode: "" };
      location.hash = "jobs";
    }));
    bindAlerts();
    requestAnimationFrame(() => drawGuilloche(document.getElementById("guilloche"), { x: 0.86, scale: 0.7, max: 300, alpha: 0.11 }));
  }

  // ---------- jobs ----------
  function renderList() {
    const list = filtered();
    document.getElementById("result-count").textContent =
      `${list.length} open ${list.length === 1 ? "role" : "roles"}`;
    document.getElementById("ledger").innerHTML = list.length
      ? list.map(jobRow).join("")
      : `<li class="empty">No roles match those filters. Clear a filter or try a broader search.</li>`;
    document.querySelectorAll(".cat-chip").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.cat === state.filters.category)));
  }

  function viewJobs() {
    const counts = {};
    state.jobs.forEach((j) => (counts[j.category] = (counts[j.category] || 0) + 1));
    const f = state.filters;

    view.innerHTML = `
      <section class="hero">
        <canvas id="guilloche" aria-hidden="true"></canvas>
        <div class="wrap">
          <h1>Current positions</h1>
          <p>Openings at banks and credit unions. Direct postings come from the employer; the rest are gathered from public job sites and link to the original.</p>
          <div class="stat-row" role="group" aria-label="Filter by department">
            ${Object.entries(CATEGORIES).filter(([k]) => counts[k]).map(([k, v]) =>
              `<button class="cat-chip" data-cat="${k}" aria-pressed="false" type="button">${esc(v)} <b>${counts[k]}</b></button>`).join("")}
          </div>
        </div>
      </section>
      <div class="wrap">
        <div class="filters">
          <input class="search" id="f-q" type="search" placeholder="Search title, bank or city" value="${esc(f.q)}" aria-label="Search jobs">
          <select id="f-inst" aria-label="Institution type"><option value="">All institutions</option>${options({ bank: "Banks", "credit-union": "Credit unions", fintech: "Fintech" }, f.institution_type)}</select>
          <select id="f-mode" aria-label="Work arrangement"><option value="">Any arrangement</option>${options(MODES, f.work_mode)}</select>
          <select id="f-core" aria-label="Core system"><option value="">Any core system</option>${options(CORE_SYSTEMS, f.core_system)}</select>
          <select id="f-lic" aria-label="License"><option value="">Any license</option>${options(LICENSES, f.license)}</select>
        </div>
        <div class="result-count" id="result-count"></div>
        <ul class="ledger" id="ledger"></ul>
        <div class="alerts-wrap">${alertsPanel(f.category)}</div>
      </div>`;

    view.querySelectorAll(".cat-chip").forEach((b) => b.addEventListener("click", () => {
      state.filters.category = state.filters.category === b.dataset.cat ? "" : b.dataset.cat;
      renderList();
    }));
    document.getElementById("f-q").addEventListener("input", (e) => { state.filters.q = e.target.value; renderList(); });
    document.getElementById("f-inst").addEventListener("change", (e) => { state.filters.institution_type = e.target.value; renderList(); });
    document.getElementById("f-mode").addEventListener("change", (e) => { state.filters.work_mode = e.target.value; renderList(); });
    document.getElementById("f-core").addEventListener("change", (e) => { state.filters.core_system = e.target.value; renderList(); });
    document.getElementById("f-lic").addEventListener("change", (e) => { state.filters.license = e.target.value; renderList(); });
    renderList();
    bindAlerts();
    requestAnimationFrame(() => drawGuilloche(document.getElementById("guilloche")));
  }

  function viewJob(id) {
    const j = state.jobs.find((x) => String(x.id) === String(id));
    if (!j) {
      view.innerHTML = `<div class="wrap narrow"><h1 style="font-size:1.6rem">This job isn't open anymore.</h1>
        <p>It may have been filled or taken down by the employer.</p><a class="btn" href="#jobs">See current positions</a></div>`;
      return;
    }
    // Count one view per job per browser session (the employer sees views in their dashboard).
    if (!state.demo) {
      const seenKey = `bankjobz.viewed.${j.id}`;
      let seen = false;
      try { seen = !!sessionStorage.getItem(seenKey); sessionStorage.setItem(seenKey, "1"); } catch { /* storage blocked: still count */ }
      if (!seen) fetch(`/api/jobs/${j.id}`, { keepalive: true }).catch(() => {});
    }
    const pay = salary(j);
    const external = !j.direct;
    const ownAts = j.direct && j.apply_url;
    view.innerHTML = `
      <div class="wrap detail">
        <article style="display:grid;gap:1.1rem;min-width:0">
          <a class="back" href="#jobs">← All positions</a>
          <span class="job-id">${jobCode(j.id)}${j.direct ? ' · <span class="tag direct">Direct</span>' : ""}</span>
          <h1>${esc(j.title)}</h1>
          <p class="lede">${esc(j.summary)}</p>
          <dl class="facts">
            <dt>Employer</dt><dd>${esc(j.company)} (${esc(INST[j.institution_type] || "")})</dd>
            <dt>Location</dt><dd>${esc(j.location)}</dd>
            <dt>Arrangement</dt><dd>${esc(MODES[j.work_mode] || j.work_mode)}</dd>
            <dt>Employment</dt><dd>${esc(EMPLOYMENT[j.employment_type] || "Full-time")}</dd>
            <dt>Department</dt><dd>${esc(CATEGORIES[j.category] || j.category)}</dd>
            ${(j.core_systems || []).length ? `<dt>Core system</dt><dd>${j.core_systems.map((s) => esc(CORE_SYSTEMS[s] || s)).join(", ")}</dd>` : ""}
            ${(j.licenses || []).length ? `<dt>Licenses</dt><dd>${j.licenses.map((s) => esc(LICENSES[s] || s)).join(", ")}</dd>` : ""}
            <dt>Pay</dt><dd class="salary">${pay ? esc(pay) + " per year" : "Not listed"}</dd>
            ${j.posted_at ? `<dt>Posted</dt><dd>${esc(fmtDate(j.posted_at))}</dd>` : ""}
          </dl>
          ${j.description ? `<div class="prose">${esc(j.description)}</div>` : ""}
          ${external ? `<p class="source-note">Found on ${esc(j.source_name)}. Listings we gather can close without notice, so confirm the role on the original posting.</p>` : ""}
          <div><button class="linkish" id="save-job" type="button">☆ Save job</button> · <button class="linkish" id="copy-link" type="button">Copy link to this job</button></div>
        </article>
        <aside class="panel">
          <div id="qa-slot"></div>
          <h2>Apply for this role</h2>
          ${external ? `<a class="btn secondary" href="${esc(j.apply_url)}" target="_blank" rel="noopener">Open the original posting ↗</a>
            <p class="source-note">Or leave your details and we'll take you there.</p>` : ""}
          ${ownAts ? `<a class="btn" href="${esc(j.apply_url)}" target="_blank" rel="noopener">Apply on ${esc(j.company)}'s site ↗</a>` : `
          <form class="form" id="apply-form" novalidate>
            <div class="field"><label for="a-name">Full name</label><input id="a-name" name="name" autocomplete="name" required></div>
            <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" required></div>
            ${external ? "" : `<div class="field"><label for="a-phone">Phone (optional)</label><input id="a-phone" name="phone" type="tel" autocomplete="tel"></div>`}
            <div class="field"><label for="a-linkedin">LinkedIn profile (optional)</label><input id="a-linkedin" name="linkedin_url" type="url" placeholder="https://linkedin.com/in/…"></div>
            ${external ? "" : `
            <div class="field"><label for="a-file">Résumé</label><input id="a-file" name="resume" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"><span class="hint">PDF or Word, up to 5 MB.</span></div>
            <div class="field"><label for="a-note">Note to the hiring team (optional)</label><textarea id="a-note" name="cover_note" rows="4"></textarea></div>`}
            ${honeypot}
            <button class="btn" type="submit">${external ? "Continue to the posting" : "Send application"}</button>
            <div class="msg" id="apply-msg" hidden></div>
          </form>`}
        </aside>
      </div>`;

    document.getElementById("copy-link").addEventListener("click", async (e) => {
      const url = state.demo ? location.href : `${location.origin}/jobs/${j.id}`;
      try { await navigator.clipboard.writeText(url); e.target.textContent = "Link copied"; }
      catch { e.target.textContent = url; }
    });

    initCandidateBits(j);
    const form = document.getElementById("apply-form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("apply-msg");
      const fd = new FormData(form);
      const file = fd.get("resume");
      if (!String(fd.get("name")).trim() || !/^\S+@\S+\.\S+$/.test(String(fd.get("email")))) {
        return showMsg(msg, "Enter your name and a valid email address.", true);
      }
      if (file && file.size > 5 * 1024 * 1024) return showMsg(msg, "Résumés can be up to 5 MB.", true);
      if (file && file.size && !/\.(pdf|docx?)$/i.test(file.name)) return showMsg(msg, "Upload your résumé as a PDF or Word document.", true);
      if (state.demo) return showMsg(msg, "Preview mode: applications are saved once the site is deployed.", false);
      if (file && !file.size) fd.delete("resume");
      fd.append("job_id", j.id);
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const r = await api("/api/apply", { method: "POST", body: fd });
        if (r.external) {
          form.innerHTML = `<p class="msg">Saved. Finish your application on the employer's site.</p>
            <a class="btn" href="${esc(r.apply_url)}" target="_blank" rel="noopener">Continue to the posting ↗</a>`;
        } else {
          form.innerHTML = `<p class="msg">${r.duplicate ? "You've already applied to this role." : `Application sent to ${esc(j.company)}. A confirmation is on its way to your inbox.`}</p>`;
        }
      } catch (err) {
        showMsg(msg, err.message, true);
        btn.disabled = false;
        btn.textContent = external ? "Continue to the posting" : "Send application";
      }
    });
  }

  // ---------- employer accounts ----------
  // ---------- employer sign-in: password + second factor ----------
  // One card handles every step: sign in → code, create account → code, forgot → code + new password.
  const deviceKey = () => store.get("bankjobz.device");

  function authCard(mode = "signin") {
    return `<section class="panel auth-card" id="auth-card" data-mode="${mode}">
      <div class="auth-tabs" role="tablist">
        <button type="button" role="tab" data-auth-tab="signin" aria-selected="${mode === "signin"}">Sign in</button>
        <button type="button" role="tab" data-auth-tab="signup" aria-selected="${mode === "signup"}">Create account</button>
      </div>
      <div id="auth-body"></div>
    </section>`;
  }

  const pwField = (id, label, autocomplete, hint = "") => `
    <div class="field"><label for="${id}">${label}</label>
      <div class="pw-wrap"><input id="${id}" name="${id.replace(/^a-/, "")}" type="password" autocomplete="${autocomplete}" required minlength="${autocomplete === "new-password" ? 10 : 1}">
        <button type="button" class="linkish pw-toggle" data-toggle="${id}" aria-label="Show password">Show</button></div>
      ${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;

  function bindAuth(after) {
    const card = document.getElementById("auth-card");
    if (!card) return;
    const body = document.getElementById("auth-body");
    const msgBox = () => document.getElementById("auth-msg");
    const busy = (form, on) => form.querySelectorAll("button, input").forEach((el) => (el.disabled = on));

    const bindToggles = () => body.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.toggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.textContent = show ? "Hide" : "Show";
    }));

    const finish = (r) => {
      store.set("bankstack.key", r.token);
      if (r.device_token) store.set("bankjobz.device", r.device_token);
      updateNav();
      state.pendingFlash = [`Signed in${r.company ? ` to ${r.company}` : ""}.`];
      after();
    };

    // Step 2: the 6-digit code (email or authenticator app), or a recovery code.
    const codeStep = ({ challenge, method, email, purpose }) => {
      const viaApp = method === "totp";
      body.innerHTML = `
        <form class="form" id="code-form" novalidate>
          <h2>${purpose === "verify" ? "Confirm your email" : "Check it's you"}</h2>
          <p>${viaApp ? "Open your authenticator app and enter the 6-digit code for BankJobz."
            : `We emailed a 6-digit code to <b>${esc(email)}</b>. It expires in 10 minutes. You can also use the button in that email.`}</p>
          <div class="field"><label for="a-code">${viaApp ? "Code from your app" : "Code from your email"}</label>
            <input id="a-code" name="code" class="code-input" inputmode="${viaApp ? "text" : "numeric"}" autocomplete="one-time-code"
              maxlength="${viaApp ? 11 : 6}" placeholder="123456" required>
            ${viaApp ? `<span class="hint">Lost your phone? Enter one of your recovery codes instead (like a1b2c-3d4e5).</span>` : ""}</div>
          <label class="check-line"><input type="checkbox" id="a-remember" checked> Trust this device for 30 days (don't ask for a code here)</label>
          <button class="btn btn-lg" type="submit">${purpose === "verify" ? "Confirm and continue" : "Verify and sign in"}</button>
          <div class="cta-row auth-links">
            ${viaApp ? "" : `<button type="button" class="linkish" id="a-resend">Send a new code</button>`}
            <button type="button" class="linkish" id="a-back">Start over</button>
          </div>
          <div class="msg" id="auth-msg" hidden></div>
        </form>`;
      const form = document.getElementById("code-form");
      const input = document.getElementById("a-code");
      input.focus();
      if (!viaApp) input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 6);
        if (input.value.length === 6) form.requestSubmit();
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = input.value.trim();
        if (code.length < 6) return showMsg(msgBox(), "Enter the 6-digit code.", true);
        busy(form, true);
        try {
          finish(await api("/api/auth/verify", { method: "POST", body: JSON.stringify({
            challenge, code, remember_device: document.getElementById("a-remember").checked }) }));
        } catch (err) {
          busy(form, false);
          input.select();
          showMsg(msgBox(), err.message, true);
        }
      });
      document.getElementById("a-resend")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          await api("/api/auth/resend", { method: "POST", body: JSON.stringify({ challenge }) });
          showMsg(msgBox(), `A new code is on its way to ${email}.`, false);
        } catch (err) { showMsg(msgBox(), err.message, true); }
        setTimeout(() => (e.target.disabled = false), 30000);
      });
      document.getElementById("a-back").addEventListener("click", () => show("signin"));
    };

    const show = (mode, notice = "") => {
      card.dataset.mode = mode;
      card.querySelectorAll("[data-auth-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.authTab === mode)));
      if (mode === "signin") {
        body.innerHTML = `
          <form class="form" id="signin-form" novalidate>
            ${notice ? `<p class="msg">${esc(notice)}</p>` : ""}
            <div class="field"><label for="a-email">Work email</label><input id="a-email" name="email" type="email" autocomplete="username" required></div>
            ${pwField("a-password", "Password", "current-password")}
            <button class="btn btn-lg" type="submit">Sign in</button>
            <div class="cta-row auth-links"><button type="button" class="linkish" id="a-forgot">Forgot or set password</button></div>
            <div class="msg" id="auth-msg" hidden></div>
          </form>`;
        const form = document.getElementById("signin-form");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const email = form.email.value.trim(), password = form.password.value;
          if (!/^\S+@\S+\.\S+$/.test(email) || !password) return showMsg(msgBox(), "Enter your email and password.", true);
          if (state.demo) return showMsg(msgBox(), "Preview mode: sign-in works on the live site.", false);
          busy(form, true);
          try {
            const r = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password, device_token: deviceKey() }) });
            if (r.token) return finish(r);
            codeStep({ ...r, email });
          } catch (err) {
            busy(form, false);
            showMsg(msgBox(), err.message, true);
          }
        });
        document.getElementById("a-forgot").addEventListener("click", () => show("forgot"));
      } else if (mode === "signup") {
        body.innerHTML = `
          <form class="form" id="signup-form" novalidate>
            <p class="source-note">Free to create. Your own dashboard for postings, applicants and billing — you only pay ${PRICE}/month per job you post.</p>
            <div class="row-2">
              <div class="field"><label for="su-name">Your name</label><input id="su-name" name="contact_name" autocomplete="name" required></div>
              <div class="field"><label for="su-title">Your title (optional)</label><input id="su-title" name="contact_title" autocomplete="organization-title" placeholder="HR Manager"></div>
            </div>
            <div class="row-2">
              <div class="field"><label for="su-company">Institution name</label><input id="su-company" name="company" autocomplete="organization" required></div>
              <div class="field"><label for="su-type">Type</label><select id="su-type" name="institution_type">${options(INST, "bank")}</select></div>
            </div>
            <div class="field"><label for="su-email">Work email</label><input id="su-email" name="email" type="email" autocomplete="username" required>
              <span class="hint">You'll confirm it with a code. Applicant notifications and receipts go here too.</span></div>
            ${pwField("a-newpw", "Create a password", "new-password", "At least 10 characters. A short phrase is easy to remember and hard to guess.")}
            ${honeypot}
            <button class="btn btn-lg" type="submit">Create account</button>
            <p class="source-note">Every new sign-in is protected by a second step: a code by email, or from an authenticator app you can add later.</p>
            <div class="msg" id="auth-msg" hidden></div>
          </form>`;
        const form = document.getElementById("signup-form");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(form));
          data.password = document.getElementById("a-newpw").value;
          if (!data.contact_name.trim()) return showMsg(msgBox(), "Enter your name.", true);
          if (!data.company.trim()) return showMsg(msgBox(), "Enter your institution's name.", true);
          if (!/^\S+@\S+\.\S+$/.test(data.email)) return showMsg(msgBox(), "Enter a valid work email.", true);
          if (data.password.length < 10) return showMsg(msgBox(), "Use at least 10 characters for your password.", true);
          if (state.demo) return showMsg(msgBox(), "Preview mode: on the live site this creates your account.", false);
          busy(form, true);
          try {
            const r = await api("/api/auth/signup", { method: "POST", body: JSON.stringify(data) });
            codeStep({ ...r, email: data.email.trim(), purpose: "verify" });
          } catch (err) {
            busy(form, false);
            showMsg(msgBox(), err.message, true);
          }
        });
      } else if (mode === "forgot") {
        body.innerHTML = `
          <form class="form" id="forgot-form" novalidate>
            <h2>Forgot or set your password</h2>
            <p>We'll email you a code. Use this too if your account was created before passwords were added.</p>
            <div class="field"><label for="f-email">Work email</label><input id="f-email" type="email" autocomplete="username" required></div>
            <button class="btn btn-lg" type="submit">Email me a code</button>
            <div class="cta-row auth-links"><button type="button" class="linkish" id="a-back">Back to sign in</button></div>
            <div class="msg" id="auth-msg" hidden></div>
          </form>`;
        document.getElementById("a-back").addEventListener("click", () => show("signin"));
        const form = document.getElementById("forgot-form");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const email = document.getElementById("f-email").value.trim();
          if (!/^\S+@\S+\.\S+$/.test(email)) return showMsg(msgBox(), "Enter a valid email.", true);
          if (state.demo) return showMsg(msgBox(), "Preview mode: password resets work on the live site.", false);
          busy(form, true);
          try {
            const { challenge } = await api("/api/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
            body.innerHTML = `
              <form class="form" id="reset-form" novalidate>
                <h2>Set a new password</h2>
                <p>If <b>${esc(email)}</b> has an account, a 6-digit code is on its way. Enter it with your new password.</p>
                <div class="field"><label for="r-code">Code from your email</label><input id="r-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
                ${pwField("a-resetpw", "New password", "new-password", "At least 10 characters.")}
                <button class="btn btn-lg" type="submit">Save new password</button>
                <div class="cta-row auth-links"><button type="button" class="linkish" id="a-resend">Send a new code</button><button type="button" class="linkish" id="a-back">Back to sign in</button></div>
                <div class="msg" id="auth-msg" hidden></div>
              </form>`;
            bindToggles();
            document.getElementById("a-back").addEventListener("click", () => show("signin"));
            document.getElementById("a-resend").addEventListener("click", async (ev) => {
              ev.target.disabled = true;
              try { await api("/api/auth/resend", { method: "POST", body: JSON.stringify({ challenge }) }); showMsg(msgBox(), "A new code is on its way.", false); }
              catch (err) { showMsg(msgBox(), err.message, true); }
              setTimeout(() => (ev.target.disabled = false), 30000);
            });
            const rf = document.getElementById("reset-form");
            rf.addEventListener("submit", async (ev) => {
              ev.preventDefault();
              const code = document.getElementById("r-code").value.trim(), password = document.getElementById("a-resetpw").value;
              if (!/^\d{6}$/.test(code)) return showMsg(msgBox(), "Enter the 6-digit code.", true);
              if (password.length < 10) return showMsg(msgBox(), "Use at least 10 characters.", true);
              busy(rf, true);
              try {
                await api("/api/auth/reset", { method: "POST", body: JSON.stringify({ challenge, code, password }) });
                show("signin", "Password saved. Sign in with it now.");
                document.getElementById("a-email").value = email;
              } catch (err) { busy(rf, false); showMsg(msgBox(), err.message, true); }
            });
          } catch (err) { busy(form, false); showMsg(msgBox(), err.message, true); }
        });
      }
      bindToggles();
      body.querySelector("input:not([type=hidden]):not([tabindex='-1'])")?.focus({ preventScroll: true });
    };

    card.querySelectorAll("[data-auth-tab]").forEach((t) => t.addEventListener("click", () => show(t.dataset.authTab)));
    // An error message goes away as soon as they start fixing the field.
    body.addEventListener("input", () => { const m = msgBox(); if (m && m.classList.contains("error")) m.hidden = true; });
    show(card.dataset.mode);
  }

  const postIntro = (extra = "") => `
    <section class="post-intro">
      <p class="eyebrow">Post a job</p>
      <h1>${PRICE} per posting, per month.</h1>
      <p class="lede">Create your free employer account, describe the role, and pay by card through Stripe. It goes live right away as a Direct listing above sourced jobs, with its own page in Google's job search, and renews monthly until you cancel it from your dashboard.</p>
      ${extra}
    </section>`;

  async function viewPost() {
    // Hiring managers need an account first: it's where their postings, applicants and billing live.
    if (!key()) {
      view.innerHTML = `<div class="wrap post">${postIntro(`<ul class="ticks">
          <li>Your own dashboard: postings, applicants, notes and billing</li>
          <li>Applicants by email and in one place, with résumés</li>
          <li>Protected sign-in: password plus a one-time code</li></ul>`)}${authCard("signup")}</div>`;
      bindAuth(() => { location.hash = "post"; route(); });
      return;
    }
    let acct = null, prefill = {};
    if (!state.demo) {
      try { acct = (await api("/api/employer", { auth: true })).account; }
      catch (err) { if (err.status === 401) return signedOut(err.message); }
      // "Duplicate" from the dashboard: start from an existing posting.
      if (state.duplicateFrom) {
        try { prefill = await api(`/api/employer/jobs/${state.duplicateFrom}`, { auth: true }); } catch { prefill = {}; }
        state.duplicateFrom = null;
      }
    }
    view.innerHTML = `
      <div class="wrap post">
        ${postIntro(acct ? `<p class="source-note">Posting as <b>${esc(acct.company)}</b>${acct.contact_name ? ` · ${esc(acct.contact_name)}` : ""}. Billed to your account. <a href="#dashboard">Back to dashboard</a></p>` : "")}
        <form class="panel form" id="post-form" novalidate>
          <h2>${prefill.title ? "The role (copied from an earlier posting)" : "The role"}</h2>
          ${roleFields(prefill, "p", aiDraftBox())}
          ${honeypot}
          <div class="checkout-line"><span>Due today, then monthly</span><strong>${PRICE}.00</strong></div>
          <button class="btn btn-lg" type="submit">Continue to payment</button>
          <div class="msg" id="post-msg" hidden></div>
        </form>
      </div>`;

    bindAiDraft("p", () => ({ company: acct?.company, institution_type: acct?.institution_type }));

    document.getElementById("post-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = document.getElementById("post-msg");
      const pfd = new FormData(form);
      const data = Object.fromEntries(pfd);
      data.core_systems = pfd.getAll("core_systems");
      data.licenses = pfd.getAll("licenses");
      if (!data.title.trim() || !data.location.trim() || !data.summary.trim()) {
        return showMsg(msg, "Add a job title, location and summary.", true);
      }
      if (state.demo) return showMsg(msg, `Preview mode: on the live site this opens Stripe Checkout for ${PRICE}/month.`, false);
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const r = await api("/api/checkout", { method: "POST", auth: true, body: JSON.stringify(data) });
        location.href = r.url;
      } catch (err) {
        if (err.status === 401) return signedOut(err.message);
        showMsg(msg, err.message, true);
        btn.disabled = false;
      }
    });
  }

  // ---------- after checkout ----------
  // The button in a sign-in, confirmation or reset email. The page asks the server what the link is
  // for and which account it belongs to (never trusting the address), shows that, and needs a click —
  // plus the sign-up password or a new password — before using it, so mail scanners can't use it up.
  async function viewEmailLink() {
    const pending = state.authLink;
    if (!pending) { location.hash = "dashboard"; return; }
    view.innerHTML = `<div class="wrap narrow"><section class="panel auth-card" id="link-card"><p>Checking your link…</p></section></div>`;
    const card = document.getElementById("link-card");
    let info;
    try {
      info = await api("/api/auth/link/peek", { method: "POST", body: JSON.stringify({ link: pending.link }) });
    } catch (err) {
      state.authLink = null;
      card.innerHTML = `<h2>This link can't be used</h2><p class="msg error">${esc(err.message)}</p>
        <div class="cta-row"><a class="btn" href="#dashboard">Go to sign in</a></div>`;
      return;
    }
    const who = `<b>${esc(info.email)}</b>${info.company ? ` (${esc(info.company)})` : ""}`;
    const copy = {
      login: { h: "Finish signing in", p: `Sign in to the BankJobz employer account ${who} on this device.`, btn: "Continue", field: "" },
      verify: { h: "Confirm your email", p: `Confirm the new BankJobz employer account for ${who}. Enter the password you chose when you signed up.`,
        btn: "Confirm and sign in", field: pwField("a-linkpw", "Your password", "current-password") },
      reset: { h: "Set a new password", p: `Choose a new password for ${who}. You'll be signed out everywhere else.`, btn: "Save new password",
        field: pwField("a-linkpw", "New password", "new-password", "At least 10 characters. A short phrase is easy to remember and hard to guess.") },
    }[info.purpose];
    card.innerHTML = `
      <form class="form" id="link-form" novalidate>
        <h2>${copy.h}</h2>
        <p>${copy.p}</p>
        <input type="email" autocomplete="username" value="${esc(info.email)}" hidden aria-hidden="true" tabindex="-1">
        ${copy.field}
        <button class="btn btn-lg" type="submit">${copy.btn}</button>
        <p class="source-note">Not you, or didn't ask for this? Close this page — nothing changes unless you continue.</p>
        <div class="msg" id="link-msg" hidden></div>
      </form>`;
    card.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.toggle);
      const showIt = input.type === "password";
      input.type = showIt ? "text" : "password";
      b.textContent = showIt ? "Hide" : "Show";
    }));
    const form = document.getElementById("link-form");
    const msg = document.getElementById("link-msg");
    form.addEventListener("input", () => { if (msg.classList.contains("error")) msg.hidden = true; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = copy.field ? document.getElementById("a-linkpw").value : undefined;
      if (info.purpose === "reset" && password.length < 10) return showMsg(msg, "Use at least 10 characters.", true);
      if (info.purpose === "verify" && !password) return showMsg(msg, "Enter your password.", true);
      form.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
      try {
        const r = await api("/api/auth/link", { method: "POST", body: JSON.stringify({ link: pending.link, password }) });
        state.authLink = null;
        if (r.reset) {
          state.pendingFlash = ["Password saved. Sign in with it now."];
        } else {
          store.set("bankstack.key", r.token);
          state.pendingFlash = [`Signed in${r.company ? ` to ${r.company}` : ""}.`];
        }
        updateNav();
        location.hash = "dashboard";
      } catch (err) {
        form.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
        showMsg(msg, err.message, true);
        if (err.status === 409 || /expired|already used/.test(err.message)) {
          form.querySelector("button[type=submit]").outerHTML = `<a class="btn btn-lg" href="#dashboard">Go to sign in</a>`;
          state.authLink = null;
        }
      }
    });
    document.getElementById("a-linkpw")?.focus();
  }

  async function viewWelcome() {
    const sessionId = new URLSearchParams(location.search).get("session_id");
    view.innerHTML = `<div class="wrap narrow"><section class="panel" id="welcome"><p>Confirming your payment…</p></section></div>`;
    const box = document.getElementById("welcome");
    if (!sessionId) {
      box.innerHTML = `<p>There's no payment to confirm. <a href="#post">Post a job</a> to get started.</p>`;
      return;
    }
    try {
      const r = await api("/api/session?session_id=" + encodeURIComponent(sessionId));
      history.replaceState(null, "", "/#welcome");
      await loadJobs();
      const live = r.job && r.job.status === "open";
      box.innerHTML = `
        <h2>Thanks, ${esc(r.company)}. ${live ? "Your job is live." : "Payment received."}</h2>
        ${r.job ? `<p><b>${esc(r.job.title)}</b> ${live ? "is now listed as a Direct posting and renews monthly until you cancel it." : "will appear as soon as Stripe confirms the payment."}</p>` : ""}
        <p>Applicants will arrive in your dashboard and by email. Sign in from any device with your email and password.</p>
        <div class="cta-row">
          <a class="btn" href="#dashboard">Go to dashboard</a>
          ${live ? `<a class="btn secondary" href="${jobHref(r.job.id)}">View your posting</a>` : ""}
        </div>`;
      updateNav();
    } catch (err) {
      box.innerHTML = `<p class="msg error">${esc(err.message)}</p><p>If you were charged, refresh this page in a minute.</p>`;
    }
  }

  // ---------- dashboard ----------
  function jobStatus(j) {
    if (j.status === "pending") return { label: "Awaiting payment", bad: true };
    if (j.status === "closed") return { label: "Closed", bad: true };
    if (j.cancel_at_period_end) return { label: `Ends ${fmtDate(j.paid_through)}`, bad: true };
    return { label: j.paid_through ? `Renews ${fmtDate(j.paid_through)}` : "Live", bad: false };
  }

  function signedOut(message) {
    store.del("bankstack.key");
    updateNav();
    view.innerHTML = `<div class="wrap post">
      <section class="post-intro"><p class="eyebrow">Employers</p><h1>Sign in to your dashboard</h1>
        <p class="lede">Your postings, applicants and billing, from any device.</p>
        ${message ? `<p class="msg error">${esc(message)}</p>` : ""}</section>
      ${authCard("signin")}</div>`;
    bindAuth(() => { location.hash = "dashboard"; route(); });
  }

  async function downloadAuthed(path, name, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(path, { headers: { authorization: "Bearer " + key() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Download failed.");
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name || "download" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) { const m = document.getElementById("act-msg"); if (m) m.textContent = err.message; }
    if (btn) btn.disabled = false;
  }
  const downloadResume = (appId, name, btn) => downloadAuthed(`/api/employer/applications/${appId}/resume`, name || "resume", btn);

  const DASH_TABS = [["overview", "Overview"], ["postings", "Postings"], ["applicants", "Applicants"], ["talent", "Talent pool"], ["account", "Account & security"]];
  const stars = (n) => [1, 2, 3, 4, 5].map((i) => `<span aria-hidden="true">${i <= (n || 0) ? "★" : "☆"}</span>`).join("");

  async function viewDashboard(tab) {
    if (!key()) return signedOut();
    if (tab) state.dashTab = tab;
    state.dashTab ||= "overview";
    view.innerHTML = `<div class="wrap dash"><p>Loading your dashboard…</p></div>`;
    let d;
    try { d = await api("/api/employer", { auth: true }); }
    catch (err) { return err.status === 401 ? signedOut(err.message) : (view.innerHTML = `<div class="wrap dash"><p class="msg error">${esc(err.message)}</p></div>`); }
    state.dash = d;
    const first = d.account?.contact_name ? d.account.contact_name.split(" ")[0] : "";

    view.innerHTML = `
      <div class="wrap dash">
        <div class="dash-head">
          <div style="display:grid;gap:0.25rem">
            <p class="eyebrow" style="margin:0">Employer dashboard</p>
            <h1 style="font-size:1.8rem">${esc(d.company)}</h1>
            <span class="source-note">${d.account?.contact_name ? `${esc(d.account.contact_name)}${d.account.contact_title ? `, ${esc(d.account.contact_title)}` : ""} · ` : ""}${esc(d.email)}</span>
          </div>
          <div class="cta-row">
            <a class="btn" href="#post">${d.jobs.length ? "Post a job" : "Post your first job"}</a>
            ${d.account?.has_billing ? `<button class="btn secondary" id="billing" type="button">Cards &amp; invoices</button>` : ""}
            <button class="linkish" id="signout" type="button">Sign out</button>
          </div>
        </div>
        <nav class="profile-tabs dash-tabs" aria-label="Dashboard sections">
          ${DASH_TABS.map(([k, v]) => `<button type="button" data-dtab="${k}"${k === state.dashTab ? ' aria-current="page"' : ""}>${v}${k === "applicants" && d.stats.new_applicants ? ` <span class="new-dot">${d.stats.new_applicants}</span>` : ""}</button>`).join("")}
        </nav>
        <p class="source-note" id="act-msg" aria-live="polite"></p>
        <div id="dash-body"></div>
      </div>`;

    const say = (t) => (document.getElementById("act-msg").textContent = t);
    document.getElementById("signout").addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST", auth: true }); } catch { /* signing out locally regardless */ }
      store.del("bankstack.key"); updateNav(); location.hash = "home";
    });
    document.getElementById("billing")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const r = await api("/api/employer/billing", { method: "POST", auth: true }); location.href = r.url; }
      catch (err) { e.target.disabled = false; say(err.message); }
    });
    view.querySelectorAll("[data-dtab]").forEach((b) => b.addEventListener("click", () => {
      state.dashTab = b.dataset.dtab;
      view.querySelectorAll("[data-dtab]").forEach((x) => (x.dataset.dtab === state.dashTab ? x.setAttribute("aria-current", "page") : x.removeAttribute("aria-current")));
      say("");
      renderTab();
    }));
    const goTab = (t, filters = {}) => {
      Object.assign(state, filters);
      view.querySelector(`[data-dtab="${t}"]`).click();
      window.scrollTo({ top: 0 });
    };

    const renderTab = () => {
      const body = document.getElementById("dash-body");
      ({ overview: tabOverview, postings: tabPostings, applicants: tabApplicants, talent: tabTalent, account: tabAccount })[state.dashTab](body);
    };

    // ----- Overview -----
    function tabOverview(body) {
      const s = d.stats;
      const totalPipe = Object.values(d.pipeline).reduce((a, b) => a + b, 0);
      body.innerHTML = `
        ${d.jobs.length ? "" : `
        <section class="panel first-run">
          <h2>Welcome${first ? `, ${esc(first)}` : ""}</h2>
          <p>This is where your postings, applicants and billing live. Post your first job — the AI assistant can write it from just the title — and applications show up here and in your inbox.</p>
          <a class="btn btn-lg" href="#post">Post your first job · ${PRICE}/mo</a>
        </section>`}
        <div class="kpis">
          <div class="kpi"><strong>${s.live_postings}</strong><span>live ${s.live_postings === 1 ? "posting" : "postings"}</span></div>
          <div class="kpi"><strong>${s.applicants}</strong><span>applicants${s.new_applicants ? ` · <b>${s.new_applicants} new</b>` : ""}</span></div>
          <div class="kpi"><strong>${s.applicants_7d}</strong><span>in the last 7 days</span></div>
          <div class="kpi"><strong>${s.views.toLocaleString()}</strong><span>views of live postings</span></div>
          <div class="kpi"><strong>${fmtMoney(s.monthly_cents)}</strong><span>per month (${s.renewing} renewing)</span></div>
        </div>
        ${d.attention.length ? `<section class="panel attention">
          <h2 class="dash-title">Needs your attention</h2>
          <ul>${d.attention.map((a) => `<li><b>${esc(a.title)}</b> — ${esc(a.text)} <button class="linkish" data-goto-postings type="button">Manage</button></li>`).join("")}</ul>
        </section>` : ""}
        <section>
          <h2 class="dash-title">Hiring pipeline</h2>
          ${totalPipe ? `<div class="pipeline">${Object.entries(d.pipeline).map(([k, n]) => `
            <button type="button" class="pipe-step${n ? "" : " empty"}" data-goto-stage="${k}">
              <strong>${n}</strong><span>${esc(STAGES[k])}</span>
              <i style="width:${Math.max(n ? 6 : 0, Math.round((n / totalPipe) * 100))}%"></i>
            </button>`).join("")}</div>`
            : `<p class="source-note">Your pipeline fills in as candidates apply. Move them through stages from the Applicants tab.</p>`}
        </section>
        <section>
          <div class="dash-row"><h2 class="dash-title">Latest applicants</h2>${d.applications.length ? `<button class="linkish" data-goto-applicants type="button">See all ${d.applications.length} →</button>` : ""}</div>
          ${d.applications.length ? `<ul class="recent-apps">${d.applications.slice(0, 5).map((a) => `
            <li${a.status === "new" ? ' class="is-new"' : ""}><b>${esc(a.name)}</b> <span class="source-note">for ${esc(a.job_title)} · ${esc(fmtDate(a.created_at))}</span>
              <span class="status-pill${a.status === "rejected" ? " bad" : ""}">${esc(STAGES[a.status])}</span></li>`).join("")}</ul>`
            : `<p class="source-note">No applicants yet. They'll appear here, and in your inbox, as they apply.</p>`}
        </section>
        ${d.account.mfa_method === "email" ? `<p class="source-note tip">Tip: for stronger sign-in security, add an authenticator app under <button class="linkish" data-goto-account type="button">Account &amp; security</button>.</p>` : ""}`;
      body.querySelectorAll("[data-goto-stage]").forEach((b) => b.addEventListener("click", () => goTab("applicants", { appStage: b.dataset.gotoStage, appFilter: "" })));
      body.querySelectorAll("[data-goto-applicants]").forEach((b) => b.addEventListener("click", () => goTab("applicants", { appStage: "", appFilter: "" })));
      body.querySelectorAll("[data-goto-postings]").forEach((b) => b.addEventListener("click", () => goTab("postings")));
      body.querySelectorAll("[data-goto-account]").forEach((b) => b.addEventListener("click", () => goTab("account")));
    }

    // ----- Postings -----
    function tabPostings(body) {
      body.innerHTML = `
        <div class="table-wrap"><table class="stack-table">
          <thead><tr><th>Job</th><th>Status</th><th class="num">Views</th><th class="num">Applicants</th><th class="num">Apply rate</th><th>Actions</th></tr></thead>
          <tbody>${d.jobs.length ? d.jobs.map((j) => {
            const s = jobStatus(j);
            const acts = [];
            if (j.status === "open") acts.push(`<a href="${jobHref(j.id)}">View</a>`);
            if (j.status !== "closed") acts.push(`<a href="#edit-${j.id}">Edit</a>`);
            acts.push(`<button class="linkish" data-dup="${j.id}" type="button">Duplicate</button>`);
            if (j.applications) acts.push(`<button class="linkish" data-see-apps="${j.id}" type="button">Applicants</button>`);
            if (j.status === "pending") acts.push(`<button class="linkish" data-act="pay" data-id="${j.id}" type="button">Finish payment</button>`);
            else if (j.status === "open" && j.cancel_at_period_end) acts.push(`<button class="linkish" data-act="resume" data-id="${j.id}" type="button">Keep renewing</button>`);
            else if (j.status === "open") acts.push(`<button class="linkish danger" data-act="cancel" data-id="${j.id}" type="button">Cancel</button>`);
            const rate = j.views ? Math.round((j.applications / j.views) * 1000) / 10 + "%" : "—";
            return `<tr>
              <td data-label="Job"><b>${esc(j.title)}</b><br><span class="source-note">${esc(j.location)} · posted ${esc(fmtDate(j.posted_at))}</span></td>
              <td data-label="Status"><span class="status-pill${s.bad ? " bad" : ""}">${esc(s.label)}</span></td>
              <td data-label="Views" class="num">${j.views.toLocaleString()}</td>
              <td data-label="Applicants" class="num">${j.applications}${j.new_applications ? ` <span class="new-dot">${j.new_applications} new</span>` : ""}</td>
              <td data-label="Apply rate" class="num">${rate}</td>
              <td data-label="Actions" class="acts">${acts.join(" ")}</td></tr>`;
          }).join("") : `<tr><td colspan="6" class="source-note">No postings yet. <a href="#post">Post your first job</a>.</td></tr>`}</tbody>
        </table></div>
        <p class="source-note">Each posting is ${PRICE}/month and renews until you cancel; a cancelled posting stays live through the month you've paid for. <b>Duplicate</b> starts a new posting pre-filled from an old one.</p>`;
      body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
        if (b.dataset.act === "cancel" && !confirmInline(b, "Stop renewing? It stays live until the paid month ends.")) return;
        b.disabled = true;
        try {
          const r = await api(`/api/employer/jobs/${b.dataset.id}/${b.dataset.act}`, { method: "POST", auth: true });
          if (r.url) { location.href = r.url; return; }
          await loadJobs();
          viewDashboard("postings");
        } catch (err) { b.disabled = false; say(err.message); }
      }));
      body.querySelectorAll("[data-dup]").forEach((b) => b.addEventListener("click", () => { state.duplicateFrom = b.dataset.dup; location.hash = "post"; }));
      body.querySelectorAll("[data-see-apps]").forEach((b) => b.addEventListener("click", () => goTab("applicants", { appFilter: b.dataset.seeApps, appStage: "" })));
    }

    // A second click confirms a destructive action, instead of a browser pop-up.
    function confirmInline(btn, text) {
      if (btn.dataset.armed) return true;
      btn.dataset.armed = "1";
      const original = btn.textContent;
      btn.textContent = "Click again to confirm";
      say(text);
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = original; }, 5000);
      return false;
    }

    // ----- Applicants -----
    function tabApplicants(body) {
      state.appSearch ||= "";
      body.innerHTML = `
        <div class="filters app-filters">
          <input id="ap-q" type="search" placeholder="Search name or email" aria-label="Search applicants" value="${esc(state.appSearch)}">
          <select id="ap-job" aria-label="Posting"><option value="">All postings</option>${d.jobs.map((j) => `<option value="${j.id}"${String(j.id) === String(state.appFilter || "") ? " selected" : ""}>${esc(j.title)}</option>`).join("")}</select>
          <select id="ap-stage" aria-label="Stage"><option value="">All stages</option>${options(STAGES, state.appStage || "")}</select>
          <select id="ap-sort" aria-label="Sort"><option value="new">Newest first</option><option value="rating"${state.appSort === "rating" ? " selected" : ""}>Highest rated</option></select>
          <button class="btn secondary" id="ap-export" type="button">Export CSV</button>
        </div>
        <p class="source-note" id="ap-count"></p>
        <div id="ap-list" class="app-list"></div>`;
      const draw = () => {
        const q = state.appSearch.toLowerCase();
        let list = d.applications.filter((a) =>
          (!state.appFilter || String(a.job_id) === String(state.appFilter)) &&
          (!state.appStage || a.status === state.appStage) &&
          (!q || `${a.name} ${a.email}`.toLowerCase().includes(q)));
        if (state.appSort === "rating") list = [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0));
        document.getElementById("ap-count").textContent = d.applications.length
          ? `${list.length} of ${d.applications.length} applicants` : "";
        document.getElementById("ap-list").innerHTML = list.length ? list.map((a) => `
          <article class="app-card${a.status === "new" ? " is-new" : ""}" data-app-card="${a.id}">
            <div class="app-top">
              <div><b class="app-name">${esc(a.name)}</b> <span class="source-note">applied for ${esc(a.job_title)} · ${esc(fmtDate(a.created_at))}</span></div>
              <div class="app-controls">
                <div class="stars" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-rate="${i}" aria-label="${i} star${i > 1 ? "s" : ""}" class="${i <= (a.rating || 0) ? "on" : ""}">★</button>`).join("")}</div>
                <select class="stage" data-app="${a.id}" aria-label="Stage for ${esc(a.name)}">${options(STAGES, a.status)}</select>
              </div>
            </div>
            <div class="app-contact">
              <a href="mailto:${esc(a.email)}">${esc(a.email)}</a>${a.phone ? ` · <a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : ""}
              ${a.linkedin_url ? ` · <a href="${esc(a.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}
              ${a.has_resume ? ` · <button class="linkish" data-resume="${a.id}" data-name="${esc(a.resume_name)}" type="button">Résumé (${esc(a.resume_name || "file")}${a.resume_size ? `, ${fmtSize(a.resume_size)}` : ""})</button>` : ""}
              ${a.resume_url ? ` · <a href="${esc(a.resume_url)}" target="_blank" rel="noopener">Résumé link</a>` : ""}
            </div>
            ${a.cover_note ? `<details><summary>Their note</summary><p class="prose">${esc(a.cover_note)}</p></details>` : ""}
            <details${a.notes ? " open" : ""}><summary>Your private notes${a.notes ? "" : " (only your team sees these)"}</summary>
              <textarea data-notes rows="3" maxlength="5000" placeholder="Interview notes, follow-ups…">${esc(a.notes || "")}</textarea>
              <button class="btn secondary" data-save-notes type="button">Save notes</button>
            </details>
          </article>`).join("")
          : `<p class="source-note">${d.applications.length ? "No applicants match those filters." : "Applicants show up here, and in your inbox, as they apply."}</p>`;
        bindCards();
      };
      const saveNotes = async (card, patch) => {
        const app = d.applications.find((x) => String(x.id) === card.dataset.appCard);
        const next = { notes: app.notes || "", rating: app.rating ?? null, ...patch };
        await api(`/api/employer/applications/${app.id}/notes`, { method: "POST", auth: true, body: JSON.stringify(next) });
        Object.assign(app, next);
      };
      const bindCards = () => {
        body.querySelectorAll("[data-resume]").forEach((b) => b.addEventListener("click", () => downloadResume(b.dataset.resume, b.dataset.name, b)));
        body.querySelectorAll("select.stage").forEach((s) => s.addEventListener("change", async () => {
          s.disabled = true;
          try {
            await api(`/api/employer/applications/${s.dataset.app}/status`, { method: "POST", auth: true, body: JSON.stringify({ status: s.value }) });
            const app = d.applications.find((x) => String(x.id) === s.dataset.app);
            d.pipeline[app.status]--; d.pipeline[s.value]++;
            app.status = s.value;
            s.closest(".app-card").classList.toggle("is-new", s.value === "new");
            say(`${app.name} moved to ${STAGES[s.value]}.`);
          } catch (err) { say(err.message); }
          s.disabled = false;
        }));
        body.querySelectorAll("[data-rate]").forEach((b) => b.addEventListener("click", async () => {
          const card = b.closest("[data-app-card]");
          const app = d.applications.find((x) => String(x.id) === card.dataset.appCard);
          const val = Number(b.dataset.rate) === app.rating ? null : Number(b.dataset.rate); // click again to clear
          try {
            await saveNotes(card, { rating: val });
            card.querySelectorAll("[data-rate]").forEach((x) => x.classList.toggle("on", Number(x.dataset.rate) <= (val || 0)));
            say(val ? `Rated ${app.name} ${val}/5.` : `Cleared ${app.name}'s rating.`);
          } catch (err) { say(err.message); }
        }));
        body.querySelectorAll("[data-save-notes]").forEach((b) => b.addEventListener("click", async () => {
          const card = b.closest("[data-app-card]");
          b.disabled = true;
          try { await saveNotes(card, { notes: card.querySelector("[data-notes]").value }); say("Notes saved."); }
          catch (err) { say(err.message); }
          b.disabled = false;
        }));
      };
      document.getElementById("ap-q").addEventListener("input", (e) => { state.appSearch = e.target.value; draw(); });
      document.getElementById("ap-job").addEventListener("change", (e) => { state.appFilter = e.target.value; draw(); });
      document.getElementById("ap-stage").addEventListener("change", (e) => { state.appStage = e.target.value; draw(); });
      document.getElementById("ap-sort").addEventListener("change", (e) => { state.appSort = e.target.value; draw(); });
      document.getElementById("ap-export").addEventListener("click", (e) => {
        const p = new URLSearchParams();
        if (state.appFilter) p.set("job_id", state.appFilter);
        if (state.appStage) p.set("status", state.appStage);
        downloadAuthed(`/api/employer/applications.csv?${p}`, `bankjobz-applicants-${new Date().toISOString().slice(0, 10)}.csv`, e.target);
      });
      draw();
    }

    // ----- Talent pool -----
    function tabTalent(body) {
      body.innerHTML = `
        <p class="source-note">Candidates who opted in, shown anonymously — no names or contact details. Invite one to a posting and they get an email with your role; you only learn who they are if they apply. Included while you have a live posting.</p>
        <div class="filters talent-filters">
          <select id="t-cat" aria-label="Department"><option value="">Any department</option>${options(CATEGORIES, "")}</select>
          <input id="t-state" maxlength="2" placeholder="State, e.g. AL" aria-label="State" style="text-transform:uppercase">
          <select id="t-core" aria-label="Core system"><option value="">Any core system</option>${options(CORE_SYSTEMS, "")}</select>
          <select id="t-lic" aria-label="License"><option value="">Any license</option>${options(LICENSES, "")}</select>
          <button class="btn secondary" id="t-load" type="button">Browse candidates</button>
        </div>
        <div id="talent-list" class="talent-list"></div>`;
      document.getElementById("t-load").addEventListener("click", async () => {
        const list = document.getElementById("talent-list");
        list.innerHTML = `<p class="source-note">Looking through the pool…</p>`;
        const params = new URLSearchParams();
        const cat = document.getElementById("t-cat").value, st = document.getElementById("t-state").value.trim();
        const core = document.getElementById("t-core").value, lic = document.getElementById("t-lic").value;
        if (cat) params.set("category", cat);
        if (st) params.set("state", st);
        if (core) params.set("core_system", core);
        if (lic) params.set("license", lic);
        let r;
        try { r = await api("/api/employer/talent?" + params, { auth: true }); }
        catch (err) { list.innerHTML = `<p class="msg error">${esc(err.message)}</p>`; return; }
        if (!r.candidates.length) {
          list.innerHTML = `<p class="source-note">No candidates match those filters yet. The pool grows as job seekers opt in — try fewer filters or check back.</p>`;
          return;
        }
        list.innerHTML = r.candidates.map((c) => `
          <div class="talent-card">
            <div class="t-main">
              <b>${esc(c.location || "Location not given")}</b> · ${esc({ any: "Any arrangement", onsite: "On-site", hybrid: "Hybrid", remote: "Remote" }[c.work_mode_pref] || "")}${c.has_resume ? " · Résumé on file" : ""}
              <span class="tags">${(c.categories || []).map((k) => `<span class="tag">${esc(CATEGORIES[k] || k)}</span>`).join("")}
                ${(c.core_systems || []).map((k) => `<span class="tag direct">${esc(CORE_SYSTEMS[k] || k)}</span>`).join("")}
                ${(c.licenses || []).map((k) => `<span class="tag">${esc(LICENSES[k] || k)}</span>`).join("")}</span>
              ${c.summary ? `<p class="t-summary">${esc(c.summary)}</p>` : ""}
            </div>
            <div class="t-invite">
              <select data-tjob aria-label="Posting to invite them to">${r.jobs.map((j) => `<option value="${j.id}"${(c.invited_job_ids || []).includes(j.id) ? " disabled" : ""}>${esc(j.title)}</option>`).join("")}</select>
              <input data-tnote maxlength="200" placeholder="Optional note to the candidate">
              <button class="btn" data-invite="${c.id}" type="button">Invite to apply</button>
            </div>
          </div>`).join("");
        list.querySelectorAll("[data-invite]").forEach((b) => b.addEventListener("click", async () => {
          const card = b.closest(".talent-card");
          b.disabled = true;
          b.textContent = "Inviting…";
          try {
            const res = await api(`/api/employer/talent/${b.dataset.invite}/invite`, { method: "POST", auth: true,
              body: JSON.stringify({ job_id: card.querySelector("[data-tjob]").value, note: card.querySelector("[data-tnote]").value }) });
            card.querySelector(".t-invite").innerHTML = `<span class="status-pill">${res.duplicate ? "Already invited" : "Invited — they'll get an email"}</span>`;
          } catch (err) {
            b.disabled = false;
            b.textContent = "Invite to apply";
            say(err.message);
          }
        }));
      });
    }

    // ----- Account & security -----
    async function tabAccount(body) {
      body.innerHTML = `
        <div class="acct-grid">
          <form class="panel form" id="account-form" novalidate>
            <h2 class="dash-title">Your details</h2>
            <div class="row-2">
              <div class="field"><label for="ac-name">Your name</label><input id="ac-name" name="contact_name" value="${esc(d.account?.contact_name || "")}" required></div>
              <div class="field"><label for="ac-title">Your title</label><input id="ac-title" name="contact_title" value="${esc(d.account?.contact_title || "")}" placeholder="HR Manager"></div>
            </div>
            <div class="row-2">
              <div class="field"><label for="ac-company">Institution name</label><input id="ac-company" name="company" value="${esc(d.account?.company || d.company)}" required>
                <span class="hint">Applies to new postings; live ones keep the name they were posted under.</span></div>
              <div class="field"><label for="ac-type">Type</label><select id="ac-type" name="institution_type">${options(INST, d.account?.institution_type || "bank")}</select></div>
            </div>
            <div class="row-2">
              <div class="field"><label for="ac-phone">Phone (optional)</label><input id="ac-phone" name="phone" type="tel" value="${esc(d.account?.phone || "")}"></div>
              <div class="field"><label>Sign-in &amp; notification email</label><input value="${esc(d.email)}" disabled></div>
            </div>
            <div class="cta-row"><button class="btn secondary" type="submit">Save details</button></div>
            <div class="msg" id="account-msg" hidden></div>
          </form>
          <div id="security-box" class="panel"><p class="source-note">Loading security settings…</p></div>
        </div>`;
      document.getElementById("account-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = document.getElementById("account-msg");
        const data = Object.fromEntries(new FormData(e.currentTarget));
        if (!data.contact_name.trim() || !data.company.trim()) return showMsg(msg, "Your name and institution are required.", true);
        try {
          await api("/api/employer/account", { method: "PUT", auth: true, body: JSON.stringify(data) });
          Object.assign(d.account, data);
          showMsg(msg, "Details saved.", false);
        } catch (err) { showMsg(msg, err.message, true); }
      });
      await drawSecurity();
    }

    async function drawSecurity() {
      const box = document.getElementById("security-box");
      if (!box) return;
      let s;
      try { s = await api("/api/employer/security", { auth: true }); }
      catch (err) { if (err.status === 401) return signedOut(err.message); box.innerHTML = `<p class="msg error">${esc(err.message)}</p>`; return; }
      const app = s.mfa_method === "totp";
      const device = (ua) => {
        const u = String(ua || "");
        const browser = /Edg\//.test(u) ? "Edge" : /Chrome\//.test(u) ? "Chrome" : /Firefox\//.test(u) ? "Firefox" : /Safari\//.test(u) ? "Safari" : "Browser";
        const os = /iPhone|iPad/.test(u) ? "iPhone/iPad" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows" : /Mac OS X/.test(u) ? "Mac" : /Linux/.test(u) ? "Linux" : "device";
        return `${browser} on ${os}`;
      };
      box.innerHTML = `
        <h2 class="dash-title">Sign-in &amp; security</h2>
        <div class="sec-block">
          <h3>Second step at sign-in</h3>
          <p>${app ? `<span class="status-pill">Authenticator app</span> New devices ask for a code from your app. ${s.recovery_codes_left} recovery ${s.recovery_codes_left === 1 ? "code" : "codes"} left.`
            : `<span class="status-pill">Email code</span> New devices get a 6-digit code by email. An authenticator app (Microsoft or Google Authenticator) is stronger and works offline.`}</p>
          <div class="cta-row">${app
            ? `<button class="btn secondary" id="sec-newcodes" type="button">New recovery codes</button><button class="linkish danger" id="sec-totp-off" type="button">Turn off app, use email codes</button>`
            : `<button class="btn" id="sec-totp-on" type="button">Set up authenticator app</button>`}</div>
          <div id="sec-mfa-area"></div>
        </div>
        <div class="sec-block">
          <h3>Password</h3>
          <p class="source-note">${s.password_changed_at ? `Last changed ${esc(fmtDate(s.password_changed_at))}.` : ""} Changing it signs out your other devices.</p>
          <form class="form" id="sec-pw" novalidate>
            <div class="row-2">${pwField("a-curpw", "Current password", "current-password")}${pwField("a-nextpw", "New password", "new-password", "At least 10 characters.")}</div>
            <div class="cta-row"><button class="btn secondary" type="submit">Change password</button></div>
          </form>
        </div>
        <div class="sec-block">
          <h3>Where you're signed in</h3>
          <ul class="sessions">${s.sessions.map((x) => `<li>
            <span><b>${esc(device(x.user_agent))}</b>${x.current ? ' <span class="status-pill">This device</span>' : ""}<br>
            <span class="source-note">Signed in ${esc(fmtDate(x.created_at))} · last active ${esc(fmtDate(x.last_seen_at))}${x.ip ? ` · ${esc(x.ip)}` : ""}</span></span>
            ${x.current ? "" : `<button class="linkish danger" data-revoke="${x.id}" type="button">Sign out</button>`}</li>`).join("")}</ul>
          <div class="cta-row">
            ${s.sessions.length > 1 ? `<button class="btn secondary" id="sec-revoke-all" type="button">Sign out everywhere else</button>` : ""}
            ${s.trusted_devices ? `<button class="linkish" id="sec-forget" type="button">Forget ${s.trusted_devices} trusted ${s.trusted_devices === 1 ? "device" : "devices"} (ask for codes again)</button>` : ""}
          </div>
        </div>
        <div class="sec-block">
          <h3>Notifications</h3>
          <label class="check-line"><input type="checkbox" id="sec-notify"${s.notify_each_applicant ? " checked" : ""}> Email me each time someone applies</label>
          <p class="source-note">Off means applicants still arrive in your dashboard — you just won't get an email for each one.</p>
        </div>
        <div class="msg" id="sec-msg" hidden></div>`;
      const msg = () => document.getElementById("sec-msg");
      box.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
        const input = document.getElementById(b.dataset.toggle);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        b.textContent = show ? "Hide" : "Show";
      }));
      const askPassword = (area, label, onOk) => {
        area.innerHTML = `<form class="form inline-confirm" novalidate>${pwField("a-confirmpw", `Current password — ${label}`, "current-password")}
          <div class="cta-row"><button class="btn secondary" type="submit">Confirm</button><button class="linkish" type="button" data-cancel>Cancel</button></div></form>`;
        const f = area.querySelector("form");
        area.querySelector("[data-cancel]").addEventListener("click", () => (area.innerHTML = ""));
        area.querySelector("[data-toggle]").addEventListener("click", (e) => {
          const i = document.getElementById("a-confirmpw"); i.type = i.type === "password" ? "text" : "password";
          e.target.textContent = i.type === "password" ? "Show" : "Hide";
        });
        document.getElementById("a-confirmpw").focus();
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          try { await onOk(document.getElementById("a-confirmpw").value); }
          catch (err) { showMsg(msg(), err.message, true); }
        });
      };
      const showCodes = (area, codes) => {
        const text = `BankJobz recovery codes for ${d.email}\nEach works once, if you can't use your authenticator app.\n\n${codes.join("\n")}\n`;
        area.innerHTML = `<div class="codes-box">
          <p><b>Save these recovery codes now.</b> Each one works once if you lose your phone. They won't be shown again.</p>
          <ol class="codes">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join("")}</ol>
          <div class="cta-row"><button class="btn secondary" id="codes-dl" type="button">Download .txt</button><button class="linkish" id="codes-copy" type="button">Copy</button><button class="btn" id="codes-done" type="button">I've saved them</button></div></div>`;
        document.getElementById("codes-dl").addEventListener("click", () => {
          const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
          const a = Object.assign(document.createElement("a"), { href: url, download: "bankjobz-recovery-codes.txt" });
          document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
        document.getElementById("codes-copy").addEventListener("click", async (e) => {
          try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; } catch { e.target.textContent = "Select and copy the codes above"; }
        });
        document.getElementById("codes-done").addEventListener("click", () => drawSecurity());
      };
      const area = document.getElementById("sec-mfa-area");

      document.getElementById("sec-totp-on")?.addEventListener("click", () => askPassword(area, "to set up an authenticator app", async (pw) => {
          const r = await api("/api/employer/security/totp/start", { method: "POST", auth: true, body: JSON.stringify({ current_password: pw }) });
          area.innerHTML = `<div class="totp-setup">
            <div class="qr">${r.qr_svg}</div>
            <ol>
              <li>Open Microsoft Authenticator, Google Authenticator, 1Password or similar.</li>
              <li>Add an account and scan this QR code. Can't scan? Enter this key: <code class="secret">${esc(r.secret.match(/.{1,4}/g).join(" "))}</code></li>
              <li>Enter the 6-digit code it shows:</li>
            </ol>
            <form class="form" id="totp-confirm" novalidate>
              <div class="field"><label for="totp-code">Code from the app</label><input id="totp-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
              <div class="cta-row"><button class="btn" type="submit">Turn on</button><button class="linkish" type="button" id="totp-cancel">Cancel</button></div>
            </form></div>`;
          document.getElementById("totp-cancel").addEventListener("click", () => drawSecurity());
          document.getElementById("totp-code").focus();
          document.getElementById("totp-confirm").addEventListener("submit", async (ev) => {
            ev.preventDefault();
            try {
              const res = await api("/api/employer/security/totp/confirm", { method: "POST", auth: true,
                body: JSON.stringify({ code: document.getElementById("totp-code").value.trim() }) });
              d.account.mfa_method = "totp";
              const block = area.closest(".sec-block");
              block.querySelector("p").innerHTML = `<span class="status-pill">Authenticator app</span> Turned on. New devices will ask for a code from your app.`;
              block.querySelector(".cta-row").remove();
              showCodes(area, res.recovery_codes);
            } catch (err) { showMsg(msg(), err.message, true); }
          });
      }));
      document.getElementById("sec-newcodes")?.addEventListener("click", () => askPassword(area, "to make new recovery codes", async (pw) => {
        const r = await api("/api/employer/security/recovery-codes", { method: "POST", auth: true, body: JSON.stringify({ current_password: pw }) });
        showCodes(area, r.recovery_codes);
      }));
      document.getElementById("sec-totp-off")?.addEventListener("click", () => askPassword(area, "to turn off the app", async (pw) => {
        await api("/api/employer/security/totp/disable", { method: "POST", auth: true, body: JSON.stringify({ current_password: pw }) });
        d.account.mfa_method = "email";
        await drawSecurity();
        showMsg(msg(), "Authenticator turned off. Sign-in codes now come by email.", false);
      }));
      document.getElementById("sec-pw").addEventListener("submit", async (e) => {
        e.preventDefault();
        const cur = document.getElementById("a-curpw").value, next = document.getElementById("a-nextpw").value;
        if (!cur || next.length < 10) return showMsg(msg(), "Enter your current password and a new one of at least 10 characters.", true);
        try {
          await api("/api/employer/security/password", { method: "POST", auth: true, body: JSON.stringify({ current_password: cur, new_password: next }) });
          await drawSecurity();
          showMsg(msg(), "Password changed. Your other devices were signed out.", false);
        } catch (err) { showMsg(msg(), err.message, true); }
      });
      box.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
        try { await api(`/api/employer/security/sessions/${b.dataset.revoke}/revoke`, { method: "POST", auth: true }); await drawSecurity(); }
        catch (err) { showMsg(msg(), err.message, true); }
      }));
      document.getElementById("sec-revoke-all")?.addEventListener("click", async () => {
        try { await api("/api/employer/security/sessions/revoke-others", { method: "POST", auth: true }); await drawSecurity(); showMsg(msg(), "Signed out everywhere else.", false); }
        catch (err) { showMsg(msg(), err.message, true); }
      });
      document.getElementById("sec-forget")?.addEventListener("click", async () => {
        try {
          await api("/api/employer/security/devices/forget", { method: "POST", auth: true });
          store.del("bankjobz.device");
          await drawSecurity();
          showMsg(msg(), "Trusted devices forgotten. Each will ask for a code next sign-in.", false);
        } catch (err) { showMsg(msg(), err.message, true); }
      });
      document.getElementById("sec-notify").addEventListener("change", async (e) => {
        try {
          await api("/api/employer/security/notifications", { method: "POST", auth: true, body: JSON.stringify({ notify_each_applicant: e.target.checked }) });
          showMsg(msg(), e.target.checked ? "You'll get an email for each applicant." : "Applicant emails off. They'll still appear in your dashboard.", false);
        } catch (err) { e.target.checked = !e.target.checked; showMsg(msg(), err.message, true); }
      });
    }

    renderTab();
  }

  async function viewEdit(id) {
    if (!key()) return signedOut();
    view.innerHTML = `<div class="wrap narrow"><p>Loading the posting…</p></div>`;
    let j;
    try { j = await api(`/api/employer/jobs/${id}`, { auth: true }); }
    catch (err) { return err.status === 401 ? signedOut(err.message) : (view.innerHTML = `<div class="wrap narrow"><p class="msg error">${esc(err.message)}</p><a href="#dashboard">Back to dashboard</a></div>`); }
    view.innerHTML = `
      <div class="wrap narrow">
        <a class="back" href="#dashboard">← Dashboard</a>
        <form class="panel form" id="edit-form" novalidate style="margin-top:1rem">
          <h1 style="font-size:1.5rem">Edit posting</h1>
          <p class="source-note">${esc(j.company)} · ${jobCode(j.id)}. Changes show on the board right away; billing doesn't change.</p>
          ${roleFields(j, "e", aiDraftBox())}
          <div class="cta-row"><button class="btn" type="submit">Save changes</button><a class="btn secondary" href="#dashboard">Cancel</a></div>
          <div class="msg" id="edit-msg" hidden></div>
        </form>
      </div>`;
    bindAiDraft("e", () => ({ company: j.company, institution_type: j.institution_type }));
    document.getElementById("edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const efd = new FormData(form);
      const data = Object.fromEntries(efd);
      data.core_systems = efd.getAll("core_systems");
      data.licenses = efd.getAll("licenses");
      const msg = document.getElementById("edit-msg");
      if (!data.title.trim() || !data.location.trim() || !data.summary.trim()) return showMsg(msg, "Add a job title, location and summary.", true);
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api(`/api/employer/jobs/${j.id}`, { method: "PUT", auth: true, body: JSON.stringify(data) });
        await loadJobs();
        state.pendingFlash = ["Posting updated."];
        location.hash = "dashboard";
      } catch (err) { showMsg(msg, err.message, true); btn.disabled = false; }
    });
  }

  // ---------- admin (site owner) ----------
  async function viewAdmin() {
    if (!adminKey()) {
      view.innerHTML = `<div class="wrap narrow"><form class="panel form" id="admin-key-form" novalidate>
        <h1 style="font-size:1.5rem">Admin console</h1>
        <div class="field"><label for="ad-key">Admin key</label><input id="ad-key" type="password" autocomplete="off"><span class="hint">The ADMIN_TOKEN value from your Netlify environment variables.</span></div>
        <button class="btn" type="submit">Open console</button></form></div>`;
      document.getElementById("admin-key-form").addEventListener("submit", (e) => {
        e.preventDefault();
        store.set("bankstack.admin", document.getElementById("ad-key").value.trim());
        viewAdmin();
      });
      return;
    }
    view.innerHTML = `<div class="wrap dash"><p>Loading…</p></div>`;
    let d;
    try { d = await api("/api/admin", { admin: true }); }
    catch (err) {
      if (err.status === 401) store.del("bankstack.admin");
      view.innerHTML = `<div class="wrap narrow"><p class="msg error">${esc(err.message)}</p><a href="#admin" id="admin-retry">Try again</a></div>`;
      document.getElementById("admin-retry").addEventListener("click", (e) => { e.preventDefault(); viewAdmin(); });
      return;
    }
    view.innerHTML = `
      <div class="wrap dash">
        <div class="dash-head">
          <h1 style="font-size:1.8rem">Admin console</h1>
          <div class="cta-row">
            <button class="btn secondary" id="run-maint" type="button">Check links &amp; expire now</button>
            <button class="linkish" id="admin-out" type="button">Sign out</button>
          </div>
        </div>
        <p class="source-note" id="act-msg" aria-live="polite"></p>
        <div class="figures-grid admin-figures">
          <div><strong>${fmtMoney(d.mrr_cents)}</strong><span>monthly recurring revenue</span></div>
          <div><strong>${d.paid_live}</strong><span>paid postings live (${d.renewing} renewing)</span></div>
          <div><strong>${d.unpaid}</strong><span>started, not paid</span></div>
          <div><strong>${d.sourced_live}</strong><span>sourced listings live</span></div>
          <div><strong>${d.employer_count}</strong><span>paying employers</span></div>
          <div><strong>${d.applications_7d}</strong><span>applications this week (${d.applications} total)</span></div>
          <div><strong>${d.alert_subscribers}</strong><span>alert subscribers</span></div>
          <div><strong>${d.open_jobs}</strong><span>jobs on the board</span></div>
          <div><strong>${((d.directory?.banks || 0) + (d.directory?.credit_unions || 0)).toLocaleString()}</strong><span>institutions in the directory (${d.directory?.banks || 0} banks, ${d.directory?.credit_unions || 0} CUs)</span></div>
        </div>
        <div class="cta-row" style="margin:0.5rem 0 1rem">
          <button class="btn secondary" id="sync-dir" type="button">${(d.directory?.banks || 0) ? "Refresh" : "Load"} the institution directory (FDIC + NCUA)</button>
          <span class="source-note">Pulls every active US bank and credit union from public data. Takes a few minutes; leave the tab open.</span>
        </div>
        <section>
          <h2 class="dash-title">Listings</h2>
          <div class="table-wrap"><table class="stack-table">
            <thead><tr><th>Job</th><th>Type</th><th>Status</th><th style="text-align:right">Applicants</th><th>Expires</th><th></th></tr></thead>
            <tbody>${d.jobs.map((j) => `<tr>
              <td data-label="Job">${j.status === "open" ? `<a href="${jobHref(j.id)}">${esc(j.title)}</a>` : esc(j.title)}<br><span class="source-note">${esc(j.company)}</span></td>
              <td data-label="Type">${j.direct ? '<span class="tag direct">Paid</span>' : `<span class="source-note">${esc(j.source_name || "Sourced")}</span>`}</td>
              <td data-label="Status"><span class="status-pill${j.status === "open" ? "" : " bad"}">${esc(j.status)}${j.cancel_at_period_end ? " · ending" : ""}</span></td>
              <td data-label="Applicants" class="num">${j.applications}</td>
              <td data-label="Expires" class="num">${esc(fmtDate(j.expires_at))}</td>
              <td data-label="" class="acts">${j.status === "open" ? `<button class="linkish" data-admin="close" data-id="${j.id}" data-direct="${j.direct}" type="button">Take down</button>`
                : !j.direct ? `<button class="linkish" data-admin="reopen" data-id="${j.id}" type="button">Reopen</button>` : ""}</td></tr>`).join("")}</tbody>
          </table></div>
        </section>
        <div class="dash-grid">
          <form class="panel form" id="admin-add" novalidate>
            <h2>Add a sourced listing</h2>
            <p class="source-note">For a real opening you found elsewhere. It links to the original and stays up 30 days.</p>
            <div class="row-2">
              <div class="field"><label for="s-company">Employer</label><input id="s-company" name="company" required></div>
              <div class="field"><label for="s-type">Type</label><select id="s-type" name="institution_type">${options(INST, "bank")}</select></div>
            </div>
            <div class="row-2">
              <div class="field"><label for="s-url">Original posting link</label><input id="s-url" name="source_url" type="url" required placeholder="https://"><span class="hint">Must be the bank\'s own careers or ATS page (iCIMS, Workday, Paylocity, applytojob…). Links on third-party job boards are refused — they go stale, break for candidates, and their terms often forbid reuse.</span></div>
              <div class="field"><label for="s-src">Found on</label><input id="s-src" name="source_name" placeholder="Bank careers site"></div>
            </div>
            ${roleFields({}, "s")}
            <button class="btn" type="submit">Add listing</button>
            <div class="msg" id="add-msg" hidden></div>
          </form>
          <section class="panel">
            <h2>Employers</h2>
            <div class="table-wrap"><table class="stack-table">
              <thead><tr><th>Employer</th><th style="text-align:right">Live</th><th>Since</th></tr></thead>
              <tbody>${d.employers.length ? d.employers.map((e) => `<tr><td>${esc(e.company)}<br><span class="source-note">${esc(e.email)}</span></td><td class="num">${e.live_postings}</td><td class="num">${esc(fmtDate(e.created_at))}</td></tr>`).join("")
                : `<tr><td colspan="3" class="source-note">No paying employers yet.</td></tr>`}</tbody>
            </table></div>
          </section>
        </div>
      </div>`;

    const say = (t) => (document.getElementById("act-msg").textContent = t);
    document.getElementById("admin-out").addEventListener("click", () => { store.del("bankstack.admin"); location.hash = "home"; });
    document.getElementById("sync-dir").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const totals = {};
      for (const source of ["fdic", "ncua"]) {
        let offset = 0;
        totals[source] = 0;
        try {
          while (offset !== null) {
            say(`Syncing ${source.toUpperCase()}… ${totals[source].toLocaleString()} imported so far.`);
            const r = await api("/api/admin/institutions/sync", { method: "POST", admin: true, body: JSON.stringify({ source, offset }) });
            totals[source] += r.imported;
            offset = r.next_offset;
          }
        } catch (err) {
          say(`${source.toUpperCase()} sync stopped: ${err.message}. ${totals[source]} rows made it in — run it again to continue.`);
          e.target.disabled = false;
          return;
        }
      }
      await viewAdmin();
      document.getElementById("act-msg").textContent =
        `Directory synced: ${totals.fdic.toLocaleString()} banks and ${totals.ncua.toLocaleString()} credit unions imported or refreshed.`;
    });
    document.getElementById("run-maint").addEventListener("click", async (e) => {
      e.target.disabled = true; say("Checking listings. This can take up to a minute…");
      try {
        const r = await api("/api/admin/maintenance", { method: "POST", admin: true });
        await loadJobs(); await viewAdmin();
        say(`Checked ${r.checked} sourced links: closed ${r.closed.length} dead, ${r.expired} expired.`);
      } catch (err) { say(err.message); e.target.disabled = false; }
    });
    view.querySelectorAll("[data-admin]").forEach((b) => {
      let armed = false;
      b.addEventListener("click", async () => {
        if (b.dataset.admin === "close" && !armed) {
          armed = true;
          b.textContent = b.dataset.direct === "true" ? "Confirm: take down and cancel billing" : "Confirm take down";
          return;
        }
        b.disabled = true;
        try { await api(`/api/admin/jobs/${b.dataset.id}/${b.dataset.admin}`, { method: "POST", admin: true }); await loadJobs(); viewAdmin(); }
        catch (err) { say(err.message); b.disabled = false; }
      });
    });
    document.getElementById("admin-add").addEventListener("submit", async (e) => {
      e.preventDefault();
      const afd = new FormData(e.currentTarget);
      const data = Object.fromEntries(afd);
      data.core_systems = afd.getAll("core_systems");
      data.licenses = afd.getAll("licenses");
      const msg = document.getElementById("add-msg");
      try {
        await api("/api/admin/jobs", { method: "POST", admin: true, body: JSON.stringify(data) });
        await loadJobs(); await viewAdmin();
        say(`Added "${data.title}".`);
      } catch (err) { showMsg(msg, err.message, true); }
    });
  }


  // ---------- candidate profile, matches, saved jobs and quick apply ----------
  function profileTabs(active) {
    return `<nav class="profile-tabs" aria-label="Your profile">
      ${[["profile", "Profile"], ["matches", "Matches"], ["saved", "Saved jobs"], ["applications", "Applications"]]
        .map(([k, v]) => `<a href="#${k}"${k === active ? ' aria-current="page"' : ""}>${v}</a>`).join("")}
    </nav>`;
  }

  async function toggleSave(jobId, wantSaved) {
    return api("/api/candidate/save", { method: "POST", cauth: true, body: JSON.stringify({ job_id: jobId, saved: wantSaved }) });
  }

  function candidateSignedOut(message) {
    view.innerHTML = `
      <div class="wrap post">
        <section class="post-intro">
          <p class="eyebrow">For job seekers</p>
          <h1>One profile. Every bank job, ranked for you.</h1>
          <p class="lede">Create a free profile and upload your résumé. We rank every opening at banks and credit unions by how well it fits your experience, and you apply to any of them in one click.</p>
          ${message ? `<p class="msg error">${esc(message)}</p>` : ""}
        </section>
        <form class="panel form" id="cstart-form" novalidate>
          <h2>Create your profile or sign in</h2>
          <div class="field"><label for="cs-name">Full name</label><input id="cs-name" name="name" autocomplete="name"></div>
          <div class="field"><label for="cs-email">Email</label><input id="cs-email" name="email" type="email" autocomplete="email" required><span class="hint">We email you a sign-in link. No password to remember.</span></div>
          ${honeypot}
          <button class="btn" type="submit">Email me a sign-in link</button>
          <div class="msg" id="cs-msg" hidden></div>
        </form>
      </div>`;
    document.getElementById("cstart-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("cs-msg");
      const fd = new FormData(e.currentTarget);
      const email = String(fd.get("email") || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return showMsg(msg, "Enter a valid email address.", true);
      if (state.demo) return showMsg(msg, "Preview mode: on the live site this emails you a sign-in link.", false);
      try {
        await api("/api/candidate-auth/request", { method: "POST", body: JSON.stringify({ email, name: fd.get("name"), company_website: fd.get("company_website") }) });
        showMsg(msg, `Check ${email} for your sign-in link. It works for 30 minutes.`, false);
      } catch (err) { showMsg(msg, err.message, true); }
    });
  }

  function candidateExpired(err) {
    store.del("bankjobz.ck");
    candidateSignedOut(err && err.status === 401 ? "Your sign-in expired. Enter your email for a new link." : err?.message);
  }

  async function viewProfile() {
    if (!ckey()) return candidateSignedOut();
    view.innerHTML = `<div class="wrap narrow"><p>Loading your profile…</p></div>`;
    let d;
    try { d = await api("/api/candidate", { cauth: true }); }
    catch (err) { return candidateExpired(err); }
    const me = d.candidate;
    view.innerHTML = `
      <div class="wrap">${profileTabs("profile")}</div>
      <div class="wrap post">
        <section class="post-intro">
          <p class="eyebrow">Your profile</p>
          <h1>${esc(me.name || "Welcome")}</h1>
          <p class="lede">The more your profile says, the sharper your matches. Your résumé stays private: a bank only sees it when you apply.</p>
          <div class="cta-row"><a class="btn" href="#matches">See my matches</a><button class="linkish" id="c-signout" type="button">Sign out</button></div>
          <p class="source-note">${d.applications.length ? `You've applied to ${d.applications.length} ${d.applications.length === 1 ? "job" : "jobs"} — see <a href="#applications">Applications</a>.` : ""}
          ${d.saved.length ? ` ${d.saved.length} saved ${d.saved.length === 1 ? "job" : "jobs"} under <a href="#saved">Saved jobs</a>.` : ""}</p>
        </section>
        <form class="panel form" id="profile-form" novalidate>
          <h2>About you</h2>
          <div class="row-2">
            <div class="field"><label for="pr-name">Full name</label><input id="pr-name" name="name" autocomplete="name" value="${esc(me.name || "")}" required></div>
            <div class="field"><label for="pr-phone">Phone (optional)</label><input id="pr-phone" name="phone" type="tel" autocomplete="tel" value="${esc(me.phone || "")}"></div>
          </div>
          <div class="row-2">
            <div class="field"><label for="pr-location">City &amp; state</label><input id="pr-location" name="location" placeholder="Florence, AL" value="${esc(me.location || "")}"></div>
            <div class="field"><label for="pr-mode">Work preference</label><select id="pr-mode" name="work_mode_pref">${options({ any: "Anything", onsite: "On-site", hybrid: "Hybrid", remote: "Remote" }, me.work_mode_pref || "any")}</select></div>
          </div>
          <div class="field"><label for="pr-linkedin">LinkedIn (optional)</label><input id="pr-linkedin" name="linkedin_url" type="url" placeholder="https://linkedin.com/in/…" value="${esc(me.linkedin_url || "")}"></div>
          <div class="field"><label>Departments you'd work in</label>
            <div class="chip-set">${Object.entries(CATEGORIES).map(([k, v]) => `<label class="chip-check"><input type="checkbox" name="categories" value="${k}"${(me.categories || []).includes(k) ? " checked" : ""}><span>${esc(v)}</span></label>`).join("")}</div>
          </div>
          <div class="field"><label>Core banking systems you've worked on</label>
            <div class="chip-set">${chipChecks("core_systems", CORE_SYSTEMS, me.core_systems)}</div>
            <span class="hint">Experience on an employer's exact core is one of the strongest signals in banking. Uploading a résumé ticks these automatically when we spot them.</span></div>
          <div class="field"><label>Licenses &amp; certifications you hold</label>
            <div class="chip-set">${chipChecks("licenses", LICENSES, me.licenses)}</div></div>
          <div class="field"><label for="pr-summary">Experience in your own words (optional)</label><textarea id="pr-summary" name="summary" rows="4" placeholder="15 years in consumer lending; NMLS; led a team of six processors…">${esc(me.summary || "")}</textarea><span class="hint">Used for matching alongside your résumé${me.pool_visible ? ", and shown on your anonymous talent-pool card" : ""}.</span></div>
          <h2>Talent pool</h2>
          <p class="source-note">Opt in and hiring banks see an anonymous card: departments, systems, licenses, location and your summary — never your name, contact details or résumé. If a role fits, they invite you by email and you decide whether to respond.</p>
          <label class="chip-check"><input type="checkbox" name="pool_visible"${me.pool_visible ? " checked" : ""}><span>Show me in the talent pool, anonymously</span></label>
          <div class="field" style="margin-top:0.6rem"><label for="pr-blocked">Hide me from these employers (optional)</label><input id="pr-blocked" name="blocked_employers" placeholder="Your current employer's name — separate several with commas" value="${esc(me.blocked_employers || "")}"><span class="hint">Institutions named here never see your card and can't invite you. Job-hunting quietly? Put your employer here.</span></div>
          <h2>Résumé</h2>
          ${me.resume_name
            ? `<p class="source-note">On file: <b>${esc(me.resume_name)}</b>${me.resume_size ? ` (${fmtSize(me.resume_size)})` : ""}.${me.text_ok ? "" : " We couldn't read text from this file, so matches lean on your profile details."} Choose a new file to replace it.</p>`
            : `<p class="source-note">No résumé yet. Matching works best once one is on file.</p>`}
          <div class="field"><label for="pr-file">Résumé file</label><input id="pr-file" name="resume" type="file" accept=".pdf,.doc,.docx"><span class="hint">PDF or Word, up to 5 MB.</span></div>
          <button class="btn" type="submit">Save profile</button>
          <div class="msg" id="pr-msg" hidden></div>
        </form>
      </div>`;
    document.getElementById("c-signout").addEventListener("click", () => { store.del("bankjobz.ck"); location.hash = "home"; });
    document.getElementById("profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const msg = document.getElementById("pr-msg");
      const fd = new FormData(formEl);
      if (!String(fd.get("name")).trim()) return showMsg(msg, "Enter your name.", true);
      const file = fd.get("resume");
      if (file && file.size > 5 * 1024 * 1024) return showMsg(msg, "Résumés can be up to 5 MB.", true);
      if (file && file.size && !/\.(pdf|docx?)$/i.test(file.name)) return showMsg(msg, "Upload your résumé as a PDF or Word document.", true);
      const btn = formEl.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/candidate", { method: "PUT", cauth: true, body: JSON.stringify({
          name: fd.get("name"), phone: fd.get("phone"), location: fd.get("location"),
          work_mode_pref: fd.get("work_mode_pref"), linkedin_url: fd.get("linkedin_url"),
          summary: fd.get("summary"), categories: fd.getAll("categories"),
          core_systems: fd.getAll("core_systems"), licenses: fd.getAll("licenses"),
          pool_visible: !!fd.get("pool_visible"), blocked_employers: fd.get("blocked_employers") }) });
        let note = "Profile saved.";
        if (file && file.size) {
          const rf = new FormData();
          rf.append("resume", file);
          const r = await api("/api/candidate/resume", { method: "POST", cauth: true, body: rf });
          note = r.text_extracted ? "Profile and résumé saved." : "Saved. We couldn't read text from that file, so matches lean on your profile details.";
          const found = [...(r.detected?.core_systems || []).map((s) => CORE_SYSTEMS[s]), ...(r.detected?.licenses || []).map((l) => LICENSES[l])].filter(Boolean);
          if (found.length && !fd.getAll("core_systems").length && !fd.getAll("licenses").length) {
            note += ` We spotted ${found.slice(0, 4).join(", ")} in your résumé and added ${found.length === 1 ? "it" : "them"} to your profile.`;
          }
        }
        state.pendingFlash = [note + " Here are your matches."];
        location.hash = "matches";
      } catch (err) { showMsg(msg, err.message, true); btn.disabled = false; }
    });
  }

  async function viewMatches() {
    if (!ckey()) return candidateSignedOut();
    if (state.demo) {
      view.innerHTML = `<div class="wrap narrow"><p class="msg">Preview mode: matching runs once the site is deployed with its database.</p></div>`;
      return;
    }
    view.innerHTML = `<div class="wrap narrow"><p>Ranking every open job against your profile…</p></div>`;
    let d;
    try { d = await api("/api/candidate/matches", { cauth: true }); }
    catch (err) { return candidateExpired(err); }
    const TIER = { strong: "Strong match", good: "Good match", possible: "Worth a look" };
    view.innerHTML = `
      <div class="wrap">${profileTabs("matches")}</div>
      <div class="wrap dash">
        <div class="dash-head">
          <div style="display:grid;gap:0.3rem">
            <h1 style="font-size:1.8rem">Your matches</h1>
            <span class="source-note">${d.matches.length} open ${d.matches.length === 1 ? "job" : "jobs"}, ranked against ${d.basis === "resume" ? "your résumé and profile" : "your profile"}.${d.basis === "resume" ? "" : ` <a href="#profile">Upload a résumé</a> for sharper rankings.`}</span>
          </div>
          <div class="cta-row"><a class="btn secondary" href="#profile">Edit profile</a></div>
        </div>
        <p class="source-note" id="act-msg" aria-live="polite"></p>
        <ul class="ledger match-list">
          ${d.matches.map((m) => `<li class="match-row${m.applied ? " is-applied" : ""}">
            <div class="match-score tier-${m.tier}"><b>${m.score}</b><span>${TIER[m.tier] || ""}</span></div>
            <div class="job-main">
              <a class="job-title" href="${jobHref(m.id)}">${esc(m.title)}</a>
              <span class="job-meta">${esc(m.company)} · ${esc(m.location)}${salary(m) ? " · " + esc(salary(m)) : ""}</span>
              <span class="tags">${m.direct ? '<span class="tag direct">Direct</span>' : ""}<span class="tag">${esc(CATEGORIES[m.category] || m.category)}</span><span class="tag">${esc(MODES[m.work_mode] || m.work_mode)}</span></span>
              ${m.reasons.length ? `<span class="source-note">${esc(m.reasons.join(" · "))}</span>` : ""}
            </div>
            <div class="match-act">${m.applied ? `<span class="status-pill">Applied</span>` : m.direct ? `<button class="btn" data-qa="${m.id}" type="button">Quick apply</button>` : `<a class="btn secondary" href="${jobHref(m.id)}">View &amp; apply</a>`}
              <button class="linkish save-link" data-save="${m.id}" data-on="${m.saved ? 1 : 0}" type="button">${m.saved ? "★ Saved" : "☆ Save"}</button></div>
          </li>`).join("")}
        </ul>
      </div>`;
    view.querySelectorAll("[data-qa]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "Applying…";
      try {
        const r = await api("/api/candidate/apply", { method: "POST", cauth: true, body: JSON.stringify({ job_id: b.dataset.qa }) });
        b.closest(".match-act").innerHTML = `<span class="status-pill">Applied</span>`;
        document.getElementById("act-msg").textContent = r.duplicate
          ? "You had already applied to that one."
          : "Application sent with your résumé attached. The bank also gets it by email.";
      } catch (err) {
        b.disabled = false;
        b.textContent = "Quick apply";
        document.getElementById("act-msg").textContent = err.message;
      }
    }));
    view.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
      const want = b.dataset.on !== "1";
      b.disabled = true;
      try {
        await toggleSave(b.dataset.save, want);
        b.dataset.on = want ? "1" : "0";
        b.textContent = want ? "★ Saved" : "☆ Save";
      } catch (err) { document.getElementById("act-msg").textContent = err.message; }
      b.disabled = false;
    }));
  }

  async function viewSaved() {
    if (!ckey()) return candidateSignedOut();
    if (state.demo) {
      view.innerHTML = `<div class="wrap narrow"><p class="msg">Preview mode: saved jobs work once the site is deployed with its database.</p></div>`;
      return;
    }
    view.innerHTML = `<div class="wrap narrow"><p>Loading your saved jobs…</p></div>`;
    let d;
    try { d = await api("/api/candidate", { cauth: true }); }
    catch (err) { return candidateExpired(err); }
    const appliedIds = new Set(d.applications.map((a) => String(a.job_id)));
    view.innerHTML = `
      <div class="wrap">${profileTabs("saved")}</div>
      <div class="wrap dash">
        <div class="dash-head">
          <div style="display:grid;gap:0.3rem">
            <h1 style="font-size:1.8rem">Saved jobs</h1>
            <span class="source-note">${d.saved.length ? `${d.saved.length} ${d.saved.length === 1 ? "job" : "jobs"} you've bookmarked. Closed roles stay here until you remove them.` : ""}</span>
          </div>
        </div>
        <p class="source-note" id="act-msg" aria-live="polite"></p>
        ${d.saved.length ? `<ul class="ledger match-list">
          ${d.saved.map((s) => `<li class="match-row${s.open ? "" : " is-closed"}">
            <div class="job-main">
              ${s.open ? `<a class="job-title" href="${jobHref(s.job_id)}">${esc(s.title)}</a>` : `<span class="job-title">${esc(s.title)}</span>`}
              <span class="job-meta">${esc(s.company)} · ${esc(s.location)}${salary(s) ? " · " + esc(salary(s)) : ""}</span>
              <span class="tags">${s.direct ? '<span class="tag direct">Direct</span>' : ""}<span class="tag">${esc(CATEGORIES[s.category] || s.category)}</span><span class="tag">${esc(MODES[s.work_mode] || s.work_mode)}</span>${s.open ? "" : '<span class="tag">No longer open</span>'}</span>
              <span class="source-note">Saved ${esc(fmtDate(s.saved_at))}</span>
            </div>
            <div class="match-act">
              ${appliedIds.has(String(s.job_id)) ? `<span class="status-pill">Applied</span>` : s.open ? `<a class="btn secondary" href="${jobHref(s.job_id)}">View &amp; apply</a>` : ""}
              <button class="linkish save-link" data-unsave="${s.job_id}" type="button">Remove</button>
            </div>
          </li>`).join("")}
        </ul>`
        : `<div class="panel"><p>Nothing saved yet. On any job page, or next to a match, use <b>☆ Save</b> to keep a role here while you decide.</p>
           <div class="cta-row"><a class="btn" href="#matches">See my matches</a><a class="btn secondary" href="#jobs">Browse all positions</a></div></div>`}
      </div>`;
    view.querySelectorAll("[data-unsave]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await toggleSave(b.dataset.unsave, false); b.closest("li").remove(); }
      catch (err) { document.getElementById("act-msg").textContent = err.message; b.disabled = false; }
    }));
  }

  async function viewApplications() {
    if (!ckey()) return candidateSignedOut();
    if (state.demo) {
      view.innerHTML = `<div class="wrap narrow"><p class="msg">Preview mode: applications work once the site is deployed with its database.</p></div>`;
      return;
    }
    view.innerHTML = `<div class="wrap narrow"><p>Loading your applications…</p></div>`;
    let d;
    try { d = await api("/api/candidate", { cauth: true }); }
    catch (err) { return candidateExpired(err); }
    view.innerHTML = `
      <div class="wrap">${profileTabs("applications")}</div>
      <div class="wrap dash">
        <div class="dash-head">
          <div style="display:grid;gap:0.3rem">
            <h1 style="font-size:1.8rem">Your applications</h1>
            <span class="source-note">${d.applications.length ? `${d.applications.length} ${d.applications.length === 1 ? "application" : "applications"}. The hiring team contacts you directly if they'd like to talk.` : ""}</span>
          </div>
        </div>
        ${d.invites.length ? `<section style="margin-bottom:1.5rem">
          <h2 class="dash-title">Invites from banks</h2>
          <p class="source-note">These employers saw your anonymous talent-pool card and asked you to apply. They haven't seen your name or contact details.</p>
          <div class="table-wrap"><table class="stack-table">
            <thead><tr><th>Job</th><th>Employer</th><th>Received</th><th></th></tr></thead>
            <tbody>${d.invites.map((v) => `<tr>
              <td data-label="Job">${v.open ? `<a href="${jobHref(v.job_id)}">${esc(v.job_title)}</a>` : esc(v.job_title)}${v.note ? `<details><summary>Their note</summary><p class="prose">${esc(v.note)}</p></details>` : ""}</td>
              <td data-label="Employer">${esc(v.company)}</td>
              <td data-label="Received" class="num">${esc(fmtDate(v.created_at))}</td>
              <td data-label="" class="acts">${v.open ? `<a href="${jobHref(v.job_id)}">View &amp; apply</a>` : '<span class="source-note">Closed</span>'}</td>
            </tr>`).join("")}</tbody>
          </table></div>
        </section>` : ""}
        ${d.applications.length ? `<div class="table-wrap"><table class="stack-table">
          <thead><tr><th>Job</th><th>Employer</th><th>Applied</th><th>Posting</th></tr></thead>
          <tbody>${d.applications.map((a) => `<tr>
            <td data-label="Job">${a.status === "open" ? `<a href="${jobHref(a.job_id)}">${esc(a.job_title)}</a>` : esc(a.job_title)}</td>
            <td data-label="Employer">${esc(a.company)}</td>
            <td data-label="Applied" class="num">${esc(fmtDate(a.created_at))}</td>
            <td data-label="Posting"><span class="status-pill${a.status === "open" ? "" : " bad"}">${a.status === "open" ? "Still open" : "Closed"}</span></td>
          </tr>`).join("")}</tbody>
        </table></div>`
        : `<div class="panel"><p>No applications yet. Your matches are ranked by how well each role fits your résumé — a good place to start.</p>
           <div class="cta-row"><a class="btn" href="#matches">See my matches</a><a class="btn secondary" href="#jobs">Browse all positions</a></div></div>`}
      </div>`;
  }

  // On a job page: wires the Save button and, for Direct roles, the one-click apply box.
  async function initCandidateBits(j) {
    const saveBtn = document.getElementById("save-job");
    if (state.demo) {
      if (saveBtn) saveBtn.addEventListener("click", () => flash("Preview mode: saving jobs works on the live site."));
      return;
    }
    if (!ckey()) {
      if (saveBtn) saveBtn.addEventListener("click", () => {
        state.pendingFlash = ["Create a free profile to save jobs and apply in one click."];
        location.hash = "profile";
      });
      return;
    }
    let d;
    try { d = await api("/api/candidate", { cauth: true }); } catch { return; }
    if (saveBtn) {
      let on = d.saved.some((s) => String(s.job_id) === String(j.id));
      const paint = () => (saveBtn.textContent = on ? "★ Saved" : "☆ Save job");
      paint();
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        try { await toggleSave(j.id, !on); on = !on; paint(); }
        catch (err) { flash(err.message, true); }
        saveBtn.disabled = false;
      });
    }
    maybeQuickApply(j, d);
  }

  function maybeQuickApply(j, d) {
    const slot = document.getElementById("qa-slot");
    if (!slot || !j.direct || j.apply_url || !d) return;
    const me = d.candidate;
    const prior = d.applications.find((a) => String(a.job_id) === String(j.id));
    if (prior) {
      slot.innerHTML = `<p class="msg">You applied to this role on ${esc(fmtDate(prior.created_at))}.</p>`;
      return;
    }
    if (!me.resume_name) {
      slot.innerHTML = `<p class="source-note">Signed in as ${esc(me.name || me.email)}. <a href="#profile">Add a résumé</a> to apply in one click.</p>`;
      return;
    }
    const canTailor = state.ai && (me.text_ok || me.summary);
    slot.innerHTML = `
      <div class="qa-box">
        <button class="btn" id="qa-btn" type="button">Quick apply as ${esc(me.name || me.email)}</button>
        ${canTailor ? `<button class="btn secondary" id="qa-tailor" type="button">✨ Tailor my application</button>` : ""}
        <span class="hint">Sends your profile and ${esc(me.resume_name)}. Or use the form below.</span>
      </div>`;
    const tailorBtn = document.getElementById("qa-tailor");
    if (tailorBtn) tailorBtn.addEventListener("click", async () => {
      tailorBtn.disabled = true;
      tailorBtn.textContent = "Writing from your résumé…";
      try {
        const r = await api("/api/ai/apply-assist", { method: "POST", cauth: true, body: JSON.stringify({ job_id: j.id }) });
        slot.innerHTML = `
          <div class="qa-box">
            <label class="hint" for="qa-note"><b>Your tailored note</b> — written only from what's in your résumé. Edit anything before sending.</label>
            <textarea id="qa-note" rows="8" maxlength="4000">${esc(r.cover_note)}</textarea>
            ${r.tips.length ? `<div class="ai-tips"><b>Angle your résumé for this one:</b><ul>${r.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
            <button class="btn" id="qa-send" type="button">Send application with this note</button>
            <span class="hint">Sends your profile, ${esc(me.resume_name)} and the note above.</span>
          </div>`;
        document.getElementById("qa-send").addEventListener("click", async (e2) => {
          e2.target.disabled = true;
          e2.target.textContent = "Sending…";
          try {
            await api("/api/candidate/apply", { method: "POST", cauth: true, body: JSON.stringify({
              job_id: j.id, cover_note: document.getElementById("qa-note").value }) });
            document.querySelector(".detail .panel").innerHTML =
              `<h2>Apply for this role</h2><p class="msg">Application sent to ${esc(j.company)} with your résumé and note. A confirmation is on its way to your inbox.</p>`;
          } catch (err) {
            e2.target.disabled = false;
            e2.target.textContent = "Send application with this note";
            flash(err.message, true);
          }
        });
      } catch (err) {
        tailorBtn.disabled = false;
        tailorBtn.textContent = "✨ Tailor my application";
        flash(err.message, true);
      }
    });
    document.getElementById("qa-btn").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Applying…";
      try {
        await api("/api/candidate/apply", { method: "POST", cauth: true, body: JSON.stringify({ job_id: j.id }) });
        document.querySelector(".detail .panel").innerHTML =
          `<h2>Apply for this role</h2><p class="msg">Application sent to ${esc(j.company)} with your résumé. A confirmation is on its way to your inbox.</p>`;
      } catch (err) {
        slot.insertAdjacentHTML("beforeend", `<p class="msg error">${esc(err.message)}</p>`);
        e.target.disabled = false;
        e.target.textContent = "Quick apply as " + (me.name || me.email);
      }
    });
  }

  // ---------- router ----------
  function updateNav() {
    // Always visible: signed-in employers see their Dashboard; everyone else gets a clear way back in.
    document.getElementById("nav-dashboard").textContent = key() ? "Dashboard" : "Employer sign in";
  }

  function route() {
    document.getElementById("flash").hidden = true;
    if (state.pendingFlash) { const [t, bad] = state.pendingFlash; state.pendingFlash = null; setTimeout(() => flash(t, bad), 0); }
    // A real /jobs/123 URL (served by the job page function) shows that job until another view is picked.
    const pathJob = location.pathname.match(/^\/jobs\/(\d+)\/?$/);
    // An email button pasted into a tab that's already open arrives as a hash change.
    const linkInHash = location.hash.match(/^#auth=(bsl_[0-9a-f]{48})$/)?.[1];
    if (linkInHash) { state.authLink = { link: linkInHash }; history.replaceState(null, "", location.pathname + "#email-link"); }
    let h = location.hash.replace(/^#/, "");
    if (pathJob && h) history.replaceState(null, "", "/#" + h);
    if (!h) h = pathJob ? `job-${pathJob[1]}` : "home";
    if (h === "employers") h = "post";
    const section = h.startsWith("job-") ? "jobs" : h.startsWith("edit-") ? "dashboard"
      : ["matches", "saved", "applications"].includes(h) ? "profile" : h;
    document.querySelectorAll("[data-nav]").forEach((a) => {
      if (a.dataset.nav === section) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    updateNav();
    if (h.startsWith("job-")) viewJob(h.slice(4));
    else if (h.startsWith("edit-")) viewEdit(h.slice(5));
    else if (h === "jobs") viewJobs();
    else if (h === "post") viewPost();
    else if (h === "welcome") viewWelcome();
    else if (h === "email-link") viewEmailLink();
    else if (h === "dashboard") viewDashboard();
    else if (h === "profile") viewProfile();
    else if (h === "matches") viewMatches();
    else if (h === "saved") viewSaved();
    else if (h === "applications") viewApplications();
    else if (h === "admin") viewAdmin();
    else viewHome();
    window.scrollTo(0, 0);
  }

  // Links that arrive by email: ?clogin= (candidate sign-in) and ?alerts= (job alert confirm/unsubscribe).
  // Employers sign in with a password and a code, so an old emailed ?login= link just opens the sign-in page.
  async function handleEmailLinks() {
    const params = new URLSearchParams(location.search);
    const login = params.get("login");
    const clogin = params.get("clogin");
    const alerts = params.get("alerts");
    // The button in a sign-in email: #auth=<secret>. (In the #fragment, so it never reaches a server log.)
    const authLink = location.hash.match(/^#auth=(bsl_[0-9a-f]{48})$/)?.[1];
    if (authLink) {
      // Kept in memory only; the secret leaves the address bar (and history) right away.
      state.authLink = { link: authLink };
      history.replaceState(null, "", location.pathname + "#email-link");
      return;
    }
    if (!login && !clogin && !alerts) return;
    history.replaceState(null, "", location.pathname + location.hash);
    if (login) {
      if (!location.hash) history.replaceState(null, "", location.pathname + "#dashboard");
      state.pendingFlash = ["Sign-in links have been replaced by your email and password. If you haven't set a password yet, choose \u201cForgot or set password.\u201d"];
    }
    if (clogin) {
      try {
        const r = await api("/api/candidate-auth/verify", { method: "POST", body: JSON.stringify({ token: clogin }) });
        store.set("bankjobz.ck", r.token);
        if (!location.hash) history.replaceState(null, "", location.pathname + "#profile");
        state.pendingFlash = [`Signed in${r.name ? " as " + r.name : ""}.${r.has_resume ? "" : " Add your résumé to unlock ranked matches."}`];
      } catch (err) { state.pendingFlash = [err.message, true]; }
    }
    if (alerts) {
      const text = { confirmed: "You're subscribed. New roles will arrive weekly.", unsubscribed: "You're unsubscribed from job alerts.", invalid: "That alert link isn't valid anymore." }[alerts];
      if (text) state.pendingFlash = [text, alerts === "invalid"];
    }
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => {
    const c = document.getElementById("guilloche");
    if (!c) return;
    if (c.closest(".home-hero")) drawGuilloche(c, { x: 0.86, scale: 0.7, max: 300, alpha: 0.11 });
    else drawGuilloche(c);
  });
  Promise.all([loadJobs(), handleEmailLinks()]).then(route);
})();
