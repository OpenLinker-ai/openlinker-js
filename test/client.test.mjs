import test from "node:test";
import assert from "node:assert/strict";

import { OpenLinkerClient, OpenLinkerError } from "../dist/index.js";

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
  assert.equal(headers.get("x-openlinker-sdk"), "@openlinker/sdk-js/0.0.0");
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
  });

  assert.equal(response.run_id, "run-1");
  assert.equal(calls[0].url, "https://core.example.com/api/v1/run");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agent_id: "00000000-0000-0000-0000-000000000001",
    input: { query: "hello" },
    metadata: { trace_id: "trace-1" },
  });
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
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.equal(await client.claimRuntimeRun(), undefined);
});

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
