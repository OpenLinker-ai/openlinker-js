# Changelog

All notable changes to `@openlinker/sdk` will be documented in this file.

This SDK is currently pre-1.0. Breaking changes may happen before the Core API,
runtime helper, callback, and A2A contracts are declared stable.

## Unreleased

### Added

- Added `RuntimeV2WebSocketSession` for the canonical v2 WebSocket envelope,
  correlated business ACKs, pushed assignments and cancellation commands,
  multi-Attempt resume, strict size/shape validation, and close-code handling.
  It accepts an already authenticated mTLS socket so credentials never appear
  in a WebSocket URL.

### Changed

- Breaking: moved every Runtime HTTP and WebSocket endpoint from the versioned
  URL prefix to `/api/v1/agent-runtime/*`. Protocol version 2, the
  `openlinker.runtime.v2` contract ID, and the `RuntimeV2*` API remain pinned in
  the handshake contract. The contract now binds session heartbeat and close,
  including the close request body and empty `204` response; its digest is
  `fb92bb6ddbc65bd3353b5d7c63ad148dd510e4d0ac0a6ca6110461d91e2dec53`.
- Breaking: `ConnectionMode` now exposes `direct_http | mcp_server |
  agent_node`. WebSocket and Pull v2 are Agent Node transport policies, not
  separate marketplace connection modes.
- Added reliable Run creation to `runAgent` and `startAgentRun`: both methods
  now send a validated `Idempotency-Key`, generate a secure per-invocation key
  when omitted, and expose Core's `replayed` result across `201`, `200`, and
  `202` responses.

### Removed

- Breaking: removed the pre-v2 runtime heartbeat, pull claim, result upload,
  legacy WebSocket connector, delegated-call helpers, and their DTO/connector
  exports. `@openlinker/sdk/runtime` now exposes strict Runtime v2 HTTP and
  WebSocket protocol primitives only.

### Documentation

- Split Chinese documentation into dedicated `*.zh-CN.md` files and kept the
  default GitHub-facing documentation English-only.
- Strengthened the README and package metadata for TypeScript SDK, AI agent
  registry, agent marketplace, A2A/MCP runtime gateway, browser-friendly
  transports, and self-hosted Agent discoverability.
- Expanded the README into an English-first open-source entry point with a
  Chinese overview, install instructions, quick start, callback verification,
  A2A transport scope, Core surface, development, security, and contribution
  guidance.
- Expanded contributing, security, support, and release documents for public
  TypeScript SDK use.
- Documented that native gRPC, process-level adapters, and commercial Cloud APIs
  are outside this browser-first SDK's scope.

### Repository

- Added open-source governance files, issue templates, pull request template,
  and CI workflow.
- Added public package metadata for repository, issues, homepage, keywords,
  and Node.js engine.
- Added Apache-2.0 license, contributing guide, security policy, code of
  conduct, and support guidance.
