/**
 * A local, spec-validating mock of the NearPay public API (HTTP server on 127.0.0.1).
 *
 * Every request is matched to a route of `PUBLIC_ROUTES` and checked the way the gateway and the
 * service bootstrap check it: credentials allowed by the route's `auth` (no `Authorization` on
 * anonymous / client-secret routes; `rk_` keys need the route's scope — default `CLI_KEY_SCOPES`),
 * `NearPay-Version`, the CLI's `User-Agent`, an `Idempotency-Key` on every POST and idempotent PATCH,
 * and path params, query, declared headers and body parsed **strictly** with the route's schemas. A
 * request that fails a check is answered `400 invalid_request` and recorded in `violations` (tests
 * assert it stays empty). JSON handler results are validated against the route's response schema;
 * `idempotent: true` routes replay stored responses for a repeated key. Stream routes answer
 * `text/event-stream`: every frame's payload is validated against `route.stream.events[name]`.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AnyRoute,
  API_VERSION,
  CLI_KEY_SCOPES,
  ERRORS,
  type ErrorCode,
  ErrorEnvelope,
  HEADERS,
  ID_ALPHABET,
  PUBLIC_ROUTES,
  type RouteBody,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
} from "@nearpay-money/spec";

export interface MockRequest<R extends AnyRoute = AnyRoute> {
  readonly route: R;
  readonly params: RouteParams<R>;
  readonly query: RouteQuery<R>;
  readonly body: RouteBody<R>;
  readonly headers: IncomingMessage["headers"];
  readonly idempotencyKey: string | undefined;
  /** `sk` / `rk` / null (anonymous). */
  readonly keyKind: "sk" | "rk" | null;
}

/** An open SSE response. */
export interface SseSink {
  /** Sends `event: <name>` with `data: JSON(payload)` (validated against the route's frame schema). */
  send(name: string, payload: unknown, id?: string): void;
  /** Sends raw text (malformed frames, comments, partial lines). */
  raw(text: string): void;
  comment(text?: string): void;
  end(): void;
  /** Destroys the socket without a clean end (network error). */
  destroy(): void;
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
}

export type MockReply<R extends AnyRoute> =
  | RouteResponse<R>
  | { readonly $status: number; readonly $body?: unknown; readonly $headers?: Record<string, string> }
  | { readonly $sse: (sink: SseSink) => void | Promise<void> };

export type MockHandler<R extends AnyRoute> = (req: MockRequest<R>) => MockReply<R> | Promise<MockReply<R>>;

/** Thrown by a handler to answer with a catalogue error. */
export class MockApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: {
      readonly param?: string;
      readonly headers?: Record<string, string>;
      readonly status?: number;
    } = {},
  ) {
    super(code);
  }
}

export interface Violation {
  readonly route: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly problem: string;
}

export interface SpecMock {
  readonly url: string;
  readonly calls: MockRequest[];
  readonly violations: Violation[];
  on<R extends AnyRoute>(route: R, handler: MockHandler<R>): SpecMock;
  callsTo<R extends AnyRoute>(route: R): MockRequest<R>[];
  setRestrictedScopes(scopes: readonly string[]): void;
  reset(): void;
  close(): Promise<void>;
}

