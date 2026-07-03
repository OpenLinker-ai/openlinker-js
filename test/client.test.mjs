import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenLinkerA2AError,
  OpenLinkerClient,
  OpenLinkerError,
  a2aTaskStateRunStatus,
  createWebhookRunCallback,
  extractA2AText,
  generateTaskCallbackSecret,
  newA2ATextMessageParams,
  normalizeA2ADialect,
  normalizeA2AJsonRpcMethod,
  normalizeA2AJsonRpcMethodForDialect,
  normalizeA2ATaskState,
  signTaskCallbackPayload,
  taskCallbackSignatureFromHeaders,
  verifyTaskCallbackHeaders,
  verifyTaskCallbackSignature,
} from "../dist/index.js";

test("listAgents builds Core API URL and authorization header", async () => {
  const calls = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    accessToken: "ol_live_test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        items: [],
        total: 0,
        page: 2,
        size: 5,
      });
    },
  });

  const response = await client.listAgents({
    query: "data",
    tags: ["sql", "finance"],
    page: 2,
    size: 5,
    callableOnly: true,
  });

  assert.equal(response.page, 2);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://core.example.com/api/v1/agents?q=data&page=2&size=5&callable_only=true&tags=sql%2Cfinance",
  );
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer ol_live_test");
  assert.equal(headers.get("x-openlinker-sdk"), "@openlinker/sdk/0.1.3");
});

test("client rejects oversized API response bodies", async () => {
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async () => new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(8 * 1024 * 1024 + 1),
      },
    }),
  });

  await assert.rejects(
    () => client.listAgents(),
    (error) => {
      assert.ok(error instanceof OpenLinkerError);
      assert.equal(error.status, 200);
      assert.equal(error.code, "RESPONSE_TOO_LARGE");
      return true;
    },
  );
});

test("runAgent maps camelCase input to Core request body", async () => {
  const calls = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        run_id: "run-1",
        status: "success",
        output: { ok: true },
        cost_cents: 0,
        duration_ms: 12,
      });
    },
  });

  const response = await client.runAgent({
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    metadata: { trace_id: "trace-1" },
    a2aContext: {
      contextId: "ctx-root",
      taskId: "task-root",
      traceId: "trace-1",
    },
    pushNotificationConfig: {
      url: "https://caller.example.com/a2a/events",
      token: "caller-token",
      secret: "caller-secret",
      eventTypes: ["run.completed", "run.failed"],
      metadata: { client: "js-sdk" },
    },
  });

  assert.equal(response.run_id, "run-1");
  assert.equal(calls[0].url, "https://core.example.com/api/v1/run");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agent_id: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    metadata: { trace_id: "trace-1" },
    a2a_context: {
      contextId: "ctx-root",
      taskId: "task-root",
      traceId: "trace-1",
    },
    task_callback: {
      url: "https://caller.example.com/a2a/events",
      token: "caller-token",
      secret: "caller-secret",
      eventTypes: ["run.completed", "run.failed"],
      metadata: { client: "js-sdk" },
    },
  });
});

test("createWebhookRunCallback passes external callback URL and generated secret", async () => {
  const calls = [];
  const callback = createWebhookRunCallback({
    url: " https://caller.example.com/openlinker/events ",
    token: "caller-token",
    eventTypes: ["run.completed", "run.failed"],
    metadata: { client: "js-sdk" },
  });
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        run_id: "run-webhook",
        status: "running",
        task_callback: {
          id: "callback-1",
          run_id: "run-webhook",
          target_url: callback.url,
          event_types: callback.eventTypes,
          status: "active",
          consecutive_failures: 0,
          secret: callback.secret,
          created_at: "2026-06-25T00:00:00Z",
          updated_at: "2026-06-25T00:00:00Z",
        },
      });
    },
  });

  assert.equal(callback.url, "https://caller.example.com/openlinker/events");
  assert.match(callback.secret, /^[0-9a-f]{64}$/);

  await client.startAgentRun({
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    callback,
  });

  assert.equal(calls[0].url, "https://core.example.com/api/v1/runs");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agent_id: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    task_callback: {
      url: "https://caller.example.com/openlinker/events",
      token: "caller-token",
      secret: callback.secret,
      eventTypes: ["run.completed", "run.failed"],
      metadata: { client: "js-sdk" },
    },
  });
});

test("task callback signature helpers verify external webhook payloads", async () => {
  const secret = generateTaskCallbackSecret();
  const payload = JSON.stringify({
    event_type: "run.completed",
    run_id: "run-1",
  });
  const signature = await signTaskCallbackPayload(payload, secret);
  const headerValue = `sha256=${signature}`;

  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(await verifyTaskCallbackSignature(payload, secret, headerValue), true);
  assert.equal(await verifyTaskCallbackSignature(payload + "\n", secret, headerValue), false);
  assert.equal(
    await verifyTaskCallbackHeaders(
      payload,
      secret,
      new Headers({ "X-OpenLinker-Signature": headerValue }),
    ),
    true,
  );
  assert.equal(
    await verifyTaskCallbackHeaders(payload, secret, { "x-openlinker-signature": headerValue }),
    true,
  );
  assert.equal(taskCallbackSignatureFromHeaders({ "x-openlinker-signature": [headerValue] }), headerValue);
});

