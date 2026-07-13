import {
  decodeRuntimeAssignment,
  decodeRuntimeAssignmentConfirmed,
  decodeRuntimeAssignmentRejected,
  decodeRuntimeEnvelope,
  decodeRuntimeErrorEnvelope,
  decodeRuntimeEventAck,
  decodeRuntimeLeaseRenewed,
  decodeRuntimePendingCommand,
  decodeRuntimeReady,
  decodeRuntimeResultAck,
  decodeRuntimeResumeAccepted,
  encodeRuntimeAssignmentAck,
  encodeRuntimeAssignmentReject,
  encodeRuntimeCancelAck,
  encodeRuntimeEnvelope,
  encodeRuntimeEvent,
  encodeRuntimeHello,
  encodeRuntimeLeaseRenew,
  encodeRuntimeResult,
  encodeRuntimeResume,
  runtimeAttemptIdentityEqual,
  type RuntimeDecodedEnvelope,
} from "./runtime-codec.js";
import {
  RuntimeMaxMessageBytes,
  RuntimeMessageTypes,
  type RuntimeAssignmentAckPayload,
  type RuntimeAssignmentConfirmedPayload,
  type RuntimeAssignmentRejectPayload,
  type RuntimeAssignmentRejectedPayload,
  type RuntimeAttemptIdentity,
  type RuntimeHelloPayload,
  type RuntimeLeaseRenewedPayload,
  type RuntimeLeaseRenewPayload,
  type RuntimeMessageType,
  type RuntimePendingCommand,
  type RuntimeReadyPayload,
  type RuntimeResumeAcceptedPayload,
  type RuntimeResumePayload,
  type RuntimeRunAssignedPayload,
  type RuntimeRunCancelAckPayload,
  type RuntimeRunEventAckPayload,
  type RuntimeRunEventPayload,
  type RuntimeRunResultAckPayload,
  type RuntimeRunResultPayload,
} from "./runtime-types.js";

