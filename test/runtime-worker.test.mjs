import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FileRuntimeStore,
  MemoryRuntimeStore,
  OpenLinkerError,
  RuntimeDrainTimeoutError,
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
  attachment: "88888888-8888-4888-8888-888888888888",
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
      assert.equal(
        "createdAt" in event,
        false,
        "local Store metadata crossed the Runtime transport boundary",
      );
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

test("RuntimeWorker renews a finished Attempt until its durable spool is ACKed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-finished-lease-"));
  const store = new FileRuntimeStore(dataDir);
  let hello;
  let claimed = false;
  let handlerCalls = 0;
  let renewCalls = 0;
  let eventCalls = 0;
  let resultCalls = 0;

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
    async renewRuntimeLease(request) {
      renewCalls += 1;
      assert.equal(request.inflight, 1, "finished Attempt stopped occupying Runtime capacity");
      return {
        attemptIdentity: request.attemptIdentity,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async appendRuntimeEvent(event) {
      eventCalls += 1;
      if (eventCalls === 1 || renewCalls < 1) throw new Error("temporary Event upload outage");
      return {
        clientEventId: event.clientEventId,
        clientEventSeq: event.clientEventSeq,
        sequence: event.clientEventSeq,
        replayed: eventCalls > 1,
      };
    },
    async finalizeRuntimeResult(result) {
      resultCalls += 1;
      if (resultCalls === 1 || renewCalls < 3) throw new Error("temporary Result upload outage");
      return {
        resultId: result.resultId,
        classification: "success",
        runStatus: "success",
        dispatchState: "terminal",
        replayed: resultCalls > 1,
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
    store,
    retryMinimumMs: 1,
    retryMaximumMs: 5,
    heartbeatIntervalMs: 250,
    handler: async (run) => {
      handlerCalls += 1;
      await run.emit("run.progress", { durable: true });
      return { output: { complete: true } };
    },
  }, {
    connectTransport: async () => fakeTransport(client),
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  t.after(async () => {
    try {
      await worker.stop();
      await running;
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  await waitFor(() => worker.transportState === "pull_active");
  await waitFor(async () => {
    const assignment = await store.getAssignment(ids.attempt);
    return assignment?.state === "finished" && Boolean(await store.getPendingResult(ids.attempt));
  });
  await waitFor(() => renewCalls >= 3 && resultCalls > 1);
  assert.equal(handlerCalls, 1);
  assert.ok(eventCalls > 1, "durable Event was not retried through the outage");
  assert.ok(resultCalls > 1, "durable Result was not retried through the outage");
  assert.ok(renewCalls >= 3, "finished Attempt lease stopped before the spool was ACKed");
  await waitFor(async () => (await store.snapshot()).assignments.length === 0);
});

test("RuntimeWorker shutdown retains a finished spool without waiting for Core ACK", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-finished-shutdown-"));
  const store = new FileRuntimeStore(dataDir);
  let hello;
  let claimed = false;
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
    async appendRuntimeEvent() {
      throw new Error("Core Event upload remains unavailable");
    },
  });
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store,
    retryMinimumMs: 1,
    retryMaximumMs: 5,
    shutdownTimeoutMs: 100,
    handler: async (run) => {
      await run.emit("run.progress", { durable: true });
      return { output: { complete: true } };
    },
  }, {
    connectTransport: async () => fakeTransport(client),
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  t.after(async () => {
    try {
      await worker.stop();
      await running;
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  await waitFor(() => worker.transportState === "pull_active");
  await waitFor(async () => (await store.getAssignment(ids.attempt))?.state === "finished");
  let shutdownTimer;
  await Promise.race([
    worker.stop(),
    new Promise((_, reject) => {
      shutdownTimer = setTimeout(
        () => reject(new Error("shutdown waited for Core spool ACK")),
        1_000,
      );
    }),
  ]).finally(() => clearTimeout(shutdownTimer));
  await running;

  const reopened = new FileRuntimeStore(dataDir);
  await reopened.open();
  try {
    const snapshot = await reopened.snapshot();
    assert.equal(snapshot.assignments.length, 1);
    assert.equal(snapshot.assignments[0].state, "finished");
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.results.length, 1);
  } finally {
    await reopened.close();
  }
});

test("RuntimeWorker drain waits for the active handler and durable spool ACK before stopping", async () => {
  const store = new MemoryRuntimeStore();
  const handlerStarted = deferred();
  const handlerGate = deferred();
  const handlerResumed = deferred();
  const handlerEventPersisted = deferred();
  const resultUploadStarted = deferred();
  const resultAckGate = deferred();
  const serverDrainStarted = deferred();
  const serverDrainAckGate = deferred();
  let hello;
  let claimed = false;
  let drainSettled = false;
  let drainedRuntimeSessionId;
  let serverDrainRequest;
  let serverDrainCalls = 0;
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
    async drainRuntimeSession(runtimeSessionId, request) {
      serverDrainCalls += 1;
      drainedRuntimeSessionId = runtimeSessionId;
      serverDrainRequest = request;
      serverDrainStarted.resolve();
      if (serverDrainCalls === 1) {
        await serverDrainAckGate.promise;
        return { ...request, reasonCode: "FIRST_WRITER_REASON", inflight: 1 };
      }
      return { ...request, reasonCode: "FIRST_WRITER_REASON", inflight: 0 };
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
      resultUploadStarted.resolve();
      await resultAckGate.promise;
      return {
        resultId: result.resultId,
        classification: "success",
        runStatus: "success",
        dispatchState: "terminal",
        replayed: false,
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
    store,
    allowUnsafeMemoryStore: true,
    retryMinimumMs: 1,
    retryMaximumMs: 5,
    heartbeatIntervalMs: 10_000,
    handler: async (run) => {
      handlerStarted.resolve();
      await handlerGate.promise;
      handlerResumed.resolve();
      await run.emit("run.progress", { durable: true });
      handlerEventPersisted.resolve();
      return { output: { complete: true } };
    },
  }, {
    connectTransport: async () => fakeTransport(client),
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  await handlerStarted.promise;
  const draining = worker.drain({ timeoutMs: 2_000, reasonCode: "DEPLOYMENT" }).finally(() => {
    drainSettled = true;
  });
  await serverDrainStarted.promise;
  assert.equal(drainedRuntimeSessionId, hello.runtimeSessionId);
  assert.equal(serverDrainRequest.reasonCode, "DEPLOYMENT");
  assert.equal(serverDrainRequest.capacity, 0);
  assert.equal(serverDrainRequest.inflight, 1);
  await delay(20);
  assert.equal(drainSettled, false, "drain returned before Core committed the drain fence");

  serverDrainAckGate.resolve();
  await delay(20);
  assert.equal(drainSettled, false, "drain returned before the handler completed");

  handlerGate.resolve();
  await handlerResumed.promise;
  await handlerEventPersisted.promise;
  await resultUploadStarted.promise;
  await delay(20);
  assert.equal(drainSettled, false, "drain returned before Core ACKed the durable Result");

  resultAckGate.resolve();
  await draining;
  await running;
  assert.equal(serverDrainCalls, 2, "drain did not re-check authoritative Core inflight");
  assert.equal(worker.transportState, "stopped");
});

test("RuntimeWorker drain times out explicitly and preserves the unacknowledged spool", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-drain-timeout-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new FileRuntimeStore(dataDir);
  let hello;
  let claimed = false;
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
    async appendRuntimeEvent() {
      throw new Error("Core Event ACK remains unavailable");
    },
  });
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store,
    retryMinimumMs: 1,
    retryMaximumMs: 5,
    heartbeatIntervalMs: 10_000,
    shutdownTimeoutMs: 100,
    handler: async (run) => {
      await run.emit("run.progress", { durable: true });
      return { output: { complete: true } };
    },
  }, {
    connectTransport: async () => fakeTransport(client),
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "pull_active");
  await waitFor(async () => (await store.getAssignment(ids.attempt))?.state === "finished");
  const firstIdentity = worker.identity;
  await assert.rejects(worker.drain({ timeoutMs: 100 }), (error) => {
    assert.ok(error instanceof RuntimeDrainTimeoutError);
    assert.equal(error.code, "RUNTIME_DRAIN_TIMEOUT");
    assert.equal(error.timeoutMs, 100);
    assert.deepEqual(error.spool, {
      assignments: 1,
      events: 1,
      results: 1,
      empty: false,
    });
    return true;
  });
  await running;

  const reopened = new FileRuntimeStore(dataDir);
  await reopened.open();
  let retainedEventId;
  let retainedResultId;
  try {
    assert.deepEqual(await reopened.spoolStatus(), {
      assignments: 1,
      events: 1,
      results: 1,
      empty: false,
    });
    const snapshot = await reopened.snapshot();
    retainedEventId = snapshot.events[0].clientEventId;
    retainedResultId = snapshot.results[0].payload.resultId;
  } finally {
    await reopened.close();
  }

  const replayedEventIds = [];
  const replayedResultIds = [];
  let recoveryHandlerCalls = 0;
  const recoveryClient = fakeClient({
    async appendRuntimeEvent(event) {
      replayedEventIds.push(event.clientEventId);
      return {
        clientEventId: event.clientEventId,
        clientEventSeq: event.clientEventSeq,
        sequence: event.clientEventSeq,
        replayed: true,
      };
    },
    async finalizeRuntimeResult(result) {
      replayedResultIds.push(result.resultId);
      return {
        resultId: result.resultId,
        classification: "success",
        runStatus: "success",
        dispatchState: "terminal",
        replayed: true,
      };
    },
  });
  const recovery = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    dataDir,
    retryMinimumMs: 1,
    retryMaximumMs: 5,
    heartbeatIntervalMs: 10_000,
    handler: async () => {
      recoveryHandlerCalls += 1;
      return { output: {} };
    },
  }, {
    connectTransport: async () => fakeTransport(recoveryClient),
  });

  const recoveryRunning = recovery.start();
  await waitFor(() => recovery.transportState === "pull_active");
  await waitFor(() => replayedEventIds.length === 1 && replayedResultIds.length === 1);
  await recovery.drain({ timeoutMs: 1_000 });
  await recoveryRunning;
  assert.deepEqual(replayedEventIds, [retainedEventId]);
  assert.deepEqual(replayedResultIds, [retainedResultId]);
  assert.equal(recoveryHandlerCalls, 0, "recovery re-entered an already finished handler");
  assert.equal(recovery.identity.workerId, firstIdentity.workerId);
  assert.equal(recovery.identity.sessionEpoch, firstIdentity.sessionEpoch + 1);
});

