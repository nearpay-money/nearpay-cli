# nearpay-cli

> Developer CLI: login, listen (forward webhooks to localhost), trigger test events, tail logs, resend events.

| | |
|---|---|
| Group | SDKs & tools |
| Kind | binary |
| Ships as | npm: @nearpay/cli + standalone binaries |
| Owns | CLI |
| Depends on (published artifacts only) | spec (public) |
| First built in | Stage 3 (step 3.3) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sdks-and-tools.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/sdks-and-tools.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md#9-webhooks`

## Layout

```
nearpay-cli/
├── src/
│   ├── commands/
│   └── lib/
├── test/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 3 (step 3.3)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
