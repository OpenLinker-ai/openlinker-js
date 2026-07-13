import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FileRuntimeStore,
  MemoryRuntimeStore,
  OpenLinkerError,
  RuntimeRequiredFeatures,
  RuntimeWebSocketError,
  RuntimeWorker,
} from "../dist/runtime.js";

const ids = {
  node: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  core: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
  attempt: "55555555-5555-4555-8555-555555555555",
  lease: "66666666-6666-4666-8666-666666666666",
  result: "77777777-7777-4777-8777-777777777777",
};

test("RuntimeWorker persists before ACK, confirms before handler, and retries stable spool IDs", async () => {
  const store = new MemoryRuntimeStore();
  const ackGate = deferred();
  const secondAckEntered = deferred();
  const finalAcked = deferred();
  let hello;
  let claimed = false;
  let ackCalls = 0;
  let handlerCalls = 0;
  const eventIds = [];
  const resultIds = [];

  const client = fakeClient({
    async createRuntimeSession(value) {
      hello = value;
      return ready();
    },
    async claimRuntimeRun(_wait, _request, options) {
      if (!claimed) {
        claimed = true;
        return assignmentFor(hello);
      }
      await delay(5, options?.signal);
      return undefined;
    },
    async ackRuntimeAssignment(request) {
      ackCalls += 1;
      if (ackCalls === 1) throw new Error("response lost after Core accepted ACK");
      secondAckEntered.resolve();
      await ackGate.promise;
      return {
        attemptIdentity: request.attemptIdentity,
        attemptNo: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async appendRuntimeEvent(event) {
      eventIds.push(event.clientEventId);
      if (eventIds.length === 1) throw new Error("temporary Event upload failure");
      return {
        clientEventId: event.clientEventId,
        clientEventSeq: event.clientEventSeq,
        sequence: event.clientEventSeq,
        replayed: eventIds.length > 2,
      };
    },
    async finalizeRuntimeResult(result) {
      resultIds.push(result.resultId);
      if (resultIds.length === 1) {
        throw new OpenLinkerError("Core needs an exact Event replay", {
          status: 409,
          code: "EVENTS_MISSING",
          details: {
            code: "EVENTS_MISSING",
            message: "missing Event",
            missingEventRanges: [{ start: 1, end: 1 }],
          },
        });
      }
      finalAcked.resolve();
      return {
        resultId: result.resultId,
        classification: "success",
        runStatus: "success",
        dispatchState: "terminal",
        replayed: resultIds.length > 2,
      };
    },
  });
  const transport = fakeTransport(client);
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store,
    allowUnsafeMemoryStore: true,
    retryMinimumMs: 1,
    retryMaximumMs: 1,
    heartbeatIntervalMs: 10_000,
    handler: async (run) => {
      handlerCalls += 1;
      await run.emit("run.progress", { step: 1 });
      return { output: { answer: 42 } };
    },
  }, {
    connectTransport: async () => transport,
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  await secondAckEntered.promise;
  assert.equal(handlerCalls, 0, "handler ran before assignment confirmation");
  const durable = await store.getAssignment(ids.attempt);
  assert.equal(durable.state, "ack_sent", "assignment ACK was not durably journaled first");

  ackGate.resolve();
  await finalAcked.promise;
  await waitFor(() => handlerCalls === 1 && resultIds.length >= 2);
  assert.equal(handlerCalls, 1);
  assert.equal(new Set(eventIds).size, 1, "Event retry changed its durable ID");
  assert.ok(eventIds.length >= 3, "acked Event was not retained for exact missing-range replay");
  assert.equal(new Set(resultIds).size, 1, "Result retry changed its durable ID");
  await waitFor(async () => (await store.snapshot()).assignments.length === 0);

  await worker.stop();
  await running;
  assert.equal(worker.transportState, "stopped");
});

test("RuntimeWorker refuses to re-enter a handler after a persisted started boundary", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-resume-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const seed = new FileRuntimeStore(dataDir);
  await seed.open();
  const previousIdentity = await seed.beginSession();
  const assignment = assignmentFor({
    workerId: previousIdentity.workerId,
    runtimeSessionId: previousIdentity.runtimeSessionId,
  });
  await seed.saveAssignment(assignment);
  await seed.transitionAssignment(ids.attempt, "ack_sent");
  await seed.transitionAssignment(ids.attempt, "confirmed", {
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await seed.transitionAssignment(ids.attempt, "started");
  await seed.close();

  let handlerCalls = 0;
  const client = fakeClient({
    async resumeRuntimeRuns(request) {
      return {
        decisions: request.attempts.map((attempt) => ({
          attemptIdentity: attempt.attemptIdentity,
          decision: "continue_execution",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          allowedActions: ["continue_execution", "upload_events", "upload_result"],
        })),
      };
    },
  });
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new FileRuntimeStore(dataDir),
    handler: async () => {
      handlerCalls += 1;
      return { output: {} };
    },
  }, {
    connectTransport: async () => fakeTransport(client),
  });

  await assert.rejects(
    worker.start(),
    /Unsafe resume refused: a previous process already started this Attempt/,
  );
  assert.equal(handlerCalls, 0);
});

test("RuntimeWorker requires an explicit unsafe flag for MemoryRuntimeStore", () => {
  assert.throws(() => new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    handler: async () => ({ output: {} }),
  }), /allowUnsafeMemoryStore/);
});

