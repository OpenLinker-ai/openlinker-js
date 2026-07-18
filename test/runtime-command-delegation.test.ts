import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenLinkerRuntime,
  RuntimeAttachmentHeader,
  RuntimeCallAgentPath,
  RuntimeContractDigest,
  RuntimeMaxMessageBytes,
  RuntimeMessageTypes,
  RuntimeRequiredFeatures,
  buildRuntimeInvocationProof,
} from "../dist/runtime.js";
import type {
  FetchLike,
  RuntimeAttemptIdentity,
  RuntimeHelloPayload,
} from "../dist/runtime.js";
import type { JsonValue } from "../dist/index.js";

const ids = Object.freeze({
  node: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  session: "33333333-3333-4333-8333-333333333333",
  otherSession: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  run: "44444444-4444-4444-8444-444444444444",
  attempt: "55555555-5555-4555-8555-555555555555",
  lease: "66666666-6666-4666-8666-666666666666",
  child: "77777777-7777-4777-8777-777777777777",
  cancellation: "88888888-8888-4888-8888-888888888888",
  otherCancellation: "99999999-9999-4999-8999-999999999999",
  target: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  core: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  attachment: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const now = "2026-07-11T13:00:00.123Z";
const later = "2026-07-11T13:01:00.123Z";
const invocation = Object.freeze({
  invocationContext: "ol_ctx_v2.current.payload.signature",
  token: "ol_inv_v2.current.payload.signature",
  idempotencyKey: "delegation-42",
});

test("Runtime invocation proof matches the fixed Core and Go vector", async () => {
  const request = {
    method: "POST",
    path: RuntimeCallAgentPath,
    idempotencyKey: "delegation-42<&",
    context: invocation.invocationContext,
    body: new TextEncoder().encode(
      `{"target_agent_id":"${ids.target}","input":{"q":"hello"},"reason":"need data"}`,
    ),
  };
  const proof = await buildRuntimeInvocationProof(invocation.token, request);
  assert.equal(proof, "lBuoEqAJKl9ujEr72b0oR3cuuoqJPqCs1vkABcw6zA0");

  const mutations = [
    { ...request, body: new Uint8Array([...request.body, 0x20]) },
    { ...request, idempotencyKey: `${request.idempotencyKey}-other` },
    { ...request, context: `${request.context}x` },
    { ...request, path: `${request.path}/other` },
  ];
  for (const changed of mutations) {
    assert.notEqual(await buildRuntimeInvocationProof(invocation.token, changed), proof);
  }
  assert.notEqual(
    await buildRuntimeInvocationProof("ol_inv_v2.other.payload.signature", request),
    proof,
  );
});

test("callRuntimeAgent signs and sends one exact UTF-8 body", async () => {
  let stringifyCalls = 0;
  const changing = {
    toJSON() {
      stringifyCalls++;
      return { value: stringifyCalls };
    },
  };
  const expectedBody = JSON.stringify({
    target_agent_id: ids.target,
    input: { q: "hello", nonce: { value: 1 } },
    metadata: { trace: "sdk" },
    reason: "need data",
  });
  const runtime = new OpenLinkerRuntime({
    baseUrl: "https://core.example.com/api/v1",
    agentToken: async () => {
      throw new Error("ordinary Agent Token provider must not run for delegated calls");
    },
    headers: {
      authorization: "Bearer default-must-not-win",
      "idempotency-key": "default-must-not-win",
      "openlinker-invocation-context": "default-must-not-win",
      [RuntimeAttachmentHeader]: "default-must-not-leak",
    },
    fetch: async (input, init) => {
      assert.ok(init);
      assert.ok(init.body instanceof ArrayBuffer);
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      const body = new Uint8Array(init.body);
      const text = new TextDecoder().decode(body);
      assert.equal(init.method, "POST");
      assert.equal(url.pathname, RuntimeCallAgentPath);
      assert.equal(url.search, "");
      assert.equal(headers.get("authorization"), `Bearer ${invocation.token}`);
      assert.equal(headers.get("idempotency-key"), invocation.idempotencyKey);
      assert.equal(headers.get("openlinker-invocation-context"), invocation.invocationContext);
      assert.equal(headers.get(RuntimeAttachmentHeader), null);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(text, expectedBody);
      assert.equal(stringifyCalls, 1, "delegated body must be stringified exactly once");
      const idempotencyKey = headers.get("idempotency-key");
      const context = headers.get("openlinker-invocation-context");
      assert.ok(idempotencyKey);
      assert.ok(context);
      const expectedProof = await buildRuntimeInvocationProof(invocation.token, {
        method: init.method ?? "",
        path: url.pathname,
        idempotencyKey,
        context,
        body,
      });
      assert.equal(headers.get("openlinker-invocation-proof"), expectedProof);
      return jsonResponse({
        run_id: ids.child,
        status: "running",
        dispatch_state: "pending",
      }, { status: 202 });
    },
  });

  const summary = await runtime.callRuntimeAgent(invocation, {
    targetAgentId: ids.target,
    input: { q: "hello", nonce: changing as unknown as JsonValue },
    metadata: { trace: "sdk" },
    reason: "need data",
  }, {
    headers: {
      authorization: "Bearer option-must-not-win",
      "idempotency-key": "option-must-not-win",
      "openlinker-invocation-proof": "option-must-not-win",
      [RuntimeAttachmentHeader]: "option-must-not-leak",
    },
  });
  assert.deepEqual(summary, {
    runId: ids.child,
    status: "running",
    dispatchState: "pending",
  });
});

test("Runtime commands and cancel ACK are session-bound and strictly typed", async () => {
  const calls: string[] = [];
  const runtime = runtimeWithFetch(async (input, init) => {
    const request = init ?? {};
    const url = new URL(String(input));
    const headers = new Headers(request.headers);
    if (url.pathname === "/api/v1/agent-runtime/sessions") {
      assert.equal(headers.get(RuntimeAttachmentHeader), null);
      return jsonResponse(wireReady());
    }
    calls.push(url.pathname);
    assert.equal(headers.get("authorization"), "Bearer ol_agent_v2");
    assert.equal(headers.get(RuntimeAttachmentHeader), ids.attachment);
    if (url.pathname === "/api/v1/agent-runtime/commands") {
      assert.equal(request.method, "GET");
      assert.equal(url.searchParams.get("runtime_session_id"), ids.session);
      assert.equal(url.searchParams.get("wait"), "17");
      assert.equal(headers.has("content-type"), false);
      return jsonResponse({
        commands: [
          {
            type: RuntimeMessageTypes.runCancel,
            payload: {
              cancellation_id: ids.cancellation,
              attempt_identity: wireIdentity(),
              reason_code: "OWNER_CANCEL_REQUESTED",
              deadline_at: later,
            },
          },
          {
            type: RuntimeMessageTypes.drain,
            payload: {
              deadline_at: later,
              reason_code: "DEPLOY",
              capacity: 0,
              inflight: 4000,
            },
          },
          {
            type: RuntimeMessageTypes.leaseRevoked,
            payload: {
              attempt_identity: wireIdentity(),
              reason_code: "LEASE_LOST",
              dispatch_state: "terminal",
              run_status: "canceled",
            },
          },
        ],
        database_time: now,
      });
    }
    assert.equal(url.pathname, `/api/v1/agent-runtime/runs/${ids.run}/cancel-ack`);
    assert.equal(request.method, "POST");
    const requestBody = request.body;
    if (typeof requestBody !== "string") {
      assert.fail("Runtime cancel ACK body must be a JSON string");
    }
    const body = JSON.parse(requestBody);
    assert.deepEqual(body, {
      cancellation_id: ids.cancellation,
      attempt_identity: wireIdentity(),
      cancel_state: "unsupported",
      error_code: "CANCEL_NOT_SUPPORTED",
    });
    return jsonResponse({
      cancellation_id: ids.cancellation,
      cancel_state: "unsupported",
      updated_at: now,
      error_code: "CANCEL_NOT_SUPPORTED",
    });
  });

  await runtime.createRuntimeSession(runtimeHello());
  const commands = await runtime.pollRuntimeCommands(ids.session, 17);
  assert.equal(commands.databaseTime, now);
  assert.equal(commands.commands.length, 3);
  const [cancelCommand, drainCommand, revokedCommand] = commands.commands;
  assert.ok(cancelCommand);
  assert.ok(drainCommand);
  assert.ok(revokedCommand);
  assert.equal(cancelCommand.type, RuntimeMessageTypes.runCancel);
  assert.equal(drainCommand.type, RuntimeMessageTypes.drain);
  assert.equal(revokedCommand.type, RuntimeMessageTypes.leaseRevoked);
  assert.equal(cancelCommand.payload.cancellationId, ids.cancellation);
  assert.equal(drainCommand.payload.capacity, 0);
  assert.equal(revokedCommand.payload.runStatus, "canceled");

  const state = await runtime.ackRuntimeCancel({
    cancellationId: ids.cancellation,
    attemptIdentity: runtimeIdentity(),
    cancelState: "unsupported",
    errorCode: "CANCEL_NOT_SUPPORTED",
  });
  assert.deepEqual(state, {
    cancellationId: ids.cancellation,
    cancelState: "unsupported",
    updatedAt: now,
    errorCode: "CANCEL_NOT_SUPPORTED",
  });
  assert.deepEqual(calls, [
    "/api/v1/agent-runtime/commands",
    `/api/v1/agent-runtime/runs/${ids.run}/cancel-ack`,
  ]);
});

test("commands and cancel ACK reject malformed unions, UUIDs, and state mismatches", async () => {
  let calls = 0;
  const responses = [
    jsonResponse({
      commands: [{
        type: "run.cancel",
        payload: {
          cancellation_id: ids.cancellation,
          attempt_identity: { ...wireIdentity(), runtime_session_id: ids.otherSession },
          reason_code: "OWNER_CANCEL_REQUESTED",
          deadline_at: later,
        },
      }],
      database_time: now,
    }),
    jsonResponse({
      commands: [{
        type: "run.cancel",
        payload: {
          cancellation_id: ids.cancellation,
          attempt_identity: wireIdentity(),
          reason_code: "OWNER_CANCEL_REQUESTED",
          deadline_at: later,
          unexpected: true,
        },
      }],
      database_time: now,
    }),
    jsonResponse({
      cancellation_id: ids.otherCancellation,
      cancel_state: "stopped",
      updated_at: now,
    }),
    jsonResponse({
      cancellation_id: ids.cancellation,
      cancel_state: "failed",
      updated_at: now,
      error_code: "STOP_FAILED",
    }),
  ];
  const runtime = runtimeWithFetch(async (input) => {
    if (new URL(String(input)).pathname === "/api/v1/agent-runtime/sessions") {
      return jsonResponse(wireReady());
    }
    calls++;
    const response = responses.shift();
    assert.ok(response);
    return response;
  });

  await runtime.createRuntimeSession(runtimeHello());
  await assert.rejects(() => runtime.pollRuntimeCommands("not-a-uuid", 0), /canonical lowercase UUID/);
  await assert.rejects(() => runtime.pollRuntimeCommands(ids.session, 31), /waitSeconds/);
  assert.equal(calls, 0);
  await assert.rejects(() => runtime.pollRuntimeCommands(ids.session, 0), /Session identity mismatch/);
  await assert.rejects(() => runtime.pollRuntimeCommands(ids.session, 0), /unknown field unexpected/);
  await assert.rejects(
    () => runtime.ackRuntimeCancel({
      cancellationId: ids.cancellation,
      attemptIdentity: runtimeIdentity(),
      cancelState: "stopped",
    }),
    /identity mismatch/,
  );
  await assert.rejects(
    () => runtime.ackRuntimeCancel({
      cancellationId: ids.cancellation,
      attemptIdentity: runtimeIdentity(),
      cancelState: "stopped",
    }),
    /does not correlate/,
  );
  await assert.rejects(
    () => runtime.ackRuntimeCancel({
      cancellationId: ids.cancellation,
      attemptIdentity: runtimeIdentity(),
      cancelState: "failed",
    }),
    /errorCode is required/,
  );
  assert.equal(calls, 4, "invalid local ACK must not reach Core");
});

test("delegated calls reject invalid authority, statuses, summaries, and strict errors", async () => {
  let calls = 0;
  const responses = [
    jsonResponse({ run_id: ids.child, status: "running", dispatch_state: "pending" }, { status: 200 }),
    jsonResponse({ run_id: ids.child, status: "success", dispatch_state: "terminal" }, { status: 202 }),
    jsonResponse({ run_id: ids.child, status: "running", dispatch_state: "pending" }, { status: 201 }),
    jsonResponse({ run_id: ids.child, status: "success", dispatch_state: "pending" }, { status: 200 }),
    jsonResponse({
      error: { code: "BAD_REQUEST", message: "bad", retryable: false, unexpected: true },
    }, { status: 400 }),
    new Response(new Uint8Array(RuntimeMaxMessageBytes + 1), { status: 400 }),
  ];
  const runtime = runtimeWithFetch(async () => {
    calls++;
    const response = responses.shift();
    assert.ok(response);
    return response;
  }, {
    authorization: "Bearer ordinary-agent-token-must-not-win",
  });
  const request = { targetAgentId: ids.target, input: {} };

  await assert.rejects(
    () => runtime.callRuntimeAgent({ ...invocation, token: "ordinary-agent-token" }, request),
    /authorization is invalid/,
  );
  await assert.rejects(
    () => runtime.callRuntimeAgent({ ...invocation, idempotencyKey: " delegation-42 " }, request),
    /surrounding whitespace/,
  );
  assert.equal(calls, 0);
  await assert.rejects(() => runtime.callRuntimeAgent(invocation, request), /status does not match/);
  await assert.rejects(() => runtime.callRuntimeAgent(invocation, request), /status does not match/);
  await assert.rejects(() => runtime.callRuntimeAgent(invocation, request), /must return 200 or 202/);
  await assert.rejects(() => runtime.callRuntimeAgent(invocation, request), /incoherent terminal state/);
  await assert.rejects(() => runtime.callRuntimeAgent(invocation, request), /unknown field unexpected/);
  await assert.rejects(() => runtime.callRuntimeAgent(invocation, request), /exceeds 4 MiB/);
  assert.equal(calls, 6);
});

test("delegated call rejects an oversized request before transport", async () => {
  let calls = 0;
  const runtime = runtimeWithFetch(async () => {
    calls++;
    return jsonResponse({});
  });
  await assert.rejects(
    () => runtime.callRuntimeAgent(invocation, {
      targetAgentId: ids.target,
      input: { value: "x".repeat(RuntimeMaxMessageBytes) },
    }),
    /exceeds 4 MiB/,
  );
  assert.equal(calls, 0);
});

function runtimeWithFetch(fetch: FetchLike, headers?: HeadersInit): OpenLinkerRuntime {
  return new OpenLinkerRuntime({
    baseUrl: "https://core.example.com",
    agentToken: "ol_agent_v2",
    headers,
    fetch,
  });
}

function runtimeHello(): RuntimeHelloPayload {
  return {
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-a",
    runtimeSessionId: ids.session,
    sessionEpoch: 1,
    nodeVersion: "test-node/1",
    capacity: 1,
    features: [...RuntimeRequiredFeatures],
    contractDigest: RuntimeContractDigest,
  };
}

function wireReady() {
  return {
    core_instance_id: ids.core,
    attachment_id: ids.attachment,
    features: [...RuntimeRequiredFeatures],
    offer_ttl_seconds: 30,
    lease_ttl_seconds: 60,
    database_time: now,
  };
}

function runtimeIdentity(): RuntimeAttemptIdentity {
  return {
    runId: ids.run,
    attemptId: ids.attempt,
    leaseId: ids.lease,
    fencingToken: 1,
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-a",
    runtimeSessionId: ids.session,
  };
}

function wireIdentity() {
  return {
    run_id: ids.run,
    attempt_id: ids.attempt,
    lease_id: ids.lease,
    fencing_token: 1,
    node_id: ids.node,
    agent_id: ids.agent,
    worker_id: "worker-a",
    runtime_session_id: ids.session,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}
