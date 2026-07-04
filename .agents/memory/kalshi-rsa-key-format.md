---
name: Kalshi RSA key format
description: KALSHI_PRIVATE_KEY is stored as raw base64 (no PEM headers); getPrivateKey() must wrap it before use.
---

The `KALSHI_PRIVATE_KEY` Replit secret is pasted as raw base64 content — no `-----BEGIN RSA PRIVATE KEY-----` wrapper. Node.js `crypto.sign()` requires proper PEM; passing headerless base64 throws `error:1E08010C:DECODER routines::unsupported`.

**Fix in `getPrivateKey()` (kalshi-trader.ts):**
```typescript
if (!raw.includes("-----BEGIN")) {
  const b64 = raw.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return ["-----BEGIN RSA PRIVATE KEY-----", ...lines, "-----END RSA PRIVATE KEY-----"].join("\n");
}
```

**Why:** Key is PKCS#1 RSA (starts with `MIIEowIBAAKCAQEA` = SEQUENCE + version INTEGER 0 + modulus).  The code also handles the case where the key already has headers (identity path) and escaped `\n` literals.

**How to apply:** Any time `makeSignedHeaders` silently returns unsigned headers (or the balance endpoint returns `DECODER routines::unsupported`), check the key format first — don't hunt for signing algorithm bugs.
