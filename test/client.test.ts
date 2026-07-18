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
import type {
  A2AStreamEvent,
  OpenLinkerClientOptions,
  StreamRunEvent,
} from "../dist/index.js";

interface RecordedFetchCall {
  url: string;
  init: RequestInit;
}

interface TestRequestBody extends Record<string, unknown> {
  id?: string | number | null;
  method?: string;
  message?: { role?: string };
  params?: {
    message?: {
      kind?: string;
      role?: string;
      parts?: Array<Record<string, unknown>>;
    };
    configuration?: {
      returnImmediately?: boolean;
      blocking?: boolean;
    };
    status?: string;
    pageSize?: number;
    taskId?: string;
    url?: string;
    pushNotificationConfig?: unknown;
    id?: string;
  };
  url?: string;
}

interface RecordedA2ACall {
  url: string;
  method?: string | undefined;
  headers: Headers;
  body: TestRequestBody | undefined;
}

test("listAgents builds Core API URL and authorization header", async () => {
  const calls: RecordedFetchCall[] = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    userToken: "ol_user_test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
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
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://core.example.com/api/v1/agents?q=data&page=2&size=5&callable_only=true&tags=sql%2Cfinance",
  );
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer ol_user_test");
  assert.equal(headers.get("x-openlinker-sdk"), "@openlinker/sdk/0.1.4");
});

test("client rejects agent token and points callers to runtime entry", () => {
  const invalidOptions = {
    baseUrl: "https://core.example.com",
    agentToken: "ol_agent_runtime",
    fetch: async () => jsonResponse({}),
  } as unknown as OpenLinkerClientOptions;
  assert.throws(
    () => new OpenLinkerClient(invalidOptions),
    /OpenLinkerRuntime/,
  );
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
  const calls: RecordedFetchCall[] = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        run_id: "run-1",
        status: "success",
        replayed: false,
        output: { ok: true },
        cost_cents: 0,
        duration_ms: 12,
        agent_id: "00000000-0000-0000-0000-000000000001",
        agent_slug: "runtime-agent",
        agent_name: "Runtime Agent",
        agent_connection_mode: "runtime",
        started_at: "2026-07-18T00:00:00Z",
        finished_at: "2026-07-18T00:00:01Z",
        source: "api",
        runtime_contract_id: "openlinker.runtime.v2",
        runtime_transport: "websocket",
        runtime_transport_reason: "recovery",
        runtime_transport_changed_at: "2026-07-18T00:00:00Z",
        dispatch_state: "terminal",
        attempt_count: 1,
        max_attempts: 3,
        latest_attempt_id: "attempt-1",
      }, { status: 201 });
    },
  });

  const response = await client.runAgent({
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    idempotencyKey: "logical-run-1",
    metadata: { trace_id: "trace-1" },
    a2aContext: {
      protocol_context_id: "ctx-root",
      protocol_task_id: "task-root",
      trace_id: "trace-1",
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
  assert.equal(response.replayed, false);
  assert.equal(response.agent_connection_mode, "runtime");
  assert.equal(response.runtime_transport, "websocket");
  assert.equal(response.runtime_transport_reason, "recovery");
  assert.equal(response.dispatch_state, "terminal");
  assert.equal(response.attempt_count, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://core.example.com/api/v1/run");
  assert.equal(new Headers(call.init.headers).get("idempotency-key"), "logical-run-1");
  assert.deepEqual(parseRequestBody(call.init), {
    agent_id: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    metadata: { trace_id: "trace-1" },
    a2a_context: {
      protocol_context_id: "ctx-root",
      protocol_task_id: "task-root",
      trace_id: "trace-1",
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

test("Run creation accepts 201, 200, and 202 idempotency responses", async () => {
  const calls: RecordedFetchCall[] = [];
  const responses = [
    {
      status: 201,
      body: {
        run_id: "run-status",
        status: "success",
        replayed: false,
        cost_cents: 0,
        duration_ms: 4,
      },
    },
    {
      status: 200,
      body: {
        run_id: "run-status",
        status: "success",
        replayed: true,
        cost_cents: 0,
        duration_ms: 4,
      },
    },
    {
      status: 202,
      body: {
        run_id: "run-async-status",
        status: "running",
        replayed: true,
        cost_cents: 0,
        duration_ms: 0,
      },
    },
  ];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const response = responses[calls.length - 1];
      assert.ok(response);
      return jsonResponse(response.body, {
        status: response.status,
        headers: { location: `/api/v1/runs/${response.body.run_id}` },
      });
    },
  });
  const request = {
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "retry me" },
    idempotencyKey: "stable-application-operation",
  };

  const created = await client.runAgent(request);
  const replayed = await client.runAgent(request);
  const runningReplay = await client.startAgentRun({
    ...request,
    idempotencyKey: "stable-async-operation",
  });

  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.equal(runningReplay.replayed, true);
  assert.equal(runningReplay.status, "running");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://core.example.com/api/v1/run",
    "https://core.example.com/api/v1/run",
    "https://core.example.com/api/v1/runs",
  ]);
  assert.deepEqual(
    calls.map((call) => new Headers(call.init.headers).get("idempotency-key")),
    ["stable-application-operation", "stable-application-operation", "stable-async-operation"],
  );
});

test("Run creation generates a secure per-invocation idempotency key when omitted", async () => {
  const keys: Array<string | null> = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return jsonResponse({
        run_id: `run-generated-${keys.length}`,
        status: "success",
        replayed: false,
        cost_cents: 0,
        duration_ms: 1,
      }, { status: 201 });
    },
  });
  const request = {
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
  };

  await client.runAgent(request);
  await client.startAgentRun(request);

  const [firstKey, secondKey] = keys;
  assert.ok(firstKey);
  assert.ok(secondKey);
  assert.match(firstKey, /^[0-9a-f]{64}$/);
  assert.match(secondKey, /^[0-9a-f]{64}$/);
  assert.notEqual(firstKey, secondKey);
});

