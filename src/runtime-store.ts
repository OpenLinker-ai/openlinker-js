import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { JsonObject } from "./types.js";
import type {
  RuntimeAttemptIdentity,
  RuntimeRunAssignedPayload,
  RuntimeRunEventPayload,
  RuntimeRunResultPayload,
} from "./runtime-types.js";

const storeFormat = 1;
const storeMagic = Buffer.from("OLRTS1\r\n", "ascii");
const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;
const stateFileName = "runtime-store.enc";
const keyFileName = "runtime-store.key";
const lockFileName = ".runtime-worker.lock";
const defaultMaxBytes = 512 * 1024 * 1024;
const defaultMaxRecords = 10_000;
const defaultReserveBytes = 16 * 1024 * 1024;

export type RuntimeAssignmentState =
  | "received"
  | "ack_sent"
  | "confirmed"
  | "started"
  | "finished"
  | "result_acked"
  | "reject_sent"
  | "rejected"
  | "revoked";

export interface RuntimeWorkerIdentity {
  workerId: string;
  runtimeSessionId: string;
  sessionEpoch: number;
}

export interface RuntimeStoredAssignment {
  assignment: RuntimeRunAssignedPayload;
  state: RuntimeAssignmentState;
  lastClientEventSeq: number;
  ackedClientEventSeq: number;
  ackedOutOfOrderEventSeqs: number[];
  leaseExpiresAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeStoredEvent extends RuntimeRunEventPayload {
  createdAt: string;
}

export interface RuntimeStoredResult {
  payload: RuntimeRunResultPayload;
  createdAt: string;
}

export interface RuntimeStoreSnapshot {
  identity: RuntimeWorkerIdentity | undefined;
  assignments: RuntimeStoredAssignment[];
  events: RuntimeStoredEvent[];
  results: RuntimeStoredResult[];
  bytesUsed: number;
  recordsUsed: number;
}

/** Counts every durable record that must be cleared before a safe Worker exit. */
export interface RuntimeSpoolStatus {
  assignments: number;
  events: number;
  results: number;
  empty: boolean;
}

/**
 * RuntimeStore mutations must be durable before their promises resolve.
 * RuntimeWorker relies on this boundary before sending assignment, Event, or
 * Result acknowledgements to Core.
 */
export interface RuntimeStore {
  readonly durable: boolean;
  open(): Promise<void>;
  beginSession(): Promise<RuntimeWorkerIdentity>;
  identity(): RuntimeWorkerIdentity | undefined;
  acceptsNewRuns(): boolean;
  snapshot(): Promise<RuntimeStoreSnapshot>;
  spoolStatus(): Promise<RuntimeSpoolStatus>;
  saveAssignment(assignment: RuntimeRunAssignedPayload): Promise<RuntimeStoredAssignment>;
  transitionAssignment(
    attemptId: string,
    next: RuntimeAssignmentState,
    options?: { leaseExpiresAt?: string | undefined },
  ): Promise<RuntimeStoredAssignment>;
  getAssignment(attemptId: string): Promise<RuntimeStoredAssignment | undefined>;
  listAssignments(): Promise<RuntimeStoredAssignment[]>;
  deleteAssignment(attemptId: string): Promise<void>;
  appendEvent(
    identity: RuntimeAttemptIdentity,
    eventType: string,
    payload: JsonObject,
  ): Promise<RuntimeStoredEvent>;
  listPendingEvents(attemptId: string): Promise<RuntimeStoredEvent[]>;
  listEventsInRanges(
    attemptId: string,
    ranges: readonly { start: number; end: number }[],
  ): Promise<RuntimeStoredEvent[]>;
  ackEvent(attemptId: string, clientEventId: string, clientEventSeq: number): Promise<void>;
  saveResult(payload: RuntimeRunResultPayload): Promise<RuntimeStoredResult>;
  getPendingResult(attemptId: string): Promise<RuntimeStoredResult | undefined>;
  ackResult(attemptId: string, resultId: string): Promise<void>;
  revokeAttempt(attemptId: string): Promise<void>;
  close(): Promise<void>;
}

export interface FileRuntimeStoreOptions {
  maxBytes?: number | undefined;
  maxRecords?: number | undefined;
  reserveBytes?: number | undefined;
}

interface DiskIdentity {
  workerId: string;
  runtimeSessionId?: string | undefined;
  sessionEpoch: number;
}

interface RuntimeStoreState {
  format: typeof storeFormat;
  identity: DiskIdentity;
  assignments: Record<string, RuntimeStoredAssignment>;
  events: Record<string, RuntimeStoredEvent>;
  results: Record<string, RuntimeStoredResult>;
}

export class RuntimeStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_OPEN"
      | "ALREADY_OPEN"
      | "LOCKED"
      | "CORRUPT"
      | "CAPACITY"
      | "CONFLICT"
      | "INVALID_TRANSITION"
      | "PERMISSIONS"
      | "CLOSED",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeStoreError";
  }
}

/**
 * Encrypted production store. One authenticated snapshot contains the stable
 * worker identity, session epoch, assignment payloads, and Event/Result spool.
 * Every mutation uses a private temporary file, fsync, atomic rename, and a
 * directory fsync before it becomes visible to the caller.
 */
export class FileRuntimeStore implements RuntimeStore {
  readonly durable = true;
  readonly dataDir: string;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly reserveBytes: number;
  private state: RuntimeStoreState | undefined;
  private key: Buffer | undefined;
  private lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  private opened = false;
  private closed = false;
  private sessionBegun = false;
  private bytesUsed = 0;
  private mutation = Promise.resolve();

