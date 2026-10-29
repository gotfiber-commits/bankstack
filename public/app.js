(() => {
  "use strict";

  // Display only. Stripe charges whatever STRIPE_PRICE_ID is set to ($99/month recurring).
  const PRICE = "$99";

  const CATEGORIES = {
    "data-engineering": "Data engineering",
    "software": "Software",
    "analytics": "Analytics & BI",
    "architecture": "Data architecture",
    "security": "Security",
    "risk-tech": "Tech risk",
  };
  const CATEGORY_BLURB = {
    "data-engineering": "Pipelines, warehouses and lakehouses that feed regulatory and customer reporting.",
    "software": "Digital banking, payments, trading and integration platforms.",
    "analytics": "BI, dashboards and customer insight for lines of business.",
    "architecture": "Enterprise data models, core-system integration and governance.",
    "security": "Data loss prevention, identity and cyber defense.",
    "risk-tech": "Technology and data risk, controls and exam readiness.",
  };
  const MODES = { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" };
  const EMPLOYMENT = { "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", internship: "Internship" };
  const INST = { bank: "Bank", "credit-union": "Credit union", fintech: "Fintech", other: "Other" };
  const STAGES = { new: "New", reviewing: "Reviewing", interview: "Interview", offer: "Offer", hired: "Hired", rejected: "Not a fit" };

  const state = { jobs: [], demo: false, filters: { q: "", category: "", institution_type: "", work_mode: "" }, appFilter: "" };
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

  async function api(path, opts = {}) {
    const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
    const headers = { ...(isForm ? {} : { "content-type": "application/json" }), ...(opts.headers || {}) };
    if (opts.auth && key()) headers.authorization = "Bearer " + key();
    if (opts.admin && adminKey()) headers.authorization = "Bearer " + adminKey();
    const res = await fetch(path, { ...opts, headers });
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) throw new Error("The server isn't reachable right now.");
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
      state.demo = false;
    } catch {
      const res = await fetch("seed-jobs.json");
      const seed = await res.json();
      state.jobs = seed.map((j, i) => ({ ...j, id: i + 1, apply_url: j.source_url, direct: false }));
      state.demo = true;
    }
    document.getElementById("demo-banner").hidden = !state.demo;
  }

  function filtered() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    return state.jobs.filter((j) =>
      (!f.category || j.category === f.category) &&
      (!f.institution_type || j.institution_type === f.institution_type) &&
      (!f.work_mode || j.work_mode === f.work_mode) &&
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
  function roleFields(j = {}, prefix = "p") {
    return `
      <div class="field"><label for="${prefix}-title">Job title</label><input id="${prefix}-title" name="title" required placeholder="Senior Data Engineer" value="${esc(j.title)}"></div>
      <div class="row-2">
        <div class="field"><label for="${prefix}-location">Location</label><input id="${prefix}-location" name="location" required placeholder="Birmingham, AL" value="${esc(j.location)}"></div>
        <div class="field"><label for="${prefix}-mode">Arrangement</label><select id="${prefix}-mode" name="work_mode">${options(MODES, j.work_mode)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label for="${prefix}-cat">Specialty</label><select id="${prefix}-cat" name="category">${options(CATEGORIES, j.category)}</select></div>
        <div class="field"><label for="${prefix}-emp">Employment</label><select id="${prefix}-emp" name="employment_type">${options(EMPLOYMENT, j.employment_type)}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label for="${prefix}-min">Salary from (USD/yr)</label><input id="${prefix}-min" name="salary_min" inputmode="numeric" placeholder="95,000" value="${esc(j.salary_min ?? "")}"></div>
        <div class="field"><label for="${prefix}-max">Salary to (USD/yr)</label><input id="${prefix}-max" name="salary_max" inputmode="numeric" placeholder="125,000" value="${esc(j.salary_max ?? "")}"></div>
      </div>
      <div class="field"><label for="${prefix}-summary">Summary</label><input id="${prefix}-summary" name="summary" maxlength="400" required placeholder="One or two sentences shown in the job list" value="${esc(j.summary)}"></div>
      <div class="field"><label for="${prefix}-desc">Full description</label><textarea id="${prefix}-desc" name="description" rows="7" placeholder="Responsibilities, systems you use, qualifications">${esc(j.description)}</textarea></div>
      <div class="field"><label for="${prefix}-apply">Apply link (optional)</label><input id="${prefix}-apply" name="apply_url" type="url" placeholder="https://your-ats.example/job/123" value="${esc(j.apply_url)}"><span class="hint">Leave blank to collect applications here, with résumés, in your dashboard.</span></div>`;
  }

  // ---------- job alerts ----------
  function alertsPanel(preselect = "") {
    return `
      <section class="alerts" aria-labelledby="alerts-title">
        <div>
          <p class="eyebrow">Job alerts</p>
          <h2 id="alerts-title">Get new roles by email, once a week.</h2>
          <p class="source-note">Pick the specialties you care about, or leave them all off for everything. One click to unsubscribe.</p>
        </div>
        <form class="form" id="alerts-form" novalidate>
          <fieldset class="chip-set"><legend class="visually-hidden">Specialties</legend>
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
    const preview = [...jobs].sort((a, b) => (b.direct - a.direct) || ((b.salary_max || b.salary_min || 0) - (a.salary_max || a.salary_min || 0))).slice(0, 4);

    view.innerHTML = `
      <section class="home-hero">
        <canvas id="guilloche" aria-hidden="true"></canvas>
        <div class="wrap home-hero-grid">
          <div class="home-hero-copy">
            <p class="eyebrow">Banks · Credit unions · Their technology teams</p>
            <h1>The job board for <em>banking technology</em> and data.</h1>
            <p class="lede">BankStack lists only tech and data roles at financial institutions: data engineers, architects, developers, analysts and security staff. Candidates find roles built for their background. Banks reach people who already know core systems, call reports and regulatory data.</p>
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
          <div><strong>${jobs.length}</strong><span>open tech &amp; data roles</span></div>
          <div><strong>${institutions}</strong><span>banks and credit unions hiring</span></div>
          <div><strong>${Object.keys(counts).length}</strong><span>specialties covered</span></div>
          <div><strong>${withPay.length}</strong><span>listings with posted pay</span></div>
        </div>
      </section>

      <section class="band">
        <div class="wrap two-up">
          <div class="audience">
            <p class="eyebrow">For job seekers</p>
            <h2>Roles that value banking experience.</h2>
            <p>Every listing is a technology or data job inside a financial institution. Filter by specialty, institution type and on-site, hybrid or remote, then apply with your résumé in a couple of minutes.</p>
            <a class="text-link" href="#jobs">Browse positions →</a>
          </div>
          <div class="audience">
            <p class="eyebrow">For banks and credit unions</p>
            <h2>Reach candidates who already speak your language.</h2>
            <p>Skip general boards full of applicants who've never touched a core platform. Post a role for ${PRICE} a month, review applicants and résumés in your dashboard, and stop whenever it's filled.</p>
            <a class="text-link" href="#post">Post a job →</a>
          </div>
        </div>
      </section>

      <section class="band alt">
        <div class="wrap">
          <p class="eyebrow">Specialties</p>
          <h2 class="section-title">Browse by the work you do</h2>
          <div class="spec-grid">
            ${Object.entries(CATEGORIES).map(([k, v]) => `
              <button class="spec" data-cat="${k}" type="button">
                <span class="spec-name">${esc(v)}</span>
                <span class="spec-count">${counts[k] || 0} open</span>
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
          <h2>Looking for your next role in banking tech?</h2>
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
          <p>Tech and data openings at banks and credit unions. Direct postings come from the employer; the rest are gathered from public job sites and link to the original.</p>
          <div class="stat-row" role="group" aria-label="Filter by specialty">
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
            <dt>Specialty</dt><dd>${esc(CATEGORIES[j.category] || j.category)}</dd>
            <dt>Pay</dt><dd class="salary">${pay ? esc(pay) + " per year" : "Not listed"}</dd>
            ${j.posted_at ? `<dt>Posted</dt><dd>${esc(fmtDate(j.posted_at))}</dd>` : ""}
          </dl>
          ${j.description ? `<div class="prose">${esc(j.description)}</div>` : ""}
          ${external ? `<p class="source-note">Found on ${esc(j.source_name)}. Listings we gather can close without notice, so confirm the role on the original posting.</p>` : ""}
          <div><button class="linkish" id="copy-link" type="button">Copy link to this job</button></div>
        </article>
        <aside class="panel">
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

  // ---------- post a job ----------
  function signInPanel() {
    return `
      <div class="panel signin">
        <h2>Posted with us before?</h2>
        <form class="form" id="link-form" novalidate>
          <div class="field"><label for="l-email">Work email</label><input id="l-email" name="email" type="email" autocomplete="email" placeholder="you@yourbank.com"></div>
          <button class="btn secondary" type="submit">Email me a sign-in link</button>
          <div class="msg" id="link-msg" hidden></div>
        </form>
        <details><summary>Use a posting key instead</summary>
          <form class="form" id="key-form" novalidate style="margin-top:0.75rem">
            <div class="field"><label for="k-key">Posting key</label><input id="k-key" name="key" placeholder="bsk_…" autocomplete="off"></div>
            <button class="btn secondary" type="submit">Sign in</button>
            <div class="msg" id="key-msg" hidden></div>
          </form>
        </details>
      </div>`;
  }

  function bindSignIn(after) {
    const linkForm = document.getElementById("link-form");
    if (linkForm) linkForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = document.getElementById("link-msg");
      const email = document.getElementById("l-email").value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return showMsg(msg, "Enter the email you posted with.", true);
      if (state.demo) return showMsg(msg, "Preview mode: on the live site this emails you a sign-in link.", false);
      try {
        await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email }) });
        showMsg(msg, `If ${email} has posted with us, a sign-in link is on its way. It works for 30 minutes.`, false);
      } catch (err) { showMsg(msg, err.message, true); }
    });
    const keyForm = document.getElementById("key-form");
    if (keyForm) keyForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = document.getElementById("k-key").value.trim();
      if (!v.startsWith("bsk_")) return showMsg(document.getElementById("key-msg"), "Posting keys start with bsk_.", true);
      store.set("bankstack.key", v);
      updateNav();
      after();
    });
  }

  function viewPost() {
    const signedIn = !!key();
    view.innerHTML = `
      <div class="wrap post">
        <section class="post-intro">
          <p class="eyebrow">Post a job</p>
          <h1>${PRICE} per posting, per month.</h1>
          <p class="lede">Describe the role, pay by card through Stripe, and it goes live right away as a Direct listing above sourced jobs, with its own page in Google's job search. It renews monthly until you cancel it from your dashboard.</p>
          ${signedIn ? "" : signInPanel()}
        </section>
        <form class="panel form" id="post-form" novalidate>
          ${signedIn ? `<p class="source-note">Signed in. This posting is billed to your account. <a href="#dashboard">Dashboard</a></p>` : `
          <h2>Your institution</h2>
          <div class="row-2">
            <div class="field"><label for="c-company">Institution name</label><input id="c-company" name="company" autocomplete="organization" required></div>
            <div class="field"><label for="c-type">Type</label>
              <select id="c-type" name="institution_type">${options(INST, "bank")}</select>
            </div>
          </div>
          <div class="field"><label for="c-email">Work email</label><input id="c-email" name="email" type="email" autocomplete="email" required><span class="hint">Receipts, applicant notifications and sign-in links go here.</span></div>`}
          <h2>The role</h2>
          ${roleFields({}, "p")}
          ${honeypot}
          <div class="checkout-line"><span>Due today, then monthly</span><strong>${PRICE}.00</strong></div>
          <button class="btn btn-lg" type="submit">Continue to payment</button>
          <div class="msg" id="post-msg" hidden></div>
        </form>
      </div>`;

    bindSignIn(viewPost);

    document.getElementById("post-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = document.getElementById("post-msg");
      const data = Object.fromEntries(new FormData(form));
      if (!signedIn && (!data.company.trim() || !/^\S+@\S+\.\S+$/.test(data.email))) {
        return showMsg(msg, "Enter your institution's name and a valid work email.", true);
      }
      if (!data.title.trim() || !data.location.trim() || !data.summary.trim()) {
        return showMsg(msg, "Add a job title, location and summary.", true);
      }
      if (state.demo) return showMsg(msg, `Preview mode: on the live site this opens Stripe Checkout for ${PRICE}/month.`, false);
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const r = await api("/api/checkout", { method: "POST", auth: signedIn, body: JSON.stringify(data) });
        location.href = r.url;
      } catch (err) {
        showMsg(msg, err.message, true);
        btn.disabled = false;
      }
    });
  }

  // ---------- after checkout ----------
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
      store.set("bankstack.key", r.token);
      history.replaceState(null, "", "/#welcome");
      await loadJobs();
      const live = r.job && r.job.status === "open";
      box.innerHTML = `
        <h2>Thanks, ${esc(r.company)}. ${live ? "Your job is live." : "Payment received."}</h2>
        ${r.job ? `<p><b>${esc(r.job.title)}</b> ${live ? "is now listed as a Direct posting and renews monthly until you cancel it." : "will appear as soon as Stripe confirms the payment."}</p>` : ""}
        <p>You're signed in on this device. On another device, use <b>Email me a sign-in link</b> on the Post a job page, or paste this posting key:</p>
        <div class="key-box" id="the-key">${esc(r.token)}</div>
        <div class="cta-row">
          <button class="btn secondary" id="copy-key" type="button">Copy key</button>
          ${live ? `<a class="btn secondary" href="${jobHref(r.job.id)}">View your posting</a>` : ""}
          <a class="btn" href="#dashboard">Go to dashboard</a>
        </div>`;
      document.getElementById("copy-key").addEventListener("click", async (e) => {
        try { await navigator.clipboard.writeText(r.token); e.target.textContent = "Copied"; }
        catch { getSelection().selectAllChildren(document.getElementById("the-key")); }
      });
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
    view.innerHTML = `<div class="wrap post"><section class="post-intro"><h1>Sign in to your dashboard</h1>
      ${message ? `<p class="msg error">${esc(message)}</p>` : ""}</section>${signInPanel()}</div>`;
    bindSignIn(() => { location.hash = "dashboard"; route(); });
  }

  async function downloadResume(appId, name, btn) {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/employer/applications/${appId}/resume`, { headers: { authorization: "Bearer " + key() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Download failed.");
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name || "resume" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) { document.getElementById("act-msg").textContent = err.message; }
    btn.disabled = false;
  }

  async function viewDashboard() {
    if (!key()) return signedOut();
    view.innerHTML = `<div class="wrap dash"><p>Loading your dashboard…</p></div>`;
    let d;
    try { d = await api("/api/employer", { auth: true }); }
    catch (err) { return err.status === 401 ? signedOut(err.message) : (view.innerHTML = `<div class="wrap dash"><p class="msg error">${esc(err.message)}</p></div>`); }

    const live = d.jobs.filter((j) => j.status === "open" && !j.cancel_at_period_end).length;
    const newCount = d.applications.filter((a) => a.status === "new").length;
    const apps = state.appFilter ? d.applications.filter((a) => String(a.job_id) === state.appFilter) : d.applications;

    view.innerHTML = `
      <div class="wrap dash">
        <div class="dash-head">
          <div style="display:grid;gap:0.3rem">
            <h1 style="font-size:1.8rem">${esc(d.company)}</h1>
            <span class="source-note">${live} live ${live === 1 ? "posting" : "postings"} · ${PRICE}/month each · ${newCount} new ${newCount === 1 ? "applicant" : "applicants"}</span>
          </div>
          <div class="cta-row">
            <a class="btn" href="#post">Post another job</a>
            <button class="btn secondary" id="billing" type="button">Cards &amp; invoices</button>
            <button class="linkish" id="signout" type="button">Sign out</button>
          </div>
        </div>
        <p class="source-note" id="act-msg" aria-live="polite"></p>
        <section>
          <h2 class="dash-title">Your postings</h2>
          <div class="table-wrap"><table class="stack-table">
            <thead><tr><th>Job</th><th>Billing</th><th style="text-align:right">Applicants</th><th>Actions</th></tr></thead>
            <tbody>${d.jobs.length ? d.jobs.map((j) => {
              const s = jobStatus(j);
              const acts = [];
              if (j.status !== "closed") acts.push(`<a href="#edit-${j.id}">Edit</a>`);
              if (j.status === "pending") acts.push(`<button class="linkish" data-act="pay" data-id="${j.id}" type="button">Finish payment</button>`);
              else if (j.status === "open" && j.cancel_at_period_end) acts.push(`<button class="linkish" data-act="resume" data-id="${j.id}" type="button">Keep renewing</button>`);
              else if (j.status === "open") acts.push(`<button class="linkish" data-act="cancel" data-id="${j.id}" type="button">Cancel posting</button>`);
              return `<tr>
                <td data-label="Job">${j.status === "open" ? `<a href="${jobHref(j.id)}">${esc(j.title)}</a>` : esc(j.title)}<br><span class="source-note">${esc(j.location)}</span></td>
                <td data-label="Billing"><span class="status-pill${s.bad ? " bad" : ""}">${esc(s.label)}</span></td>
                <td data-label="Applicants" class="num">${j.applications}${j.new_applications ? ` <span class="new-dot">${j.new_applications} new</span>` : ""}</td>
                <td data-label="Actions" class="acts">${acts.join(" ")}</td></tr>`;
            }).join("") : `<tr><td colspan="4" class="source-note">No postings yet. <a href="#post">Post your first job</a>.</td></tr>`}</tbody>
          </table></div>
        </section>
        <section>
          <div class="dash-row">
            <h2 class="dash-title">Applicants</h2>
            ${d.jobs.length > 1 ? `<select id="app-filter" aria-label="Show applicants for"><option value="">All postings</option>${d.jobs.map((j) => `<option value="${j.id}"${String(j.id) === state.appFilter ? " selected" : ""}>${esc(j.title)}</option>`).join("")}</select>` : ""}
          </div>
          <div class="table-wrap"><table class="stack-table">
            <thead><tr><th>Candidate</th><th>Job</th><th>Received</th><th>Résumé &amp; links</th><th>Stage</th></tr></thead>
            <tbody>${apps.length ? apps.map((a) => `<tr${a.status === "new" ? ' class="is-new"' : ""}>
              <td data-label="Candidate"><b>${esc(a.name)}</b><br><span class="source-note">${esc(a.email)}${a.phone ? " · " + esc(a.phone) : ""}</span>${a.cover_note ? `<details><summary>Note</summary><p class="prose">${esc(a.cover_note)}</p></details>` : ""}</td>
              <td data-label="Job">${esc(a.job_title)}</td>
              <td data-label="Received" class="num">${esc(fmtDate(a.created_at))}</td>
              <td data-label="Résumé">${a.has_resume ? `<button class="linkish" data-resume="${a.id}" data-name="${esc(a.resume_name)}" type="button">${esc(a.resume_name || "Résumé")}</button> <span class="source-note">${a.resume_size ? fmtSize(a.resume_size) : ""}</span><br>` : ""}${a.resume_url ? `<a href="${esc(a.resume_url)}" target="_blank" rel="noopener">Résumé link</a> ` : ""}${a.linkedin_url ? `<a href="${esc(a.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}${!a.has_resume && !a.resume_url && !a.linkedin_url ? '<span class="source-note">None</span>' : ""}</td>
              <td data-label="Stage"><select class="stage" data-app="${a.id}" aria-label="Stage for ${esc(a.name)}">${options(STAGES, a.status)}</select></td></tr>`).join("")
              : `<tr><td colspan="5" class="source-note">Applicants show up here, and in your inbox, as they apply.</td></tr>`}</tbody>
          </table></div>
        </section>
      </div>`;

    const say = (t) => (document.getElementById("act-msg").textContent = t);
    document.getElementById("signout").addEventListener("click", () => {
      store.del("bankstack.key"); updateNav(); location.hash = "home";
    });
    document.getElementById("billing").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const r = await api("/api/employer/billing", { method: "POST", auth: true }); location.href = r.url; }
      catch (err) { e.target.disabled = false; say(err.message); }
    });
    const filter = document.getElementById("app-filter");
    if (filter) filter.addEventListener("change", (e) => { state.appFilter = e.target.value; viewDashboard(); });
    view.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const r = await api(`/api/employer/jobs/${b.dataset.id}/${b.dataset.act}`, { method: "POST", auth: true });
        if (r.url) { location.href = r.url; return; }
        await loadJobs();
        viewDashboard();
      } catch (err) { b.disabled = false; say(err.message); }
    }));
    view.querySelectorAll("[data-resume]").forEach((b) => b.addEventListener("click", () => downloadResume(b.dataset.resume, b.dataset.name, b)));
    view.querySelectorAll("select.stage").forEach((s) => s.addEventListener("change", async () => {
      s.disabled = true;
      try {
        await api(`/api/employer/applications/${s.dataset.app}/status`, { method: "POST", auth: true, body: JSON.stringify({ status: s.value }) });
        s.closest("tr").classList.toggle("is-new", s.value === "new");
        say(`Moved to ${STAGES[s.value]}.`);
      } catch (err) { say(err.message); }
      s.disabled = false;
    }));
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
          ${roleFields(j, "e")}
          <div class="cta-row"><button class="btn" type="submit">Save changes</button><a class="btn secondary" href="#dashboard">Cancel</a></div>
          <div class="msg" id="edit-msg" hidden></div>
        </form>
      </div>`;
    document.getElementById("edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form));
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
              <div class="field"><label for="s-url">Original posting link</label><input id="s-url" name="source_url" type="url" required placeholder="https://"></div>
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
      const data = Object.fromEntries(new FormData(e.currentTarget));
      const msg = document.getElementById("add-msg");
      try {
        await api("/api/admin/jobs", { method: "POST", admin: true, body: JSON.stringify(data) });
        await loadJobs(); await viewAdmin();
        say(`Added "${data.title}".`);
      } catch (err) { showMsg(msg, err.message, true); }
    });
  }

  // ---------- router ----------
  function updateNav() {
    document.getElementById("nav-dashboard").hidden = !key();
  }

  function route() {
    document.getElementById("flash").hidden = true;
    if (state.pendingFlash) { const [t, bad] = state.pendingFlash; state.pendingFlash = null; setTimeout(() => flash(t, bad), 0); }
    // A real /jobs/123 URL (served by the job page function) shows that job until another view is picked.
    const pathJob = location.pathname.match(/^\/jobs\/(\d+)\/?$/);
    let h = location.hash.replace(/^#/, "");
    if (pathJob && h) history.replaceState(null, "", "/#" + h);
    if (!h) h = pathJob ? `job-${pathJob[1]}` : "home";
    if (h === "employers") h = "post";
    const section = h.startsWith("job-") ? "jobs" : h.startsWith("edit-") ? "dashboard" : h;
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
    else if (h === "dashboard") viewDashboard();
    else if (h === "admin") viewAdmin();
    else viewHome();
    window.scrollTo(0, 0);
  }

  // Links that arrive by email: ?login= (employer sign-in) and ?alerts= (job alert confirm/unsubscribe).
  async function handleEmailLinks() {
    const params = new URLSearchParams(location.search);
    const login = params.get("login");
    const alerts = params.get("alerts");
    if (!login && !alerts) return;
    history.replaceState(null, "", location.pathname + location.hash);
    if (login) {
      try {
        const r = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ token: login }) });
        store.set("bankstack.key", r.token);
        if (!location.hash) history.replaceState(null, "", location.pathname + "#dashboard");
        state.pendingFlash = [`Signed in as ${r.company}.`];
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
