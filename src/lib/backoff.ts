/** Reconnect backoff for `listen` (sdks-and-tools §3): 1 s doubling to 30 s, ±20 % jitter. */
export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_JITTER = 0.2;

/** Delay before reconnect attempt `n` (0-based) with `rand` ∈ [0, 1). Always within [800 ms, 30 s]. */
export function backoffDelay(n: number, rand: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** Math.min(Math.max(0, n), 16));
  const jittered = base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * rand);
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_INITIAL_MS * (1 - BACKOFF_JITTER), jittered)));
}

/** A bounded set remembering the most recent `capacity` ids (stream dedupe across reconnects). */
export class RecentIds {
  private readonly set = new Set<string>();
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  }

  /** Records `id`; returns false when it was already seen. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.capacity) {
      const oldest = this.set.values().next().value as string;
      this.set.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  get size(): number {
    return this.set.size;
  }
}