  constructor(dataDir: string, options: FileRuntimeStoreOptions = {}) {
    if (!dataDir.trim()) {
      throw new Error("FileRuntimeStore requires dataDir");
    }
    this.dataDir = resolve(dataDir);
    this.maxBytes = positiveInteger(options.maxBytes ?? defaultMaxBytes, "maxBytes");
    this.maxRecords = positiveInteger(options.maxRecords ?? defaultMaxRecords, "maxRecords");
    this.reserveBytes = nonNegativeInteger(
      options.reserveBytes ?? Math.min(defaultReserveBytes, Math.floor(this.maxBytes / 4)),
      "reserveBytes",
    );
    if (this.reserveBytes >= this.maxBytes) {
      throw new Error("FileRuntimeStore reserveBytes must be smaller than maxBytes");
    }
  }

  async open(): Promise<void> {
    if (this.opened) throw new RuntimeStoreError("Runtime store is already open", "ALREADY_OPEN");
    if (this.closed) throw new RuntimeStoreError("Runtime store is closed", "CLOSED");
    await ensurePrivateDirectory(this.dataDir);
    this.lockHandle = await acquireProcessLock(join(this.dataDir, lockFileName));
    try {
      await cleanupTemporaryFiles(this.dataDir);
      await this.loadOrCreate();
      this.opened = true;
    } catch (error) {
      await releaseProcessLock(this.lockHandle, join(this.dataDir, lockFileName));
      this.lockHandle = undefined;
      throw error;
    }
  }

  async beginSession(): Promise<RuntimeWorkerIdentity> {
    return this.mutate((state) => {
      if (this.sessionBegun) {
        throw new RuntimeStoreError("Runtime store session already began", "CONFLICT");
      }
      if (state.identity.sessionEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new RuntimeStoreError("Runtime session epoch is exhausted", "CORRUPT");
      }
      state.identity.sessionEpoch += 1;
      state.identity.runtimeSessionId = randomUUID();
      this.sessionBegun = true;
      return publicIdentity(state.identity);
    });
  }

  identity(): RuntimeWorkerIdentity | undefined {
    this.assertOpen();
    const identity = this.requiredState().identity;
    return identity.runtimeSessionId ? publicIdentity(identity) : undefined;
  }

  acceptsNewRuns(): boolean {
    if (!this.opened || this.closed || !this.state) return false;
    return this.bytesUsed < this.maxBytes - this.reserveBytes &&
      recordCount(this.state) < this.maxRecords;
  }

  async snapshot(): Promise<RuntimeStoreSnapshot> {
    return this.read((state) => ({
      identity: state.identity.runtimeSessionId ? publicIdentity(state.identity) : undefined,
      assignments: Object.values(state.assignments).map(cloneJSON),
      events: sortEvents(Object.values(state.events)).map(cloneJSON),
      results: Object.values(state.results).map(cloneJSON),
      bytesUsed: this.bytesUsed,
      recordsUsed: recordCount(state),
    }));
  }

  async spoolStatus(): Promise<RuntimeSpoolStatus> {
    return this.read(runtimeSpoolStatus);
  }

  async saveAssignment(assignment: RuntimeRunAssignedPayload): Promise<RuntimeStoredAssignment> {
    return this.mutate((state) => {
      assertAssignmentMatchesIdentity(assignment, state.identity);
      const attemptId = assignment.attemptIdentity.attemptId;
      const existing = state.assignments[attemptId];
      if (existing) {
        if (!jsonEqual(existing.assignment, assignment)) {
          throw new RuntimeStoreError("Attempt is already bound to another assignment", "CONFLICT");
        }
        return cloneJSON(existing);
      }
      const now = new Date().toISOString();
      const stored: RuntimeStoredAssignment = {
        assignment: cloneJSON(assignment),
        state: "received",
        lastClientEventSeq: 0,
        ackedClientEventSeq: 0,
        ackedOutOfOrderEventSeqs: [],
        createdAt: now,
        updatedAt: now,
      };
      state.assignments[attemptId] = stored;
      return cloneJSON(stored);
    });
  }

