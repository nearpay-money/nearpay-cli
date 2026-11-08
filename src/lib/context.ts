/**
 * Resolves who the CLI talks as: `--api-key` > `NEARPAY_API_KEY` > the profile's stored key
 * (sdks-and-tools §3), and where: `--api-base` > `NEARPAY_API_BASE` > the profile's origin > default.
 * The CLI is test mode only: live keys and publishable keys are refused before any request.
 */
import { ApiClient, DEFAULT_API_BASE } from "./api.js";
import type { OpenUrl } from "./browser.js";
import { ConfigStore, checkProfileName, configDir, type Profile } from "./config.js";
import {
  CredentialStore,
  DEFAULT_KEYCHAIN_SERVICE,
  fileBackend,
  type KeyringModule,
  keychainBackend,
} from "./credentials.js";
import { CliError, EXIT } from "./errors.js";
import type { Io, Output } from "./output.js";
import type { Clock } from "./time.js";

export interface Runtime {
  readonly io: Io;
  readonly out: Output;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly openUrl: OpenUrl;
  readonly hostname: string;
  readonly keyring?: () => Promise<KeyringModule>;
  readonly signal: AbortSignal;
}

export interface GlobalOptions {
  readonly apiKey?: string;
  readonly apiBase?: string;
  readonly profile?: string;
}

export type KeySource = "flag" | "env" | "profile";

export interface Session {
  readonly api: ApiClient;
  readonly apiKey: string;
  readonly keyKind: "secret" | "restricted";
  readonly source: KeySource;
  readonly profileName: string;
  readonly profile: Profile | null;
}

export function stores(rt: Runtime): { config: ConfigStore; creds: CredentialStore } {
  const dir = configDir(rt.io.env);
  const service = rt.io.env.NEARPAY_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE;
  return {
    config: new ConfigStore(dir),
    creds: new CredentialStore(keychainBackend(service, rt.keyring), fileBackend(dir)),
  };
}

export function profileName(g: GlobalOptions, env: Io["env"]): string {
  return checkProfileName(g.profile ?? env.NEARPAY_PROFILE ?? "default");
}

/** Refuses anything but `sk_test_` / `rk_test_` keys. */
export function checkTestKey(key: string, source: KeySource): "secret" | "restricted" {
  const m = /^(sk|rk|pk)_(test|live)_[0-9A-Za-z]+$/.exec(key.trim());
  const where = source === "flag" ? "--api-key" : source === "env" ? "NEARPAY_API_KEY" : "the stored key";
  if (!m) throw new CliError(`${where} is not a NearPay API key`, EXIT.usage);
  if (m[2] === "live") {
    throw new CliError(
      `${where} is a live key; the NearPay CLI works in test mode only`,
      EXIT.usage,
      "Use a test key (`nearpay login` mints a restricted test key).",
    );
  }
  if (m[1] === "pk")
    throw new CliError(`${where} is a publishable key; use a secret or restricted test key`, EXIT.usage);
  return m[1] === "sk" ? "secret" : "restricted";
}

export function apiBase(g: GlobalOptions, env: Io["env"], profile: Profile | null): string {
  return g.apiBase ?? env.NEARPAY_API_BASE ?? profile?.api_base ?? DEFAULT_API_BASE;
}

export function anonymousApi(rt: Runtime, g: GlobalOptions, profile: Profile | null = null): ApiClient {
  return new ApiClient({
    baseUrl: apiBase(g, rt.io.env, profile),
    clock: rt.clock,
    ...(rt.fetch ? { fetch: rt.fetch } : {}),
  });
}

export async function resolveSession(rt: Runtime, g: GlobalOptions): Promise<Session> {
  const name = profileName(g, rt.io.env);
  const { config, creds } = stores(rt);
  const profile = await config.getProfile(name);
  let apiKey: string | null = null;
  let source: KeySource = "profile";
  if (g.apiKey) {
    apiKey = g.apiKey.trim();
    source = "flag";
  } else if (rt.io.env.NEARPAY_API_KEY) {
    apiKey = rt.io.env.NEARPAY_API_KEY.trim();
    source = "env";
  } else if (profile) {
    apiKey = await creds.load(name, profile.credential_store);
    if (!apiKey) {
      throw new CliError(
        `profile ${JSON.stringify(name)} has no stored key (it was removed from the ${profile.credential_store})`,
        EXIT.auth,
        "Run `nearpay login` again.",
      );
    }
  }
  if (!apiKey) {
    throw new CliError(
      name === "default" ? "not logged in" : `profile ${JSON.stringify(name)} is not logged in`,
      EXIT.auth,
      `Run \`nearpay login${name === "default" ? "" : ` --profile ${name}`}\`, or set NEARPAY_API_KEY to a test key.`,
    );
  }
  const keyKind = checkTestKey(apiKey, source);
  const api = new ApiClient({
    baseUrl: apiBase(g, rt.io.env, source === "profile" ? profile : null),
    apiKey,
    clock: rt.clock,
    ...(rt.fetch ? { fetch: rt.fetch } : {}),
  });
  return { api, apiKey, keyKind, source, profileName: name, profile };
}