test("RuntimeWorker auto transport falls back to pull and probes WebSocket again", async () => {
  const firstClosed = deferred();
  const secondClosed = deferred();
  let dials = 0;
  let pullSessions = 0;
  const client = fakeClient({
    async createRuntimeSession() {
      pullSessions += 1;
      return ready();
    },
  });
  const transport = {
    http: client,
    async dialWebSocket() {
      dials += 1;
      return fakeDuplex(dials === 1 ? firstClosed.promise : secondClosed.promise);
    },
    async close() {},
  };
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    websocketProbeIntervalMs: 100,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    connectTransport: async () => transport,
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "ws_active");
  firstClosed.resolve();
  await waitFor(() => worker.transportState === "pull_active");
  assert.ok(pullSessions >= 1);
  await waitFor(() => dials >= 2 && worker.transportState === "ws_active");

  await worker.stop();
  secondClosed.resolve();
  await running;
});

test("RuntimeWorker reserves capacity across concurrent WebSocket offers", async () => {
  const handlerGate = deferred();
  const socketDone = deferred();
  const rejected = [];
  let handlerCalls = 0;
  const client = fakeClient();
  const transport = {
    http: client,
    async dialWebSocket(hello, callbacks) {
      const duplex = fakeDuplex(socketDone.promise);
      duplex.rejectAssignment = async (identity) => {
        rejected.push(identity.attemptId);
        return { attemptIdentity: identity, outcome: "offer_rejected", dispatchState: "pending" };
      };
      setTimeout(() => {
        callbacks.onAssigned?.(assignmentFor(hello));
        callbacks.onAssigned?.(assignmentFor(hello, {
          runId: "88888888-8888-4888-8888-888888888888",
          attemptId: "99999999-9999-4999-8999-999999999999",
          leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }));
      }, 0);
      return duplex;
    },
    async close() {},
  };
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "ws",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    capacity: 1,
    heartbeatIntervalMs: 10_000,
    handler: async () => {
      handlerCalls += 1;
      await handlerGate.promise;
      return { output: { accepted: true } };
    },
  }, {
    connectTransport: async () => transport,
  });

  const running = worker.start();
  await waitFor(() => handlerCalls === 1 && rejected.length === 1);
  assert.equal(handlerCalls, 1);
  assert.equal(rejected.length, 1);
  handlerGate.resolve();
  await delay(20);
  await worker.stop();
  socketDone.resolve();
  await running;
});

