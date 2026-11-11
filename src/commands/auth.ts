/** `nearpay login`, `nearpay logout`, `nearpay whoami`. */
import { listEvents } from "@nearpay-money/spec";
import { anonymousApi, type GlobalOptions, profileName, type Runtime, resolveSession, stores } from "../lib/context.js";
import { FILE_FALLBACK_WARNING } from "../lib/credentials.js";
import { deviceLogin, deviceNameFrom } from "../lib/login.js";
import { maskKey } from "../lib/output.js";
import { unixNow } from "../lib/time.js";
import { CLI_VERSION } from "../lib/version.js";

const date = (unix: number | null) => (unix === null ? "never" : new Date(unix * 1000).toISOString().slice(0, 10));

export async function loginCommand(rt: Runtime, g: GlobalOptions, o: { browser: boolean }): Promise<void> {
  const name = profileName(g, rt.io.env);
  const { config, creds } = stores(rt);
  const existing = await config.getProfile(name);
  if (existing) {
    rt.out.info(
      `Profile ${name} is logged in to ${existing.account_name} (${existing.account_id}); this login replaces it.`,
    );
  }
  const api = anonymousApi(rt, g);
  const res = await deviceLogin({
    api,
    clock: rt.clock,
    out: rt.out,
    openUrl: rt.openUrl,
    deviceName: deviceNameFrom(rt.hostname),
    clientVersion: CLI_VERSION,
    openBrowser: o.browser,
    signal: rt.signal,
  });
  const backend = await creds.save(name, res.key.secret, (s) => rt.out.warn(s));
  await config.setProfile(name, {
    account_id: res.account.id,
    account_name: res.account.display_name,
    key_id: res.key.id,
    key_display: maskKey(res.key.secret),
    key_expires_at: res.key.expires_at,
    credential_store: backend,
    api_base: api.baseUrl === "https://api.nearpay.money" ? null : api.baseUrl,
    logged_in_at: unixNow(rt.clock),
  });
  const c = rt.out.color;
  rt.out.line(
    `${c.green("Done!")} Logged in to ${c.bold(res.account.display_name)} (${res.account.id}) in test mode` +
      `${name === "default" ? "" : ` as profile ${name}`}.`,
  );
  rt.out.line(
    `Key ${maskKey(res.key.secret)} (${res.key.id}) stored in the ${backend === "keychain" ? "OS keychain" : "credentials file"}; ` +
      `it expires on ${date(res.key.expires_at)}.`,
  );
  if (rt.io.env.NEARPAY_API_KEY) rt.out.warn("NEARPAY_API_KEY is set and overrides the stored key until you unset it.");
}

export async function logoutCommand(rt: Runtime, g: GlobalOptions): Promise<void> {
  const name = profileName(g, rt.io.env);
  const { config, creds } = stores(rt);
  const profile = await config.getProfile(name);
  const removed = await creds.remove(name);
  await config.deleteProfile(name);
  if (!profile && !removed) {
    rt.out.line(`Profile ${name} is not logged in; nothing to remove.`);
    return;
  }
  rt.out.line(`Removed the local copy of ${profile ? `${profile.key_display} (${profile.key_id})` : "the key"}.`);
  rt.out.line(
    "The key itself is still valid until it expires: revoke it in the dashboard (Developers → API keys, " +
      "the key named `CLI · <this device>`). The CLI cannot revoke keys (only dashboard sessions can).",
  );
}

export async function whoamiCommand(rt: Runtime, g: GlobalOptions, o: { json: boolean }): Promise<void> {
  const s = await resolveSession(rt, g);
  // A cheap read every CLI key may make (`events.read`): proves the key is accepted right now.
  await s.api.call(listEvents, { query: { limit: 1 }, signal: rt.signal });
  const p = s.source === "profile" ? s.profile : null;
  const info = {
    profile: s.profileName,
    source: s.source,
    key: maskKey(s.apiKey),
    key_type: s.keyKind,
    livemode: false,
    api_base: s.api.baseUrl,
    account: p ? { id: p.account_id, display_name: p.account_name } : null,
    key_id: p?.key_id ?? null,
    key_expires_at: p?.key_expires_at ?? null,
    credential_store: p?.credential_store ?? null,
  };
  if (o.json) {
    rt.out.json(info);
    return;
  }
  const c = rt.out.color;
  if (p) {
    rt.out.line(`Logged in to ${c.bold(p.account_name)} (${p.account_id}) — test mode, profile ${s.profileName}`);
    rt.out.line(`Key       ${p.key_display} (${p.key_id}), restricted, expires ${date(p.key_expires_at)}`);
    rt.out.line(
      `Stored in ${p.credential_store === "keychain" ? "OS keychain" : "credentials file (plaintext, 0600)"}`,
    );
  } else {
    rt.out.line(
      `Using ${s.keyKind} test key ${maskKey(s.apiKey)} from ${s.source === "flag" ? "--api-key" : "NEARPAY_API_KEY"}`,
    );
  }
  rt.out.line(`API       ${s.api.baseUrl}`);
  rt.out.line(`${c.green("✓")} the key is accepted`);
  if (p?.credential_store === "file") rt.out.warn(FILE_FALLBACK_WARNING(stores(rt).creds.file.path));
  if (p?.key_expires_at && p.key_expires_at - unixNow(rt.clock) < 7 * 86_400) {
    rt.out.warn(`the key expires on ${date(p.key_expires_at)}; run \`nearpay login\` to get a new one.`);
  }
}
