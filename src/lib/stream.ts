/**
 * `GET /v1/events/stream` client for `nearpay listen` (lld/webhooks.md §5.1, sdks-and-tools §3):
 * frames `ready` / `event` / `reset`; resumes with `Last-Event-ID` after the 1 h server close, a
 * network error, a slow-client close or a silent connection (no byte for 3 heartbeats); backoff 1 s →
 * 30 s (reset once a stream is `ready`); dedupes by event id (delivery is at-least-once).
 */
import {
  EVENT_STREAM_HEARTBEAT_S,
  Event,
  EventStreamReady,
  EventStreamReset,
  idPattern,
  safeParseTolerant,
  streamEvents,
} from "@nearpay/spec";
import type { z } from "zod";
import type { ApiClient } from "./api.js";
import { BACKOFF_MAX_MS, backoffDelay, RecentIds } from "./backoff.js";
import { ApiError, CliError, EXIT, NetworkError } from "./errors.js";
import { SseParser } from "./sse.js";
import { type Clock, systemClock } from "./time.js";

export interface StreamedEvent {
  readonly id: string;
  readonly type: string;
  /** The `data:` payload exactly as received (forwarded byte for byte). */
  readonly raw: string;
  /** The event parsed with the spec (`null` when it does not match this CLI's spec version). */
  readonly event: Event | null;
  /** Why `event` is null. */
  readonly issue: string | null;
  /** Primary object id (`data.object.id`), if any. */
  readonly objectId: string | null;
}

export interface StreamHandlers {
  onReady?(ready: z.infer<typeof EventStreamReady>, connection: number): void;
  onEvent(ev: StreamedEvent): void | Promise<void>;
  onReset?(reset: z.infer<typeof EventStreamReset>): void;
  onDisconnect?(info: { readonly reason: string; readonly delayMs: number; readonly failures: number }): void;
  onWarning?(message: string): void;
}

export interface StreamOptions {
  readonly api: ApiClient;
  /** Event types (`undefined` = all). */
  readonly types?: readonly string[];
  readonly signal: AbortSignal;
  readonly clock?: Clock;
  readonly random?: () => number;
  /** Reconnect when no byte arrived for this long (default 3 heartbeats = 45 s). */
  readonly idleTimeoutMs?: number;
  readonly dedupeCapacity?: number;
  /** Stop after this many connections (tests); default unlimited. */
  readonly maxConnections?: number;
}

const EVT_ID = idPattern("evt");

/** Fatal answers: retrying cannot help (bad key, live key, unknown type, …). */
function fatal(e: ApiError): CliError {
  if (e.status === 401) return e;
  if (e.code === "livemode_forbidden") {
    return new CliError(
      "the event stream is test mode only and this is a live key",
      EXIT.auth,
      "Use a test key (`nearpay login` mints one).",
    );
  }
  if (e.code === "event_type_unknown") {
    return new CliError(
      `unknown event type in --events${e.param ? ` (${e.param})` : ""}: ${e.message}`,
      EXIT.usage,
      "Run `nearpay trigger --list` to see the event types.",
    );
  }
  if (e.status === 403) {
    return new CliError(`the key may not read events: ${e.message}`, EXIT.auth, "Run `nearpay login` again.");
  }
  return e;
}

