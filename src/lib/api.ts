/**
 * Minimal NearPay public API client driven by the `@nearpay/spec` route table: requests are validated
 * with the route's own schemas before they leave, responses are parsed tolerantly (unknown open-enum
 * values allowed, api-conventions §5) and non-2xx answers become `ApiError` from the `ErrorEnvelope`.
 * Every POST carries an `Idempotency-Key` (api-conventions §4); retries of a request reuse it.
 */
import { randomUUID } from "node:crypto";
import {
  type AnyRoute,
  API_VERSION,
  buildPath,
  ErrorEnvelope,
  HEADERS,
  type RouteDefinition,
  type RouteResponse,
  safeParseTolerant,
} from "@nearpay/spec";
import type { z } from "zod";
import { ApiError, CliError, InterruptedError, NetworkError, parseRetryAfter } from "./errors.js";
import { type Clock, systemClock } from "./time.js";
import { userAgent } from "./version.js";

export const DEFAULT_API_BASE = "https://api.nearpay.money";

type In<S> = S extends z.ZodType ? z.input<S> : undefined;
type RouteIn<R> =
  R extends RouteDefinition<infer P, infer Q, infer B, infer _R>
    ? {
        params?: In<P>;
        query?: In<Q>;
        body?: In<B>;
      }
    : never;

export type CallOptions<R extends AnyRoute> = RouteIn<R> & {
  /** Extra request headers (e.g. `Last-Event-ID`, `X-NearPay-Invoice-Secret`). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Override the retry budget (default 2 for safe requests, 0 otherwise). */
  retries?: number;
};

export interface ApiResult<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: () => string;
}

