# @openlinker/sdk

`@openlinker/sdk` is the TypeScript SDK for OpenLinker Core. Use its default
entry from web apps, Node.js services, edge runtimes, and developer tools to
discover Agents, start runs, stream events, verify callbacks, and call
browser-friendly A2A JSON-RPC and HTTP+JSON/SSE bindings. Strict Agent Runtime
v2 protocol primitives use the separate `@openlinker/sdk/runtime` entry.

Chinese documentation: [README.zh-CN.md](./README.zh-CN.md)

## Status

This SDK is pre-1.0. The package tracks the Core API and runtime contracts while
they are still stabilizing. Pin versions or commits and review `CHANGELOG.md`
before upgrading.

## Install

```bash
npm install @openlinker/sdk
```

The package may still be used from this repository directly while the API
contract is being finalized.

## Open-source Architecture

The TypeScript SDK keeps caller and Agent runtime credentials separate. The
default `@openlinker/sdk` entry wraps user-token platform calls. The
`@openlinker/sdk/runtime` entry wraps Agent-token runtime calls. Neither entry
exposes hosted product internals.

```mermaid
flowchart LR
  App["Web app / Node service / Edge runtime"] --> ClientSDK["@openlinker/sdk"]
  ClientSDK -->|"REST client with OPENLINKER_USER_TOKEN"| Core["openlinker-core<br/>registry / runs / events"]
  ClientSDK -->|"A2A JSON-RPC / HTTP+JSON / SSE"| Core
  Runtime["Agent runtime process"] --> RuntimeSDK["@openlinker/sdk/runtime"]
  RuntimeSDK -->|"mTLS + Agent Token / session / lease / event / result"| Core

  HostedBridge["Hosted Bridge<br/>optional deployment adapter"] -.->|"same Core API contract"| Core

  Core -->|"direct_http"| HTTPAgent["Public HTTPS Agent"]
  Core -->|"mcp_server"| MCPAgent["Remote MCP / JSON-RPC server"]
  Core -->|"Runtime v2 assignment and cancellation"| AgentNode["openlinker-agent-node"]
```

## Quick Start

```ts
import { OpenLinkerClient } from "@openlinker/sdk";

const openlinker = new OpenLinkerClient({
  baseUrl: "https://core.example.com",
  userToken: process.env.OPENLINKER_USER_TOKEN,
});

const agents = await openlinker.listAgents({
  query: "data",
  callableOnly: true,
});

const idempotencyKey = crypto.randomUUID();
const run = await openlinker.startAgentRun({
  agentId: agents.items[0].id,
  input: { query: "Summarize this dataset" },
  idempotencyKey,
});

await openlinker.streamRunEvents(run.run_id, {
  onEvent(event) {
    console.log(event.event, event.data);
  },
});
```

## Reliable Run Creation

`runAgent` and `startAgentRun` send `Idempotency-Key` on every Run creation
request. Keep one key for one logical operation and reuse it when your
application retries that operation:

```ts
const idempotencyKey = crypto.randomUUID();
const request = {
  agentId: agents.items[0].id,
  input: { query: "Summarize this dataset" },
  idempotencyKey,
};

const run = await openlinker.startAgentRun(request);
// A later retry with the same key and semantic request returns the same Run.
const sameRun = await openlinker.startAgentRun(request);
console.log(sameRun.run_id, sameRun.replayed);
```

When `idempotencyKey` is omitted, the SDK generates a cryptographically strong
key once for that method invocation. That protects the request itself, but a
separate method call gets a new key and represents a new operation. Explicit
keys must be 1–255 printable ASCII characters; validation errors never include
the key value.

Core uses `201` for a newly created Run, `200` for a completed replay, and `202`
when a replayed Run is still in progress. The SDK accepts all three and exposes
the result through `RunResponse.replayed`.

## Durable Event Pages

`listRunEvents` returns an `items` page plus durable cursor metadata. The
response does not expose the former `events` alias:

```ts
const page = await openlinker.listRunEvents(run.run_id, {
  afterSequence: 0,
  limit: 100,
});

for (const event of page.items) {
  console.log(event.sequence, event.event_type, event.payload);
}

if (page.meta.retention_gap) {
  console.warn(
    `Events through sequence ${page.meta.retained_through_sequence} are no longer available`,
  );
}

if (page.meta.terminal && page.meta.stream_complete) {
  console.log("The terminal event history has been read through its latest sequence");
}
```

`requested_after_sequence` is the caller's cursor. Core advances
`effective_after_sequence` to `retained_through_sequence` when retention has
removed older events, and sets `retention_gap` so callers do not mistake the
page for a complete history. `earliest_available_sequence` and
`latest_available_sequence` are `null` when no retained event is available.
SSE continues to use `streamRunEvents` unchanged.

## Runtime v2 Entry

Runtime workers use `OPENLINKER_AGENT_TOKEN` through the strict v2 entry:

```ts
import {
  OpenLinkerRuntime,
  RuntimeContractDigest,
  RuntimeRequiredFeatures,
} from "@openlinker/sdk/runtime";

const agentToken = process.env.OPENLINKER_AGENT_TOKEN;
if (!agentToken) {
  throw new Error("OPENLINKER_AGENT_TOKEN is required");
}

const runtime = new OpenLinkerRuntime({
  // Dedicated Runtime origin. The supplied transport must present the Node certificate.
  baseUrl: "https://runtime.example.com:8443",
  agentToken,
});

const runtimeSessionId = crypto.randomUUID();
const hello = {
  nodeId: process.env.OPENLINKER_NODE_ID!,
  agentId: process.env.OPENLINKER_AGENT_ID!,
  workerId: "worker-1",
  runtimeSessionId,
  sessionEpoch: 1,
  nodeVersion: "0.2.0",
  capacity: 1,
  features: RuntimeRequiredFeatures,
  contractDigest: RuntimeContractDigest,
};

await runtime.createRuntimeV2Session(hello);
const assignment = await runtime.claimRuntimeV2Run(25, {
  runtimeSessionId,
  capacity: 1,
  inflight: 0,
});

if (assignment) {
  await runtime.ackRuntimeV2Assignment({
    attemptIdentity: assignment.attemptIdentity,
  });
  // Execute through a durable worker that renews the lease, persists events,
  // handles cancellation, and finalizes the result with the same identity.
}
```

