/**
 * Where the CLI key lives: the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
 * Service via `@napi-rs/keyring`). Only when no keychain exists on the machine (headless Linux, CI,
 * containers) does it fall back to `credentials.json` in the config directory, owner-only (0600) — and
 * says so loudly every time it writes or reports it. A keychain that exists but refuses (locked, the
 * user denied access) is an error, never a silent downgrade to a file.
 */
import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDir, writePrivateFile } from "./config.js";
import { CliError } from "./errors.js";

export type BackendName = "keychain" | "file";

export interface SecretBackend {
  readonly name: BackendName;
  get(profile: string): Promise<string | null>;
  set(profile: string, secret: string): Promise<void>;
  delete(profile: string): Promise<boolean>;
}

/** Thrown by the keychain backend when the machine has no usable keychain at all. */
export class NoKeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoKeychainError";
  }
}

/** The subset of `@napi-rs/keyring` the CLI uses (injectable in tests). */
export interface KeyringModule {
  AsyncEntry: new (
    service: string,
    username: string,
  ) => {
    getPassword(): Promise<string | null>;
    setPassword(password: string): Promise<void>;
    deletePassword(): Promise<boolean>;
  };
}

export const DEFAULT_KEYCHAIN_SERVICE = "nearpay-cli";

/**
 * `keyring-rs` reports a missing platform store (no D-Bus Secret Service, no keychain daemon) as
 * `NoStorageAccess` ("Couldn't access platform storage"); everything else (`PlatformFailure`,
 * `Ambiguous`, a user cancel) means a keychain exists and must not be bypassed.
 */
export function isNoKeychain(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /couldn't access platform storage|no ?storage ?access|org\.freedesktop\.(secrets|DBus)|dbus/i.test(msg);
}

export function keychainBackend(
  service: string,
  load: () => Promise<KeyringModule> = async () => (await import("@napi-rs/keyring")) as unknown as KeyringModule,
): SecretBackend {
  let mod: Promise<KeyringModule> | null = null;
  const entry = async (profile: string) => {
    mod ??= load().catch((e: unknown) => {
      // No prebuilt binary for this platform, or the native module failed to load.
      throw new NoKeychainError(`keychain library unavailable: ${e instanceof Error ? e.message : String(e)}`);
    });
    const { AsyncEntry } = await mod;
    return new AsyncEntry(service, profile);
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NoKeychainError) throw e;
      if (isNoKeychain(e)) throw new NoKeychainError(e instanceof Error ? e.message : String(e));
      throw new CliError(
        `the OS keychain refused the request: ${e instanceof Error ? e.message : String(e)}`,
        1,
        "Unlock your keychain (or allow access for this terminal) and try again.",
      );
    }
  };
  return {
    name: "keychain",
    get: (profile) => wrap(async () => (await entry(profile)).getPassword()),
    set: (profile, secret) =>
      wrap(async () => {
        const e = await entry(profile);
        await e.setPassword(secret);
        // Read back: some stores accept a write they cannot serve (e.g. a session-less Secret Service).
        if ((await e.getPassword()) !== secret) throw new CliError("the OS keychain did not keep the key");
      }),
    delete: (profile) => wrap(async () => (await entry(profile)).deletePassword()),
  };
}

const CredentialsFile = z.object({ version: z.literal(1), keys: z.record(z.string(), z.string()) });

/** `credentials.json` (0600) in the config directory: used only when no keychain exists. */
export function fileBackend(dir: string): SecretBackend & { readonly path: string } {
  const path = join(dir, "credentials.json");
  const read = async (): Promise<z.infer<typeof CredentialsFile>> => {
    let raw: string;
    try {
      if (process.platform !== "win32") {
        const st = await stat(path);
        if ((st.mode & 0o077) !== 0) {
          throw new CliError(
            `${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it`,
            1,
            `Run \`chmod 600 ${path}\`, or delete it and run \`nearpay login\` again.`,
          );
        }
      }
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: {} };
      throw e;
    }
    const parsed = CredentialsFile.safeParse(
      (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) throw new CliError(`${path} is corrupt`, 1, "Delete it and run `nearpay login` again.");
    return parsed.data;
  };
  const write = async (data: z.infer<typeof CredentialsFile>) => {
    await ensurePrivateDir(dir);
    if (Object.keys(data.keys).length === 0) {
      await unlink(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      return;
    }
    await writePrivateFile(path, `${JSON.stringify(data, null, 2)}\n`);
  };
  return {
    name: "file",
    path,
    get: async (profile) => (await read()).keys[profile] ?? null,
    set: async (profile, secret) => {
      const data = await read();
      data.keys[profile] = secret;
      await write(data);
    },
    delete: async (profile) => {
      const data = await read();
      if (!(profile in data.keys)) return false;
      delete data.keys[profile];
      await write(data);
      return true;
    },
  };
}

export const FILE_FALLBACK_WARNING = (path: string) =>
  `No OS keychain is available on this machine, so the key is stored in plaintext in ${path} ` +
  "(owner-only, mode 0600). Anyone with access to your user account can read it. " +
  "Prefer a machine with a keychain, or pass a key per command with NEARPAY_API_KEY.";

export class CredentialStore {
  constructor(
    readonly keychain: SecretBackend,
    readonly file: SecretBackend & { readonly path: string },
  ) {}

  /** Stores the key in the keychain; falls back to the file only when there is no keychain. */
  async save(profile: string, secret: string, warn: (s: string) => void): Promise<BackendName> {
    try {
      await this.keychain.set(profile, secret);
      // A stale fallback copy from an earlier login on this profile must not linger.
      await this.file.delete(profile).catch(() => false);
      return "keychain";
    } catch (e) {
      if (!(e instanceof NoKeychainError)) throw e;
      warn(FILE_FALLBACK_WARNING(this.file.path));
      await this.file.set(profile, secret);
      return "file";
    }
  }

  async load(profile: string, backend: BackendName): Promise<string | null> {
    if (backend === "file") return this.file.get(profile);
    try {
      return await this.keychain.get(profile);
    } catch (e) {
      if (e instanceof NoKeychainError) {
        throw new CliError(
          `the key of profile ${JSON.stringify(profile)} is in the OS keychain, which is not reachable now (${e.message})`,
          3,
          "Run `nearpay login` again on this machine.",
        );
      }
      throw e;
    }
  }

  /** Deletes the key from both stores; returns whether anything was deleted. */
  async remove(profile: string): Promise<boolean> {
    let removed = false;
    try {
      removed = (await this.keychain.delete(profile)) || removed;
    } catch (e) {
      if (!(e instanceof NoKeychainError)) throw e;
    }
    removed = (await this.file.delete(profile)) || removed;
    return removed;
  }
}