  async transitionAssignment(
    attemptId: string,
    next: RuntimeAssignmentState,
    options: { leaseExpiresAt?: string | undefined } = {},
  ): Promise<RuntimeStoredAssignment> {
    return this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      if (assignment.state !== next && !allowedTransition(assignment.state, next)) {
        throw new RuntimeStoreError(
          `Runtime assignment cannot move from ${assignment.state} to ${next}`,
          "INVALID_TRANSITION",
        );
      }
      assignment.state = next;
      if (options.leaseExpiresAt !== undefined) {
        if (!Number.isFinite(Date.parse(options.leaseExpiresAt))) {
          throw new RuntimeStoreError("Runtime lease expiry is invalid", "CORRUPT");
        }
        assignment.leaseExpiresAt = options.leaseExpiresAt;
      }
      assignment.updatedAt = new Date().toISOString();
      return cloneJSON(assignment);
    });
  }

  async getAssignment(attemptId: string): Promise<RuntimeStoredAssignment | undefined> {
    return this.read((state) => {
      const value = state.assignments[attemptId];
      return value ? cloneJSON(value) : undefined;
    });
  }

  async listAssignments(): Promise<RuntimeStoredAssignment[]> {
    return this.read((state) => Object.values(state.assignments)
      .sort((left, right) => left.assignment.attemptIdentity.attemptId.localeCompare(
        right.assignment.attemptIdentity.attemptId,
      ))
      .map(cloneJSON));
  }

  async deleteAssignment(attemptId: string): Promise<void> {
    await this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      if (!isTerminalState(assignment.state) || state.results[attemptId] || hasAttemptEvents(state, attemptId)) {
        throw new RuntimeStoreError("Runtime assignment still owns durable work", "INVALID_TRANSITION");
      }
      delete state.assignments[attemptId];
    });
  }

  async appendEvent(
    identity: RuntimeAttemptIdentity,
    eventType: string,
    payload: JsonObject,
  ): Promise<RuntimeStoredEvent> {
    return this.mutate((state) => {
      if (!eventType.trim() || eventType.length > 200) {
        throw new RuntimeStoreError("Runtime Event type is invalid", "CORRUPT");
      }
      const assignment = requiredAssignment(state, identity.attemptId);
      if (assignment.state !== "started" || !attemptIdentityEqual(
        assignment.assignment.attemptIdentity,
        identity,
      )) {
        throw new RuntimeStoreError("Runtime Event does not belong to a started Attempt", "INVALID_TRANSITION");
      }
      assertJSONObject(payload, "Runtime Event payload");
      if (assignment.lastClientEventSeq >= Number.MAX_SAFE_INTEGER) {
        throw new RuntimeStoreError("Runtime Event sequence is exhausted", "CORRUPT");
      }
      const clientEventSeq = assignment.lastClientEventSeq + 1;
      const event: RuntimeStoredEvent = {
        attemptIdentity: cloneJSON(identity),
        clientEventId: randomUUID(),
        clientEventSeq,
        eventType,
        payload: cloneJSON(payload),
        createdAt: new Date().toISOString(),
      };
      state.events[event.clientEventId] = event;
      assignment.lastClientEventSeq = clientEventSeq;
      assignment.updatedAt = event.createdAt;
      return cloneJSON(event);
    });
  }

  async listPendingEvents(attemptId: string): Promise<RuntimeStoredEvent[]> {
    return this.read((state) => {
      const assignment = requiredAssignment(state, attemptId);
      return sortEvents(Object.values(state.events).filter(
        (event) => event.attemptIdentity.attemptId === attemptId &&
          !eventSequenceAcked(assignment, event.clientEventSeq),
      )).map(cloneJSON);
    });
  }

  async listEventsInRanges(
    attemptId: string,
    ranges: readonly { start: number; end: number }[],
  ): Promise<RuntimeStoredEvent[]> {
    return this.read((state) => eventsInRanges(state, attemptId, ranges));
  }

  async ackEvent(attemptId: string, clientEventId: string, clientEventSeq: number): Promise<void> {
    await this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      const event = state.events[clientEventId];
      if (!event || event.attemptIdentity.attemptId !== attemptId || event.clientEventSeq !== clientEventSeq) {
        throw new RuntimeStoreError("Runtime Event ACK does not match durable Event", "CONFLICT");
      }
      applyEventAck(assignment, clientEventSeq);
      assignment.updatedAt = new Date().toISOString();
    });
  }

  async saveResult(payload: RuntimeRunResultPayload): Promise<RuntimeStoredResult> {
    return this.mutate((state) => {
      const attemptId = payload.attemptIdentity.attemptId;
      const assignment = requiredAssignment(state, attemptId);
      if (!attemptIdentityEqual(assignment.assignment.attemptIdentity, payload.attemptIdentity) ||
        (assignment.state !== "started" && assignment.state !== "finished")) {
        throw new RuntimeStoreError("Runtime Result does not belong to a started Attempt", "INVALID_TRANSITION");
      }
      const existing = state.results[attemptId];
      if (existing) {
        if (!jsonEqual(existing.payload, payload)) {
          throw new RuntimeStoreError("Attempt already has another Runtime Result", "CONFLICT");
        }
        return cloneJSON(existing);
      }
      if (payload.finalClientEventSeq !== assignment.lastClientEventSeq) {
        throw new RuntimeStoreError("Runtime Result final Event sequence is invalid", "CONFLICT");
      }
      const stored: RuntimeStoredResult = {
        payload: cloneJSON(payload),
        createdAt: new Date().toISOString(),
      };
      state.results[attemptId] = stored;
      assignment.state = "finished";
      assignment.updatedAt = stored.createdAt;
      return cloneJSON(stored);
    });
  }

  async getPendingResult(attemptId: string): Promise<RuntimeStoredResult | undefined> {
    return this.read((state) => {
      requiredAssignment(state, attemptId);
      const value = state.results[attemptId];
      return value ? cloneJSON(value) : undefined;
    });
  }

  async ackResult(attemptId: string, resultId: string): Promise<void> {
    await this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      const result = state.results[attemptId];
      if (!result || result.payload.resultId !== resultId) {
        throw new RuntimeStoreError("Runtime Result ACK does not match durable Result", "CONFLICT");
      }
      delete state.results[attemptId];
      for (const [eventId, event] of Object.entries(state.events)) {
        if (event.attemptIdentity.attemptId === attemptId) delete state.events[eventId];
      }
      assignment.state = "result_acked";
      assignment.updatedAt = new Date().toISOString();
    });
  }

  async revokeAttempt(attemptId: string): Promise<void> {
    await this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      assignment.state = "revoked";
      assignment.updatedAt = new Date().toISOString();
      delete state.results[attemptId];
      for (const [eventId, event] of Object.entries(state.events)) {
        if (event.attemptIdentity.attemptId === attemptId) delete state.events[eventId];
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.mutation.catch(() => undefined);
    this.closed = true;
    this.opened = false;
    this.state = undefined;
    this.key?.fill(0);
    this.key = undefined;
    if (this.lockHandle) {
      await releaseProcessLock(this.lockHandle, join(this.dataDir, lockFileName));
      this.lockHandle = undefined;
    }
  }

  private async loadOrCreate(): Promise<void> {
    const statePath = join(this.dataDir, stateFileName);
    const keyPath = join(this.dataDir, keyFileName);
    const stateExists = await pathExists(statePath);
    const keyExists = await pathExists(keyPath);
    if (stateExists !== keyExists) {
      throw new RuntimeStoreError("Runtime store key and state do not match", "CORRUPT");
    }
    this.key = keyExists ? await loadPrivateKey(keyPath) : await createPrivateKey(keyPath);
    if (stateExists) {
      await assertPrivateFile(statePath, "Runtime store state");
      const encrypted = await readFile(statePath);
      this.bytesUsed = encrypted.byteLength;
      this.state = decryptState(this.key, encrypted);
      try {
        validateState(this.state);
      } catch (error) {
        if (error instanceof RuntimeStoreError) throw error;
        throw new RuntimeStoreError("Runtime store state is corrupt", "CORRUPT", { cause: error });
      }
      if (this.bytesUsed > this.maxBytes || recordCount(this.state) > this.maxRecords) {
        throw new RuntimeStoreError("Runtime store exceeds configured capacity", "CAPACITY");
      }
      return;
    }
    this.state = emptyState();
    await this.persist(this.state);
  }

  private async read<T>(operation: (state: RuntimeStoreState) => T): Promise<T> {
    await this.mutation;
    this.assertOpen();
    return operation(this.requiredState());
  }

  private mutate<T>(operation: (state: RuntimeStoreState) => T): Promise<T> {
    const run = this.mutation.then(async () => {
      this.assertOpen();
      const current = this.requiredState();
      const candidate = cloneJSON(current);
      const value = operation(candidate);
      await this.persist(candidate);
      this.state = candidate;
      return value;
    });
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(state: RuntimeStoreState): Promise<void> {
    const key = this.key;
    if (!key) throw new RuntimeStoreError("Runtime store key is unavailable", "NOT_OPEN");
    validateState(state);
    if (recordCount(state) > this.maxRecords) {
      throw new RuntimeStoreError("Runtime store record capacity is exhausted", "CAPACITY");
    }
    const encrypted = encryptState(key, state);
    if (encrypted.byteLength > this.maxBytes - this.reserveBytes) {
      throw new RuntimeStoreError("Runtime store byte capacity is exhausted", "CAPACITY");
    }
    let availableBytes: number;
    try {
      const filesystem = await statfs(this.dataDir);
      availableBytes = filesystem.bavail * filesystem.bsize;
    } catch (cause) {
      throw new RuntimeStoreError("Runtime store cannot verify free disk space", "CAPACITY", { cause });
    }
    if (!Number.isFinite(availableBytes) || availableBytes < encrypted.byteLength + this.reserveBytes) {
      throw new RuntimeStoreError("Runtime store disk reserve is exhausted", "CAPACITY");
    }
    await atomicWriteDurable(join(this.dataDir, stateFileName), encrypted);
    this.bytesUsed = encrypted.byteLength;
  }

  private requiredState(): RuntimeStoreState {
    if (!this.state) throw new RuntimeStoreError("Runtime store is not open", "NOT_OPEN");
    return this.state;
  }

  private assertOpen(): void {
    if (this.closed) throw new RuntimeStoreError("Runtime store is closed", "CLOSED");
    if (!this.opened && this.state === undefined) {
      throw new RuntimeStoreError("Runtime store is not open", "NOT_OPEN");
    }
  }
}

/** Explicitly unsafe, process-memory-only Store for tests and local harnesses. */
export class MemoryRuntimeStore implements RuntimeStore {
  readonly durable = false;
  private state = emptyState();
  private opened = false;
  private closed = false;
  private sessionBegun = false;
  private mutation = Promise.resolve();

  async open(): Promise<void> {
    if (this.opened) throw new RuntimeStoreError("Runtime store is already open", "ALREADY_OPEN");
    if (this.closed) throw new RuntimeStoreError("Runtime store is closed", "CLOSED");
    this.opened = true;
  }

  async beginSession(): Promise<RuntimeWorkerIdentity> {
    return this.mutate((state) => {
      if (this.sessionBegun) throw new RuntimeStoreError("Runtime store session already began", "CONFLICT");
      state.identity.sessionEpoch += 1;
      state.identity.runtimeSessionId = randomUUID();
      this.sessionBegun = true;
      return publicIdentity(state.identity);
    });
  }

  identity(): RuntimeWorkerIdentity | undefined {
    this.assertOpen();
    return this.state.identity.runtimeSessionId ? publicIdentity(this.state.identity) : undefined;
  }

  acceptsNewRuns(): boolean {
    return this.opened && !this.closed;
  }

  async snapshot(): Promise<RuntimeStoreSnapshot> {
    return this.read((state) => ({
      identity: state.identity.runtimeSessionId ? publicIdentity(state.identity) : undefined,
      assignments: Object.values(state.assignments).map(cloneJSON),
      events: sortEvents(Object.values(state.events)).map(cloneJSON),
      results: Object.values(state.results).map(cloneJSON),
      bytesUsed: 0,
      recordsUsed: recordCount(state),
    }));
  }

  async spoolStatus(): Promise<RuntimeSpoolStatus> {
    return this.read(runtimeSpoolStatus);
  }

  saveAssignment(assignment: RuntimeRunAssignedPayload): Promise<RuntimeStoredAssignment> {
    return storeOps.saveAssignment.call(this as unknown as StoreOpsTarget, assignment);
  }

  transitionAssignment(
    attemptId: string,
    next: RuntimeAssignmentState,
    options: { leaseExpiresAt?: string | undefined } = {},
  ): Promise<RuntimeStoredAssignment> {
    return storeOps.transitionAssignment.call(this as unknown as StoreOpsTarget, attemptId, next, options);
  }

  getAssignment(attemptId: string): Promise<RuntimeStoredAssignment | undefined> {
    return this.read((state) => state.assignments[attemptId] ? cloneJSON(state.assignments[attemptId]) : undefined);
  }

  listAssignments(): Promise<RuntimeStoredAssignment[]> {
    return this.read((state) => Object.values(state.assignments)
      .sort((left, right) => left.assignment.attemptIdentity.attemptId.localeCompare(
        right.assignment.attemptIdentity.attemptId,
      ))
      .map(cloneJSON));
  }

  deleteAssignment(attemptId: string): Promise<void> {
    return storeOps.deleteAssignment.call(this as unknown as StoreOpsTarget, attemptId);
  }

  appendEvent(identity: RuntimeAttemptIdentity, eventType: string, payload: JsonObject): Promise<RuntimeStoredEvent> {
    return storeOps.appendEvent.call(this as unknown as StoreOpsTarget, identity, eventType, payload);
  }

  listPendingEvents(attemptId: string): Promise<RuntimeStoredEvent[]> {
    return this.read((state) => {
      const assignment = requiredAssignment(state, attemptId);
      return sortEvents(Object.values(state.events).filter(
        (event) => event.attemptIdentity.attemptId === attemptId &&
          !eventSequenceAcked(assignment, event.clientEventSeq),
      )).map(cloneJSON);
    });
  }

  listEventsInRanges(
    attemptId: string,
    ranges: readonly { start: number; end: number }[],
  ): Promise<RuntimeStoredEvent[]> {
    return this.read((state) => eventsInRanges(state, attemptId, ranges));
  }

  ackEvent(attemptId: string, clientEventId: string, clientEventSeq: number): Promise<void> {
    return storeOps.ackEvent.call(this as unknown as StoreOpsTarget, attemptId, clientEventId, clientEventSeq);
  }

  saveResult(payload: RuntimeRunResultPayload): Promise<RuntimeStoredResult> {
    return storeOps.saveResult.call(this as unknown as StoreOpsTarget, payload);
  }

  getPendingResult(attemptId: string): Promise<RuntimeStoredResult | undefined> {
    return this.read((state) => {
      requiredAssignment(state, attemptId);
      return state.results[attemptId] ? cloneJSON(state.results[attemptId]) : undefined;
    });
  }

  ackResult(attemptId: string, resultId: string): Promise<void> {
    return storeOps.ackResult.call(this as unknown as StoreOpsTarget, attemptId, resultId);
  }

  revokeAttempt(attemptId: string): Promise<void> {
    return storeOps.revokeAttempt.call(this as unknown as StoreOpsTarget, attemptId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.opened = false;
    this.state = emptyState();
  }

  private async read<T>(operation: (state: RuntimeStoreState) => T): Promise<T> {
    await this.mutation;
    this.assertOpen();
    return operation(this.state);
  }

  private mutate<T>(operation: (state: RuntimeStoreState) => T): Promise<T> {
    const run = this.mutation.then(() => {
      this.assertOpen();
      const candidate = cloneJSON(this.state);
      const value = operation(candidate);
      validateState(candidate);
      this.state = candidate;
      return value;
    });
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw new RuntimeStoreError("Runtime store is closed", "CLOSED");
    if (!this.opened) throw new RuntimeStoreError("Runtime store is not open", "NOT_OPEN");
  }
}

interface StoreOpsTarget {
  state: RuntimeStoreState;
  mutate<T>(operation: (state: RuntimeStoreState) => T): Promise<T>;
}

const storeOps = {
  saveAssignment(this: StoreOpsTarget, assignment: RuntimeRunAssignedPayload): Promise<RuntimeStoredAssignment> {
    return this.mutate((state) => {
      assertAssignmentMatchesIdentity(assignment, state.identity);
      const attemptId = assignment.attemptIdentity.attemptId;
      const existing = state.assignments[attemptId];
      if (existing) {
        if (!jsonEqual(existing.assignment, assignment)) {
          throw new RuntimeStoreError("Attempt is already bound to another assignment", "CONFLICT");
        }
        return cloneJSON(existing);
      }
      const now = new Date().toISOString();
      const stored: RuntimeStoredAssignment = {
        assignment: cloneJSON(assignment), state: "received", lastClientEventSeq: 0,
        ackedClientEventSeq: 0, ackedOutOfOrderEventSeqs: [], createdAt: now, updatedAt: now,
      };
      state.assignments[attemptId] = stored;
      return cloneJSON(stored);
    });
  },
  transitionAssignment(
    this: StoreOpsTarget,
    attemptId: string,
    next: RuntimeAssignmentState,
    options: { leaseExpiresAt?: string | undefined } = {},
  ): Promise<RuntimeStoredAssignment> {
    return this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      if (assignment.state !== next && !allowedTransition(assignment.state, next)) {
        throw new RuntimeStoreError(`Runtime assignment cannot move from ${assignment.state} to ${next}`, "INVALID_TRANSITION");
      }
      assignment.state = next;
      if (options.leaseExpiresAt !== undefined) {
        if (!Number.isFinite(Date.parse(options.leaseExpiresAt))) {
          throw new RuntimeStoreError("Runtime lease expiry is invalid", "CORRUPT");
        }
        assignment.leaseExpiresAt = options.leaseExpiresAt;
      }
      assignment.updatedAt = new Date().toISOString();
      return cloneJSON(assignment);
    });
  },
  deleteAssignment(this: StoreOpsTarget, attemptId: string): Promise<void> {
    return this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      if (!isTerminalState(assignment.state) || state.results[attemptId] || hasAttemptEvents(state, attemptId)) {
        throw new RuntimeStoreError("Runtime assignment still owns durable work", "INVALID_TRANSITION");
      }
      delete state.assignments[attemptId];
    });
  },
  appendEvent(
    this: StoreOpsTarget,
    identity: RuntimeAttemptIdentity,
    eventType: string,
    payload: JsonObject,
  ): Promise<RuntimeStoredEvent> {
    return this.mutate((state) => {
      if (!eventType.trim() || eventType.length > 200) {
        throw new RuntimeStoreError("Runtime Event type is invalid", "CORRUPT");
      }
      const assignment = requiredAssignment(state, identity.attemptId);
      if (assignment.state !== "started" || !attemptIdentityEqual(assignment.assignment.attemptIdentity, identity)) {
        throw new RuntimeStoreError("Runtime Event does not belong to a started Attempt", "INVALID_TRANSITION");
      }
      assertJSONObject(payload, "Runtime Event payload");
      if (assignment.lastClientEventSeq >= Number.MAX_SAFE_INTEGER) {
        throw new RuntimeStoreError("Runtime Event sequence is exhausted", "CORRUPT");
      }
      const event: RuntimeStoredEvent = {
        attemptIdentity: cloneJSON(identity), clientEventId: randomUUID(),
        clientEventSeq: assignment.lastClientEventSeq + 1, eventType,
        payload: cloneJSON(payload), createdAt: new Date().toISOString(),
      };
      state.events[event.clientEventId] = event;
      assignment.lastClientEventSeq = event.clientEventSeq;
      assignment.updatedAt = event.createdAt;
      return cloneJSON(event);
    });
  },
  ackEvent(this: StoreOpsTarget, attemptId: string, clientEventId: string, clientEventSeq: number): Promise<void> {
    return this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      const event = state.events[clientEventId];
      if (!event || event.attemptIdentity.attemptId !== attemptId || event.clientEventSeq !== clientEventSeq) {
        throw new RuntimeStoreError("Runtime Event ACK does not match durable Event", "CONFLICT");
      }
      applyEventAck(assignment, clientEventSeq);
      assignment.updatedAt = new Date().toISOString();
    });
  },
  saveResult(this: StoreOpsTarget, payload: RuntimeRunResultPayload): Promise<RuntimeStoredResult> {
    return this.mutate((state) => {
      const attemptId = payload.attemptIdentity.attemptId;
      const assignment = requiredAssignment(state, attemptId);
      if (!attemptIdentityEqual(assignment.assignment.attemptIdentity, payload.attemptIdentity) ||
        (assignment.state !== "started" && assignment.state !== "finished")) {
        throw new RuntimeStoreError("Runtime Result does not belong to a started Attempt", "INVALID_TRANSITION");
      }
      const existing = state.results[attemptId];
      if (existing) {
        if (!jsonEqual(existing.payload, payload)) throw new RuntimeStoreError("Attempt already has another Runtime Result", "CONFLICT");
        return cloneJSON(existing);
      }
      if (payload.finalClientEventSeq !== assignment.lastClientEventSeq) {
        throw new RuntimeStoreError("Runtime Result final Event sequence is invalid", "CONFLICT");
      }
      const stored = { payload: cloneJSON(payload), createdAt: new Date().toISOString() };
      state.results[attemptId] = stored;
      assignment.state = "finished";
      assignment.updatedAt = stored.createdAt;
      return cloneJSON(stored);
    });
  },
  ackResult(this: StoreOpsTarget, attemptId: string, resultId: string): Promise<void> {
    return this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      const result = state.results[attemptId];
      if (!result || result.payload.resultId !== resultId) {
        throw new RuntimeStoreError("Runtime Result ACK does not match durable Result", "CONFLICT");
      }
      delete state.results[attemptId];
      for (const [eventId, event] of Object.entries(state.events)) {
        if (event.attemptIdentity.attemptId === attemptId) delete state.events[eventId];
      }
      assignment.state = "result_acked";
      assignment.updatedAt = new Date().toISOString();
    });
  },
  revokeAttempt(this: StoreOpsTarget, attemptId: string): Promise<void> {
    return this.mutate((state) => {
      const assignment = requiredAssignment(state, attemptId);
      assignment.state = "revoked";
      assignment.updatedAt = new Date().toISOString();
      delete state.results[attemptId];
      for (const [eventId, event] of Object.entries(state.events)) {
        if (event.attemptIdentity.attemptId === attemptId) delete state.events[eventId];
      }
    });
  },
};