`OpenLinkerClient` rejects `agentToken`. `OpenLinkerRuntime` exposes strict
Runtime v2 primitives only; durable spooling, lease scheduling, execution, and
recovery remain worker responsibilities.

For the v2 WebSocket transport, pass an already-open, authenticated socket to
`RuntimeV2WebSocketSession`. The socket upgrade must present the Node client
certificate and `Authorization: Bearer <Agent Token>`; the SDK never places a
credential in the URL. The session implements hello/ready, pushed assignment
and cancellation, correlated assignment/lease/Event/Result ACKs, and resume.
Workers still persist an assignment before ACK and persist every Event/Result
before sending it. Use `openlinker-agent-node` when you need automatic
WebSocket-to-v2-long-poll switching and durable recovery.

## Callbacks

Platform-hosted callbacks do not require a public callback URL:

```ts
const result = await openlinker.runAgentWithCallbacks({
  agentId: agents.items[0].id,
  input: { query: "Summarize this dataset" },
  callback: {
    mode: "platform",
    eventTypes: ["run.message.delta"],
    onEvent(event) {
      console.log("callback", event);
    },
  },
});
```

External webhook callbacks are available for server integrations:

```ts
import { createWebhookRunCallback } from "@openlinker/sdk";

const callback = createWebhookRunCallback({
  url: process.env.OPENLINKER_CALLBACK_URL!,
  secret: process.env.OPENLINKER_CALLBACK_SECRET,
  eventTypes: ["run.completed", "run.failed"],
});
```

Verify the raw request body before trusting webhook payloads:

```ts
import { verifyTaskCallbackHeaders } from "@openlinker/sdk";

const rawBody = await request.text();
const ok = await verifyTaskCallbackHeaders(
  rawBody,
  process.env.OPENLINKER_CALLBACK_SECRET!,
  request.headers,
);
if (!ok) {
  return new Response("invalid signature", { status: 401 });
}
```

## A2A Transports

`@openlinker/sdk` is browser-first for A2A. It supports the JSON-RPC and
HTTP+JSON/SSE bindings exposed by OpenLinker Core, including send, stream, task
lookup, task cancel, resubscribe, extended card, and Push Notification Config
methods.

It does not bundle a native gRPC client. gRPC requires Node-only dependencies
such as `@grpc/grpc-js` plus generated protobuf code, while this package must
remain safe for browsers, edge runtimes, and ordinary HTTPS infrastructure. For
gRPC callers, use `github.com/OpenLinker-ai/openlinker-go` or a separate
Node-only generated client.

Operationally, gRPC is an additional A2A transport binding. It does not replace
JSON-RPC, HTTP+JSON/SSE, or the separate Agent Node Runtime v2 control plane.

## Core Surface

The interim contract source is
[`contracts/core-client.v1.json`](./contracts/core-client.v1.json) and
[`contracts/core-runtime.v2.json`](./contracts/core-runtime.v2.json). They list
the Core endpoints this package is allowed to wrap until OpenAPI or JSON Schema
generation is in place.

Application-side calls:

- `listAgents`
- `getAgent`
- `getAgentCard`
- `runAgent`
- `runAgentWithCallbacks`
- `startAgentRun`
- `startAgentRunWithCallbacks`
- `getRun`
- `listRunEvents`
- `listRunArtifacts`
- `listRunMessages`
- `streamRunEvents`

Strict Runtime v2 protocol, from `@openlinker/sdk/runtime`:

- `createRuntimeV2Session`
- `heartbeatRuntimeV2Session`
- `closeRuntimeV2Session`
- `claimRuntimeV2Run`
- `ackRuntimeV2Assignment`
- `rejectRuntimeV2Assignment`
- `renewRuntimeV2Lease`
- `appendRuntimeV2Event`
- `finalizeRuntimeV2Result`
- `resumeRuntimeV2Runs`
- `pollRuntimeV2Commands`
- `ackRuntimeV2Cancel`
- `callRuntimeV2Agent`
- `buildRuntimeV2InvocationProof`

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Optional smoke test against a running Core API:

```bash
OPENLINKER_API_ROOT=http://localhost:8080/api/v1 make validate-sdk-core-smoke
```

Authenticated run checks are only attempted when `OPENLINKER_USER_TOKEN` and
`OPENLINKER_SDK_SMOKE_RUN_ID` are set.

## Security

Keep user tokens, agent tokens, callback secrets, and push credentials out of
logs and public issue reports. Use `OPENLINKER_USER_TOKEN` with
`OpenLinkerClient`, and `OPENLINKER_AGENT_TOKEN` with `OpenLinkerRuntime`.
Browser code should use least-privilege user tokens or a server-side proxy.
Agent tokens should stay in runtime processes and should not be passed to
business adapters. Report vulnerabilities through [SECURITY.md](./SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Support and Releases

- Help and issue guidance: [SUPPORT.md](./SUPPORT.md)
- Release checklist: [RELEASE.md](./RELEASE.md)
- Notable changes: [CHANGELOG.md](./CHANGELOG.md)
- Conduct expectations: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