test("runAgentWithCallbacks uses platform run stream without external callback URL", async () => {
  const calls = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        "id: 1",
        "event: run.message.delta",
        'data: {"event_id":"event-1","run_id":"run-platform","sequence":1,"event_type":"run.message.delta","payload":{"text":"working"},"created_at":"2026-06-21T00:00:00Z"}',
        "",
        "id: 2",
        "event: run.completed",
        'data: {"event_id":"event-2","run_id":"run-platform","sequence":2,"event_type":"run.completed","payload":{"status":"success"},"created_at":"2026-06-21T00:00:01Z"}',
        "",
        "",
      ].join("\n")));
      controller.close();
    },
  });
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://core.example.com/api/v1/runs") {
        return jsonResponse({
          run_id: "run-platform",
          status: "running",
          cost_cents: 0,
          duration_ms: 0,
        });
      }
      if (String(url) === "https://core.example.com/api/v1/runs/run-platform/stream") {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (String(url) === "https://core.example.com/api/v1/runs/run-platform") {
        return jsonResponse({
          run_id: "run-platform",
          status: "success",
          output: { ok: true },
          cost_cents: 0,
          duration_ms: 12,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const events = [];
  const terminal = [];
  const response = await client.runAgentWithCallbacks({
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    callback: {
      mode: "platform",
      eventTypes: ["run.message.delta"],
      onEvent: (event) => events.push(event),
      onTerminal: (event) => terminal.push(event),
    },
  });

  assert.equal(response.status, "success");
  assert.equal(calls[0].url, "https://core.example.com/api/v1/runs");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agent_id: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
  });
  assert.equal(calls[1].url, "https://core.example.com/api/v1/runs/run-platform/stream");
  assert.equal(calls[2].url, "https://core.example.com/api/v1/runs/run-platform");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "run.message.delta");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].event, "run.completed");
});

test("endpoint helpers encode paths, queries, and async headers", async () => {
  const calls = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1/",
    accessToken: async () => "ol_live_async",
    headers: async () => ({ "x-default": "base" }),
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return jsonResponse({
        run_id: "run-helper",
        status: "success",
        output: { ok: true },
        cost_cents: 0,
        duration_ms: 1,
        items: [],
        events: [],
      });
    },
  });

  await client.getAgent("agent/one");
  await client.getAgentCard("agent/one", { extended: true });
  await client.startAgentRun({
    agentId: "agent-1",
    input: "hello",
    metadata: { trace_id: "trace-helper" },
  }, {
    headers: { authorization: "Bearer ol_override", "x-default": "override" },
  });
  await client.getRun("run helper");
  await client.listRunEvents("run helper", { afterSequence: 2, limit: 10 });
  await client.listRunArtifacts("run helper");
  await client.listRunMessages("run helper");

  assert.deepEqual(calls.map((call) => call.url), [
    "https://core.example.com/api/v1/agents/agent%2Fone",
    "https://core.example.com/api/v1/agents/agent%2Fone/agent-card.extended.json",
    "https://core.example.com/api/v1/runs",
    "https://core.example.com/api/v1/runs/run%20helper",
    "https://core.example.com/api/v1/runs/run%20helper/events?after_sequence=2&limit=10",
    "https://core.example.com/api/v1/runs/run%20helper/artifacts",
    "https://core.example.com/api/v1/runs/run%20helper/messages",
  ]);
  assert.deepEqual(calls[2].body, {
    agent_id: "agent-1",
    input: "hello",
    metadata: { trace_id: "trace-helper" },
  });
  assert.equal(calls[0].headers.get("authorization"), "Bearer ol_live_async");
  assert.equal(calls[2].headers.get("authorization"), "Bearer ol_override");
  assert.equal(calls[2].headers.get("x-default"), "override");
  assert.equal(calls[2].headers.get("content-type"), "application/json");
});

test("standard Core errors become OpenLinkerError", async () => {
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async () => jsonResponse(
      {
        error: {
          code: "FORBIDDEN",
          message: "missing scope",
          details: { scope: "agents:run" },
        },
      },
      { status: 403, headers: { "x-request-id": "req-1" } },
    ),
  });

  await assert.rejects(
    () => client.getRun("run-1"),
    (error) => {
      assert.ok(error instanceof OpenLinkerError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.message, "missing scope");
      assert.equal(error.requestId, "req-1");
      assert.deepEqual(error.details, { scope: "agents:run" });
      return true;
    },
  );
});

