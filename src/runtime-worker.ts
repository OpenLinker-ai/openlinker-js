import { randomUUID } from "node:crypto";
import type { JsonObject } from "./types.js";
import { OpenLinkerError, type RequestOptions } from "./client.js";
import {
  NodeRuntimeTransport,
  discoverRuntimeURL,
  validatePlatformURL,
  validateRuntimeURL,
  type NodeRuntimeTransportOptions,
  type RuntimeMTLSConfig,
} from "./runtime-node-transport.js";
import {
  FileRuntimeStore,
  MemoryRuntimeStore,
  RuntimeStoreError,
  type RuntimeAssignmentState,
  type RuntimeStore,
  type RuntimeStoredAssignment,
  type RuntimeStoredEvent,
  type RuntimeStoredResult,
  type RuntimeWorkerIdentity,
} from "./runtime-store.js";
import {
  RuntimeContractDigest,
  RuntimeMaxNodeCapacity,
  RuntimeRequiredFeatures,
  RuntimeResumeActions,
  RuntimeResumeDecisions,
  type RuntimeAssignmentConfirmedPayload,
  type RuntimeAssignmentRejectedPayload,
  type RuntimeAttemptIdentity,
  type RuntimeCommandsResponse,
  type RuntimeHelloPayload,
  type RuntimeLeaseRenewedPayload,
  type RuntimePendingCommand,
  type RuntimeReadyPayload,
  type RuntimeResumeAcceptedPayload,
  type RuntimeResumePayload,
  type RuntimeResumeResponse,
  type RuntimeRunAssignedPayload,
  type RuntimeRunCancellationState,
  type RuntimeRunEventAckPayload,
  type RuntimeRunResultAckPayload,
  type RuntimeRunResultPayload,
  type RuntimeRunSummary,
} from "./runtime-types.js";
import type { RuntimeWebSocketSessionOptions } from "./runtime-websocket.js";

export type RuntimeTransportMode = "auto" | "ws" | "pull";
export type RuntimeTransportState =
  | "disconnected"
  | "connecting_ws"
  | "ws_active"
  | "switching_to_pull"
  | "pull_active"
  | "probing_ws"
  | "switching_to_ws"
  | "stopped";

export interface RuntimeEvent {
  eventType: string;
  payload?: JsonObject | undefined;
}

export interface RuntimeHandlerError {
  code: string;
  message: string;
  retryableHint?: boolean | undefined;
}

export type RuntimeResult =
  | {
    status?: "success" | undefined;
    output?: JsonObject | undefined;
    events?: RuntimeEvent[] | undefined;
    durationMs?: number | undefined;
    error?: never;
  }
  | {
    status: "failed";
    error: RuntimeHandlerError;
    events?: RuntimeEvent[] | undefined;
    durationMs?: number | undefined;
    output?: never;
  };

export interface RuntimeCallOptions {
  idempotencyKey: string;
  reason?: string | undefined;
  metadata?: JsonObject | undefined;
}

export interface RuntimeContext {
  readonly runId: string;
  readonly agentId: string;
  readonly input: JsonObject;
  readonly metadata: JsonObject;
  readonly signal: AbortSignal;
  emit(eventType: string, payload?: JsonObject): Promise<void>;
  callAgent(
    targetAgentId: string,
    input: JsonObject,
    options: RuntimeCallOptions,
  ): Promise<RuntimeRunSummary>;
}

export type RuntimeHandler = (
  assignment: RuntimeContext,
) => RuntimeResult | Promise<RuntimeResult>;

