/**
 * `nearpay trigger <event>` (sdks-and-tools §3): fixtures made of **real** test-mode API calls with the
 * CLI key — never synthetic events. Every public webhook type has an entry: a fixture, or the reason it
 * cannot be produced through the public API in spec 0.3.0. Sandbox outcomes are chosen the documented
 * way (lld/sandbox.md §4: the last two digits of the scenario amount; payments §16.1 test helper).
 */
import {
  type CheckoutSession,
  cancelPaymentIntent,
  cancelRefund,
  cancelSubscription,
  createCheckoutSession,
  createCustomer,
  createInvoice,
  createPrice,
  createProduct,
  createPublicInvoiceSession,
  createRefund,
  createSubscription,
  expireCheckoutSession,
  finalizeInvoice,
  getPaymentIntent,
  getRefund,
  type Invoice,
  InvoiceSecret,
  listEvents,
  markInvoiceUncollectible,
  type PaymentIntent,
  payCheckoutSessionTestHelper,
  type Refund,
  sendInvoice,
  simulateRefundDeposit,
  updateSubscription,
  voidInvoice,
  WEBHOOK_TYPE_NAMES,
  type WebhookType,
} from "@nearpay-money/spec";
import type { ApiClient } from "./api.js";
import { CliError, EXIT } from "./errors.js";
import type { Clock } from "./time.js";

export interface TriggerContext {
  readonly api: ApiClient;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  /** Progress line ("Created checkout session cs_…"). */
  readonly step: (message: string) => void;
  /** `restricted` for the CLI key (`CLI_KEY_SCOPES`), `secret` for an `sk_test_` override. */
  readonly keyKind: "secret" | "restricted";
  /** Budget for waiting on asynchronous state (intent succeeded, refund leg prepared). */
  readonly waitMs: number;
  /** Poll interval for those waits. */
  readonly pollMs: number;
}

export interface TriggerOutcome {
  /** The event that proves the trigger worked, and the object it is about. */
  readonly target: { readonly type: WebhookType; readonly objectId: string };
  /** Objects created, for the summary. */
  readonly objects: Readonly<Record<string, string>>;
}

