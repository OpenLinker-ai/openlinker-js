import {
  OpenLinkerClient,
  OpenLinkerError,
  type FetchLike,
  type RequestOptions,
  type TokenProvider,
} from "./client.js";
import {
  assertRuntimeUUID,
  assertRuntimeWaitSeconds,
  decodeRuntimeAssignment,
  decodeRuntimeAssignmentConfirmed,
  decodeRuntimeAssignmentRejected,
  decodeRuntimeCancellationState,
  decodeRuntimeCommandsResponse,
  decodeRuntimeErrorEnvelope,
  decodeRuntimeEventAck,
  decodeRuntimeLeaseRenewed,
  decodeRuntimeReady,
  decodeRuntimeResultAck,
  decodeRuntimeResumeResponse,
  decodeRuntimeRunSummary,
  encodeRuntimeAssignmentAck,
  encodeRuntimeAssignmentReject,
  encodeRuntimeCallAgent,
  encodeRuntimeCancelAck,
  encodeRuntimeClaim,
  encodeRuntimeEvent,
  encodeRuntimeHello,
  encodeRuntimeLeaseRenew,
  encodeRuntimeResult,
  encodeRuntimeResume,
  encodeRuntimeSessionClose,
  readRuntimeJSON,
  runtimeAttemptIdentityEqual,
} from "./runtime-codec.js";
import {
  RuntimeCallAgentPath,
  assertRuntimeCallAgentAuthorization,
  buildRuntimeInvocationProof,
} from "./runtime-invocation.js";
import type {
  RuntimeAssignmentAckPayload,
  RuntimeAssignmentConfirmedPayload,
  RuntimeAssignmentRejectPayload,
  RuntimeAssignmentRejectedPayload,
  RuntimeCallAgentAuthorization,
  RuntimeCallAgentRequest,
  RuntimeClaimRequest,
  RuntimeCommandsResponse,
  RuntimeHelloPayload,
  RuntimeLeaseRenewedPayload,
  RuntimeLeaseRenewPayload,
  RuntimeReadyPayload,
  RuntimeResumePayload,
  RuntimeResumeResponse,
  RuntimeRunAssignedPayload,
  RuntimeRunCancelAckPayload,
  RuntimeRunCancellationState,
  RuntimeRunEventAckPayload,
  RuntimeRunEventPayload,
  RuntimeRunResultAckPayload,
  RuntimeRunResultPayload,
  RuntimeRunSummary,
  RuntimeSessionCloseRequest,
} from "./runtime-types.js";
import { RuntimeAttachmentHeader, RuntimeMaxMessageBytes } from "./runtime-types.js";

export * from "./runtime-types.js";
export * from "./runtime-invocation.js";
export * from "./runtime-websocket.js";

export interface OpenLinkerRuntimeOptions {
  baseUrl: string;
  agentToken: TokenProvider;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>) | undefined;
  fetch?: FetchLike | undefined;
  sdkAgent?: string | undefined;
}

export class OpenLinkerRuntime extends OpenLinkerClient {
  private attachmentIdValue: string | undefined;
  private attachmentTransition: Promise<void> = Promise.resolve();

  constructor(options: OpenLinkerRuntimeOptions) {
    if (!options.agentToken) {
      throw new Error("OpenLinkerRuntime requires agentToken");
    }
    super({
      baseUrl: options.baseUrl,
      headers: sanitizeRuntimeHeaderProvider(options.headers),
      fetch: options.fetch,
      sdkAgent: options.sdkAgent ?? "@openlinker/sdk/runtime/0.1.4",
      agentToken: options.agentToken,
      runtimeMode: true,
    } as unknown as ConstructorParameters<typeof OpenLinkerClient>[0]);
  }

  /** The active Pull attachment. It is replaced only after a validated Ready response. */
  get runtimeAttachmentId(): string | undefined {
    return this.attachmentIdValue;
  }

