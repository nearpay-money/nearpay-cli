/** In-process CLI runtime for unit tests: captured stdio, temp config dir, fake keychain, fake clock. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../../src/lib/context.js";
import type { KeyringModule } from "../../src/lib/credentials.js";
import { createOutput, type Io } from "../../src/lib/output.js";
import { type Clock, systemClock } from "../../src/lib/time.js";

export interface Captured {
  stdout: string;
  stderr: string;
}

export function captureIo(env: Record<string, string | undefined> = {}): { io: Io; captured: Captured } {
  const captured: Captured = { stdout: "", stderr: "" };
  return {
    captured,
    io: {
      stdout: {
        write: (s: string) => {
          captured.stdout += s;
          return true;
        },
      },
      stderr: {
        write: (s: string) => {
          captured.stderr += s;
          return true;
        },
      },
      env,
    },
  };
}

/** An in-memory keyring with the `@napi-rs/keyring` shape; `fail` simulates platform errors. */
export function memoryKeyring(fail: { error?: Error | null } = {}) {
  const store = new Map<string, string>();
  const mod: KeyringModule = {
    AsyncEntry: class {
      constructor(
        private readonly service: string,
        private readonly user: string,
      ) {}
      private get k() {
        return `${this.service}/${this.user}`;
      }
      async getPassword() {
        if (fail.error) throw fail.error;
        return store.get(this.k) ?? null;
      }
      async setPassword(p: string) {
        if (fail.error) throw fail.error;
        store.set(this.k, p);
      }
      async deletePassword() {
        if (fail.error) throw fail.error;
        return store.delete(this.k);
      }
    },
  };
  return { store, mod, fail };
}

export const NO_KEYCHAIN = () => new Error("Couldn't access platform storage: AccessDenied");

/** A clock whose `sleep` returns at once and advances time (records every sleep). */
export function fakeClock(start = Date.UTC(2026, 10, 8, 12, 0, 0)): Clock & { sleeps: number[]; t: number } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new (await import("../../src/lib/errors.js")).InterruptedError();
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
  return c;
}

export interface TestRuntime {
  rt: Runtime;
  captured: Captured;
  dir: string;
  keyring: ReturnType<typeof memoryKeyring>;
  opened: string[];
  abort: AbortController;
  cleanup(): void;
}

export function testRuntime(
  o: {
    env?: Record<string, string | undefined>;
    clock?: Clock;
    keychain?: "memory" | "none";
    fetch?: typeof fetch;
  } = {},
): TestRuntime {
  const dir = mkdtempSync(join(tmpdir(), "nearpay-cli-test-"));
  const { io, captured } = captureIo({ NEARPAY_CONFIG_DIR: dir, NO_COLOR: "1", ...o.env });
  const keyring = memoryKeyring(o.keychain === "none" ? { error: NO_KEYCHAIN() } : {});
  const opened: string[] = [];
  const abort = new AbortController();
  return {
    dir,
    captured,
    keyring,
    opened,
    abort,
    rt: {
      io,
      out: createOutput(io),
      clock: o.clock ?? systemClock,
      openUrl: async (u) => {
        opened.push(u);
        return true;
      },
      hostname: "test-host",
      keyring: async () => keyring.mod,
      signal: abort.signal,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
