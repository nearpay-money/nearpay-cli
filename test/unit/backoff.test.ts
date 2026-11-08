import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BACKOFF_MAX_MS, backoffDelay, RecentIds } from "../../src/lib/backoff.js";

describe("backoffDelay", () => {
  it("starts at ~1 s and doubles to the 30 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffDelay(n, 0.5))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it("property: always within [800 ms, 30 s] and never below the previous attempt's minimum", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 1000 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (n, r) => {
        const d = backoffDelay(n, r);
        expect(d).toBeGreaterThanOrEqual(800);
        expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
        if (n > 0 && n < 5) expect(d).toBeGreaterThanOrEqual(backoffDelay(n - 1, 0));
      }),
    );
  });
});

describe("RecentIds", () => {
  it("dedupes and forgets the oldest beyond capacity", () => {
    const r = new RecentIds(2);
    expect(r.add("a")).toBe(true);
    expect(r.add("a")).toBe(false);
    r.add("b");
    r.add("c");
    expect(r.has("a")).toBe(false);
    expect(r.has("c")).toBe(true);
    expect(r.size).toBe(2);
    expect(() => new RecentIds(0)).toThrow(RangeError);
  });

  it("property: never holds more than its capacity and always remembers the latest id", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.array(fc.string({ maxLength: 3 })), (cap, ids) => {
        const r = new RecentIds(cap);
        for (const id of ids) {
          r.add(id);
          expect(r.size).toBeLessThanOrEqual(cap);
          expect(r.has(id)).toBe(true);
        }
      }),
    );
  });
});
