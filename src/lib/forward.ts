/**
 * Forwards a streamed event to a local endpoint the way the webhooks dispatcher delivers it
 * (lld/webhooks.md §6): POST, the raw event JSON as body, `Content-Type: application/json; charset=utf-8`,
 * `NearPay-Signature` (local secret), `NearPay-Event-Id`, `NearPay-Event-Type`, no redirects, 10 s timeout.
 */
import { HEADERS } from "@nearpay-money/spec";
import { isLoopbackHost } from "./api.js";
import { CliError, EXIT } from "./errors.js";
import { signatureHeader } from "./signing.js";
import { CLI_VERSION } from "./version.js";

export const FORWARD_TIMEOUT_MS = 10_000;

export interface ForwardTarget {
  readonly url: URL;
  readonly loopback: boolean;
}

/** Parses `--forward-to`: `http(s)://…`; a bare `localhost:3000/path` or `:3000/path` means http://localhost. */
export function parseForwardTarget(raw: string): ForwardTarget {
  let s = raw.trim();
  if (/^:\d+/.test(s)) s = `localhost${s}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new CliError(`invalid --forward-to URL ${JSON.stringify(raw)}`, EXIT.usage);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`--forward-to must be an http:// or https:// URL, got ${url.protocol}`, EXIT.usage);
  }
  if (url.username || url.password) throw new CliError("--forward-to must not contain credentials", EXIT.usage);
  url.hash = "";
  return { url, loopback: isLoopbackHost(url.hostname) };
}

export type ForwardResult =
  | { readonly ok: boolean; readonly status: number; readonly ms: number }
  | { readonly ok: false; readonly status: null; readonly ms: number; readonly error: string };

export interface ForwardInput {
  readonly target: ForwardTarget;
  readonly secret: string;
  readonly rawBody: string;
  readonly eventId: string;
  readonly eventType: string;
  /** Unix seconds for `t=`. */
  readonly timestamp: number;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export async function forwardEvent(i: ForwardInput): Promise<ForwardResult> {
  const now = i.now ?? Date.now;
  const started = now();
  const ctl = new AbortController();
  const timeout = i.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await (i.fetch ?? fetch)(i.target.url, {
      method: "POST",
      redirect: "manual",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": `NearPay-CLI/${CLI_VERSION} (listen)`,
        [HEADERS.webhookSignature]: signatureHeader(i.secret, i.timestamp, i.rawBody),
        [HEADERS.webhookEventId]: i.eventId,
        [HEADERS.webhookEventType]: i.eventType,
      },
      body: i.rawBody,
    });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: now() - started };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const error = ctl.signal.aborted
      ? `timed out after ${timeout} ms`
      : (cause?.code ?? cause?.message ?? (e as Error).message);
    return { ok: false, status: null, ms: now() - started, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs async jobs one at a time in arrival order (forwards keep the stream's order). */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  push(job: () => Promise<void>): void {
    this.pending++;
    this.tail = this.tail
      .then(job)
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
  }

  get size(): number {
    return this.pending;
  }

  /** Resolves when every queued job finished. */
  drain(): Promise<void> {
    return this.tail;
  }
}
