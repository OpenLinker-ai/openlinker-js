# Contributing to @openlinker/sdk

Chinese documentation: [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)

Thanks for helping improve `@openlinker/sdk`, the TypeScript SDK for
OpenLinker Core APIs, browser/edge-friendly A2A transports, runtime helpers,
and callback verification.

## Development Setup

```bash
npm install
npm run typecheck
npm run build
npm test
```

Use placeholder tokens in tests and examples. Never commit real user tokens,
agent tokens, callback secrets, private endpoints, or captured customer data.

## Scope Boundaries

Allowed here:

- TypeScript wrappers for open-source Core API surfaces
- runtime pull/WebSocket connector helpers
- callback construction and signature verification helpers
- browser-safe A2A JSON-RPC, HTTP+JSON, and SSE client behavior
- contract tests for the supported Core API surface

Out of scope:

- native gRPC client dependencies; use `openlinker-go` or a separate Node-only
  generated client for gRPC
- Cloud wallet, billing, Stripe, withdrawal, and commercial dashboard APIs
- hosted marketplace ranking or private recommendation internals
- process-level Agent adapters such as command, Codex, OpenClaw, or local
  backend runners

## Pull Request Expectations

- Keep exported API changes small and documented.
- Add or update tests for client behavior, callbacks, runtime helpers, or A2A
  transports.
- Update `README.md`, contracts, and `CHANGELOG.md` for public behavior changes.
- Preserve browser safety: avoid Node-only APIs in exported paths unless they
  are explicitly isolated.
- Preserve backwards compatibility unless the change is clearly documented as
  pre-1.0 breaking behavior.

## Checks

```bash
npm run typecheck
npm run build
npm test
```

Before publishing, also run:

```bash
npm pack --dry-run
```

## Security

Do not open public issues for vulnerabilities. Follow [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the
Apache-2.0 license used by this repository.
