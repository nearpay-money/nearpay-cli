#!/usr/bin/env node
/** `nearpay` entry point: wires the process (stdio, env, signals) into the CLI runtime. */
import { hostname } from "node:os";
import { systemOpener } from "./lib/browser.js";
import { createOutput, type Io } from "./lib/output.js";
import { systemClock } from "./lib/time.js";
import { run } from "./program.js";

const io: Io = { stdout: process.stdout, stderr: process.stderr, env: process.env };
const ctl = new AbortController();
let interrupts = 0;
const onSignal = () => {
  interrupts++;
  if (interrupts > 1) process.exit(130); // second Ctrl-C: do not wait for in-flight forwards
  ctl.abort();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const code = await run(
  {
    io,
    out: createOutput(io),
    clock: systemClock,
    openUrl: systemOpener(),
    hostname: hostname(),
    signal: ctl.signal,
  },
  process.argv.slice(2),
);
process.exitCode = code;
