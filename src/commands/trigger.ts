/** `nearpay trigger [event] [--list] [--no-wait] [--timeout s]` (sdks-and-tools §3). */
import { WEBHOOK_TYPE_NAMES } from "@nearpay/spec";
import { type GlobalOptions, type Runtime, resolveSession } from "../lib/context.js";
import { CliError, EXIT } from "../lib/errors.js";
import { unixNow } from "../lib/time.js";
import { fixtureFor, TRIGGERS, waitForEvent } from "../lib/trigger.js";

export interface TriggerOptions {
  readonly list?: boolean;
  readonly wait: boolean;
  readonly timeout: number;
  readonly json?: boolean;
  /** Tests: poll interval. */
  readonly pollMs?: number;
}

export function listTriggers(rt: Runtime, json: boolean): void {
  const rows = WEBHOOK_TYPE_NAMES.map((t) => {
    const f = TRIGGERS[t];
    return f.kind === "supported"
      ? { event: t, supported: true, how: f.summary }
      : { event: t, supported: false, how: f.reason };
  });
  if (json) {
    rt.out.json(rows);
    return;
  }
  const c = rt.out.color;
  const w = Math.max(...rows.map((r) => r.event.length));
  rt.out.line(c.bold("Supported events (real test-mode API calls):"));
  for (const r of rows.filter((x) => x.supported)) rt.out.line(`  ${r.event.padEnd(w)}  ${c.dim(r.how)}`);
  rt.out.line("");
  rt.out.line(c.bold("Not supported in this version:"));
  for (const r of rows.filter((x) => !x.supported)) rt.out.line(`  ${r.event.padEnd(w)}  ${c.dim(r.how)}`);
}

export async function triggerCommand(
  rt: Runtime,
  g: GlobalOptions,
  event: string | undefined,
  o: TriggerOptions,
): Promise<void> {
  if (o.list || !event) {
    listTriggers(rt, o.json === true);
    return;
  }
  const f = fixtureFor(event);
  if (!f) {
    throw new CliError(
      `unknown event ${JSON.stringify(event)}`,
      EXIT.usage,
      "Run `nearpay trigger --list` to see the events.",
    );
  }
  if (f.kind === "unsupported") {
    throw new CliError(`${event} cannot be triggered from the CLI: ${f.reason}`, EXIT.usage);
  }
  if (!Number.isFinite(o.timeout) || o.timeout < 1 || o.timeout > 600) {
    throw new CliError("--timeout must be between 1 and 600 seconds", EXIT.usage);
  }
  const s = await resolveSession(rt, g);
  const c = rt.out.color;
  const pollMs = o.pollMs ?? 2_000;
  const since = unixNow(rt.clock);
  rt.out.info(`Triggering ${c.bold(event)} with real test-mode API calls…`);
  const outcome = await f.run({
    api: s.api,
    clock: rt.clock,
    signal: rt.signal,
    step: (m) => rt.out.info(`  ${c.dim("•")} ${m}`),
    keyKind: s.keyKind,
    waitMs: o.timeout * 1000,
    pollMs,
  });
  let eventId: string | null = null;
  if (o.wait) {
    rt.out.info(`Waiting for ${outcome.target.type} on ${outcome.target.objectId}…`);
    eventId = await waitForEvent(
      { api: s.api, clock: rt.clock, signal: rt.signal, pollMs },
      outcome.target,
      since,
      o.timeout * 1000,
    );
  }
  if (o.json) {
    rt.out.json({ event, target: outcome.target, objects: outcome.objects, event_id: eventId, waited: o.wait });
  } else if (eventId) {
    rt.out.line(`${c.green("✓")} ${outcome.target.type} ${eventId} (${outcome.target.objectId})`);
  } else if (!o.wait) {
    rt.out.line(`Fixtures created; ${outcome.target.type} for ${outcome.target.objectId} follows asynchronously.`);
  }
  if (o.wait && !eventId) {
    throw new CliError(
      `the fixtures were created but ${outcome.target.type} for ${outcome.target.objectId} did not appear within ${o.timeout} s`,
      EXIT.timeout,
      `Check \`nearpay events list --type ${outcome.target.type}\` in a moment; the sandbox may be slow.`,
    );
  }
  if (!o.json) rt.out.info(c.dim("Tip: run `nearpay listen` in another terminal to see every event as it happens."));
}
