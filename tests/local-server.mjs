// Runs the site the way Netlify does, without the Netlify CLI: static files from public/ plus every
// function in netlify/functions routed by its own `config.path`. Used by the end-to-end test.
import http from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".txt": "text/plain" };

function compile(pattern) {
  const names = [];
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; })
    .replace(/\*/g, () => { names.push("splat"); return "(.*)"; });
  return { regex: new RegExp(`^${re}/?$`), names };
}

export async function startLocalServer(port = 8899) {
  const routes = [];
  const dir = path.join(root, "netlify/functions");
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".mjs"))) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const paths = mod.config?.path;
    if (!paths) continue; // scheduled functions have no URL
    for (const p of [].concat(paths)) routes.push({ ...compile(p), handler: mod.default, file });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      for (const r of routes) {
        const m = url.pathname.match(r.regex);
        if (!m) continue;
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length && !["GET", "HEAD"].includes(req.method) ? Buffer.concat(chunks) : undefined;
        const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        const response = await r.handler(request, { params });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      let file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(path.join(root, "public"))) throw Object.assign(new Error("bad path"), { code: "ENOENT" });
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(await readFile(file));
    } catch (err) {
      if (err.code === "ENOENT") { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
      console.error(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Server error: " + err.message);
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return { server, routes };
}
