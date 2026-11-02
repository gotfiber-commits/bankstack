// A local stand-in for the FDIC BankFind API (api.fdic.gov/banks/institutions) and the
// NCUA locator API (mapping.ncua.gov GetDetailSearch), mirroring each one's real shape,
// so the directory sync runs against known data in tests. Pointed at via
// FDIC_API_BASE / NCUA_API_BASE.
import http from "node:http";

// Four banks — two sharing name+city+state to exercise slug collision handling.
export const FAKE_BANKS = [
  { CERT: 1001, NAME: "SHOALS COMMUNITY BANK", CITY: "FLORENCE", STALP: "AL", ASSET: 742000, OFFICES: 12, WEBADDR: "https://shoalsbank.test", REPDTE: "2026-06-30" },
  { CERT: 1002, NAME: "FIRST STATE BANK", CITY: "SPRINGFIELD", STALP: "IL", ASSET: 310000, OFFICES: 4, WEBADDR: "", REPDTE: "2026-06-30" },
  { CERT: 1003, NAME: "FIRST STATE BANK", CITY: "SPRINGFIELD", STALP: "IL", ASSET: 95000, OFFICES: 2, WEBADDR: "www.fsbil.test", REPDTE: "2026-06-30" },
  { CERT: 1004, NAME: "RIVER CITY NATIONAL BANK", CITY: "DECATUR", STALP: "AL", ASSET: 1850000, OFFICES: 22, WEBADDR: "https://rivercity.test", REPDTE: "2026-06-30" },
  { CERT: 1005, NAME: "MUSCLE SHOALS NATIONAL BANK", CITY: "MUSCLE SHOALS", STALP: "AL", ASSET: 410000, OFFICES: 7, WEBADDR: "", REPDTE: "2026-06-30" },
];

// NCUA GetDetailSearch rows: roster basics only — no assets or members, like the real search.
export const FAKE_CUS = [
  { charterNumber: 60001, cuName: "TENNESSEE VALLEY CREDIT UNION", city: "MUSCLE SHOALS", state: "AL" },
  { charterNumber: 60002, cuName: "PRAIRIE FEDERAL CREDIT UNION", city: "SPRINGFIELD", state: "IL" },
];

export function startFakeRegistries(port = 8977) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // FDIC: GET /banks/institutions?filters=ACTIVE:1&fields=…&limit=&offset=
    if (url.pathname === "/banks/institutions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 10);
      const offset = Number(url.searchParams.get("offset") || 0);
      const page = FAKE_BANKS.slice(offset, offset + limit);
      return send({ meta: { total: FAKE_BANKS.length }, data: page.map((d) => ({ data: d, score: 0 })) });
    }
    // NCUA: POST /api/ResearchCreditUnion/GetDetailSearch { skip, take, cuStatus: "A" }
    if (url.pathname === "/api/ResearchCreditUnion/GetDetailSearch" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let b = {};
        try { b = JSON.parse(raw); } catch { /* empty body */ }
        const take = Math.min(Number(b.take || 100), 100); // the real API silently caps at 100
        const skip = Number(b.skip || 0);
        send({ totalResultCount: FAKE_CUS.length, results: FAKE_CUS.slice(skip, skip + take) });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => server.listen(port, () => resolve({
    server,
    base: `http://localhost:${port}`,
  })));
}