test("RuntimeWorker cancels only the matching Attempt and drain rejects new offers", async () => {
  const socketDone = deferred();
  const handlerStarted = deferred();
  const canceledResult = deferred();
  const drainRejected = deferred();
  const cancelStates = [];
  let callbacks;
  let firstAssignment;
  const transport = {
    http: fakeClient(),
    async dialWebSocket(hello, value) {
      callbacks = value;
      firstAssignment = assignmentFor(hello);
      const duplex = fakeDuplex(socketDone.promise);
      duplex.ackCancel = async (request) => {
        cancelStates.push(request.cancelState);
      };
      duplex.finalizeResult = async (result) => {
        if (result.attemptIdentity.attemptId === ids.attempt) {
          canceledResult.resolve(result);
        }
        return {
          resultId: result.resultId,
          classification: "canceled",
          runStatus: "canceled",
          dispatchState: "terminal",
          replayed: false,
        };
      };
      duplex.rejectAssignment = async (identity, reasonCode) => {
        if (identity.attemptId !== ids.attempt) drainRejected.resolve(reasonCode);
        return { attemptIdentity: identity, outcome: "offer_rejected", dispatchState: "pending" };
      };
      setTimeout(() => value.onAssigned?.(firstAssignment), 0);
      return duplex;
    },
    async close() {},
  };
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "ws",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async (run) => {
      handlerStarted.resolve();
      await new Promise((resolve, reject) => {
        const abort = () => reject(run.signal.reason);
        if (run.signal.aborted) abort();
        else run.signal.addEventListener("abort", abort, { once: true });
      });
      return { output: {} };
    },
  }, {
    connectTransport: async () => transport,
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  await handlerStarted.promise;
  await callbacks.onCommand({
    type: "run.cancel",
    payload: {
      cancellationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attemptIdentity: firstAssignment.attemptIdentity,
      reasonCode: "USER_REQUESTED",
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    },
  });
  const result = await canceledResult.promise;
  assert.equal(result.status, "failed");
  assert.equal(result.error.errorCode, "RUN_CANCELED");
  assert.deepEqual(cancelStates, ["stopping", "stopped"]);

  await callbacks.onCommand({
    type: "runtime.drain",
    payload: {
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      reasonCode: "DEPLOYMENT",
      capacity: 0,
      inflight: 0,
    },
  });
  callbacks.onAssigned?.(assignmentFor({
    workerId: firstAssignment.attemptIdentity.workerId,
    runtimeSessionId: firstAssignment.attemptIdentity.runtimeSessionId,
  }, {
    runId: "88888888-8888-4888-8888-888888888888",
    attemptId: "99999999-9999-4999-8999-999999999999",
    leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }));
  assert.equal(await drainRejected.promise, "NODE_DRAINING");

  await worker.stop();
  socketDone.resolve();
  await running;
});

for (const mode of ["pull", "ws", "auto"]) {
  test(`RuntimeWorker ${mode} retries Session conflict only until Ready`, async () => {
    const socketDone = deferred();
    let sessionCreates = 0;
    let socketDials = 0;
    const client = fakeClient({
      async createRuntimeSession() {
        sessionCreates += 1;
        if (sessionCreates === 1) throw sessionConflict();
        return ready();
      },
    });
    const transport = {
      http: client,
      async dialWebSocket() {
        socketDials += 1;
        if (socketDials === 1) {
          throw new RuntimeWebSocketError(
            "stale Session attachment is still being reaped",
            "RUNTIME_SESSION_CONFLICT",
            true,
            4409,
          );
        }
        return fakeDuplex(socketDone.promise);
      },
      async close() {},
    };
    const worker = new RuntimeWorker({
      runtimeURL: "https://runtime.example",
      transport: mode,
      nodeId: ids.node,
      agentId: ids.agent,
      agentToken: "ol_agent_private",
      mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
      store: new MemoryRuntimeStore(),
      allowUnsafeMemoryStore: true,
      retryMinimumMs: 1,
      retryMaximumMs: 1,
      heartbeatIntervalMs: 10_000,
      handler: async () => ({ output: {} }),
    }, {
      connectTransport: async () => transport,
    });

    const running = worker.start();
    await waitFor(() => worker.transportState === (mode === "pull" ? "pull_active" : "ws_active"));
    if (mode === "pull") {
      assert.equal(sessionCreates, 2);
      assert.equal(socketDials, 0);
    } else {
      assert.equal(socketDials, 2);
      assert.equal(sessionCreates, 0);
    }
    await worker.stop();
    socketDone.resolve();
    await running;
  });
}

test("RuntimeWorker treats Session conflict after Ready as a permanent business error", async () => {
  const client = fakeClient({
    async claimRuntimeRun() {
      throw sessionConflict();
    },
  });
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    retryMinimumMs: 1,
    retryMaximumMs: 1,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    connectTransport: async () => fakeTransport(client),
  });

  await assert.rejects(worker.start(), (error) => {
    assert.equal(error.code, "RUNTIME_SESSION_CONFLICT");
    return true;
  });
});

test("RuntimeWorker auto mode still falls back to Pull for a non-conflict WebSocket failure", async () => {
  let sessionCreates = 0;
  const client = fakeClient({
    async createRuntimeSession() {
      sessionCreates += 1;
      return ready();
    },
  });
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    websocketProbeIntervalMs: 10_000,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    connectTransport: async () => ({
      http: client,
      async dialWebSocket() { throw new Error("WebSocket route unavailable"); },
      async close() {},
    }),
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "pull_active");
  assert.equal(sessionCreates, 1);
  await worker.stop();
  await running;
});

function fakeTransport(http) {
  return {
    http,
    async dialWebSocket() {
      throw new Error("WebSocket not configured in this test");
    },
    async close() {},
  };
}

