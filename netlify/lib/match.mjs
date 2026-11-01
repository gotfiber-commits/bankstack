// Ranks open jobs against a candidate's résumé and profile.
// Deterministic and explainable: banking-domain phrases by department, word overlap with
// each posting weighted by how rare the word is across the board, plus the candidate's
// own department picks, location and work preference. No outside services.

export const LEXICON = {
  "branch-retail": ["teller", "branch manager", "member service", "customer service", "cash handling", "new accounts", "personal banker", "head teller", "vault", "branch operations", "universal banker", "drive-thru"],
  "lending-credit": ["loan officer", "underwriting", "underwriter", "mortgage", "lending", "loan processing", "loan processor", "credit analysis", "credit analyst", "consumer loans", "commercial loans", "origination", "nmls", "heloc", "closing disclosure", "loan servicing", "collateral", "escrow"],
  "commercial-banking": ["relationship manager", "treasury management", "commercial banking", "business banking", "portfolio manage", "cash management", "merchant services", "business development", "commercial deposits"],
  "operations": ["deposit operations", "wire transfer", "ach", "payments", "card services", "item processing", "collections", "loss mitigation", "chargeback", "dispute", "reg e", "account servicing", "exception", "proof", "settlement"],
  "risk-compliance": ["bsa", "aml", "anti-money laundering", "compliance", "audit", "fraud", "kyc", "ofac", "sar", "risk management", "regulatory", "examination", "internal audit", "cra", "fair lending", "vendor management"],
  "finance-accounting": ["accounting", "accountant", "general ledger", "reconciliation", "financial reporting", "call report", "alm", "budget", "accounts payable", "cpa", "treasury", "fp&a", "interest rate risk", "month-end close"],
  "wealth-trust": ["financial advisor", "wealth management", "trust officer", "investment", "portfolio", "brokerage", "retirement", "fiduciary", "estate", "series 7", "series 66", "annuit"],
  "technology": ["software", "developer", "engineer", "it support", "help desk", "network", "infrastructure", "cybersecurity", "security analyst", "cloud", "devops", "java", ".net", "api", "core banking", "jack henry", "fiserv", "silverlake", "system administrator", "active directory", "microsoft 365"],
  "data-analytics": ["data engineer", "data analyst", "analytics", "sql", "power bi", "tableau", "etl", "data warehouse", "data architect", "reporting", "python", "business intelligence", "database", "snowflake", "fabric", "spark", "data governance", "data model", "dashboards"],
  "leadership-admin": ["executive", "chief", "president", "human resources", "hr generalist", "marketing", "training", "facilities", "administrative assistant", "recruiter", "payroll", "office manager", "communications"],
};

const STOP = new Set(
  ("the a an and or of to in for with on at by from as is are be will can has have was were this that it its our your " +
    "their my we you they not all any out up new one two per day days bank banks banking credit union unions financial " +
    "institution company team teams work working role roles job jobs position positions experience years year hiring " +
    "responsibilities qualifications required preferred strong ability skills including degree related etc plus other more").split(/\s+/)
);

function tokenize(text) {
  const counts = new Map();
  for (const m of String(text).toLowerCase().matchAll(/[a-z][a-z0-9+#&.-]*/g)) {
    const t = m[0].replace(/^[.-]+|[.-]+$/g, "");
    if (t.length < 2 || STOP.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

const MODE_LABEL = { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" };

export function rankJobs(candidate, jobs, limit = 50) {
  const text = [candidate.resume_text, candidate.summary].filter(Boolean).join("\n").toLowerCase();
  const basis = candidate.resume_text ? "resume" : "profile";
  const prefs = candidate.categories || [];
  const resume = tokenize(text);

  // How strongly the résumé leans toward each department
  const dept = {};
  for (const [cat, phrases] of Object.entries(LEXICON)) dept[cat] = phrases.filter((p) => text.includes(p)).length;
  const maxDept = Math.max(1, ...Object.values(dept));

  // Document frequency across the open jobs, so everyday words count less
  const df = new Map();
  const jobTokens = jobs.map((j) => {
    const w = new Map();
    const add = (t, weight) => { for (const tok of tokenize(t).keys()) w.set(tok, Math.max(w.get(tok) || 0, weight)); };
    add(j.title, 3); add(j.summary || "", 2); add(j.description || "", 1);
    for (const tok of w.keys()) df.set(tok, (df.get(tok) || 0) + 1);
    return w;
  });
  const idf = (t) => Math.log(1 + jobs.length / (1 + (df.get(t) || 0)));
  const state = (candidate.location || "").match(/\b([A-Z]{2})\b/)?.[1];

  const scored = jobs.map((j, i) => {
    const reasons = [];
    let raw = 0;

    // 1. This job's own department phrases, found in the résumé
    const phraseHits = (LEXICON[j.category] || []).filter((p) => text.includes(p));
    raw += Math.min(phraseHits.length, 5) * 2;
    if (phraseHits.length) reasons.push(`Your experience: ${phraseHits.slice(0, 4).join(", ")}`);

    // 2. Word overlap with this particular posting, rare words counting more
    const overlaps = [];
    for (const [tok, weight] of jobTokens[i]) {
      if (resume.has(tok)) overlaps.push([tok, weight * idf(tok)]);
    }
    overlaps.sort((a, b) => b[1] - a[1]);
    raw += Math.min(6, overlaps.reduce((s, [, v]) => s + v, 0) / 4);
    const extra = overlaps.map(([t]) => t).filter((t) => t.length > 3 && !phraseHits.some((p) => p.includes(t))).slice(0, 3);
    if (extra.length && text) reasons.push(`Posting mentions ${extra.join(", ")}`);

    // 3. Overall lean of the résumé toward this department
    raw += 3 * ((dept[j.category] || 0) / maxDept);

    // 4. The candidate's own picks and practical fit
    if (prefs.includes(j.category)) { raw += 2; reasons.push("A department you picked"); }
    const pref = candidate.work_mode_pref || "any";
    if (pref !== "any" && j.work_mode === pref) { raw += 0.75; reasons.push(`${MODE_LABEL[j.work_mode]}, your preference`); }
    if (state && new RegExp(`\\b${state}\\b`).test(j.location || "")) { raw += 0.75; reasons.push(`In ${state}`); }

    const score = Math.min(98, Math.round((100 * raw) / (raw + 6)));
    const tier = score >= 65 ? "strong" : score >= 40 ? "good" : "possible";
    return { job: j, score, tier, reasons: reasons.slice(0, 4) };
  });

  scored.sort((a, b) => b.score - a.score || (b.job.direct === true) - (a.job.direct === true));
  return { basis, matches: scored.slice(0, limit) };
}
