import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore, checkProfileName, configDir, type Profile } from "../../src/lib/config.js";
import {
  CredentialStore,
  fileBackend,
  isNoKeychain,
  keychainBackend,
  NoKeychainError,
} from "../../src/lib/credentials.js";
import { CliError } from "../../src/lib/errors.js";
import { memoryKeyring, NO_KEYCHAIN } from "../support/runtime.js";

const SECRET = `rk_test_${"k".repeat(48)}`;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nearpay-cred-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;
const posix = process.platform !== "win32";

describe("CredentialStore", () => {
  it("stores in the keychain when one exists (no file is written)", async () => {
    const k = memoryKeyring();
    const store = new CredentialStore(
      keychainBackend("svc", async () => k.mod),
      fileBackend(dir),
    );
    const warnings: string[] = [];
    expect(await store.save("default", SECRET, (w) => warnings.push(w))).toBe("keychain");
    expect(k.store.get("svc/default")).toBe(SECRET);
    expect(warnings).toEqual([]);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
    expect(await store.load("default", "keychain")).toBe(SECRET);
    expect(await store.remove("default")).toBe(true);
    expect(k.store.size).toBe(0);
  });

  it("falls back to a 0600 file in a 0700 directory only when there is no keychain, with a loud warning", async () => {
    const k = memoryKeyring({ error: NO_KEYCHAIN() });
    const sub = join(dir, "nested");
    const store = new CredentialStore(
      keychainBackend("svc", async () => k.mod),
      fileBackend(sub),
    );
    const warnings: string[] = [];
    expect(await store.save("default", SECRET, (w) => warnings.push(w))).toBe("file");
    expect(warnings[0]).toMatch(/No OS keychain .* plaintext .*credentials\.json .*0600/s);
    const path = join(sub, "credentials.json");
    if (posix) {
      expect(mode(path)).toBe(0o600);
      expect(mode(sub)).toBe(0o700);
    }
    expect(JSON.parse(readFileSync(path, "utf8")).keys.default).toBe(SECRET);
    expect(await store.load("default", "file")).toBe(SECRET);
    expect(await store.remove("default")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("also falls back when the keychain library cannot load on this platform", async () => {
    const store = new CredentialStore(
      keychainBackend("svc", async () => {
        throw new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'");
      }),
      fileBackend(dir),
    );
    expect(await store.save("p", SECRET, () => undefined)).toBe("file");
  });

  it("never downgrades to a file when a keychain exists but refuses (locked, denied)", async () => {
    const k = memoryKeyring({ error: new Error("Platform secure storage failure: User canceled the operation") });
    const store = new CredentialStore(
      keychainBackend("svc", async () => k.mod),
      fileBackend(dir),
    );
    await expect(store.save("default", SECRET, () => undefined)).rejects.toThrow(/keychain refused/);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
  });

  it("fails when the keychain does not keep what was written", async () => {
    const k = memoryKeyring();
    const lossy = {
      AsyncEntry: class extends k.mod.AsyncEntry {
        override async getPassword() {
          return null;
        }
      },
    };
    const store = new CredentialStore(
      keychainBackend("svc", async () => lossy),
      fileBackend(dir),
    );
    await expect(store.save("default", SECRET, () => undefined)).rejects.toThrow(/did not keep/);
  });

  it("explains a keychain key that is unreachable now, and removes the stale file copy on keychain save", async () => {
    const k = memoryKeyring();
    const file = fileBackend(dir);
    await file.set("default", "rk_test_old");
    const store = new CredentialStore(
      keychainBackend("svc", async () => k.mod),
      file,
    );
    await store.save("default", SECRET, () => undefined);
    expect(await file.get("default")).toBeNull();
    k.fail.error = NO_KEYCHAIN();
    await expect(store.load("default", "keychain")).rejects.toThrow(/not reachable now/);
    expect(await store.remove("default")).toBe(false);
  });

  it.skipIf(!posix)("refuses a credentials file readable by others", async () => {
    const file = fileBackend(dir);
    await file.set("default", SECRET);
    chmodSync(join(dir, "credentials.json"), 0o644);
    await expect(file.get("default")).rejects.toMatchObject({
      message: expect.stringMatching(/readable by other users/),
      hint: expect.stringMatching(/chmod 600/),
    });
  });

  it("reports a corrupt credentials file", async () => {
    writeFileSync(join(dir, "credentials.json"), "{nope", { mode: 0o600 });
    await expect(fileBackend(dir).get("x")).rejects.toThrow(/corrupt/);
    expect(await fileBackend(join(dir, "missing")).delete("x")).toBe(false);
  });

  it("classifies keyring errors", () => {
    expect(isNoKeychain(NO_KEYCHAIN())).toBe(true);
    expect(isNoKeychain("org.freedesktop.DBus.Error.ServiceUnknown")).toBe(true);
    expect(isNoKeychain(new Error("Platform secure storage failure"))).toBe(false);
    expect(new NoKeychainError("x").name).toBe("NoKeychainError");
  });
});

describe("ConfigStore", () => {
  const profile: Profile = {
    account_id: "acct_1",
    account_name: "Acme",
    key_id: "key_1",
    key_display: "rk_test_…kkkk",
    key_expires_at: null,
    credential_store: "keychain",
    api_base: null,
    logged_in_at: 1,
  };

  it("round-trips profiles in a private file", async () => {
    const c = new ConfigStore(join(dir, "cfg"));
    expect(await c.getProfile("default")).toBeNull();
    await c.setProfile("default", profile);
    await c.setProfile("work", { ...profile, account_name: "Work" });
    expect((await c.getProfile("work"))?.account_name).toBe("Work");
    if (posix) expect(mode(c.path)).toBe(0o600);
    expect(await c.deleteProfile("work")).toBe(true);
    expect(await c.deleteProfile("work")).toBe(false);
    expect(Object.keys((await c.load()).profiles)).toEqual(["default"]);
  });

  it("reports broken config files with a fix", async () => {
    const c = new ConfigStore(dir);
    writeFileSync(c.path, "{");
    await expect(c.load()).rejects.toThrow(/not valid JSON/);
    writeFileSync(c.path, '{"version":2}');
    await expect(c.load()).rejects.toThrow(/unexpected shape/);
  });

  it("finds the config directory per platform", () => {
    expect(configDir({ NEARPAY_CONFIG_DIR: "/x" })).toBe("/x");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/h")).toBe(join("/xdg", "nearpay"));
    expect(configDir({}, "darwin", "/h")).toBe(join("/h", ".config", "nearpay"));
    expect(configDir({ APPDATA: "C:\\A" }, "win32", "/h")).toBe(join("C:\\A", "nearpay"));
    expect(configDir({}, "win32", "/h")).toBe(join("/h", "AppData", "Roaming", "nearpay"));
  });

  it("validates profile names", () => {
    expect(checkProfileName("work-2")).toBe("work-2");
    expect(() => checkProfileName("../x")).toThrow(CliError);
  });
});
