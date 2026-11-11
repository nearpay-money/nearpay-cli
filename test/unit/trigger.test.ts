import {
  CLI_KEY_SCOPES,
  createRefund,
  getPaymentIntent,
  payCheckoutSessionTestHelper,
  simulateRefundDeposit,
  WEBHOOK_TYPE_NAMES,
  type WebhookType,
} from "@nearpay-money/spec";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../src/lib/api.js";
import { CliError } from "../../src/lib/errors.js";
import { systemClock } from "../../src/lib/time.js";
import {
  AMOUNTS,
  fixtureFor,
  invoiceSecretFrom,
  refundAmount,
  TRIGGERS,
  type TriggerContext,
  waitForEvent,
} from "../../src/lib/trigger.js";
import { type FakeNearPay, startFakeNearPay } from "../support/fake-nearpay.js";
import { MockApiError } from "../support/spec-mock.js";

const RK = `rk_test_${"t".repeat(48)}`;
const SK = `sk_test_${"t".repeat(48)}`;
let fake: FakeNearPay;
beforeAll(async () => {
  fake = await startFakeNearPay({ settleMs: 5 });
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.mock.violations.splice(0);
});

const ctx = (key = RK, o: Partial<TriggerContext> = {}): TriggerContext & { steps: string[] } => {
  const steps: string[] = [];
  return {
    api: new ApiClient({ baseUrl: fake.url, apiKey: key }),
    clock: systemClock,
    signal: new AbortController().signal,
    step: (m) => steps.push(m),
    keyKind: key.startsWith("sk_") ? "secret" : "restricted",
    waitMs: 5000,
    pollMs: 10,
    steps,
    ...o,
  };
};

const supported = WEBHOOK_TYPE_NAMES.filter((t) => TRIGGERS[t].kind === "supported" && t !== "payment_intent.canceled");

