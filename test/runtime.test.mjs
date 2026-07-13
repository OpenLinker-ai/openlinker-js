import test from "node:test";
import assert from "node:assert/strict";

import * as RootSDK from "../dist/index.js";
import {
  OpenLinkerError,
  OpenLinkerRuntime,
  RuntimeAttachmentHeader,
  RuntimeContractDigest,
  RuntimeRequiredFeatures,
  RuntimeAssignmentRejectReasons,
  RuntimeMaxMessageBytes,
  RuntimeMessageTypes,
  RuntimeResumeActions,
  RuntimeResumeDecisions,
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
  attachment: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
});

const now = "2026-07-11T13:00:00.123Z";
const later = "2026-07-11T13:01:00.123Z";

test("Runtime types and constants are server-only", () => {
  assert.equal("RuntimeContractDigest" in RootSDK, false);
  assert.equal("RuntimeMessageTypes" in RootSDK, false);
  assert.equal(RuntimeMessageTypes.resume, "runtime.resume");
  assert.equal(RuntimeResumeDecisions.uploadSpoolOnly, "upload_spool_only");
});

test("Runtime HTTP flow keeps claim and assignment ACK separate", async () => {
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
      assert.equal(
        headers.get(RuntimeAttachmentHeader),
        url.pathname === "/api/v1/agent-runtime/sessions" ? null : ids.attachment,
      );

      switch (url.pathname) {
        case "/api/v1/agent-runtime/sessions":
        case `/api/v1/agent-runtime/sessions/${ids.session}/heartbeat`:
          return jsonResponse({
            core_instance_id: ids.core,
            attachment_id: ids.attachment,
            features: [...RuntimeRequiredFeatures],
            offer_ttl_seconds: 30,
            lease_ttl_seconds: 60,
            database_time: now,
          });
        case "/api/v1/agent-runtime/runs/claim":
          assert.equal(url.searchParams.get("wait"), "12");
          claimCalls++;
          if (claimCalls === 1) {
            return new Response(null, { status: 204 });
          }
          return jsonResponse(wireAssignment());
        case `/api/v1/agent-runtime/runs/${ids.run}/assignment-ack`:
          return jsonResponse({
            attempt_identity: body.attempt_identity,
            attempt_no: 1,
            lease_expires_at: later,
          });
        case `/api/v1/agent-runtime/runs/${ids.run}/assignment-reject`:
          return jsonResponse({
            attempt_identity: body.attempt_identity,
            outcome: "offer_rejected",
            dispatch_state: "pending",
          });
        case `/api/v1/agent-runtime/runs/${ids.run}/lease-renew`:
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
        case `/api/v1/agent-runtime/runs/${ids.run}/events`:
          return jsonResponse({
            client_event_id: body.client_event_id,
            client_event_seq: body.client_event_seq,
            sequence: 4,
            replayed: false,
          });
        case `/api/v1/agent-runtime/runs/${ids.run}/result`:
          return jsonResponse({
            result_id: body.result_id,
            classification: "success",
            run_status: "success",
            dispatch_state: "terminal",
            replayed: false,
          });
        case "/api/v1/agent-runtime/runs/resume":
          return jsonResponse({
            decisions: body.attempts.map((attempt) => ({
              attempt_identity: attempt.attempt_identity,
              decision: "continue_execution",
              lease_expires_at: later,
              allowed_actions: ["continue_execution", "upload_events", "upload_result"],
            })),
          });
        case `/api/v1/agent-runtime/sessions/${ids.session}/close`:
          return new Response(null, { status: 204 });
        default:
          return jsonResponse({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
      }
    },
  });

  const hello = runtimeHello();
  const ready = await runtime.createRuntimeSession(hello);
  assert.equal(ready.coreInstanceId, ids.core);
  assert.equal(ready.attachmentId, ids.attachment);
  assert.equal(ready.databaseTime, now);
  assert.equal(runtime.runtimeAttachmentId, ids.attachment);
  await runtime.heartbeatRuntimeSession(hello);

  const claim = { runtimeSessionId: ids.session, capacity: 2, inflight: 0 };
  assert.equal(await runtime.claimRuntimeRun(12, claim), undefined);
  const assigned = await runtime.claimRuntimeRun(12, claim);
  assert.ok(assigned);
  assert.equal(assigned.attemptIdentity.runId, ids.run);
  assert.deepEqual(assigned.input, { prompt: "hello" });

  // Claim is only an offer. Execution permission is returned by this explicit
  // assignment ACK and cannot be synthesized by a legacy claim loop.
  const confirmed = await runtime.ackRuntimeAssignment({
    attemptIdentity: assigned.attemptIdentity,
  });
  assert.equal(confirmed.attemptNo, 1);

  const rejected = await runtime.rejectRuntimeAssignment({
    attemptIdentity: assigned.attemptIdentity,
    reasonCode: RuntimeAssignmentRejectReasons.nodeAtCapacity,
    capacity: 2,
    inflight: 2,
  });
  assert.equal(rejected.outcome, "offer_rejected");

  const renewed = await runtime.renewRuntimeLease({
    attemptIdentity: assigned.attemptIdentity,
    lastClientEventSeq: 0,
    capacity: 2,
    inflight: 1,
  });
  assert.equal(renewed.pendingCommand?.type, "run.cancel");
  assert.equal(renewed.pendingCommand?.payload.cancellationId, ids.cancellation);

  const eventAck = await runtime.appendRuntimeEvent({
    attemptIdentity: assigned.attemptIdentity,
    clientEventId: ids.event,
    clientEventSeq: 1,
    eventType: "run.progress",
    payload: { percent: 50 },
  });
  assert.equal(eventAck.sequence, 4);

  const resultAck = await runtime.finalizeRuntimeResult({
    attemptIdentity: assigned.attemptIdentity,
    resultId: ids.result,
    status: "success",
    output: { answer: "ok" },
    durationMs: 10,
    finalClientEventSeq: 1,
  });
  assert.equal(resultAck.resultId, ids.result);

  const resumed = await runtime.resumeRuntimeRuns({
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
  assert.equal(resumed.decisions[0].decision, RuntimeResumeDecisions.continueExecution);
  assert.deepEqual(resumed.decisions[0].allowedActions, [
    RuntimeResumeActions.continueExecution,
    RuntimeResumeActions.uploadEvents,
    RuntimeResumeActions.uploadResult,
  ]);

  await runtime.closeRuntimeSession({
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-a",
    runtimeSessionId: ids.session,
    sessionEpoch: 1,
    status: "offline",
    reason: "process restart",
  });
  assert.equal(runtime.runtimeAttachmentId, undefined);

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
  assert.deepEqual(calls[1].body, calls[0].body);
  const eventCall = calls.find((call) => call.url.pathname.endsWith("/events"));
  assert.equal(eventCall.body.client_event_id, ids.event);
  const resultCall = calls.find((call) => call.url.pathname.endsWith("/result"));
  assert.equal(resultCall.body.result_id, ids.result);
  assert.deepEqual(calls.at(-1).body, {
    node_id: ids.node,
    agent_id: ids.agent,
    worker_id: "worker-a",
    runtime_session_id: ids.session,
    session_epoch: 1,
    status: "offline",
    reason: "process restart",
  });
});

test("Runtime session close requires an empty 204 response", async () => {
  let calls = 0;
  const runtime = runtimeWithFetch(async () => {
    calls += 1;
    return calls === 1 ? jsonResponse(wireReady()) : jsonResponse({}, { status: 200 });
  });
  await runtime.createRuntimeSession(runtimeHello());
  await assert.rejects(
    () => runtime.closeRuntimeSession({
      nodeId: ids.node,
      agentId: ids.agent,
      workerId: "worker-a",
      runtimeSessionId: ids.session,
      sessionEpoch: 1,
      status: "closed",
      reason: "operator shutdown",
    }),
    /session close must return 204/,
  );
});

test("Runtime owns Pull attachment headers and rejects a stale generation response", async () => {
  const nextAttachment = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let createCalls = 0;
  let claimCalls = 0;
  let releaseStaleClaim;
  let markStaleClaimStarted;
  const staleClaimGate = new Promise((resolve) => {
    releaseStaleClaim = resolve;
  });
  const staleClaimStarted = new Promise((resolve) => {
    markStaleClaimStarted = resolve;
  });
  const seen = [];
  const runtime = new OpenLinkerRuntime({
    baseUrl: "https://core.example.com",
    agentToken: "ol_agent_v2",
    headers: { [RuntimeAttachmentHeader]: "constructor-spoof" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const attachment = new Headers(init.headers).get(RuntimeAttachmentHeader);
      seen.push({ path: url.pathname, attachment });
      if (url.pathname === "/api/v1/agent-runtime/sessions") {
        createCalls += 1;
        assert.equal(attachment, null, "Session create must never carry an old attachment");
        return jsonResponse(wireReady(createCalls === 1 ? ids.attachment : nextAttachment));
      }
      assert.equal(url.pathname, "/api/v1/agent-runtime/runs/claim");
      claimCalls += 1;
      if (claimCalls === 1) {
        assert.equal(attachment, ids.attachment);
        markStaleClaimStarted();
        await staleClaimGate;
        return jsonResponse(wireAssignment());
      }
      assert.equal(attachment, nextAttachment);
      return new Response(null, { status: 204 });
    },
  });

  await assert.rejects(
    () => runtime.claimRuntimeRun(0, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    /requires an active Pull attachment/,
  );
  await runtime.createRuntimeSession(runtimeHello(), {
    headers: { [RuntimeAttachmentHeader]: "request-spoof" },
  });
  const staleClaim = runtime.claimRuntimeRun(
    0,
    { runtimeSessionId: ids.session, capacity: 1, inflight: 0 },
    { headers: { [RuntimeAttachmentHeader]: "request-spoof" } },
  );
  await staleClaimStarted;
  await runtime.createRuntimeSession(runtimeHello());
  assert.equal(runtime.runtimeAttachmentId, nextAttachment);
  releaseStaleClaim();
  await assert.rejects(staleClaim, /response belongs to a stale attachment/);
  assert.equal(
    await runtime.claimRuntimeRun(0, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    undefined,
  );
  assert.deepEqual(seen.map((call) => call.attachment), [null, ids.attachment, null, nextAttachment]);
});

test("Runtime heartbeat cannot silently replace the Pull attachment", async () => {
  const unexpectedAttachment = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const runtime = runtimeWithFetch(async (input, init) => {
    const url = new URL(String(input));
    const attachment = new Headers(init.headers).get(RuntimeAttachmentHeader);
    if (url.pathname === "/api/v1/agent-runtime/sessions") {
      assert.equal(attachment, null);
      return jsonResponse(wireReady());
    }
    if (url.pathname.endsWith("/heartbeat")) {
      assert.equal(attachment, ids.attachment);
      return jsonResponse(wireReady(unexpectedAttachment));
    }
    assert.equal(attachment, ids.attachment);
    return new Response(null, { status: 204 });
  });

  await runtime.createRuntimeSession(runtimeHello());
  await assert.rejects(
    () => runtime.heartbeatRuntimeSession(runtimeHello()),
    /heartbeat changed the attachment identity/,
  );
  assert.equal(runtime.runtimeAttachmentId, ids.attachment);
  assert.equal(
    await runtime.claimRuntimeRun(0, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    undefined,
  );
});

test("Runtime suppresses a stale attachment error response after reattach", async () => {
  const nextAttachment = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  let createCalls = 0;
  let releaseClaim;
  let markClaimStarted;
  const claimGate = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  const claimStarted = new Promise((resolve) => {
    markClaimStarted = resolve;
  });
  const runtime = runtimeWithFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/agent-runtime/sessions") {
      createCalls += 1;
      return jsonResponse(wireReady(createCalls === 1 ? ids.attachment : nextAttachment));
    }
    markClaimStarted();
    await claimGate;
    return jsonResponse({
      error: {
        code: "RUNTIME_SESSION_CONFLICT",
        message: "old attachment was fenced",
        retryable: false,
      },
    }, { status: 409 });
  });

  await runtime.createRuntimeSession(runtimeHello());
  const staleClaim = runtime.claimRuntimeRun(
    0,
    { runtimeSessionId: ids.session, capacity: 1, inflight: 0 },
  );
  await claimStarted;
  await runtime.createRuntimeSession(runtimeHello());
  releaseClaim();
  await assert.rejects(staleClaim, (error) => {
    assert.equal(error instanceof OpenLinkerError, false);
    assert.match(error.message, /response belongs to a stale attachment/);
    return true;
  });
});

test("Runtime validates stable identities, contract, capacity, and request shape locally", async () => {
  let calls = 0;
  const runtime = runtimeWithFetch(async () => {
    calls++;
    return jsonResponse({});
  });

  await assert.rejects(
    () => runtime.createRuntimeSession({ ...runtimeHello(), nodeId: ids.cancellation.toUpperCase() }),
    /canonical lowercase UUID/,
  );
  await assert.rejects(
    () => runtime.createRuntimeSession({ ...runtimeHello(), contractDigest: "0".repeat(64) }),
    /packaged contract/,
  );
  await assert.rejects(
    () => runtime.createRuntimeSession({
      ...runtimeHello(),
      features: RuntimeRequiredFeatures.filter((feature) => feature !== "persistent_spool"),
    }),
    /missing required feature persistent_spool/,
  );
  await assert.rejects(
    () => runtime.createRuntimeSession({ ...runtimeHello(), capacity: 1025 }),
    /capacity/,
  );
  await assert.rejects(
    () => runtime.appendRuntimeEvent({
      attemptIdentity: runtimeIdentity(),
      clientEventId: "event-from-clock",
      clientEventSeq: 1,
      eventType: "run.progress",
      payload: {},
    }),
    /canonical lowercase UUID/,
  );
  await assert.rejects(
    () => runtime.finalizeRuntimeResult({
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
    () => runtime.appendRuntimeEvent({
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
    () => runtime.claimRuntimeRun(31, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    /waitSeconds/,
  );
  assert.equal(calls, 0, "invalid Runtime requests must not reach Core");
});

test("Runtime rejects unknown, oversized, and identity-mismatched responses", async () => {
  const responses = [
    jsonResponse({
      core_instance_id: ids.core,
      attachment_id: ids.attachment,
      features: [...RuntimeRequiredFeatures],
      offer_ttl_seconds: 30,
      lease_ttl_seconds: 60,
      database_time: now,
      unexpected: true,
    }),
    jsonResponse(wireReady()),
    jsonResponse({
      ...wireAssignment(),
      attempt_identity: { ...wireIdentity(), unexpected: true },
    }),
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(RuntimeMaxMessageBytes + 1),
      },
    }),
    jsonResponse({
      attempt_identity: { ...wireIdentity(), attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      attempt_no: 1,
      lease_expires_at: later,
    }),
  ];
  const runtime = runtimeWithFetch(async () => responses.shift());

  await assert.rejects(() => runtime.createRuntimeSession(runtimeHello()), /unknown field unexpected/);
  await runtime.createRuntimeSession(runtimeHello());
  await assert.rejects(
    () => runtime.claimRuntimeRun(0, { runtimeSessionId: ids.session, capacity: 1, inflight: 0 }),
    /attempt_identity contains unknown field unexpected/,
  );
  await assert.rejects(() => runtime.createRuntimeSession(runtimeHello()), /exceeds 4 MiB/);
  await assert.rejects(
    () => runtime.ackRuntimeAssignment({ attemptIdentity: runtimeIdentity() }),
    /identity mismatch/,
  );
});

test("Runtime parses strict error envelopes with the existing runtime auth", async () => {
  const runtime = runtimeWithFetch(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer ol_agent_v2");
    if (url.pathname === "/api/v1/agent-runtime/sessions") {
      assert.equal(headers.get(RuntimeAttachmentHeader), null);
      return jsonResponse(wireReady());
    }
    assert.equal(headers.get(RuntimeAttachmentHeader), ids.attachment);
    return jsonResponse({
      error: {
        code: "STALE_LEASE",
        message: "lease is stale",
        retryable: false,
        current_run_status: "running",
        current_dispatch_state: "executing",
      },
    }, { status: 409, headers: { "x-request-id": "req-runtime" } });
  });

  await runtime.createRuntimeSession(runtimeHello());
  await assert.rejects(
    () => runtime.ackRuntimeAssignment({ attemptIdentity: runtimeIdentity() }),
    (error) => {
      assert.ok(error instanceof OpenLinkerError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "STALE_LEASE");
      assert.equal(error.requestId, "req-runtime");
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

function wireReady(attachmentId = ids.attachment) {
  return {
    core_instance_id: ids.core,
    attachment_id: attachmentId,
    features: [...RuntimeRequiredFeatures],
    offer_ttl_seconds: 30,
    lease_ttl_seconds: 60,
    database_time: now,
  };
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}
