// A small stateful stand-in for the parts of the Stripe API this site calls.
// The real `stripe` Node library talks to it over HTTP (STRIPE_API_HOST/PORT/PROTOCOL), so the site's
// Stripe code runs unchanged. Test-only helpers live under /test/*.
import http from "node:http";
import crypto from "node:crypto";

const id = (p) => `${p}_test_${crypto.randomBytes(8).toString("hex")}`;

// Stripe sends application/x-www-form-urlencoded with bracket keys: a[b][0][c]=v
function parseForm(body) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const keys = rawKey.replace(/\]/g, "").split("[");
    let node = out;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(keys[i + 1]);
      if (last) {
        if (k === "" && Array.isArray(node)) node.push(value);
        else node[k] = value;
      } else {
        node[k] ??= nextIsIndex || keys[i + 1] === "" ? [] : {};
        node = node[k];
      }
    });
  }
  return out;
}

export function startFakeStripe(port = 12111) {
  const sessions = new Map(), subs = new Map(), customers = new Map();
  const periodEnd = (days = 30) => Math.floor(Date.now() / 1000) + days * 86400;

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const form = parseForm(body);
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const notFound = () => send(404, { error: { type: "invalid_request_error", message: "No such object" } });
    let m;

    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const s = {
        id: id("cs"), object: "checkout.session", mode: form.mode, status: "open", payment_status: "unpaid",
        url: `https://checkout.stripe.test/pay/${Date.now()}`, client_reference_id: form.client_reference_id ?? null,
        customer: form.customer ?? null, customer_email: form.customer_email ?? null, metadata: form.metadata || {},
        subscription: null, _price: form.line_items?.[0]?.price, _subscription_metadata: form.subscription_data?.metadata || {},
        success_url: form.success_url, cancel_url: form.cancel_url,
      };
      sessions.set(s.id, s);
      return send(200, s);
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const s = sessions.get(m[1]);
      if (!s) return notFound();
      const expand = url.searchParams.getAll("expand[]").concat(url.searchParams.getAll("expand[0]"));
      return send(200, { ...s, subscription: expand.includes("subscription") && s.subscription ? subs.get(s.subscription) : s.subscription });
    }
    if ((m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const sub = subs.get(m[1]);
      if (!sub) return notFound();
      if (req.method === "GET") return send(200, sub);
      if (req.method === "POST") {
        if ("cancel_at_period_end" in form) sub.cancel_at_period_end = form.cancel_at_period_end === "true";
        return send(200, sub);
      }
      if (req.method === "DELETE") { sub.status = "canceled"; sub.canceled_at = Math.floor(Date.now() / 1000); return send(200, sub); }
    }
    if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      if (!customers.has(form.customer)) return notFound();
      return send(200, { id: id("bps"), object: "billing_portal.session", url: `https://billing.stripe.test/p/${form.customer}`, return_url: form.return_url });
    }

    // ---- test helpers ----
    if (req.method === "POST" && (m = url.pathname.match(/^\/test\/complete\/([^/]+)$/))) {
      const s = sessions.get(m[1]);
      if (!s) return notFound();
      const customer = s.customer || id("cus");
      customers.set(customer, { id: customer, email: s.customer_email });
      const sub = {
        id: id("sub"), object: "subscription", status: "active", customer, cancel_at_period_end: false,
        metadata: s._subscription_metadata,
        items: { object: "list", data: [{ id: id("si"), price: { id: s._price, unit_amount: 9900, recurring: { interval: "month" } }, current_period_end: periodEnd() }] },
      };
      subs.set(sub.id, sub);
      Object.assign(s, { status: "complete", payment_status: "paid", customer, subscription: sub.id });
      return send(200, { session: s, subscription: sub });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/test\/subscriptions\/([^/]+)$/))) {
      const sub = subs.get(m[1]);
      if (!sub) return notFound();
      const patch = JSON.parse(body || "{}");
      if (patch.status) sub.status = patch.status;
      if (patch.renew) sub.items.data[0].current_period_end = periodEnd(60);
      return send(200, sub);
    }
    return send(404, { error: { message: `fake-stripe: unhandled ${req.method} ${url.pathname}` } });
  });

  return new Promise((resolve) => server.listen(port, () => resolve({ server, sessions, subs, customers })));
}
