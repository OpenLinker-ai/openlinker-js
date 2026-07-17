import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FileRuntimeStore,
  RuntimeStoreError,
} from "../dist/runtime.js";

const ids = {
  node: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  attempt: "44444444-4444-4444-8444-444444444444",
  lease: "55555555-5555-4555-8555-555555555555",
  result: "66666666-6666-4666-8666-666666666666",
};

test("FileRuntimeStore encrypts durable work and advances stable Session identity", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const store = new FileRuntimeStore(dataDir, { reserveBytes: 0 });
  await store.open();
  const first = await store.beginSession();
  const assignment = assigned(first, { privatePrompt: "do not expose this" });
  await store.saveAssignment(assignment);
  assert.deepEqual(await store.spoolStatus(), {
    assignments: 1,
    events: 0,
    results: 0,
    empty: false,
  });
  assert.equal((await store.getAssignment(ids.attempt)).state, "received");
  await store.transitionAssignment(ids.attempt, "ack_sent");
  await store.transitionAssignment(ids.attempt, "confirmed", {
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await store.transitionAssignment(ids.attempt, "started");

  const event = await store.appendEvent(
    assignment.attemptIdentity,
    "run.progress",
    { privateDelta: "also encrypted" },
  );
  assert.equal(event.clientEventSeq, 1);
  assert.equal((await store.listPendingEvents(ids.attempt)).length, 1);
  await store.ackEvent(ids.attempt, event.clientEventId, event.clientEventSeq);
  assert.equal((await store.listPendingEvents(ids.attempt)).length, 0);

  const result = {
    attemptIdentity: assignment.attemptIdentity,
    resultId: ids.result,
    durationMs: 20,
    finalClientEventSeq: 1,
    status: "success",
    output: { privateAnswer: "encrypted result" },
  };
  await store.saveResult(result);

  const encrypted = await readFile(join(dataDir, "runtime-store.enc"));
  const diskText = encrypted.toString("utf8");
  for (const secret of [
    "do not expose this",
    "also encrypted",
    "encrypted result",
    "ol_inv_v2.private",
  ]) {
    assert.equal(diskText.includes(secret), false);
  }

  await store.ackResult(ids.attempt, ids.result);
  assert.equal((await store.snapshot()).events.length, 0);
  await store.deleteAssignment(ids.attempt);
  assert.deepEqual(await store.spoolStatus(), {
    assignments: 0,
    events: 0,
    results: 0,
    empty: true,
  });
  await store.close();

  const reopened = new FileRuntimeStore(dataDir, { reserveBytes: 0 });
  await reopened.open();
  const second = await reopened.beginSession();
  assert.equal(second.workerId, first.workerId);
  assert.equal(second.sessionEpoch, first.sessionEpoch + 1);
  assert.notEqual(second.runtimeSessionId, first.runtimeSessionId);
  await reopened.close();
});

test("FileRuntimeStore retains revoked tombstones without counting them as drain work", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-revoked-tombstone-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const store = new FileRuntimeStore(dataDir, { reserveBytes: 0 });
  await store.open();
  const identity = await store.beginSession();
  const assignment = assigned(identity, { privatePrompt: "cancel me" });
  await store.saveAssignment(assignment);
  await store.transitionAssignment(ids.attempt, "ack_sent");
  await store.transitionAssignment(ids.attempt, "confirmed", {
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await store.transitionAssignment(ids.attempt, "started");
  await store.appendEvent(assignment.attemptIdentity, "run.progress", { step: 1 });
  await store.saveResult({
    attemptIdentity: assignment.attemptIdentity,
    resultId: ids.result,
    durationMs: 20,
    finalClientEventSeq: 1,
    status: "success",
    output: { tooLate: true },
  });
  await store.revokeAttempt(ids.attempt);
  assert.deepEqual(await store.spoolStatus(), {
    assignments: 0,
    events: 0,
    results: 0,
    empty: true,
  });
  assert.equal((await store.getAssignment(ids.attempt))?.state, "revoked");
  await store.close();

  const reopened = new FileRuntimeStore(dataDir, { reserveBytes: 0 });
  await reopened.open();
  assert.equal((await reopened.getAssignment(ids.attempt))?.state, "revoked");
  assert.equal((await reopened.spoolStatus()).empty, true);
  await reopened.close();
});

test("FileRuntimeStore holds an exclusive process lock and fails closed on corruption", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-lock-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const first = new FileRuntimeStore(dataDir);
  await first.open();
  const second = new FileRuntimeStore(dataDir);
  await assert.rejects(second.open(), (error) => {
    assert.ok(error instanceof RuntimeStoreError);
    assert.equal(error.code, "LOCKED");
    return true;
  });
  await first.close();

  const statePath = join(dataDir, "runtime-store.enc");
  const bytes = await readFile(statePath);
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(statePath, bytes, { mode: 0o600 });
  const corrupt = new FileRuntimeStore(dataDir);
  await assert.rejects(corrupt.open(), (error) => {
    assert.ok(error instanceof RuntimeStoreError);
    assert.equal(error.code, "CORRUPT");
    return true;
  });
});

test("FileRuntimeStore reports capacity before acknowledging oversized durable work", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-js-capacity-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new FileRuntimeStore(dataDir, {
    maxBytes: 1_024,
    reserveBytes: 0,
    maxRecords: 10,
  });
  await store.open();
  const identity = await store.beginSession();
  await assert.rejects(
    store.saveAssignment(assigned(identity, { payload: "x".repeat(4_096) })),
    (error) => {
      assert.ok(error instanceof RuntimeStoreError);
      assert.equal(error.code, "CAPACITY");
      return true;
    },
  );
  assert.equal((await store.snapshot()).assignments.length, 0);
  await store.close();
});

function assigned(identity, input) {
  const now = Date.now();
  return {
    attemptIdentity: {
      runId: ids.run,
      attemptId: ids.attempt,
      leaseId: ids.lease,
      fencingToken: 1,
      nodeId: ids.node,
      agentId: ids.agent,
      workerId: identity.workerId,
      runtimeSessionId: identity.runtimeSessionId,
    },
    offerNo: 1,
    offerExpiresAt: new Date(now + 30_000).toISOString(),
    attemptDeadlineAt: new Date(now + 60_000).toISOString(),
    runDeadlineAt: new Date(now + 120_000).toISOString(),
    input,
    metadata: { source: "test" },
    nodeEnvelope: "ol_ctx_v2.private",
    agentInvocationToken: "ol_inv_v2.private",
  };
}