test("fallback Core errors and 204 responses preserve retry metadata", async () => {
  const retryAt = new Date(Date.now() + 2_000).toUTCString();
  let requestCount = 0;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    accessToken: "ol_live_user",
    fetch: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response("temporarily unavailable", {
        status: 503,
        statusText: "Service Unavailable",
        headers: {
          "retry-after": retryAt,
          "x-correlation-id": "corr-1",
        },
      });
    },
  });

  assert.equal(await client.completeRuntimeRun("run-204", { status: "success" }), undefined);
  await assert.rejects(
    () => client.getRun("run-503"),
    (error) => {
      assert.ok(error instanceof OpenLinkerError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "HTTP_503");
      assert.equal(error.message, "Service Unavailable");
      assert.equal(error.requestId, "corr-1");
      assert.equal(error.responseBody, "temporarily unavailable");
      assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 10_000);
      return true;
    },
  );
});

test("streamRunEvents parses run SSE events", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        "id: 7",
        "event: run.completed",
        'data: {"event_id":"event-1","run_id":"run-1","sequence":7,"event_type":"run.completed","payload":{"ok":true},"created_at":"2026-06-21T00:00:00Z"}',
        "",
        "",
      ].join("\n")));
      controller.close();
    },
  });
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      assert.equal(String(url), "https://core.example.com/api/v1/runs/run-1/stream?after_sequence=6");
      assert.equal(new Headers(init.headers).get("accept"), "text/event-stream");
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const events = [];
  const terminal = [];
  let closed = false;
  await client.streamRunEvents("run-1", {
    onEvent: (event) => events.push(event),
    onTerminal: (event) => terminal.push(event),
    onClose: () => {
      closed = true;
    },
  }, { afterSequence: 6 });

  assert.equal(events.length, 1);
  assert.equal(terminal.length, 1);
  assert.equal(events[0].id, "7");
  assert.equal(events[0].event, "run.completed");
  assert.deepEqual(events[0].data.payload, { ok: true });
  assert.equal(closed, true);
});

test("streamRunEvents handles comments, plain text, buffered lines, and missing bodies", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        ": keep-alive",
        "event: run.message.delta",
        "data: plain text",
        "",
        "event:",
        "data: {\"ok\":true}",
      ].join("\r\n")));
      controller.close();
    },
  });
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url) => {
      if (String(url).includes("missing-body")) {
        return new Response(null, { status: 200 });
      }
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const events = [];
  await client.streamRunEvents("run-plain", {
    onEvent: (event) => events.push(event),
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].event, "run.message.delta");
  assert.equal(events[0].data, "plain text");
  assert.equal(events[1].event, "message");
  assert.deepEqual(events[1].data, { ok: true });
  await assert.rejects(
    () => client.streamRunEvents("missing-body"),
    /does not expose a body/,
  );
});

