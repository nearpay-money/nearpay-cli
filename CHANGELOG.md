# Changelog

## 0.2.0 — 2026-11-11 (package rename, `@nearpay-money/spec` 0.5.0)

Package rename (ADR-0025): published as **`@nearpay-money/cli`** (npm org `nearpay-money`); the `@nearpay` npm scope
belongs to an unrelated company, and `@nearpay/cli` 0.1.0 was only on NearPay's local registry. The bin is still
`nearpay`: `npm install -g @nearpay-money/cli`. `CLI_VERSION` (User-Agent, `client_version` at login) is `0.2.0`.

- `@nearpay-money/spec` 0.3.0 → 0.5.0 (additive contracts); dev: `@nearpay-money/node` 0.4.0. The eight Stage 4
  `mandate.*` webhook types are listed by `nearpay trigger` as not supported (they need a payer-funded mandate).
- Package metadata for the public registry (`repository`, `homepage`, `bugs`, `keywords`, `publishConfig`).
- `.github/workflows/release.yml`: a `v*` tag (or a manual run) verifies and publishes to npm, skipping a version that
  is already there.

### Fixed

- `trigger refund.failed` is reported as not supported instead of waiting for an event the real stack never emits:
  a refund leg that fails after the merchant's transfer (sandbox scenario 04) is held for review by rails
  (`failed_after_deposit`), so the refund stays `pending` and `review.opened` follows (found in step 3.4 E2E).

## 0.1.0 — 2026-11-08

First release (Stage 3, step 3.3; `nearpay-brain/lld/sdks-and-tools.md` §3, spec 0.3.0).

- `nearpay login` — device authorization (`createCliLogin` → pairing code + `verification_url_complete`
  → `pollCliLogin` at `interval`, `429` = RFC 8628 `slow_down`, stop at `expires_at`); the restricted
  test key is stored in the OS keychain (`@napi-rs/keyring`), with a warned owner-only file fallback
  only when no keychain exists. `logout`, `whoami`, `--profile`, `--api-key` / `NEARPAY_API_KEY`.
- `nearpay listen` — `GET /v1/events/stream` with `Last-Event-ID` resume, `reset` handling, 1 s → 30 s
  backoff, idle detection, dedupe; `--forward-to` re-signs each event with a per-session `whsec_`
  (webhook `v1` scheme), `--events`, `--print-json`.
- `nearpay trigger <event>` — real test-mode fixtures for 25 of the 33 webhook types (payments test helper,
  refunds, billing invoices and subscriptions); waits for the event; the rest explain why not.
- `nearpay events list|resend`.
- Test mode only: live and publishable keys are refused.