function emptyState(): RuntimeStoreState {
  return {
    format: storeFormat,
    identity: { workerId: randomUUID(), sessionEpoch: 0 },
    assignments: {},
    events: {},
    results: {},
  };
}

function publicIdentity(identity: DiskIdentity): RuntimeWorkerIdentity {
  if (!identity.runtimeSessionId || identity.sessionEpoch < 1) {
    throw new RuntimeStoreError("Runtime session identity is unavailable", "CORRUPT");
  }
  return {
    workerId: identity.workerId,
    runtimeSessionId: identity.runtimeSessionId,
    sessionEpoch: identity.sessionEpoch,
  };
}

function requiredAssignment(state: RuntimeStoreState, attemptId: string): RuntimeStoredAssignment {
  const assignment = state.assignments[attemptId];
  if (!assignment) throw new RuntimeStoreError("Runtime assignment is not durable", "CONFLICT");
  return assignment;
}

function allowedTransition(current: RuntimeAssignmentState, next: RuntimeAssignmentState): boolean {
  const allowed: Record<RuntimeAssignmentState, readonly RuntimeAssignmentState[]> = {
    received: ["ack_sent", "reject_sent", "revoked"],
    ack_sent: ["confirmed", "revoked"],
    confirmed: ["started", "revoked"],
    started: ["finished", "revoked"],
    finished: ["result_acked", "revoked"],
    result_acked: [],
    reject_sent: ["rejected", "revoked"],
    rejected: [],
    revoked: [],
  };
  return allowed[current].includes(next);
}

