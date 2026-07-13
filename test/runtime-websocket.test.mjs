import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimeContractDigest,
  RuntimeRequiredFeatures,
  RuntimeWebSocketSession,
} from "../dist/runtime.js";

const ids = {
  node: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  session: "33333333-3333-4333-8333-333333333333",
  core: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  attempt: "66666666-6666-4666-8666-666666666666",
  lease: "77777777-7777-4777-8777-777777777777",
  event: "88888888-8888-4888-8888-888888888888",
  result: "99999999-9999-4999-8999-999999999999",
  cancellation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const now = "2026-07-12T00:00:00Z";
const later = "2026-07-12T00:01:00Z";

function hello() {
  return {
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-1",
    runtimeSessionId: ids.session,
    sessionEpoch: 1,
    nodeVersion: "test-node/1",
    capacity: 2,
    features: RuntimeRequiredFeatures,
    contractDigest: RuntimeContractDigest,
  };
}

function identity(overrides = {}) {
  return {
    run_id: ids.run,
    attempt_id: ids.attempt,
    lease_id: ids.lease,
    fencing_token: 1,
    node_id: ids.node,
    agent_id: ids.agent,
    worker_id: "worker-1",
    runtime_session_id: ids.session,
    ...overrides,
  };
}

function envelope(type, payload, { messageId = crypto.randomUUID(), replyTo } = {}) {
  return {
    protocol_version: 2,
    runtime_contract_id: "openlinker.runtime.v2",
    message_id: messageId,
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    type,
    sent_at: now,
    payload,
  };
}

class FakeSocket {
  readyState = 1;
  onmessage = null;
  onclose = null;
  onerror = null;
  sent = [];
  closes = [];
  onSend = () => {};

  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    this.onSend(message);
  }

  close(code = 1000, reason = "") {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function readyPayload() {
  return {
    core_instance_id: ids.core,
    features: [...RuntimeRequiredFeatures],
    offer_ttl_seconds: 15,
    lease_ttl_seconds: 30,
    database_time: now,
  };
}

async function startSession(socket, options = {}) {
  socket.onSend = (message) => {
    if (message.type === "runtime.hello") {
      socket.receive(envelope("runtime.ready", readyPayload(), { replyTo: message.message_id }));
    }
  };
  const session = new RuntimeWebSocketSession(socket, options);
  const ready = await session.start(hello());
  assert.equal(ready.coreInstanceId, ids.core);
  return session;
}

test("Runtime WebSocket waits for correlated assignment confirmation before execution", async () => {
  const socket = new FakeSocket();
  let assigned;
  const session = await startSession(socket, {
    onAssigned(value) {
      assigned = value;
    },
  });

  const assignmentMessageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  socket.receive(envelope("run.assigned", {
    attempt_identity: identity(),
    offer_no: 1,
    offer_expires_at: later,
    attempt_deadline_at: later,
    run_deadline_at: later,
    input: { task: "test" },
    metadata: { source: "test" },
    node_envelope: "ol_ctx_v2.current.payload.signature",
    agent_invocation_token: "ol_invoke_v2_payload_signature",
  }, { messageId: assignmentMessageId }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(assigned.attemptIdentity.attemptId, ids.attempt);

  socket.onSend = (message) => {
    if (message.type !== "run.assignment.ack") return;
    assert.equal(message.reply_to_message_id, assignmentMessageId);
    socket.receive(envelope("run.assignment.confirmed", {
      attempt_identity: identity(),
      attempt_no: 1,
      lease_expires_at: later,
    }, { replyTo: message.message_id }));
  };

  const confirmed = await session.ackAssignment({ attemptIdentity: assigned.attemptIdentity });
  assert.equal(confirmed.attemptNo, 1);
  assert.equal(confirmed.attemptIdentity.fencingToken, 1);
});

test("Runtime WebSocket correlates Event/Result ACKs and reorders multi-Resume decisions", async () => {
  const socket = new FakeSocket();
  const session = await startSession(socket);
  const camelIdentity = {
    runId: ids.run,
    attemptId: ids.attempt,
    leaseId: ids.lease,
    fencingToken: 1,
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-1",
    runtimeSessionId: ids.session,
  };

  const second = {
    ...camelIdentity,
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    leaseId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    fencingToken: 2,
  };
  const secondWire = identity({
    run_id: second.runId,
    attempt_id: second.attemptId,
    lease_id: second.leaseId,
    fencing_token: second.fencingToken,
  });

  socket.onSend = (message) => {
    if (message.type === "run.event") {
      socket.receive(envelope("run.event.ack", {
        client_event_id: ids.event,
        client_event_seq: 1,
        sequence: 9,
        replayed: false,
      }, { replyTo: message.message_id }));
    }
    if (message.type === "run.result") {
      socket.receive(envelope("run.result.ack", {
        result_id: ids.result,
        classification: "success",
        run_status: "success",
        dispatch_state: "terminal",
        replayed: false,
      }, { replyTo: message.message_id }));
    }
    if (message.type === "runtime.resume") {
      socket.receive(envelope("run.resume.accepted", {
        attempt_identity: secondWire,
        decision: "upload_spool_only",
        allowed_actions: ["upload_events"],
      }, { replyTo: message.message_id }));
      socket.receive(envelope("run.resume.accepted", {
        attempt_identity: identity(),
        decision: "continue_execution",
        lease_expires_at: later,
        allowed_actions: ["continue_execution", "upload_events", "upload_result"],
      }, { replyTo: message.message_id }));
    }
  };

  const eventAck = await session.appendEvent({
    attemptIdentity: camelIdentity,
    clientEventId: ids.event,
    clientEventSeq: 1,
    eventType: "run.progress",
    payload: { percent: 50 },
  });
  assert.equal(eventAck.sequence, 9);

  const resultAck = await session.finalizeResult({
    attemptIdentity: camelIdentity,
    resultId: ids.result,
    status: "success",
    output: { answer: "done" },
    durationMs: 10,
    finalClientEventSeq: 1,
  });
  assert.equal(resultAck.runStatus, "success");

  const decisions = await session.resume({
    nodeId: ids.node,
    agentId: ids.agent,
    workerId: "worker-1",
    runtimeSessionId: ids.session,
    attempts: [
      { attemptIdentity: camelIdentity, lastAckedClientEventSeq: 1, pendingClientEventRanges: [] },
      { attemptIdentity: second, lastAckedClientEventSeq: 0, pendingClientEventRanges: [{ start: 1, end: 1 }] },
    ],
  });
  assert.equal(decisions[0].attemptIdentity.runId, ids.run);
  assert.equal(decisions[1].attemptIdentity.runId, second.runId);
});

test("Runtime WebSocket delivers cancellation with exact reply correlation", async () => {
  const socket = new FakeSocket();
  let command;
  const session = await startSession(socket, {
    onCommand(value) {
      command = value;
    },
  });
  const cancelMessageId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  socket.receive(envelope("run.cancel", {
    cancellation_id: ids.cancellation,
    attempt_identity: identity(),
    reason_code: "USER_REQUESTED",
    deadline_at: later,
  }, { messageId: cancelMessageId }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(command.type, "run.cancel");

  session.ackCancel({
    cancellationId: ids.cancellation,
    attemptIdentity: command.payload.attemptIdentity,
    cancelState: "stopping",
  });
  const sent = socket.sent.at(-1);
  assert.equal(sent.type, "run.cancel.ack");
  assert.equal(sent.reply_to_message_id, cancelMessageId);
});

test("Runtime WebSocket rejects pending requests on close and closes malformed protocol frames", async () => {
  const socket = new FakeSocket();
  const session = await startSession(socket, { requestTimeoutMs: 5_000 });
  socket.onSend = () => {};
  const pending = session.renewLease({
    attemptIdentity: {
      runId: ids.run,
      attemptId: ids.attempt,
      leaseId: ids.lease,
      fencingToken: 1,
      nodeId: ids.node,
      agentId: ids.agent,
      workerId: "worker-1",
      runtimeSessionId: ids.session,
    },
    lastClientEventSeq: 0,
    capacity: 1,
    inflight: 1,
  });
  socket.close(1006, "network lost");
  await assert.rejects(pending, /network lost/);

  const malformedSocket = new FakeSocket();
  await startSession(malformedSocket);
  malformedSocket.receive({ unexpected: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(malformedSocket.closes.at(-1).code, 1002);
});