export interface RuntimeWorkerLogger {
  debug?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface RuntimeWorkerConfig {
  platformURL?: string | undefined;
  runtimeURL?: string | undefined;
  transport?: RuntimeTransportMode | undefined;
  nodeId: string;
  nodeVersion?: string | undefined;
  agentId: string;
  agentToken: string;
  mtls?: RuntimeMTLSConfig | undefined;
  store?: RuntimeStore | undefined;
  dataDir?: string | undefined;
  allowUnsafeMemoryStore?: boolean | undefined;
  handler: RuntimeHandler;
  capacity?: number | undefined;
  claimWaitMs?: number | undefined;
  commandWaitMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  retryMinimumMs?: number | undefined;
  retryMaximumMs?: number | undefined;
  websocketProbeIntervalMs?: number | undefined;
  shutdownTimeoutMs?: number | undefined;
  logger?: RuntimeWorkerLogger | undefined;
}

/** Strict protocol surface used by RuntimeWorker and by deterministic fakes. */
export interface RuntimeWorkerClient {
  createRuntimeSession(hello: RuntimeHelloPayload, options?: RequestOptions): Promise<RuntimeReadyPayload>;
  heartbeatRuntimeSession(hello: RuntimeHelloPayload, options?: RequestOptions): Promise<RuntimeReadyPayload>;
  closeRuntimeSession(
    request: {
      nodeId: string;
      agentId: string;
      workerId: string;
      runtimeSessionId: string;
      sessionEpoch: number;
      status: "offline" | "closed";
      reason: string;
    },
    options?: RequestOptions,
  ): Promise<void>;
  claimRuntimeRun(
    waitSeconds: number,
    request: { runtimeSessionId: string; capacity: number; inflight: number },
    options?: RequestOptions,
  ): Promise<RuntimeRunAssignedPayload | undefined>;
  ackRuntimeAssignment(
    request: { attemptIdentity: RuntimeAttemptIdentity },
    options?: RequestOptions,
  ): Promise<RuntimeAssignmentConfirmedPayload>;
  rejectRuntimeAssignment(
    request: {
      attemptIdentity: RuntimeAttemptIdentity;
      reasonCode: "NODE_AT_CAPACITY" | "NODE_DRAINING";
      capacity: number;
      inflight: number;
    },
    options?: RequestOptions,
  ): Promise<RuntimeAssignmentRejectedPayload>;
  renewRuntimeLease(
    request: {
      attemptIdentity: RuntimeAttemptIdentity;
      lastClientEventSeq: number;
      capacity: number;
      inflight: number;
    },
    options?: RequestOptions,
  ): Promise<RuntimeLeaseRenewedPayload>;
  appendRuntimeEvent(
    request: RuntimeStoredEvent,
    options?: RequestOptions,
  ): Promise<RuntimeRunEventAckPayload>;
  finalizeRuntimeResult(
    request: RuntimeRunResultPayload,
    options?: RequestOptions,
  ): Promise<RuntimeRunResultAckPayload>;
  resumeRuntimeRuns(request: RuntimeResumePayload, options?: RequestOptions): Promise<RuntimeResumeResponse>;
  pollRuntimeCommands(
    runtimeSessionId: string,
    waitSeconds: number,
    options?: RequestOptions,
  ): Promise<RuntimeCommandsResponse>;
  ackRuntimeCancel(
    request: {
      cancellationId: string;
      attemptIdentity: RuntimeAttemptIdentity;
      cancelState: "delivered" | "stopping" | "stopped" | "unsupported" | "failed";
      errorCode?: string;
    },
    options?: RequestOptions,
  ): Promise<RuntimeRunCancellationState>;
  callRuntimeAgent(
    authorization: { invocationContext: string; token: string; idempotencyKey: string },
    request: { targetAgentId: string; input: JsonObject; metadata?: JsonObject; reason?: string },
    options?: RequestOptions,
  ): Promise<RuntimeRunSummary>;
}

export interface RuntimeWorkerDuplex {
  readonly ready: RuntimeReadyPayload;
  readonly done: Promise<void>;
  ackAssignment(identity: RuntimeAttemptIdentity): Promise<RuntimeAssignmentConfirmedPayload>;
  rejectAssignment(
    identity: RuntimeAttemptIdentity,
    reasonCode: "NODE_AT_CAPACITY" | "NODE_DRAINING",
    capacity: number,
    inflight: number,
  ): Promise<RuntimeAssignmentRejectedPayload>;
  renewLease(
    identity: RuntimeAttemptIdentity,
    lastClientEventSeq: number,
    capacity: number,
    inflight: number,
  ): Promise<RuntimeLeaseRenewedPayload>;
  appendEvent(event: RuntimeStoredEvent): Promise<RuntimeRunEventAckPayload>;
  finalizeResult(result: RuntimeRunResultPayload): Promise<RuntimeRunResultAckPayload>;
  resume(request: RuntimeResumePayload): Promise<RuntimeResumeAcceptedPayload[]>;
  ackCancel(request: {
    cancellationId: string;
    attemptIdentity: RuntimeAttemptIdentity;
    cancelState: "delivered" | "stopping" | "stopped" | "unsupported" | "failed";
    errorCode?: string;
  }): Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface RuntimeWorkerTransport {
  readonly http: RuntimeWorkerClient;
  dialWebSocket(
    hello: RuntimeHelloPayload,
    callbacks: Pick<RuntimeWebSocketSessionOptions, "onAssigned" | "onCommand" | "onError" | "onClose">,
    signal?: AbortSignal,
  ): Promise<RuntimeWorkerDuplex>;
  close(): Promise<void>;
}

export interface RuntimeWorkerDependencies {
  discoverRuntimeURL(platformURL: string, signal?: AbortSignal): Promise<string>;
  connectTransport(options: NodeRuntimeTransportOptions): Promise<RuntimeWorkerTransport>;
  randomUUID(): string;
  now(): number;
}

interface ActiveAttempt {
  stored: RuntimeStoredAssignment;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  startedAt: number;
  leaseExpiresAt: number;
  canceled: boolean;
  terminal: boolean;
}

interface BusinessClient {
  ackAssignment(identity: RuntimeAttemptIdentity, signal?: AbortSignal): Promise<RuntimeAssignmentConfirmedPayload>;
  rejectAssignment(
    identity: RuntimeAttemptIdentity,
    reasonCode: "NODE_AT_CAPACITY" | "NODE_DRAINING",
    capacity: number,
    inflight: number,
    signal?: AbortSignal,
  ): Promise<RuntimeAssignmentRejectedPayload>;
  renewLease(
    identity: RuntimeAttemptIdentity,
    lastClientEventSeq: number,
    capacity: number,
    inflight: number,
    signal?: AbortSignal,
  ): Promise<RuntimeLeaseRenewedPayload>;
  appendEvent(event: RuntimeStoredEvent, signal?: AbortSignal): Promise<RuntimeRunEventAckPayload>;
  finalizeResult(result: RuntimeRunResultPayload, signal?: AbortSignal): Promise<RuntimeRunResultAckPayload>;
  resume(request: RuntimeResumePayload, signal?: AbortSignal): Promise<RuntimeResumeAcceptedPayload[]>;
  ackCancel(
    request: {
      cancellationId: string;
      attemptIdentity: RuntimeAttemptIdentity;
      cancelState: "delivered" | "stopping" | "stopped" | "unsupported" | "failed";
      errorCode?: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

const defaultDependencies: RuntimeWorkerDependencies = {
  discoverRuntimeURL: (platformURL, signal) => discoverRuntimeURL(platformURL, { signal }),
  connectTransport: async (options) => {
    const node = await NodeRuntimeTransport.connect(options);
    return {
      http: node.client,
      dialWebSocket: async (hello, callbacks, signal) => {
        const connection = await node.dialWebSocket(hello, callbacks, signal);
        return {
          ready: connection.ready,
          done: connection.done,
          ackAssignment: (identity) => connection.session.ackAssignment({ attemptIdentity: identity }),
          rejectAssignment: (identity, reasonCode, capacity, inflight) =>
            connection.session.rejectAssignment({ attemptIdentity: identity, reasonCode, capacity, inflight }),
          renewLease: (identity, lastClientEventSeq, capacity, inflight) =>
            connection.session.renewLease({ attemptIdentity: identity, lastClientEventSeq, capacity, inflight }),
          appendEvent: (event) => connection.session.appendEvent(event),
          finalizeResult: (result) => connection.session.finalizeResult(result),
          resume: (request) => connection.session.resume(request),
          ackCancel: async (request) => connection.session.ackCancel(request),
          close: connection.close,
        };
      },
      close: () => node.close(),
    };
  },
  randomUUID,
  now: Date.now,
};

/**
 * Reliable, single-use Runtime Worker. A fresh instance is required for each
 * process session so a handler can never be re-entered after an uncertain
 * started boundary.
 */
export class RuntimeWorker {
  private readonly config: Readonly<RequiredTimingConfig & RuntimeWorkerConfig>;
  private readonly dependencies: RuntimeWorkerDependencies;
  private readonly stopSignal = deferred<void>();
  private readonly doneSignal = deferred<void>();
  private readonly fatalSignal = deferred<Error>();
  private readonly runtimeAbort = new AbortController();
  private modeAbort = new AbortController();
  private spoolSignal = new AsyncSignal();
  private store: RuntimeStore | undefined;
  private transport: RuntimeWorkerTransport | undefined;
  private duplex: RuntimeWorkerDuplex | undefined;
  private ready: RuntimeReadyPayload | undefined;
  private identityValue: RuntimeWorkerIdentity | undefined;
  private activeMode: "ws" | "pull" | undefined;
  private transportStateValue: RuntimeTransportState = "disconnected";
  private started = false;
  private completed = false;
  private draining = false;
  private stopping = false;
  private fatalReported = false;
  private loops: Promise<void>[] = [];
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly reservations = new Set<string>();
  private readonly assignmentQueues = new Map<string, Promise<void>>();
  private readonly cancellations = new Set<string>();

  constructor(
    config: RuntimeWorkerConfig,
    dependencies: Partial<RuntimeWorkerDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.config = Object.freeze(normalizeConfig(config));
  }

  get transportState(): RuntimeTransportState {
    return this.transportStateValue;
  }

  get identity(): RuntimeWorkerIdentity | undefined {
    return this.identityValue ? { ...this.identityValue } : undefined;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.started || this.completed) {
      throw new Error("RuntimeWorker is single-use and cannot be restarted");
    }
    this.started = true;
    const onAbort = () => this.requestStop();
    if (signal?.aborted) this.requestStop();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let failure: Error | undefined;
    try {
      if (this.stopping) return;
      await this.startup(signal);
      this.startLoops();
      const outcome = await Promise.race([
        this.stopSignal.promise.then(() => undefined),
        this.fatalSignal.promise.then((error) => error),
      ]);
      if (outcome instanceof Error) failure = outcome;
    } catch (error) {
      failure = asError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        await this.shutdown();
      } catch (error) {
        failure ??= asError(error);
      }
      this.completed = true;
      this.doneSignal.resolve();
    }
    if (failure) throw failure;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.requestStop();
    await this.doneSignal.promise;
  }

  private requestStop(): void {
    this.draining = true;
    this.stopping = true;
    this.stopSignal.resolve();
  }

  private async startup(signal?: AbortSignal): Promise<void> {
    const config = this.config;
    this.store = config.store ?? new FileRuntimeStore(config.dataDir!);
    if (!this.store.durable && !config.allowUnsafeMemoryStore) {
      throw new Error("MemoryRuntimeStore requires allowUnsafeMemoryStore: true");
    }
    await this.store.open();
    this.identityValue = await this.store.beginSession();

    const runtimeURL = config.runtimeURL
      ? validateRuntimeURL(config.runtimeURL)
      : await this.dependencies.discoverRuntimeURL(config.platformURL!, signal);
    this.transport = await this.dependencies.connectTransport({
      runtimeURL,
      agentToken: config.agentToken,
      mtls: config.mtls!,
    });

    if (config.transport !== "pull") {
      try {
        await this.activateWebSocket(false, signal);
        return;
      } catch (error) {
        if (config.transport === "ws") throw error;
        this.log("warn", `Runtime WebSocket unavailable; recovering with pull (${safeError(error)})`);
      }
    }
    await this.activatePull(false, signal);
  }

  private startLoops(): void {
    const run = (operation: () => Promise<void>) => {
      const promise = operation().catch((error) => {
        if (!isAbortError(error) && !this.stopping) this.reportFatal(asError(error));
      });
      this.loops.push(promise);
    };
    run(() => this.claimLoop());
    run(() => this.commandLoop());
    run(() => this.heartbeatLoop());
    run(() => this.leaseLoop());
    run(() => this.spoolLoop());
    if (this.config.transport === "auto") run(() => this.transportSupervisor());
    if (this.config.transport === "ws") run(() => this.requiredWebSocketLoop());
  }

  private async activatePull(reconnect: boolean, signal?: AbortSignal): Promise<void> {
    const transport = this.requiredTransport();
    this.transportStateValue = "switching_to_pull";
    this.replaceModeAbort();
    this.activeMode = undefined;
    this.duplex?.close(1012, "Switching to pull");
    this.duplex = undefined;
    const ready = await this.retry(
      (callSignal) => transport.http.createRuntimeSession(this.hello(), { signal: callSignal }),
      signal ?? this.runtimeAbort.signal,
      true,
    );
    this.ready = ready;
    await this.resumeDurableState(httpBusiness(transport.http), reconnect, signal, true);
    this.activeMode = "pull";
    this.transportStateValue = "pull_active";
    this.replaceModeAbort();
  }

  private async activateWebSocket(reconnect: boolean, signal?: AbortSignal): Promise<void> {
    const transport = this.requiredTransport();
    this.transportStateValue = this.activeMode === "pull" ? "probing_ws" : "connecting_ws";
    const queuedAssignments: RuntimeRunAssignedPayload[] = [];
    const queuedCommands: RuntimePendingCommand[] = [];
    let activated = false;
    const dial = (callSignal: AbortSignal) => transport.dialWebSocket(this.hello(), {
      onAssigned: (assignment) => {
        if (activated) this.enqueueAssignment(assignment);
        else queuedAssignments.push(assignment);
      },
      onCommand: (command) => {
        if (activated) return this.handleCommand(command);
        queuedCommands.push(command);
      },
      onError: (error) => this.log("warn", `Runtime WebSocket error (${safeError(error)})`),
    }, callSignal);
    const duplex = this.config.transport === "ws"
      ? await this.retry(dial, signal, true)
      : await this.retryInitialAttachConflict(dial, signal);
    this.transportStateValue = "switching_to_ws";
    this.replaceModeAbort();
    this.activeMode = undefined;
    const business = duplexBusiness(duplex);
    try {
      await this.resumeDurableState(business, reconnect, signal, false);
    } catch (error) {
      duplex.close(1011, "Runtime resume failed");
      throw error;
    }
    this.duplex?.close(1012, "Runtime transport replaced");
    this.duplex = duplex;
    this.ready = duplex.ready;
    this.activeMode = "ws";
    this.transportStateValue = "ws_active";
    this.replaceModeAbort();
    activated = true;
    for (const assignment of queuedAssignments) this.enqueueAssignment(assignment);
    for (const command of queuedCommands) {
      void this.handleCommand(command).catch((error) => this.reportFatal(asError(error)));
    }
  }

  private async requiredWebSocketLoop(): Promise<void> {
    const duplex = this.duplex;
    if (!duplex) throw new Error("Runtime WebSocket transport is unavailable");
    await Promise.race([duplex.done, abortPromise(this.runtimeAbort.signal)]);
    if (!this.runtimeAbort.signal.aborted) {
      throw new Error("Runtime WebSocket transport closed");
    }
  }

  private async transportSupervisor(): Promise<void> {
    while (!this.runtimeAbort.signal.aborted) {
      if (this.activeMode === "ws" && this.duplex) {
        await Promise.race([
          this.duplex.done,
          abortPromise(this.runtimeAbort.signal),
        ]).catch(() => undefined);
        if (this.runtimeAbort.signal.aborted) return;
        try {
          await this.activatePull(true);
        } catch (error) {
          this.reportFatal(asError(error));
          return;
        }
        continue;
      }
      await sleep(this.config.websocketProbeIntervalMs, this.runtimeAbort.signal).catch(() => undefined);
      if (this.runtimeAbort.signal.aborted) return;
      try {
        await this.activateWebSocket(true);
      } catch (error) {
        this.log("debug", `Runtime WebSocket probe failed (${safeError(error)})`);
        if (this.activeMode !== "pull") {
          try {
            await this.activatePull(true);
          } catch (pullError) {
            this.reportFatal(asError(pullError));
            return;
          }
        } else {
          this.transportStateValue = "pull_active";
        }
      }
    }
  }

  private async claimLoop(): Promise<void> {
    let failures = 0;
    while (!this.runtimeAbort.signal.aborted) {
      if (this.activeMode !== "pull" || this.draining || !this.requiredStore().acceptsNewRuns()) {
        await sleep(50, this.runtimeAbort.signal);
        continue;
      }
      const { capacity, inflight } = this.capacitySnapshot();
      if (inflight >= capacity) {
        await sleep(50, this.runtimeAbort.signal);
        continue;
      }
      const signal = combinedSignal(this.runtimeAbort.signal, this.modeAbort.signal);
      try {
        const assignment = await this.requiredTransport().http.claimRuntimeRun(
          durationSeconds(this.config.claimWaitMs),
          { runtimeSessionId: this.requiredIdentity().runtimeSessionId, capacity, inflight },
          { signal },
        );
        failures = 0;
        if (assignment) this.enqueueAssignment(assignment);
      } catch (error) {
        if (signal.aborted) continue;
        if (isPermanentRuntimeError(error)) throw error;
        await this.backoff(failures++);
      }
    }
  }

  private enqueueAssignment(assignment: RuntimeRunAssignedPayload): void {
    const attemptId = assignment.attemptIdentity.attemptId;
    if (!this.reservations.has(attemptId) && !this.active.has(attemptId) &&
      !this.draining && (this.store?.acceptsNewRuns() ?? false) &&
      this.active.size + this.reservations.size < this.config.capacity) {
      this.reservations.add(attemptId);
    }
    const previous = this.assignmentQueues.get(attemptId) ?? Promise.resolve();
    const next = previous.then(() => this.handleAssignment(assignment)).finally(() => {
      this.reservations.delete(attemptId);
    });
    this.assignmentQueues.set(attemptId, next);
    void next.catch((error) => {
      if (!this.stopping && !isAbortError(error)) this.reportFatal(asError(error));
    }).finally(() => {
      if (this.assignmentQueues.get(attemptId) === next) this.assignmentQueues.delete(attemptId);
    });
  }

  private async handleAssignment(assignment: RuntimeRunAssignedPayload): Promise<void> {
    assertAssignmentIdentity(assignment.attemptIdentity, this.config, this.requiredIdentity());
    const store = this.requiredStore();
    if (!store.acceptsNewRuns()) {
      await this.rejectWithoutStore(assignment.attemptIdentity, "NODE_AT_CAPACITY");
      return;
    }
    let stored: RuntimeStoredAssignment;
    try {
      stored = await store.saveAssignment(assignment);
    } catch (error) {
      if (error instanceof RuntimeStoreError && error.code === "CAPACITY") {
        await this.rejectWithoutStore(assignment.attemptIdentity, "NODE_AT_CAPACITY");
        return;
      }
      throw error;
    }
    if (stored.state === "started" || stored.state === "finished") {
      await this.retry((signal) => this.business().ackAssignment(assignment.attemptIdentity, signal));
      return;
    }
    if (stored.state !== "received" && stored.state !== "ack_sent" && stored.state !== "confirmed") return;
    const admitted = this.reservations.has(assignment.attemptIdentity.attemptId);
    const snapshot = this.capacitySnapshot();
    if (stored.state === "received" && (this.draining || !admitted)) {
      const reason = this.draining ? "NODE_DRAINING" : "NODE_AT_CAPACITY";
      await store.transitionAssignment(assignment.attemptIdentity.attemptId, "reject_sent");
      await this.retry((signal) => this.business().rejectAssignment(
        assignment.attemptIdentity,
        reason,
        snapshot.capacity,
        snapshot.inflight,
        signal,
      ));
      await store.transitionAssignment(assignment.attemptIdentity.attemptId, "rejected");
      await store.deleteAssignment(assignment.attemptIdentity.attemptId);
      return;
    }
    if (stored.state === "received") {
      stored = await store.transitionAssignment(assignment.attemptIdentity.attemptId, "ack_sent");
    }
    if (stored.state === "ack_sent") {
      const confirmed = await this.retry(
        (signal) => this.business().ackAssignment(assignment.attemptIdentity, signal),
      );
      assertIdentityEqual(assignment.attemptIdentity, confirmed.attemptIdentity, "assignment confirmation");
      if (Date.parse(confirmed.leaseExpiresAt) <= this.dependencies.now()) {
        throw new Error("Runtime assignment confirmation has an expired lease");
      }
      stored = await store.transitionAssignment(assignment.attemptIdentity.attemptId, "confirmed", {
        leaseExpiresAt: confirmed.leaseExpiresAt,
      });
    }
    if (stored.state === "confirmed" && !this.stopping) await this.startConfirmedAttempt(stored);
  }

  private async rejectWithoutStore(
    identity: RuntimeAttemptIdentity,
    reason: "NODE_AT_CAPACITY" | "NODE_DRAINING",
  ): Promise<void> {
    const snapshot = this.capacitySnapshot();
    await this.retry((signal) => this.business().rejectAssignment(
      identity,
      reason,
      snapshot.capacity,
      snapshot.inflight,
      signal,
    ));
  }

  private async startConfirmedAttempt(stored: RuntimeStoredAssignment): Promise<void> {
    const attemptId = stored.assignment.attemptIdentity.attemptId;
    if (this.active.has(attemptId)) return;
    if (stored.state !== "confirmed") throw new Error("Runtime handler requires a confirmed assignment");
    stored = await this.requiredStore().transitionAssignment(attemptId, "started");
    const controller = new AbortController();
    const done = deferred<void>();
    const active: ActiveAttempt = {
      stored,
      controller,
      done: done.promise,
      resolveDone: done.resolve,
      startedAt: this.dependencies.now(),
      leaseExpiresAt: Date.parse(stored.leaseExpiresAt ?? stored.assignment.attemptDeadlineAt),
      canceled: false,
      terminal: false,
    };
    this.active.set(attemptId, active);
    void this.executeAttempt(active).catch((error) => this.reportFatal(asError(error)));
  }

  private async executeAttempt(active: ActiveAttempt): Promise<void> {
    const assignment = active.stored.assignment;
    const attemptId = assignment.attemptIdentity.attemptId;
    const deadline = Math.min(
      Date.parse(assignment.attemptDeadlineAt),
      Date.parse(assignment.runDeadlineAt),
    );
    const deadlineTimer = setTimeout(() => {
      active.controller.abort(new RuntimeAttemptError("RUN_DEADLINE_EXCEEDED", "Run deadline exceeded"));
    }, Math.max(0, deadline - this.dependencies.now()));
    let result: RuntimeResult;
    try {
      const context = this.runtimeContext(active);
      result = await this.config.handler(context);
      for (const event of result.events ?? []) {
        await context.emit(event.eventType, event.payload ?? {});
      }
      if (active.controller.signal.aborted) throw active.controller.signal.reason;
      validateHandlerResult(result);
    } catch (error) {
      const runtimeError = handlerFailure(error, active);
      result = { status: "failed", error: runtimeError };
    } finally {
      clearTimeout(deadlineTimer);
    }
    const durationMs = validDuration(result.durationMs)
      ? result.durationMs
      : Math.max(0, this.dependencies.now() - active.startedAt);
    const current = await this.requiredStore().getAssignment(attemptId);
    if (!current || current.state === "revoked") {
      active.terminal = true;
      this.active.delete(attemptId);
      active.resolveDone();
      return;
    }
    const payload: RuntimeRunResultPayload = result.status === "failed"
      ? {
        attemptIdentity: assignment.attemptIdentity,
        resultId: this.dependencies.randomUUID(),
        durationMs,
        finalClientEventSeq: current.lastClientEventSeq,
        status: "failed",
        error: {
          errorCode: boundedCode(result.error.code),
          message: boundedMessage(result.error.message),
          ...(result.error.retryableHint !== undefined
            ? { retryableHint: result.error.retryableHint }
            : {}),
        },
      }
      : {
        attemptIdentity: assignment.attemptIdentity,
        resultId: this.dependencies.randomUUID(),
        durationMs,
        finalClientEventSeq: current.lastClientEventSeq,
        status: "success",
        output: result.output ?? {},
      };
    await this.requiredStore().saveResult(payload);
    active.terminal = true;
    this.active.delete(attemptId);
    active.resolveDone();
    this.spoolSignal.notify();
  }

  private runtimeContext(active: ActiveAttempt): RuntimeContext {
    const assignment = active.stored.assignment;
    return {
      runId: assignment.attemptIdentity.runId,
      agentId: assignment.attemptIdentity.agentId,
      input: cloneJSON(assignment.input),
      metadata: cloneJSON(assignment.metadata ?? {}),
      signal: active.controller.signal,
      emit: async (eventType, payload = {}) => {
        if (active.controller.signal.aborted || active.terminal) throw abortError(active.controller.signal);
        await this.requiredStore().appendEvent(assignment.attemptIdentity, eventType, payload);
        this.spoolSignal.notify();
      },
      callAgent: async (targetAgentId, input, options) => {
        if (active.controller.signal.aborted || active.terminal) throw abortError(active.controller.signal);
        assertIdempotencyKey(options.idempotencyKey);
        return this.requiredTransport().http.callRuntimeAgent({
          invocationContext: assignment.nodeEnvelope,
          token: assignment.agentInvocationToken,
          idempotencyKey: options.idempotencyKey,
        }, {
          targetAgentId,
          input,
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        }, { signal: active.controller.signal });
      },
    };
  }

  private async spoolLoop(): Promise<void> {
    let failures = 0;
    while (!this.runtimeAbort.signal.aborted) {
      try {
        const progressed = await this.flushSpool();
        failures = 0;
        if (!progressed) await this.spoolSignal.wait(100, this.runtimeAbort.signal);
      } catch (error) {
        if (isAbortError(error)) return;
        if (isPermanentRuntimeError(error)) throw error;
        await this.backoff(failures++);
      }
    }
  }

  private async flushSpool(): Promise<boolean> {
    if (!this.activeMode) return false;
    let progressed = false;
    const store = this.requiredStore();
    for (const assignment of await store.listAssignments()) {
      const attemptId = assignment.assignment.attemptIdentity.attemptId;
      if (assignment.state !== "started" && assignment.state !== "finished") continue;
      for (const event of await store.listPendingEvents(attemptId)) {
        const ack = await this.business().appendEvent(event, this.runtimeAbort.signal);
        if (ack.clientEventId !== event.clientEventId || ack.clientEventSeq !== event.clientEventSeq) {
          throw new Error("Runtime Event ACK identity mismatch");
        }
        await store.ackEvent(attemptId, event.clientEventId, event.clientEventSeq);
        progressed = true;
      }
      const result = await store.getPendingResult(attemptId);
      if (!result) continue;
      let ack: RuntimeRunResultAckPayload;
      try {
        ack = await this.business().finalizeResult(result.payload, this.runtimeAbort.signal);
      } catch (error) {
        if (runtimeErrorCode(error) !== "EVENTS_MISSING") throw error;
        const ranges = missingEventRanges(error);
        if (ranges.length === 0) {
          throw new Error("Runtime Result reported missing Events without replay ranges");
        }
        for (const event of await store.listEventsInRanges(attemptId, ranges)) {
          const eventAck = await this.business().appendEvent(event, this.runtimeAbort.signal);
          if (eventAck.clientEventId !== event.clientEventId ||
            eventAck.clientEventSeq !== event.clientEventSeq) {
            throw new Error("Runtime replay Event ACK identity mismatch");
          }
          await store.ackEvent(attemptId, event.clientEventId, event.clientEventSeq);
        }
        progressed = true;
        continue;
      }
      if (ack.resultId !== result.payload.resultId) throw new Error("Runtime Result ACK identity mismatch");
      await store.ackResult(attemptId, result.payload.resultId);
      await store.deleteAssignment(attemptId);
      progressed = true;
    }
    return progressed;
  }

  private async resumeDurableState(
    business: BusinessClient,
    reconnect: boolean,
    signal?: AbortSignal,
    retryTransport = true,
  ): Promise<void> {
    const store = this.requiredStore();
    const assignments = await store.listAssignments();
    if (assignments.length === 0) return;
    const attempts = await Promise.all(assignments.map(async (assignment) => {
      const attemptId = assignment.assignment.attemptIdentity.attemptId;
      const events = await store.listPendingEvents(attemptId);
      const result = await store.getPendingResult(attemptId);
      return {
        attemptIdentity: assignment.assignment.attemptIdentity,
        lastAckedClientEventSeq: assignment.ackedClientEventSeq,
        pendingClientEventRanges: eventRanges(events),
        ...(result ? {
          pendingResultId: result.payload.resultId,
          finalClientEventSeq: result.payload.finalClientEventSeq,
        } : {}),
      };
    }));
    const request: RuntimeResumePayload = {
      nodeId: this.config.nodeId,
      agentId: this.config.agentId,
      workerId: this.requiredIdentity().workerId,
      runtimeSessionId: this.requiredIdentity().runtimeSessionId,
      attempts,
    };
    const decisions = retryTransport
      ? await this.retry((callSignal) => business.resume(request, callSignal), signal)
      : await business.resume(request, signal);
    if (decisions.length !== assignments.length) throw new Error("Runtime resume response count mismatch");
    for (let index = 0; index < decisions.length; index += 1) {
      const decision = decisions[index]!;
      let assignment = assignments[index]!;
      assertIdentityEqual(
        assignment.assignment.attemptIdentity,
        decision.attemptIdentity,
        "resume response",
      );
      assertResumeDecisionCoherent(decision);
      const attemptId = assignment.assignment.attemptIdentity.attemptId;
      switch (decision.decision) {
        case RuntimeResumeDecisions.continueExecution: {
          if (assignment.state === "started") {
            const active = this.active.get(attemptId);
            if (!reconnect || !active) {
              throw new Error("Unsafe resume refused: a previous process already started this Attempt");
            }
            if (decision.leaseExpiresAt) active.leaseExpiresAt = Date.parse(decision.leaseExpiresAt);
            break;
          }
          if (assignment.state === "finished") break;
          if (assignment.state === "received") {
            assignment = await store.transitionAssignment(attemptId, "ack_sent");
          }
          if (assignment.state === "ack_sent") {
            assignment = await store.transitionAssignment(attemptId, "confirmed", {
              leaseExpiresAt: decision.leaseExpiresAt,
            });
          }
          if (assignment.state !== "confirmed") {
            throw new Error(`Runtime resume cannot continue ${assignment.state} assignment`);
          }
          if (decision.leaseExpiresAt) {
            assignment = await store.transitionAssignment(attemptId, "confirmed", {
              leaseExpiresAt: decision.leaseExpiresAt,
            });
          }
          await this.startConfirmedAttempt(assignment);
          break;
        }
        case RuntimeResumeDecisions.uploadSpoolOnly: {
          if (assignment.state === "started" && !this.active.has(attemptId)) {
            throw new Error("Unsafe spool-only resume refused without a durable Result");
          }
          const allowed = new Set(decision.allowedActions);
          const result = await store.getPendingResult(attemptId);
          if (result && !allowed.has(RuntimeResumeActions.uploadResult)) {
            throw new Error("Runtime resume denied durable Result upload");
          }
          if ((await store.listPendingEvents(attemptId)).length > 0 &&
            !allowed.has(RuntimeResumeActions.uploadEvents)) {
            throw new Error("Runtime resume denied durable Event upload");
          }
          break;
        }
        case RuntimeResumeDecisions.resultAlreadyAcked:
        case RuntimeResumeDecisions.leaseRevoked:
          await this.clearRevokedAttempt(assignment);
          break;
        default:
          throw new Error("Runtime resume returned an unknown decision");
      }
    }
    this.spoolSignal.notify();
  }

  private async clearRevokedAttempt(assignment: RuntimeStoredAssignment): Promise<void> {
    const attemptId = assignment.assignment.attemptIdentity.attemptId;
    const active = this.active.get(attemptId);
    if (active) {
      active.controller.abort(new RuntimeAttemptError("LEASE_REVOKED", "Runtime lease was revoked"));
      await active.done;
    }
    const current = await this.requiredStore().getAssignment(attemptId);
    if (!current) return;
    await this.requiredStore().revokeAttempt(attemptId);
    await this.requiredStore().deleteAssignment(attemptId);
  }

  private async commandLoop(): Promise<void> {
    let failures = 0;
    while (!this.runtimeAbort.signal.aborted) {
      if (this.activeMode !== "pull") {
        await sleep(50, this.runtimeAbort.signal);
        continue;
      }
      const signal = combinedSignal(this.runtimeAbort.signal, this.modeAbort.signal);
      try {
        const response = await this.requiredTransport().http.pollRuntimeCommands(
          this.requiredIdentity().runtimeSessionId,
          durationSeconds(this.config.commandWaitMs),
          { signal },
        );
        failures = 0;
        for (const command of response.commands) await this.handleCommand(command);
      } catch (error) {
        if (signal.aborted) continue;
        if (isPermanentRuntimeError(error)) throw error;
        await this.backoff(failures++);
      }
    }
  }

  private async handleCommand(command: RuntimePendingCommand): Promise<void> {
    if (command.type === "runtime.drain") {
      this.draining = true;
      return;
    }
    if (command.type === "run.lease.revoked") {
      const stored = await this.requiredStore().getAssignment(command.payload.attemptIdentity.attemptId);
      if (!stored || !identityEqual(stored.assignment.attemptIdentity, command.payload.attemptIdentity)) return;
      await this.clearRevokedAttempt(stored);
      return;
    }
    const cancellationKey = `${command.payload.cancellationId}\u0000${command.payload.attemptIdentity.attemptId}`;
    if (this.cancellations.has(cancellationKey)) return;
    this.cancellations.add(cancellationKey);
    try {
      const stored = await this.requiredStore().getAssignment(command.payload.attemptIdentity.attemptId);
      if (!stored || !identityEqual(stored.assignment.attemptIdentity, command.payload.attemptIdentity)) {
        await this.ackCancellation({
          cancellationId: command.payload.cancellationId,
          attemptIdentity: command.payload.attemptIdentity,
          cancelState: "stopped",
        });
        return;
      }
      const active = this.active.get(command.payload.attemptIdentity.attemptId);
      await this.ackCancellation({
        cancellationId: command.payload.cancellationId,
        attemptIdentity: command.payload.attemptIdentity,
        cancelState: active ? "stopping" : "stopped",
      });
      if (!active) {
        if (["received", "ack_sent", "confirmed"].includes(stored.state)) {
          await this.requiredStore().revokeAttempt(command.payload.attemptIdentity.attemptId);
          await this.requiredStore().deleteAssignment(command.payload.attemptIdentity.attemptId);
        }
        return;
      }
      active.canceled = true;
      active.controller.abort(new RuntimeAttemptError("RUN_CANCELED", "Run was canceled"));
      const remaining = Math.max(0, Date.parse(command.payload.deadlineAt) - this.dependencies.now());
      await settleOrTimeout(active.done, remaining);
      await this.ackCancellation({
        cancellationId: command.payload.cancellationId,
        attemptIdentity: command.payload.attemptIdentity,
        cancelState: "stopped",
      });
    } finally {
      this.cancellations.delete(cancellationKey);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.runtimeAbort.signal.aborted) {
      await sleep(this.config.heartbeatIntervalMs, this.runtimeAbort.signal);
      try {
        this.ready = await this.requiredTransport().http.heartbeatRuntimeSession(
          this.hello(),
          { signal: this.runtimeAbort.signal },
        );
      } catch (error) {
        if (isPermanentRuntimeError(error)) throw error;
        this.log("warn", `Runtime heartbeat will retry (${safeError(error)})`);
      }
    }
  }

  private ackCancellation(request: Parameters<BusinessClient["ackCancel"]>[0]): Promise<void> {
    return this.retry((signal) => this.business().ackCancel(request, signal));
  }

  private async leaseLoop(): Promise<void> {
    while (!this.runtimeAbort.signal.aborted) {
      const interval = Math.max(250, Math.min(
        this.config.heartbeatIntervalMs,
        Math.floor((this.ready?.leaseTtlSeconds ?? 30) * 1000 / 3),
      ));
      await sleep(interval, this.runtimeAbort.signal);
      for (const active of [...this.active.values()]) {
        if (active.terminal) continue;
        const assignment = await this.requiredStore().getAssignment(
          active.stored.assignment.attemptIdentity.attemptId,
        );
        if (!assignment) continue;
        const snapshot = this.capacitySnapshot();
        try {
          const renewed = await this.business().renewLease(
            assignment.assignment.attemptIdentity,
            assignment.lastClientEventSeq,
            snapshot.capacity,
            snapshot.inflight,
            this.runtimeAbort.signal,
          );
          active.leaseExpiresAt = Date.parse(renewed.leaseExpiresAt);
          await this.requiredStore().transitionAssignment(
            assignment.assignment.attemptIdentity.attemptId,
            "started",
            { leaseExpiresAt: renewed.leaseExpiresAt },
          );
          if (renewed.pendingCommand) await this.handleCommand(renewed.pendingCommand);
        } catch (error) {
          if (runtimeErrorCode(error) === "STALE_LEASE" || runtimeErrorCode(error) === "LEASE_EXPIRED") {
            await this.clearRevokedAttempt(assignment);
            continue;
          }
          if (this.dependencies.now() >= active.leaseExpiresAt) {
            active.controller.abort(new RuntimeAttemptError("LEASE_EXPIRED", "Runtime lease expired"));
            throw error;
          }
          this.log("warn", `Runtime lease renewal will retry (${safeError(error)})`);
        }
      }
    }
  }

  private async shutdown(): Promise<void> {
    this.draining = true;
    if (this.transport && this.identityValue) {
      try {
        await this.transport.http.heartbeatRuntimeSession(this.hello(), {
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // Best effort: capacity zero is also represented by the session close.
      }
    }
    const activeDone = Promise.allSettled([...this.active.values()].map((attempt) => attempt.done));
    await settleOrTimeout(activeDone, this.config.shutdownTimeoutMs);
    for (const active of this.active.values()) {
      active.controller.abort(new RuntimeAttemptError("WORKER_SHUTDOWN", "Runtime Worker is shutting down"));
    }
    await settleOrTimeout(activeDone, 2_000);
    if (this.transport && this.identityValue) {
      try {
        await this.transport.http.closeRuntimeSession({
          nodeId: this.config.nodeId,
          agentId: this.config.agentId,
          workerId: this.identityValue.workerId,
          runtimeSessionId: this.identityValue.runtimeSessionId,
          sessionEpoch: this.identityValue.sessionEpoch,
          status: "closed",
          reason: "node_shutdown",
        }, { signal: AbortSignal.timeout(2_000) });
      } catch {
        // Durable state is intentionally retained for the next resume.
      }
    }
    this.runtimeAbort.abort();
    this.modeAbort.abort();
    this.duplex?.close(1000, "Runtime Worker stopped");
    await Promise.allSettled(this.loops);
    if (this.transport) await this.transport.close();
    if (this.store) await this.store.close();
    this.transportStateValue = "stopped";
    this.activeMode = undefined;
  }

  private hello(): RuntimeHelloPayload {
    const identity = this.requiredIdentity();
    return {
      nodeId: this.config.nodeId,
      agentId: this.config.agentId,
      workerId: identity.workerId,
      runtimeSessionId: identity.runtimeSessionId,
      sessionEpoch: identity.sessionEpoch,
      nodeVersion: this.config.nodeVersion,
      capacity: this.capacitySnapshot().capacity,
      features: RuntimeRequiredFeatures,
      contractDigest: RuntimeContractDigest,
    };
  }

  private capacitySnapshot(): { capacity: number; inflight: number } {
    const inflight = this.active.size + this.reservations.size;
    const accepting = !this.draining && (this.store?.acceptsNewRuns() ?? true);
    return { capacity: accepting ? this.config.capacity : 0, inflight };
  }

  private business(): BusinessClient {
    if (this.activeMode === "ws" && this.duplex) return duplexBusiness(this.duplex);
    if (this.activeMode === "pull" && this.transport) return httpBusiness(this.transport.http);
    throw new Error("Runtime transport is switching");
  }

  private replaceModeAbort(): void {
    this.modeAbort.abort();
    this.modeAbort = new AbortController();
  }

  private async retry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
    retrySessionConflict = false,
  ): Promise<T> {
    let failures = 0;
    while (true) {
      const signal = combinedSignal(this.runtimeAbort.signal, externalSignal);
      if (signal.aborted) throw abortError(signal);
      try {
        return await operation(signal);
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        if (isPermanentRuntimeError(error) && !(
          retrySessionConflict && runtimeErrorCode(error) === "RUNTIME_SESSION_CONFLICT"
        )) throw error;
        await this.backoff(failures++, signal);
      }
    }
  }

  private async retryInitialAttachConflict<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    let failures = 0;
    while (true) {
      const signal = combinedSignal(this.runtimeAbort.signal, externalSignal);
      if (signal.aborted) throw abortError(signal);
      try {
        return await operation(signal);
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        if (runtimeErrorCode(error) !== "RUNTIME_SESSION_CONFLICT") throw error;
        await this.backoff(failures++, signal);
      }
    }
  }

  private backoff(attempt: number, signal = this.runtimeAbort.signal): Promise<void> {
    const base = Math.min(
      this.config.retryMaximumMs,
      this.config.retryMinimumMs * 2 ** Math.min(attempt, 20),
    );
    const jitter = 0.8 + Math.random() * 0.4;
    return sleep(Math.floor(base * jitter), signal);
  }

  private reportFatal(error: Error): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    this.fatalSignal.resolve(error);
  }