test("runtime methods use runtime token and protocol endpoints", async () => {
  const calls = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    accessToken: "ol_live_user",
    runtimeToken: "ol_live_runtime",
    fetch: async (url, init) => {
      const call = {
        url: String(url),
        method: init.method,
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (call.url.endsWith("/agent-runtime/heartbeat")) {
        return jsonResponse({
          agent_id: "agent-1",
          availability_status: "healthy",
          consecutive_failures: 0,
          pending_run_count: 1,
          claim_now: true,
          next_claim_after_seconds: 0,
          recommended_heartbeat_after_seconds: 60,
          max_claim_wait_seconds: 30,
        });
      }
      if (call.url.includes("/agent-runtime/runs/claim")) {
        return jsonResponse({
          run_id: "run-1",
          agent_id: "agent-1",
          input: { query: "hello" },
          source: "api",
          result_endpoint: "/api/v1/agent-runtime/runs/run-1/result",
          result_method: "POST",
          result_required: true,
        });
      }
      if (call.url.endsWith("/agent-runtime/runs/run-1/result")) {
        return jsonResponse({
          run_id: "run-1",
          status: "success",
          cost_cents: 0,
          duration_ms: 10,
        });
      }
      if (call.url.endsWith("/agent-runtime/call-agent")) {
        return jsonResponse({
          run_id: "child-1",
          status: "success",
          cost_cents: 0,
          duration_ms: 20,
        });
      }
      throw new Error(`unexpected URL ${call.url}`);
    },
  });

  const heartbeat = await client.heartbeatAgent();
  const claimed = await client.claimRuntimeRun({ wait: 25 });
  const completed = await client.completeRuntimeRun("run-1", {
    status: "success",
    output: { ok: true },
    events: [{ event_type: "run.message.delta", payload: { text: "done" } }],
    duration_ms: 10,
  });
  const child = await client.callAgent({
    currentRunId: "run-1",
    targetAgentId: "target-agent",
    reason: "delegate",
    input: { query: "child" },
    contextId: "ctx-sdk",
    traceId: "trace-sdk",
    referenceTaskIds: ["task-parent"],
    taskCallback: {
      url: "https://caller.example.com/a2a/events",
      token: "caller-token",
      secret: "caller-secret",
      eventTypes: ["run.completed", "run.failed", "run.canceled"],
      metadata: { client: "js-sdk" },
    },
  });
  const childAt = await client.callAgentAt("/api/v1/agent-runtime/call-agent", {
    currentRunId: "run-1",
    targetAgentId: "target-agent",
    input: "child",
  });

  assert.equal(heartbeat.agent_id, "agent-1");
  assert.equal(claimed.run_id, "run-1");
  assert.equal(completed.run_id, "run-1");
  assert.equal(child.run_id, "child-1");
  assert.equal(childAt.run_id, "child-1");
  assert.deepEqual(
    calls.map((call) => call.headers.get("authorization")),
    ["Bearer ol_live_runtime", "Bearer ol_live_runtime", "Bearer ol_live_runtime", "Bearer ol_live_runtime", "Bearer ol_live_runtime"],
  );
  assert.equal(calls[1].url, "https://core.example.com/api/v1/agent-runtime/runs/claim?wait=25");
  assert.deepEqual(calls[2].body, {
    status: "success",
    output: { ok: true },
    events: [{ event_type: "run.message.delta", payload: { text: "done" } }],
    duration_ms: 10,
  });
  assert.deepEqual(calls[3].body, {
    current_run_id: "run-1",
    target_agent_id: "target-agent",
    reason: "delegate",
    input: { query: "child" },
    context_id: "ctx-sdk",
    trace_id: "trace-sdk",
    reference_task_ids: ["task-parent"],
    task_callback: {
      url: "https://caller.example.com/a2a/events",
      token: "caller-token",
      secret: "caller-secret",
      eventTypes: ["run.completed", "run.failed", "run.canceled"],
      metadata: { client: "js-sdk" },
    },
  });
  assert.equal(calls[4].url, "https://core.example.com/api/v1/agent-runtime/call-agent");
  assert.deepEqual(calls[4].body, {
    current_run_id: "run-1",
    target_agent_id: "target-agent",
    input: "child",
  });
});

test("claimRuntimeRun returns undefined on empty 204 claim", async () => {
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    runtimeToken: "ol_live_runtime",
    fetch: async () => new Response(null, {
      status: 204,
      headers: {
        "retry-after": "3",
        "x-openlinker-max-claim-wait-seconds": "30",
      },
    }),
  });

  assert.equal(await client.claimRuntimeRun(), undefined);
  const detailed = await client.claimRuntimeRunDetailed();
  assert.equal(detailed.run, undefined);
  assert.equal(detailed.retryAfterMs, 3000);
  assert.equal(detailed.maxClaimWaitSeconds, 30);
});

