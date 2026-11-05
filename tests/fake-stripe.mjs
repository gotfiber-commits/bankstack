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
  const sessions = new Map(), subs = new Map(), customers = new Map(), prices = new Map();
  const invoices = []; // every charge the site caused: { subscription, amount, reason }
  const declining = new Set(); // customers whose card is declined
  const now = () => Math.floor(Date.now() / 1000);
  const periodEnd = (days = 30) => now() + days * 86400;
  // Graduated tiers, as Stripe computes them.
  const amountFor = (price, qty) => {
    if (!price?.tiers) return (price?.unit_amount || 0) * qty;
    let total = 0, below = 0;
    for (const t of price.tiers) {
      const top = t.up_to == null ? Infinity : Number(t.up_to);
      const units = Math.max(0, Math.min(qty, top) - below);
      if (units > 0) total += Number(t.flat_amount || 0) + Number(t.unit_amount || 0) * units;
      below = top;
      if (qty <= top) break;
    }
    return total;
  };

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const form = parseForm(body);
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const notFound = () => send(404, { error: { type: "invalid_request_error", message: "No such object" } });
    let m;

    if (req.method === "POST" && url.pathname === "/v1/prices") {
      const p = {
        id: id("price"), object: "price", active: true, currency: form.currency, nickname: form.nickname || null,
        billing_scheme: form.billing_scheme || "per_unit", tiers_mode: form.tiers_mode || null,
        recurring: { interval: form.recurring?.interval || "month" }, lookup_key: form.lookup_key || null,
        unit_amount: form.unit_amount ? Number(form.unit_amount) : null, product: id("prod"),
        tiers: form.tiers ? form.tiers.map((t) => ({ up_to: t.up_to === "inf" ? null : Number(t.up_to),
          flat_amount: Number(t.flat_amount || 0), unit_amount: Number(t.unit_amount || 0) })) : null,
      };
      if (p.lookup_key && form.transfer_lookup_key === "true") for (const q of prices.values()) if (q.lookup_key === p.lookup_key) q.lookup_key = null;
      prices.set(p.id, p);
      return send(200, p);
    }
    if (req.method === "GET" && url.pathname === "/v1/prices") {
      const q = parseForm(url.search.slice(1));
      const keys = q.lookup_keys || [];
      const data = [...prices.values()].filter((p) => p.active && (!keys.length || keys.includes(p.lookup_key)));
      return send(200, { object: "list", data: data.reverse().slice(0, Number(q.limit || 10)), has_more: false });
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/v1\/prices\/([^/]+)$/))) {
      return prices.has(m[1]) ? send(200, prices.get(m[1])) : notFound();
    }
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const s = {
        id: id("cs"), object: "checkout.session", mode: form.mode, status: "open", payment_status: "unpaid",
        url: `https://checkout.stripe.test/pay/${Date.now()}`, client_reference_id: form.client_reference_id ?? null,
        customer: form.customer ?? null, customer_email: form.customer_email ?? null, metadata: form.metadata || {},
        subscription: null, _price: form.line_items?.[0]?.price, _quantity: Number(form.line_items?.[0]?.quantity || 1),
        _subscription_metadata: form.subscription_data?.metadata || {},
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
        if (form.items) {
          const change = form.items[0];
          const item = sub.items.data.find((i) => i.id === change.id);
          if (!item) return send(400, { error: { type: "invalid_request_error", message: `No such subscription item: '${change.id}'` } });
          const qty = Number(change.quantity);
          const before = amountFor(item.price, item.quantity), after = amountFor(item.price, qty);
          const end = item.current_period_end, start = item.current_period_start;
          const prorated = Math.round((after - before) * Math.max(0, end - now()) / Math.max(1, end - start));
          if (form.proration_behavior === "always_invoice" && prorated > 0) {
            if (declining.has(sub.customer) && form.payment_behavior === "error_if_incomplete") {
              return send(402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } });
            }
            invoices.push({ subscription: sub.id, amount: prorated, reason: "subscription_update", quantity: qty });
          }
          item.quantity = qty;
          sub.quantity = qty;
        }
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
      const price = prices.get(s._price) || { id: s._price, unit_amount: 9900, recurring: { interval: "month" } };
      const sub = {
        id: id("sub"), object: "subscription", status: "active", customer, cancel_at_period_end: false,
        metadata: s._subscription_metadata, quantity: s._quantity,
        items: { object: "list", data: [{ id: id("si"), price, quantity: s._quantity, current_period_start: now(), current_period_end: periodEnd() }] },
      };
      subs.set(sub.id, sub);
      invoices.push({ subscription: sub.id, amount: amountFor(price, s._quantity), reason: "subscription_create", quantity: s._quantity });
      Object.assign(s, { status: "complete", payment_status: "paid", customer, subscription: sub.id });
      return send(200, { session: s, subscription: sub });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/test\/subscriptions\/([^/]+)$/))) {
      const sub = subs.get(m[1]);
      if (!sub) return notFound();
      const patch = JSON.parse(body || "{}");
      if (patch.status) sub.status = patch.status;
      if (patch.renew) {
        // A new month: bill the current quantity and move the period on.
        const item = sub.items.data[0];
        item.current_period_start = item.current_period_end > now() ? now() : item.current_period_end;
        item.current_period_end = periodEnd(30);
        invoices.push({ subscription: sub.id, amount: amountFor(item.price, item.quantity ?? 1), reason: "subscription_cycle", quantity: item.quantity ?? 1 });
      }
      if (patch.expire) { sub.items.data[0].current_period_end = now() - 86400 * 5; }
      return send(200, sub);
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/test\/customers\/([^/]+)\/decline$/))) {
      const on = JSON.parse(body || "{}").decline !== false;
      if (on) declining.add(m[1]); else declining.delete(m[1]);
      return send(200, { ok: true });
    }
    return send(404, { error: { message: `fake-stripe: unhandled ${req.method} ${url.pathname}` } });
  });

  return new Promise((resolve) => server.listen(port, () => resolve({ server, sessions, subs, customers, prices, invoices, amountFor })));
}
