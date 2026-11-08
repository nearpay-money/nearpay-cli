/** The command tree run in-process (`run(rt, argv)`) against the fake NearPay. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { constructEvent } from "@nearpay/node";
import { pollCliLogin, streamEvents } from "@nearpay/spec";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkTestKey } from "../../src/lib/context.js";
import { CliError } from "../../src/lib/errors.js";
import { CLI_VERSION } from "../../src/lib/version.js";
import { run } from "../../src/program.js";
import { type FakeNearPay, startFakeNearPay } from "../support/fake-nearpay.js";
import { type TestRuntime, testRuntime } from "../support/runtime.js";

let fake: FakeNearPay;
let t: TestRuntime;
const SK = `sk_test_${"c".repeat(48)}`;
beforeAll(async () => {
  fake = await startFakeNearPay({ settleMs: 5 });
});
afterAll(() => fake.close());
beforeEach(() => {
  t = testRuntime({ env: { NEARPAY_API_BASE: fake.url } });
  fake.mock.violations.splice(0);
});
afterEach(() => {
  t.cleanup();
  expect(fake.mock.violations).toEqual([]);
});

/** Approves the login as soon as the CLI created it. */
function approveWhenCreated(deny = false) {
  const before = fake.logins.size;
  const timer = setInterval(() => {
    if (fake.logins.size > before) {
      clearInterval(timer);
      deny ? fake.denyLogin() : fake.approveLogin();
    }
  }, 5);
}

