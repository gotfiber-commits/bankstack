// GET /api/jobs?q=&category=&work_mode=&institution_type=  → list of open jobs
// GET /api/jobs/:id                                          → one job
import { db, json, fail } from "../lib/shared.mjs";

const PUBLIC_FIELDS = `id, title, company, institution_type, location, work_mode, employment_type, category,
  salary_min, salary_max, summary, description, apply_url, source_name, source_url,
  is_featured, posted_at, (employer_id IS NOT NULL) AS direct`;

export default async (req, context) => {
  if (req.method !== "GET") return fail("Method not allowed", 405);
  const sql = db();
  const id = context.params?.id;

  if (id) {
    if (!/^\d+$/.test(id)) return fail("Job not found", 404);
    const rows = await sql.query(
      `SELECT ${PUBLIC_FIELDS} FROM jobs WHERE id = $1 AND status = 'open' AND expires_at > now()`,
      [id]
    );
    return rows[0] ? json(rows[0]) : fail("Job not found", 404);
  }

  const p = new URL(req.url).searchParams;
  const where = ["status = 'open'", "expires_at > now()"];
  const args = [];
  const add = (clause, value) => { args.push(value); where.push(clause.replace("?", `$${args.length}`)); };

  const q = (p.get("q") || "").trim().slice(0, 100);
  if (q) {
    args.push(`%${q}%`);
    const n = `$${args.length}`;
    where.push(`(title ILIKE ${n} OR company ILIKE ${n} OR location ILIKE ${n} OR summary ILIKE ${n})`);
  }
  if (p.get("category")) add("category = ?", p.get("category"));
  if (p.get("work_mode")) add("work_mode = ?", p.get("work_mode"));
  if (p.get("institution_type")) add("institution_type = ?", p.get("institution_type"));

  const rows = await sql.query(
    `SELECT ${PUBLIC_FIELDS} FROM jobs WHERE ${where.join(" AND ")}
     ORDER BY is_featured DESC, (employer_id IS NOT NULL) DESC, posted_at DESC LIMIT 200`,
    args
  );
  return json({ jobs: rows });
};

export const config = { path: ["/api/jobs", "/api/jobs/:id"] };