test("A2A JSON-RPC client covers task and push notification methods", async () => {
  const calls = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    accessToken: "ol_public",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const headers = new Headers(init.headers);
      calls.push({ url: String(url), headers, body });
      if (body.method === "SendMessage" || body.method === "GetTask" || body.method === "CancelTask") {
        if (body.method === "SendMessage") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              task: {
                id: "task-a2a",
                status: {
                  state: "TASK_STATE_COMPLETED",
                  message: { parts: [{ text: "done" }] },
                },
              },
            },
          });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            id: "task-a2a",
            status: {
              state: "TASK_STATE_COMPLETED",
            },
          },
        });
      }
      if (body.method === "ListTasks") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tasks: [{ id: "task-a2a", status: { state: "completed" } }] },
        });
      }
      if (body.method === "CreateTaskPushNotificationConfig" || body.method === "GetTaskPushNotificationConfig") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            taskId: "task-a2a",
            id: "cfg-1",
            url: "https://caller.example/a2a/events",
          },
        });
      }
      if (body.method === "ListTaskPushNotificationConfigs") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { configs: [{ taskId: "task-a2a", id: "cfg-1" }] },
        });
      }
      if (body.method === "DeleteTaskPushNotificationConfig") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: null });
      }
      throw new Error(`unexpected method ${body.method}`);
    },
  });

  const task = await client.a2aSendMessage("agent/one", newA2ATextMessageParams("msg-1", "hello"));
  await client.a2aGetTask("agent/one", { id: "task-a2a" });
  await client.a2aListTasks("agent/one", { status: "completed", pageSize: 5 });
  await client.a2aCancelTask("agent/one", { id: "task-a2a" });
  await client.a2aSetTaskPushNotificationConfig("agent/one", {
    id: "task-a2a",
    pushNotificationConfig: { url: "https://caller.example/a2a/events" },
  });
  await client.a2aGetTaskPushNotificationConfig("agent/one", {
    id: "task-a2a",
    pushNotificationConfigId: "cfg-1",
  });
  await client.a2aListTaskPushNotificationConfigs("agent/one", { id: "task-a2a" });
  await client.a2aDeleteTaskPushNotificationConfig("agent/one", {
    id: "task-a2a",
    pushNotificationConfigId: "cfg-1",
  });

  assert.equal(task.id, "task-a2a");
  assert.equal(a2aTaskStateRunStatus(task.status.state), "success");
  assert.equal(extractA2AText(task), "done");
  assert.equal(calls.length, 8);
  assert.equal(calls[0].url, "https://core.example.com/api/v1/a2a/agents/agent%2Fone");
  assert.equal(calls[0].headers.get("authorization"), "Bearer ol_public");
  assert.equal(calls[0].headers.get("a2a-version"), "1.0");
  assert.equal(calls[0].body.method, "SendMessage");
  assert.equal(calls[0].body.params.message.kind, undefined);
  assert.equal(calls[0].body.params.message.role, "ROLE_USER");
  assert.deepEqual(calls[0].body.params.message.parts[0], { text: "hello" });
  assert.equal(calls[0].body.params.configuration.returnImmediately, false);
  assert.equal(calls[0].body.params.configuration.blocking, undefined);
  assert.equal(calls[2].body.params.status, "completed");
  assert.equal(calls[2].body.params.pageSize, 5);
  assert.equal(calls[4].body.params.taskId, "task-a2a");
  assert.equal(calls[4].body.params.url, "https://caller.example/a2a/events");
  assert.equal(calls[4].body.params.pushNotificationConfig, undefined);
  assert.equal(calls[6].body.params.taskId, "task-a2a");
  assert.equal(calls[6].body.params.id, undefined);
});

test("A2A HTTP+JSON client covers REST task and push methods", async () => {
  const calls = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    accessToken: "ol_public",
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      const body = init.body ? JSON.parse(init.body) : undefined;
      const parsed = new URL(String(url));
      calls.push({ url: String(url), method: init.method, headers, body });
      assert.equal(headers.get("authorization"), "Bearer ol_public");
      assert.equal(headers.get("a2a-version"), "1.0");
      if (init.method === "POST" && parsed.pathname.endsWith("/message:send")) {
        assert.equal(headers.get("content-type"), "application/a2a+json");
        assert.equal(body.message.role, "ROLE_USER");
        return a2aJSONResponse({ task: { id: "task-rest", status: { state: "TASK_STATE_COMPLETED" } } });
      }
      if (init.method === "POST" && parsed.pathname.endsWith("/message:stream")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "event: status-update",
              'data: {"statusUpdate":{"status":{"state":"TASK_STATE_WORKING"}}}',
              "",
              "",
            ].join("\n")));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (init.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest")) {
        assert.equal(parsed.searchParams.get("historyLength"), "2");
        return a2aJSONResponse({ id: "task-rest", status: { state: "TASK_STATE_COMPLETED" } });
      }
      if (init.method === "GET" && parsed.pathname.endsWith("/tasks")) {
        assert.equal(parsed.searchParams.get("contextId"), "ctx-rest");
        assert.equal(parsed.searchParams.get("includeArtifacts"), "true");
        return a2aJSONResponse({ tasks: [{ id: "task-rest", status: { state: "completed" } }] });
      }
      if (init.method === "POST" && parsed.pathname.endsWith("/tasks/task-rest:cancel")) {
        return a2aJSONResponse({ id: "task-rest", status: { state: "TASK_STATE_CANCELED" } });
      }
      if (init.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest/subscribe")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "event: task",
              'data: {"task":{"id":"task-rest","status":{"state":"TASK_STATE_COMPLETED"}}}',
              "",
              "",
            ].join("\n")));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (init.method === "POST" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs")) {
        return a2aJSONResponse({ taskId: "task-rest", id: "cfg-1", url: body.url });
      }
      if (init.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs/cfg-1")) {
        return a2aJSONResponse({ taskId: "task-rest", id: "cfg-1" });
      }
      if (init.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs")) {
        return a2aJSONResponse({ configs: [{ taskId: "task-rest", id: "cfg-1" }] });
      }
      if (init.method === "DELETE" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs/cfg-1")) {
        return new Response(null, { status: 204 });
      }
      if (init.method === "GET" && parsed.pathname.endsWith("/extendedAgentCard")) {
        return a2aJSONResponse({ name: "REST Agent", description: "", url: "", version: "v1", provider: {}, capabilities: {}, default_input_modes: [], default_output_modes: [], skills: [], authentication: {}, openlinker: {} });
      }
      throw new Error(`unexpected REST request ${init.method} ${parsed.pathname}`);
    },
  });

  const send = await client.a2aSendMessageHTTP("agent/one", newA2ATextMessageParams("msg-rest", "hello"));
  assert.equal(send.task.id, "task-rest");
  const streamEvents = [];
  await client.a2aStreamMessageHTTP("agent/one", newA2ATextMessageParams("msg-stream", "hello"), {
    onEvent: (event) => streamEvents.push(event),
  });
  assert.equal(streamEvents.length, 1);
  await client.a2aGetTaskHTTP("agent/one", { id: "task-rest", historyLength: 2 });
  await client.a2aListTasksHTTP("agent/one", { contextId: "ctx-rest", includeArtifacts: true });
  await client.a2aCancelTaskHTTP("agent/one", { id: "task-rest" });
  const subscribeEvents = [];
  await client.a2aResubscribeTaskHTTP("agent/one", { id: "task-rest" }, {
    onEvent: (event) => subscribeEvents.push(event),
  });
  assert.equal(subscribeEvents.length, 1);
  const push = { id: "task-rest", pushNotificationConfigId: "cfg-1", pushNotificationConfig: { url: "https://caller.example/a2a/events" } };
  await client.a2aSetTaskPushNotificationConfigHTTP("agent/one", push);
  await client.a2aGetTaskPushNotificationConfigHTTP("agent/one", push);
  await client.a2aListTaskPushNotificationConfigsHTTP("agent/one", push);
  await client.a2aDeleteTaskPushNotificationConfigHTTP("agent/one", push);
  const card = await client.a2aGetExtendedAgentCardHTTP("agent/one");
  assert.equal(card.name, "REST Agent");
  assert.equal(calls.length, 11);
  assert.equal(calls[0].url, "https://core.example.com/api/v1/a2a/agents/agent%2Fone/message:send");
});

