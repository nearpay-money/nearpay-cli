/** `nearpay listen [--events t1,t2] [--forward-to URL] [--print-json]` (sdks-and-tools §3). */
import { WEBHOOK_TYPE_NAMES } from "@nearpay-money/spec";
import { type GlobalOptions, type Runtime, resolveSession } from "../lib/context.js";
import { CliError, EXIT } from "../lib/errors.js";
import { forwardEvent, parseForwardTarget, SerialQueue } from "../lib/forward.js";
import { formatTime } from "../lib/output.js";
import { generateWebhookSecret } from "../lib/signing.js";
import { runEventStream } from "../lib/stream.js";
import { unixNow } from "../lib/time.js";

export interface ListenOptions {
  readonly events?: string;
  readonly forwardTo?: string;
  readonly printJson?: boolean;
  /** Tests: stop after this many connections. */
  readonly maxConnections?: number;
}

/** Splits `--events`; `*` (or nothing) means every type. Types this CLI does not know are passed on with a warning. */
export function parseEventTypes(raw: string | undefined, warn: (s: string) => void): string[] | undefined {
  if (raw === undefined) return undefined;
  const types = [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  ];
  if (types.length === 0) throw new CliError("--events needs at least one event type", EXIT.usage);
  if (types.includes("*")) return undefined;
  for (const t of types) {
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(t))
      throw new CliError(`--events: ${JSON.stringify(t)} is not an event type`, EXIT.usage);
    if (!(WEBHOOK_TYPE_NAMES as readonly string[]).includes(t)) {
      warn(`${t} is not an event type this CLI knows; the server decides`);
    }
  }
  return types;
}

export async function listenCommand(rt: Runtime, g: GlobalOptions, o: ListenOptions): Promise<void> {
  const out = rt.out;
  const c = out.color;
  const types = parseEventTypes(o.events, (s) => out.warn(s));
  const target = o.forwardTo ? parseForwardTarget(o.forwardTo) : null;
  const s = await resolveSession(rt, g);
  const secret = target ? generateWebhookSecret() : null;
  if (target && !target.loopback) {
    out.warn(`--forward-to ${target.url.origin} is not on this machine; events (test mode) will be sent there.`);
  }
  if (secret) {
    out.info(
      `${c.green("Ready!")} Your webhook signing secret for this session is ${c.bold(secret)}\n` +
        "  Verify forwarded events with it, e.g. @nearpay-money/node constructEvent(rawBody, signature, secret).\n" +
        "  It is printed once and changes every time you run `nearpay listen`.",
    );
  }
  out.info(
    `Listening for ${types ? types.join(", ") : "all events"} in test mode${target ? `, forwarding to ${target.url.href}` : ""} (Ctrl-C to quit)`,
  );

  const queue = new SerialQueue();
  let connectedOnce = false;
  // Event lines are the command's output: stdout, unless --print-json owns stdout.
  const eventLine = (line: string) => (o.printJson ? out.info(line) : out.line(line));
  await runEventStream(
    {
      api: s.api,
      ...(types ? { types } : {}),
      signal: rt.signal,
      clock: rt.clock,
      ...(o.maxConnections !== undefined ? { maxConnections: o.maxConnections } : {}),
    },
    {
      onReady: (r) => {
        out.info(
          connectedOnce
            ? c.dim(`Reconnected${r.resumed_after ? `, resuming after ${r.resumed_after}` : ""}.`)
            : c.dim(`Connected to account ${r.account} (stream expires ${formatTime(r.expires_at * 1000)}).`),
        );
        connectedOnce = true;
      },
      onEvent: (ev) => {
        if (o.printJson) out.line(ev.raw);
        eventLine(
          `${formatTime(rt.clock.now())}  --> ${c.bold(ev.type)} [${ev.id}]${ev.objectId ? ` ${ev.objectId}` : ""}`,
        );
        if (!target || !secret) return;
        queue.push(async () => {
          const r = await forwardEvent({
            target,
            secret,
            rawBody: ev.raw,
            eventId: ev.id,
            eventType: ev.type,
            timestamp: unixNow(rt.clock),
            ...(rt.fetch ? { fetch: rt.fetch } : {}),
          });
          const status =
            r.status === null
              ? c.red(`[ERR ${"error" in r ? r.error : ""}]`)
              : r.ok
                ? c.green(`[${r.status}]`)
                : c.yellow(`[${r.status}]`);
          eventLine(`${formatTime(rt.clock.now())}  <-- ${status} POST ${target.url.href} [${ev.id}] (${r.ms} ms)`);
        });
      },
      onReset: (r) => {
        out.warn(
          `the stream could not resume after ${r.cursor} (${r.reason}); continuing with new events only. ` +
            "Catch up with `nearpay events list`.",
        );
      },
      onDisconnect: (d) => {
        out.info(c.dim(`Disconnected: ${d.reason}. Reconnecting in ${(d.delayMs / 1000).toFixed(1)} s…`));
      },
      onWarning: (m) => out.warn(m),
    },
  );
  await queue.drain();
}
