/**
 * Local CLI configuration: which account each profile is logged in to and where its key is stored.
 * The key itself is never in this file (OS keychain, or the 0600 fallback file — `credentials.ts`).
 */
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "./errors.js";

export const PROFILE_NAME = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_PROFILE = "default";

const Profile = z.object({
  account_id: z.string(),
  account_name: z.string(),
  key_id: z.string(),
  /** Masked key, e.g. `rk_test_…abcd`. */
  key_display: z.string(),
  key_expires_at: z.number().int().nullable(),
  credential_store: z.enum(["keychain", "file"]),
  /** API origin the key belongs to (when not the default). */
  api_base: z.string().nullable().optional(),
  logged_in_at: z.number().int(),
});
export type Profile = z.infer<typeof Profile>;

const ConfigFile = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), Profile),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

/**
 * `NEARPAY_CONFIG_DIR`, else `%APPDATA%\nearpay` on Windows, else `$XDG_CONFIG_HOME/nearpay`
 * (default `~/.config/nearpay`; also on macOS, like most developer CLIs).
 */
export function configDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.NEARPAY_CONFIG_DIR) return env.NEARPAY_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "nearpay");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "nearpay");
}

export function checkProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new CliError(`invalid profile name ${JSON.stringify(name)} (letters, digits, _ and -, at most 32)`);
  }
  return name;
}

/** Creates the directory owner-only (0700) and tightens it if it already exists. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const st = await stat(dir);
    if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
  }
}

/** Writes a file owner-only (0600) atomically: temp file in the same directory, then rename. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export class ConfigStore {
  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, "config.json");
  }

  async load(): Promise<ConfigFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CliError(`${this.path} is not valid JSON`, 1, "Fix or delete the file, then run `nearpay login`.");
    }
    const parsed = ConfigFile.safeParse(json);
    if (!parsed.success) {
      throw new CliError(`${this.path} has an unexpected shape`, 1, "Delete the file, then run `nearpay login`.");
    }
    return parsed.data;
  }

  async getProfile(name: string): Promise<Profile | null> {
    return (await this.load()).profiles[name] ?? null;
  }

  async setProfile(name: string, profile: Profile): Promise<void> {
    const cfg = await this.load();
    cfg.profiles[name] = Profile.parse(profile);
    await ensurePrivateDir(this.dir);
    await writePrivateFile(this.path, `${JSON.stringify(cfg, null, 2)}\n`);
  }

  async deleteProfile(name: string): Promise<boolean> {
    const cfg = await this.load();
    if (!(name in cfg.profiles)) return false;
    delete cfg.profiles[name];
    await ensurePrivateDir(this.dir);
    await writePrivateFile(this.path, `${JSON.stringify(cfg, null, 2)}\n`);
    return true;
  }
}