test("RuntimeWorker client drain rejects a WebSocket offer delivered after the committed ACK", async () => {
  const drainRequested = deferred();
  const drainAck = deferred();
  const offerRejected = deferred();
  const socketDone = deferred();
  let callbacks;
  let hello;
  let request;
  let serverDrainCalls = 0;
  let drainSettled = false;
  const transport = {
    http: fakeClient(),
    async dialWebSocket(value, handlers) {
      hello = value;
      callbacks = handlers;
      const duplex = fakeDuplex(socketDone.promise);
      duplex.requestDrain = async (payload) => {
        serverDrainCalls += 1;
        request = payload;
        drainRequested.resolve();
        if (serverDrainCalls === 1) return drainAck.promise;
        return { ...payload, reasonCode: "FIRST_WRITER_REASON", inflight: 0 };
      };
      duplex.rejectAssignment = async (identity, reasonCode) => {
        offerRejected.resolve(reasonCode);
        return { attemptIdentity: identity, outcome: "offer_rejected", dispatchState: "pending" };
      };
      duplex.close = () => socketDone.resolve();
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
    handler: async () => {
      assert.fail("a post-drain offer must never enter the handler");
    },
  }, {
    connectTransport: async () => transport,
    randomUUID: () => ids.result,
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "ws_active");
  const draining = worker.drain({ timeoutMs: 2_000, reasonCode: "DEPLOYMENT" }).finally(() => {
    drainSettled = true;
  });
  await drainRequested.promise;
  assert.ok(Number.isFinite(Date.parse(request.deadlineAt)));
  assert.deepEqual(request, {
    deadlineAt: request.deadlineAt,
    reasonCode: "DEPLOYMENT",
    capacity: 0,
    inflight: 0,
  });
  assert.equal(drainSettled, false);

  // Resolve the server ACK first, then synchronously deliver a raced offer
  // before the drain continuation can inspect the local queues.
  drainAck.resolve({ ...request, reasonCode: "FIRST_WRITER_REASON", inflight: 1 });
  callbacks.onAssigned(assignmentFor(hello));
  assert.equal(await offerRejected.promise, "NODE_DRAINING");
  await draining;
  await running;
  assert.equal(serverDrainCalls, 2, "drain did not re-check Core after rejecting the raced offer");
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
  const dialReasons = [];
  const pullReasons = [];
  const client = fakeClient({
    async createRuntimeSession(_hello, options) {
      pullSessions += 1;
      pullReasons.push(new Headers(options?.headers).get("openlinker-runtime-fallback-reason"));
      return ready();
    },
  });
  const transport = {
    http: client,
    async dialWebSocket(_hello, _callbacks, _signal, fallbackReason) {
      dials += 1;
      dialReasons.push(fallbackReason);
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
  assert.deepEqual(dialReasons.slice(0, 2), ["policy_forced", "recovery"]);
  assert.equal(pullReasons[0], "websocket_unavailable");

  await worker.stop();
  secondClosed.resolve();
  await running;
});

test("RuntimeWorker retries only WebSocket when discovered policy forbids Pull", async () => {
  const socketDone = deferred();
  let discoveryCalls = 0;
  let dials = 0;
  let pullCalls = 0;
  const client = fakeClient({
    async createRuntimeSession() {
      pullCalls += 1;
      throw new Error("attach-only Core must not receive a Pull Session create");
    },
    async claimRuntimeRun() {
      pullCalls += 1;
      throw new Error("attach-only Core must not receive a Pull claim");
    },
    async pollRuntimeCommands() {
      pullCalls += 1;
      throw new Error("attach-only Core must not receive a Pull command poll");
    },
  });
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    discoverRuntimeConnection: async () => {
      discoveryCalls += 1;
      return {
        runtimeURL: "https://runtime.example",
        policy: {
          allowedTransports: ["ws"],
          defaultTransport: "auto",
          retryMinimumMs: 1,
          retryMaximumMs: 1,
        },
      };
    },
    connectTransport: async () => ({
      http: client,
      async dialWebSocket() {
        dials += 1;
        if (dials < 3) throw new Error("transient WebSocket attach failure");
        return fakeDuplex(socketDone.promise);
      },
      async close() {},
    }),
  });

  const running = worker.start();
  await waitFor(() => dials === 3 && worker.transportState === "ws_active");
  assert.equal(discoveryCalls, 1);
  assert.equal(pullCalls, 0);
  await worker.stop();
  socketDone.resolve();
  await running;
});

test("RuntimeWorker recovers a 403 transport policy signal into WebSocket-only retry", async () => {
  const socketDone = deferred();
  let discoveryCalls = 0;
  let connectCalls = 0;
  let replacementDials = 0;
  let pullCalls = 0;
  const client = fakeClient({
    async createRuntimeSession() {
      pullCalls += 1;
      throw new Error("policy recovery must not enter Pull");
    },
    async claimRuntimeRun() {
      pullCalls += 1;
      throw new Error("policy recovery must not enter Pull");
    },
    async pollRuntimeCommands() {
      pullCalls += 1;
      throw new Error("policy recovery must not enter Pull");
    },
  });
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    discoverRuntimeConnection: async () => {
      discoveryCalls += 1;
      return {
        runtimeURL: `https://runtime-${discoveryCalls}.example`,
        policy: discoveryCalls === 1
          ? { allowedTransports: ["ws", "pull"], defaultTransport: "auto" }
          : {
              allowedTransports: ["ws"],
              defaultTransport: "auto",
              retryMinimumMs: 1,
              retryMaximumMs: 1,
            },
      };
    },
    connectTransport: async () => {
      connectCalls += 1;
      const connection = connectCalls;
      return {
        http: client,
        async dialWebSocket() {
          if (connection === 1) {
            throw new OpenLinkerError("RUNTIME_TRANSPORT_FORBIDDEN", {
              status: 403,
              code: "FORBIDDEN",
            });
          }
          replacementDials += 1;
          if (replacementDials === 1) throw new Error("transient replacement WebSocket failure");
          return fakeDuplex(socketDone.promise);
        },
        async close() {},
      };
    },
  });

  const running = worker.start();
  await waitFor(() => replacementDials === 2 && worker.transportState === "ws_active");
  assert.equal(discoveryCalls, 2);
  assert.equal(connectCalls, 2);
  assert.equal(pullCalls, 0);
  await worker.stop();
  socketDone.resolve();
  await running;
});

