# nearpay-cli

> Developer CLI: login, listen (forward webhooks to localhost), trigger test events, resend events.

|                                       |                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Group                                 | SDKs & tools                                                                      |
| Kind                                  | binary                                                                            |
| Ships as                              | npm: `@nearpay/cli` (bin `nearpay`) + standalone binaries (`bun build --compile`) |
| Owns                                  | CLI                                                                               |
| Depends on (published artifacts only) | `@nearpay/spec` 0.3.0 (public)                                                    |
| First built in                        | Stage 3 (step 3.3)                                                                |

**Test mode only.** The CLI talks to the public API only, with a restricted **test** key it gets from
`nearpay login` (or a `sk_test_` / `rk_test_` key you pass). Live keys are refused before any request.

## Install

```sh
npm install -g @nearpay/cli      # Node ≥ 22.11
nearpay --help
```

Or download the single-file binary for your OS from the CI artifacts (`nearpay-<platform>-<arch>`).

## Do X → see Y

| Do                                                                  | See                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nearpay login`                                                     | `Your pairing code is: BCDF-GHJK` and the dashboard opens at the approval page. Check the code matches, approve; the CLI prints `Done! Logged in to <account> (acct_…) in test mode.` The key (`rk_test_…`, 90 days) is stored in the OS keychain. |
| `nearpay login --no-browser`                                        | The same, but only the link is printed (SSH sessions, containers).                                                                                                                                                                                 |
| `nearpay whoami`                                                    | Account, masked key, expiry, where it is stored, and `✓ the key is accepted` (a live check). `--json` for scripts.                                                                                                                                 |
| `nearpay listen`                                                    | `--> payment_intent.succeeded [evt_…] pi_…` for every event in your test account, live.                                                                                                                                                            |
| `nearpay listen --forward-to localhost:3000/webhooks`               | `Ready! Your webhook signing secret for this session is whsec_…`, then per event `-->` (received) and `<-- [200] POST http://localhost:3000/webhooks [evt_…] (12 ms)` (your endpoint's answer).                                                    |
| `nearpay listen --events payment_intent.succeeded,refund.succeeded` | Only those types.                                                                                                                                                                                                                                  |
| `nearpay listen --print-json`                                       | One event JSON per line on stdout (pipe into `jq`); status lines go to stderr.                                                                                                                                                                     |
| `nearpay trigger`                                                   | The list of events that can be triggered, and why the others cannot.                                                                                                                                                                               |
| `nearpay trigger payment_intent.succeeded`                          | Each API call it makes (`• Created checkout session cs_…`, `• Paid cs_… through the sandbox`), then `✓ payment_intent.succeeded evt_… (pi_…)` once the event exists. A running `nearpay listen` shows (and forwards) every event of the flow.      |
| `nearpay trigger refund.succeeded`                                  | A paid session, a refund, the simulated merchant transfer, then `✓ refund.succeeded evt_… (re_…)`.                                                                                                                                                 |
| `nearpay trigger invoice.paid --json`                               | Product → price → customer → invoice → finalize → send → hosted page session → sandbox payment; a JSON summary with the event id.                                                                                                                  |
| `nearpay events list --type refund.succeeded -n 20`                 | `evt_…  2026-11-08 12:00:00  refund.succeeded  re_…` lines, newest first, and the `--starting-after` command for the next page.                                                                                                                    |
| `nearpay events resend evt_…`                                       | `Queued 1 delivery of evt_…:  whd_… → we_… (pending)` — your webhook endpoints get it again. `--endpoint we_…` for one endpoint.                                                                                                                   |
| `nearpay logout`                                                    | The local copy of the key is deleted; the CLI reminds you to revoke the key (`CLI · <host>`) in the dashboard — only dashboard sessions can revoke keys.                                                                                           |

### Verify forwarded events in your app

`listen --forward-to` signs each event exactly like a webhook delivery (`NearPay-Signature: t=…,v1=…`,
HMAC-SHA256 over `<t>.<raw body>` with the session secret; no `v1a` Ed25519 signature locally) and sends
`NearPay-Event-Id` / `NearPay-Event-Type`. Use the printed secret in your handler:

```ts
import { constructEvent } from "@nearpay/node";
const event = constructEvent(rawBody, req.headers["nearpay-signature"], process.env.NEARPAY_WEBHOOK_SECRET);
```

The secret changes every run. Forwarded events are the stream's events — they are not webhook
deliveries and are not retried; your endpoint's status is only printed.

### Triggerable events (spec 0.3.0)

Every fixture is made of real test-mode API calls; sandbox outcomes follow the documented scenario
amounts (sandbox §4).

