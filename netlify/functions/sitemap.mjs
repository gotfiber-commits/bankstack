// GET /sitemap.xml and /robots.txt
import { db, siteUrl } from "../lib/shared.mjs";

export default async (req) => {
  const base = siteUrl(req);
  if (new URL(req.url).pathname === "/robots.txt") {
    return new Response(`User-agent: *\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`, {
      headers: { "content-type": "text/plain" },
    });
  }
  // Only employer-posted jobs are listed; sourced listings point at someone else's original.
  const jobs = await db()`SELECT id, updated_at FROM jobs
                          WHERE status = 'open' AND expires_at > now() AND employer_id IS NOT NULL
                          ORDER BY posted_at DESC LIMIT 5000`;
  const urls = [`<url><loc>${base}/</loc><changefreq>daily</changefreq></url>`,
    ...jobs.map((j) => `<url><loc>${base}/jobs/${j.id}</loc><lastmod>${new Date(j.updated_at).toISOString()}</lastmod></url>`)];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
    { headers: { "content-type": "application/xml" } });
};

export const config = { path: ["/sitemap.xml", "/robots.txt"] };
