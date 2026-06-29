# Contributing to @openlinker/sdk

`@openlinker/sdk` is the TypeScript SDK for OpenLinker Core APIs and runtime
protocol helpers.

## Setup

```bash
npm install
npm run typecheck
npm run build
npm test
```

## Scope

- Keep this package focused on Core registry, run, A2A, MCP, and runtime
  protocol APIs.
- Do not add Cloud wallet, billing, Stripe, hosted marketplace ranking, or
  commercial dashboard APIs.
- Keep contract files and tests aligned with Core API changes.
- Use placeholders in tests and docs.

## Checks

```bash
npm run typecheck
npm run build
npm test
```

