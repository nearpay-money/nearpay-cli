import { streamEvents } from "@nearpay/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../src/lib/api.js";
import { CliError, InterruptedError } from "../../src/lib/errors.js";
import { runEventStream, type StreamedEvent, type StreamHandlers } from "../../src/lib/stream.js";
import type { Clock } from "../../src/lib/time.js";
import { type FakeNearPay, startFakeNearPay } from "../support/fake-nearpay.js";
import { MockApiError } from "../support/spec-mock.js";

const KEY = `rk_test_${"s".repeat(48)}`;
let fake: FakeNearPay;
beforeEach(async () => {
  fake = await startFakeNearPay();
});
afterEach(async () => {
  expect(fake.mock.violations).toEqual([]);
  await fake.close();
});

/** Real time, but backoff sleeps last 5 ms (recorded). */
function fastClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        sleeps.push(ms);
        if (signal?.aborted) return reject(new InterruptedError());
        const t = setTimeout(resolve, 5);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new InterruptedError());
        });
      }),
  };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

function harness(o: { types?: string[]; idleTimeoutMs?: number; maxConnections?: number } = {}) {
  const ac = new AbortController();
  const clock = fastClock();
  const got: StreamedEvent[] = [];
  const log: string[] = [];
  const h: StreamHandlers = {
    onReady: (r, n) => log.push(`ready#${n}:${r.resumed_after ?? "live"}`),
    onEvent: (e) => {
      got.push(e);
    },
    onReset: (r) => log.push(`reset:${r.reason}`),
    onDisconnect: (d) => log.push(`disconnect:${d.reason}`),
    onWarning: (w) => log.push(`warn:${w}`),
  };
  const api = new ApiClient({ baseUrl: fake.url, apiKey: KEY, clock });
  const done = runEventStream({ api, signal: ac.signal, clock, ...o }, h);
  return {
    ac,
    clock,
    got,
    log,
    done,
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

const pi = (id = "pi_01jbz9k3m4n5p6q7r8s9t0v1w2") => ({
  id,
  object: "payment_intent",
  created: 1,
  livemode: false,
  status: "succeeded",
  amount: 1000,
  currency: "usd",
  asset_id: null,
  description: null,
  source: "checkout",
  checkout_session: null,
  destination: {
    settlement_destination: "sd_01jbz9k3m4n5p6q7r8s9t0v1w2",
    asset_id: "nep141:usdc.near",
    type: "intents_account",
    chain: "near:mainnet",
    address: "m.near",
  },
  fee: { bearer: "payer", total_bps: 50 },
  settlement_asset_id: "nep141:usdc.near",
  amount_settled: "1",
  amount_refunded: "0",
  succeeded_at: 1,
  late: false,
  canceled_at: null,
  cancellation_reason: null,
  review_reason: null,
  attempts: [],
  overpayments: [],
  sequence: 1,
  metadata: {},
});

describe("runEventStream", () => {
  it("delivers live events with their raw JSON, object id and spec-parsed form", async () => {
    const s = harness();
    await fake.waitForStreams(1);
    const ev = fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 1);
    expect(s.got[0]).toMatchObject({ id: ev.id, type: "payment_intent.succeeded", objectId: pi().id, issue: null });
    expect(JSON.parse(s.got[0]?.raw ?? "")).toEqual(ev);
    expect(s.got[0]?.event?.id).toBe(ev.id);
    await s.stop();
    expect(s.log[0]).toBe("ready#1:live");
  });

  it("resumes with Last-Event-ID after the server closes the stream, without duplicates or gaps", async () => {
    const s = harness();
    await fake.waitForStreams(1);
    const a = fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 1);
    fake.closeStreams();
    await until(() => fake.streams.size === 0);
    const b = fake.emit("payment_intent.succeeded", pi()); // while disconnected
    await fake.waitForStreams(1);
    const c = fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 3);
    expect(s.got.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    const streamCalls = fake.mock.callsTo(streamEvents);
    expect(streamCalls[0]?.headers["last-event-id"]).toBeUndefined();
    expect(streamCalls[1]?.headers["last-event-id"]).toBe(a.id);
    expect(s.log).toContain(`ready#2:${a.id}`);
    expect(s.clock.sleeps[0]).toBeLessThanOrEqual(1200); // backoff restarts at ~1 s after a ready stream
    await s.stop();
  });

  it("reconnects after a network error and dedupes events replayed twice", async () => {
    const s = harness();
    await fake.waitForStreams(1);
    // not a valid Refund for this spec version: still delivered (raw), flagged
    const a = {
      ...fake.emit("payment_intent.succeeded", pi()),
      id: "evt_0aaaaaaaaaaaaaaaaaaaaaaaaa",
      type: "refund.created",
    };
    fake.events.splice(0);
    for (const st of fake.streams) st.sink.raw(`event: event\nid: ${a.id}\ndata: ${JSON.stringify(a)}\n\n`);
    await until(() => s.got.length === 2);
    s.got.shift();
    expect(s.got[0]?.issue).toMatch(/./);
    expect(s.got[0]?.event).toBeNull();
    expect(s.log.some((l) => l.startsWith("warn:event type refund.created does not match"))).toBe(true);
    fake.dropStreams();
    await until(() => fake.streams.size === 0);
    await fake.waitForStreams(1);
    // the server replays `a` again (at-least-once): the client must drop it
    for (const st of fake.streams) st.sink.raw(`event: event\nid: ${a.id}\ndata: ${JSON.stringify(a)}\n\n`);
    const b = fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 2);
    expect(s.got.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(
      s.log.some((l) => l.startsWith("disconnect:connection lost") || l.startsWith("disconnect:the server closed")),
    ).toBe(true);
    await s.stop();
  });

  it("warns on reset (unknown cursor) and continues live", async () => {
    const s = harness();
    await fake.waitForStreams(1);
    fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 1);
    fake.events.splice(0); // the server forgot the cursor (retention)
    fake.closeStreams();
    await until(() => s.log.includes("reset:cursor_unknown"));
    await fake.waitForStreams(1);
    fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 2);
    // after a reset the next reconnect sends no stale cursor
    fake.closeStreams();
    await until(() => fake.mock.callsTo(streamEvents).length === 3);
    expect(fake.mock.callsTo(streamEvents)[2]?.headers["last-event-id"]).toBe(s.got[1]?.id);
    await s.stop();
  });

  it("passes the type filter and only receives those types", async () => {
    const s = harness({ types: ["refund.succeeded", "payment_intent.succeeded"] });
    await fake.waitForStreams(1);
    expect(fake.mock.callsTo(streamEvents)[0]?.query.types).toBe("refund.succeeded,payment_intent.succeeded");
    fake.emit("payment_intent.created", { ...pi(), status: "requires_payment" });
    fake.emit("payment_intent.succeeded", pi());
    await until(() => s.got.length === 1);
    expect(s.got[0]?.type).toBe("payment_intent.succeeded");
    await s.stop();
  });

  it("reconnects when the connection goes silent (no heartbeat)", async () => {
    const s = harness({ idleTimeoutMs: 80 });
    await fake.waitForStreams(1);
    await until(() => s.log.some((l) => l.startsWith("disconnect:no data for")));
    await until(() => fake.mock.callsTo(streamEvents).length >= 2);
    await s.stop();
  });

  it("backs off on 429 / 5xx and honours Retry-After", async () => {
    let n = 0;
    const real = fake.mock;
    real.on(streamEvents, () => {
      n++;
      if (n === 1) throw new MockApiError("rate_limited", { headers: { "retry-after": "4" } });
      if (n === 2) throw new MockApiError("api_error");
      return { $sse: (sink) => sink.end() };
    });
    const s = harness({ maxConnections: 3 });
    await s.done;
    expect(s.clock.sleeps[0]).toBe(4000);
    expect(s.clock.sleeps[1]).toBeGreaterThanOrEqual(1600); // second failure: 2 s ± 20 %
    expect(s.log.filter((l) => l.startsWith("disconnect:"))[0]).toMatch(/too many open streams/);
  });

  it.each([
    ["livemode_forbidden", /test mode only/],
    ["event_type_unknown", /unknown event type in --events/],
    ["permission_denied", /may not read events/],
    ["authentication_required", /HTTP 401/],
    ["invalid_request", /HTTP 400/],
  ] as const)("stops on %s", async (code, msg) => {
    fake.mock.on(streamEvents, () => {
      throw new MockApiError(code, code === "event_type_unknown" ? { param: "types[0]" } : {});
    });
    const s = harness();
    await expect(s.done).rejects.toThrow(msg);
    await expect(s.done).rejects.toBeInstanceOf(CliError);
  });

  it("ignores unknown frames and id-less events with a warning; tolerates a bad ready frame", async () => {
    fake.mock.on(streamEvents, () => ({
      $sse: (sink) => {
        sink.raw('event: ready\ndata: {"object":"nope"}\n\n');
        sink.raw("event: party\ndata: {}\n\n");
        sink.raw('event: event\ndata: {"type":"x"}\n\n');
        sink.raw("event: reset\ndata: {}\n\n");
        sink.end();
      },
    }));
    const s = harness({ maxConnections: 1 });
    await s.done;
    expect(s.got).toEqual([]);
    expect(s.log.filter((l) => l.startsWith("warn:"))).toHaveLength(4);
  });

  it("returns when aborted while waiting to reconnect", async () => {
    fake.mock.on(streamEvents, () => {
      throw new MockApiError("api_error");
    });
    const ac = new AbortController();
    const clock: Clock = {
      now: Date.now,
      sleep: (_ms, signal) =>
        new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new InterruptedError()))),
    };
    const api = new ApiClient({
      baseUrl: fake.url,
      apiKey: KEY,
      clock: { now: Date.now, sleep: async () => undefined },
    });
    const done = runEventStream({ api, signal: ac.signal, clock }, { onEvent: () => undefined });
    await until(() => fake.mock.callsTo(streamEvents).length >= 1);
    ac.abort();
    await expect(done).resolves.toBeUndefined();
  });
});
