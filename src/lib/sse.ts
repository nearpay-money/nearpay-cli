/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2.6 "Interpreting an event stream"):
 * CRLF / LF / CR line endings (also split across chunks), a leading BOM, comments, multi-line
 * `data`, `id` (persisting across frames, ignored when it contains NUL), `retry` (digits only).
 */
export interface SseFrame {
  /** `event:` field, default `message`. */
  readonly event: string;
  /** `data:` lines joined with `\n`. */
  readonly data: string;
  /** The last event id buffer at dispatch time (persists across frames), `""` when never set. */
  readonly lastEventId: string;
  /** Whether this frame itself carried an `id:` field. */
  readonly hasId: boolean;
}

export class SseParser {
  private buf = "";
  private started = false;
  private pendingCR = false;
  private dataLines: string[] = [];
  private hasData = false;
  private eventType = "";
  private frameHasId = false;
  /** The last event id (what an `EventSource` would send as `Last-Event-ID`). */
  lastEventId = "";
  /** Reconnection time requested by the server (`retry:`), ms. */
  retryMs: number | null = null;
  private readonly decoder = new TextDecoder("utf-8");

  /** Feeds raw bytes (streaming UTF-8 decode). */
  pushBytes(chunk: Uint8Array): SseFrame[] {
    return this.push(this.decoder.decode(chunk, { stream: true }));
  }

  /** Feeds decoded text; returns the frames completed by it. */
  push(text: string): SseFrame[] {
    let s = text;
    if (!this.started && s.length > 0) {
      this.started = true;
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    }
    if (this.pendingCR) {
      this.pendingCR = false;
      if (s.startsWith("\n")) s = s.slice(1);
    }
    this.buf += s;
    const frames: SseFrame[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const line = this.buf.slice(start, i);
      if (c === 13) {
        if (i + 1 < this.buf.length) {
          if (this.buf.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const f = this.line(line);
      if (f) frames.push(f);
    }
    this.buf = this.buf.slice(start);
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\u0000")) {
          this.lastEventId = value;
          this.frameHasId = true;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
    return null;
  }

  private dispatch(): SseFrame | null {
    const hasData = this.hasData;
    const frame: SseFrame = {
      event: this.eventType || "message",
      data: this.dataLines.join("\n"),
      lastEventId: this.lastEventId,
      hasId: this.frameHasId,
    };
    this.dataLines = [];
    this.hasData = false;
    this.eventType = "";
    this.frameHasId = false;
    return hasData ? frame : null;
  }
}