test("RuntimeWorker obeys discovered transport order and a fixed server default", async () => {
  for (const policy of [
    { allowedTransports: ["pull", "ws"], defaultTransport: "auto" },
    { allowedTransports: ["ws", "pull"], defaultTransport: "pull" },
  ]) {
    let dials = 0;
    const client = fakeClient();
    const worker = new RuntimeWorker({
      platformURL: "https://openlinker.example",
      transport: "auto",
      nodeId: ids.node,
      agentId: ids.agent,
      agentToken: "ol_agent_private",
      mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
      store: new MemoryRuntimeStore(),
      allowUnsafeMemoryStore: true,
      heartbeatIntervalMs: 10_000,
      handler: async () => ({ output: {} }),
    }, {
      discoverRuntimeConnection: async () => ({
        runtimeURL: "https://runtime.example",
        policy,
      }),
      connectTransport: async () => ({
        http: client,
        async dialWebSocket() {
          dials += 1;
          throw new Error("WebSocket must not be selected");
        },
        async close() {},
      }),
    });

    const running = worker.start();
    await waitFor(() => worker.transportState === "pull_active");
    assert.equal(dials, 0, `policy ${JSON.stringify(policy)} crossed into WebSocket`);
    await worker.stop();
    await running;
  }
});

test("RuntimeWorker applies discovered probe timing over a local preference", async () => {
  let dials = 0;
  const client = fakeClient();
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
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
    discoverRuntimeConnection: async () => ({
      runtimeURL: "https://runtime.example",
      policy: {
        allowedTransports: ["ws", "pull"],
        defaultTransport: "auto",
        websocketProbeIntervalMs: 1_000,
        websocketProbeTimeoutMs: 500,
      },
    }),
    connectTransport: async () => ({
      http: client,
      async dialWebSocket() {
        dials += 1;
        throw new Error("WebSocket unavailable");
      },
      async close() {},
    }),
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "pull_active");
  await delay(250);
  assert.equal(dials, 1, "local probe interval overrode the discovered server policy");
  await worker.stop();
  await running;
});