test("Run creation rejects invalid idempotency keys without exposing the key", async () => {
  let fetchCalls = 0;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  const invalidKeys = [
    "",
    "contains\nnewline",
    "contains\u007fdelete",
    "contains-é",
    "x".repeat(256),
  ];

  for (const idempotencyKey of invalidKeys) {
    await assert.rejects(
      () => client.runAgent({
        agentId: "00000000-0000-0000-0000-000000000001",
        input: { query: "hello" },
        idempotencyKey,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /1-255 printable ASCII/);
        if (idempotencyKey) {
          assert.ok(!error.message.includes(idempotencyKey));
        }
        return true;
      },
    );
  }
  assert.equal(fetchCalls, 0);
});

test("createWebhookRunCallback passes external callback URL and generated secret", async () => {
  const calls: RecordedFetchCall[] = [];
  const callback = createWebhookRunCallback({
    url: " https://caller.example.com/openlinker/events ",
    token: "caller-token",
    eventTypes: ["run.completed", "run.failed"],
    metadata: { client: "js-sdk" },
  });
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
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
  assert.ok(callback.secret);
  assert.match(callback.secret, /^[0-9a-f]{64}$/);

  await client.startAgentRun({
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    callback,
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://core.example.com/api/v1/runs");
  assert.deepEqual(parseRequestBody(call.init), {
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
  const calls: RecordedFetchCall[] = [];
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
      calls.push({ url: String(url), init: init ?? {} });
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

  const events: StreamRunEvent[] = [];
  const terminal: StreamRunEvent[] = [];
  const response = await client.runAgentWithCallbacks({
    agentId: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    callback: {
      mode: "platform",
      eventTypes: ["run.message.delta"],
      onEvent: (event) => {
        events.push(event as StreamRunEvent);
      },
      onTerminal: (event) => {
        terminal.push(event as StreamRunEvent);
      },
    },
  });

  assert.equal(response.status, "success");
  const [startCall, streamCall, resultCall] = calls;
  assert.ok(startCall);
  assert.ok(streamCall);
  assert.ok(resultCall);
  assert.equal(startCall.url, "https://core.example.com/api/v1/runs");
  assert.deepEqual(parseRequestBody(startCall.init), {
    agent_id: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
  });
  assert.equal(streamCall.url, "https://core.example.com/api/v1/runs/run-platform/stream");
  assert.equal(resultCall.url, "https://core.example.com/api/v1/runs/run-platform");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "run.message.delta");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.event, "run.completed");
});

test("runAgentWithCallbacks preserves replay across callback wait", async () => {
  const scenarios = [
    {
      runId: "run-start-replay",
      startedReplayed: true,
      terminalReplayed: false,
      expectedReplayed: true,
    },
    {
      runId: "run-terminal-replay",
      startedReplayed: false,
      terminalReplayed: true,
      expectedReplayed: true,
    },
    {
      runId: "run-not-replayed",
      startedReplayed: false,
      terminalReplayed: false,
      expectedReplayed: false,
    },
  ];
  let startIndex = 0;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/runs") {
        const scenario = scenarios[startIndex++];
        assert.ok(scenario);
        return jsonResponse({
          run_id: scenario.runId,
          status: "running",
          replayed: scenario.startedReplayed,
          cost_cents: 0,
          duration_ms: 0,
        }, { status: scenario.startedReplayed ? 202 : 201 });
      }
      const scenario = scenarios.find(({ runId }) => (
        path === `/api/v1/runs/${runId}` || path === `/api/v1/runs/${runId}/stream`
      ));
      if (!scenario) {
        throw new Error(`unexpected URL ${url}`);
      }
      if (path.endsWith("/stream")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode([
              "id: 1",
              "event: run.completed",
              `data: {"event_id":"event-${scenario.runId}","run_id":"${scenario.runId}","sequence":1,"event_type":"run.completed","payload":{"status":"success"},"created_at":"2026-06-21T00:00:00Z"}`,
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
        run_id: scenario.runId,
        status: "success",
        replayed: scenario.terminalReplayed,
        output: { ok: true },
        cost_cents: 0,
        duration_ms: 12,
      });
    },
  });

  for (const scenario of scenarios) {
    const response = await client.runAgentWithCallbacks({
      agentId: "00000000-0000-0000-0000-000000000001",
      input: { query: scenario.runId },
      idempotencyKey: `idempotency-${scenario.runId}`,
      callback: { mode: "platform" },
    });

    assert.equal(response.replayed, scenario.expectedReplayed, scenario.runId);
  }
});