function isTerminalState(state: RuntimeAssignmentState): boolean {
  return state === "result_acked" || state === "rejected" || state === "revoked";
}

function hasAttemptEvents(state: RuntimeStoreState, attemptId: string): boolean {
  return Object.values(state.events).some((event) => event.attemptIdentity.attemptId === attemptId);
}

function applyEventAck(assignment: RuntimeStoredAssignment, sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > assignment.lastClientEventSeq) {
    throw new RuntimeStoreError("Runtime Event ACK sequence is invalid", "CONFLICT");
  }
  if (sequence === assignment.ackedClientEventSeq + 1) {
    assignment.ackedClientEventSeq = sequence;
    const outOfOrder = new Set(assignment.ackedOutOfOrderEventSeqs);
    while (outOfOrder.delete(assignment.ackedClientEventSeq + 1)) {
      assignment.ackedClientEventSeq += 1;
    }
    assignment.ackedOutOfOrderEventSeqs = [...outOfOrder].sort((a, b) => a - b);
  } else if (sequence > assignment.ackedClientEventSeq + 1 &&
    !assignment.ackedOutOfOrderEventSeqs.includes(sequence)) {
    assignment.ackedOutOfOrderEventSeqs.push(sequence);
    assignment.ackedOutOfOrderEventSeqs.sort((a, b) => a - b);
  }
}

