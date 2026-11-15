// A local stand-in for Anthropic's Messages API, so the AI assistant's full path —
// auth, rate limits, prompt assembly, section parsing, UI — runs in tests without a key
// or network. Records every request for assertions.
import http from "node:http";

// A full posting in the shape the prompt asks for (summary kept stable for older checks).
const POSTING = `SUMMARY:
Run daily deposit operations for a growing community bank, owning wires, ACH and exceptions.
DESCRIPTION:
About the role
Our operations team keeps every payment moving. You'll run the daily wire and ACH cycle and report to the Operations Manager.

What you'll do
- Process incoming and outgoing wires, verifying callbacks and OFAC results
- Balance the daily ACH files and resolve returns and NOCs
- Work the daily exception and overdraft reports
- Support branch staff with deposit questions

What you'll bring
- 2+ years in bank operations or as a teller
- Working knowledge of Reg E, Reg CC and BSA/AML
- Accuracy under deadlines

Nice to have
- Experience with Fedwire

Ready? Apply with your résumé.
Shoals Community Bank is an equal opportunity employer.`;

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
      const userText = String(body.messages?.[0]?.content || "");
      // Test hooks: simulate a slow model, a rejected key, or an out-of-credit account.
      if (userText.includes("SLOW_TEST")) return void setTimeout(() => res.writeHead(200).end("{}"), 3000);
      if (userText.includes("BADKEY_TEST")) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
      }
      if (userText.includes("NOCREDIT_TEST")) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}');
      }
      const text = sys.includes("COVER NOTE")
        ? "COVER NOTE:\nI've spent ten years in consumer lending at a community bank, working underwriting end to end, and this role matches that experience closely. I'd welcome the chance to bring it to your team.\nTIPS:\n- Lead with your underwriting experience\n- Mention your NMLS registration early\n- Mirror the posting's wording on loan servicing"
        : POSTING;
      if (body.stream) {
        // Server-sent events, as the real API streams them, a few characters at a time.
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", { message: { id: "msg_test", model: body.model } });
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        const pieces = text.match(/[\s\S]{1,37}/g);
        let i = 0;
        const tick = () => {
          if (userText.includes("MIDSTREAM_ERR_TEST") && i === 4) {
            send("error", { error: { type: "overloaded_error", message: "Overloaded" } });
            return res.end();
          }
          if (i < pieces.length) {
            send("content_block_delta", { index: 0, delta: { type: "text_delta", text: pieces[i++] } });
            return setTimeout(tick, 3);
          }
          send("content_block_stop", { index: 0 });
          send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 900 } });
          send("message_stop", {});
          res.end();
        };
        return tick();
      }
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
