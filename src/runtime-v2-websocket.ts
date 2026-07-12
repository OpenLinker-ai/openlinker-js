import {
  decodeRuntimeV2Assignment,
  decodeRuntimeV2AssignmentConfirmed,
  decodeRuntimeV2AssignmentRejected,
  decodeRuntimeV2Envelope,
  decodeRuntimeV2ErrorEnvelope,
  decodeRuntimeV2EventAck,
  decodeRuntimeV2LeaseRenewed,
  decodeRuntimeV2PendingCommand,
  decodeRuntimeV2Ready,
  decodeRuntimeV2ResultAck,
  decodeRuntimeV2ResumeAccepted,
  encodeRuntimeV2AssignmentAck,
  encodeRuntimeV2AssignmentReject,
  encodeRuntimeV2CancelAck,
  encodeRuntimeV2Envelope,
  encodeRuntimeV2Event,
  encodeRuntimeV2Hello,
  encodeRuntimeV2LeaseRenew,
  encodeRuntimeV2Result,
  encodeRuntimeV2Resume,
  runtimeV2AttemptIdentityEqual,
  type RuntimeV2DecodedEnvelope,
} from "./runtime-v2-codec.js";
import {
  RuntimeV2MaxMessageBytes,
  RuntimeV2MessageTypes,
  type RuntimeV2AssignmentAckPayload,
  type RuntimeV2AssignmentConfirmedPayload,
  type RuntimeV2AssignmentRejectPayload,
  type RuntimeV2AssignmentRejectedPayload,
  type RuntimeV2AttemptIdentity,
  type RuntimeV2HelloPayload,
  type RuntimeV2LeaseRenewedPayload,
  type RuntimeV2LeaseRenewPayload,
  type RuntimeV2MessageType,
  type RuntimeV2PendingCommand,
  type RuntimeV2ReadyPayload,
  type RuntimeV2ResumeAcceptedPayload,
  type RuntimeV2ResumePayload,
  type RuntimeV2RunAssignedPayload,
  type RuntimeV2RunCancelAckPayload,
  type RuntimeV2RunEventAckPayload,
  type RuntimeV2RunEventPayload,
  type RuntimeV2RunResultAckPayload,
  type RuntimeV2RunResultPayload,
} from "./runtime-v2-types.js";

