/** Where the CLI writes: stdout for results, stderr for progress, warnings and errors. */
export interface Io {
  readonly stdout: { write(s: string): unknown; isTTY?: boolean };
  readonly stderr: { write(s: string): unknown; isTTY?: boolean };
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Output {
  /** A result line (stdout). */
  line(s?: string): void;
  /** A JSON document (stdout, one line). */
  json(v: unknown): void;
  /** Progress / information (stderr). */
  info(s: string): void;
  /** A warning (stderr, prefixed). */
  warn(s: string): void;
  /** An error (stderr, prefixed). */
  error(s: string): void;
  readonly color: Colors;
}

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
}

const ansi = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;
const plain = (s: string) => s;

/** Colors only on a TTY, never with `NO_COLOR` (no-color.org), forced with `FORCE_COLOR=1`. */
export function colorsFor(stream: { isTTY?: boolean }, env: Io["env"]): Colors {
  const on = env.FORCE_COLOR === "1" || (stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb");
  return on
    ? {
        bold: ansi(1, 22),
        dim: ansi(2, 22),
        green: ansi(32, 39),
        yellow: ansi(33, 39),
        red: ansi(31, 39),
        cyan: ansi(36, 39),
      }
    : { bold: plain, dim: plain, green: plain, yellow: plain, red: plain, cyan: plain };
}

export function createOutput(io: Io): Output {
  const color = colorsFor(io.stderr, io.env);
  return {
    color,
    line: (s = "") => {
      io.stdout.write(`${s}\n`);
    },
    json: (v) => {
      io.stdout.write(`${JSON.stringify(v)}\n`);
    },
    info: (s) => {
      io.stderr.write(`${s}\n`);
    },
    warn: (s) => {
      io.stderr.write(`${color.yellow("warning:")} ${s}\n`);
    },
    error: (s) => {
      io.stderr.write(`${color.red("error:")} ${s}\n`);
    },
  };
}

/** `2026-11-08 12:00:00` in local time, for event lines. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Masks a key for display: `rk_test_…abcd`. */
export function maskKey(key: string): string {
  const m = /^((?:sk|rk|pk)_(?:test|live)_)/.exec(key);
  return `${m?.[1] ?? ""}…${key.slice(-4)}`;
}