  private log(level: keyof RuntimeWorkerLogger, message: string): void {
    this.config.logger?.[level]?.(message);
  }

  private requiredStore(): RuntimeStore {
    if (!this.store) throw new Error("Runtime store is unavailable");
    return this.store;
  }

  private requiredTransport(): RuntimeWorkerTransport {
    if (!this.transport) throw new Error("Runtime transport is unavailable");
    return this.transport;
  }

  private requiredIdentity(): RuntimeWorkerIdentity {
    if (!this.identityValue) throw new Error("Runtime Worker identity is unavailable");
    return this.identityValue;
  }
}

interface RequiredTimingConfig {
  transport: RuntimeTransportMode;
  nodeVersion: string;
  capacity: number;
  claimWaitMs: number;
  commandWaitMs: number;
  heartbeatIntervalMs: number;
  retryMinimumMs: number;
  retryMaximumMs: number;
  websocketProbeIntervalMs: number;
  shutdownTimeoutMs: number;
}

function normalizeConfig(config: RuntimeWorkerConfig): RuntimeWorkerConfig & RequiredTimingConfig {
  const transport = (config.transport ?? "auto").toLowerCase() as RuntimeTransportMode;
  if (!(["auto", "ws", "pull"] as string[]).includes(transport)) {
    throw new Error("RuntimeWorker transport must be auto, ws, or pull");
  }
  if (!isUUID(config.nodeId)) throw new Error("RuntimeWorker nodeId must be a non-zero lowercase UUID");
  if (!isUUID(config.agentId)) throw new Error("RuntimeWorker agentId must be a non-zero lowercase UUID");
  if (!config.agentToken?.trim()) throw new Error("RuntimeWorker requires Agent Token");
  if (typeof config.handler !== "function") throw new Error("RuntimeWorker requires handler");
  if (!config.runtimeURL && !config.platformURL) throw new Error("RuntimeWorker requires platformURL or runtimeURL");
  if (config.runtimeURL) validateRuntimeURL(config.runtimeURL);
  else validatePlatformURL(config.platformURL!);
  if (!config.store && !config.dataDir?.trim()) throw new Error("RuntimeWorker requires dataDir or store");
  if (config.store instanceof MemoryRuntimeStore && !config.allowUnsafeMemoryStore) {
    throw new Error("MemoryRuntimeStore requires allowUnsafeMemoryStore: true");
  }
  if (!config.mtls?.certFile || !config.mtls.keyFile || !config.mtls.caFile) {
    throw new Error("RuntimeWorker requires mTLS cert, key, and CA files");
  }
  const capacity = boundedInteger(config.capacity ?? 1, 1, RuntimeMaxNodeCapacity, "capacity");
  const claimWaitMs = boundedInteger(config.claimWaitMs ?? 25_000, 1_000, 30_000, "claimWaitMs");
  const commandWaitMs = boundedInteger(config.commandWaitMs ?? 25_000, 1_000, 30_000, "commandWaitMs");
  const heartbeatIntervalMs = boundedInteger(
    config.heartbeatIntervalMs ?? 5_000, 250, 300_000, "heartbeatIntervalMs",
  );
  const retryMinimumMs = boundedInteger(config.retryMinimumMs ?? 250, 1, 60_000, "retryMinimumMs");
  const retryMaximumMs = boundedInteger(config.retryMaximumMs ?? 15_000, 1, 300_000, "retryMaximumMs");
  if (retryMaximumMs < retryMinimumMs) throw new Error("retryMaximumMs must not be below retryMinimumMs");
  const websocketProbeIntervalMs = boundedInteger(
    config.websocketProbeIntervalMs ?? 15_000, 100, 300_000, "websocketProbeIntervalMs",
  );
  const shutdownTimeoutMs = boundedInteger(
    config.shutdownTimeoutMs ?? 10_000, 100, 300_000, "shutdownTimeoutMs",
  );
  return {
    ...config,
    transport,
    nodeVersion: config.nodeVersion?.trim() || "openlinker-js/runtime-worker",
    capacity,
    claimWaitMs,
    commandWaitMs,
    heartbeatIntervalMs,
    retryMinimumMs,
    retryMaximumMs,
    websocketProbeIntervalMs,
    shutdownTimeoutMs,
  };
}

function httpBusiness(client: RuntimeWorkerClient): BusinessClient {
  return {
    ackAssignment: (identity, signal) => client.ackRuntimeAssignment(
      { attemptIdentity: identity }, signal ? { signal } : undefined,
    ),
    rejectAssignment: (identity, reasonCode, capacity, inflight, signal) =>
      client.rejectRuntimeAssignment(
        { attemptIdentity: identity, reasonCode, capacity, inflight },
        signal ? { signal } : undefined,
      ),
    renewLease: (identity, lastClientEventSeq, capacity, inflight, signal) =>
      client.renewRuntimeLease(
        { attemptIdentity: identity, lastClientEventSeq, capacity, inflight },
        signal ? { signal } : undefined,
      ),
    appendEvent: (event, signal) => client.appendRuntimeEvent(event, signal ? { signal } : undefined),
    finalizeResult: (result, signal) => client.finalizeRuntimeResult(result, signal ? { signal } : undefined),
    resume: async (request, signal) => (await client.resumeRuntimeRuns(
      request,
      signal ? { signal } : undefined,
    )).decisions,
    ackCancel: async (request, signal) => {
      await client.ackRuntimeCancel(request, signal ? { signal } : undefined);
    },
  };
}

function duplexBusiness(client: RuntimeWorkerDuplex): BusinessClient {
  return {
    ackAssignment: (identity) => client.ackAssignment(identity),
    rejectAssignment: (identity, reasonCode, capacity, inflight) =>
      client.rejectAssignment(identity, reasonCode, capacity, inflight),
    renewLease: (identity, lastClientEventSeq, capacity, inflight) =>
      client.renewLease(identity, lastClientEventSeq, capacity, inflight),
    appendEvent: (event) => client.appendEvent(event),
    finalizeResult: (result) => client.finalizeResult(result),
    resume: (request) => client.resume(request),
    ackCancel: (request) => client.ackCancel(request),
  };
}

function eventRanges(events: RuntimeStoredEvent[]): { start: number; end: number }[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((left, right) => left.clientEventSeq - right.clientEventSeq);
  const ranges: { start: number; end: number }[] = [];
  let start = sorted[0]!.clientEventSeq;
  let end = start;
  for (const event of sorted.slice(1)) {
    if (event.clientEventSeq === end + 1) end = event.clientEventSeq;
    else {
      ranges.push({ start, end });
      start = end = event.clientEventSeq;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

function assertResumeDecisionCoherent(decision: RuntimeResumeAcceptedPayload): void {
  const actions = new Set(decision.allowedActions);
  if (actions.size !== decision.allowedActions.length) {
    throw new Error("Runtime resume response contains duplicate actions");
  }
  switch (decision.decision) {
    case RuntimeResumeDecisions.continueExecution:
      if (!decision.leaseExpiresAt || !Number.isFinite(Date.parse(decision.leaseExpiresAt)) ||
        decision.allowedActions.length !== 3 ||
        !actions.has(RuntimeResumeActions.continueExecution) ||
        !actions.has(RuntimeResumeActions.uploadEvents) ||
        !actions.has(RuntimeResumeActions.uploadResult)) {
        throw new Error("Runtime resume continue decision is incoherent");
      }
      break;
    case RuntimeResumeDecisions.uploadSpoolOnly:
      if (decision.leaseExpiresAt !== undefined || decision.allowedActions.length < 1 ||
        decision.allowedActions.length > 2 || decision.allowedActions.some(
          (action) => action !== RuntimeResumeActions.uploadEvents &&
            action !== RuntimeResumeActions.uploadResult,
        )) {
        throw new Error("Runtime resume spool decision is incoherent");
      }
      break;
    case RuntimeResumeDecisions.resultAlreadyAcked:
      if (decision.leaseExpiresAt !== undefined || decision.allowedActions.length !== 1 ||
        !actions.has(RuntimeResumeActions.clearSpool)) {
        throw new Error("Runtime resume acknowledged-Result decision is incoherent");
      }
      break;
    case RuntimeResumeDecisions.leaseRevoked:
      if (decision.leaseExpiresAt !== undefined || decision.allowedActions.length !== 2 ||
        !actions.has(RuntimeResumeActions.stopExecution) ||
        !actions.has(RuntimeResumeActions.clearSpool)) {
        throw new Error("Runtime resume lease-revoked decision is incoherent");
      }
      break;
  }
}

function assertAssignmentIdentity(
  identity: RuntimeAttemptIdentity,
  config: Readonly<RuntimeWorkerConfig>,
  worker: RuntimeWorkerIdentity,
): void {
  if (identity.nodeId !== config.nodeId || identity.agentId !== config.agentId ||
    identity.workerId !== worker.workerId || identity.runtimeSessionId !== worker.runtimeSessionId) {
    throw new Error("Runtime assignment identity does not match this Worker Session");
  }
}

function assertIdentityEqual(
  expected: RuntimeAttemptIdentity,
  actual: RuntimeAttemptIdentity,
  operation: string,
): void {
  if (!identityEqual(expected, actual)) throw new Error(`Runtime ${operation} identity mismatch`);
}

function identityEqual(left: RuntimeAttemptIdentity, right: RuntimeAttemptIdentity): boolean {
  return left.runId === right.runId && left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId && left.fencingToken === right.fencingToken &&
    left.nodeId === right.nodeId && left.agentId === right.agentId &&
    left.workerId === right.workerId && left.runtimeSessionId === right.runtimeSessionId;
}

function validateHandlerResult(result: RuntimeResult): void {
  if (!result || typeof result !== "object") throw new Error("Runtime handler must return a Result object");
  if (result.status === "failed") {
    if (!result.error?.code?.trim() || !result.error.message?.trim()) {
      throw new Error("Failed Runtime Result requires error code and message");
    }
    return;
  }
  assertJSONObject(result.output ?? {}, "Runtime Result output");
}

function handlerFailure(error: unknown, active: ActiveAttempt): RuntimeHandlerError {
  if (error instanceof RuntimeAttemptError) return { code: error.code, message: error.message };
  if (active.controller.signal.reason instanceof RuntimeAttemptError) {
    const reason = active.controller.signal.reason;
    return { code: reason.code, message: reason.message };
  }
  return {
    code: active.canceled ? "RUN_CANCELED" : "HANDLER_FAILED",
    message: active.canceled ? "Run was canceled" : boundedMessage(asError(error).message || "Handler failed"),
  };
}

class RuntimeAttemptError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeAttemptError";
  }
}

function isPermanentRuntimeError(error: unknown): boolean {
  const code = runtimeErrorCode(error);
  if ([
    "UNAUTHORIZED", "FORBIDDEN", "PERMISSION_DENIED", "RUNTIME_CLIENT_UPGRADE_REQUIRED",
    "RUNTIME_REQUIRED_FEATURE_MISSING", "RUNTIME_SESSION_CONFLICT",
  ].includes(code)) return true;
  return error instanceof OpenLinkerError && error.status >= 400 && error.status < 500 &&
    ![408, 409, 429].includes(error.status);
}

function runtimeErrorCode(error: unknown): string {
  if (error instanceof OpenLinkerError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "";
}

function missingEventRanges(error: unknown): { start: number; end: number }[] {
  if (!(error instanceof OpenLinkerError) || typeof error.details !== "object" ||
    error.details === null || !("missingEventRanges" in error.details) ||
    !Array.isArray((error.details as { missingEventRanges?: unknown }).missingEventRanges)) {
    return [];
  }
  return (error.details as { missingEventRanges: unknown[] }).missingEventRanges.map((range) => {
    if (typeof range !== "object" || range === null || !("start" in range) || !("end" in range)) {
      return { start: Number.NaN, end: Number.NaN };
    }
    return {
      start: Number((range as { start: unknown }).start),
      end: Number((range as { end: unknown }).end),
    };
  });
}

function safeError(error: unknown): string {
  const code = runtimeErrorCode(error);
  return code || asError(error).name || "transport error";
}

function boundedCode(value: string): string {
  const normalized = value.trim().replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 100);
  return normalized || "HANDLER_FAILED";
}

function boundedMessage(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1_000) || "Runtime handler failed";
}

function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function assertIdempotencyKey(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error("RuntimeContext.callAgent requires a 1-255 character idempotencyKey");
  }
}

function assertJSONObject(value: unknown, label: string): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  JSON.stringify(value);
}

function durationSeconds(milliseconds: number): number {
  return Math.max(0, Math.min(30, Math.floor(milliseconds / 1_000)));
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`RuntimeWorker ${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function settleOrTimeout(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 1 ? available[0]! : AbortSignal.any(available);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class AsyncSignal {
  private generation = deferred<void>();

  notify(): void {
    this.generation.resolve();
  }

  async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    const current = this.generation;
    await Promise.race([current.promise, sleep(milliseconds, signal)]);
    if (this.generation === current) this.generation = deferred<void>();
  }
}
