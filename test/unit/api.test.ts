import {
  createCheckoutSession,
  createCliLogin,
  createPublicInvoiceSession,
  getPaymentIntent,
  listEvents,
  simulateRefundDeposit,
  streamEvents,
  updateSubscription,
} from "@nearpay/spec";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, normaliseBaseUrl } from "../../src/lib/api.js";
import { ApiError, CliError, InterruptedError, NetworkError, parseRetryAfter } from "../../src/lib/errors.js";
import { fakeClock } from "../support/runtime.js";
import { MockApiError, type SpecMock, startSpecMock } from "../support/spec-mock.js";

const KEY = `rk_test_${"a".repeat(48)}`;
const PI = "pi_01jbz9k3m4n5p6q7r8s9t0v1w2";
let mock: SpecMock;
beforeAll(async () => {
  mock = await startSpecMock();
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

const client = (o: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) =>
  new ApiClient({ baseUrl: mock.url, apiKey: KEY, clock: fakeClock(), ...o });

describe("ApiClient", () => {
  it("sends the spec headers, a fresh Idempotency-Key per POST, and validates the response", async () => {
    let n = 0;
    mock.on(createCheckoutSession, () => {
      throw new MockApiError("currency_unsupported", { param: "currency" });
    });
    const api = client({ idempotencyKey: () => `k${++n}` });
    const err = await api
      .call(createCheckoutSession, { body: { amount: 100, currency: "usd", success_url: "https://e.x/s" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "currency_unsupported", param: "currency" });
    expect((err as ApiError).message).toMatch(/currency_unsupported, HTTP 400, request req_/);
    const call = mock.callsTo(createCheckoutSession)[0];
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.idempotencyKey).toBe("k1");
    expect(mock.violations).toEqual([]);
  });

  it("calls anonymous routes without credentials", async () => {
    mock.on(createCliLogin, () => ({ $status: 201, $body: { not: "checked here" } }));
    const api = client({ apiKey: null });
    await expect(api.call(createCliLogin, { body: { device_name: "box" } })).rejects.toThrow(/does not match/);
    expect(mock.callsTo(createCliLogin)[0]?.headers.authorization).toBeUndefined();
    expect(mock.violations).toEqual([]);
  });

  it("refuses to call authenticated routes without a key", async () => {
    await expect(client({ apiKey: null }).call(listEvents, {})).rejects.toMatchObject({ exitCode: 3 });
  });

  it("retries 5xx and network errors on safe requests with the same Idempotency-Key", async () => {
    let calls = 0;
    mock.on(simulateRefundDeposit, () => {
      calls++;
      if (calls === 1) throw new MockApiError("api_error");
      return undefined;
    });
    const api = client();
    const r = await api.call(simulateRefundDeposit, { params: { id: "re_01jbz9k3m4n5p6q7r8s9t0v1w2" }, body: {} });
    expect(r.status).toBe(202);
    const keys = mock.callsTo(simulateRefundDeposit).map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("does not retry non-idempotent POSTs", async () => {
    mock.on(createCliLogin, () => {
      throw new MockApiError("api_error");
    });
    await expect(client({ apiKey: null }).call(createCliLogin, { body: { device_name: "x" } })).rejects.toMatchObject({
      status: 500,
    });
    expect(mock.callsTo(createCliLogin)).toHaveLength(1);
  });

  it("honours Retry-After on 429 for GETs, then gives up after the budget", async () => {
    mock.on(getPaymentIntent, () => {
      throw new MockApiError("rate_limited", { headers: { "retry-after": "7" } });
    });
    const clock = fakeClock();
    const err = await client({ clock })
      .call(getPaymentIntent, { params: { id: PI } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryAfterSec: 7 });
    expect(clock.sleeps).toEqual([7000, 7000]);
  });

  it("sends Idempotency-Key on idempotent PATCH and none on GET", async () => {
    mock.on(updateSubscription, () => {
      throw new MockApiError("state_conflict");
    });
    mock.on(listEvents, () => ({ object: "list" as const, data: [], has_more: false, url: "/v1/events" }));
    await client()
      .call(updateSubscription, { params: { id: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2" }, body: {} })
      .catch(() => 0);
    await client().call(listEvents, { query: { limit: 1 } });
    expect(mock.callsTo(updateSubscription)[0]?.idempotencyKey).toMatch(/^nearpay-cli-/);
    expect(mock.callsTo(listEvents)[0]?.idempotencyKey).toBeUndefined();
    expect(mock.violations).toEqual([]);
  });

  it("validates requests with the route schemas before sending", async () => {
    await expect(client().call(getPaymentIntent, { params: { id: "nope" as never } })).rejects.toThrow(
      /invalid params/,
    );
    await expect(
      client().call(createCheckoutSession, { body: { amount: 1, currency: "USD", success_url: "x" } as never }),
    ).rejects.toThrow(/invalid body for createCheckoutSession/);
    expect(mock.calls).toHaveLength(0);
  });

  it("passes extra headers (invoice secret) and maps non-JSON error bodies", async () => {
    mock.on(createPublicInvoiceSession, () => ({ $status: 502, $body: undefined }));
    const err = await client({ apiKey: null })
      .call(createPublicInvoiceSession, {
        params: { id: "in_01jbz9k3m4n5p6q7r8s9t0v1w2" },
        headers: { "x-nearpay-invoice-secret": `in_01jbz9k3m4n5p6q7r8s9t0v1w2_secret_${"A".repeat(32)}` },
        body: {},
        retries: 0,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "api_error" });
    expect(mock.violations).toEqual([]);
  });

  it("reports unreachable hosts as NetworkError and Ctrl-C as InterruptedError", async () => {
    const api = new ApiClient({ baseUrl: "http://127.0.0.1:9", apiKey: KEY, clock: fakeClock() });
    await expect(api.call(getPaymentIntent, { params: { id: PI } })).rejects.toBeInstanceOf(NetworkError);
    const ac = new AbortController();
    const hang = new ApiClient({
      baseUrl: mock.url,
      apiKey: KEY,
      fetch: (_u, init) =>
        new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const p = hang.call(getPaymentIntent, { params: { id: PI }, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(InterruptedError);
  });

  it("times out slow requests", async () => {
    const api = new ApiClient({
      baseUrl: mock.url,
      apiKey: KEY,
      timeoutMs: 20,
      clock: fakeClock(),
      fetch: (_u, init) =>
        new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    await expect(api.call(getPaymentIntent, { params: { id: PI }, retries: 0 })).rejects.toThrow(
      /timed out after 20 ms/,
    );
  });

  it("rejects 2xx bodies that are not JSON", async () => {
    const api = client({ fetch: async () => new Response("<html>", { status: 200 }) });
    await expect(api.call(getPaymentIntent, { params: { id: PI } })).rejects.toThrow(/not JSON/);
  });

  it("opens streams only as text/event-stream and maps stream errors", async () => {
    mock.on(streamEvents, () => {
      throw new MockApiError("livemode_forbidden");
    });
    await expect(client().stream(streamEvents, {})).rejects.toMatchObject({ code: "livemode_forbidden" });
    const notSse = client({
      fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(notSse.stream(streamEvents, {})).rejects.toBeInstanceOf(NetworkError);
    await expect(client().call(streamEvents as never, {} as never)).rejects.toThrow(/is a stream/);
    await expect(client().stream(listEvents as never, {} as never)).rejects.toThrow(/not a stream/);
  });
});

describe("normaliseBaseUrl", () => {
  it("accepts https and loopback http, strips trailing slashes", () => {
    expect(normaliseBaseUrl("https://api.nearpay.money/")).toBe("https://api.nearpay.money");
    expect(normaliseBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normaliseBaseUrl("http://api.nearpay.localhost")).toBe("http://api.nearpay.localhost");
  });

  it("rejects plain http elsewhere, garbage, queries", () => {
    expect(() => normaliseBaseUrl("http://api.example.com")).toThrow(CliError);
    expect(() => normaliseBaseUrl("not a url")).toThrow(/invalid API base/);
    expect(() => normaliseBaseUrl("https://a.example?x=1")).toThrow(/query/);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter("garbage")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(" ")).toBeNull();
  });
});