test("RuntimeWorker drops a late Pull assignment after WebSocket reattach", async () => {
  const socketDone = deferred();
  const claimStarted = deferred();
  const releaseClaim = deferred();
  let hello;
  let dials = 0;
  let handlerCalls = 0;
  const client = fakeClient({
    async createRuntimeSession(value) {
      hello = value;
      return ready();
    },
    async claimRuntimeRun() {
      claimStarted.resolve();
      await releaseClaim.promise;
      return assignmentFor(hello);
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
    websocketProbeIntervalMs: 100,
    heartbeatIntervalMs: 10_000,
    handler: async () => {
      handlerCalls += 1;
      return { output: {} };
    },
  }, {
    connectTransport: async () => ({
      http: client,
      async dialWebSocket() {
        dials += 1;
        if (dials === 1) throw new Error("initial WebSocket unavailable");
        return fakeDuplex(socketDone.promise);
      },
      async close() {},
    }),
  });

  const running = worker.start();
  await claimStarted.promise;
  await waitFor(() => worker.transportState === "ws_active");
  releaseClaim.resolve();
  await delay(50);
  assert.equal(handlerCalls, 0);
  await worker.stop();
  socketDone.resolve();
  await running;
});

test("RuntimeWorker keeps HTTP Pull lifecycle calls out of an active WebSocket attachment", async () => {
  const socketDone = deferred();
  let sessionCreates = 0;
  let heartbeats = 0;
  let sessionCloses = 0;
  const client = fakeClient({
    async createRuntimeSession() {
      sessionCreates += 1;
      return ready();
    },
    async heartbeatRuntimeSession() {
      heartbeats += 1;
      return ready();
    },
    async closeRuntimeSession() {
      sessionCloses += 1;
    },
  });
  const worker = new RuntimeWorker({
    runtimeURL: "https://runtime.example",
    transport: "ws",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 250,
    handler: async () => ({ output: {} }),
  }, {
    connectTransport: async () => ({
      http: client,
      async dialWebSocket() { return fakeDuplex(socketDone.promise); },
      async close() {},
    }),
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "ws_active");
  await delay(300);
  await worker.stop();
  socketDone.resolve();
  await running;
  assert.deepEqual({ sessionCreates, heartbeats, sessionCloses }, {
    sessionCreates: 0,
    heartbeats: 0,
    sessionCloses: 0,
  });
});

test("RuntimeWorker stops forced Pull while claim and command polls are in flight", async () => {
  const claimStarted = deferred();
  const commandStarted = deferred();
  let sessionCloses = 0;
  const client = fakeClient({
    async claimRuntimeRun(_wait, _request, options) {
      claimStarted.resolve();
      await delay(60_000, options?.signal);
      return undefined;
    },
    async pollRuntimeCommands(_session, _wait, options) {
      commandStarted.resolve();
      await delay(60_000, options?.signal);
      return { commands: [], databaseTime: new Date().toISOString() };
    },
    async closeRuntimeSession() {
      sessionCloses += 1;
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
    heartbeatIntervalMs: 250,
    handler: async () => ({ output: {} }),
  }, {
    connectTransport: async () => fakeTransport(client),
  });

  const running = worker.start();
  await Promise.all([claimStarted.promise, commandStarted.promise]);
  await Promise.race([
    worker.stop(),
    delay(1_000).then(() => assert.fail("forced Pull shutdown was blocked by long polls")),
  ]);
  await running;
  assert.equal(sessionCloses, 1);
  assert.equal(worker.transportState, "stopped");
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

test("RuntimeWorker coalesces concurrent policy signals into one canonical rediscovery", async () => {
  const store = new MemoryRuntimeStore();
  const entered = deferred();
  const release = deferred();
  let failingCalls = 0;
  let replacementCalls = 0;
  let discoveryCalls = 0;
  let connectCalls = 0;
  const attachmentReasons = [];
  const signal = () => new OpenLinkerError("RUNTIME_POLICY_CHANGED", {
    status: 403,
    code: "FORBIDDEN",
  });
  const failTogether = async () => {
    failingCalls += 1;
    if (failingCalls === 2) entered.resolve();
    await release.promise;
    throw signal();
  };
  const initial = fakeClient({
    async createRuntimeSession(_hello, options) {
      attachmentReasons.push(new Headers(options?.headers).get("openlinker-runtime-fallback-reason"));
      return ready();
    },
    claimRuntimeRun: failTogether,
    pollRuntimeCommands: failTogether,
  });
  const replacement = fakeClient({
    async createRuntimeSession(_hello, options) {
      attachmentReasons.push(new Headers(options?.headers).get("openlinker-runtime-fallback-reason"));
      return ready();
    },
    async claimRuntimeRun(_wait, _request, options) {
      replacementCalls += 1;
      await delay(5, options?.signal);
      return undefined;
    },
    async pollRuntimeCommands(_session, _wait, options) {
      replacementCalls += 1;
      await delay(5, options?.signal);
      return { commands: [], databaseTime: new Date().toISOString() };
    },
  });
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store,
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    discoverRuntimeConnection: async () => {
      discoveryCalls += 1;
      return {
        runtimeURL: `https://runtime-${discoveryCalls}.example`,
        policy: { allowedTransports: ["pull"], defaultTransport: "auto" },
      };
    },
    connectTransport: async () => fakeTransport(connectCalls++ === 0 ? initial : replacement),
  });

  const running = worker.start();
  await waitFor(() => worker.transportState === "pull_active");
  const identity = worker.identity;
  await entered.promise;
  release.resolve();
  await waitFor(() => replacementCalls >= 2);
  assert.equal(discoveryCalls, 2, "concurrent failures triggered more than one rediscovery");
  assert.equal(connectCalls, 2);
  assert.deepEqual(worker.identity, identity, "policy recovery replaced durable Session identity");
  assert.deepEqual(attachmentReasons, ["policy_forced", "policy_forced"]);
  await worker.stop();
  await running;
});

test("RuntimeWorker returns a second policy signal without another rediscovery", async () => {
  let discoveryCalls = 0;
  let connectCalls = 0;
  const signal = () => new OpenLinkerError("RUNTIME_TRANSPORT_FORBIDDEN", {
    status: 403,
    code: "FORBIDDEN",
  });
  const initial = fakeClient({ async claimRuntimeRun() { throw signal(); } });
  const replacement = fakeClient({ async claimRuntimeRun() { throw signal(); } });
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
    transport: "pull",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    discoverRuntimeConnection: async () => {
      discoveryCalls += 1;
      return {
        runtimeURL: `https://runtime-${discoveryCalls}.example`,
        policy: { allowedTransports: ["pull"], defaultTransport: "auto" },
      };
    },
    connectTransport: async () => fakeTransport(connectCalls++ === 0 ? initial : replacement),
  });

  let terminalError;
  await assert.rejects(worker.start(), (error) => {
    terminalError = error;
    assert.equal(error.name, "RuntimePolicyRecoveryError");
    assert.equal(
      error.message,
      "OpenLinker Runtime policy recovery failed: policy signal persisted after one canonical rediscovery",
    );
    return true;
  });
  assert.equal(discoveryCalls, 2);
  assert.equal(connectCalls, 2);
  let laterOperationCalls = 0;
  await assert.rejects(worker.policyOperation(async () => {
    laterOperationCalls += 1;
  }), (error) => error === terminalError);
  assert.equal(laterOperationCalls, 0, "terminal policy failure allowed another transport call");
});

test("RuntimeWorker policy recovery fails closed without canonical discovery or with an incompatible explicit transport", async (t) => {
  await t.test("runtimeURL without platformURL", async () => {
    const client = fakeClient({
      async claimRuntimeRun() {
        throw new OpenLinkerError("RUNTIME_POLICY_CHANGED", { status: 403, code: "FORBIDDEN" });
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
      heartbeatIntervalMs: 10_000,
      handler: async () => ({ output: {} }),
    }, { connectTransport: async () => fakeTransport(client) });
    await assert.rejects(worker.start(), /canonical rediscovery requires platformURL/);
  });

  await t.test("explicit transport removed by the allowlist", async () => {
    let discoveryCalls = 0;
    let connectCalls = 0;
    const initial = fakeClient({
      async claimRuntimeRun() {
        throw new OpenLinkerError("RUNTIME_POLICY_CHANGED", { status: 403, code: "FORBIDDEN" });
      },
    });
    const worker = new RuntimeWorker({
      platformURL: "https://openlinker.example",
      transport: "pull",
      nodeId: ids.node,
      agentId: ids.agent,
      agentToken: "ol_agent_private",
      mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
      store: new MemoryRuntimeStore(),
      allowUnsafeMemoryStore: true,
      heartbeatIntervalMs: 10_000,
      handler: async () => ({ output: {} }),
    }, {
      discoverRuntimeConnection: async () => {
        discoveryCalls += 1;
        return {
          runtimeURL: `https://runtime-${discoveryCalls}.example`,
          policy: discoveryCalls === 1
            ? { allowedTransports: ["pull"], defaultTransport: "auto" }
            : { allowedTransports: ["ws"], defaultTransport: "auto" },
        };
      },
      connectTransport: async () => {
        connectCalls += 1;
        return fakeTransport(initial);
      },
    });
    await assert.rejects(worker.start(), /configured Runtime transport pull is not allowed/);
    assert.equal(discoveryCalls, 2);
    assert.equal(connectCalls, 1, "incompatible policy connected before allowlist validation");
  });
});

test("RuntimeWorker rediscovers once on an established WebSocket 1008 policy close", async () => {
  let discoveryCalls = 0;
  let connectCalls = 0;
  const sockets = [];
  const reasons = [];
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    discoverRuntimeConnection: async () => {
      discoveryCalls += 1;
      return {
        runtimeURL: `https://runtime-${discoveryCalls}.example`,
        policy: { allowedTransports: ["ws"], defaultTransport: "auto" },
      };
    },
    connectTransport: async () => {
      connectCalls += 1;
      return {
        http: fakeClient(),
        async dialWebSocket(_hello, callbacks, _signal, fallbackReason) {
          const done = deferred();
          const duplex = fakeDuplex(done.promise);
          sockets.push({ callbacks, done, duplex });
          reasons.push(fallbackReason);
          return duplex;
        },
        async close() {},
      };
    },
  });

  const running = worker.start();
  await waitFor(() => sockets.length === 1 && worker.transportState === "ws_active");
  sockets[0].callbacks.onClose({ code: 1008, reason: "RUNTIME_POLICY_CHANGED", clean: true });
  sockets[0].done.resolve();
  await waitFor(() => sockets.length === 2 && worker.transportState === "ws_active");
  assert.equal(discoveryCalls, 2);
  assert.equal(connectCalls, 2);
  assert.deepEqual(reasons, ["policy_forced", "policy_forced"]);
  await worker.stop();
  await running;
});

