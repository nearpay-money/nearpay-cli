# AGENTS.md — nearpay-cli

You are working in **nearpay-cli**, one of 26 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Developer CLI: login, listen (forward webhooks to localhost), trigger test events, tail logs, resend events.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then the docs listed in this repo's README.
2. Contracts (requests, responses, events, errors) come from `@nearpay/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Uses only the public API; credentials stored in the OS keychain.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
