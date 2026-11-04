// A local stand-in for Anthropic's Messages API, so the AI assistant's full path —
// auth, rate limits, prompt assembly, section parsing, UI — runs in tests without a key
// or network. Records every request for assertions.
import http from "node:http";

export function startFakeAnthropic(port = 8978) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/messages" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"type":"error"}');
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ headers: { "x-api-key": req.headers["x-api-key"], "anthropic-version": req.headers["anthropic-version"] }, body });
      if (!req.headers["x-api-key"]) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"type":"error","error":{"type":"authentication_error"}}');
      }
      const sys = String(body.system || "");
      const text = sys.includes("COVER NOTE")
        ? "COVER NOTE:\nI've spent ten years in consumer lending at a community bank, working underwriting end to end, and this role matches that experience closely. I'd welcome the chance to bring it to your team.\nTIPS:\n- Lead with your underwriting experience\n- Mention your NMLS registration early\n- Mirror the posting's wording on loan servicing"
        : "SUMMARY:\nRun daily deposit operations for a growing community bank, owning wires, ACH and exceptions.\nDESCRIPTION:\nOur operations team keeps every payment moving.\nWhat you'll do\n- Process wires and ACH files\n- Work daily exceptions\n- Support branch staff\nWhat you'll bring\n- 2+ years in bank operations\n- Accuracy under deadlines\nReady? Apply with your résumé.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text }],
        usage: { input_tokens: 500, output_tokens: 200 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, requests })));
}
