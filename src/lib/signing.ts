/**
 * Local webhook signing for `listen --forward-to` — the same `NearPay-Signature` scheme as webhook
 * deliveries (api-conventions §9, lld/webhooks.md §6): `t=<unix>,v1=<hex HMAC-SHA256>` where the HMAC key
 * is the UTF-8 bytes of the whole `whsec_…` secret and the message is `<t>.<raw body>`. Only `v1`: the
 * CLI has no platform Ed25519 key, so there is no `v1a` (sdks-and-tools §3). `@nearpay-money/node`
 * `constructEvent(rawBody, header, secret)` verifies it with the secret printed by `listen`.
 */
import { createHmac, randomBytes } from "node:crypto";
import { formatSignatureHeader, signedPayload } from "@nearpay-money/spec";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Characters after `whsec_` (spec `WebhookEndpoint.secret`: 32–64 of [0-9A-Za-z]); 40 × log2(62) ≈ 238 bits. */
export const LOCAL_SECRET_LENGTH = 40;

/** A fresh per-session secret `whsec_` + 40 base62 characters (unbiased: rejection sampling). */
export function generateWebhookSecret(rand: (n: number) => Uint8Array = randomBytes): string {
  let out = "";
  while (out.length < LOCAL_SECRET_LENGTH) {
    for (const b of rand(64)) {
      if (b >= 248) continue; // 248 = 4 × 62: keep the distribution uniform
      out += ALPHABET[b % 62];
      if (out.length === LOCAL_SECRET_LENGTH) break;
    }
  }
  return `whsec_${out}`;
}

/** hex(HMAC-SHA256(key = UTF-8 secret incl. `whsec_`, msg = UTF-8 `<t>.<raw body>`)). */
export function computeV1(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(signedPayload(timestamp, rawBody), "utf8"))
    .digest("hex");
}

/** The `NearPay-Signature` header value for `rawBody` at `timestamp` (unix seconds). */
export function signatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return formatSignatureHeader({ timestamp, v1: [computeV1(secret, timestamp, rawBody)] });
}
