# nearpay-cli

> Developer CLI: login, listen (forward webhooks to localhost), trigger test events, tail logs, resend events.

| | |
|---|---|
| Group | SDKs & tools |
| Kind | binary |
| Ships as | npm: @nearpay/cli + standalone binaries |
| Owns | CLI |
| Depends on (published artifacts only) | spec (public) |
| Roadmap phase | P3 Auto-debit and hardening |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

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

Scaffold only. Implementation starts in phase **P3 Auto-debit and hardening** (`nearpay-brain/roadmap/roadmap.md`).
