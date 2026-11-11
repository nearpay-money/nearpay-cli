import { CliLogin, createCliLogin, pollCliLogin } from "@nearpay-money/spec";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../src/lib/api.js";
import { CliError, InterruptedError } from "../../src/lib/errors.js";
import { deviceLogin, deviceNameFrom, type LoginDeps, SLOW_DOWN_STEP_S } from "../../src/lib/login.js";
import { createOutput } from "../../src/lib/output.js";
import { captureIo, fakeClock } from "../support/runtime.js";
import { MockApiError, type SpecMock, startSpecMock } from "../support/spec-mock.js";

let mock: SpecMock;
beforeAll(async () => {
  mock = await startSpecMock();
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

const SECRET = `rk_test_${"b".repeat(48)}`;
const ACCOUNT = { id: "acct_01jbz9k3m4n5p6q7r8s9t0v1w2", display_name: "Acme" } as const;
const key = (secret = SECRET, livemode = false) => ({
  id: "key_01jbz9k3m4n5p6q7r8s9t0v1w2",
  object: "api_key",
  created: 1,
  livemode,
  type: "restricted",
  name: "CLI · test-host",
  display_prefix: secret.slice(0, 8),
  last4: secret.slice(-4),
  scopes: ["events.read"],
  ip_allowlist: [],
  expires_at: 2_000_000_000,
  last_used_at: null,
  secret,
});

function setup(o: { interval?: number; ttl?: number; url?: string } = {}) {
  const clock = fakeClock();
  const nowS = () => Math.floor(clock.now() / 1000);
  mock.on(createCliLogin, () =>
    CliLogin.parse({
      object: "cli_login",
      device_code: `npdc_${"x".repeat(43)}`,
      user_code: "BCDF-GHJK",
      verification_url: "https://dashboard.nearpay.localhost/cli",
      verification_url_complete: o.url ?? "https://dashboard.nearpay.localhost/cli?code=BCDF-GHJK",
      expires_at: nowS() + (o.ttl ?? 900),
      interval: o.interval ?? 5,
    }),
  );
  const { io, captured } = captureIo({ NO_COLOR: "1" });
  const opened: string[] = [];
  const ac = new AbortController();
  const deps: LoginDeps = {
    api: new ApiClient({ baseUrl: mock.url, clock }),
    clock,
    out: createOutput(io),
    openUrl: async (u) => {
      opened.push(u);
      return true;
    },
    deviceName: "test-host",
    clientVersion: "0.2.0",
    openBrowser: true,
    signal: ac.signal,
  };
  return { clock, deps, captured, opened, ac };
}

/** Scripts poll answers in order (the last one repeats). */
function polls(...answers: (() => unknown)[]) {
  let i = 0;
  mock.on(pollCliLogin, () => {
    const a = answers[Math.min(i++, answers.length - 1)] as () => unknown;
    return a() as never;
  });
}
const status =
  (s: string, extra: Record<string, unknown> = {}) =>
  () => ({
    object: "cli_login_poll",
    status: s,
    interval: 5,
    ...extra,
  });

describe("deviceLogin", () => {
  it("shows the code, opens the browser, waits `interval` between polls and returns the approved key", async () => {
    const { deps, clock, captured, opened } = setup();
    polls(status("pending"), status("pending"), status("approved", { key: key(), account: ACCOUNT }));
    const r = await deviceLogin(deps);
    expect(r.key.secret).toBe(SECRET);
    expect(r.account).toEqual(ACCOUNT);
    expect(clock.sleeps).toEqual([5000, 5000, 5000]);
    expect(opened).toEqual(["https://dashboard.nearpay.localhost/cli?code=BCDF-GHJK"]);
    expect(captured.stderr).toContain("Your pairing code is: BCDF-GHJK");
    const create = mock.callsTo(createCliLogin)[0];
    expect(create?.body).toEqual({ device_name: "test-host", client_version: "0.2.0" });
    expect(create?.headers.authorization).toBeUndefined();
    expect(mock.violations).toEqual([]);
  });

  it("treats 429 as slow_down: waits Retry-After and adds 5 s to the interval for good", async () => {
    const { deps, clock } = setup();
    let n = 0;
    mock.on(pollCliLogin, () => {
      n++;
      if (n === 1) throw new MockApiError("rate_limited", { headers: { "retry-after": "12" } });
      if (n === 2) throw new MockApiError("rate_limited", { headers: { "retry-after": "1" } });
      if (n === 3) return status("pending")() as never;
      return status("approved", { key: key(), account: ACCOUNT })() as never;
    });
    await deviceLogin(deps);
    // 5 → (429, Retry-After 12, interval 10) 12 → (429, Retry-After 1, interval 15) 15 → pending 15 → approved
    expect(clock.sleeps).toEqual([5000, 12_000, 15_000, 15_000]);
    expect(SLOW_DOWN_STEP_S).toBe(5);
  });

  it("follows a larger interval from the server", async () => {
    const { deps, clock } = setup();
    polls(status("pending", { interval: 9 }), status("approved", { key: key(), account: ACCOUNT }));
    await deviceLogin(deps);
    expect(clock.sleeps).toEqual([5000, 9000]);
  });

  it.each([
    ["denied", /denied in the dashboard/],
    ["expired", /expired before it was approved/],
    ["redeemed", /already delivered/],
  ])("stops on %s", async (s, msg) => {
    const { deps } = setup();
    polls(status(s));
    await expect(deviceLogin(deps)).rejects.toThrow(msg);
  });

  it("stops at expires_at after one last poll, without polling past it", async () => {
    const { deps, clock } = setup({ ttl: 12 });
    polls(status("pending"));
    await expect(deviceLogin(deps)).rejects.toThrow(/expired/);
    expect(clock.sleeps).toEqual([5000, 5000, 2000]);
    expect(mock.callsTo(pollCliLogin)).toHaveLength(3);
  });

  it("clamps the deadline to the login lifetime when the local clock is off", async () => {
    const { deps, clock } = setup({ ttl: 100_000 });
    polls(status("pending"));
    await expect(deviceLogin(deps)).rejects.toThrow(/expired/);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(900_000);
  });

  it("keeps polling on an unknown (newer) status", async () => {
    const { deps } = setup();
    // the spec mock refuses unknown enum values in responses, so the newer status is a raw reply
    mock.on(
      pollCliLogin,
      (() => {
        let i = 0;
        return () => {
          i++;
          if (i === 2)
            return { $status: 200, $body: { object: "cli_login_poll", status: "awaiting_mfa", interval: 5 } };
          return (i === 1 ? status("pending")() : status("approved", { key: key(), account: ACCOUNT })()) as never;
        };
      })(),
    );
    await expect(deviceLogin(deps)).resolves.toMatchObject({ account: ACCOUNT });
  });

  it("retries network errors and 5xx with backoff until approval", async () => {
    const { deps, clock, captured } = setup();
    let n = 0;
    mock.on(pollCliLogin, () => {
      n++;
      if (n <= 2) throw new MockApiError("api_error");
      return status("approved", { key: key(), account: ACCOUNT })() as never;
    });
    await deviceLogin(deps);
    expect(clock.sleeps).toEqual([5000, 10_000, 20_000]);
    expect(captured.stderr).toMatch(/retrying in 10 s/);
  });

  it("treats 404 (purged device code) as expired and other errors as fatal", async () => {
    const a = setup();
    mock.on(pollCliLogin, () => {
      throw new MockApiError("resource_missing");
    });
    await expect(deviceLogin(a.deps)).rejects.toThrow(/expired/);
    const b = setup();
    mock.on(pollCliLogin, () => {
      throw new MockApiError("invalid_request");
    });
    await expect(deviceLogin(b.deps)).rejects.toMatchObject({ status: 400 });
  });

  it("fails closed on a live or secret key, or an approval without a key", async () => {
    for (const bad of [
      status("approved", { key: key(`rk_live_${"c".repeat(48)}`, true), account: ACCOUNT }),
      status("approved", { key: key(`sk_test_${"c".repeat(48)}`), account: ACCOUNT }),
      status("approved"),
    ]) {
      const { deps } = setup();
      polls(bad);
      await expect(deviceLogin(deps)).rejects.toThrow(CliError);
    }
  });

  it("does not open non-https links, honours --no-browser, and stops on Ctrl-C", async () => {
    const a = setup({ url: "http://evil.example/cli?code=BCDF-GHJK" });
    polls(status("approved", { key: key(), account: ACCOUNT }));
    await deviceLogin(a.deps);
    expect(a.opened).toEqual([]);
    expect(a.captured.stderr).toContain("Could not open a browser");

    const b = setup();
    polls(status("approved", { key: key(), account: ACCOUNT }));
    await deviceLogin({ ...b.deps, openBrowser: false });
    expect(b.opened).toEqual([]);

    const c = setup();
    polls(status("pending"));
    c.ac.abort();
    await expect(deviceLogin(c.deps)).rejects.toBeInstanceOf(InterruptedError);
  });
});

describe("deviceNameFrom", () => {
  it("strips control characters, trims to 64, falls back to nearpay-cli", () => {
    expect(deviceNameFrom(" box\u0007 ")).toBe("box");
    expect(deviceNameFrom("x".repeat(80))).toHaveLength(64);
    expect(deviceNameFrom("\u0001")).toBe("nearpay-cli");
  });
});