export interface RuntimeWebSocketLike {
  readonly readyState: number;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RuntimeWebSocketSessionOptions {
  requestTimeoutMs?: number;
  onAssigned?: (assignment: RuntimeRunAssignedPayload) => void | Promise<void>;
  onCommand?: (command: RuntimePendingCommand) => void | Promise<void>;
  onError?: (error: Error) => void;
  onClose?: (event: { code: number; reason: string; clean: boolean }) => void;
}

type PendingRequest<T> = {
  expected: ReadonlySet<RuntimeMessageType>;
  remaining: number;
  values: T[];
  decode: (envelope: RuntimeDecodedEnvelope) => T;
  resolve: (values: T[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RuntimeWebSocketError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly closeCode?: number,
  ) {
    super(message);
    this.name = "RuntimeWebSocketError";
  }
}

/**
 * Strict Runtime WebSocket protocol session over an already authenticated
 * socket. The caller owns TLS, the Node client certificate, and the Agent Token
 * used during the HTTP upgrade; credentials are never placed in the URL.
 *
 * Durable workers must persist assignments before ACK and persist Events and
 * Results before calling these methods. This class deliberately provides no
 * in-memory execution queue or automatic task replay.
 */
export class RuntimeWebSocketSession {
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly assignmentMessages = new Map<string, string>();
  private readonly cancellationMessages = new Map<string, string>();
  private inbound = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(
    private readonly socket: RuntimeWebSocketLike,
    private readonly options: RuntimeWebSocketSessionOptions = {},
  ) {
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
      throw new Error("OpenLinker Runtime: WebSocket requestTimeoutMs is invalid");
    }
    this.requestTimeoutMs = timeout;
  }

  async start(hello: RuntimeHelloPayload): Promise<RuntimeReadyPayload> {
    if (this.started || this.closed) {
      throw new Error("OpenLinker Runtime: WebSocket session already started or closed");
    }
    if (this.socket.readyState !== 1) {
      throw new Error("OpenLinker Runtime: authenticated WebSocket is not open");
    }
    this.started = true;
    this.socket.onmessage = (event) => {
      this.inbound = this.inbound
        .then(() => this.handleMessage(event.data))
        .catch((error: unknown) => this.failProtocol(asError(error)));
    };
    this.socket.onerror = () => {
      this.options.onError?.(new RuntimeWebSocketError(
        "OpenLinker Runtime: WebSocket transport error",
        "TRANSPORT_ERROR",
        true,
      ));
    };
    this.socket.onclose = (event) => this.handleClose(event);

    return this.requestOne(
      RuntimeMessageTypes.hello,
      encodeRuntimeHello(hello),
      new Set([RuntimeMessageTypes.ready]),
      (envelope) => decodeRuntimeReady(envelope.payload),
    );
  }

  ackAssignment(request: RuntimeAssignmentAckPayload): Promise<RuntimeAssignmentConfirmedPayload> {
    const replyTo = this.assignmentMessage(request.attemptIdentity);
    return this.requestOne(
      RuntimeMessageTypes.assignmentAck,
      encodeRuntimeAssignmentAck(request),
      new Set([RuntimeMessageTypes.assignmentConfirmed]),
      (envelope) => {
        const confirmed = decodeRuntimeAssignmentConfirmed(envelope.payload);
        if (!runtimeAttemptIdentityEqual(request.attemptIdentity, confirmed.attemptIdentity)) {
          throw new Error("OpenLinker Runtime: WebSocket assignment confirmation identity mismatch");
        }
        return confirmed;
      },
      replyTo,
    );
  }

  rejectAssignment(request: RuntimeAssignmentRejectPayload): Promise<RuntimeAssignmentRejectedPayload> {
    const replyTo = this.assignmentMessage(request.attemptIdentity);
    return this.requestOne(
      RuntimeMessageTypes.assignmentReject,
      encodeRuntimeAssignmentReject(request),
      new Set([RuntimeMessageTypes.assignmentRejected]),
      (envelope) => {
        const rejected = decodeRuntimeAssignmentRejected(envelope.payload);
        if (!runtimeAttemptIdentityEqual(request.attemptIdentity, rejected.attemptIdentity)) {
          throw new Error("OpenLinker Runtime: WebSocket assignment rejection identity mismatch");
        }
        return rejected;
      },
      replyTo,
    );
  }

  renewLease(request: RuntimeLeaseRenewPayload): Promise<RuntimeLeaseRenewedPayload> {
    return this.requestOne(
      RuntimeMessageTypes.leaseRenew,
      encodeRuntimeLeaseRenew(request),
      new Set([RuntimeMessageTypes.leaseRenewed]),
      (envelope) => {
        const renewed = decodeRuntimeLeaseRenewed(envelope.payload);
        if (!runtimeAttemptIdentityEqual(request.attemptIdentity, renewed.attemptIdentity)) {
          throw new Error("OpenLinker Runtime: WebSocket lease identity mismatch");
        }
        return renewed;
      },
    );
  }

  appendEvent(request: RuntimeRunEventPayload): Promise<RuntimeRunEventAckPayload> {
    return this.requestOne(
      RuntimeMessageTypes.runEvent,
      encodeRuntimeEvent(request),
      new Set([RuntimeMessageTypes.runEventAck]),
      (envelope) => {
        const ack = decodeRuntimeEventAck(envelope.payload);
        if (ack.clientEventId !== request.clientEventId || ack.clientEventSeq !== request.clientEventSeq) {
          throw new Error("OpenLinker Runtime: WebSocket Event ACK identity mismatch");
        }
        return ack;
      },
    );
  }

  finalizeResult(request: RuntimeRunResultPayload): Promise<RuntimeRunResultAckPayload> {
    return this.requestOne(
      RuntimeMessageTypes.runResult,
      encodeRuntimeResult(request),
      new Set([RuntimeMessageTypes.runResultAck]),
      (envelope) => {
        const ack = decodeRuntimeResultAck(envelope.payload);
        if (ack.resultId !== request.resultId) {
          throw new Error("OpenLinker Runtime: WebSocket Result ACK identity mismatch");
        }
        return ack;
      },
    );
  }

  async resume(request: RuntimeResumePayload): Promise<RuntimeResumeAcceptedPayload[]> {
    if (request.attempts.length < 1) {
      throw new Error("OpenLinker Runtime: WebSocket resume requires at least one Attempt");
    }
    const decisions = await this.requestMany(
      RuntimeMessageTypes.resume,
      encodeRuntimeResume(request),
      new Set([RuntimeMessageTypes.resumeAccepted]),
      request.attempts.length,
      (envelope) => decodeRuntimeResumeAccepted(envelope.payload),
    );
    const byAttempt = new Map(decisions.map((decision) => [attemptKey(decision.attemptIdentity), decision]));
    return request.attempts.map((attempt) => {
      const decision = byAttempt.get(attemptKey(attempt.attemptIdentity));
      if (!decision) {
        throw new Error("OpenLinker Runtime: WebSocket resume response identity mismatch");
      }
      return decision;
    });
  }

  ackCancel(request: RuntimeRunCancelAckPayload): void {
    const replyTo = this.cancellationMessages.get(cancelKey(request));
    if (!replyTo) {
      throw new Error("OpenLinker Runtime: cancellation command correlation is missing");
    }
    this.sendEnvelope(
      RuntimeMessageTypes.runCancelAck,
      encodeRuntimeCancelAck(request),
      replyTo,
    );
  }

  close(code = 1000, reason = "runtime node stopped"): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(code) || code < 1000 || code > 4999 || reason.length > 123) {
      throw new Error("OpenLinker Runtime: invalid WebSocket close");
    }
    this.socket.close(code, reason);
  }

  private requestOne<T>(
    type: RuntimeMessageType,
    payload: unknown,
    expected: ReadonlySet<RuntimeMessageType>,
    decode: (envelope: RuntimeDecodedEnvelope) => T,
    replyTo?: string,
  ): Promise<T> {
    return this.requestMany(type, payload, expected, 1, decode, replyTo).then((values) => {
      const value = values[0];
      if (value === undefined) throw new Error("OpenLinker Runtime: missing WebSocket reply");
      return value;
    });
  }

  private requestMany<T>(
    type: RuntimeMessageType,
    payload: unknown,
    expected: ReadonlySet<RuntimeMessageType>,
    count: number,
    decode: (envelope: RuntimeDecodedEnvelope) => T,
    replyTo?: string,
  ): Promise<T[]> {
    this.assertUsable();
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024) {
      return Promise.reject(new Error("OpenLinker Runtime: invalid WebSocket reply count"));
    }
    const messageId = runtimeUUID();
    return new Promise<T[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new RuntimeWebSocketError(
          "OpenLinker Runtime: WebSocket business ACK timed out",
          "ACK_TIMEOUT",
          true,
        ));
      }, this.requestTimeoutMs);
      const pending: PendingRequest<T> = {
        expected,
        remaining: count,
        values: [],
        decode,
        resolve,
        reject,
        timer,
      };
      this.pending.set(messageId, pending as PendingRequest<unknown>);
      try {
        this.sendEnvelope(type, payload, replyTo, messageId);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(messageId);
        reject(asError(error));
      }
    });
  }

  private sendEnvelope(
    type: RuntimeMessageType,
    payload: unknown,
    replyTo?: string,
    messageId = runtimeUUID(),
  ): void {
    this.assertUsable();
    const wire = encodeRuntimeEnvelope(type, messageId, new Date().toISOString(), payload, replyTo);
    const text = JSON.stringify(wire);
    if (new TextEncoder().encode(text).byteLength > RuntimeMaxMessageBytes) {
      throw new Error("OpenLinker Runtime: WebSocket message exceeds 4 MiB");
    }
    this.socket.send(text);
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = await messageText(data);
    if (new TextEncoder().encode(text).byteLength > RuntimeMaxMessageBytes) {
      throw new Error("OpenLinker Runtime: WebSocket message exceeds 4 MiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error("OpenLinker Runtime: WebSocket frame is not JSON", { cause });
    }
    const envelope = decodeRuntimeEnvelope(parsed);
    if (envelope.replyToMessageId) {
      this.handleReply(envelope);
      return;
    }
    switch (envelope.type) {
      case RuntimeMessageTypes.runAssigned: {
        const assignment = decodeRuntimeAssignment(envelope.payload);
        rememberBounded(this.assignmentMessages, attemptKey(assignment.attemptIdentity), envelope.messageId);
        await this.options.onAssigned?.(assignment);
        return;
      }
      case RuntimeMessageTypes.runCancel:
      case RuntimeMessageTypes.drain:
      case RuntimeMessageTypes.leaseRevoked: {
        const command = decodeRuntimePendingCommand({ type: envelope.type, payload: envelope.payload });
        if (command.type === RuntimeMessageTypes.runCancel) {
          rememberBounded(this.cancellationMessages, cancelKey(command.payload), envelope.messageId);
        }
        await this.options.onCommand?.(command);
        return;
      }
      case RuntimeMessageTypes.error: {
        const error = websocketError(envelope);
        this.options.onError?.(error);
        return;
      }
      default:
        throw new Error(`OpenLinker Runtime: unexpected uncorrelated ${envelope.type} message`);
    }
  }

  private handleReply(envelope: RuntimeDecodedEnvelope): void {
    const correlation = envelope.replyToMessageId;
    if (!correlation) throw new Error("OpenLinker Runtime: WebSocket reply has no correlation ID");
    const pending = this.pending.get(correlation);
    if (!pending) {
      throw new Error("OpenLinker Runtime: WebSocket reply references an unknown request");
    }
    if (envelope.type === RuntimeMessageTypes.error) {
      clearTimeout(pending.timer);
      this.pending.delete(correlation);
      pending.reject(websocketError(envelope));
      return;
    }
    if (!pending.expected.has(envelope.type)) {
      throw new Error(`OpenLinker Runtime: unexpected ${envelope.type} business ACK`);
    }
    const decoded = pending.decode(envelope);
    pending.values.push(decoded);
    pending.remaining -= 1;
    if (pending.remaining > 0) return;
    clearTimeout(pending.timer);
    this.pending.delete(correlation);
    pending.resolve(pending.values);
  }

  private assignmentMessage(identity: RuntimeAttemptIdentity): string {
    const messageId = this.assignmentMessages.get(attemptKey(identity));
    if (!messageId) {
      throw new Error("OpenLinker Runtime: assignment correlation is missing");
    }
    return messageId;
  }

  private assertUsable(): void {
    if (!this.started || this.closed || this.socket.readyState !== 1) {
      throw new RuntimeWebSocketError(
        "OpenLinker Runtime: WebSocket session is not open",
        "TRANSPORT_CLOSED",
        true,
      );
    }
  }

  private failProtocol(error: Error): void {
    this.options.onError?.(error);
    try {
      this.socket.close(1002, "Runtime protocol error");
    } catch {
      this.rejectPending(error);
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.closed) return;
    this.closed = true;
    const error = new RuntimeWebSocketError(
      event.reason || "OpenLinker Runtime: WebSocket closed",
      closeCodeReason(event.code),
      event.code === 1006 || event.code === 1011,
      event.code,
    );
    this.rejectPending(error);
    this.options.onClose?.({ code: event.code, reason: event.reason, clean: event.wasClean });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function websocketError(envelope: RuntimeDecodedEnvelope): RuntimeWebSocketError {
  const body = decodeRuntimeErrorEnvelope({ error: envelope.payload }).error;
  return new RuntimeWebSocketError(body.message, body.code, body.retryable ?? false);
}

function attemptKey(identity: RuntimeAttemptIdentity): string {
  return [
    identity.runId,
    identity.attemptId,
    identity.leaseId,
    identity.fencingToken,
    identity.nodeId,
    identity.agentId,
    identity.workerId,
    identity.runtimeSessionId,
  ].join("\u0000");
}

function cancelKey(value: RuntimeRunCancelAckPayload | { cancellationId: string; attemptIdentity: RuntimeAttemptIdentity }): string {
  return `${value.cancellationId}\u0000${attemptKey(value.attemptIdentity)}`;
}

function rememberBounded(map: Map<string, string>, key: string, value: string): void {
  if (!map.has(key) && map.size >= 2048) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest) map.delete(oldest);
  }
  map.set(key, value);
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  throw new Error("OpenLinker Runtime: unsupported WebSocket frame type");
}

function runtimeUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function closeCodeReason(code: number): string {
  switch (code) {
    case 4401: return "AUTHENTICATION_FAILED";
    case 4406: return "RUNTIME_CLIENT_UPGRADE_REQUIRED";
    case 4409: return "RUNTIME_SESSION_CONFLICT";
    case 4412: return "RUNTIME_REQUIRED_FEATURE_MISSING";
    default: return "TRANSPORT_CLOSED";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
