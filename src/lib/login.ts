/**
 * `nearpay login` — device authorization in the RFC 8628 shape (lld/identity.md §6.2, sdks-and-tools §3):
 * `createCliLogin` → show `user_code`, open `verification_url_complete` → `pollCliLogin` no faster than
 * `interval` (a `429` is RFC 8628 `slow_down`: wait `Retry-After` and add 5 s to the interval) until
 * `approved` (the key arrives exactly once), `denied`, `expired`/`redeemed`, or `expires_at` passes.
 */
import {
  type ApiKey as ApiKeySchema,
  CLI_LOGIN_TTL_SECONDS,
  type CliLogin as CliLoginSchema,
  createCliLogin,
  pollCliLogin,
} from "@nearpay-money/spec";
import type { z } from "zod";
import type { ApiClient } from "./api.js";
import type { OpenUrl } from "./browser.js";
import { isOpenableUrl } from "./browser.js";
import { ApiError, CliError, EXIT, NetworkError } from "./errors.js";
import type { Output } from "./output.js";
import { type Clock, unixNow } from "./time.js";

type ApiKey = z.infer<typeof ApiKeySchema>;
type CliLogin = z.infer<typeof CliLoginSchema>;

/** RFC 8628 §3.5: on `slow_down` the interval grows by 5 seconds. */
export const SLOW_DOWN_STEP_S = 5;

export interface LoginDeps {
  readonly api: ApiClient;
  readonly clock: Clock;
  readonly out: Output;
  readonly openUrl: OpenUrl;
  readonly deviceName: string;
  readonly clientVersion: string;
  readonly openBrowser: boolean;
  readonly signal: AbortSignal;
}

export interface LoginResult {
  readonly key: ApiKey & { secret: string };
  readonly account: { readonly id: string; readonly display_name: string };
}

/** Host name trimmed to the spec's 1–64 characters. */
export function deviceNameFrom(host: string): string {
  const printable = [...host].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
  const s = printable.join("").trim().slice(0, 64);
  return s.length > 0 ? s : "nearpay-cli";
}

export async function deviceLogin(d: LoginDeps): Promise<LoginResult> {
  const { data: login } = await d.api.call(createCliLogin, {
    body: { device_name: d.deviceName, client_version: d.clientVersion.slice(0, 32) },
    signal: d.signal,
    retries: 0,
  });
  announce(d, login);
  return poll(d, login);
}

function announce(d: LoginDeps, login: CliLogin): void {
  const c = d.out.color;
  d.out.info(`Your pairing code is: ${c.bold(login.user_code)}`);
  d.out.info(
    "Check that the dashboard shows this exact code before you approve — never approve a code you did not create.",
  );
  d.out.info(`Approve this login in the dashboard: ${c.cyan(login.verification_url_complete)}`);
  d.out.info(c.dim(`(or open ${login.verification_url} and enter the code)`));
}

async function poll(d: LoginDeps, login: CliLogin): Promise<LoginResult> {
  if (d.openBrowser) {
    const opened = isOpenableUrl(login.verification_url_complete) && (await d.openUrl(login.verification_url_complete));
    if (!opened) d.out.info("Could not open a browser; open the link above yourself.");
  }
  d.out.info("Waiting for approval… (Ctrl-C to cancel)");
  let interval = Math.max(1, login.interval);
  let wait = interval;
  let networkFailures = 0;
  // `expires_at` is server time: a local clock that is off would stop polling too early or too late, so
  // the local deadline is clamped to the login lifetime (15 min).
  const ttl = login.expires_at - unixNow(d.clock);
  const deadline = unixNow(d.clock) + (ttl > 0 && ttl <= CLI_LOGIN_TTL_SECONDS ? ttl : CLI_LOGIN_TTL_SECONDS);
  for (let first = true; ; first = false) {
    // One last poll happens at the deadline (an approval just before it is still collected); after it, stop.
    const remaining = deadline - unixNow(d.clock);
    if (remaining <= 0 && !first) throw expired();
    await d.clock.sleep(Math.max(0, Math.min(wait, remaining)) * 1000, d.signal);
    let res: Awaited<ReturnType<typeof d.api.call<typeof pollCliLogin>>>;
    try {
      res = await d.api.call(pollCliLogin, { body: { device_code: login.device_code }, signal: d.signal, retries: 0 });
      networkFailures = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        interval += SLOW_DOWN_STEP_S;
        wait = Math.max(interval, e.retryAfterSec ?? 0);
        continue;
      }
      if (e instanceof ApiError && e.status === 404) throw expired();
      if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
        networkFailures++;
        wait = Math.min(interval * 2 ** Math.min(networkFailures, 4), 60);
        d.out.warn(`${e.message}; retrying in ${wait} s`);
        continue;
      }
      throw e;
    }
    const p = res.data;
    interval = Math.max(interval, p.interval);
    wait = interval;
    switch (p.status) {
      case "pending":
        continue;
      case "approved": {
        const secret = p.key?.secret;
        if (!p.key || !secret || !p.account) {
          throw new CliError("the login was approved but no key was returned", EXIT.error, REVOKE_HINT);
        }
        // Fail closed: the CLI only ever stores restricted test keys.
        if (!/^rk_test_/.test(secret) || p.key.livemode !== false) {
          throw new CliError(
            "the server returned a key that is not a restricted test key; refusing to store it",
            EXIT.error,
            REVOKE_HINT,
          );
        }
        return { key: { ...p.key, secret }, account: p.account };
      }
      case "denied":
        throw new CliError("the login was denied in the dashboard", EXIT.auth);
      case "expired":
        throw expired();
      case "redeemed":
        throw new CliError(
          "this login's key was already delivered to another poll",
          EXIT.auth,
          `${REVOKE_HINT} Then run \`nearpay login\` again.`,
        );
      default:
        // An unknown (newer) status: keep polling until the login expires (api-conventions §5).
        continue;
    }
  }
}

const REVOKE_HINT = "Revoke the key named `CLI · <this device>` in the dashboard (Developers → API keys).";

const expired = () =>
  new CliError("the pairing code expired before it was approved", EXIT.auth, "Run `nearpay login` again.");