test("A2A send message response supports direct message payloads", async () => {
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { message: { role: "ROLE_AGENT", parts: [{ text: "no task" }] } },
      });
    },
  });

  const response = await client.a2aSendMessageResponse("agent-one", newA2ATextMessageParams("msg-1", "hello"));
  assert.equal(extractA2AText(response.message), "no task");
  await assert.rejects(
    () => client.a2aSendMessage("agent-one", newA2ATextMessageParams("msg-2", "hello")),
    /returned a message/,
  );
});

test("A2A legacy dialect keeps slash methods and legacy message parts", async () => {
  let received;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      received = JSON.parse(init.body);
      return jsonResponse({
        jsonrpc: "2.0",
        id: received.id,
        result: { id: "task-legacy", status: { state: "completed" } },
      });
    },
  });

  await client.a2aSendMessage(
    "agent-one",
    newA2ATextMessageParams("msg-legacy", "legacy"),
    { a2aDialect: "legacy" },
  );

  assert.equal(received.method, "message/send");
  assert.equal(received.params.message.kind, "message");
  assert.deepEqual(received.params.message.parts[0], { text: "legacy", kind: "text" });
  assert.equal(received.params.configuration.blocking, true);
  assert.equal(received.params.configuration.returnImmediately, undefined);
});

test("A2A stream and JSON-RPC errors are parsed", async () => {
  let requestCount = 0;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      requestCount += 1;
      const body = JSON.parse(init.body);
      if (requestCount === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "id: 1",
              "event: task.status",
              'data: {"jsonrpc":"2.0","result":{"statusUpdate":{"status":{"state":"TASK_STATE_WORKING"}}}}',
              "",
              "",
            ].join("\n")));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32603, message: "boom" },
      });
    },
  });
  const events = [];
  await client.a2aStreamMessage("agent-one", newA2ATextMessageParams("msg-1", "hello"), {
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.length, 1);
  assert.equal(normalizeA2ATaskState(events[0].result.statusUpdate.status.state), "working");
  await assert.rejects(
    () => client.a2aGetTask("agent-one", { id: "task-bad" }),
    (error) => {
      assert.ok(error instanceof OpenLinkerA2AError);
      assert.equal(error.code, -32603);
      assert.equal(error.message, "boom");
      return true;
    },
  );
  assert.equal(normalizeA2AJsonRpcMethod("SendMessage"), "SendMessage");
  assert.equal(normalizeA2AJsonRpcMethod("ListTaskPushNotificationConfigs"), "ListTaskPushNotificationConfigs");
  assert.equal(normalizeA2AJsonRpcMethodForDialect("SendMessage", "legacy"), "message/send");
  assert.equal(normalizeA2ADialect("0.3"), "legacy");
  assert.equal(normalizeA2ATaskState("TASK_STATE_CANCELLED"), "canceled");
  assert.equal(a2aTaskStateRunStatus("TASK_STATE_REJECTED"), "failed");
});

