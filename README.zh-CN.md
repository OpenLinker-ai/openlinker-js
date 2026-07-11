# @openlinker/sdk

`@openlinker/sdk` 是 OpenLinker Core 的 TypeScript SDK。默认入口用于在 Web 应用、
Node.js 服务、Edge runtime 和开发者工具中查找 Agent、启动运行、监听事件、校验回调，
并调用浏览器友好的 A2A JSON-RPC 与 HTTP+JSON/SSE 接口。Agent runtime connector
使用单独的 `@openlinker/sdk/runtime` 入口。

English documentation: [README.md](./README.md)

## 状态

本 SDK 目前是 pre-1.0。它跟随 Core API 和 runtime 契约演进。升级前请固定版本或
commit，并阅读 [CHANGELOG.md](./CHANGELOG.md)。

本 SDK 不内置原生 gRPC 客户端，也不包含钱包、扣费、Stripe、提现、商业 Dashboard
或本地 adapter 实现。默认入口使用 `OPENLINKER_USER_TOKEN`，runtime 入口使用
`OPENLINKER_AGENT_TOKEN`。
## 开源架构图

TypeScript SDK 把调用方凭证和 Agent runtime 凭证分开。默认 `@openlinker/sdk`
入口封装 user-token 平台调用；`@openlinker/sdk/runtime` 入口封装 agent-token
runtime 调用。两者都不暴露托管产品内部接口。

```mermaid
flowchart LR
  App["Web app / Node service / Edge runtime"] --> ClientSDK["@openlinker/sdk"]
  ClientSDK -->|"REST client with OPENLINKER_USER_TOKEN"| Core["openlinker-core<br/>registry / runs / events"]
  ClientSDK -->|"A2A JSON-RPC / HTTP+JSON / SSE"| Core
  Runtime["Agent runtime process"] --> RuntimeSDK["@openlinker/sdk/runtime"]
  RuntimeSDK -->|"heartbeat / claim / result with OPENLINKER_AGENT_TOKEN"| Core

  HostedBridge["Hosted Bridge<br/>可选部署适配层"] -.->|"同一 Core API contract"| Core

  Core -->|"direct_http"| HTTPAgent["公网 HTTPS Agent"]
  Core -->|"mcp_server"| MCPAgent["远程 MCP / JSON-RPC server"]
  Core -->|"runtime_ws / runtime_pull"| AgentNode["openlinker-agent-node"]
```

## 安装

```bash
npm install @openlinker/sdk
```

API 契约稳定前，也可以直接从本仓库目录使用该 package。

## 快速开始

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

浏览器代码不要直接暴露高权限 token。需要时使用低权限 token 或服务端代理。

## 可靠创建 Run

`runAgent` 和 `startAgentRun` 每次创建 Run 都会发送 `Idempotency-Key`。一次业务操作只用
一个 key；应用层重试时复用它，Core 就会返回同一个 Run：

```ts
const idempotencyKey = crypto.randomUUID();
const request = {
  agentId: agents.items[0].id,
  input: { query: "Summarize this dataset" },
  idempotencyKey,
};

const run = await openlinker.startAgentRun(request);
// 同一个 key 与同一份语义请求再次调用，仍然返回原来的 Run。
const sameRun = await openlinker.startAgentRun(request);
console.log(sameRun.run_id, sameRun.replayed);
```

不传 `idempotencyKey` 时，SDK 会为本次方法调用生成一个密码学安全的 key。它只代表这
一次调用；下一次方法调用会生成新 key，也就代表一项新操作。显式 key 必须是 1–255 个
可打印 ASCII 字符，校验错误不会带出 key 原文。

Core 对首次创建返回 `201`，对已结束的重放返回 `200`，对仍在运行的重放返回 `202`。
SDK 会透明处理这三种状态，可通过 `RunResponse.replayed` 判断是否为重放。

## Runtime 入口

Agent runtime 进程通过 runtime 入口使用 `OPENLINKER_AGENT_TOKEN`：

```ts
import { OpenLinkerRuntime } from "@openlinker/sdk/runtime";

const agentToken = process.env.OPENLINKER_AGENT_TOKEN;
if (!agentToken) {
  throw new Error("OPENLINKER_AGENT_TOKEN is required");
}

const runtime = new OpenLinkerRuntime({
  baseUrl: "https://core.example.com",
  agentToken,
});

await runtime.runRuntimePullLoop({
  async onAssigned(assignment) {
    const output = await handleAssignment(assignment);
    await runtime.completeRuntimeRun(assignment.run_id, {
      status: "success",
      output,
    });
  },
});
```

`OpenLinkerClient` 会拒绝 `agentToken`；`/agent-runtime/*` endpoint 请使用
`OpenLinkerRuntime`。

## Callback

平台托管 callback 不需要公网 callback URL。外部 webhook callback 适合服务端集成。
处理 webhook 时必须先校验原始请求体签名，再信任 payload。

## A2A Transport

`@openlinker/sdk` 是 browser-first 的 A2A SDK。它支持 OpenLinker Core 暴露的 JSON-RPC
和 HTTP+JSON/SSE binding，包括 send、stream、task lookup、task cancel、resubscribe、
extended card 和 Push Notification Config 方法。

它不内置原生 gRPC client。gRPC 需要 Node-only 依赖和生成的 protobuf code，而本包需要
保持浏览器、Edge runtime 和普通 HTTPS 基础设施友好。gRPC 调用方可使用
`github.com/OpenLinker-ai/openlinker-go` 或单独的 Node-only generated client。

## Core Surface

临时契约来源：

- [`contracts/core-client.v1.json`](./contracts/core-client.v1.json)
- [`contracts/core-runtime.v2.json`](./contracts/core-runtime.v2.json)

这些文件列出本包在 OpenAPI / JSON Schema 生成稳定前允许封装的 Core endpoint。

## 开发

```bash
npm install
npm run typecheck
npm run build
npm test
```

可选：对运行中的 Core API 做 smoke test：

```bash
OPENLINKER_API_ROOT=http://localhost:8080/api/v1 make validate-sdk-core-smoke
```

## 安全

不要把 user token、agent token、callback secret 或 push credential 写入日志或公开 Issue。
`OPENLINKER_USER_TOKEN` 用于 `OpenLinkerClient`，`OPENLINKER_AGENT_TOKEN` 用于
`OpenLinkerRuntime`。浏览器代码应使用最小权限 user token 或服务端代理；agent token
应留在 runtime 进程内，不要传给业务 adapter。漏洞请通过 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)
报告。

## 贡献

提交 PR 前请阅读 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)。SDK 只封装开源 Core
协议，不加入 Cloud 钱包、商业计费或托管市场内部接口。公共 API 变化要同步测试和契约文件。

## 支持和发布

- 支持说明：[SUPPORT.zh-CN.md](./SUPPORT.zh-CN.md)
- 发布清单：[RELEASE.zh-CN.md](./RELEASE.zh-CN.md)
- 英文变更记录：[CHANGELOG.md](./CHANGELOG.md)
- 行为准则：[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## 许可证

Apache-2.0。详见 [LICENSE](./LICENSE)。