/** Validates and normalises an API origin (`--api-base`). */
export function normaliseBaseUrl(raw: string): string {
  const base = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new CliError(`invalid API base URL ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new CliError(`the API base must be https:// (http:// only for localhost): ${raw}`);
  }
  if (u.search || u.hash) throw new CliError(`the API base must not have a query or fragment: ${raw}`);
  return base;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(`${k}[]`, String(item));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Every POST, and PATCH/DELETE routes that honour the key (api-conventions §4). */
export const takesIdempotencyKey = (route: AnyRoute) =>
  route.method === "POST" || (route.method !== "GET" && route.idempotent);

const isAnonymous = (route: AnyRoute) => route.auth.every((a) => a === "anonymous" || a === "client_secret");

export class ApiClient {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly newKey: () => string;

  constructor(o: ApiClientOptions) {
    this.baseUrl = normaliseBaseUrl(o.baseUrl);
    this.apiKey = o.apiKey ?? null;
    this.fetchImpl = o.fetch ?? fetch;
    this.clock = o.clock ?? systemClock;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.newKey = o.idempotencyKey ?? (() => `nearpay-cli-${randomUUID()}`);
  }

  /** Validates a request against the route's schemas; throws a `CliError` naming the bad field. */
  private validate(route: AnyRoute, part: "params" | "query" | "body", value: unknown): void {
    const schema = route[part];
    if (!schema) {
      if (value !== undefined && !(part === "body" && typeof value === "object" && value !== null)) {
        throw new CliError(`internal: ${route.id} takes no ${part}`);
      }
      return;
    }
    const r = schema.safeParse(value ?? (part === "body" ? {} : (value ?? {})));
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new CliError(
        `invalid ${part} for ${route.id}: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
      );
    }
  }

  private buildRequest(route: AnyRoute, o: CallOptions<AnyRoute>, idempotencyKey: string | null) {
    const params = (o.params ?? {}) as Record<string, string>;
    this.validate(route, "params", route.params ? params : undefined);
    this.validate(route, "query", o.query);
    const url = `${this.baseUrl}${buildPath(route, params)}${queryString(o.query as Record<string, unknown>)}`;
    const headers: Record<string, string> = {
      accept: route.stream ? "text/event-stream" : "application/json",
      "user-agent": userAgent(),
      [HEADERS.apiVersion]: API_VERSION,
      ...(o.headers ?? {}),
    };
    if (!isAnonymous(route)) {
      if (!this.apiKey) throw new CliError("not logged in", 3, "Run `nearpay login`, or set NEARPAY_API_KEY.");
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    let body: string | undefined;
    if (route.method !== "GET" && route.method !== "DELETE") {
      const b = o.body ?? {};
      this.validate(route, "body", b);
      body = JSON.stringify(b);
      headers["content-type"] = "application/json";
    }
    if (idempotencyKey) headers[HEADERS.idempotencyKey] = idempotencyKey;
    return { url, init: { method: route.method, headers, body } };
  }

  private async send(url: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs: number | null) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs === null ? null : setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctl.signal, redirect: "error" });
    } catch (e) {
      if (signal?.aborted) throw new InterruptedError();
      const reason = ctl.signal.aborted ? `timed out after ${timeoutMs} ms` : (e as Error).message;
      throw new NetworkError(`cannot reach ${new URL(url).origin}: ${reason}`, e);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Turns a non-2xx response into an `ApiError`. */
  async errorFrom(res: Response): Promise<ApiError> {
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (proxy page, …)
    }
    const env = safeParseTolerant(ErrorEnvelope, json);
    const retryAfter = parseRetryAfter(res.headers.get(HEADERS.retryAfter), this.clock.now());
    if (env.success) {
      const e = env.data.error;
      return new ApiError(res.status, e.code, e.message, e.request_id ?? null, e.param ?? null, retryAfter);
    }
    return new ApiError(
      res.status,
      res.status >= 500 ? "api_error" : "invalid_response",
      `unexpected ${res.status} response${text ? `: ${text.slice(0, 200)}` : ""}`,
      res.headers.get(HEADERS.requestId),
      null,
      retryAfter,
    );
  }

  /** Calls a JSON route; retries network errors, 429 and 5xx when the request is safe to repeat. */
  async call<R extends AnyRoute>(
    route: R,
    o: CallOptions<R> = {} as CallOptions<R>,
  ): Promise<ApiResult<RouteResponse<R>>> {
    if (route.stream) throw new CliError(`internal: ${route.id} is a stream; use stream()`);
    const safe = route.method === "GET" || route.idempotent;
    const budget = o.retries ?? (safe ? 2 : 0);
    const key = takesIdempotencyKey(route) ? this.newKey() : null;
    for (let attempt = 0; ; attempt++) {
      const { url, init } = this.buildRequest(route, o as CallOptions<AnyRoute>, key);
      let res: Response;
      try {
        res = await this.send(url, init, o.signal, this.timeoutMs);
      } catch (e) {
        if (e instanceof NetworkError && attempt < budget) {
          await this.clock.sleep(500 * 2 ** attempt, o.signal);
          continue;
        }
        throw e;
      }
      if (res.ok) {
        if (route.response === null) {
          await res.body?.cancel().catch(() => undefined);
          return { data: undefined as RouteResponse<R>, status: res.status, headers: res.headers };
        }
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new CliError(`${route.id}: the API answered ${res.status} with a body that is not JSON`);
        }
        const parsed = safeParseTolerant(route.response, json);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new CliError(
            `${route.id}: response does not match @nearpay/spec (${issue?.path.join(".")}: ${issue?.message})`,
            1,
            "Update the CLI (`npm i -g @nearpay/cli`); if it is current, report this to NearPay.",
          );
        }
        return { data: parsed.data as RouteResponse<R>, status: res.status, headers: res.headers };
      }
      const err = await this.errorFrom(res);
      if ((res.status === 429 || res.status >= 500) && attempt < budget) {
        const wait = err.retryAfterSec !== null ? Math.min(err.retryAfterSec, 30) * 1000 : 500 * 2 ** attempt;
        await this.clock.sleep(wait, o.signal);
        continue;
      }
      throw err;
    }
  }

  /** Opens a server-sent-events route; returns the open response (status 2xx, `text/event-stream`). */
  async stream<R extends AnyRoute>(route: R, o: CallOptions<R> = {} as CallOptions<R>): Promise<Response> {
    if (!route.stream) throw new CliError(`internal: ${route.id} is not a stream`);
    const { url, init } = this.buildRequest(route, o as CallOptions<AnyRoute>, null);
    const res = await this.send(url, init, o.signal, null);
    if (!res.ok) throw await this.errorFrom(res);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("text/event-stream")) {
      await res.body?.cancel().catch(() => undefined);
      throw new NetworkError(`${route.id}: expected text/event-stream, got ${type || "no content type"}`);
    }
    return res;
  }
}