test("runRuntimePullLoop reports heartbeat and claim errors before stopOnEmpty", async () => {
  const errors = [];
  let heartbeatCalls = 0;
  let claimCalls = 0;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    runtimeToken: "ol_live_runtime",
    fetch: async (url) => {
      if (String(url).endsWith("/agent-runtime/heartbeat")) {
        heartbeatCalls += 1;
        if (heartbeatCalls === 1) {
          return jsonResponse({ error: { code: "HEARTBEAT_BUSY", message: "busy" } }, { status: 503 });
        }
        return jsonResponse({
          agent_id: "agent-1",
          availability_status: "healthy",
          consecutive_failures: 0,
          pending_run_count: 0,
          claim_now: false,
          next_claim_after_seconds: 1,
          recommended_heartbeat_after_seconds: 60,
          max_claim_wait_seconds: 30,
        });
      }
      if (String(url).includes("/agent-runtime/runs/claim")) {
        claimCalls += 1;
        if (claimCalls === 1) {
          return jsonResponse({ error: { code: "CLAIM_BACKOFF", message: "back off" } }, { status: 429 });
        }
        return new Response(null, {
          status: 204,
          headers: { "retry-after": "0" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await client.runRuntimePullLoop({
    onError: (error) => errors.push(error),
  }, {
    waitSeconds: 1,
    heartbeatMs: 0,
    emptyRetryMs: 1,
    stopOnEmpty: true,
  });

  assert.equal(heartbeatCalls, 2);
  assert.equal(claimCalls, 2);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((error) => error.code), ["HEARTBEAT_BUSY", "CLAIM_BACKOFF"]);
});

test("runRuntimePullLoop claims assignments with runtime token", async () => {
  const calls = [];
  const assignments = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    runtimeToken: "ol_live_runtime",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        authorization: new Headers(init.headers).get("authorization"),
      });
      if (String(url).endsWith("/agent-runtime/heartbeat")) {
        return jsonResponse({
          agent_id: "agent-1",
          availability_status: "healthy",
          consecutive_failures: 0,
          pending_run_count: 1,
          claim_now: true,
          next_claim_after_seconds: 0,
          recommended_heartbeat_after_seconds: 60,
          max_claim_wait_seconds: 30,
        });
      }
      if (String(url).includes("/agent-runtime/runs/claim")) {
        return jsonResponse({
          run_id: "run-loop",
          agent_id: "agent-1",
          input: "hello",
          metadata: { source: "test" },
          source: "api",
          result_endpoint: "/api/v1/agent-runtime/runs/run-loop/result",
          result_method: "POST",
          result_required: true,
          a2a: { current_run_id: "run-loop", call_agent_endpoint: "/api/v1/agent-runtime/call-agent", call_agent_method: "POST", runtime_token_type: "scoped", runtime_scopes: ["agent:call"] },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await client.runRuntimePullLoop({
    onAssigned: (assignment) => assignments.push(assignment),
  }, {
    waitSeconds: 2,
    heartbeatMs: 1,
    emptyRetryMs: 1,
    maxRuns: 1,
  });

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].type, "run.assigned");
  assert.equal(assignments[0].run_id, "run-loop");
  assert.equal(assignments[0].input, "hello");
  assert.deepEqual(calls.map((call) => call.authorization), ["Bearer ol_live_runtime", "Bearer ol_live_runtime"]);
  assert.equal(calls[1].url, "https://core.example.com/api/v1/agent-runtime/runs/claim?wait=2");
});

test("connectRuntimeWebSocket handles assignment and sends event/result", async () => {
  const sockets = [];
  const ready = [];
  const assignments = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    runtimeToken: "ol_live_ws",
    fetch: async () => {
      throw new Error("fetch should not be used for websocket");
    },
  });

  const connection = await client.connectRuntimeWebSocket({
    onReady: (message) => ready.push(message),
    onAssigned: (assignment) => assignments.push(assignment),
  }, {
    webSocketFactory: (url, options) => {
      const socket = new FakeRuntimeWebSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    reconnect: false,
  });

  const socket = sockets[0];
  assert.equal(socket.url, "wss://core.example.com/api/v1/agent-runtime/ws");
  assert.equal(socket.options.headers.authorization, "Bearer ol_live_ws");
  socket.open();
  await connection.ready;
  socket.message({ type: "runtime.ready", agent_id: "agent-1" });
  socket.message({
    type: "run.assigned",
    run_id: "run-ws",
    agent_id: "agent-1",
    input: { task: "ws" },
    source: "api",
    result_required: true,
    a2a: { current_run_id: "run-ws", call_agent_endpoint: "/api/v1/agent-runtime/call-agent", call_agent_method: "POST", runtime_token_type: "scoped", runtime_scopes: ["agent:call"] },
  });
  await nextTick();

  assert.equal(ready[0].agent_id, "agent-1");
  assert.equal(assignments[0].run_id, "run-ws");
  assert.deepEqual(assignments[0].input, { task: "ws" });

  connection.sendRunEvent("run-ws", { event_type: "run.message.delta", payload: "hi" });
  connection.completeRun("run-ws", {
    status: "success",
    output: { answer: "ok" },
    duration_ms: 12,
  });

  assert.equal(socket.sent[0].type, "run.event");
  assert.equal(socket.sent[0].event_type, "run.message.delta");
  assert.equal(socket.sent[1].type, "run.result");
  assert.equal(socket.sent[1].status, "success");
  assert.equal(socket.sent[1].duration_ms, 12);
  connection.close();
});

test("connectRuntimeWebSocket reconnects after close", async () => {
  const sockets = [];
  const assignments = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    runtimeToken: "ol_live_ws",
    fetch: async () => {
      throw new Error("fetch should not be used for websocket");
    },
  });

  const connection = await client.connectRuntimeWebSocket({
    onAssigned: (assignment) => assignments.push(assignment),
  }, {
    reconnect: true,
    reconnectMinMs: 1,
    reconnectMaxMs: 2,
    webSocketFactory: (url, options) => {
      const socket = new FakeRuntimeWebSocket(url, options);
      sockets.push(socket);
      return socket;
    },
  });

  sockets[0].open();
  await connection.ready;
  sockets[0].close();
  await waitFor(() => sockets.length === 2);
  sockets[1].open();
  sockets[1].message({
    type: "run.assigned",
    run_id: "run-reconnect",
    input: "after reconnect",
  });
  await waitFor(() => assignments.length === 1);

  assert.equal(assignments[0].run_id, "run-reconnect");
  assert.equal(assignments[0].input, "after reconnect");
  connection.close();
});