function fakeDuplex(done) {
  return {
    ready: ready(),
    done,
    async ackAssignment(identity) {
      return {
        attemptIdentity: identity,
        attemptNo: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async rejectAssignment(identity) {
      return { attemptIdentity: identity, outcome: "offer_rejected", dispatchState: "pending" };
    },
    async renewLease(identity) {
      return { attemptIdentity: identity, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    async appendEvent(event) {
      return {
        clientEventId: event.clientEventId,
        clientEventSeq: event.clientEventSeq,
        sequence: event.clientEventSeq,
        replayed: false,
      };
    },
    async finalizeResult(result) {
      return {
        resultId: result.resultId,
        classification: "success",
        runStatus: "success",
        dispatchState: "terminal",
        replayed: false,
      };
    },
    async resume(request) {
      return request.attempts.map((attempt) => ({
        attemptIdentity: attempt.attemptIdentity,
        decision: "upload_spool_only",
        allowedActions: ["upload_events", "upload_result"],
      }));
    },
    async ackCancel() {},
    close() {},
  };
}

function fakeClient(overrides = {}) {
  const base = {
    async createRuntimeSession() { return ready(); },
    async heartbeatRuntimeSession() { return ready(); },
    async closeRuntimeSession() {},
    async claimRuntimeRun(_wait, _request, options) {
      await delay(5, options?.signal);
      return undefined;
    },
    async ackRuntimeAssignment(request) {
      return {
        attemptIdentity: request.attemptIdentity,
        attemptNo: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async rejectRuntimeAssignment(request) {
      return {
        attemptIdentity: request.attemptIdentity,
        outcome: "offer_rejected",
        dispatchState: "pending",
      };
    },
    async renewRuntimeLease(request) {
      return {
        attemptIdentity: request.attemptIdentity,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async appendRuntimeEvent(event) {
      return {
        clientEventId: event.clientEventId,
        clientEventSeq: event.clientEventSeq,
        sequence: event.clientEventSeq,
        replayed: false,
      };
    },
    async finalizeRuntimeResult(result) {
      return {
        resultId: result.resultId,
        classification: result.status === "success" ? "success" : "non_retryable_failure",
        runStatus: result.status === "success" ? "success" : "failed",
        dispatchState: "terminal",
        replayed: false,
      };
    },
    async resumeRuntimeRuns(request) {
      return {
        decisions: request.attempts.map((attempt) => ({
          attemptIdentity: attempt.attemptIdentity,
          decision: "upload_spool_only",
          allowedActions: ["upload_events", "upload_result"],
        })),
      };
    },
    async pollRuntimeCommands(_session, _wait, options) {
      await delay(5, options?.signal);
      return { commands: [], databaseTime: new Date().toISOString() };
    },
    async ackRuntimeCancel(request) {
      return {
        cancellationId: request.cancellationId,
        cancelState: request.cancelState,
        updatedAt: new Date().toISOString(),
      };
    },
    async callRuntimeAgent() {
      return { runId: ids.run, status: "running", dispatchState: "executing" };
    },
  };
  return Object.assign(base, overrides);
}

function ready() {
  return {
    coreInstanceId: ids.core,
    features: [...RuntimeRequiredFeatures],
    offerTtlSeconds: 30,
    leaseTtlSeconds: 60,
    databaseTime: new Date().toISOString(),
  };
}

function sessionConflict() {
  return new OpenLinkerError("Runtime Session is attached elsewhere", {
    status: 409,
    code: "RUNTIME_SESSION_CONFLICT",
    details: { code: "RUNTIME_SESSION_CONFLICT", message: "conflict" },
  });
}

function assignmentFor(hello, identityOverrides = {}) {
  const now = Date.now();
  return {
    attemptIdentity: {
      runId: ids.run,
      attemptId: ids.attempt,
      leaseId: ids.lease,
      fencingToken: 1,
      nodeId: ids.node,
      agentId: ids.agent,
      workerId: hello.workerId,
      runtimeSessionId: hello.runtimeSessionId,
      ...identityOverrides,
    },
    offerNo: 1,
    offerExpiresAt: new Date(now + 30_000).toISOString(),
    attemptDeadlineAt: new Date(now + 60_000).toISOString(),
    runDeadlineAt: new Date(now + 120_000).toISOString(),
    input: { prompt: "hello" },
    metadata: { source: "worker-test" },
    nodeEnvelope: "ol_ctx_v2.private",
    agentInvocationToken: "ol_inv_v2.private",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail("timed out waiting for Runtime Worker state");
}