| Event                                                                                                          | How                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_intent.created` / `.processing` / `.succeeded`, `checkout.session.completed`                          | checkout session → `payCheckoutSessionTestHelper` (outcome `succeeded`)                                                                                                                        |
| `payment_intent.payment_failed`                                                                                | the same with outcome `payment_failed`                                                                                                                                                         |
| `payment_intent.requires_review`                                                                               | USD 10.05 session: scenario `05` settles one base unit short                                                                                                                                   |
| `payment_intent.overpaid`                                                                                      | USD 10.06 session: an open quote, then a paid one; scenario `06` also pays the older quote                                                                                                     |
| `payment_intent.canceled`                                                                                      | session → cancel the intent (needs `--api-key sk_test_…`: the CLI key has no `payment_intents.write`)                                                                                          |
| `checkout.session.expired`                                                                                     | session → expire                                                                                                                                                                               |
| `refund.created` / `.requires_action` / `.pending` / `.succeeded` / `.failed` / `.canceled`                    | paid intent → `createRefund` (amount ending `00`, or `04` for a failing leg) → `simulateRefundDeposit` / `cancelRefund`                                                                        |
| `invoice.created` / `.finalized` / `.sent` / `.paid` / `.payment_failed` / `.voided` / `.marked_uncollectible` | billing routes; payment through the hosted invoice session                                                                                                                                     |
| `customer.subscription.created` / `.updated` / `.deleted`                                                      | monthly price, 30-day trial → update (`cancel_at_period_end`) → cancel                                                                                                                         |
| not supported                                                                                                  | `invoice.overdue`, `customer.subscription.renewal_upcoming` (need a billing clock test helper), `agent_payment.*` (needs a sandbox-funded agent signer), `review.*`, `account.updated`, `ping` |

## Options and environment

| Option                 | Environment                  | Meaning                                                                                               |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `--api-key <key>`      | `NEARPAY_API_KEY`            | use this test key instead of the stored one                                                           |
| `-p, --profile <name>` | `NEARPAY_PROFILE`            | named logins (default `default`)                                                                      |
| `--api-base <url>`     | `NEARPAY_API_BASE`           | API origin (default `https://api.nearpay.money`; `https://api.nearpay.localhost` for the local stack) |
|                        | `NEARPAY_CONFIG_DIR`         | config directory (default `$XDG_CONFIG_HOME/nearpay`, `%APPDATA%\nearpay` on Windows)                 |
|                        | `NO_COLOR` / `FORCE_COLOR=1` | colors                                                                                                |

Exit codes: `0` ok, `1` error, `2` usage, `3` not logged in / key rejected, `4` `trigger` timed out
waiting for the event, `130` interrupted.

## Credentials

`nearpay login` stores the key in the OS keychain (macOS Keychain, Windows Credential Manager, Linux
Secret Service) through `@napi-rs/keyring`; `config.json` holds only the account and the masked key.
Only when the machine has **no keychain at all** (headless Linux, CI, containers) is the key written to
`credentials.json` in the config directory, owner-only (`0600`, directory `0700`), and the CLI warns
every time it writes or reports it. A keychain that exists but refuses (locked, access denied) is an
error, never a silent downgrade. A credentials file readable by others is refused.

## Development

```sh
pnpm install
pnpm test                 # unit + property tests (in-process, spec-validating mock API with SSE)
pnpm test:integration     # builds, then runs the `nearpay` binary against a stateful fake API
pnpm verify               # typecheck, lint, coverage gate, integration
pnpm build:binaries       # single-file binary for this platform (needs bun)
```

The spec mock (`test/support/spec-mock.ts`) validates every request and response — and every SSE frame
— against `@nearpay/spec` 0.3.0; the fake (`test/support/fake-nearpay.ts`) implements the routes the CLI
uses with their documented behaviour (device login with `slow_down`, stream resume and `reset`, sandbox
scenarios).

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sdks-and-tools.md` §3 — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/identity.md` §6.2 (CLI login), `nearpay-brain/lld/webhooks.md` §5.1 (events stream), §6 (signatures)
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/api-conventions.md#9-webhooks`

## Layout

```
nearpay-cli/
├── src/
│   ├── cli.ts          process entry (bin)
│   ├── program.ts      command tree, exit codes
│   ├── commands/       login/logout/whoami, listen, trigger, events
│   └── lib/            API client, SSE parser, stream client, signing, forwarder, login flow,
│                       credential stores, trigger fixtures
├── test/
│   ├── unit/           unit + property tests
│   ├── integration/    the built binary end to end
│   └── support/        spec-validating mock, stateful fake API
├── scripts/            build-binaries.mjs
└── .github/workflows/  ci.yml
```

## Status

Stage 3 (step 3.3): `login`, `logout`, `whoami`, `listen`, `trigger`, `events list|resend`. `logs tail`
is not in v1 (no request-log API).

## Built with

Libraries (hackathon rule Q-005): [`commander`](https://github.com/tj/commander.js) (command line),
[`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) (OS keychain), [`zod`](https://zod.dev)
(with `@nearpay/spec`); dev: TypeScript, Biome, Vitest, fast-check, `@nearpay/node` (signature
verification in tests), Bun (single-file binaries). Code and documentation are written with AI
assistance (Claude) under human direction and review.
