# Changelog

All notable changes to `@openlinker/sdk` will be documented in this file.

This SDK is currently pre-1.0. Breaking changes may happen before the Core API,
runtime helper, callback, and A2A contracts are declared stable.

## Unreleased

### Added

- Added the SDK-owned `RuntimeWorker` with credential-free Runtime discovery,
  Node mTLS, WebSocket-first automatic Pull recovery, Session lifecycle,
  assignment confirmation, renewal, resume, cancellation, drain, capacity,
  stable Event/Result retry, assignment-scoped delegated calls, and safe
  shutdown. Handlers run only after durable assignment confirmation.
- Session creation and the initial WebSocket attach retry stale attachment
  conflicts while Core reaps the previous Session. The same conflict remains
  permanent for business operations after Ready.
- Added the encrypted `FileRuntimeStore` with stable Worker identity, monotonic
  Session epoch, authenticated encryption, atomic fsync-backed writes, a
  process lock, private permissions, corruption detection, and fail-closed
  space limits. `MemoryRuntimeStore` requires an explicit unsafe test flag.
- Added `RuntimeWebSocketSession` for correlated business ACKs, pushed
  assignments and cancellation commands, multi-Attempt resume, strict
  size/shape validation, and close-code handling.
- Added `NodeRuntimeTransport` for Node 20 mTLS HTTP and WebSocket connections.
  Runtime credentials are never placed in a URL and redirects are rejected.

### Changed

- Breaking: Runtime HTTP and WebSocket endpoints use the neutral
  `/api/v1/agent-runtime/*` namespace. Public Runtime API names and the contract
  filename are neutral as well; protocol negotiation remains an internal wire
  concern of the handshake contract. The contract binds Session heartbeat and close,
  including the close request body and empty `204` response. Every Pull Ready
  response also establishes or confirms the attachment that fences subsequent HTTP work;
  its contract digest is
  `3f84df167bbe211efdc6362ad5ec876aeedf881cbfb9677606982af63c7423e9`.
- Breaking: the package root is browser-safe and no longer exports or imports
  Runtime types. Server-only Worker, Store, mTLS, HTTP, and WebSocket APIs are
  available from `@openlinker/sdk/runtime`.
- Breaking: `ConnectionMode` now exposes `direct_http | mcp_server | runtime`.
  WebSocket and Pull are Runtime transport policies, not
  separate marketplace connection modes.
- Added reliable Run creation to `runAgent` and `startAgentRun`: both methods
  now send a validated `Idempotency-Key`, generate a secure per-invocation key
  when omitted, and expose Core's `replayed` result across `201`, `200`, and
  `202` responses.

### Removed

- Breaking: removed version labels from public Runtime class names, methods,
  source filenames, tests, and the contract filename. No compatibility aliases
  are retained during the pre-1.0 cutover.
- Removed the Agent Node ownership assumption from the TypeScript SDK. Agent
  Node is now an optional adapter shell over the SDK Worker rather than a
  second Runtime state machine.

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