export type Fixture =
  | {
      readonly kind: "supported";
      readonly summary: string;
      readonly run: (ctx: TriggerContext) => Promise<TriggerOutcome>;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

// ------------------------------------------------------------------------------------- helpers

/** Fiat amounts in USD minor units; the last two digits pick the sandbox scenario (sandbox §4). */
export const AMOUNTS = {
  /** `00`: settles in ~5 s. */
  normal: 1000,
  /** `05`: settles one base unit short → short settlement → `requires_review`. */
  short: 1005,
  /** `06`: a deposit also pays the older open quote → duplicate settlement → `overpaid`. */
  duplicate: 1006,
} as const;

const SUCCESS_URL = "https://example.com/nearpay-cli/success";
const CUSTOMER_EMAIL = "nearpay-cli-trigger@example.com";
const meta = (event: string) => ({ nearpay_cli_trigger: event });

const intentId = (cs: CheckoutSession): string =>
  typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent.id;

async function session(ctx: TriggerContext, event: string, amount: number = AMOUNTS.normal) {
  const { data: cs } = await ctx.api.call(createCheckoutSession, {
    body: {
      amount,
      currency: "usd",
      success_url: SUCCESS_URL,
      description: `nearpay trigger ${event}`,
      metadata: meta(event),
    },
    signal: ctx.signal,
  });
  ctx.step(`Created checkout session ${cs.id} (payment intent ${intentId(cs)}, USD ${(amount / 100).toFixed(2)})`);
  return cs;
}

async function pay(ctx: TriggerContext, cs: string, outcome: "succeeded" | "payment_failed" | "refunded" | "none") {
  const { data } = await ctx.api.call(payCheckoutSessionTestHelper, {
    params: { id: cs },
    body: { outcome },
    signal: ctx.signal,
  });
  ctx.step(`Paid ${cs} through the sandbox (attempt ${data.payment_attempt}, outcome ${outcome})`);
  return data;
}

/** Polls until `check` returns a value; throws a timeout error naming `what`. */
async function until<T>(ctx: TriggerContext, what: string, check: () => Promise<T | null>): Promise<T> {
  const deadline = ctx.clock.now() + ctx.waitMs;
  for (;;) {
    const v = await check();
    if (v !== null) return v;
    if (ctx.clock.now() >= deadline) {
      throw new CliError(`timed out after ${Math.round(ctx.waitMs / 1000)} s waiting for ${what}`, EXIT.timeout);
    }
    await ctx.clock.sleep(ctx.pollMs, ctx.signal);
  }
}

async function succeededIntent(ctx: TriggerContext, pi: string): Promise<PaymentIntent> {
  ctx.step(`Waiting for ${pi} to succeed…`);
  return until(ctx, `${pi} to succeed`, async () => {
    const { data } = await ctx.api.call(getPaymentIntent, { params: { id: pi }, signal: ctx.signal });
    if (data.status === "succeeded") return data;
    if (data.status === "canceled" || data.status === "expired" || data.status === "requires_review") {
      throw new CliError(`${pi} ended ${data.status} instead of succeeding`);
    }
    return null;
  });
}

/** A paid intent ready to refund. */
async function paidIntent(ctx: TriggerContext, event: string): Promise<{ cs: string; pi: PaymentIntent }> {
  const cs = await session(ctx, event);
  await pay(ctx, cs.id, "succeeded");
  return { cs: cs.id, pi: await succeededIntent(ctx, intentId(cs)) };
}

/**
 * Refund amount ≤ what settled whose last two digits are `suffix` (the refund leg's sandbox scenario:
 * `00` succeeds; `04` fails after processing, which rails holds for review — the refund stays pending).
 */
export function refundAmount(settled: string, suffix: 0 | 4): string {
  const s = BigInt(settled);
  let a = (s / 100n) * 100n + BigInt(suffix);
  if (a > s) a -= 100n;
  if (a <= 0n) throw new CliError(`the settled amount ${settled} is too small for a sandbox refund scenario`);
  return a.toString();
}

async function refund(ctx: TriggerContext, event: string, suffix: 0 | 4): Promise<{ cs: string; refund: Refund }> {
  const { cs, pi } = await paidIntent(ctx, event);
  const amount = refundAmount(pi.amount_settled, suffix);
  const { data } = await ctx.api.call(createRefund, {
    body: { payment_intent: pi.id, amount, reason: "requested_by_customer", metadata: meta(event) },
    signal: ctx.signal,
  });
  ctx.step(`Created refund ${data.id} of ${amount} base units (status ${data.status})`);
  return { cs, refund: data };
}

/** Sends the merchant's leg in the sandbox once the leg is prepared (`next_action` set). */
async function sendRefundLeg(ctx: TriggerContext, r: Refund): Promise<void> {
  if (r.next_action === null) {
    ctx.step(`Waiting for refund ${r.id} to be prepared…`);
    await until(ctx, `refund ${r.id} to be prepared`, async () => {
      const { data } = await ctx.api.call(getRefund, { params: { id: r.id }, signal: ctx.signal });
      if (data.status === "requires_action" && data.next_action !== null) return data;
      if (data.status !== "requires_action")
        throw new CliError(`refund ${r.id} is ${data.status}, not requires_action`);
      return null;
    });
  }
  await ctx.api.call(simulateRefundDeposit, { params: { id: r.id }, body: {}, signal: ctx.signal });
  ctx.step(`Simulated the merchant's signed transfer for ${r.id}`);
}

async function catalogue(ctx: TriggerContext, event: string, recurring: boolean) {
  const { data: product } = await ctx.api.call(createProduct, {
    body: { name: "NearPay CLI test product", metadata: meta(event) },
    signal: ctx.signal,
  });
  const { data: price } = await ctx.api.call(createPrice, {
    body: {
      product: product.id,
      unit_amount: AMOUNTS.normal,
      currency: "usd",
      ...(recurring ? { recurring: { interval: "month" as const } } : {}),
      metadata: meta(event),
    },
    signal: ctx.signal,
  });
  const { data: customer } = await ctx.api.call(createCustomer, {
    body: { email: CUSTOMER_EMAIL, name: "NearPay CLI trigger", metadata: meta(event) },
    signal: ctx.signal,
  });
  ctx.step(
    `Created product ${product.id}, ${recurring ? "monthly" : "one-time"} price ${price.id}, customer ${customer.id}`,
  );
  return { product: product.id, price: price.id, customer: customer.id };
}

type InvoiceStage = "created" | "finalized" | "sent";

async function invoice(ctx: TriggerContext, event: string, stage: InvoiceStage) {
  const cat = await catalogue(ctx, event, false);
  let { data: inv } = await ctx.api.call(createInvoice, {
    body: { customer: cat.customer, lines: [{ price: cat.price }], metadata: meta(event) },
    signal: ctx.signal,
  });
  ctx.step(`Created draft invoice ${inv.id}`);
  if (stage !== "created") {
    inv = (await ctx.api.call(finalizeInvoice, { params: { id: inv.id }, body: {}, signal: ctx.signal })).data;
    ctx.step(`Finalized ${inv.id}${inv.number ? ` (${inv.number})` : ""}`);
  }
  if (stage === "sent") {
    inv = (await ctx.api.call(sendInvoice, { params: { id: inv.id }, body: {}, signal: ctx.signal })).data;
    ctx.step(`Sent ${inv.id} to ${CUSTOMER_EMAIL}`);
  }
  return { ...cat, invoice: inv };
}

/** The invoice secret from `hosted_invoice_url` (`<pay origin>/i/<id>#<secret>`). */
export function invoiceSecretFrom(inv: Pick<Invoice, "id" | "hosted_invoice_url">): string {
  const url = inv.hosted_invoice_url;
  if (!url) throw new CliError(`invoice ${inv.id} has no hosted_invoice_url (is it finalized?)`);
  const secret = decodeURIComponent(new URL(url).hash.slice(1));
  if (!InvoiceSecret.safeParse(secret).success) {
    throw new CliError(`invoice ${inv.id}: hosted_invoice_url does not carry an invoice secret`);
  }
  return secret;
}

/** Pays an invoice the way its customer would: hosted page session → sandbox payment. */
async function payInvoice(ctx: TriggerContext, event: string, outcome: "succeeded" | "payment_failed") {
  const r = await invoice(ctx, event, "sent");
  const { data: s } = await ctx.api.call(createPublicInvoiceSession, {
    params: { id: r.invoice.id },
    headers: { "x-nearpay-invoice-secret": invoiceSecretFrom(r.invoice) },
    body: {},
    signal: ctx.signal,
  });
  ctx.step(`Opened the hosted invoice page session ${s.checkout_session}`);
  await pay(ctx, s.checkout_session, outcome);
  return {
    target: { type: event as WebhookType, objectId: r.invoice.id },
    objects: { invoice: r.invoice.id, checkout_session: s.checkout_session, customer: r.customer },
  };
}

async function subscription(ctx: TriggerContext, event: string) {
  const cat = await catalogue(ctx, event, true);
  // A trial keeps the fixture free of a first invoice (and of the customer email it would send).
  const { data: sub } = await ctx.api.call(createSubscription, {
    body: { customer: cat.customer, items: [{ price: cat.price }], trial_period_days: 30, metadata: meta(event) },
    signal: ctx.signal,
  });
  ctx.step(`Created subscription ${sub.id} (status ${sub.status}, 30-day trial)`);
  return { ...cat, subscription: sub.id };
}

// ------------------------------------------------------------------------------------ fixtures

const paymentSucceeded = (type: WebhookType, summary: string): Fixture => ({
  kind: "supported",
  summary,
  run: async (ctx) => {
    const cs = await session(ctx, type);
    const p = await pay(ctx, cs.id, "succeeded");
    const objectId = type.startsWith("checkout.session.") ? cs.id : p.payment_intent;
    return { target: { type, objectId }, objects: { checkout_session: cs.id, payment_intent: p.payment_intent } };
  },
});

const invoiceAt = (type: WebhookType, stage: InvoiceStage, summary: string): Fixture => ({
  kind: "supported",
  summary,
  run: async (ctx) => {
    const r = await invoice(ctx, type, stage);
    return { target: { type, objectId: r.invoice.id }, objects: { invoice: r.invoice.id, customer: r.customer } };
  },
});

const unsupported = (reason: string): Fixture => ({ kind: "unsupported", reason });
const MANDATE_REASON =
  "needs a payer-funded auto-debit mandate (Stage 4, spec 0.4.0); the CLI test key cannot act as the payer";

export const TRIGGERS = {
  "checkout.session.completed": paymentSucceeded(
    "checkout.session.completed",
    "checkout session → sandbox payment (outcome succeeded)",
  ),
  "checkout.session.expired": {
    kind: "supported",
    summary: "checkout session → expire",
    run: async (ctx) => {
      const cs = await session(ctx, "checkout.session.expired");
      await ctx.api.call(expireCheckoutSession, { params: { id: cs.id }, body: {}, signal: ctx.signal });
      ctx.step(`Expired ${cs.id}`);
      return {
        target: { type: "checkout.session.expired", objectId: cs.id },
        objects: { checkout_session: cs.id, payment_intent: intentId(cs) },
      };
    },
  },
  "payment_intent.created": {
    kind: "supported",
    summary: "checkout session (creates its payment intent)",
    run: async (ctx) => {
      const cs = await session(ctx, "payment_intent.created");
      return {
        target: { type: "payment_intent.created", objectId: intentId(cs) },
        objects: { checkout_session: cs.id, payment_intent: intentId(cs) },
      };
    },
  },
  "payment_intent.processing": paymentSucceeded(
    "payment_intent.processing",
    "checkout session → sandbox payment (the deposit puts the intent in processing)",
  ),
  "payment_intent.succeeded": paymentSucceeded(
    "payment_intent.succeeded",
    "checkout session → sandbox payment (outcome succeeded)",
  ),
  "payment_intent.payment_failed": {
    kind: "supported",
    summary: "checkout session → sandbox payment (outcome payment_failed)",
    run: async (ctx) => {
      const cs = await session(ctx, "payment_intent.payment_failed");
      const p = await pay(ctx, cs.id, "payment_failed");
      return {
        target: { type: "payment_intent.payment_failed", objectId: p.payment_intent },
        objects: { checkout_session: cs.id, payment_intent: p.payment_intent },
      };
    },
  },
  "payment_intent.requires_review": {
    kind: "supported",
    summary: "USD 10.05 session → sandbox payment; scenario 05 settles one base unit short",
    run: async (ctx) => {
      const cs = await session(ctx, "payment_intent.requires_review", AMOUNTS.short);
      const p = await pay(ctx, cs.id, "succeeded");
      return {
        target: { type: "payment_intent.requires_review", objectId: p.payment_intent },
        objects: { checkout_session: cs.id, payment_intent: p.payment_intent },
      };
    },
  },
  "payment_intent.overpaid": {
    kind: "supported",
    summary: "USD 10.06 session → open quote → second payment; scenario 06 also pays the older quote",
    run: async (ctx) => {
      const cs = await session(ctx, "payment_intent.overpaid", AMOUNTS.duplicate);
      const first = await pay(ctx, cs.id, "none");
      const second = await pay(ctx, cs.id, "succeeded");
      return {
        target: { type: "payment_intent.overpaid", objectId: second.payment_intent },
        objects: {
          checkout_session: cs.id,
          payment_intent: second.payment_intent,
          older_attempt: first.payment_attempt,
          paying_attempt: second.payment_attempt,
        },
      };
    },
  },
  "payment_intent.canceled": {
    kind: "supported",
    summary: "checkout session → cancel its payment intent (needs a secret test key)",
    run: async (ctx) => {
      if (ctx.keyKind === "restricted") {
        throw new CliError(
          "payment_intent.canceled needs the payment_intents.write scope, which the CLI login key does not have",
          EXIT.usage,
          "Run it with a secret test key: `nearpay trigger payment_intent.canceled --api-key sk_test_…`.",
        );
      }
      const cs = await session(ctx, "payment_intent.canceled");
      const pi = intentId(cs);
      await ctx.api.call(cancelPaymentIntent, {
        params: { id: pi },
        body: { cancellation_reason: "nearpay trigger" },
        signal: ctx.signal,
      });
      ctx.step(`Canceled ${pi}`);
      return {
        target: { type: "payment_intent.canceled", objectId: pi },
        objects: { checkout_session: cs.id, payment_intent: pi },
      };
    },
  },
  "agent_payment.settled": unsupported(
    "needs an x402 agent signer funded in the sandbox; spec 0.3.0 has no public test-mode faucet or agent-payment test helper",
  ),
  "agent_payment.failed": unsupported(
    "needs an x402 agent signer funded in the sandbox; spec 0.3.0 has no public test-mode faucet or agent-payment test helper",
  ),
  ping: unsupported(
    "generated by webhooks for one endpoint (`POST /v1/webhook_endpoints/{id}/test`, the dashboard's Send test event)",
  ),
  "account.updated": unsupported("account settings change only through dashboard sessions, not API keys"),
  "refund.created": {
    kind: "supported",
    summary: "paid intent → create refund",
    run: async (ctx) => {
      const r = await refund(ctx, "refund.created", 0);
      return {
        target: { type: "refund.created", objectId: r.refund.id },
        objects: { checkout_session: r.cs, refund: r.refund.id },
      };
    },
  },
  "refund.requires_action": {
    kind: "supported",
    summary: "paid intent → create refund (its leg waits for the merchant's signature)",
    run: async (ctx) => {
      const r = await refund(ctx, "refund.requires_action", 0);
      return {
        target: { type: "refund.requires_action", objectId: r.refund.id },
        objects: { checkout_session: r.cs, refund: r.refund.id },
      };
    },
  },
  "refund.pending": {
    kind: "supported",
    summary: "paid intent → refund → simulated merchant transfer",
    run: async (ctx) => {
      const r = await refund(ctx, "refund.pending", 0);
      await sendRefundLeg(ctx, r.refund);
      return {
        target: { type: "refund.pending", objectId: r.refund.id },
        objects: { checkout_session: r.cs, refund: r.refund.id },
      };
    },
  },
  "refund.succeeded": {
    kind: "supported",
    summary: "paid intent → refund (amount …00) → simulated merchant transfer",
    run: async (ctx) => {
      const r = await refund(ctx, "refund.succeeded", 0);
      await sendRefundLeg(ctx, r.refund);
      return {
        target: { type: "refund.succeeded", objectId: r.refund.id },
        objects: { checkout_session: r.cs, refund: r.refund.id },
      };
    },
  },
  "refund.failed": unsupported(
    "no fast public test-mode path to a failed refund: a refund leg that fails after the merchant's transfer (sandbox scenario 04) is held for review (the refund stays pending, review.opened), and the scenario that returns the transfer (02) only resolves at the leg's deadline",
  ),
  "refund.canceled": {
    kind: "supported",
    summary: "paid intent → refund → cancel before signing",
    run: async (ctx) => {
      const r = await refund(ctx, "refund.canceled", 0);
      await ctx.api.call(cancelRefund, { params: { id: r.refund.id }, body: {}, signal: ctx.signal });
      ctx.step(`Canceled refund ${r.refund.id}`);
      return {
        target: { type: "refund.canceled", objectId: r.refund.id },
        objects: { checkout_session: r.cs, refund: r.refund.id },
      };
    },
  },
  "review.opened": unsupported("compliance reviews open on held executions; no public test helper produces one"),
  "review.closed": unsupported("reviews are closed by NearPay operators, not through the public API"),
  "invoice.created": invoiceAt("invoice.created", "created", "product → price → customer → draft invoice"),
  "invoice.finalized": invoiceAt("invoice.finalized", "finalized", "draft invoice → finalize"),
  "invoice.sent": invoiceAt("invoice.sent", "sent", "draft invoice → finalize → send"),
  "invoice.paid": {
    kind: "supported",
    summary: "sent invoice → hosted page session → sandbox payment (succeeded)",
    run: (ctx) => payInvoice(ctx, "invoice.paid", "succeeded"),
  },
  "invoice.payment_failed": {
    kind: "supported",
    summary: "sent invoice → hosted page session → sandbox payment (payment_failed)",
    run: (ctx) => payInvoice(ctx, "invoice.payment_failed", "payment_failed"),
  },
  "invoice.overdue": unsupported(
    "needs a billing test helper that advances an invoice past its due date (not in spec 0.3.0)",
  ),
  "invoice.voided": {
    kind: "supported",
    summary: "finalized invoice → void",
    run: async (ctx) => {
      const r = await invoice(ctx, "invoice.voided", "finalized");
      await ctx.api.call(voidInvoice, { params: { id: r.invoice.id }, body: {}, signal: ctx.signal });
      ctx.step(`Voided ${r.invoice.id}`);
      return { target: { type: "invoice.voided", objectId: r.invoice.id }, objects: { invoice: r.invoice.id } };
    },
  },
  "invoice.marked_uncollectible": {
    kind: "supported",
    summary: "finalized invoice → mark uncollectible",
    run: async (ctx) => {
      const r = await invoice(ctx, "invoice.marked_uncollectible", "finalized");
      await ctx.api.call(markInvoiceUncollectible, { params: { id: r.invoice.id }, body: {}, signal: ctx.signal });
      ctx.step(`Marked ${r.invoice.id} uncollectible`);
      return {
        target: { type: "invoice.marked_uncollectible", objectId: r.invoice.id },
        objects: { invoice: r.invoice.id },
      };
    },
  },
  "customer.subscription.created": {
    kind: "supported",
    summary: "product → monthly price → customer → subscription (30-day trial)",
    run: async (ctx) => {
      const r = await subscription(ctx, "customer.subscription.created");
      return {
        target: { type: "customer.subscription.created", objectId: r.subscription },
        objects: { subscription: r.subscription, customer: r.customer },
      };
    },
  },
  "customer.subscription.updated": {
    kind: "supported",
    summary: "subscription → schedule cancellation at period end",
    run: async (ctx) => {
      const r = await subscription(ctx, "customer.subscription.updated");
      await ctx.api.call(updateSubscription, {
        params: { id: r.subscription },
        body: { cancel_at_period_end: true },
        signal: ctx.signal,
      });
      ctx.step(`Scheduled ${r.subscription} to cancel at period end`);
      return {
        target: { type: "customer.subscription.updated", objectId: r.subscription },
        objects: { subscription: r.subscription, customer: r.customer },
      };
    },
  },
  "customer.subscription.deleted": {
    kind: "supported",
    summary: "subscription → cancel now",
    run: async (ctx) => {
      const r = await subscription(ctx, "customer.subscription.deleted");
      await ctx.api.call(cancelSubscription, { params: { id: r.subscription }, body: {}, signal: ctx.signal });
      ctx.step(`Canceled ${r.subscription}`);
      return {
        target: { type: "customer.subscription.deleted", objectId: r.subscription },
        objects: { subscription: r.subscription, customer: r.customer },
      };
    },
  },
  "customer.subscription.renewal_upcoming": unsupported(
    "needs a billing test helper that advances a subscription's clock (not in spec 0.3.0)",
  ),
  // Stage 4 auto-debit (spec 0.4.0): a mandate is created and funded by the payer's wallet in the subscription
  // vault; the CLI's test key cannot act as the payer, so mandate events are not triggerable yet.
  "mandate.activated": unsupported(MANDATE_REASON),
  "mandate.collected": unsupported(MANDATE_REASON),
  "mandate.insufficient_funds": unsupported(MANDATE_REASON),
  "mandate.canceled": unsupported(MANDATE_REASON),
  "mandate.exhausted": unsupported(MANDATE_REASON),
  "mandate.updated": unsupported(MANDATE_REASON),
  "mandate.unlinked": unsupported(MANDATE_REASON),
  "mandate.released": unsupported(MANDATE_REASON),
} satisfies Record<WebhookType, Fixture>;

export function fixtureFor(type: string): Fixture | null {
  return (WEBHOOK_TYPE_NAMES as readonly string[]).includes(type) ? TRIGGERS[type as WebhookType] : null;
}

/** Polls `GET /v1/events?type=` until an event about `objectId` appears; returns its id. */
export async function waitForEvent(
  ctx: Pick<TriggerContext, "api" | "clock" | "signal" | "pollMs">,
  target: TriggerOutcome["target"],
  sinceUnix: number,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = ctx.clock.now() + timeoutMs;
  for (;;) {
    const { data } = await ctx.api.call(listEvents, {
      query: { type: target.type, "created[gte]": Math.max(0, sinceUnix - 60), limit: 100 },
      signal: ctx.signal,
    });
    const hit = data.data.find((e) => (e.data.object as { id?: string }).id === target.objectId);
    if (hit) return hit.id;
    if (ctx.clock.now() >= deadline) return null;
    await ctx.clock.sleep(ctx.pollMs, ctx.signal);
  }
}