  async createRuntimeSession(
    hello: RuntimeHelloPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeReadyPayload> {
    const body = encodeRuntimeHello(hello);
    return this.withAttachmentTransition(async () => {
      const value = await this.runtimeJSON(
        "POST",
        "/agent-runtime/sessions",
        body,
        withoutRuntimeAttachment(options),
      );
      if (value === undefined) {
        throw new Error("OpenLinker Runtime: session create returned 204");
      }
      const ready = decodeRuntimeReady(value);
      this.attachmentIdValue = ready.attachmentId;
      return ready;
    });
  }

  async heartbeatRuntimeSession(
    hello: RuntimeHelloPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeReadyPayload> {
    const body = encodeRuntimeHello(hello);
    return this.withAttachmentTransition(async () => {
      const attachmentId = this.requiredRuntimeAttachment("session heartbeat");
      const value = await this.runtimeAttachedJSON(
        "POST",
        `/agent-runtime/sessions/${encodeURIComponent(hello.runtimeSessionId)}/heartbeat`,
        body,
        options,
        undefined,
        "session heartbeat",
      );
      if (value === undefined) {
        throw new Error("OpenLinker Runtime: session heartbeat returned 204");
      }
      const ready = decodeRuntimeReady(value);
      if (ready.attachmentId !== attachmentId) {
        throw new Error("OpenLinker Runtime: session heartbeat changed the attachment identity");
      }
      this.attachmentIdValue = ready.attachmentId;
      return ready;
    });
  }

  async closeRuntimeSession(
    request: RuntimeSessionCloseRequest,
    options: RequestOptions = {},
  ): Promise<void> {
    const body = encodeRuntimeSessionClose(request);
    await this.withAttachmentTransition(async () => {
      const response = await this.runtimeAttachedFetch(
        "POST",
        `/agent-runtime/sessions/${encodeURIComponent(request.runtimeSessionId)}/close`,
        body,
        options,
        undefined,
        "session close",
      );
      if (response.status !== 204) {
        throw new Error("OpenLinker Runtime: session close must return 204");
      }
      this.attachmentIdValue = undefined;
    });
  }

  async claimRuntimeRun(
    waitSeconds: number,
    request: RuntimeClaimRequest,
    options: RequestOptions = {},
  ): Promise<RuntimeRunAssignedPayload | undefined> {
    assertRuntimeWaitSeconds(waitSeconds);
    const query = new URLSearchParams({ wait: String(waitSeconds) });
    const value = await this.runtimeAttachedJSON(
      "POST",
      "/agent-runtime/runs/claim",
      encodeRuntimeClaim(request),
      options,
      query,
      "run claim",
    );
    if (value === undefined) {
      return undefined;
    }
    const assignment = decodeRuntimeAssignment(value);
    if (assignment.attemptIdentity.runtimeSessionId !== request.runtimeSessionId) {
      throw new Error("OpenLinker Runtime: claim response Session identity mismatch");
    }
    return assignment;
  }

  async ackRuntimeAssignment(
    request: RuntimeAssignmentAckPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeAssignmentConfirmedPayload> {
    const value = await this.runtimeAttachedRequiredJSON(
      "POST",
      runtimeRunPath(request.attemptIdentity.runId, "assignment-ack"),
      encodeRuntimeAssignmentAck(request),
      options,
      undefined,
      "assignment ACK",
    );
    const confirmed = decodeRuntimeAssignmentConfirmed(value);
    assertRuntimeResponseIdentity(request.attemptIdentity, confirmed.attemptIdentity, "assignment confirmation");
    return confirmed;
  }

  async rejectRuntimeAssignment(
    request: RuntimeAssignmentRejectPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeAssignmentRejectedPayload> {
    const value = await this.runtimeAttachedRequiredJSON(
      "POST",
      runtimeRunPath(request.attemptIdentity.runId, "assignment-reject"),
      encodeRuntimeAssignmentReject(request),
      options,
      undefined,
      "assignment rejection",
    );
    const rejected = decodeRuntimeAssignmentRejected(value);
    assertRuntimeResponseIdentity(request.attemptIdentity, rejected.attemptIdentity, "assignment rejection");
    return rejected;
  }

  async renewRuntimeLease(
    request: RuntimeLeaseRenewPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeLeaseRenewedPayload> {
    const value = await this.runtimeAttachedRequiredJSON(
      "POST",
      runtimeRunPath(request.attemptIdentity.runId, "lease-renew"),
      encodeRuntimeLeaseRenew(request),
      options,
      undefined,
      "lease renewal",
    );
    const renewed = decodeRuntimeLeaseRenewed(value);
    assertRuntimeResponseIdentity(request.attemptIdentity, renewed.attemptIdentity, "lease renewal");
    return renewed;
  }

  async appendRuntimeEvent(
    request: RuntimeRunEventPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeRunEventAckPayload> {
    const value = await this.runtimeAttachedRequiredJSON(
      "POST",
      runtimeRunPath(request.attemptIdentity.runId, "events"),
      encodeRuntimeEvent(request),
      options,
      undefined,
      "Event upload",
    );
    const ack = decodeRuntimeEventAck(value);
    if (ack.clientEventId !== request.clientEventId || ack.clientEventSeq !== request.clientEventSeq) {
      throw new Error("OpenLinker Runtime: Event acknowledgement identity mismatch");
    }
    return ack;
  }

  async finalizeRuntimeResult(
    request: RuntimeRunResultPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeRunResultAckPayload> {
    const value = await this.runtimeAttachedRequiredJSON(
      "POST",
      runtimeRunPath(request.attemptIdentity.runId, "result"),
      encodeRuntimeResult(request),
      options,
      undefined,
      "Result upload",
    );
    const ack = decodeRuntimeResultAck(value);
    if (ack.resultId !== request.resultId) {
      throw new Error("OpenLinker Runtime: Result acknowledgement identity mismatch");
    }
    return ack;
  }

  async resumeRuntimeRuns(
    request: RuntimeResumePayload,
    options: RequestOptions = {},
  ): Promise<RuntimeResumeResponse> {
    const value = await this.runtimeAttachedRequiredJSON(
      "POST",
      "/agent-runtime/runs/resume",
      encodeRuntimeResume(request),
      options,
      undefined,
      "resume",
    );
    const response = decodeRuntimeResumeResponse(value);
    if (response.decisions.length !== request.attempts.length) {
      throw new Error("OpenLinker Runtime: Resume response count mismatch");
    }
    response.decisions.forEach((decision, index) => {
      const requested = request.attempts[index];
      if (!requested || !runtimeAttemptIdentityEqual(requested.attemptIdentity, decision.attemptIdentity)) {
        throw new Error("OpenLinker Runtime: Resume response order or identity mismatch");
      }
    });
    return response;
  }

  async pollRuntimeCommands(
    runtimeSessionId: string,
    waitSeconds: number,
    options: RequestOptions = {},
  ): Promise<RuntimeCommandsResponse> {
    assertRuntimeUUID(runtimeSessionId, "commands.runtimeSessionId");
    assertRuntimeWaitSeconds(waitSeconds);
    const query = new URLSearchParams({
      runtime_session_id: runtimeSessionId,
      wait: String(waitSeconds),
    });
    const { status, value } = await this.runtimeAttachedStatusJSON(
      "GET",
      "/agent-runtime/commands",
      undefined,
      options,
      query,
      "command poll",
    );
    if (status !== 200 || value === undefined) {
      throw new Error("OpenLinker Runtime: commands endpoint must return 200");
    }
    const decoded = decodeRuntimeCommandsResponse(value);
    for (const command of decoded.commands) {
      if ((command.type === "run.cancel" || command.type === "run.lease.revoked") &&
        command.payload.attemptIdentity.runtimeSessionId !== runtimeSessionId) {
        throw new Error("OpenLinker Runtime: command Session identity mismatch");
      }
    }
    return decoded;
  }

  async ackRuntimeCancel(
    request: RuntimeRunCancelAckPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeRunCancellationState> {
    const { status, value } = await this.runtimeAttachedStatusJSON(
      "POST",
      runtimeRunPath(request.attemptIdentity.runId, "cancel-ack"),
      encodeRuntimeCancelAck(request),
      options,
      undefined,
      "cancel ACK",
    );
    if (status !== 200 || value === undefined) {
      throw new Error("OpenLinker Runtime: cancel ACK endpoint must return 200");
    }
    const state = decodeRuntimeCancellationState(value);
    if (state.cancellationId !== request.cancellationId) {
      throw new Error("OpenLinker Runtime: cancellation state identity mismatch");
    }
    assertRuntimeCancelStateCorrelation(request.cancelState, state.cancelState);
    return state;
  }

  async callRuntimeAgent(
    authorization: RuntimeCallAgentAuthorization,
    request: RuntimeCallAgentRequest,
    options: RequestOptions = {},
  ): Promise<RuntimeRunSummary> {
    assertRuntimeCallAgentAuthorization(authorization);
    const wire = encodeRuntimeCallAgent(request);
    let json: string;
    try {
      json = JSON.stringify(wire);
    } catch (cause) {
      throw new Error("OpenLinker Runtime: delegated call is not JSON serializable", { cause });
    }
    const body = new TextEncoder().encode(json);
    if (body.byteLength > RuntimeMaxMessageBytes) {
      throw new Error("OpenLinker Runtime: delegated call exceeds 4 MiB");
    }
    const proof = await buildRuntimeInvocationProof(authorization.token, {
      method: "POST",
      path: RuntimeCallAgentPath,
      idempotencyKey: authorization.idempotencyKey,
      context: authorization.invocationContext,
      body,
    });
    const headers = new Headers({
      "idempotency-key": authorization.idempotencyKey,
      "openlinker-invocation-context": authorization.invocationContext,
      "openlinker-invocation-proof": proof,
    });
    const response = await this.fetchAgentRuntimeBytesRaw(
      "POST",
      RuntimeCallAgentPath,
      body,
      authorization.token,
      headers,
      withoutRuntimeAttachment(options),
    );
    await assertRuntimeResponseOK(response);
    if (response.status !== 200 && response.status !== 202) {
      throw new Error("OpenLinker Runtime: delegated call must return 200 or 202");
    }
    const summary = decodeRuntimeRunSummary(await readRuntimeJSON(response));
    if ((summary.status === "running") !== (response.status === 202)) {
      throw new Error("OpenLinker Runtime: delegated call status does not match its Run summary");
    }
    return summary;
  }

  private async runtimeAttachedRequiredJSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query: URLSearchParams | undefined,
    operation: string,
  ): Promise<unknown> {
    const value = await this.runtimeAttachedJSON(method, path, body, options, query, operation);
    if (value === undefined) {
      throw new Error("OpenLinker Runtime: endpoint returned 204 without a response body");
    }
    return value;
  }

  private async runtimeAttachedJSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query: URLSearchParams | undefined,
    operation: string,
  ): Promise<unknown | undefined> {
    const attachmentId = this.requiredRuntimeAttachment(operation);
    let value: unknown | undefined;
    try {
      value = await this.runtimeJSON(
        method,
        path,
        body,
        withRuntimeAttachment(options, attachmentId),
        query,
      );
    } catch (error) {
      this.assertRuntimeAttachment(attachmentId, operation);
      throw error;
    }
    this.assertRuntimeAttachment(attachmentId, operation);
    return value;
  }

  private async runtimeAttachedFetch(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query: URLSearchParams | undefined,
    operation: string,
  ): Promise<Response> {
    const attachmentId = this.requiredRuntimeAttachment(operation);
    let response: Response;
    try {
      response = await this.runtimeFetch(
        method,
        path,
        body,
        withRuntimeAttachment(options, attachmentId),
        query,
      );
    } catch (error) {
      this.assertRuntimeAttachment(attachmentId, operation);
      throw error;
    }
    this.assertRuntimeAttachment(attachmentId, operation);
    return response;
  }

  private async runtimeAttachedStatusJSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query: URLSearchParams | undefined,
    operation: string,
  ): Promise<{ status: number; value: unknown | undefined }> {
    const attachmentId = this.requiredRuntimeAttachment(operation);
    let response: Response;
    let value: unknown | undefined;
    try {
      response = await this.runtimeFetch(
        method,
        path,
        body,
        withRuntimeAttachment(options, attachmentId),
        query,
      );
      value = response.status === 204 ? undefined : await readRuntimeJSON(response);
    } catch (error) {
      this.assertRuntimeAttachment(attachmentId, operation);
      throw error;
    }
    this.assertRuntimeAttachment(attachmentId, operation);
    return { status: response.status, value };
  }

  private requiredRuntimeAttachment(operation: string): string {
    if (!this.attachmentIdValue) {
      throw new Error(
        `OpenLinker Runtime: ${operation} requires an active Pull attachment; create the Session first`,
      );
    }
    return this.attachmentIdValue;
  }

  private assertRuntimeAttachment(expected: string, operation: string): void {
    if (this.attachmentIdValue !== expected) {
      throw new Error(`OpenLinker Runtime: ${operation} response belongs to a stale attachment`);
    }
  }

  private async withAttachmentTransition<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.attachmentTransition;
    this.attachmentTransition = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runtimeJSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
  ): Promise<unknown | undefined> {
    const response = await this.runtimeFetch(method, path, body, options, query);
    if (response.status === 204) {
      return undefined;
    }
    return readRuntimeJSON(response);
  }

  private async runtimeFetch(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
  ): Promise<Response> {
    const response = await this.fetchAgentRuntimeRaw(method, path, body, options, query);
    return assertRuntimeResponseOK(response);
  }
}

function withRuntimeAttachment(options: RequestOptions, attachmentId: string): RequestOptions {
  const headers = new Headers(options.headers);
  headers.set(RuntimeAttachmentHeader, attachmentId);
  return { ...options, headers };
}

function withoutRuntimeAttachment(options: RequestOptions): RequestOptions {
  const headers = new Headers(options.headers);
  headers.delete(RuntimeAttachmentHeader);
  return { ...options, headers };
}

function sanitizeRuntimeHeaderProvider(
  provider: OpenLinkerRuntimeOptions["headers"],
): OpenLinkerRuntimeOptions["headers"] {
  if (typeof provider === "function") {
    return async () => {
      const headers = new Headers(await provider());
      headers.delete(RuntimeAttachmentHeader);
      return headers;
    };
  }
  if (provider === undefined) return undefined;
  const headers = new Headers(provider);
  headers.delete(RuntimeAttachmentHeader);
  return headers;
}

function runtimeRunPath(runId: string, action: string): string {
  return `/agent-runtime/runs/${encodeURIComponent(runId)}/${action}`;
}

function assertRuntimeResponseIdentity(
  requested: RuntimeAssignmentAckPayload["attemptIdentity"],
  returned: RuntimeAssignmentAckPayload["attemptIdentity"],
  operation: string,
): void {
  if (!runtimeAttemptIdentityEqual(requested, returned)) {
    throw new Error(`OpenLinker Runtime: ${operation} identity mismatch`);
  }
}

function assertRuntimeCancelStateCorrelation(
  requested: RuntimeRunCancelAckPayload["cancelState"],
  returned: RuntimeRunCancellationState["cancelState"],
): void {
  const allowed = returned === "unconfirmed" || returned === requested ||
    (requested === "delivered" && returned === "stopping");
  if (!allowed) {
    throw new Error("OpenLinker Runtime: cancellation state does not correlate with the ACK");
  }
}

async function assertRuntimeResponseOK(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const raw = await readRuntimeJSON(response);
  const envelope = decodeRuntimeErrorEnvelope(raw);
  throw new OpenLinkerError(envelope.error.message, {
    status: response.status,
    code: envelope.error.code,
    details: envelope.error,
    requestId: response.headers.get("x-request-id") ??
      response.headers.get("x-correlation-id") ?? undefined,
    retryAfterMs: runtimeRetryAfterMs(response.headers),
    responseBody: raw,
  });
}

function runtimeRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  const delay = retryAt - Date.now();
  return delay > 0 ? delay : undefined;
}

export { OpenLinkerError };
export type {
  FetchLike,
  RequestOptions,
  TokenProvider,
} from "./client.js";