function eventSequenceAcked(assignment: RuntimeStoredAssignment, sequence: number): boolean {
  return sequence <= assignment.ackedClientEventSeq ||
    assignment.ackedOutOfOrderEventSeqs.includes(sequence);
}

function assertAssignmentMatchesIdentity(assignment: RuntimeRunAssignedPayload, identity: DiskIdentity): void {
  const current = publicIdentity(identity);
  const attempt = assignment.attemptIdentity;
  if (attempt.workerId !== current.workerId || attempt.runtimeSessionId !== current.runtimeSessionId) {
    throw new RuntimeStoreError("Runtime assignment Session identity mismatch", "CONFLICT");
  }
  assertJSONObject(assignment.input, "Runtime assignment input");
  if (assignment.metadata !== undefined) assertJSONObject(assignment.metadata, "Runtime assignment metadata");
}

function attemptIdentityEqual(left: RuntimeAttemptIdentity, right: RuntimeAttemptIdentity): boolean {
  return left.runId === right.runId && left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId && left.fencingToken === right.fencingToken &&
    left.nodeId === right.nodeId && left.agentId === right.agentId &&
    left.workerId === right.workerId && left.runtimeSessionId === right.runtimeSessionId;
}

function sortEvents(events: RuntimeStoredEvent[]): RuntimeStoredEvent[] {
  return [...events].sort((left, right) => left.clientEventSeq - right.clientEventSeq);
}