test("endpoint helpers encode paths, queries, and async headers", async () => {
  const calls: RecordedA2ACall[] = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1/",
    userToken: async () => "ol_user_async",
    headers: async () => ({ "x-default": "base" }),
    fetch: async (url, init) => {
      const request = init ?? {};
      calls.push({
        url: String(url),
        method: request.method,
        headers: new Headers(request.headers),
        body: parseOptionalRequestBody(request),
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
  await client.listRunChildren("run helper");
  await client.listRunArtifacts("run helper");
  await client.listRunMessages("run helper");

  assert.deepEqual(calls.map((call) => call.url), [
    "https://core.example.com/api/v1/agents/agent%2Fone",
    "https://core.example.com/api/v1/agents/agent%2Fone/agent-card.extended.json",
    "https://core.example.com/api/v1/runs",
    "https://core.example.com/api/v1/runs/run%20helper",
    "https://core.example.com/api/v1/runs/run%20helper/events?after_sequence=2&limit=10",
    "https://core.example.com/api/v1/runs/run%20helper/children",
    "https://core.example.com/api/v1/runs/run%20helper/artifacts",
    "https://core.example.com/api/v1/runs/run%20helper/messages",
  ]);
  assert.deepEqual(calls[2]?.body, {
    agent_id: "agent-1",
    input: "hello",
    metadata: { trace_id: "trace-helper" },
  });
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer ol_user_async");
  assert.equal(calls[2]?.headers.get("authorization"), "Bearer ol_override");
  assert.equal(calls[2]?.headers.get("x-default"), "override");
  assert.equal(calls[2]?.headers.get("content-type"), "application/json");
});

test("listRunEvents returns items and durable page metadata", async () => {
  const responseBody = {
    items: [{
      event_id: "event-6",
      run_id: "run-page",
      sequence: 6,
      event_type: "run.message.delta",
      payload: { text: "continued" },
      created_at: "2026-07-11T00:00:00Z",
    }],
    meta: {
      requested_after_sequence: 2,
      effective_after_sequence: 5,
      retained_through_sequence: 5,
      earliest_available_sequence: 6,
      latest_available_sequence: 8,
      retention_gap: true,
      terminal: false,
      stream_complete: false,
    },
  };
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    userToken: "ol_user_test",
    fetch: async () => jsonResponse(responseBody),
  });

  const page = await client.listRunEvents("run-page", { afterSequence: 2 });

  assert.deepEqual(page, responseBody);
  assert.equal(page.items[0]?.sequence, 6);
  assert.equal(page.meta.retention_gap, true);
  assert.equal("events" in page, false);
});

test("listRunChildren returns the parent and nested delegation tree", async () => {
  const responseBody = {
    parent_run_id: "parent-run",
    items: [{
      child_run_id: "child-run",
      status: "success",
      children: [{
        child_run_id: "grandchild-run",
        status: "running",
      }],
    }],
  };
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    userToken: "ol_user_test",
    fetch: async () => jsonResponse(responseBody),
  });

  const children = await client.listRunChildren("parent-run");

  assert.deepEqual(children, responseBody);
  const child = children.items[0];
  assert.ok(child);
  const grandchild = child.children?.[0];
  assert.ok(grandchild);
  assert.equal(grandchild.child_run_id, "grandchild-run");
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
    userToken: "ol_user_user",
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

  assert.equal(await client.getRun("run-204"), undefined);
  await assert.rejects(
    () => client.getRun("run-503"),
    (error) => {
      assert.ok(error instanceof OpenLinkerError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "HTTP_503");
      assert.equal(error.message, "Service Unavailable");
      assert.equal(error.requestId, "corr-1");
      assert.equal(error.responseBody, "temporarily unavailable");
      assert.ok(error.retryAfterMs !== undefined);
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
      assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const events: StreamRunEvent[] = [];
  const terminal: StreamRunEvent[] = [];
  let closed = false;
  await client.streamRunEvents("run-1", {
    onEvent: (event) => {
      events.push(event);
    },
    onTerminal: (event) => {
      terminal.push(event);
    },
    onClose: () => {
      closed = true;
    },
  }, { afterSequence: 6 });

  assert.equal(events.length, 1);
  assert.equal(terminal.length, 1);
  const firstEvent = events[0];
  assert.ok(firstEvent);
  assert.equal(firstEvent.id, "7");
  assert.equal(firstEvent.event, "run.completed");
  assert.ok(firstEvent.data && typeof firstEvent.data === "object");
  assert.deepEqual((firstEvent.data as { payload?: unknown }).payload, { ok: true });
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

  const events: StreamRunEvent[] = [];
  await client.streamRunEvents("run-plain", {
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, "run.message.delta");
  assert.equal(events[0]?.data, "plain text");
  assert.equal(events[1]?.event, "message");
  assert.deepEqual(events[1]?.data, { ok: true });
  await assert.rejects(
    () => client.streamRunEvents("missing-body"),
    /does not expose a body/,
  );
});

test("A2A JSON-RPC client covers task and push notification methods", async () => {
  const calls: Array<RecordedA2ACall & { body: TestRequestBody }> = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    userToken: "ol_public",
    fetch: async (url, init) => {
      const body = parseRequestBody(init);
      const headers = new Headers(init?.headers);
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
  const sendCall = calls[0];
  const listCall = calls[2];
  const setPushCall = calls[4];
  const listPushCall = calls[6];
  assert.ok(sendCall);
  assert.ok(listCall);
  assert.ok(setPushCall);
  assert.ok(listPushCall);
  assert.equal(sendCall.url, "https://core.example.com/api/v1/a2a/agents/agent%2Fone");
  assert.equal(sendCall.headers.get("authorization"), "Bearer ol_public");
  assert.equal(sendCall.headers.get("a2a-version"), "1.0");
  assert.equal(sendCall.body.method, "SendMessage");
  assert.equal(sendCall.body.params?.message?.kind, undefined);
  assert.equal(sendCall.body.params?.message?.role, "ROLE_USER");
  assert.deepEqual(sendCall.body.params?.message?.parts?.[0], { text: "hello" });
  assert.equal(sendCall.body.params?.configuration?.returnImmediately, false);
  assert.equal(sendCall.body.params?.configuration?.blocking, undefined);
  assert.equal(listCall.body.params?.status, "completed");
  assert.equal(listCall.body.params?.pageSize, 5);
  assert.equal(setPushCall.body.params?.taskId, "task-a2a");
  assert.equal(setPushCall.body.params?.url, "https://caller.example/a2a/events");
  assert.equal(setPushCall.body.params?.pushNotificationConfig, undefined);
  assert.equal(listPushCall.body.params?.taskId, "task-a2a");
  assert.equal(listPushCall.body.params?.id, undefined);
});

test("A2A HTTP+JSON client covers REST task and push methods", async () => {
  const calls: RecordedA2ACall[] = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com/api/v1",
    userToken: "ol_public",
    fetch: async (url, init) => {
      const request = init ?? {};
      const headers = new Headers(request.headers);
      const body = parseOptionalRequestBody(request);
      const parsed = new URL(String(url));
      calls.push({ url: String(url), method: request.method, headers, body });
      assert.equal(headers.get("authorization"), "Bearer ol_public");
      assert.equal(headers.get("a2a-version"), "1.0");
      if (request.method === "POST" && parsed.pathname.endsWith("/message:send")) {
        assert.equal(headers.get("content-type"), "application/a2a+json");
        assert.equal(body?.message?.role, "ROLE_USER");
        return a2aJSONResponse({ task: { id: "task-rest", status: { state: "TASK_STATE_COMPLETED" } } });
      }
      if (request.method === "POST" && parsed.pathname.endsWith("/message:stream")) {
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
      if (request.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest")) {
        assert.equal(parsed.searchParams.get("historyLength"), "2");
        return a2aJSONResponse({ id: "task-rest", status: { state: "TASK_STATE_COMPLETED" } });
      }
      if (request.method === "GET" && parsed.pathname.endsWith("/tasks")) {
        assert.equal(parsed.searchParams.get("contextId"), "ctx-rest");
        assert.equal(parsed.searchParams.get("includeArtifacts"), "true");
        return a2aJSONResponse({ tasks: [{ id: "task-rest", status: { state: "completed" } }] });
      }
      if (request.method === "POST" && parsed.pathname.endsWith("/tasks/task-rest:cancel")) {
        return a2aJSONResponse({ id: "task-rest", status: { state: "TASK_STATE_CANCELED" } });
      }
      if (request.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest/subscribe")) {
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
      if (request.method === "POST" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs")) {
        return a2aJSONResponse({ taskId: "task-rest", id: "cfg-1", url: body?.url });
      }
      if (request.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs/cfg-1")) {
        return a2aJSONResponse({ taskId: "task-rest", id: "cfg-1" });
      }
      if (request.method === "GET" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs")) {
        return a2aJSONResponse({ configs: [{ taskId: "task-rest", id: "cfg-1" }] });
      }
      if (request.method === "DELETE" && parsed.pathname.endsWith("/tasks/task-rest/pushNotificationConfigs/cfg-1")) {
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && parsed.pathname.endsWith("/extendedAgentCard")) {
        return a2aJSONResponse({ name: "REST Agent", description: "", url: "", version: "v1", provider: {}, capabilities: {}, default_input_modes: [], default_output_modes: [], skills: [], authentication: {}, openlinker: {} });
      }
      throw new Error(`unexpected REST request ${request.method} ${parsed.pathname}`);
    },
  });

  const send = await client.a2aSendMessageHTTP("agent/one", newA2ATextMessageParams("msg-rest", "hello"));
  assert.equal(send.task?.id, "task-rest");
  const streamEvents: A2AStreamEvent[] = [];
  await client.a2aStreamMessageHTTP("agent/one", newA2ATextMessageParams("msg-stream", "hello"), {
    onEvent: (event) => {
      streamEvents.push(event);
    },
  });
  assert.equal(streamEvents.length, 1);
  await client.a2aGetTaskHTTP("agent/one", { id: "task-rest", historyLength: 2 });
  await client.a2aListTasksHTTP("agent/one", { contextId: "ctx-rest", includeArtifacts: true });
  await client.a2aCancelTaskHTTP("agent/one", { id: "task-rest" });
  const subscribeEvents: A2AStreamEvent[] = [];
  await client.a2aResubscribeTaskHTTP("agent/one", { id: "task-rest" }, {
    onEvent: (event) => {
      subscribeEvents.push(event);
    },
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
  assert.equal(calls[0]?.url, "https://core.example.com/api/v1/a2a/agents/agent%2Fone/message:send");
});

test("A2A send message response supports direct message payloads", async () => {
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      const body = parseRequestBody(init);
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
  let received: TestRequestBody | undefined;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      received = parseRequestBody(init);
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

  assert.ok(received);
  assert.equal(received.method, "message/send");
  assert.equal(received.params?.message?.kind, "message");
  assert.deepEqual(received.params?.message?.parts?.[0], { text: "legacy", kind: "text" });
  assert.equal(received.params?.configuration?.blocking, true);
  assert.equal(received.params?.configuration?.returnImmediately, undefined);
});

test("A2A stream and JSON-RPC errors are parsed", async () => {
  let requestCount = 0;
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example.com",
    fetch: async (_url, init) => {
      requestCount += 1;
      const body = parseRequestBody(init);
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
  const events: A2AStreamEvent[] = [];
  await client.a2aStreamMessage("agent-one", newA2ATextMessageParams("msg-1", "hello"), {
    onEvent: (event) => {
      events.push(event);
    },
  });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event?.result?.statusUpdate);
  assert.equal(normalizeA2ATaskState(event.result.statusUpdate.status.state), "working");
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

function parseRequestBody(init: RequestInit | undefined): TestRequestBody {
  const body = init?.body;
  if (typeof body !== "string") {
    assert.fail("expected a JSON string request body");
  }
  return JSON.parse(body) as TestRequestBody;
}

function parseOptionalRequestBody(init: RequestInit): TestRequestBody | undefined {
  if (init.body === undefined || init.body === null) {
    return undefined;
  }
  return parseRequestBody(init);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function a2aJSONResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/a2a+json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
