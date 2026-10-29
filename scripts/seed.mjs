// Creates or upgrades the schema and loads the sourced listings from public/seed-jobs.json.
// Usage: DATABASE_URL=postgres://... npm run db:seed
import { readFile } from "node:fs/promises";
import { db } from "../netlify/lib/shared.mjs";

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to your Neon (or local Postgres) connection string first.");
  process.exit(1);
}
const sql = db();

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const statements = schema
  .replace(/--.*$/gm, "")
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter(Boolean);
for (const stmt of statements) await sql.query(stmt);
console.log(`Schema ready (${statements.length} statements).`);

const jobs = JSON.parse(await readFile(new URL("../public/seed-jobs.json", import.meta.url), "utf8"));
let inserted = 0;
for (const j of jobs) {
  const rows = await sql`
    INSERT INTO jobs (title, company, institution_type, location, work_mode, employment_type, category,
                      salary_min, salary_max, summary, apply_url, source_name, source_url, expires_at)
    VALUES (${j.title}, ${j.company}, ${j.institution_type}, ${j.location}, ${j.work_mode},
            ${j.employment_type || "full-time"}, ${j.category}, ${j.salary_min}, ${j.salary_max}, ${j.summary},
            ${j.source_url}, ${j.source_name}, ${j.source_url}, now() + interval '30 days')
    ON CONFLICT (source_url) DO NOTHING
    RETURNING id`;
  inserted += rows.length;
}
console.log(`Seeded ${inserted} new listings (${jobs.length - inserted} already present).`);
await sql.end?.();