let reqSeq = 0;
const requestId = () => {
  let n = reqSeq++ % 32768;
  let tail = "";
  for (let i = 0; i < 5; i++) {
    tail = ID_ALPHABET[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `req_01jbz9k3m4n5p6q7r8s9t${tail}`;
};

export function envelopeFor(code: ErrorCode, message?: string, param?: string) {
  const def = ERRORS[code];
  return ErrorEnvelope.parse({
    error: {
      type: def.type,
      code,
      message: message ?? def.example,
      ...(param ? { param } : {}),
      doc_url: `https://docs.nearpay.money/errors/${code}`,
      request_id: requestId(),
    },
  });
}

function compile(route: AnyRoute) {
  const names: string[] = [];
  const src = route.path
    .split("/")
    .map((seg) => {
      const m = /^\{([a-z_]+)\}$/.exec(seg);
      if (m) {
        names.push(m[1] as string);
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { route, names, re: new RegExp(`^${src}$`) };
}

// Static paths first so `/v1/events/stream` is not taken for `/v1/events/{id}`.
const TABLE = PUBLIC_ROUTES.map(compile).sort((a, b) => a.names.length - b.names.length);

function queryObject(sp: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of sp) {
    if (k.endsWith("[]")) {
      const key = k.slice(0, -2);
      const arr = (out[key] as string[] | undefined) ?? [];
      arr.push(v);
      out[key] = arr;
    } else out[k] = v;
  }
  return out;
}

export async function startSpecMock(): Promise<SpecMock> {
  const handlers = new Map<string, MockHandler<AnyRoute>>();
  const calls: MockRequest[] = [];
  const violations: Violation[] = [];
  const idem = new Map<string, { hash: string; status: number; body: string }>();
  let scopes: readonly string[] = CLI_KEY_SCOPES;
  const sockets = new Set<import("node:net").Socket>();

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-request-id": requestId(),
      ...headers,
    });
    res.end(text);
    return text;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://mock");
        const hit = TABLE.map((t) => ({ t, m: t.route.method === method ? t.re.exec(url.pathname) : null })).find(
          (x) => x.m,
        );
        if (!hit?.m) {
          violations.push({ route: undefined, method, url: req.url ?? "", problem: "no such route" });
          send(res, 404, envelopeFor("resource_missing", "mock: no such route"));
          return;
        }
        const route = hit.t.route;
        const v = (problem: string) => {
          violations.push({ route: route.id, method, url: req.url ?? "", problem });
          send(res, 400, envelopeFor("invalid_request", `mock: ${problem}`));
        };

        const auth = req.headers.authorization;
        const anonymous = route.auth.every((a) => a === "anonymous" || a === "client_secret");
        let keyKind: "sk" | "rk" | null = null;
        if (anonymous) {
          if (auth !== undefined) return v("anonymous routes must be called without credentials");
        } else {
          const key = /^Bearer ((sk|rk)_(test|live)_[0-9A-Za-z]+)$/.exec(auth ?? "");
          if (!key) {
            send(res, 401, envelopeFor("authentication_required"));
            return;
          }
          keyKind = key[2] as "sk" | "rk";
          if (key[2] === "sk" && !route.auth.includes("secret_key")) {
            send(res, 403, envelopeFor("permission_denied"));
            return;
          }
          if (key[2] === "rk") {
            const need = route.auth.find((a) => a.startsWith("restricted_key:"))?.slice("restricted_key:".length);
            if (!need || !scopes.includes(need)) {
              send(res, 403, envelopeFor("permission_denied"));
              return;
            }
          }
          if (key[3] === "live" && (route.testModeOnly || route.stream)) {
            send(res, 403, envelopeFor("livemode_forbidden"));
            return;
          }
        }
        if (req.headers["nearpay-version"] !== API_VERSION) return v("NearPay-Version header missing or not pinned");
        if (!/^nearpay-cli\/\S+ node\//.test(String(req.headers["user-agent"]))) return v("unexpected User-Agent");
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        const needsKey = method === "POST" || (method !== "GET" && route.idempotent);
        if (needsKey && !idempotencyKey) return v("Idempotency-Key missing");
        if (!needsKey && idempotencyKey) return v("Idempotency-Key on a route that does not take one");
        if (idempotencyKey && idempotencyKey.length > 255) return v("Idempotency-Key longer than 255 chars");
        if (route.stream && !String(req.headers.accept).includes("text/event-stream")) {
          return v("stream requests must accept text/event-stream");
        }

        const paramObj = Object.fromEntries(hit.t.names.map((n, i) => [n, decodeURIComponent(hit.m?.[i + 1] ?? "")]));
        let params: unknown;
        if (route.params) {
          const p = route.params.safeParse(paramObj);
          if (!p.success) return v(`params: ${p.error.issues[0]?.message}`);
          params = p.data;
        }
        let query: unknown;
        const qObj = queryObject(url.searchParams);
        if (route.query) {
          const q = route.query.safeParse(qObj);
          if (!q.success) return v(`query: ${JSON.stringify(q.error.issues[0])}`);
          query = q.data;
        } else if (Object.keys(qObj).length > 0) return v("query on a route without one");
        if (route.headers) {
          const shape = (route.headers as unknown as { shape?: Record<string, unknown> }).shape ?? {};
          const picked = Object.fromEntries(
            Object.keys(shape)
              .filter((k) => req.headers[k] !== undefined)
              .map((k) => [k, req.headers[k]]),
          );
          const h = route.headers.safeParse(picked);
          if (!h.success) return v(`headers: ${JSON.stringify(h.error.issues[0])}`);
        }
        let body: unknown;
        if (method === "GET" || method === "DELETE") {
          if (raw !== "") return v(`${method} with a body`);
        } else {
          if (req.headers["content-type"] !== "application/json") return v("Content-Type must be application/json");
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            return v("body is not JSON");
          }
          if (route.body) {
            const b = route.body.safeParse(json);
            if (!b.success) return v(`body: ${JSON.stringify(b.error.issues[0])}`);
            body = b.data;
          }
        }

        const storeKey = idempotencyKey && route.idempotent ? `${auth}|${idempotencyKey}` : undefined;
        const hash = createHash("sha256").update(`${method} ${url.pathname} ${raw}`).digest("hex");
        const mreq: MockRequest = {
          route,
          params: params as never,
          query: query as never,
          body: body as never,
          headers: req.headers,
          idempotencyKey,
          keyKind,
        };
        if (storeKey) {
          const stored = idem.get(storeKey);
          if (stored && stored.hash !== hash) {
            send(res, 409, envelopeFor("idempotency_key_reused"));
            return;
          }
          if (stored) {
            calls.push(mreq);
            res.writeHead(stored.status, {
              "content-type": "application/json",
              [HEADERS.idempotentReplayed.toLowerCase()]: "true",
            });
            res.end(stored.body);
            return;
          }
        }
        calls.push(mreq);
        const handler = handlers.get(route.id);
        if (!handler) {
          violations.push({ route: route.id, method, url: req.url ?? "", problem: "route not mocked" });
          send(res, 500, envelopeFor("api_error", "mock: route not mocked"));
          return;
        }
        let reply: unknown;
        try {
          reply = await handler(mreq);
        } catch (e) {
          if (e instanceof MockApiError) {
            const def = ERRORS[e.code];
            send(res, e.extra.status ?? def.status, envelopeFor(e.code, undefined, e.extra.param), e.extra.headers);
            return;
          }
          throw e;
        }
        if (typeof reply === "object" && reply !== null && "$sse" in reply) {
          if (!route.stream) throw new Error(`${route.id} is not a stream route`);
          const frames = route.stream.events;
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            "x-request-id": requestId(),
          });
          res.write(`retry: ${route.stream.retryMs}\n\n`);
          let closed = false;
          const closedP = new Promise<void>((r) => res.on("close", () => r()));
          void closedP.then(() => {
            closed = true;
          });
          const sink: SseSink = {
            send(name, payload, id) {
              const schema = frames[name];
              if (!schema) throw new Error(`${route.id}: no frame "${name}" in the spec`);
              const check = schema.safeParse(payload);
              if (!check.success) {
                violations.push({
                  route: route.id,
                  method,
                  url: req.url ?? "",
                  problem: `mock frame ${name} does not match the spec: ${JSON.stringify(check.error.issues.slice(0, 2))}`,
                });
              }
              if (!closed) res.write(`event: ${name}\n${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
            },
            raw: (text) => {
              if (!closed) res.write(text);
            },
            comment: (text = "") => {
              if (!closed) res.write(`: ${text}\n\n`);
            },
            end: () => res.end(),
            destroy: () => res.destroy(),
            closed: closedP,
            get isClosed() {
              return closed;
            },
          };
          await (reply as { $sse: (s: SseSink) => void | Promise<void> }).$sse(sink);
          return;
        }
        let status: number = route.status;
        let out: unknown = reply;
        let headers: Record<string, string> = {};
        if (typeof reply === "object" && reply !== null && "$status" in reply) {
          const r = reply as { $status: number; $body?: unknown; $headers?: Record<string, string> };
          status = r.$status;
          out = r.$body;
          headers = r.$headers ?? {};
        } else if (route.response === null) {
          out = undefined;
        } else {
          const check = route.response.safeParse(reply);
          if (!check.success) {
            violations.push({
              route: route.id,
              method,
              url: req.url ?? "",
              problem: `mock response does not match the spec: ${JSON.stringify(check.error.issues.slice(0, 3))}`,
            });
            send(res, 500, envelopeFor("api_error", "mock: invalid response"));
            return;
          }
        }
        const text = send(res, status, out, headers);
        if (storeKey && status < 500) idem.set(storeKey, { hash, status, body: text });
      })().catch((e: unknown) => {
        violations.push({ route: undefined, method: req.method ?? "", url: req.url ?? "", problem: String(e) });
        if (!res.headersSent) send(res, 500, envelopeFor("api_error", "mock: handler crashed"));
        else res.destroy();
      });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const mock: SpecMock = {
    url: `http://127.0.0.1:${port}`,
    calls,
    violations,
    on(route, handler) {
      handlers.set(route.id, handler as unknown as MockHandler<AnyRoute>);
      return mock;
    },
    callsTo<R extends AnyRoute>(route: R) {
      return calls.filter((c) => c.route.id === route.id) as unknown as MockRequest<R>[];
    },
    setRestrictedScopes(s) {
      scopes = s;
    },
    reset() {
      handlers.clear();
      calls.splice(0);
      violations.splice(0);
      idem.clear();
      scopes = CLI_KEY_SCOPES;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
  return mock;
}
