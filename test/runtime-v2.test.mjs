import test from "node:test";
import assert from "node:assert/strict";

import {
  RuntimeContractDigest as RootRuntimeContractDigest,
  RuntimeV2MessageTypes as RootRuntimeV2MessageTypes,
} from "../dist/index.js";
import {
  OpenLinkerError,
  OpenLinkerRuntime,
  RuntimeContractDigest,
  RuntimeRequiredFeatures,
  RuntimeV2AssignmentRejectReasons,
  RuntimeV2MaxMessageBytes,
  RuntimeV2MessageTypes,
  RuntimeV2ResumeActions,
  RuntimeV2ResumeDecisions,
} from "../dist/runtime.js";

const ids = Object.freeze({
  node: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  session: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
  attempt: "55555555-5555-4555-8555-555555555555",
  lease: "66666666-6666-4666-8666-666666666666",
  event: "77777777-7777-4777-8777-777777777777",
  result: "88888888-8888-4888-8888-888888888888",
  core: "99999999-9999-4999-8999-999999999999",
  cancellation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
});

const now = "2026-07-11T13:00:00.123Z";
const later = "2026-07-11T13:01:00.123Z";

test("runtime v2 types and constants are exported from both SDK entries", () => {
  assert.equal(RootRuntimeContractDigest, RuntimeContractDigest);
  assert.equal(RootRuntimeV2MessageTypes.assignmentAck, "run.assignment.ack");
  assert.equal(RuntimeV2MessageTypes.resume, "runtime.resume");
  assert.equal(RuntimeV2ResumeDecisions.uploadSpoolOnly, "upload_spool_only");
});

