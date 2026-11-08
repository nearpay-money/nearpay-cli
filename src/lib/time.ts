import { InterruptedError } from "./errors.js";

/** Clock and timers, injectable so the login poller and the stream client run on a fake clock in tests. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, rejects with `InterruptedError` when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new InterruptedError());
        return;
      }
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new InterruptedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export const unixNow = (clock: Clock): number => Math.floor(clock.now() / 1000);
