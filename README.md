# @openlinker/sdk

TypeScript client SDK for OpenLinker Core APIs.

Status: pre-release skeleton. The package is intentionally limited to Core
registry, client runtime, and Agent runtime protocol APIs. Cloud wallet,
billing, task marketplace, commercial dashboard, workflow product APIs, and
adapter implementations are out of scope for this package.

## Install

```bash
npm install @openlinker/sdk
```

The package is not published yet. Use this directory as the source package
while the API contract is being finalized.

## Usage

```ts
import { OpenLinkerClient } from "@openlinker/sdk";

const openlinker = new OpenLinkerClient({
  baseUrl: "https://core.example.com",
  accessToken: process.env.OPENLINKER_API_KEY,
  runtimeToken: process.env.OPENLINKER_RUNTIME_TOKEN,
});

const agents = await openlinker.listAgents({
  query: "data",
  callableOnly: true,
});

const run = await openlinker.startAgentRun({
  agentId: agents.items[0].id,
  input: { query: "Summarize this dataset" },
});

await openlinker.streamRunEvents(run.run_id, {
  onEvent(event) {
    console.log(event.event, event.data);
  },
});
```

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

External webhook callbacks are still available for server integrations. The
SDK builds the callback config and can generate a signing secret when one is
not supplied:

```ts
import { createWebhookRunCallback } from "@openlinker/sdk";

const callback = createWebhookRunCallback({
  url: process.env.OPENLINKER_CALLBACK_URL!,
  secret: process.env.OPENLINKER_CALLBACK_SECRET,
  eventTypes: ["run.completed", "run.failed"],
});

await openlinker.startAgentRun({
  agentId: agents.items[0].id,
  input: { query: "Summarize this dataset" },
  callback,
});
```

Use the same secret in your webhook handler to verify the raw request body:

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

## Core Surface

The interim contract source is
[`contracts/core-client.v1.json`](./contracts/core-client.v1.json) and
[`contracts/core-runtime.v1.json`](./contracts/core-runtime.v1.json). They list
the Core endpoints this package is allowed to wrap until OpenAPI / JSON Schema
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

Agent runtime protocol:

- `heartbeatAgent`
- `claimRuntimeRun`
- `claimRuntimeRunDetailed`
- `completeRuntimeRun`
- `callAgent`
- `callAgentAt`
- `runRuntimePullLoop`
- `connectRuntimeWebSocket`

The package includes the base runtime integration layer: pull loop, websocket
connect/reconnect, heartbeat messages, assignment callbacks, `run.event`, and
`run.result` submission. It does not include adapters such as command, Codex,
OpenClaw, or local HTTP backend runners.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Optional smoke against a running Core API:

```bash
OPENLINKER_API_ROOT=http://localhost:8080/api/v1 make validate-sdk-core-smoke
```

Authenticated run checks are only attempted when `OPENLINKER_API_KEY` and
`OPENLINKER_SDK_SMOKE_RUN_ID` are set.