describe("trigger fixtures", () => {
  it("cover every public webhook type with a fixture or a reason", () => {
    for (const t of WEBHOOK_TYPE_NAMES) {
      const f = fixtureFor(t);
      expect(f, t).not.toBeNull();
      if (f?.kind === "unsupported") expect(f.reason.length, t).toBeGreaterThan(20);
    }
    expect(fixtureFor("nope.nope")).toBeNull();
    expect(supported).toEqual(
      expect.arrayContaining(["payment_intent.succeeded", "payment_intent.payment_failed", "invoice.paid"]),
    );
    // every refund type but refund.failed: a leg failing after the transfer is held for review on the real stack
    expect(
      WEBHOOK_TYPE_NAMES.filter((t) => t.startsWith("refund.") && t !== "refund.failed").every(
        (t) => TRIGGERS[t].kind === "supported",
      ),
    ).toBe(true);
    expect(TRIGGERS["refund.failed"]).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/held/) });
  });

  it.each(supported)("%s: real API calls with the CLI key produce the event", async (type) => {
    const c = ctx();
    const since = Math.floor(Date.now() / 1000);
    const f = TRIGGERS[type as WebhookType];
    if (f.kind !== "supported") throw new Error("unreachable");
    const outcome = await f.run(c);
    expect(outcome.target.type).toBe(type);
    const id = await waitForEvent(c, outcome.target, since, 5000);
    expect(id, `${type} on ${outcome.target.objectId}`).toMatch(/^evt_/);
    expect(c.steps.length).toBeGreaterThan(0);
    expect(fake.mock.violations).toEqual([]);
    // only scopes the CLI login key holds were needed
    expect(
      fake.mock.calls
        .filter((x) => x.keyKind === "rk")
        .every((x) => {
          const need = x.route.auth.find((a) => a.startsWith("restricted_key:"))?.slice(15);
          return need !== undefined && (CLI_KEY_SCOPES as readonly string[]).includes(need);
        }),
    ).toBe(true);
  });

  it("payment_intent.canceled needs a secret key and works with one", async () => {
    const f = TRIGGERS["payment_intent.canceled"];
    if (f.kind !== "supported") throw new Error("unreachable");
    await expect(f.run(ctx())).rejects.toThrow(/payment_intents\.write/);
    const c = ctx(SK);
    const since = Math.floor(Date.now() / 1000);
    const o = await f.run(c);
    expect(await waitForEvent(c, o.target, since, 5000)).toMatch(/^evt_/);
  });

  it("drives the documented sandbox scenarios", async () => {
    const pays = fake.mock.callsTo(payCheckoutSessionTestHelper);
    expect(pays.some((p) => p.body.outcome === "none")).toBe(true); // overpaid: older open quote first
    const sims = fake.mock.callsTo(simulateRefundDeposit).length;
    expect(sims).toBeGreaterThanOrEqual(2);
    const amounts = fake.mock.callsTo(createRefund).map((r) => BigInt(r.body.amount ?? "0") % 100n);
    expect(amounts.every((a) => a === 0n)).toBe(true);
    expect(AMOUNTS).toEqual({ normal: 1000, short: 1005, duplicate: 1006 });
  });

  it("times out waiting for an intent that never succeeds, and reports one that went elsewhere", async () => {
    const f = TRIGGERS["refund.created"];
    if (f.kind !== "supported") throw new Error("unreachable");
    fake.mock.on(getPaymentIntent, () => {
      throw new MockApiError("resource_missing");
    });
    await expect(f.run(ctx())).rejects.toMatchObject({ status: 404 });
    // restore the fake's handler by restarting
    await fake.close();
    fake = await startFakeNearPay({ settleMs: 5 });
    const slow = await startFakeNearPay({ settleMs: 10_000 });
    try {
      const c = { ...ctx(), api: new ApiClient({ baseUrl: slow.url, apiKey: RK }), waitMs: 50 };
      await expect(f.run(c)).rejects.toMatchObject({ exitCode: 4, message: expect.stringMatching(/timed out/) });
    } finally {
      await slow.close();
    }
  });

  it("waitForEvent returns null when the event does not appear in time", async () => {
    const c = ctx();
    expect(
      await waitForEvent(c, { type: "refund.succeeded", objectId: "re_01jbz9k3m4n5p6q7r8s9t0v1w2" }, 0, 30),
    ).toBeNull();
  });
});

describe("refundAmount", () => {
  it("picks the largest amount ≤ settled with the scenario suffix", () => {
    expect(refundAmount("9950037", 0)).toBe("9950000");
    expect(refundAmount("9950037", 4)).toBe("9950004");
    expect(refundAmount("9950002", 4)).toBe("9949904");
    expect(() => refundAmount("50", 0)).toThrow(CliError);
  });

  it("property: result ≤ settled, > 0 and ends in the suffix", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 200n, max: 10n ** 30n }), fc.constantFrom(0 as const, 4 as const), (s, suffix) => {
        const a = BigInt(refundAmount(s.toString(), suffix));
        expect(a <= s && a > 0n).toBe(true);
        expect(a % 100n).toBe(BigInt(suffix));
        expect(s - a < 200n).toBe(true);
      }),
    );
  });
});

describe("invoiceSecretFrom", () => {
  const id = "in_01jbz9k3m4n5p6q7r8s9t0v1w2";
  it("reads the secret from the URL fragment", () => {
    const secret = `${id}_secret_${"A".repeat(32)}`;
    expect(invoiceSecretFrom({ id, hosted_invoice_url: `https://pay.nearpay.money/i/${id}#${secret}` })).toBe(secret);
  });
  it("rejects missing or malformed secrets", () => {
    expect(() => invoiceSecretFrom({ id, hosted_invoice_url: null })).toThrow(/no hosted_invoice_url/);
    expect(() => invoiceSecretFrom({ id, hosted_invoice_url: `https://pay.nearpay.money/i/${id}#nope` })).toThrow(
      /does not carry/,
    );
  });
});