function eventsInRanges(
  state: RuntimeStoreState,
  attemptId: string,
  ranges: readonly { start: number; end: number }[],
): RuntimeStoredEvent[] {
  const assignment = requiredAssignment(state, attemptId);
  const bySequence = new Map(Object.values(state.events)
    .filter((event) => event.attemptIdentity.attemptId === attemptId)
    .map((event) => [event.clientEventSeq, event]));
  const result: RuntimeStoredEvent[] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < 1 || range.end < range.start || range.start <= previousEnd ||
      range.end > assignment.lastClientEventSeq) {
      throw new RuntimeStoreError("Runtime Event replay range is invalid", "CONFLICT");
    }
    for (let sequence = range.start; sequence <= range.end; sequence += 1) {
      const event = bySequence.get(sequence);
      if (!event) throw new RuntimeStoreError("Runtime Event replay record is unavailable", "CORRUPT");
      result.push(cloneJSON(event));
    }
    previousEnd = range.end;
  }
  return result;
}

function recordCount(state: RuntimeStoreState): number {
  return Object.keys(state.assignments).length + Object.keys(state.events).length +
    Object.keys(state.results).length;
}

function runtimeSpoolStatus(state: RuntimeStoreState): RuntimeSpoolStatus {
  const assignments = Object.keys(state.assignments).length;
  const events = Object.keys(state.events).length;
  const results = Object.keys(state.results).length;
  return {
    assignments,
    events,
    results,
    empty: assignments === 0 && events === 0 && results === 0,
  };
}

