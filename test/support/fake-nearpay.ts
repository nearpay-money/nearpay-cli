/**
 * A stateful fake of the NearPay public API in test mode, built on the spec-validating mock: the routes
 * the CLI uses behave like the real services (CLI device login with `interval` / `429 slow_down`,
 * the events SSE stream with `Last-Event-ID` resume and `reset`, checkout sessions paid through the
 * sandbox test helper with the documented scenario suffixes, refunds, invoices, subscriptions, events
 * list/resend). Every object it returns and every event it emits is parsed with the spec.
 */
import { randomBytes } from "node:crypto";
import {
  API_VERSION,
  ApiKey,
  CheckoutSession,
  CliLogin,
  CliLoginPoll,
  Customer,
  cancelPaymentIntent,
  cancelRefund,
  cancelSubscription,
  createCheckoutSession,
  createCliLogin,
  createCustomer,
  createInvoice,
  createPrice,
  createProduct,
  createPublicInvoiceSession,
  createRefund,
  createSubscription,
  Event,
  EventResend,
  EventStreamReady,
  EventStreamReset,
  expireCheckoutSession,
  finalizeInvoice,
  getPaymentIntent,
  getRefund,
  ID_ALPHABET,
  Invoice,
  InvoicePaymentSession,
  listEvents,
  markInvoiceUncollectible,
  PaymentIntent,
  Price,
  Product,
  payCheckoutSessionTestHelper,
  pollCliLogin,
  Refund,
  resendEvent,
  Subscription,
  sendInvoice,
  simulateRefundDeposit,
  streamEvents,
  updateSubscription,
  voidInvoice,
  WEBHOOK_TYPE_NAMES,
} from "@nearpay/spec";
import type { z } from "zod";
import { MockApiError, type SpecMock, type SseSink, startSpecMock } from "./spec-mock.js";

type T<S extends z.ZodType> = z.infer<S>;

export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const PAYER = "0x2222222222222222222222222222222222222222";
const SD = "sd_01jbz9k3m4n5p6q7r8s9t0v1w2";
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXZ";

