/**
 * The built `nearpay` binary (dist/cli.js) as a child process against the stateful fake NearPay
 * (spec-validating, SSE included) and a local webhook receiver that verifies with @nearpay-money/node.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constructEvent } from "@nearpay-money/node";
import { streamEvents } from "@nearpay-money/spec";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeNearPay, startFakeNearPay } from "../support/fake-nearpay.js";

const BIN = new URL("../../dist/cli.js", import.meta.url).pathname;
const SK = `sk_test_${"i".repeat(48)}`;

interface Proc {
  child: ChildProcess;
  out: { stdout: string; stderr: string };
  exit: Promise<number | null>;
}

let fake: FakeNearPay;
let home: string;
let env: Record<string, string>;

function cli(args: string[], extra: Record<string, string> = {}): Proc {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  child.stdout?.on("data", (c: Buffer) => (out.stdout += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (out.stderr += c.toString()));
  const exit = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  return { child, out, exit };
}

async function until(cond: () => boolean, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  expect(existsSync(BIN), "run `pnpm build` first (pnpm test:integration does)").toBe(true);
});
beforeEach(async () => {
  fake = await startFakeNearPay({ settleMs: 20, heartbeatMs: 200 });
  home = mkdtempSync(join(tmpdir(), "nearpay-cli-it-"));
  env = {
    NEARPAY_API_BASE: fake.url,
    NEARPAY_CONFIG_DIR: join(home, "config"),
    // never touch the developer's real keychain entry
    NEARPAY_KEYCHAIN_SERVICE: `nearpay-cli-test-${randomBytes(4).toString("hex")}`,
    NO_COLOR: "1",
  };
});
afterEach(async () => {
  expect(fake.mock.violations).toEqual([]);
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

describe("nearpay binary", () => {
  it("login (device code) → whoami → trigger invoice.paid → events list → logout", async () => {
    const login = cli(["login", "--no-browser"]);
    await until(
      () => fake.logins.size === 1 && /pairing code is: [A-Z]{4}-[A-Z]{4}/.test(login.out.stderr),
      "the pairing code",
    );
    const code = [...fake.logins.values()][0]?.login.user_code as string;
    expect(login.out.stderr).toContain(code);
    expect(login.out.stderr).toContain(`https://dashboard.nearpay.localhost/cli?code=${code}`);
    const secret = fake.approveLogin();
    expect(await login.exit).toBe(0);
    expect(login.out.stdout).toMatch(/Done! Logged in to Acme Test Shop/);
    // Stored where? Keychain if this machine has one; otherwise the warned 0600 file.
    const credFile = join(home, "config", "credentials.json");
    if (existsSync(credFile)) {
      expect(login.out.stderr).toMatch(/No OS keychain is available/);
      if (process.platform !== "win32") expect(statSync(credFile).mode & 0o777).toBe(0o600);
    } else {
      expect(login.out.stdout).toContain("OS keychain");
    }
    expect(JSON.stringify(login.out)).not.toContain(secret);

    const who = cli(["whoami", "--json"]);
    expect(await who.exit).toBe(0);
    expect(JSON.parse(who.out.stdout)).toMatchObject({
      account: fake.account,
      livemode: false,
      key_type: "restricted",
    });

    const trig = cli(["trigger", "invoice.paid", "--json", "--timeout", "20"]);
    expect(await trig.exit).toBe(0);
    const result = JSON.parse(trig.out.stdout) as { target: { objectId: string }; event_id: string };
    expect(result.event_id).toMatch(/^evt_/);
    expect(fake.events.find((e) => e.id === result.event_id)?.type).toBe("invoice.paid");

    const list = cli(["events", "list", "--type", "invoice.paid"]);
    expect(await list.exit).toBe(0);
    expect(list.out.stdout).toContain(result.target.objectId);

    const logout = cli(["logout"]);
    expect(await logout.exit).toBe(0);
    expect(existsSync(credFile)).toBe(false);
    const after = cli(["whoami"]);
    expect(await after.exit).toBe(3);
  });

  it("listen --forward-to: signed forwards verify with @nearpay-money/node; resumes after the server closes the stream", async () => {
    const received: { sig: string; id: string; type: string; body: string }[] = [];
    const receiver: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          sig: String(req.headers["nearpay-signature"]),
          id: String(req.headers["nearpay-event-id"]),
          type: String(req.headers["nearpay-event-type"]),
          body,
        });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const port = (receiver.address() as AddressInfo).port;
    try {
      const listen = cli(["listen", "--forward-to", `localhost:${port}/webhooks`], { NEARPAY_API_KEY: SK });
      await fake.waitForStreams(1);
      const secret = /whsec_[0-9A-Za-z]{40}/.exec(listen.out.stderr)?.[0];
      expect(secret).toBeDefined();

      const t1 = cli(["trigger", "payment_intent.succeeded", "--api-key", SK]);
      expect(await t1.exit).toBe(0);
      await until(() => received.some((r) => r.type === "checkout.session.completed"), "first forwards");

      // the server closes the stream (1 h limit); an event happens while the CLI is reconnecting
      fake.closeStreams();
      await until(() => fake.streams.size === 0, "stream closed");
      const missed = fake.emit("payment_intent.created", fake.events[0]?.data.object);
      await until(() => fake.mock.callsTo(streamEvents).length === 2, "reconnect");
      const t2 = cli(["trigger", "refund.created", "--api-key", SK]);
      expect(await t2.exit).toBe(0);
      await until(() => received.some((r) => r.type === "refund.created"), "forwards after resume");

      listen.child.kill("SIGINT");
      expect(await listen.exit).toBe(0);

      const resumeFrom = fake.mock.callsTo(streamEvents)[1]?.headers["last-event-id"];
      expect(resumeFrom).toBe(fake.events[fake.events.indexOf(missed) - 1]?.id);
      // every event exactly once, in order, each verifying with the printed secret
      const ids = received.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(fake.events.map((e) => e.id));
      for (const r of received) {
        const ev = constructEvent(r.body, r.sig, secret as string);
        expect(ev.id).toBe(r.id);
        expect(ev.type).toBe(r.type);
      }
      expect(listen.out.stdout).toMatch(/--> refund\.created \[evt_\w+\] re_\w+/);
      expect(listen.out.stdout).toMatch(/<-- \[200\] POST http:\/\/localhost:\d+\/webhooks/);
      expect(listen.out.stderr).toMatch(/Reconnected, resuming after evt_/);
    } finally {
      await new Promise<void>((r) => receiver.close(() => r()));
    }
  });

  it("refuses live keys before connecting; Ctrl-C during login exits 130", async () => {
    const live = cli(["listen"], { NEARPAY_API_KEY: `sk_live_${"x".repeat(48)}` });
    expect(await live.exit).toBe(2);
    expect(live.out.stderr).toMatch(/test mode only/);
    expect(fake.mock.calls).toHaveLength(0);

    const login = cli(["login", "--no-browser"]);
    await until(() => fake.logins.size === 1, "login created");
    login.child.kill("SIGINT");
    expect(await login.exit).toBe(130);
  });
});

afterAll(() => undefined);
