/** `nearpay events list` and `nearpay events resend <evt_…>` (sdks-and-tools §3). */
import { idPattern, listEvents, resendEvent } from "@nearpay-money/spec";
import { type GlobalOptions, type Runtime, resolveSession } from "../lib/context.js";
import { CliError, EXIT } from "../lib/errors.js";
import { formatTime } from "../lib/output.js";

export interface EventsListOptions {
  readonly limit: number;
  readonly type?: string;
  readonly startingAfter?: string;
  readonly json?: boolean;
}

export async function eventsListCommand(rt: Runtime, g: GlobalOptions, o: EventsListOptions): Promise<void> {
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 100) {
    throw new CliError("--limit must be an integer from 1 to 100", EXIT.usage);
  }
  if (o.startingAfter !== undefined && !idPattern("evt").test(o.startingAfter)) {
    throw new CliError("--starting-after must be an event id (evt_…)", EXIT.usage);
  }
  const s = await resolveSession(rt, g);
  const { data } = await s.api.call(listEvents, {
    query: {
      limit: o.limit,
      ...(o.type ? { type: o.type } : {}),
      ...(o.startingAfter ? { starting_after: o.startingAfter } : {}),
    },
    signal: rt.signal,
  });
  if (o.json) {
    rt.out.json(data);
    return;
  }
  if (data.data.length === 0) {
    rt.out.line(`No events in the last 30 days${o.type ? ` of type ${o.type}` : ""}.`);
    return;
  }
  const w = Math.max(...data.data.map((e) => e.type.length));
  for (const e of data.data) {
    const obj = (e.data.object as { id?: string }).id ?? "";
    rt.out.line(`${e.id}  ${formatTime(e.created * 1000)}  ${e.type.padEnd(w)}  ${obj}`);
  }
  const last = data.data[data.data.length - 1];
  if (data.has_more && last) rt.out.info(rt.out.color.dim(`More: nearpay events list --starting-after ${last.id}`));
}

export async function eventsResendCommand(
  rt: Runtime,
  g: GlobalOptions,
  id: string,
  o: { endpoint?: string; json?: boolean },
): Promise<void> {
  if (!idPattern("evt").test(id)) throw new CliError(`${JSON.stringify(id)} is not an event id (evt_…)`, EXIT.usage);
  if (o.endpoint !== undefined && !idPattern("we").test(o.endpoint)) {
    throw new CliError("--endpoint must be a webhook endpoint id (we_…)", EXIT.usage);
  }
  const s = await resolveSession(rt, g);
  const { data } = await s.api.call(resendEvent, {
    params: { id },
    body: o.endpoint ? { endpoint: o.endpoint } : {},
    signal: rt.signal,
  });
  if (o.json) {
    rt.out.json(data);
    return;
  }
  if (data.deliveries.length === 0) {
    rt.out.line(`No enabled webhook endpoint is subscribed to ${id}'s type; nothing was queued.`);
    return;
  }
  rt.out.line(
    `Queued ${data.deliveries.length} ${data.deliveries.length === 1 ? "delivery" : "deliveries"} of ${data.event}:`,
  );
  for (const d of data.deliveries) rt.out.line(`  ${d.id} → ${d.webhook_endpoint} (${d.status})`);
}