test("connectRuntimeWebSocket sends heartbeats and reports edge errors", async () => {
  let socket;
  let connection;
  const messages = [];
  const errors = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    runtimeToken: "ol_live_ws",
    fetch: async () => {
      throw new Error("fetch should not be used for websocket");
    },
  });

  try {
    connection = await client.connectRuntimeWebSocket({
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
    }, {
      endpoint: "ws://runtime.example.test/ws",
      heartbeatMs: 1,
      reconnect: false,
      protocols: ["openlinker-runtime"],
      webSocketFactory: (url, options) => {
        socket = new LegacyRuntimeWebSocket(url, options);
        return socket;
      },
    });

    assert.equal(socket.url, "ws://runtime.example.test/ws");
    assert.deepEqual(socket.options.protocols, ["openlinker-runtime"]);
    socket.open();
    await connection.ready;
    await waitFor(() => socket.sent.some((message) => message.type === "heartbeat"));

    socket.messageBuffer({ type: "error", error: { code: "RUNTIME_BAD", message: "bad runtime" } });
    socket.message({ type: "error", error: { message: "loose runtime" } });
    socket.messageRaw("{");
    socket.error({ type: "network-error" });
    await waitFor(() => errors.length >= 4 && messages.length >= 2);

    const errorMessages = errors.map((error) => error?.message ?? JSON.stringify(error)).join("\n");
    assert.match(errorMessages, /RUNTIME_BAD: bad runtime/);
    assert.match(errorMessages, /loose runtime/);
    assert.ok(errors.some((error) => error instanceof SyntaxError));
    assert.ok(errors.some((error) => error?.type === "network-error"));

    socket.close();
    assert.throws(
      () => connection.sendRunEvent("run-closed", { event_type: "run.message.delta" }),
      /runtime websocket is not open/,
    );
  } finally {
    connection?.close();
  }
});

test("connectRuntimeWebSocket requires a WebSocket implementation by default", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const client = new OpenLinkerClient({
      baseUrl: "https://core.example.com",
      runtimeToken: "ol_live_ws",
      fetch: async () => {
        throw new Error("fetch should not be used for websocket");
      },
    });
    await assert.rejects(
      () => client.connectRuntimeWebSocket({}, { reconnect: false }),
      /requires a WebSocket implementation/,
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "WebSocket", descriptor);
    } else {
      delete globalThis.WebSocket;
    }
  }
});

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function a2aJSONResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/a2a+json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

class FakeRuntimeWebSocket {
  readyState = 0;
  sent = [];
  listeners = new Map();

  constructor(url, options) {
    this.url = url;
    this.options = options;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value) {
    this.emit("message", { data: JSON.stringify(value) });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class LegacyRuntimeWebSocket {
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url, options) {
    this.url = url;
    this.options = options;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(value) {
    this.messageRaw(JSON.stringify(value));
  }

  messageBuffer(value) {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(value)).buffer });
  }

  messageRaw(data) {
    this.onmessage?.({ data });
  }

  error(event) {
    this.onerror?.(event);
  }
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await nextTick();
  }
}
