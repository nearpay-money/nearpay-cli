import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constructEvent } from "@nearpay/node";
import { parseSignatureHeader, WebhookEndpoint } from "@nearpay/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeV1, generateWebhookSecret, LOCAL_SECRET_LENGTH, signatureHeader } from "../../src/lib/signing.js";

const require = createRequire(import.meta.url);
const vectors = JSON.parse(
  readFileSync(require.resolve("@nearpay/spec/test-vectors/webhook-signatures.json"), "utf8"),
) as {
  secret: string;
  timestamp: number;
  raw_body: string;
  header: string;
};
const secretSchema = WebhookEndpoint.shape.secret;

describe("local webhook signing", () => {
  it("matches the spec test vector's v1 signature byte for byte", () => {
    const expected = parseSignatureHeader(vectors.header)?.v1[0];
    expect(computeV1(vectors.secret, vectors.timestamp, vectors.raw_body)).toBe(expected);
    expect(signatureHeader(vectors.secret, vectors.timestamp, vectors.raw_body)).toBe(
      `t=${vectors.timestamp},v1=${expected}`,
    );
  });

  it("has no v1a (the CLI holds no platform Ed25519 key)", () => {
    const h = parseSignatureHeader(signatureHeader(vectors.secret, 1, "{}"));
    expect(h?.v1a).toBeNull();
    expect(h?.kid).toBeNull();
  });

  it("is verified by @nearpay/node constructEvent with the printed secret", () => {
    const secret = generateWebhookSecret();
    const t = Math.floor(Date.now() / 1000);
    const ev = constructEvent(vectors.raw_body, signatureHeader(secret, t, vectors.raw_body), secret);
    expect(ev.id).toBe("evt_01jbz9k3m4n5p6q7r8s9t0v1w2");
    expect(() =>
      constructEvent(vectors.raw_body, signatureHeader(secret, t, vectors.raw_body), generateWebhookSecret()),
    ).toThrow();
  });

  it("property: any body signed with any generated secret verifies, and a changed body does not", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.integer({ min: 0, max: 2 ** 31 }), (text, t) => {
        const secret = generateWebhookSecret();
        const body = JSON.stringify({
          id: "evt_01jbz9k3m4n5p6q7r8s9t0v1w2",
          object: "event",
          type: "payment_intent.succeeded",
          note: text,
        });
        const header = signatureHeader(secret, t, body);
        expect(() => constructEvent(body, header, secret, { now: t })).not.toThrow();
        expect(() => constructEvent(`${body} `, header, secret, { now: t })).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("generates secrets in the spec's whsec_ format, fresh each time", () => {
    const a = generateWebhookSecret();
    expect(secretSchema.safeParse(a).success).toBe(true);
    expect(a).toHaveLength(6 + LOCAL_SECRET_LENGTH);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it("rejection-samples bytes ≥ 248 (no modulo bias) and keeps drawing until it has 40 characters", () => {
    let calls = 0;
    const s = generateWebhookSecret((n) => {
      calls++;
      // first draw: only rejected bytes, then 0..61 repeated
      return calls === 1 ? new Uint8Array(n).fill(250) : Uint8Array.from({ length: n }, (_, i) => i % 62);
    });
    expect(calls).toBe(2);
    expect(s).toBe(`whsec_${"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd"}`);
  });
});
