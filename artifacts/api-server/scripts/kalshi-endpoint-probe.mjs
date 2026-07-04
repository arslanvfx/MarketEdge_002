import crypto from "crypto";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

function getPrivateKey() {
  const raw = process.env["KALSHI_PRIVATE_KEY"] ?? null;
  if (!raw) return null;
  if (raw.includes("-----BEGIN")) {
    return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  }
  const b64 = raw.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return ["-----BEGIN RSA PRIVATE KEY-----", ...lines, "-----END RSA PRIVATE KEY-----"].join("\n");
}

function headers(method, path) {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  const keyId = process.env["KALSHI_API_KEY_ID"] ?? null;
  const pem = getPrivateKey();
  if (!keyId || !pem) return h;
  const ts = Date.now().toString();
  const pathNoQuery = path.split("?")[0];
  const msg = ts + method.toUpperCase() + "/trade-api/v2" + pathNoQuery;
  const sign = crypto.createSign("SHA256");
  sign.update(msg);
  sign.end();
  const sig = sign.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, "base64");
  h["KALSHI-ACCESS-KEY"] = keyId;
  h["KALSHI-ACCESS-TIMESTAMP"] = ts;
  h["KALSHI-ACCESS-SIGNATURE"] = sig;
  return h;
}

async function probe(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(method, path),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    console.log(`\n${method} ${path} → ${res.status}`);
    console.log(text.slice(0, 500));
  } catch (e) {
    console.log(`\n${method} ${path} → ERROR ${e.message}`);
  }
}

// 1. Auth sanity: read-only list orders (classic path)
await probe("GET", "/portfolio/orders?limit=1");

// 2. Is the classic single-order POST deprecated (410) or valid (400 on bad body)?
//    Deliberately incomplete body so nothing is ever placed.
await probe("POST", "/portfolio/orders", { client_order_id: crypto.randomUUID() });

// 3. Same probe against the events/orders path we currently use.
await probe("POST", "/portfolio/events/orders", { client_order_id: crypto.randomUUID() });

// 4. Validate the EXACT v2 body shape placeOrder() now builds, using a
//    non-existent ticker so the schema is checked but no real order can match.
//    Expected: NOT "side must be bid or ask" / price errors — instead a
//    market/ticker-not-found error, proving the body shape is accepted.
await probe("POST", "/portfolio/events/orders", {
  client_order_id: crypto.randomUUID(),
  ticker: "NONEXISTENT-PROBE-TICKER-ZZZ",
  side: "bid",
  count: "1",
  price: "0.0100",
  time_in_force: "fill_or_kill",
  self_trade_prevention_type: "taker_at_cross",
});