export async function runEventStream(o: StreamOptions, h: StreamHandlers): Promise<void> {
  const clock = o.clock ?? systemClock;
  const random = o.random ?? Math.random;
  const idleMs = o.idleTimeoutMs ?? EVENT_STREAM_HEARTBEAT_S * 3 * 1000;
  const seen = new RecentIds(o.dedupeCapacity ?? 10_000);
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    h.onWarning?.(msg);
  };
  let cursor: string | null = null;
  let failures = 0;
  let connections = 0;

  while (!o.signal.aborted) {
    if (o.maxConnections !== undefined && connections >= o.maxConnections) return;
    connections++;
    let ready = false;
    let reason = "the server closed the stream";
    let minDelay = 0;
    try {
      const res: Response = await o.api.stream(streamEvents, {
        ...(o.types && o.types.length > 0 ? { query: { types: o.types.join(",") } } : {}),
        headers: cursor ? { "last-event-id": cursor } : {},
        signal: o.signal,
      });
      const body = res.body;
      if (!body) throw new NetworkError("the event stream has no body");
      const reader = body.getReader();
      const parser = new SseParser();
      let idle: ReturnType<typeof setTimeout> | null = null;
      let idleFired = false;
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          idleFired = true;
          void reader.cancel().catch(() => undefined);
        }, idleMs);
      };
      const onAbort = () => void reader.cancel().catch(() => undefined);
      o.signal.addEventListener("abort", onAbort, { once: true });
      arm();
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (o.signal.aborted) return;
            reason = `connection lost (${(e as Error).message})`;
            break;
          }
          if (chunk.done) {
            if (idleFired) reason = `no data for ${Math.round(idleMs / 1000)} s`;
            break;
          }
          arm();
          for (const f of parser.pushBytes(chunk.value)) {
            if (f.event === "ready") {
              const r = safeParseTolerant(EventStreamReady, safeJson(f.data));
              if (!r.success) {
                warnOnce("ready", "the stream's ready frame does not match @nearpay/spec; continuing");
              } else {
                ready = true;
                failures = 0;
                h.onReady?.(r.data, connections);
              }
            } else if (f.event === "event") {
              const json = safeJson(f.data) as { id?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
              const id =
                f.hasId && EVT_ID.test(f.lastEventId)
                  ? f.lastEventId
                  : typeof json?.id === "string" && EVT_ID.test(json.id)
                    ? json.id
                    : null;
              if (!id) {
                warnOnce("noid", "skipped a stream event without an evt_ id");
                continue;
              }
              cursor = id;
              if (!seen.add(id)) continue;
              const type = typeof json?.type === "string" ? json.type : "unknown";
              const parsed = safeParseTolerant(Event, json);
              const objectId = typeof json?.data?.object?.id === "string" ? json.data.object.id : null;
              let issue: string | null = null;
              if (!parsed.success) {
                const i = parsed.error.issues[0];
                issue = `${i?.path.join(".") || "(root)"}: ${i?.message ?? "invalid"}`;
                warnOnce(
                  `type:${type}`,
                  `event type ${type} does not match this CLI's @nearpay/spec (${issue}); forwarded as received`,
                );
              }
              await h.onEvent({ id, type, raw: f.data, event: parsed.success ? parsed.data : null, issue, objectId });
            } else if (f.event === "reset") {
              const r = safeParseTolerant(EventStreamReset, safeJson(f.data));
              cursor = null;
              if (r.success) h.onReset?.(r.data);
              else warnOnce("reset", "the stream could not resume; continuing live");
            } else {
              warnOnce(`frame:${f.event}`, `ignored unknown stream frame "${f.event}"`);
            }
          }
        }
      } finally {
        if (idle) clearTimeout(idle);
        o.signal.removeEventListener("abort", onAbort);
        await reader.cancel().catch(() => undefined);
      }
    } catch (e) {
      if (o.signal.aborted) return;
      if (e instanceof ApiError) {
        if (e.status === 429 || e.status >= 500) {
          reason =
            e.status === 429
              ? `too many open streams or requests (${e.message})`
              : `the API answered ${e.status} (${e.code})`;
          if (e.retryAfterSec !== null) minDelay = Math.min(e.retryAfterSec * 1000, BACKOFF_MAX_MS * 4);
        } else {
          throw fatal(e);
        }
      } else if (e instanceof NetworkError) {
        reason = e.message;
      } else {
        throw e;
      }
    }
    if (o.signal.aborted) return;
    if (o.maxConnections !== undefined && connections >= o.maxConnections) return;
    const delayMs = Math.max(minDelay, backoffDelay(ready ? 0 : failures, random()));
    if (!ready) failures++;
    h.onDisconnect?.({ reason, delayMs, failures });
    try {
      await clock.sleep(delayMs, o.signal);
    } catch {
      return;
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