let seq = 0;
/** Monotonic ids (lexicographic = creation order, like UUIDv7). */
export function seqId<P extends string>(prefix: P): `${P}_${string}` {
  let n = ++seq + Date.now() * 1000;
  let s = "";
  while (n > 0) {
    s = ID_ALPHABET[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return `${prefix}_0${s.padStart(25, "0").slice(-25)}` as `${P}_${string}`;
}
const rand = (alphabet: string, n: number) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
const now = () => Math.floor(Date.now() / 1000);

export interface FakeOptions {
  /** Poll interval of CLI logins (seconds, ≥ 1). */
  readonly loginInterval?: number;
  /** Delay before sandbox outcomes land (ms). */
  readonly settleMs?: number;
  /** Comment heartbeat on streams (ms; 0 = none). */
  readonly heartbeatMs?: number;
}

interface LoginState {
  login: T<typeof CliLogin>;
  status: "pending" | "approved" | "denied" | "expired" | "redeemed";
  lastPoll: number;
  key: T<typeof ApiKey> | null;
}

interface Stream {
  readonly sink: SseSink;
  readonly types: readonly string[] | null;
}

export interface FakeNearPay {
  readonly url: string;
  readonly mock: SpecMock;
  readonly account: { readonly id: string; readonly display_name: string };
  readonly events: T<typeof Event>[];
  readonly logins: Map<string, LoginState>;
  readonly streams: Set<Stream>;
  /** Approve the newest pending login (as a dashboard user would). */
  approveLogin(): string;
  denyLogin(): void;
  emit(type: string, object: unknown): T<typeof Event>;
  /** End every open stream cleanly (the 1 h server close). */
  closeStreams(): void;
  /** Destroy every open stream's socket (network error). */
  dropStreams(): void;
  waitForStreams(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeNearPay(o: FakeOptions = {}): Promise<FakeNearPay> {
  const mock = await startSpecMock();
  const settleMs = o.settleMs ?? 30;
  const account = { id: "acct_01jbz9k3m4n5p6q7r8s9t0v1w2", display_name: "Acme Test Shop" };
  const events: T<typeof Event>[] = [];
  const logins = new Map<string, LoginState>();
  const streams = new Set<Stream>();
  const sessions = new Map<
    string,
    T<typeof CheckoutSession> & { secret: string; attempts: { id: string; open: boolean }[] }
  >();
  const intents = new Map<string, T<typeof PaymentIntent>>();
  const refunds = new Map<string, T<typeof Refund>>();
  const prices = new Map<string, T<typeof Price>>();
  const customers = new Map<string, T<typeof Customer>>();
  const invoices = new Map<string, T<typeof Invoice> & { secret: string | null }>();
  const subs = new Map<string, T<typeof Subscription>>();
  const later = (fn: () => void) => setTimeout(fn, settleMs);

  const emit = (type: string, object: unknown) => {
    const ev = Event.parse({
      id: seqId("evt"),
      object: "event",
      type,
      api_version: API_VERSION,
      created: now(),
      livemode: false,
      data: { object: structuredClone(object) },
      request: { id: null, idempotency_key: null },
    });
    events.push(ev);
    for (const s of streams) if (!s.types || s.types.includes(type)) s.sink.send("event", ev, ev.id);
    return ev;
  };
  const bump = <O extends { sequence?: number }>(obj: O) => {
    obj.sequence = (obj.sequence ?? 0) + 1;
    return obj;
  };
  /** Public view of an invoice (without the fake's own `secret`). */
  const pubInvoice = (inv: T<typeof Invoice> & { secret: string | null }) => {
    const { secret: _s, ...rest } = inv;
    return Invoice.parse(rest);
  };
  const evInvoice = (type: string, inv: T<typeof Invoice> & { secret: string | null }) =>
    emit(type, { ...pubInvoice(inv), hosted_invoice_url: null });
  const pubSession = (s: T<typeof CheckoutSession> & { secret: string; attempts: unknown }, created = false) => {
    const { secret: _s, attempts: _a, ...rest } = s;
    return CheckoutSession.parse({ ...rest, ...(created ? {} : { url: null, client_secret: null }) });
  };

  // ------------------------------------------------------------------------------- CLI login
  mock.on(createCliLogin, () => {
    const device_code = `npdc_${rand(ALNUM, 43)}`;
    const user_code = `${rand(CONSONANTS, 4)}-${rand(CONSONANTS, 4)}`;
    const login = CliLogin.parse({
      object: "cli_login",
      device_code,
      user_code,
      verification_url: "https://dashboard.nearpay.localhost/cli",
      verification_url_complete: `https://dashboard.nearpay.localhost/cli?code=${user_code}`,
      expires_at: now() + 900,
      interval: o.loginInterval ?? 1,
    });
    logins.set(device_code, { login, status: "pending", lastPoll: 0, key: null });
    return login;
  });
  mock.on(pollCliLogin, (req) => {
    const st = logins.get(req.body.device_code);
    if (!st) throw new MockApiError("resource_missing");
    const t = Date.now();
    if (t - st.lastPoll < st.login.interval * 1000 - 150) {
      st.lastPoll = t;
      throw new MockApiError("rate_limited", { headers: { "retry-after": String(st.login.interval) } });
    }
    st.lastPoll = t;
    if (st.status === "pending" && now() > st.login.expires_at) st.status = "expired";
    if (st.status === "approved") {
      st.status = "redeemed";
      return CliLoginPoll.parse({
        object: "cli_login_poll",
        status: "approved",
        interval: st.login.interval,
        key: st.key,
        account,
      });
    }
    return CliLoginPoll.parse({ object: "cli_login_poll", status: st.status, interval: st.login.interval });
  });

  // ----------------------------------------------------------------------------------- stream
  mock.on(streamEvents, (req) => {
    const raw = req.query.types;
    const types = raw && raw !== "*" ? raw.split(",") : null;
    for (const [i, t] of (types ?? []).entries()) {
      if (!(WEBHOOK_TYPE_NAMES as readonly string[]).includes(t)) {
        throw new MockApiError("event_type_unknown", { param: `types[${i}]` });
      }
    }
    if (streams.size >= 5) throw new MockApiError("rate_limited", { headers: { "retry-after": "1" } });
    const cursor = (req.headers["last-event-id"] as string | undefined) ?? req.query.starting_after ?? null;
    return {
      $sse: (sink: SseSink) => {
        const idx = cursor ? events.findIndex((e) => e.id === cursor) : -1;
        sink.send(
          "ready",
          EventStreamReady.parse({
            object: "event_stream",
            livemode: false,
            account: account.id,
            types: types ?? ["*"],
            resumed_after: cursor && idx >= 0 ? cursor : null,
            expires_at: now() + 3600,
          }),
        );
        if (cursor && idx < 0) {
          sink.send(
            "reset",
            EventStreamReset.parse({ object: "event_stream_reset", reason: "cursor_unknown", cursor }),
          );
        }
        if (idx >= 0) {
          for (const e of events.slice(idx + 1)) if (!types || types.includes(e.type)) sink.send("event", e, e.id);
        }
        const s: Stream = { sink, types };
        streams.add(s);
        const hb = o.heartbeatMs ? setInterval(() => sink.comment("heartbeat"), o.heartbeatMs) : null;
        void sink.closed.then(() => {
          streams.delete(s);
          if (hb) clearInterval(hb);
        });
      },
    };
  });

  // --------------------------------------------------------------------------------- payments
  mock.on(createCheckoutSession, (req) => {
    const b = req.body;
    const csId = seqId("cs");
    const piId = seqId("pi");
    const secret = `${csId}_secret_${rand(ALNUM, 32)}`;
    const pi = PaymentIntent.parse({
      id: piId,
      object: "payment_intent",
      created: now(),
      livemode: false,
      status: "requires_payment",
      amount: b.amount,
      currency: b.currency,
      asset_id: null,
      description: b.description ?? null,
      source: "checkout",
      checkout_session: csId,
      destination: {
        settlement_destination: SD,
        asset_id: USDC_NEAR,
        type: "intents_account",
        chain: "near:mainnet",
        address: "merchant.near",
      },
      fee: { bearer: "payer", total_bps: 50 },
      settlement_asset_id: USDC_NEAR,
      amount_settled: "0",
      amount_refunded: "0",
      succeeded_at: null,
      late: false,
      canceled_at: null,
      cancellation_reason: null,
      review_reason: null,
      attempts: [],
      overpayments: [],
      sequence: 1,
      metadata: b.metadata ?? {},
    });
    intents.set(piId, pi);
    const cs = {
      ...CheckoutSession.parse({
        id: csId,
        object: "checkout_session",
        created: now(),
        livemode: false,
        status: "open",
        url: `https://pay.nearpay.localhost/c/${csId}#${secret}`,
        client_secret: secret,
        expires_at: now() + 3600,
        payment_intent: piId,
        amount: b.amount,
        currency: b.currency,
        asset_id: null,
        settlement_destination: SD,
        ui_mode: "hosted",
        success_url: b.success_url,
        cancel_url: null,
        description: b.description ?? null,
        allowed_origins: [],
        late_payments: false,
        locale: null,
        completed_at: null,
        late: false,
        sequence: 1,
        metadata: b.metadata ?? {},
        invoice: null,
      }),
      secret,
      attempts: [] as { id: `pa_${string}`; open: boolean }[],
    };
    sessions.set(csId, cs);
    emit("payment_intent.created", pi);
    return pubSession(cs, true);
  });

  const settleIntent = (cs: ReturnType<typeof sessions.get> & object, outcome: string, olderOpen: boolean) => {
    const pi = intents.get(cs.payment_intent as string) as T<typeof PaymentIntent>;
    const inv = cs.invoice ? invoices.get(cs.invoice) : undefined;
    pi.status = "processing";
    emit("payment_intent.processing", bump(pi));
    later(() => {
      if (outcome === "payment_failed") {
        pi.status = "requires_payment";
        emit("payment_intent.payment_failed", bump(pi));
        if (inv) evInvoice("invoice.payment_failed", bump(inv));
        return;
      }
      const suffix = Number(cs.amount) % 100;
      if (suffix === 5) {
        pi.status = "requires_review";
        pi.review_reason = "short_settlement";
        pi.amount_settled = "9949999";
        emit("payment_intent.requires_review", bump(pi));
        return;
      }
      pi.status = "succeeded";
      pi.amount_settled = "9950037";
      pi.succeeded_at = now();
      emit("payment_intent.succeeded", bump(pi));
      cs.status = "complete";
      cs.completed_at = now();
      emit("checkout.session.completed", pubSession(bump(cs)));
      if (suffix === 6 && olderOpen) {
        pi.overpayments = [{ attempt: cs.attempts[0]?.id as `pa_${string}`, amount: "9950037", reason: "duplicate" }];
        emit("payment_intent.overpaid", bump(pi));
      }
      if (inv) {
        inv.status = "paid";
        inv.amount_paid = inv.total;
        inv.amount_remaining = 0;
        inv.payment_intent = pi.id;
        inv.status_transitions.paid_at = now();
        evInvoice("invoice.paid", bump(inv));
      }
    });
  };

  mock.on(payCheckoutSessionTestHelper, (req) => {
    const cs = sessions.get(req.params.id);
    if (!cs) throw new MockApiError("resource_missing");
    if (cs.status !== "open") throw new MockApiError("session_not_open");
    const olderOpen = cs.attempts.some((a) => a.open);
    const attempt = { id: seqId("pa") as `pa_${string}`, open: true };
    cs.attempts.push(attempt);
    const outcome = req.body.outcome ?? "succeeded";
    if (outcome !== "none") {
      attempt.open = false;
      settleIntent(cs, outcome, olderOpen);
    }
    return {
      object: "test_helper_payment" as const,
      checkout_session: cs.id,
      payment_intent: cs.payment_intent as `pi_${string}`,
      payment_attempt: attempt.id,
      outcome,
    };
  });
  mock.on(getPaymentIntent, (req) => {
    const pi = intents.get(req.params.id);
    if (!pi) throw new MockApiError("resource_missing");
    return pi;
  });
  mock.on(expireCheckoutSession, (req) => {
    const cs = sessions.get(req.params.id);
    if (!cs) throw new MockApiError("resource_missing");
    if (cs.status !== "open") throw new MockApiError("state_conflict");
    cs.status = "expired";
    emit("checkout.session.expired", pubSession(bump(cs)));
    return pubSession(cs);
  });
  mock.on(cancelPaymentIntent, (req) => {
    const pi = intents.get(req.params.id);
    if (!pi) throw new MockApiError("resource_missing");
    pi.status = "canceled";
    pi.canceled_at = now();
    pi.cancellation_reason = req.body.cancellation_reason ?? null;
    emit("payment_intent.canceled", bump(pi));
    return pi;
  });

  // ---------------------------------------------------------------------------------- refunds
  mock.on(createRefund, (req) => {
    const pi = intents.get(req.body.payment_intent);
    if (!pi) throw new MockApiError("resource_missing");
    if (pi.status !== "succeeded") throw new MockApiError("intent_not_succeeded");
    const amount = req.body.amount ?? pi.amount_settled;
    if (BigInt(amount) > BigInt(pi.amount_settled) - BigInt(pi.amount_refunded)) {
      throw new MockApiError("amount_exceeds_refundable");
    }
    const deadline = now() + 600;
    const r = Refund.parse({
      id: seqId("re"),
      object: "refund",
      created: now(),
      livemode: false,
      status: "requires_action",
      payment_intent: pi.id,
      payment_attempt: seqId("pa"),
      amount,
      asset_id: USDC_NEAR,
      decimals: 6,
      fee_mode: "payer_absorbs",
      reason: req.body.reason ?? null,
      method: "route_quote",
      recipient: { address: PAYER, asset_id: USDC_NEAR, chain: "eip155:8453", type: "origin_chain", overridden: false },
      next_action: {
        type: "sign_and_send",
        chain: "near:mainnet",
        from: "merchant.near",
        to: "sbx-deposit.near",
        asset_id: USDC_NEAR,
        token: { standard: "nep141", address: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
        symbol: "USDC",
        decimals: 6,
        amount,
        memo: null,
        deadline,
        display: `Send ${amount} USDC`,
      },
      legs: [
        {
          number: 1,
          status: "awaiting_signature",
          method: "route_quote",
          swap_type: "EXACT_INPUT",
          amount,
          amount_out_expected: null,
          deadline,
          submitted_tx: null,
          duplicate: false,
          evidence: null,
          failure_code: null,
          created: now(),
        },
      ],
      amount_received: null,
      evidence: null,
      extra_amount_sent: "0",
      source: "api",
      failure_code: null,
      succeeded_at: null,
      canceled_at: null,
      sequence: 1,
      metadata: req.body.metadata ?? {},
    });
    refunds.set(r.id, r);
    emit("refund.created", r);
    emit("refund.requires_action", r);
    return r;
  });
  mock.on(getRefund, (req) => {
    const r = refunds.get(req.params.id);
    if (!r) throw new MockApiError("resource_missing");
    return r;
  });
  mock.on(simulateRefundDeposit, (req) => {
    const r = refunds.get(req.params.id);
    if (!r) throw new MockApiError("resource_missing");
    if (r.status !== "requires_action") throw new MockApiError("state_conflict");
    r.status = "pending";
    r.next_action = null;
    emit("refund.pending", bump(r));
    later(() => {
      if (BigInt(r.amount) % 100n === 4n) {
        r.status = "failed";
        r.failure_code = "provider_failed";
        emit("refund.failed", bump(r));
      } else {
        r.status = "succeeded";
        r.succeeded_at = now();
        emit("refund.succeeded", bump(r));
      }
    });
    return undefined;
  });
  mock.on(cancelRefund, (req) => {
    const r = refunds.get(req.params.id);
    if (!r) throw new MockApiError("resource_missing");
    if (r.status !== "requires_action") throw new MockApiError("state_conflict");
    r.status = "canceled";
    r.next_action = null;
    r.canceled_at = now();
    emit("refund.canceled", bump(r));
    return r;
  });

  // ---------------------------------------------------------------------------------- billing
  mock.on(createProduct, (req) =>
    Product.parse({
      id: seqId("prod"),
      object: "product",
      created: now(),
      updated: now(),
      livemode: false,
      name: req.body.name,
      description: req.body.description ?? null,
      active: true,
      metadata: req.body.metadata ?? {},
    }),
  );
  mock.on(createPrice, (req) => {
    const p = Price.parse({
      id: seqId("price"),
      object: "price",
      created: now(),
      livemode: false,
      product: req.body.product,
      active: true,
      type: req.body.recurring ? "recurring" : "one_time",
      unit_amount: req.body.unit_amount,
      currency: req.body.currency,
      asset_id: null,
      recurring: req.body.recurring ? { interval: req.body.recurring.interval, interval_count: 1 } : null,
      nickname: null,
      metadata: req.body.metadata ?? {},
    });
    prices.set(p.id, p);
    return p;
  });
  mock.on(createCustomer, (req) => {
    const c = Customer.parse({
      id: seqId("cus"),
      object: "customer",
      created: now(),
      livemode: false,
      email: req.body.email ?? null,
      name: req.body.name ?? null,
      description: null,
      wallets: [],
      metadata: req.body.metadata ?? {},
    });
    customers.set(c.id, c);
    return c;
  });
  mock.on(createInvoice, (req) => {
    const line = req.body.lines?.[0];
    const price = line && "price" in line ? prices.get(line.price) : undefined;
    if (!price) throw new MockApiError("resource_missing", { param: "lines[0].price" });
    if (price.type !== "one_time") throw new MockApiError("price_type_invalid");
    const amount = price.unit_amount;
    const inv = {
      ...Invoice.parse({
        id: seqId("in"),
        object: "invoice",
        created: now(),
        livemode: false,
        status: "draft",
        number: null,
        customer: req.body.customer,
        subscription: null,
        billing_reason: "manual",
        collection_method: "send_invoice",
        currency: price.currency,
        asset_id: null,
        description: null,
        footer: null,
        lines: [
          {
            id: seqId("il"),
            object: "line_item",
            type: "invoiceitem",
            price: price.id,
            product: price.product,
            subscription_item: null,
            description: "NearPay CLI test product",
            quantity: 1,
            unit_amount: amount,
            amount,
            amount_excluding_tax: amount,
            tax_rates: [],
            tax_amounts: [],
            period: null,
          },
        ],
        default_tax_rates: [],
        subtotal: amount,
        tax: 0,
        total: amount,
        total_excluding_tax: amount,
        total_tax_amounts: [],
        amount_due: amount,
        amount_paid: 0,
        amount_remaining: amount,
        days_until_due: 30,
        due_date: null,
        period_start: null,
        period_end: null,
        settlement_destination: null,
        reminder_days: [-3, 0, 1, 3, 7],
        reminders_sent: 0,
        next_reminder_at: null,
        hosted_invoice_url: null,
        invoice_pdf: null,
        checkout_session: null,
        payment_intent: null,
        payment_intents: [],
        status_transitions: {
          finalized_at: null,
          sent_at: null,
          paid_at: null,
          voided_at: null,
          marked_uncollectible_at: null,
        },
        uncollectible_reason: null,
        metadata: req.body.metadata ?? {},
        sequence: 1,
      }),
      secret: null as string | null,
    };
    invoices.set(inv.id, inv);
    evInvoice("invoice.created", inv);
    return pubInvoice(inv);
  });
  const inv = (id: string) => {
    const i = invoices.get(id);
    if (!i) throw new MockApiError("resource_missing");
    return i;
  };
  mock.on(finalizeInvoice, (req) => {
    const i = inv(req.params.id);
    if (i.status !== "draft") throw new MockApiError("state_conflict");
    i.status = "open";
    i.number = `ACME-${String(invoices.size).padStart(5, "0")}`;
    i.secret = `${i.id}_secret_${rand(ALNUM, 32)}`;
    i.hosted_invoice_url = `https://pay.nearpay.localhost/i/${i.id}#${i.secret}`;
    i.invoice_pdf = `https://api.nearpay.localhost/v1/invoices/${i.id}/pdf`;
    i.due_date = now() + 30 * 86_400;
    i.status_transitions.finalized_at = now();
    evInvoice("invoice.finalized", bump(i));
    return pubInvoice(i);
  });
  mock.on(sendInvoice, (req) => {
    const i = inv(req.params.id);
    if (i.status !== "open") throw new MockApiError("state_conflict");
    i.status_transitions.sent_at = now();
    evInvoice("invoice.sent", bump(i));
    return pubInvoice(i);
  });
  mock.on(voidInvoice, (req) => {
    const i = inv(req.params.id);
    i.status = "void";
    i.status_transitions.voided_at = now();
    evInvoice("invoice.voided", bump(i));
    return pubInvoice(i);
  });
  mock.on(markInvoiceUncollectible, (req) => {
    const i = inv(req.params.id);
    i.status = "uncollectible";
    i.uncollectible_reason = "merchant";
    i.status_transitions.marked_uncollectible_at = now();
    evInvoice("invoice.marked_uncollectible", bump(i));
    return pubInvoice(i);
  });
  mock.on(createPublicInvoiceSession, async (req) => {
    const i = inv(req.params.id);
    if (req.headers["x-nearpay-invoice-secret"] !== i.secret) throw new MockApiError("invoice_secret_invalid");
    if (i.status === "paid" || i.status === "void") throw new MockApiError("invoice_not_payable");
    // Payments creates the invoice's session (internal route in reality).
    const created = await fetch(`${mock.url}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_fakeinternal",
        "content-type": "application/json",
        "nearpay-version": API_VERSION,
        "user-agent": "nearpay-cli/fake node/x",
        "idempotency-key": `inv-${i.id}`,
      },
      body: JSON.stringify({ amount: i.total, currency: i.currency, success_url: "https://example.com/paid" }),
    }).then((r) => r.json() as Promise<{ id: `cs_${string}`; client_secret: string; expires_at: number }>);
    const cs = sessions.get(created.id);
    if (cs) cs.invoice = i.id;
    i.checkout_session = created.id;
    return InvoicePaymentSession.parse({
      object: "invoice_payment_session",
      checkout_session: created.id,
      client_secret: created.client_secret,
      expires_at: new Date(created.expires_at * 1000).toISOString(),
      reused: false,
    });
  });
  mock.on(createSubscription, (req) => {
    const price = prices.get(req.body.items[0]?.price ?? "");
    if (!price?.recurring) throw new MockApiError("price_type_invalid");
    const trialEnd = req.body.trial_period_days ? now() + req.body.trial_period_days * 86_400 : null;
    const s = Subscription.parse({
      id: seqId("sub"),
      object: "subscription",
      created: now(),
      livemode: false,
      customer: req.body.customer,
      status: trialEnd ? "trialing" : "incomplete",
      collection_method: "send_invoice",
      items: [{ id: seqId("si"), object: "subscription_item", price, quantity: 1, tax_rates: null }],
      currency: price.currency,
      asset_id: null,
      recurring: price.recurring,
      billing_cycle_anchor: trialEnd ?? now(),
      current_period_start: now(),
      current_period_end: trialEnd ?? now() + 30 * 86_400,
      days_until_due: 7,
      default_tax_rates: [],
      dunning: { reminder_days: [-3, 0, 1, 3, 7], on_exhausted: "cancel" },
      trial_start: trialEnd ? now() : null,
      trial_end: trialEnd,
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      cancellation_reason: null,
      latest_invoice: null,
      settlement_destination: null,
      description: null,
      metadata: req.body.metadata ?? {},
      sequence: 1,
    });
    subs.set(s.id, s);
    emit("customer.subscription.created", s);
    return s;
  });
  mock.on(updateSubscription, (req) => {
    const s = subs.get(req.params.id);
    if (!s) throw new MockApiError("resource_missing");
    if (req.body.cancel_at_period_end !== undefined) s.cancel_at_period_end = req.body.cancel_at_period_end;
    if (req.body.metadata) s.metadata = req.body.metadata;
    emit("customer.subscription.updated", bump(s));
    return s;
  });
  mock.on(cancelSubscription, (req) => {
    const s = subs.get(req.params.id);
    if (!s) throw new MockApiError("resource_missing");
    s.status = "canceled";
    s.canceled_at = now();
    s.ended_at = now();
    s.cancellation_reason = "requested";
    emit("customer.subscription.deleted", bump(s));
    return s;
  });

  // ----------------------------------------------------------------------------------- events
  mock.on(listEvents, (req) => {
    const q = req.query;
    let list = [...events].reverse();
    if (q.type) list = list.filter((e) => e.type === q.type);
    const gte = q["created[gte]"];
    if (gte !== undefined) list = list.filter((e) => e.created >= gte);
    if (q.starting_after) {
      const i = list.findIndex((e) => e.id === q.starting_after);
      list = i >= 0 ? list.slice(i + 1) : [];
    }
    const limit = q.limit ?? 10;
    return { object: "list" as const, data: list.slice(0, limit), has_more: list.length > limit, url: "/v1/events" };
  });
  mock.on(resendEvent, (req) => {
    const e = events.find((x) => x.id === req.params.id);
    if (!e) throw new MockApiError("resource_missing");
    return EventResend.parse({
      object: "event_resend",
      event: e.id,
      deliveries: [
        {
          id: seqId("whd"),
          object: "webhook_delivery",
          created: now(),
          livemode: false,
          webhook_endpoint: req.body.endpoint ?? "we_01jbz9k3m4n5p6q7r8s9t0v1w2",
          event: e.id,
          event_type: e.type,
          status: "pending",
          attempts: 0,
          last_status_code: null,
          last_error: null,
          next_attempt_at: now(),
          succeeded_at: null,
        },
      ],
    });
  });

  const newestPending = () => {
    const st = [...logins.values()].reverse().find((l) => l.status === "pending");
    if (!st) throw new Error("no pending login");
    return st;
  };

  return {
    url: mock.url,
    mock,
    account,
    events,
    logins,
    streams,
    approveLogin() {
      const st = newestPending();
      const secret = `rk_test_${rand(ALNUM, 48)}`;
      st.key = ApiKey.parse({
        id: seqId("key"),
        object: "api_key",
        created: now(),
        livemode: false,
        type: "restricted",
        name: "CLI · test-host",
        display_prefix: "rk_test_",
        last4: secret.slice(-4),
        scopes: [],
        ip_allowlist: [],
        expires_at: now() + 90 * 86_400,
        last_used_at: null,
        secret,
      });
      st.status = "approved";
      return secret;
    },
    denyLogin() {
      newestPending().status = "denied";
    },
    emit,
    closeStreams() {
      for (const s of streams) s.sink.end();
    },
    dropStreams() {
      for (const s of streams) s.sink.destroy();
    },
    async waitForStreams(n, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while (streams.size < n) {
        if (Date.now() > end) throw new Error(`expected ${n} open streams, have ${streams.size}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => mock.close(),
  };
}
