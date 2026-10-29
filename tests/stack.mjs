// Shared setup for the tests: fresh Postgres database, seed data, fake Stripe, local site server.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

export const PORT = Number(process.env.TEST_PORT || 8899);
export const STRIPE_PORT = Number(process.env.TEST_STRIPE_PORT || 12111);
export const BASE = `http://localhost:${PORT}`;

export async function startStack(dbName = "bankstack_e2e") {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || "postgres://postgres@127.0.0.1:5432/postgres";
  Object.assign(process.env, {
    DATABASE_URL: adminUrl.replace(/\/[^/]*$/, `/${dbName}`), DB_DRIVER: "pg", URL: BASE,
    STRIPE_SECRET_KEY: "sk_test_e2e", STRIPE_PRICE_ID: "price_e2e_99", STRIPE_WEBHOOK_SECRET: "whsec_e2e_secret",
    STRIPE_API_HOST: "localhost", STRIPE_API_PORT: String(STRIPE_PORT), STRIPE_API_PROTOCOL: "http",
    ADMIN_TOKEN: "admin_e2e_token", LOCAL_BLOBS_DIR: mkdtempSync(path.join(os.tmpdir(), "bankstack-blobs-")),
  });
  delete process.env.RESEND_API_KEY;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  execFileSync(process.execPath, ["scripts/seed.mjs"], { env: process.env, stdio: "inherit" });

  const { startFakeStripe } = await import("./fake-stripe.mjs");
  const { startLocalServer } = await import("./local-server.mjs");
  const fakeStripe = await startFakeStripe(STRIPE_PORT);
  const site = await startLocalServer(PORT);
  const { db } = await import("../netlify/lib/shared.mjs");
  const Stripe = (await import("stripe")).default;
  const stripeLib = new Stripe("sk_test_e2e");

  const sendWebhook = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_${Date.now()}`, object: "event", type, data: { object } });
    const sig = stripeLib.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const res = await fetch(`${BASE}/api/stripe-webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: payload });
    return { status: res.status, data: await res.json() };
  };
  // Simulates the customer paying on Stripe's checkout page, then Stripe's webhook.
  const pay = async (session) => {
    const r = await fetch(`http://localhost:${STRIPE_PORT}/test/complete/${session.id}`, { method: "POST" });
    const { session: s } = await r.json();
    await sendWebhook("checkout.session.completed", s);
    return s;
  };

  return {
    fakeStripe, site, sql: db(), sendWebhook, pay,
    lastSession: () => [...fakeStripe.sessions.values()].at(-1),
    outbox: () => (globalThis.__outbox ||= []),
    async stop() { site.server.close(); fakeStripe.server.close(); await db().end?.(); },
  };
}
