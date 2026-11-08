# AGENTS.md — nearpay-cli

You are working in **nearpay-cli**, one of 27 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Developer CLI (test mode): login, listen (forward events to localhost, re-signed like webhooks), trigger test events, list and resend events. `logs tail` is not in v1 (no request-log API).

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/sdks-and-tools.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Uses only the public API (route table and types from `@nearpay/spec`); credentials stored in the OS keychain
  (file fallback only when no keychain exists, warned). Test mode only: refuse live keys.
- Tests: `pnpm test` (unit, property) runs freely; `pnpm test:integration` / `pnpm verify` build and spawn the
  binary — on the shared machine run them under `flock /tmp/np-heavy.lock`.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
