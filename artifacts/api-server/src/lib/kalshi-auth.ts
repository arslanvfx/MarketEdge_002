import crypto from "crypto";

/** Normalizes Kalshi's dashboard-exported raw RSA key into a PEM key. */
export function getKalshiPrivateKey(): string | null {
  const raw = process.env["KALSHI_PRIVATE_KEY"] ?? null;
  if (!raw) return null;
  if (raw.includes("-----BEGIN")) return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const lines = raw.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return ["-----BEGIN RSA PRIVATE KEY-----", ...lines, "-----END RSA PRIVATE KEY-----"].join("\n");
}

export function getKalshiKeyId(): string | null {
  return process.env["KALSHI_API_KEY_ID"] ?? null;
}

export function hasKalshiCredentials(): boolean {
  return Boolean(getKalshiKeyId() && getKalshiPrivateKey());
}

/**
 * Signs the exact Kalshi protocol string. Callers provide the full API path
 * prefix so REST v2 and websocket v2 cannot accidentally sign each other's
 * paths. Query strings are intentionally excluded by Kalshi's REST protocol.
 */
export function makeKalshiSignedHeaders(
  method: string,
  signingPath: string,
  contentType = true,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (contentType) headers["Content-Type"] = "application/json";
  const keyId = getKalshiKeyId();
  const privateKey = getKalshiPrivateKey();
  if (!keyId || !privateKey) return headers;
  const timestamp = Date.now().toString();
  const path = signingPath.split("?")[0];
  const signer = crypto.createSign("SHA256");
  signer.update(timestamp + method.toUpperCase() + path);
  signer.end();
  headers["KALSHI-ACCESS-KEY"] = keyId;
  headers["KALSHI-ACCESS-TIMESTAMP"] = timestamp;
  headers["KALSHI-ACCESS-SIGNATURE"] = signer.sign(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
    "base64",
  );
  return headers;
}