test("runtime v2 HTTP flow keeps claim and assignment ACK separate", async () => {
  const calls = [];
  let claimCalls = 0;
  const runtime = new OpenLinkerRuntime({
    baseUrl: "https://core.example.com/api/v1",
    agentToken: async () => "ol_agent_v2",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ url, init, body });
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer ol_agent_v2");
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(init.method, "POST");

      switch (url.pathname) {
        case "/api/v1/agent-runtime/v2/sessions":
        case `/api/v1/agent-runtime/v2/sessions/${ids.session}/heartbeat`:
          return jsonResponse({
            core_instance_id: ids.core,
            features: [...RuntimeRequiredFeatures],
            offer_ttl_seconds: 30,
            lease_ttl_seconds: 60,
            database_time: now,
          });
        case "/api/v1/agent-runtime/v2/runs/claim":
          assert.equal(url.searchParams.get("wait"), "12");
          claimCalls++;
          if (claimCalls === 1) {
            return new Response(null, { status: 204 });
          }
          return jsonResponse(wireAssignment());
        case `/api/v1/agent-runtime/v2/runs/${ids.run}/assignment-ack`:
          return jsonResponse({
            attempt_identity: body.attempt_identity,
            attempt_no: 1,
            lease_expires_at: later,
          });
        case `/api/v1/agent-runtime/v2/runs/${ids.run}/assignment-reject`:
          return jsonResponse({
            attempt_identity: body.attempt_identity,
            outcome: "offer_rejected",
            dispatch_state: "pending",
          });
        case `/api/v1/agent-runtime/v2/runs/${ids.run}/lease-renew`:
          return jsonResponse({
            attempt_identity: body.attempt_identity,
            lease_expires_at: later,
            pending_command: {
              type: "run.cancel",
              payload: {
                cancellation_id: ids.cancellation,
                attempt_identity: body.attempt_identity,
                reason_code: "USER_REQUESTED",
                deadline_at: later,
              },
            },
          });
        case `/api/v1/agent-runtime/v2/runs/${ids.run}/events`:
          return jsonResponse({
            client_event_id: body.client_event_id,
            client_event_seq: body.client_event_seq,
            sequence: 4,
            replayed: false,
          });
        case `/api/v1/agent-runtime/v2/runs/${ids.run}/result`:
          return jsonResponse({
            result_id: body.result_id,
            classification: "success",
            run_status: "success",
            dispatch_state: "terminal",
            replayed: false,
          });
        case "/api/v1/agent-runtime/v2/runs/resume":
          return jsonResponse({
            decisions: body.attempts.map((attempt) => ({
              attempt_identity: attempt.attempt_identity,
              decision: "continue_execution",
              lease_expires_at: later,
              allowed_actions: ["continue_execution", "upload_events", "upload_result"],
            })),
          });
        case `/api/v1/agent-runtime/v2/sessions/${ids.session}/close`:
          return new Response(null, { status: 204 });
        default:
          return jsonResponse({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
      }
    },
  });

  const hello = runtimeHello();
  const ready = await runtime.createRuntimeV2Session(hello);
  assert.equal(ready.coreInstanceId, ids.core);
  assert.equal(ready.databaseTime, now);
  await runtime.heartbeatRuntimeV2Session(hello);

  const claim = { runtimeSessionId: ids.session, capacity: 2, inflight: 0 };
  assert.equal(await runtime.claimRuntimeV2Run(12, claim), undefined);
  const assigned = await runtime.claimRuntimeV2Run(12, claim);
  assert.ok(assigned);
  assert.equal(assigned.attemptIdentity.runId, ids.run);
  assert.deepEqual(assigned.input, { prompt: "hello" });

  // Claim is only an offer. Execution permission is returned by this explicit
  // assignment ACK and cannot be synthesized by a legacy claim loop.
  const confirmed = await runtime.ackRuntimeV2Assignment({
    attemptIdentity: assigned.attemptIdentity,
  });
  assert.equal(confirmed.attemptNo, 1);

  const rejected = await runtime.rejectRuntimeV2Assignment({
    attemptIdentity: assigned.attemptIdentity,
    reasonCode: RuntimeV2AssignmentRejectReasons.nodeAtCapacity,
    capacity: 2,
    inflight: 2,
  });
  assert.equal(rejected.outcome, "offer_rejected");

  const renewed = await runtime.renewRuntimeV2Lease({
    attemptIdentity: assigned.attemptIdentity,
    lastClientEventSeq: 0,
    capacity: 2,
    inflight: 1,
  });
  assert.equal(renewed.pendingCommand?.type, "run.cancel");
  assert.equal(renewed.pendingCommand?.payload.cancellationId, ids.cancellation);

  const eventAck = await runtime.appendRuntimeV2Event({
    attemptIdentity: assigned.attemptIdentity,
    clientEventId: ids.event,
    clientEventSeq: 1,
    eventType: "run.progress",
    payload: { percent: 50 },
  });
  assert.equal(eventAck.sequence, 4);

  const resultAck = await runtime.finalizeRuntimeV2Result({
    attemptIdentity: assigned.attemptIdentity,
    resultId: ids.result,
    status: "success",
    output: { answer: "ok" },
    durationMs: 10,
    finalClientEventSeq: 1,
  });
  assert.equal(resultAck.resultId, ids.result);

  const resumed = await runtime.resumeRuntimeV2Runs({
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-a",
    runtimeSessionId: ids.session,
    attempts: [{
      attemptIdentity: assigned.attemptIdentity,
      lastAckedClientEventSeq: 1,
      pendingClientEventRanges: [],
    }],
  });
  assert.equal(resumed.decisions[0].decision, RuntimeV2ResumeDecisions.continueExecution);
  assert.deepEqual(resumed.decisions[0].allowedActions, [
    RuntimeV2ResumeActions.continueExecution,
    RuntimeV2ResumeActions.uploadEvents,
    RuntimeV2ResumeActions.uploadResult,
  ]);

  await runtime.closeRuntimeV2Session({
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-a",
    runtimeSessionId: ids.session,
    sessionEpoch: 1,
    status: "offline",
    reason: "process restart",
  });

  assert.equal(calls.length, 11);
  assert.deepEqual(calls[0].body, {
    node_id: ids.node,
    agent_id: ids.agent,
    worker_id: "worker-a",
    runtime_session_id: ids.session,
    session_epoch: 1,
    node_version: "0.2.0",
    capacity: 2,
    features: [...RuntimeRequiredFeatures],
    contract_digest: RuntimeContractDigest,
  });
  const eventCall = calls.find((call) => call.url.pathname.endsWith("/events"));
  assert.equal(eventCall.body.client_event_id, ids.event);
  const resultCall = calls.find((call) => call.url.pathname.endsWith("/result"));
  assert.equal(resultCall.body.result_id, ids.result);
});

