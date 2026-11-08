/** Exit codes (sysexits-like, kept small). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** Not logged in, or the key was rejected. */
  auth: 3,
  /** `trigger` created its fixtures but the event did not show up in time. */
  timeout: 4,
  interrupted: 130,
} as const;

/** An error shown to the user as is (no stack); `hint` is printed on its own line. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.error,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A non-2xx answer of the NearPay API (`ErrorEnvelope`). */
export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly param: string | null,
    /** `Retry-After` in seconds, when the server sent one. */
    readonly retryAfterSec: number | null,
  ) {
    super(
      `${message} (${code}, HTTP ${status}${requestId ? `, request ${requestId}` : ""})`,
      status === 401 ? EXIT.auth : EXIT.error,
      status === 401 ? "Your key was rejected. Run `nearpay login` again (keys expire after 90 days)." : undefined,
    );
    this.name = "ApiError";
  }
}

/** A network failure or timeout talking to the API (retryable). */
export class NetworkError extends CliError {
  constructor(message: string, cause?: unknown) {
    super(message, EXIT.error);
    this.name = "NetworkError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Thrown when the user pressed Ctrl-C (the AbortSignal fired). */
export class InterruptedError extends CliError {
  constructor() {
    super("interrupted", EXIT.interrupted);
    this.name = "InterruptedError";
  }
}

/** Parses `Retry-After` (delta-seconds or an HTTP date) into seconds ≥ 0. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}
