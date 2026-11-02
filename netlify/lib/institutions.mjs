// The institution directory: every active US bank (FDIC) and credit union (NCUA),
// pulled from their public data into the institutions table. The admin console calls
// syncInstitutions page by page so each call stays well inside the function time limit.
// FDIC_API_BASE / NCUA_API_BASE env vars exist so tests can point at a local fixture server.
import { db, normalizeName } from "./shared.mjs";

// FDIC's BankFind API moved from banks.data.fdic.gov to api.fdic.gov/banks (verified Nov 2026).
const FDIC_BASE = () => process.env.FDIC_API_BASE || "https://api.fdic.gov";
const NCUA_BASE = () => process.env.NCUA_API_BASE || "https://mapping.ncua.gov";

export function slugify(name, city, state) {
  return [name, city, state].filter(Boolean).join(" ").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

// FDIC names arrive in ALL CAPS; people and Google prefer "First Metro Bank".
export function titleCase(s) {
  const t = String(s || "").trim();
  if (!/^[^a-z]*$/.test(t)) return t; // already mixed case
  const small = new Set(["of", "the", "and", "for", "at", "in", "on", "de", "la"]);
  return t.toLowerCase().replace(/[a-z0-9&']+/g, (w, i) => {
    if (/^\d/.test(w)) return w.replace(/(st|nd|rd|th)$/, "$1"); // 1st, 21st
    if (i > 0 && small.has(w)) return w;
    if (/^(fsb|ssb|na|llc|fcu|cu)$/.test(w)) return w.toUpperCase();
    return w[0].toUpperCase() + w.slice(1);
  });
}

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

// Upserts one page of institutions. Keyed on (institution_type, regulator_id); an existing
// row keeps its slug so directory URLs never change. New slug collisions get the regulator
// id appended, which keeps the whole operation deterministic and safe to re-run.
async function upsertBatch(sql, rows) {
  if (!rows.length) return 0;
  const seen = new Map();
  for (const r of rows) {
    r.slug = slugify(r.name, r.city, r.state);
    while (seen.has(r.slug)) r.slug = `${r.slug}-${r.regulator_id}`;
    seen.set(r.slug, r);
    r.normalized_name = normalizeName(r.name);
  }
  // Slugs already used by a DIFFERENT institution get the regulator id appended.
  const taken = await sql.query(
    `SELECT slug, institution_type, regulator_id FROM institutions WHERE slug = ANY($1)`,
    [rows.map((r) => r.slug)]
  );
  for (const t of taken) {
    const r = seen.get(t.slug);
    if (r && !(r.institution_type === t.institution_type && String(r.regulator_id) === String(t.regulator_id))) {
      r.slug = `${r.slug}-${r.regulator_id}`;
    }
  }
  const col = (k) => rows.map((r) => r[k] ?? null);
  const inserted = await sql.query(
    `INSERT INTO institutions (slug, name, normalized_name, institution_type, regulator_id, city, state,
                               asset_thousands, branches, employees, members, website, data_as_of, active, updated_at)
     SELECT u.*, true, now()
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                 $8::bigint[], $9::int[], $10::int[], $11::int[], $12::text[], $13::text[])
       AS u(slug, name, normalized_name, institution_type, regulator_id, city, state,
            asset_thousands, branches, employees, members, website, data_as_of)
     ON CONFLICT (institution_type, regulator_id) DO UPDATE SET
       name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name, city = EXCLUDED.city,
       state = EXCLUDED.state, asset_thousands = EXCLUDED.asset_thousands, branches = EXCLUDED.branches,
       employees = EXCLUDED.employees, members = EXCLUDED.members, website = EXCLUDED.website,
       active = true, data_as_of = EXCLUDED.data_as_of, updated_at = now()
     RETURNING id`,
    [col("slug"), col("name"), col("normalized_name"), col("institution_type"), col("regulator_id"),
     col("city"), col("state"), col("asset_thousands"), col("branches"), col("employees"), col("members"),
     col("website"), col("data_as_of")]
  );
  return inserted.length;
}

// Jobs posted before the directory existed (or before an institution was added) get linked here.
export async function linkJobsToInstitutions(sql) {
  const jobs = await sql`SELECT id, company FROM jobs WHERE institution_id IS NULL`;
  if (!jobs.length) return 0;
  const names = [...new Set(jobs.map((j) => normalizeName(j.company)).filter(Boolean))];
  const insts = await sql.query(`SELECT id, normalized_name FROM institutions WHERE active AND normalized_name = ANY($1)`, [names]);
  const byName = new Map(insts.map((i) => [i.normalized_name, i.id]));
  let linked = 0;
  for (const j of jobs) {
    const instId = byName.get(normalizeName(j.company));
    if (!instId) continue;
    await sql`UPDATE jobs SET institution_id = ${instId} WHERE id = ${j.id}`;
    linked++;
  }
  return linked;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "user-agent": "BankJobzDirectory/1.0 (job board; contact listings@bankjobz.com)", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

// First non-empty value among several possible key spellings — sources rename fields between versions.
const pick = (r, ...keys) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
  return null;
};

// Continue paging while the source says there's more, or while pages keep coming back full.
const nextOffset = (offset, fetched, requested, total) =>
  fetched > 0 && (total != null ? offset + fetched < total : fetched === requested) ? offset + fetched : null;

async function syncFdic(sql, offset, pageSize) {
  const fields = "CERT,NAME,CITY,STALP,ASSET,OFFICES,WEBADDR,REPDTE";
  const url = `${FDIC_BASE()}/banks/institutions?filters=ACTIVE:1&fields=${fields}` +
    `&limit=${pageSize}&offset=${offset}&sort_by=CERT&sort_order=ASC&format=json`;
  const body = await fetchJson(url);
  const records = (body.data || []).map((d) => d.data || d);
  const total = body.meta?.total ?? body.totals?.count ?? null;
  const rows = records.filter((r) => r.CERT != null && r.NAME).map((r) => ({
    institution_type: "bank",
    regulator_id: String(r.CERT),
    name: titleCase(r.NAME),
    city: titleCase(r.CITY) || null,
    state: (r.STALP || "").toUpperCase() || null,
    asset_thousands: toInt(r.ASSET), // FDIC reports assets in thousands of dollars
    branches: toInt(r.OFFICES),
    employees: null, // not in the FDIC institutions dataset
    members: null,
    website: String(r.WEBADDR || "").trim() || null,
    data_as_of: r.REPDTE ? String(r.REPDTE) : null,
  }));
  const imported = await upsertBatch(sql, rows);
  return { source: "fdic", imported, fetched: records.length, total, next_offset: nextOffset(offset, records.length, pageSize, total) };
}

// NCUA's credit union locator API (mapping.ncua.gov). Pages are capped at 100 rows, so the
// admin console loops ~43 times for the full roster. The search rows carry the roster basics;
// asset/member figures aren't included, so those columns stay empty until a richer source is wired.
async function syncNcua(sql, offset) {
  const take = 100;
  const body = await fetchJson(`${NCUA_BASE()}/api/ResearchCreditUnion/GetDetailSearch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cuName: null, cuType: null, cuStatus: "A", region: null, state: null,
      city: null, zipCode: null, fomType: null, lowIncome: null, isMdi: null, skip: offset, take }),
  });
  const records = body.results || body.data || [];
  const total = body.totalResultCount ?? body.total ?? body.meta?.total ?? null;
  const rows = records.map((r) => {
    const charter = pick(r, "charterNumber", "charter_number", "creditUnionCharter", "charter", "cuNumber", "CU_NUMBER");
    const name = pick(r, "cuName", "name", "creditUnionName", "CU_NAME");
    if (charter == null || !name) return null;
    const assetsDollars = pick(r, "creditUnionAssets", "totalAssets", "assets");
    return {
      institution_type: "credit-union",
      regulator_id: String(charter),
      name: titleCase(String(name)),
      city: titleCase(String(pick(r, "city", "creditUnionCity", "CITY") || "")) || null,
      state: String(pick(r, "state", "stateCode", "creditUnionState", "STATE") || "").toUpperCase().slice(0, 2) || null,
      asset_thousands: assetsDollars != null ? toInt(Number(assetsDollars) / 1000) : null,
      branches: null,
      employees: null,
      members: toInt(pick(r, "creditUnionNom", "members", "numberOfMembers")),
      website: String(pick(r, "website", "creditUnionWebsite") || "").trim() || null,
      data_as_of: pick(r, "cycleDate", "data_as_of") ? String(pick(r, "cycleDate", "data_as_of")) : null,
    };
  }).filter(Boolean);
  const imported = await upsertBatch(sql, rows);
  return { source: "ncua", imported, fetched: records.length, total, next_offset: nextOffset(offset, records.length, take, total) };
}

export async function syncInstitutions(source, offset = 0, pageSize = 2500) {
  const sql = db();
  const result = source === "fdic" ? await syncFdic(sql, offset, pageSize)
    : source === "ncua" ? await syncNcua(sql, offset)
    : null;
  if (!result) throw new Error("source must be fdic or ncua");
  // Link any unlinked jobs once the last page of a source lands.
  if (result.next_offset === null) result.linked_jobs = await linkJobsToInstitutions(sql);
  return result;
}