test("RuntimeWorker retains a WebSocket policy close delivered before dial settles", async () => {
  let discoveryCalls = 0;
  let dialCalls = 0;
  const worker = new RuntimeWorker({
    platformURL: "https://openlinker.example",
    transport: "auto",
    nodeId: ids.node,
    agentId: ids.agent,
    agentToken: "ol_agent_private",
    mtls: { certFile: "unused.crt", keyFile: "unused.key", caFile: "unused-ca.crt" },
    store: new MemoryRuntimeStore(),
    allowUnsafeMemoryStore: true,
    heartbeatIntervalMs: 10_000,
    handler: async () => ({ output: {} }),
  }, {
    discoverRuntimeConnection: async () => {
      discoveryCalls += 1;
      return {
        runtimeURL: `https://runtime-${discoveryCalls}.example`,
        policy: { allowedTransports: ["ws"], defaultTransport: "auto" },
      };
    },
    connectTransport: async () => ({
      http: fakeClient(),
      async dialWebSocket(_hello, callbacks) {
        dialCalls += 1;
        const done = deferred();
        const duplex = fakeDuplex(done.promise);
        if (dialCalls === 1) {
          callbacks.onClose({ code: 1008, reason: "RUNTIME_POLICY_CHANGED", clean: true });
          done.resolve();
        }
        return duplex;
      },
      async close() {},
    }),
  });

  const running = worker.start();
  await waitFor(() => dialCalls === 2 && worker.transportState === "ws_active");
  assert.equal(discoveryCalls, 2);
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
    async requestDrain(request) { return request; },
    close() {},
  };
}

function fakeClient(overrides = {}) {
  const base = {
    async createRuntimeSession() { return ready(); },
    async heartbeatRuntimeSession() { return ready(); },
    async drainRuntimeSession(_runtimeSessionId, request) { return request; },
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
    attachmentId: ids.attachment,
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
