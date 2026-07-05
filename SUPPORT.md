# Support

Use GitHub issues for reproducible bugs, documentation problems, and feature
requests that fit the `@openlinker/sdk` open-source scope.

## Good Issue Topics

- TypeScript client behavior for supported Core endpoints
- runtime pull or WebSocket helper behavior
- callback signing or verification behavior
- A2A JSON-RPC, HTTP+JSON, or SSE behavior
- browser, Node.js, or edge runtime compatibility
- contract mismatch between this SDK and `openlinker-core`
- documentation gaps in examples or public API usage

## Before Opening an Issue

- Search existing issues and recent commits.
- Confirm the problem on the latest `main` branch or a named release.
- Include package version or commit SHA, Node.js version, package manager, and
  runtime environment.
- Include the Core API version or commit you are testing against.
- Include a minimal TypeScript or JavaScript reproduction when possible.
- Include expected behavior, actual behavior, and sanitized logs.
- Redact user tokens, agent tokens, callback secrets, private URLs, customer
  data, and local `.env` values.

中文提示：请尽量提供最小 TypeScript/JavaScript 复现代码。公开 Issue 里不要贴真实
token、callback secret、客户数据或私有服务地址。

## Not Supported Here

- vulnerabilities; follow [SECURITY.md](./SECURITY.md)
- native gRPC client support in this browser-first package
- commercial Cloud wallet, billing, withdrawal, or dashboard APIs
- process-level Agent adapters; use `openlinker-agent-node`
- private deployment debugging without reproducible public details

## Cross-Repository Questions

For issues that involve Core and this SDK together, include:

- SDK version or commit SHA
- Core API commit SHA or version
- SDK method name or A2A method
- sanitized request/response status and error body when available
