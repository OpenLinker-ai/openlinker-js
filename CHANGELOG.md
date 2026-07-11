# Changelog

All notable changes to `@openlinker/sdk` will be documented in this file.

This SDK is currently pre-1.0. Breaking changes may happen before the Core API,
runtime helper, callback, and A2A contracts are declared stable.

## Unreleased

### Changed

- Added reliable Run creation to `runAgent` and `startAgentRun`: both methods
  now send a validated `Idempotency-Key`, generate a secure per-invocation key
  when omitted, and expose Core's `replayed` result across `201`, `200`, and
  `202` responses.

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