test("runtime v2 validates stable identities, contract, capacity, and request shape locally", async () => {
  let calls = 0;
  const runtime = runtimeWithFetch(async () => {
    calls++;
    return jsonResponse({});
  });

  await assert.rejects(
    () => runtime.createRuntimeV2Session({ ...runtimeHello(), nodeId: ids.cancellation.toUpperCase() }),
    /canonical lowercase UUID/,
  );
  await assert.rejects(
    () => runtime.createRuntimeV2Session({ ...runtimeHello(), contractDigest: "0".repeat(64) }),
    /packaged contract/,
  );
  await assert.rejects(
    () => runtime.createRuntimeV2Session({
      ...runtimeHello(),
      features: RuntimeRequiredFeatures.filter((feature) => feature !== "persistent_spool"),
    }),
    /missing required feature persistent_spool/,
  );
  await assert.rejects(
    () => runtime.createRuntimeV2Session({ ...runtimeHello(), capacity: 1025 }),
    /capacity/,
  );
  await assert.rejects(
    () => runtime.appendRuntimeV2Event({
      attemptIdentity: runtimeIdentity(),
      clientEventId: "event-from-clock",
      clientEventSeq: 1,
      eventType: "run.progress",
      payload: {},
    }),
    /canonical lowercase UUID/,
  );
  await assert.rejects(
    () => runtime.finalizeRuntimeV2Result({
      attemptIdentity: runtimeIdentity(),
      resultId: "result-from-clock",
      status: "success",
      output: {},
      durationMs: 0,
      finalClientEventSeq: 0,
    }),
    /canonical lowercase UUID/,
  );
  await assert.rejects(
    () => runtime.appendRuntimeV2Event({
      attemptIdentity: runtimeIdentity(),
      clientEventId: ids.event,
      clientEventSeq: 1,
      eventType: "run.progress",
      payload: {},
      unexpected: true,
    }),
    /unknown field unexpected/,
  );
  await assert.rejects(
    () => runtime.claimRuntimeV2Run(31, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    /waitSeconds/,
  );
  assert.equal(calls, 0, "invalid v2 requests must not reach Core");
});

test("runtime v2 rejects unknown, oversized, and identity-mismatched responses", async () => {
  const responses = [
    jsonResponse({
      core_instance_id: ids.core,
      features: [...RuntimeRequiredFeatures],
      offer_ttl_seconds: 30,
      lease_ttl_seconds: 60,
      database_time: now,
      unexpected: true,
    }),
    jsonResponse({
      ...wireAssignment(),
      attempt_identity: { ...wireIdentity(), unexpected: true },
    }),
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(RuntimeV2MaxMessageBytes + 1),
      },
    }),
    jsonResponse({
      attempt_identity: { ...wireIdentity(), attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      attempt_no: 1,
      lease_expires_at: later,
    }),
  ];
  const runtime = runtimeWithFetch(async () => responses.shift());

  await assert.rejects(() => runtime.createRuntimeV2Session(runtimeHello()), /unknown field unexpected/);
  await assert.rejects(
    () => runtime.claimRuntimeV2Run(0, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    /attempt_identity contains unknown field unexpected/,
  );
  await assert.rejects(() => runtime.createRuntimeV2Session(runtimeHello()), /exceeds 4 MiB/);
  await assert.rejects(
    () => runtime.ackRuntimeV2Assignment({ attemptIdentity: runtimeIdentity() }),
    /identity mismatch/,
  );
});

test("runtime v2 parses strict error envelopes with the existing runtime auth", async () => {
  const runtime = runtimeWithFetch(async (_input, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer ol_agent_v2");
    return jsonResponse({
      error: {
        code: "STALE_LEASE",
        message: "lease is stale",
        retryable: false,
        current_run_status: "running",
        current_dispatch_state: "executing",
      },
    }, { status: 409, headers: { "x-request-id": "req-v2" } });
  });

  await assert.rejects(
    () => runtime.ackRuntimeV2Assignment({ attemptIdentity: runtimeIdentity() }),
    (error) => {
      assert.ok(error instanceof OpenLinkerError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "STALE_LEASE");
      assert.equal(error.requestId, "req-v2");
      assert.equal(error.details.currentRunStatus, "running");
      return true;
    },
  );
});

function runtimeWithFetch(fetch) {
  return new OpenLinkerRuntime({
    baseUrl: "https://core.example.com",
    agentToken: "ol_agent_v2",
    fetch,
  });
}

function runtimeHello() {
  return {
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-a",
    runtimeSessionId: ids.session,
    sessionEpoch: 1,
    nodeVersion: "0.2.0",
    capacity: 2,
    features: [...RuntimeRequiredFeatures],
    contractDigest: RuntimeContractDigest,
  };
}

function runtimeIdentity() {
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

function wireAssignment() {
  return {
    attempt_identity: wireIdentity(),
    offer_no: 1,
    offer_expires_at: later,
    attempt_deadline_at: "2026-07-11T13:30:00.123Z",
    run_deadline_at: "2026-07-11T14:00:00.123Z",
    input: { prompt: "hello" },
    metadata: { trace: "trace-a" },
    node_envelope: "ol_ctx_v2.current.payload.signature",
    agent_invocation_token: "ol_inv_v2.current.payload.signature",
  };
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}
