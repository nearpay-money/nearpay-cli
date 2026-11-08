import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SseParser } from "../../src/lib/sse.js";

const all = (p: SseParser, ...chunks: string[]) => chunks.flatMap((c) => p.push(c));

describe("SseParser", () => {
  it("parses event, data, id and retry; comments and unknown fields are ignored", () => {
    const p = new SseParser();
    const frames = all(
      p,
      'retry: 3000\n\n: heartbeat\n\nevent: ready\ndata: {"a":1}\n\nevent: event\nid: evt_1\nfoo: bar\ndata: x\n\n',
    );
    expect(p.retryMs).toBe(3000);
    expect(frames).toEqual([
      { event: "ready", data: '{"a":1}', lastEventId: "", hasId: false },
      { event: "event", data: "x", lastEventId: "evt_1", hasId: true },
    ]);
  });

  it("joins multi-line data, defaults the event name, keeps the last id across frames", () => {
    const p = new SseParser();
    const frames = all(p, "id: 7\ndata: a\ndata: b\n\ndata\n\n");
    expect(frames).toEqual([
      { event: "message", data: "a\nb", lastEventId: "7", hasId: true },
      { event: "message", data: "", lastEventId: "7", hasId: false },
    ]);
  });

  it("handles CRLF and CR endings, also split across chunks, and a leading BOM", () => {
    const p = new SseParser();
    const frames = all(p, "﻿event: e\r", "\ndata: 1\r", "\r", "data: 2\rdata: 3\r\r");
    expect(frames.map((f) => f.data)).toEqual(["1", "2\n3"]);
    expect(frames[0]?.event).toBe("e");
  });

  it("does not dispatch a frame without data, ignores ids containing NUL and non-numeric retry", () => {
    const p = new SseParser();
    expect(all(p, "event: x\nid: a\u0000b\nretry: 1s\n\n")).toEqual([]);
    expect(p.lastEventId).toBe("");
    expect(p.retryMs).toBeNull();
  });

  it("decodes UTF-8 split across byte chunks", () => {
    const p = new SseParser();
    const bytes = new TextEncoder().encode("data: naïve ✓\n\n");
    const frames = [...bytes].flatMap((b) => p.pushBytes(Uint8Array.of(b)));
    expect(frames.map((f) => f.data)).toEqual(["naïve ✓"]);
  });

  it("property: any chunking and any line ending yields the same frames", () => {
    const frameArb = fc.record({
      event: fc.constantFrom("ready", "event", "reset", "message"),
      id: fc.option(fc.stringMatching(/^evt_[0-9a-z]{4}$/), { nil: undefined }),
      data: fc.array(fc.string({ unit: fc.constantFrom("a", "{", "}", ":", " ", "é", '"') }), {
        minLength: 1,
        maxLength: 3,
      }),
    });
    fc.assert(
      fc.property(
        fc.array(frameArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom("\n", "\r\n", "\r"),
        fc.array(fc.nat(), { maxLength: 10 }),
        (frames, eol, cuts) => {
          const text = frames
            .map(
              (f) =>
                `event: ${f.event}${eol}${f.id ? `id: ${f.id}${eol}` : ""}${f.data.map((d) => `data: ${d}`).join(eol)}${eol}${eol}`,
            )
            .join(`: comment${eol}`);
          const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
          const chunks: string[] = [];
          let prev = 0;
          for (const pt of points) {
            chunks.push(text.slice(prev, pt));
            prev = pt;
          }
          chunks.push(text.slice(prev));
          const got = all(new SseParser(), ...chunks);
          let last = "";
          const want = frames.map((f) => {
            if (f.id) last = f.id;
            return { event: f.event, data: f.data.join("\n"), lastEventId: last, hasId: f.id !== undefined };
          });
          expect(got).toEqual(want);
        },
      ),
      { numRuns: 300 },
    );
  });
});