describe("nearpay (in-process)", () => {
  it("prints help and version; unknown commands are usage errors", async () => {
    expect(await run(t.rt, ["--version"])).toBe(0);
    expect(t.captured.stdout).toContain(CLI_VERSION);
    expect(await run(t.rt, ["--help"])).toBe(0);
    expect(t.captured.stdout).toMatch(/login[\s\S]*listen[\s\S]*trigger[\s\S]*events/);
    expect(await run(t.rt, ["frobnicate"])).toBe(2);
    expect(await run(t.rt, ["events", "list", "--limit", "abc"])).toBe(2);
  });

  it("login → whoami → logout, with the key in the keychain", async () => {
    approveWhenCreated();
    expect(await run(t.rt, ["login"])).toBe(0);
    expect(t.captured.stdout).toMatch(/Done! Logged in to Acme Test Shop \(acct_\w+\) in test mode/);
    expect(t.captured.stdout).toContain("stored in the OS keychain");
    expect(t.opened[0]).toMatch(/^https:\/\/dashboard\.nearpay\.localhost\/cli\?code=/);
    expect([...t.keyring.store.values()][0]).toMatch(/^rk_test_/);
    expect(fake.mock.callsTo(pollCliLogin).length).toBeGreaterThanOrEqual(1);

    expect(await run(t.rt, ["whoami"])).toBe(0);
    expect(t.captured.stdout).toMatch(/Logged in to Acme Test Shop .* test mode, profile default/);
    expect(t.captured.stdout).toContain("✓ the key is accepted");

    t.captured.stdout = "";
    expect(await run(t.rt, ["whoami", "--json"])).toBe(0);
    expect(JSON.parse(t.captured.stdout)).toMatchObject({
      profile: "default",
      source: "profile",
      livemode: false,
      credential_store: "keychain",
    });

    expect(await run(t.rt, ["logout"])).toBe(0);
    expect(t.captured.stdout).toMatch(/revoke it in the dashboard/);
    expect(t.keyring.store.size).toBe(0);
    expect(await run(t.rt, ["whoami"])).toBe(3);
    expect(t.captured.stderr).toMatch(/not logged in/);
    expect(await run(t.rt, ["logout"])).toBe(0);
    expect(t.captured.stdout).toMatch(/nothing to remove/);
  });

  it("falls back to the credentials file when there is no keychain, and warns", async () => {
    const n = testRuntime({ env: { NEARPAY_API_BASE: fake.url }, keychain: "none" });
    try {
      approveWhenCreated();
      expect(await run(n.rt, ["login", "--no-browser", "--profile", "ci"])).toBe(0);
      expect(n.opened).toEqual([]);
      expect(n.captured.stderr).toMatch(/warning: No OS keychain/);
      expect(n.captured.stdout).toContain("credentials file");
      expect(await run(n.rt, ["whoami", "-p", "ci"])).toBe(0);
      expect(n.captured.stderr.match(/No OS keychain/g)).toHaveLength(2);
    } finally {
      n.cleanup();
    }
  });

  it("login denied → exit 3", async () => {
    approveWhenCreated(true);
    expect(await run(t.rt, ["login", "--no-browser"])).toBe(3);
    expect(t.captured.stderr).toMatch(/denied/);
  });

  it("uses --api-key / NEARPAY_API_KEY and refuses live and publishable keys", async () => {
    expect(await run(t.rt, ["whoami", "--api-key", SK])).toBe(0);
    expect(t.captured.stdout).toContain("Using secret test key sk_test_…cccc from --api-key");
    expect(await run(t.rt, ["whoami", "--api-key", `sk_live_${"c".repeat(48)}`])).toBe(2);
    expect(t.captured.stderr).toMatch(/live key; the NearPay CLI works in test mode only/);
    expect(() => checkTestKey(`pk_test_${"c".repeat(10)}`, "env")).toThrow(/publishable/);
    expect(() => checkTestKey("hello", "profile")).toThrow(CliError);
    const e = testRuntime({ env: { NEARPAY_API_BASE: fake.url, NEARPAY_API_KEY: SK } });
    try {
      expect(await run(e.rt, ["whoami"])).toBe(0);
      expect(e.captured.stdout).toContain("from NEARPAY_API_KEY");
    } finally {
      e.cleanup();
    }
  });

  it("trigger --list, unknown and unsupported events", async () => {
    expect(await run(t.rt, ["trigger"])).toBe(0);
    expect(t.captured.stdout).toMatch(
      /Supported events[\s\S]*payment_intent\.succeeded[\s\S]*Not supported[\s\S]*invoice\.overdue/,
    );
    t.captured.stdout = "";
    expect(await run(t.rt, ["trigger", "--list", "--json"])).toBe(0);
    const rows = JSON.parse(t.captured.stdout) as { event: string; supported: boolean }[];
    expect(rows.find((r) => r.event === "agent_payment.settled")?.supported).toBe(false);
    expect(await run(t.rt, ["trigger", "nope.nope", "--api-key", SK])).toBe(2);
    expect(await run(t.rt, ["trigger", "invoice.overdue", "--api-key", SK])).toBe(2);
    expect(t.captured.stderr).toMatch(/cannot be triggered from the CLI: needs a billing test helper/);
    expect(await run(t.rt, ["trigger", "payment_intent.succeeded", "--timeout", "0", "--api-key", SK])).toBe(2);
  });

  it("trigger payment_intent.succeeded waits for the event; --no-wait and --json", async () => {
    expect(await run(t.rt, ["trigger", "payment_intent.succeeded", "--api-key", SK])).toBe(0);
    expect(t.captured.stdout).toMatch(/✓ payment_intent\.succeeded evt_\w+ \(pi_\w+\)/);
    expect(t.captured.stderr).toMatch(/Created checkout session cs_/);
    t.captured.stdout = "";
    expect(await run(t.rt, ["trigger", "invoice.sent", "--no-wait", "--json", "--api-key", SK])).toBe(0);
    expect(JSON.parse(t.captured.stdout)).toMatchObject({ event: "invoice.sent", event_id: null, waited: false });
    t.captured.stdout = "";
    expect(await run(t.rt, ["trigger", "invoice.sent", "--no-wait", "--api-key", SK])).toBe(0);
    expect(t.captured.stdout).toMatch(/follows asynchronously/);
  });

  it("events list and resend", async () => {
    expect(await run(t.rt, ["trigger", "refund.created", "--api-key", SK])).toBe(0);
    t.captured.stdout = "";
    expect(await run(t.rt, ["events", "list", "--limit", "2", "--api-key", SK])).toBe(0);
    const lines = t.captured.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^evt_\w+ {2}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}refund\.requires_action +re_\w+$/);
    expect(t.captured.stderr).toMatch(/More: nearpay events list --starting-after evt_/);
    const id = lines[0]?.split(" ")[0] as string;
    t.captured.stdout = "";
    expect(await run(t.rt, ["events", "list", "--type", "refund.created", "--json", "--api-key", SK])).toBe(0);
    expect(JSON.parse(t.captured.stdout).data[0].type).toBe("refund.created");
    t.captured.stdout = "";
    expect(await run(t.rt, ["events", "list", "--type", "invoice.overdue", "--api-key", SK])).toBe(0);
    expect(t.captured.stdout).toMatch(/No events/);
    expect(await run(t.rt, ["events", "resend", id, "--api-key", SK])).toBe(0);
    expect(t.captured.stdout).toMatch(/Queued 1 delivery of evt_\w+:\n {2}whd_\w+ → we_\w+ \(pending\)/);
    t.captured.stdout = "";
    expect(
      await run(t.rt, [
        "events",
        "resend",
        id,
        "--endpoint",
        "we_01jbz9k3m4n5p6q7r8s9t0v1w3",
        "--json",
        "--api-key",
        SK,
      ]),
    ).toBe(0);
    expect(JSON.parse(t.captured.stdout).deliveries[0].webhook_endpoint).toBe("we_01jbz9k3m4n5p6q7r8s9t0v1w3");
    expect(await run(t.rt, ["events", "resend", "nope", "--api-key", SK])).toBe(2);
    expect(await run(t.rt, ["events", "resend", id, "--endpoint", "x", "--api-key", SK])).toBe(2);
    expect(await run(t.rt, ["events", "list", "--limit", "101", "--api-key", SK])).toBe(2);
    expect(await run(t.rt, ["events", "list", "--starting-after", "x", "--api-key", SK])).toBe(2);
    expect(await run(t.rt, ["events", "resend", "evt_7zzzzzzzzzzzzzzzzzzzzzzzzz", "--api-key", SK])).toBe(1);
    expect(t.captured.stderr).toMatch(/resource_missing, HTTP 404/);
  });

  describe("listen", () => {
    let receiver: Server;
    let received: { headers: Record<string, string | string[] | undefined>; body: string }[];
    let url: string;
    beforeEach(async () => {
      received = [];
      receiver = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          received.push({ headers: req.headers, body });
          res.writeHead(received.length === 2 ? 500 : 200).end();
        });
      });
      await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
      url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks`;
    });
    afterEach(async () => {
      await new Promise<void>((r) => receiver.close(() => r()));
      const end = Date.now() + 5000;
      while (fake.streams.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    });

    it("prints events and forwards them signed with the printed secret", async () => {
      const done = run(t.rt, [
        "listen",
        "--forward-to",
        url,
        "--events",
        "payment_intent.succeeded,refund.created",
        "--api-key",
        SK,
      ]);
      await fake.waitForStreams(1);
      expect(fake.mock.callsTo(streamEvents).at(-1)?.query.types).toBe("payment_intent.succeeded,refund.created");
      expect(
        await run(testRuntime({ env: { NEARPAY_API_BASE: fake.url } }).rt, [
          "trigger",
          "refund.created",
          "--api-key",
          SK,
        ]),
      ).toBe(0);
      const deadline = Date.now() + 5000;
      while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      t.abort.abort();
      expect(await done).toBe(0);
      const secret = /whsec_[0-9A-Za-z]{40}/.exec(t.captured.stderr)?.[0] as string;
      expect(secret).toBeDefined();
      expect(received.map((r) => r.headers["nearpay-event-type"])).toEqual([
        "payment_intent.succeeded",
        "refund.created",
      ]);
      for (const r of received) {
        const ev = constructEvent(r.body, r.headers["nearpay-signature"] as string, secret);
        expect(ev.id).toBe(r.headers["nearpay-event-id"]);
        expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      }
      expect(t.captured.stdout).toMatch(/--> payment_intent\.succeeded \[evt_\w+\] pi_\w+/);
      expect(t.captured.stdout).toMatch(/<-- \[200\] POST http:\/\/127\.0\.0\.1:\d+\/webhooks \[evt_\w+\]/);
      expect(t.captured.stdout).toMatch(/<-- \[500\] POST/);
    });

    it("--print-json puts each event's JSON on stdout; errors forwarding are reported", async () => {
      const closedPort = (receiver.address() as AddressInfo).port;
      await new Promise<void>((r) => receiver.close(() => r()));
      receiver = createServer();
      receiver.listen(0, "127.0.0.1");
      const done = run(t.rt, ["listen", "--print-json", "--forward-to", `:${closedPort}/none`, "--api-key", SK]);
      await fake.waitForStreams(1);
      const prev = fake.events.find((e) => e.type === "payment_intent.succeeded");
      if (!prev) throw new Error("expected an earlier payment_intent.succeeded");
      const ev = fake.emit(prev.type, prev.data.object);
      const deadline = Date.now() + 5000;
      while (!/<-- \[ERR/.test(t.captured.stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      t.abort.abort();
      expect(await done).toBe(0);
      expect(JSON.parse(t.captured.stdout.trim().split("\n")[0] as string).id).toBe(ev.id);
      expect(t.captured.stderr).toMatch(/<-- \[ERR ECONNREFUSED\]/);
    });

    it("rejects bad options and a non-local forward target is warned", async () => {
      expect(await run(t.rt, ["listen", "--events", "", "--api-key", SK])).toBe(2);
      expect(await run(t.rt, ["listen", "--events", "Bad Type", "--api-key", SK])).toBe(2);
      expect(await run(t.rt, ["listen", "--forward-to", "ftp://x", "--api-key", SK])).toBe(2);
      expect(await run(t.rt, ["listen", "--events", "made.up", "--api-key", SK])).toBe(2);
      expect(t.captured.stderr).toMatch(/made\.up is not an event type this CLI knows/);
      expect(t.captured.stderr).toMatch(/unknown event type in --events/);
      const done = run(t.rt, [
        "listen",
        "--forward-to",
        "https://hooks.example.com/x",
        "--events",
        "*",
        "--api-key",
        SK,
      ]);
      await fake.waitForStreams(1);
      t.abort.abort();
      expect(await done).toBe(0);
      expect(t.captured.stderr).toMatch(/is not on this machine/);
      expect(t.captured.stderr).toMatch(/Listening for all events/);
    });
  });
});