export interface RuntimeV2WebSocketLike {
  readonly readyState: number;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RuntimeV2WebSocketSessionOptions {
  requestTimeoutMs?: number;
  onAssigned?: (assignment: RuntimeV2RunAssignedPayload) => void | Promise<void>;
  onCommand?: (command: RuntimeV2PendingCommand) => void | Promise<void>;
  onError?: (error: Error) => void;
  onClose?: (event: { code: number; reason: string; clean: boolean }) => void;
}

type PendingRequest<T> = {
  expected: ReadonlySet<RuntimeV2MessageType>;
  remaining: number;
  values: T[];
  decode: (envelope: RuntimeV2DecodedEnvelope) => T;
  resolve: (values: T[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RuntimeV2WebSocketError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly closeCode?: number,
  ) {
    super(message);
    this.name = "RuntimeV2WebSocketError";
  }
}

/**
 * Strict Runtime v2 WebSocket protocol session over an already authenticated
 * socket. The caller owns TLS, the Node client certificate, and the Agent Token
 * used during the HTTP upgrade; credentials are never placed in the URL.
 *
 * Durable workers must persist assignments before ACK and persist Events and
 * Results before calling these methods. This class deliberately provides no
 * in-memory execution queue or automatic task replay.
 */
export class RuntimeV2WebSocketSession {
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly assignmentMessages = new Map<string, string>();
  private readonly cancellationMessages = new Map<string, string>();
  private inbound = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(
    private readonly socket: RuntimeV2WebSocketLike,
    private readonly options: RuntimeV2WebSocketSessionOptions = {},
  ) {
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
      throw new Error("OpenLinker runtime v2: WebSocket requestTimeoutMs is invalid");
    }
    this.requestTimeoutMs = timeout;
  }

  async start(hello: RuntimeV2HelloPayload): Promise<RuntimeV2ReadyPayload> {
    if (this.started || this.closed) {
      throw new Error("OpenLinker runtime v2: WebSocket session already started or closed");
    }
    if (this.socket.readyState !== 1) {
      throw new Error("OpenLinker runtime v2: authenticated WebSocket is not open");
    }
    this.started = true;
    this.socket.onmessage = (event) => {
      this.inbound = this.inbound
        .then(() => this.handleMessage(event.data))
        .catch((error: unknown) => this.failProtocol(asError(error)));
    };
    this.socket.onerror = () => {
      this.options.onError?.(new RuntimeV2WebSocketError(
        "OpenLinker runtime v2: WebSocket transport error",
        "TRANSPORT_ERROR",
        true,
      ));
    };
    this.socket.onclose = (event) => this.handleClose(event);

    return this.requestOne(
      RuntimeV2MessageTypes.hello,
      encodeRuntimeV2Hello(hello),
      new Set([RuntimeV2MessageTypes.ready]),
      (envelope) => decodeRuntimeV2Ready(envelope.payload),
    );
  }

  ackAssignment(request: RuntimeV2AssignmentAckPayload): Promise<RuntimeV2AssignmentConfirmedPayload> {
    const replyTo = this.assignmentMessage(request.attemptIdentity);
    return this.requestOne(
      RuntimeV2MessageTypes.assignmentAck,
      encodeRuntimeV2AssignmentAck(request),
      new Set([RuntimeV2MessageTypes.assignmentConfirmed]),
      (envelope) => {
        const confirmed = decodeRuntimeV2AssignmentConfirmed(envelope.payload);
        if (!runtimeV2AttemptIdentityEqual(request.attemptIdentity, confirmed.attemptIdentity)) {
          throw new Error("OpenLinker runtime v2: WebSocket assignment confirmation identity mismatch");
        }
        return confirmed;
      },
      replyTo,
    );
  }

  rejectAssignment(request: RuntimeV2AssignmentRejectPayload): Promise<RuntimeV2AssignmentRejectedPayload> {
    const replyTo = this.assignmentMessage(request.attemptIdentity);
    return this.requestOne(
      RuntimeV2MessageTypes.assignmentReject,
      encodeRuntimeV2AssignmentReject(request),
      new Set([RuntimeV2MessageTypes.assignmentRejected]),
      (envelope) => {
        const rejected = decodeRuntimeV2AssignmentRejected(envelope.payload);
        if (!runtimeV2AttemptIdentityEqual(request.attemptIdentity, rejected.attemptIdentity)) {
          throw new Error("OpenLinker runtime v2: WebSocket assignment rejection identity mismatch");
        }
        return rejected;
      },
      replyTo,
    );
  }

  renewLease(request: RuntimeV2LeaseRenewPayload): Promise<RuntimeV2LeaseRenewedPayload> {
    return this.requestOne(
      RuntimeV2MessageTypes.leaseRenew,
      encodeRuntimeV2LeaseRenew(request),
      new Set([RuntimeV2MessageTypes.leaseRenewed]),
      (envelope) => {
        const renewed = decodeRuntimeV2LeaseRenewed(envelope.payload);
        if (!runtimeV2AttemptIdentityEqual(request.attemptIdentity, renewed.attemptIdentity)) {
          throw new Error("OpenLinker runtime v2: WebSocket lease identity mismatch");
        }
        return renewed;
      },
    );
  }

  appendEvent(request: RuntimeV2RunEventPayload): Promise<RuntimeV2RunEventAckPayload> {
    return this.requestOne(
      RuntimeV2MessageTypes.runEvent,
      encodeRuntimeV2Event(request),
      new Set([RuntimeV2MessageTypes.runEventAck]),
      (envelope) => {
        const ack = decodeRuntimeV2EventAck(envelope.payload);
        if (ack.clientEventId !== request.clientEventId || ack.clientEventSeq !== request.clientEventSeq) {
          throw new Error("OpenLinker runtime v2: WebSocket Event ACK identity mismatch");
        }
        return ack;
      },
    );
  }

  finalizeResult(request: RuntimeV2RunResultPayload): Promise<RuntimeV2RunResultAckPayload> {
    return this.requestOne(
      RuntimeV2MessageTypes.runResult,
      encodeRuntimeV2Result(request),
      new Set([RuntimeV2MessageTypes.runResultAck]),
      (envelope) => {
        const ack = decodeRuntimeV2ResultAck(envelope.payload);
        if (ack.resultId !== request.resultId) {
          throw new Error("OpenLinker runtime v2: WebSocket Result ACK identity mismatch");
        }
        return ack;
      },
    );
  }

  async resume(request: RuntimeV2ResumePayload): Promise<RuntimeV2ResumeAcceptedPayload[]> {
    if (request.attempts.length < 1) {
      throw new Error("OpenLinker runtime v2: WebSocket resume requires at least one Attempt");
    }
    const decisions = await this.requestMany(
      RuntimeV2MessageTypes.resume,
      encodeRuntimeV2Resume(request),
      new Set([RuntimeV2MessageTypes.resumeAccepted]),
      request.attempts.length,
      (envelope) => decodeRuntimeV2ResumeAccepted(envelope.payload),
    );
    const byAttempt = new Map(decisions.map((decision) => [attemptKey(decision.attemptIdentity), decision]));
    return request.attempts.map((attempt) => {
      const decision = byAttempt.get(attemptKey(attempt.attemptIdentity));
      if (!decision) {
        throw new Error("OpenLinker runtime v2: WebSocket resume response identity mismatch");
      }
      return decision;
    });
  }

  ackCancel(request: RuntimeV2RunCancelAckPayload): void {
    const replyTo = this.cancellationMessages.get(cancelKey(request));
    if (!replyTo) {
      throw new Error("OpenLinker runtime v2: cancellation command correlation is missing");
    }
    this.sendEnvelope(
      RuntimeV2MessageTypes.runCancelAck,
      encodeRuntimeV2CancelAck(request),
      replyTo,
    );
  }

  close(code = 1000, reason = "runtime node stopped"): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(code) || code < 1000 || code > 4999 || reason.length > 123) {
      throw new Error("OpenLinker runtime v2: invalid WebSocket close");
    }
    this.socket.close(code, reason);
  }

  private requestOne<T>(
    type: RuntimeV2MessageType,
    payload: unknown,
    expected: ReadonlySet<RuntimeV2MessageType>,
    decode: (envelope: RuntimeV2DecodedEnvelope) => T,
    replyTo?: string,
  ): Promise<T> {
    return this.requestMany(type, payload, expected, 1, decode, replyTo).then((values) => {
      const value = values[0];
      if (value === undefined) throw new Error("OpenLinker runtime v2: missing WebSocket reply");
      return value;
    });
  }

  private requestMany<T>(
    type: RuntimeV2MessageType,
    payload: unknown,
    expected: ReadonlySet<RuntimeV2MessageType>,
    count: number,
    decode: (envelope: RuntimeV2DecodedEnvelope) => T,
    replyTo?: string,
  ): Promise<T[]> {
    this.assertUsable();
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024) {
      return Promise.reject(new Error("OpenLinker runtime v2: invalid WebSocket reply count"));
    }
    const messageId = runtimeUUID();
    return new Promise<T[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new RuntimeV2WebSocketError(
          "OpenLinker runtime v2: WebSocket business ACK timed out",
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
    type: RuntimeV2MessageType,
    payload: unknown,
    replyTo?: string,
    messageId = runtimeUUID(),
  ): void {
    this.assertUsable();
    const wire = encodeRuntimeV2Envelope(type, messageId, new Date().toISOString(), payload, replyTo);
    const text = JSON.stringify(wire);
    if (new TextEncoder().encode(text).byteLength > RuntimeV2MaxMessageBytes) {
      throw new Error("OpenLinker runtime v2: WebSocket message exceeds 4 MiB");
    }
    this.socket.send(text);
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = await messageText(data);
    if (new TextEncoder().encode(text).byteLength > RuntimeV2MaxMessageBytes) {
      throw new Error("OpenLinker runtime v2: WebSocket message exceeds 4 MiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error("OpenLinker runtime v2: WebSocket frame is not JSON", { cause });
    }
    const envelope = decodeRuntimeV2Envelope(parsed);
    if (envelope.replyToMessageId) {
      this.handleReply(envelope);
      return;
    }
    switch (envelope.type) {
      case RuntimeV2MessageTypes.runAssigned: {
        const assignment = decodeRuntimeV2Assignment(envelope.payload);
        rememberBounded(this.assignmentMessages, attemptKey(assignment.attemptIdentity), envelope.messageId);
        await this.options.onAssigned?.(assignment);
        return;
      }
      case RuntimeV2MessageTypes.runCancel:
      case RuntimeV2MessageTypes.drain:
      case RuntimeV2MessageTypes.leaseRevoked: {
        const command = decodeRuntimeV2PendingCommand({ type: envelope.type, payload: envelope.payload });
        if (command.type === RuntimeV2MessageTypes.runCancel) {
          rememberBounded(this.cancellationMessages, cancelKey(command.payload), envelope.messageId);
        }
        await this.options.onCommand?.(command);
        return;
      }
      case RuntimeV2MessageTypes.error: {
        const error = websocketError(envelope);
        this.options.onError?.(error);
        return;
      }
      default:
        throw new Error(`OpenLinker runtime v2: unexpected uncorrelated ${envelope.type} message`);
    }
  }

  private handleReply(envelope: RuntimeV2DecodedEnvelope): void {
    const correlation = envelope.replyToMessageId;
    if (!correlation) throw new Error("OpenLinker runtime v2: WebSocket reply has no correlation ID");
    const pending = this.pending.get(correlation);
    if (!pending) {
      throw new Error("OpenLinker runtime v2: WebSocket reply references an unknown request");
    }
    if (envelope.type === RuntimeV2MessageTypes.error) {
      clearTimeout(pending.timer);
      this.pending.delete(correlation);
      pending.reject(websocketError(envelope));
      return;
    }
    if (!pending.expected.has(envelope.type)) {
      throw new Error(`OpenLinker runtime v2: unexpected ${envelope.type} business ACK`);
    }
    const decoded = pending.decode(envelope);
    pending.values.push(decoded);
    pending.remaining -= 1;
    if (pending.remaining > 0) return;
    clearTimeout(pending.timer);
    this.pending.delete(correlation);
    pending.resolve(pending.values);
  }

  private assignmentMessage(identity: RuntimeV2AttemptIdentity): string {
    const messageId = this.assignmentMessages.get(attemptKey(identity));
    if (!messageId) {
      throw new Error("OpenLinker runtime v2: assignment correlation is missing");
    }
    return messageId;
  }

  private assertUsable(): void {
    if (!this.started || this.closed || this.socket.readyState !== 1) {
      throw new RuntimeV2WebSocketError(
        "OpenLinker runtime v2: WebSocket session is not open",
        "TRANSPORT_CLOSED",
        true,
      );
    }
  }

  private failProtocol(error: Error): void {
    this.options.onError?.(error);
    try {
      this.socket.close(1002, "runtime v2 protocol error");
    } catch {
      this.rejectPending(error);
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.closed) return;
    this.closed = true;
    const error = new RuntimeV2WebSocketError(
      event.reason || "OpenLinker runtime v2: WebSocket closed",
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

function websocketError(envelope: RuntimeV2DecodedEnvelope): RuntimeV2WebSocketError {
  const body = decodeRuntimeV2ErrorEnvelope({ error: envelope.payload }).error;
  return new RuntimeV2WebSocketError(body.message, body.code, body.retryable ?? false);
}

function attemptKey(identity: RuntimeV2AttemptIdentity): string {
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

function cancelKey(value: RuntimeV2RunCancelAckPayload | { cancellationId: string; attemptIdentity: RuntimeV2AttemptIdentity }): string {
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
  throw new Error("OpenLinker runtime v2: unsupported WebSocket frame type");
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