function validateState(state: RuntimeStoreState): void {
  if (!state || state.format !== storeFormat || !isUUID(state.identity?.workerId) ||
    !Number.isSafeInteger(state.identity.sessionEpoch) || state.identity.sessionEpoch < 0 ||
    (state.identity.runtimeSessionId !== undefined && !isUUID(state.identity.runtimeSessionId)) ||
    !isPlainObject(state.assignments) || !isPlainObject(state.events) || !isPlainObject(state.results)) {
    throw new RuntimeStoreError("Runtime store state is corrupt", "CORRUPT");
  }
  for (const [attemptId, assignment] of Object.entries(state.assignments)) {
    if (!assignment || assignment.assignment.attemptIdentity.attemptId !== attemptId ||
      assignment.assignment.attemptIdentity.workerId !== state.identity.workerId ||
      !allowedState(assignment.state) || !Number.isSafeInteger(assignment.lastClientEventSeq) ||
      !Number.isSafeInteger(assignment.ackedClientEventSeq) ||
      assignment.ackedClientEventSeq > assignment.lastClientEventSeq ||
      !Array.isArray(assignment.ackedOutOfOrderEventSeqs)) {
      throw new RuntimeStoreError("Runtime assignment journal is corrupt", "CORRUPT");
    }
  }
  for (const event of Object.values(state.events)) {
    const assignment = state.assignments[event.attemptIdentity.attemptId];
    if (!assignment || !isUUID(event.clientEventId) || !Number.isSafeInteger(event.clientEventSeq) ||
      event.clientEventSeq < 1 || !attemptIdentityEqual(assignment.assignment.attemptIdentity, event.attemptIdentity)) {
      throw new RuntimeStoreError("Runtime Event spool is corrupt", "CORRUPT");
    }
  }
  for (const [attemptId, result] of Object.entries(state.results)) {
    const assignment = state.assignments[attemptId];
    if (!assignment || result.payload.attemptIdentity.attemptId !== attemptId ||
      !attemptIdentityEqual(assignment.assignment.attemptIdentity, result.payload.attemptIdentity) ||
      !isUUID(result.payload.resultId)) {
      throw new RuntimeStoreError("Runtime Result spool is corrupt", "CORRUPT");
    }
  }
}

function allowedState(value: unknown): value is RuntimeAssignmentState {
  return typeof value === "string" && [
    "received", "ack_sent", "confirmed", "started", "finished",
    "result_acked", "reject_sent", "rejected", "revoked",
  ].includes(value);
}

function encryptState(key: Buffer, state: RuntimeStoreState): Buffer {
  const plaintext = Buffer.from(JSON.stringify(state), "utf8");
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(storeMagic);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([storeMagic, nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptState(key: Buffer, encrypted: Buffer): RuntimeStoreState {
  if (encrypted.byteLength < storeMagic.byteLength + nonceBytes + tagBytes + 2 ||
    !encrypted.subarray(0, storeMagic.byteLength).equals(storeMagic)) {
    throw new RuntimeStoreError("Runtime store header is corrupt", "CORRUPT");
  }
  try {
    const nonceStart = storeMagic.byteLength;
    const tagStart = nonceStart + nonceBytes;
    const bodyStart = tagStart + tagBytes;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      encrypted.subarray(nonceStart, tagStart),
    );
    decipher.setAAD(storeMagic);
    decipher.setAuthTag(encrypted.subarray(tagStart, bodyStart));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(bodyStart)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as RuntimeStoreState;
  } catch (cause) {
    throw new RuntimeStoreError("Runtime store authentication failed", "CORRUPT", { cause });
  }
}

async function atomicWriteDurable(path: string, value: Buffer): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await stat(path);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new RuntimeStoreError("Runtime data directory must have mode 0700", "PERMISSIONS");
  }
}

async function cleanupTemporaryFiles(dataDir: string): Promise<void> {
  const prefix = `${stateFileName}.tmp-`;
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new RuntimeStoreError("Runtime store temporary record is invalid", "CORRUPT");
    }
    await rm(join(dataDir, entry.name), { force: true });
  }
}

async function acquireProcessLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "EEXIST") {
      throw new RuntimeStoreError("Runtime data directory is locked by another process", "LOCKED", { cause });
    }
    throw cause;
  }
}

async function releaseProcessLock(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<void> {
  try {
    await handle.close();
  } finally {
    await rm(path, { force: true });
  }
}

async function loadPrivateKey(path: string): Promise<Buffer> {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new RuntimeStoreError("Runtime store key must have mode 0600", "PERMISSIONS");
  }
  const key = await readFile(path);
  if (key.byteLength !== keyBytes) {
    throw new RuntimeStoreError("Runtime store key is corrupt", "CORRUPT");
  }
  return Buffer.from(key);
}

async function assertPrivateFile(path: string, label: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new RuntimeStoreError(`${label} must have mode 0600`, "PERMISSIONS");
  }
}

async function createPrivateKey(path: string): Promise<Buffer> {
  const key = randomBytes(keyBytes);
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(key);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryHandle = await open(dirname(path), fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return key;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertJSONObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isPlainObject(value)) throw new RuntimeStoreError(`${label} must be a JSON object`, "CORRUPT");
  try {
    JSON.stringify(value);
  } catch (cause) {
    throw new RuntimeStoreError(`${label} is not JSON serializable`, "CORRUPT", { cause });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`FileRuntimeStore ${label} is invalid`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`FileRuntimeStore ${label} is invalid`);
  return value;
}
