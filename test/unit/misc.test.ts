import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "../../src/lib/api.js";
import { isOpenableUrl, openerFor, systemOpener } from "../../src/lib/browser.js";
import { ApiError, CliError, EXIT, NetworkError } from "../../src/lib/errors.js";
import { forwardEvent, parseForwardTarget, SerialQueue } from "../../src/lib/forward.js";
import { colorsFor, createOutput, formatTime, maskKey } from "../../src/lib/output.js";
import { systemClock, unixNow } from "../../src/lib/time.js";
import { CLI_VERSION, userAgent } from "../../src/lib/version.js";
import { captureIo } from "../support/runtime.js";

describe("package", () => {
  it("CLI_VERSION equals package.json and the bin points at the built entry", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
    expect(pkg.bin).toEqual({ nearpay: "./dist/cli.js" });
    expect(pkg.dependencies["@nearpay/spec"]).toBe("0.3.0");
    expect(userAgent()).toMatch(/^nearpay-cli\/\S+ node\/v\d+/);
  });
});

describe("parseForwardTarget", () => {
  it.each([
    ["http://localhost:3000/webhooks", "http://localhost:3000/webhooks", true],
    ["localhost:3000/hooks", "http://localhost:3000/hooks", true],
    [":4242", "http://localhost:4242/", true],
    ["https://127.0.0.1:8443/x#frag", "https://127.0.0.1:8443/x", true],
    ["https://hooks.example.com/x", "https://hooks.example.com/x", false],
  ])("%s", (raw, href, loopback) => {
    const t = parseForwardTarget(raw);
    expect(t.url.href).toBe(href);
    expect(t.loopback).toBe(loopback);
  });

  it("rejects other schemes, credentials and garbage", () => {
    expect(() => parseForwardTarget("ftp://x")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => parseForwardTarget("http://u:p@localhost")).toThrow(/credentials/);
    expect(() => parseForwardTarget("http://[bad")).toThrow(/invalid --forward-to/);
  });

  it("knows loopback hosts", () => {
    expect(["localhost", "app.localhost", "127.0.0.2", "[::1]"].every(isLoopbackHost)).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("forwardEvent", () => {
  it("does not follow redirects and times out slow endpoints", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/slow") return; // never answers
      res.writeHead(302, { location: "https://elsewhere.example/" }).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const base = { secret: "whsec_x", rawBody: "{}", eventId: "evt_1", eventType: "ping", timestamp: 1 };
    try {
      const r = await forwardEvent({ ...base, target: parseForwardTarget(`http://127.0.0.1:${port}/r`) });
      expect(r).toMatchObject({ ok: false, status: 302 });
      const slow = await forwardEvent({
        ...base,
        target: parseForwardTarget(`http://127.0.0.1:${port}/slow`),
        timeoutMs: 30,
      });
      expect(slow).toMatchObject({ ok: false, status: null, error: "timed out after 30 ms" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("SerialQueue keeps order and survives failing jobs", async () => {
    const q = new SerialQueue();
    const seen: number[] = [];
    q.push(async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(1);
    });
    q.push(async () => {
      throw new Error("x");
    });
    q.push(async () => {
      seen.push(3);
    });
    expect(q.size).toBe(3);
    await q.drain();
    expect(seen).toEqual([1, 3]);
    expect(q.size).toBe(0);
  });
});

describe("browser", () => {
  it("opens only https (or loopback http) URLs, as one argv entry", async () => {
    expect(isOpenableUrl("https://dashboard.nearpay.money/cli?code=A&b=1")).toBe(true);
    expect(isOpenableUrl("http://localhost:5173/cli")).toBe(true);
    expect(isOpenableUrl("http://evil.example")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("::")).toBe(false);
    expect(openerFor("darwin", "https://x/?a&b")).toEqual(["open", ["https://x/?a&b"]]);
    expect(openerFor("win32", "https://x/?a&b")).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", "https://x/?a&b"],
    ]);
    expect(openerFor("linux", "https://x")).toEqual(["xdg-open", ["https://x"]]);
    expect(await systemOpener("linux")("http://evil.example")).toBe(false);
  });
});

describe("output", () => {
  it("colors only on a TTY without NO_COLOR, or with FORCE_COLOR", () => {
    expect(colorsFor({ isTTY: true }, {}).green("x")).toBe("\u001b[32mx\u001b[39m");
    expect(colorsFor({ isTTY: true }, { NO_COLOR: "" }).green("x")).toBe("x");
    expect(colorsFor({ isTTY: false }, { FORCE_COLOR: "1" }).red("x")).toBe("\u001b[31mx\u001b[39m");
    expect(colorsFor({ isTTY: true }, { TERM: "dumb" }).bold("x")).toBe("x");
  });

  it("writes results to stdout and diagnostics to stderr", () => {
    const { io, captured } = captureIo({});
    const out = createOutput(io);
    out.line("a");
    out.line();
    out.json({ b: 1 });
    out.info("i");
    out.warn("w");
    out.error("e");
    expect(captured.stdout).toBe('a\n\n{"b":1}\n');
    expect(captured.stderr).toBe("i\nwarning: w\nerror: e\n");
  });

  it("masks keys and formats times", () => {
    expect(maskKey(`rk_test_${"a".repeat(44)}wxyz`)).toBe("rk_test_…wxyz");
    expect(maskKey("weird1234")).toBe("…1234");
    expect(formatTime(Date.UTC(2026, 0, 2, 3, 4, 5))).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});

describe("errors and time", () => {
  it("maps API errors to exit codes and hints", () => {
    const e401 = new ApiError(401, "invalid_api_key", "bad key", null, null, null);
    expect(e401.exitCode).toBe(EXIT.auth);
    expect(e401.hint).toMatch(/nearpay login/);
    expect(new ApiError(400, "x", "m", "req_1", null, null).message).toBe("m (x, HTTP 400, request req_1)");
    expect(new NetworkError("n", new Error("c"))).toBeInstanceOf(CliError);
  });

  it("system clock sleeps and can be interrupted", async () => {
    await systemClock.sleep(1);
    const ac = new AbortController();
    const p = systemClock.sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ exitCode: EXIT.interrupted });
    await expect(systemClock.sleep(1, ac.signal)).rejects.toMatchObject({ exitCode: 130 });
    expect(unixNow({ now: () => 1999, sleep: async () => undefined })).toBe(1);
  });
});
