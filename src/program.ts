/** The `nearpay` command tree (commander) and the error → exit-code mapping. */
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { eventsListCommand, eventsResendCommand } from "./commands/events.js";
import { listenCommand } from "./commands/listen.js";
import { triggerCommand } from "./commands/trigger.js";
import type { GlobalOptions, Runtime } from "./lib/context.js";
import { CliError, EXIT, InterruptedError } from "./lib/errors.js";
import { CLI_VERSION } from "./lib/version.js";

const int = (name: string) => (v: string) => {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError(`${name} must be a whole number`);
  return Number(v);
};

export function buildProgram(rt: Runtime): Command {
  const program = new Command("nearpay");
  program
    .description("NearPay developer CLI (test mode): log in, stream and forward events, trigger test events.")
    .version(CLI_VERSION, "-v, --version")
    .addOption(new Option("--api-key <key>", "use this test key instead of the stored one (also NEARPAY_API_KEY)"))
    .addOption(new Option("--api-base <url>", "API origin (also NEARPAY_API_BASE)").hideHelp())
    .addOption(new Option("-p, --profile <name>", "named login profile (also NEARPAY_PROFILE)").default(undefined))
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => rt.io.stdout.write(s),
      writeErr: (s) => rt.io.stderr.write(s),
    });
  const globals = (): GlobalOptions => program.opts<GlobalOptions>();

  program
    .command("login")
    .description(
      "log in with a pairing code approved in the dashboard; stores a restricted test key in the OS keychain",
    )
    .option("--no-browser", "print the approval link instead of opening a browser")
    .action((o: { browser: boolean }) => loginCommand(rt, globals(), o));

  program
    .command("logout")
    .description("delete this machine's copy of the CLI key (revoke it in the dashboard)")
    .action(() => logoutCommand(rt, globals()));

  program
    .command("whoami")
    .description("show the account and key in use, and check the key is accepted")
    .option("--json", "machine-readable output")
    .action((o: { json?: boolean }) => whoamiCommand(rt, globals(), { json: o.json === true }));

  program
    .command("listen")
    .description("stream events live; optionally forward each one, signed like a webhook, to a local URL")
    .option("-e, --events <types>", "comma-separated event types (default: all)")
    .option("-f, --forward-to <url>", "POST each event here, e.g. http://localhost:3000/webhooks")
    .option("-j, --print-json", "print every event's JSON on stdout (one per line)")
    .action((o: { events?: string; forwardTo?: string; printJson?: boolean }) => listenCommand(rt, globals(), o));

  program
    .command("trigger")
    .description("produce a real test-mode event through the API (run without an event to list them)")
    .argument("[event]", "event type, e.g. payment_intent.succeeded")
    .option("-l, --list", "list the events that can be triggered")
    .option("--no-wait", "do not wait for the event to appear")
    .option("-t, --timeout <seconds>", "how long to wait for asynchronous steps and the event", int("--timeout"), 90)
    .option("--json", "machine-readable output")
    .action((event: string | undefined, o: { list?: boolean; wait: boolean; timeout: number; json?: boolean }) =>
      triggerCommand(rt, globals(), event, o),
    );

  const events = program.command("events").description("list and resend events of the last 30 days");
  events
    .command("list")
    .description("list recent events, newest first")
    .option("-n, --limit <n>", "how many (1–100)", int("--limit"), 10)
    .option("--type <type>", "only this event type")
    .option("--starting-after <evt_id>", "the page after this event")
    .option("--json", "machine-readable output (the API list object)")
    .action((o: { limit: number; type?: string; startingAfter?: string; json?: boolean }) =>
      eventsListCommand(rt, globals(), o),
    );
  events
    .command("resend")
    .description("deliver an event again to your webhook endpoints")
    .argument("<event_id>", "evt_…")
    .option("--endpoint <we_id>", "only to this endpoint (it must be enabled)")
    .option("--json", "machine-readable output")
    .action((id: string, o: { endpoint?: string; json?: boolean }) => eventsResendCommand(rt, globals(), id, o));

  return program;
}

/** Runs the CLI; returns the exit code (never throws). */
export async function run(rt: Runtime, argv: readonly string[]): Promise<number> {
  const program = buildProgram(rt);
  try {
    await program.parseAsync(argv as string[], { from: "user" });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") {
        return EXIT.ok;
      }
      return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (e instanceof InterruptedError || rt.signal.aborted) return EXIT.interrupted;
    if (e instanceof CliError) {
      rt.out.error(e.message);
      if (e.hint) rt.out.info(e.hint);
      return e.exitCode;
    }
    rt.out.error(`unexpected error: ${(e as Error)?.message ?? String(e)}`);
    if (rt.io.env.NEARPAY_DEBUG) rt.io.stderr.write(`${(e as Error)?.stack ?? ""}\n`);
    return EXIT.error;
  }
}
