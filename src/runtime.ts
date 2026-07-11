import {
  OpenLinkerClient,
  OpenLinkerError,
  type ClaimRuntimeRunResult,
  type FetchLike,
  type RequestOptions,
  type RuntimeHandlers,
  type RuntimePullLoopOptions,
  type RuntimeWebSocketConnection,
  type RuntimeWebSocketOptions,
  type TokenProvider,
} from "./client.js";
import {
  assertRuntimeV2WaitSeconds,
  decodeRuntimeV2Assignment,
  decodeRuntimeV2AssignmentConfirmed,
  decodeRuntimeV2AssignmentRejected,
  decodeRuntimeV2ErrorEnvelope,
  decodeRuntimeV2EventAck,
  decodeRuntimeV2LeaseRenewed,
  decodeRuntimeV2Ready,
  decodeRuntimeV2ResultAck,
  decodeRuntimeV2ResumeResponse,
  encodeRuntimeV2AssignmentAck,
  encodeRuntimeV2AssignmentReject,
  encodeRuntimeV2Claim,
  encodeRuntimeV2Event,
  encodeRuntimeV2Hello,
  encodeRuntimeV2LeaseRenew,
  encodeRuntimeV2Result,
  encodeRuntimeV2Resume,
  encodeRuntimeV2SessionClose,
  readRuntimeV2JSON,
  runtimeV2AttemptIdentityEqual,
} from "./runtime-v2-codec.js";
import type {
  RuntimeV2AssignmentAckPayload,
  RuntimeV2AssignmentConfirmedPayload,
  RuntimeV2AssignmentRejectPayload,
  RuntimeV2AssignmentRejectedPayload,
  RuntimeV2ClaimRequest,
  RuntimeV2HelloPayload,
  RuntimeV2LeaseRenewedPayload,
  RuntimeV2LeaseRenewPayload,
  RuntimeV2ReadyPayload,
  RuntimeV2ResumePayload,
  RuntimeV2ResumeResponse,
  RuntimeV2RunAssignedPayload,
  RuntimeV2RunEventAckPayload,
  RuntimeV2RunEventPayload,
  RuntimeV2RunResultAckPayload,
  RuntimeV2RunResultPayload,
  RuntimeV2SessionCloseRequest,
} from "./runtime-v2-types.js";
import type {
  AgentHeartbeatResponse,
  CallAgentRequest,
  ClaimRuntimeRunParams,
  RuntimePullResultRequest,
  RuntimePullRunResponse,
  RunResponse,
} from "./types.js";

export * from "./runtime-v2-types.js";

export interface OpenLinkerRuntimeOptions {
  baseUrl: string;
  agentToken: TokenProvider;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>) | undefined;
  fetch?: FetchLike | undefined;
  sdkAgent?: string | undefined;
}

export class OpenLinkerRuntime extends OpenLinkerClient {
  constructor(options: OpenLinkerRuntimeOptions) {
    if (!options.agentToken) {
      throw new Error("OpenLinkerRuntime requires agentToken");
    }
    super({
      baseUrl: options.baseUrl,
      headers: options.headers,
      fetch: options.fetch,
      sdkAgent: options.sdkAgent ?? "@openlinker/sdk/runtime/0.1.4",
      agentToken: options.agentToken,
      runtimeMode: true,
    } as unknown as ConstructorParameters<typeof OpenLinkerClient>[0]);
  }

  override async heartbeatAgent(
    options: RequestOptions = {},
  ): Promise<AgentHeartbeatResponse> {
    return super.heartbeatAgent(options);
  }

  async createRuntimeV2Session(
    hello: RuntimeV2HelloPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2ReadyPayload> {
    const value = await this.runtimeV2JSON(
      "POST",
      "/agent-runtime/v2/sessions",
      encodeRuntimeV2Hello(hello),
      options,
    );
    if (value === undefined) {
      throw new Error("OpenLinker runtime v2: session create returned 204");
    }
    return decodeRuntimeV2Ready(value);
  }

  async heartbeatRuntimeV2Session(
    hello: RuntimeV2HelloPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2ReadyPayload> {
    const body = encodeRuntimeV2Hello(hello);
    const value = await this.runtimeV2JSON(
      "POST",
      `/agent-runtime/v2/sessions/${encodeURIComponent(hello.runtimeSessionId)}/heartbeat`,
      body,
      options,
    );
    if (value === undefined) {
      throw new Error("OpenLinker runtime v2: session heartbeat returned 204");
    }
    return decodeRuntimeV2Ready(value);
  }

  async closeRuntimeV2Session(
    request: RuntimeV2SessionCloseRequest,
    options: RequestOptions = {},
  ): Promise<void> {
    const body = encodeRuntimeV2SessionClose(request);
    const response = await this.runtimeV2Fetch(
      "POST",
      `/agent-runtime/v2/sessions/${encodeURIComponent(request.runtimeSessionId)}/close`,
      body,
      options,
    );
    if (response.status !== 204) {
      throw new Error("OpenLinker runtime v2: session close must return 204");
    }
  }

  async claimRuntimeV2Run(
    waitSeconds: number,
    request: RuntimeV2ClaimRequest,
    options: RequestOptions = {},
  ): Promise<RuntimeV2RunAssignedPayload | undefined> {
    assertRuntimeV2WaitSeconds(waitSeconds);
    const query = new URLSearchParams({ wait: String(waitSeconds) });
    const value = await this.runtimeV2JSON(
      "POST",
      "/agent-runtime/v2/runs/claim",
      encodeRuntimeV2Claim(request),
      options,
      query,
    );
    if (value === undefined) {
      return undefined;
    }
    const assignment = decodeRuntimeV2Assignment(value);
    if (assignment.attemptIdentity.runtimeSessionId !== request.runtimeSessionId) {
      throw new Error("OpenLinker runtime v2: claim response Session identity mismatch");
    }
    return assignment;
  }

  async ackRuntimeV2Assignment(
    request: RuntimeV2AssignmentAckPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2AssignmentConfirmedPayload> {
    const value = await this.runtimeV2RequiredJSON(
      "POST",
      runtimeV2RunPath(request.attemptIdentity.runId, "assignment-ack"),
      encodeRuntimeV2AssignmentAck(request),
      options,
    );
    const confirmed = decodeRuntimeV2AssignmentConfirmed(value);
    assertRuntimeV2ResponseIdentity(request.attemptIdentity, confirmed.attemptIdentity, "assignment confirmation");
    return confirmed;
  }

  async rejectRuntimeV2Assignment(
    request: RuntimeV2AssignmentRejectPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2AssignmentRejectedPayload> {
    const value = await this.runtimeV2RequiredJSON(
      "POST",
      runtimeV2RunPath(request.attemptIdentity.runId, "assignment-reject"),
      encodeRuntimeV2AssignmentReject(request),
      options,
    );
    const rejected = decodeRuntimeV2AssignmentRejected(value);
    assertRuntimeV2ResponseIdentity(request.attemptIdentity, rejected.attemptIdentity, "assignment rejection");
    return rejected;
  }

  async renewRuntimeV2Lease(
    request: RuntimeV2LeaseRenewPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2LeaseRenewedPayload> {
    const value = await this.runtimeV2RequiredJSON(
      "POST",
      runtimeV2RunPath(request.attemptIdentity.runId, "lease-renew"),
      encodeRuntimeV2LeaseRenew(request),
      options,
    );
    const renewed = decodeRuntimeV2LeaseRenewed(value);
    assertRuntimeV2ResponseIdentity(request.attemptIdentity, renewed.attemptIdentity, "lease renewal");
    return renewed;
  }

  async appendRuntimeV2Event(
    request: RuntimeV2RunEventPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2RunEventAckPayload> {
    const value = await this.runtimeV2RequiredJSON(
      "POST",
      runtimeV2RunPath(request.attemptIdentity.runId, "events"),
      encodeRuntimeV2Event(request),
      options,
    );
    const ack = decodeRuntimeV2EventAck(value);
    if (ack.clientEventId !== request.clientEventId || ack.clientEventSeq !== request.clientEventSeq) {
      throw new Error("OpenLinker runtime v2: Event acknowledgement identity mismatch");
    }
    return ack;
  }

  async finalizeRuntimeV2Result(
    request: RuntimeV2RunResultPayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2RunResultAckPayload> {
    const value = await this.runtimeV2RequiredJSON(
      "POST",
      runtimeV2RunPath(request.attemptIdentity.runId, "result"),
      encodeRuntimeV2Result(request),
      options,
    );
    const ack = decodeRuntimeV2ResultAck(value);
    if (ack.resultId !== request.resultId) {
      throw new Error("OpenLinker runtime v2: Result acknowledgement identity mismatch");
    }
    return ack;
  }

  async resumeRuntimeV2Runs(
    request: RuntimeV2ResumePayload,
    options: RequestOptions = {},
  ): Promise<RuntimeV2ResumeResponse> {
    const value = await this.runtimeV2RequiredJSON(
      "POST",
      "/agent-runtime/v2/runs/resume",
      encodeRuntimeV2Resume(request),
      options,
    );
    const response = decodeRuntimeV2ResumeResponse(value);
    if (response.decisions.length !== request.attempts.length) {
      throw new Error("OpenLinker runtime v2: Resume response count mismatch");
    }
    response.decisions.forEach((decision, index) => {
      const requested = request.attempts[index];
      if (!requested || !runtimeV2AttemptIdentityEqual(requested.attemptIdentity, decision.attemptIdentity)) {
        throw new Error("OpenLinker runtime v2: Resume response order or identity mismatch");
      }
    });
    return response;
  }

  override async claimRuntimeRun(
    params: ClaimRuntimeRunParams = {},
    options: RequestOptions = {},
  ): Promise<RuntimePullRunResponse | undefined> {
    return super.claimRuntimeRun(params, options);
  }

  override async claimRuntimeRunDetailed(
    params: ClaimRuntimeRunParams = {},
    options: RequestOptions = {},
  ): Promise<ClaimRuntimeRunResult> {
    return super.claimRuntimeRunDetailed(params, options);
  }

  override async completeRuntimeRun(
    runId: string,
    result: RuntimePullResultRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return super.completeRuntimeRun(runId, result, options);
  }

  override async callAgent(
    request: CallAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return super.callAgent(request, options);
  }

  override async callAgentAt(
    endpoint: string,
    request: CallAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return super.callAgentAt(endpoint, request, options);
  }

  override async runRuntimePullLoop(
    handlers: RuntimeHandlers,
    options: RuntimePullLoopOptions = {},
  ): Promise<void> {
    return super.runRuntimePullLoop(handlers, options);
  }

  override async connectRuntimeWebSocket(
    handlers: RuntimeHandlers,
    options: RuntimeWebSocketOptions = {},
  ): Promise<RuntimeWebSocketConnection> {
    return super.connectRuntimeWebSocket(handlers, options);
  }

  private async runtimeV2RequiredJSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
  ): Promise<unknown> {
    const value = await this.runtimeV2JSON(method, path, body, options, query);
    if (value === undefined) {
      throw new Error("OpenLinker runtime v2: endpoint returned 204 without a response body");
    }
    return value;
  }

  private async runtimeV2JSON(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
  ): Promise<unknown | undefined> {
    const response = await this.runtimeV2Fetch(method, path, body, options, query);
    if (response.status === 204) {
      return undefined;
    }
    return readRuntimeV2JSON(response);
  }

  private async runtimeV2Fetch(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
  ): Promise<Response> {
    const response = await this.fetchAgentRuntimeRaw(method, path, body, options, query);
    if (response.ok) {
      return response;
    }
    const raw = await readRuntimeV2JSON(response);
    const envelope = decodeRuntimeV2ErrorEnvelope(raw);
    throw new OpenLinkerError(envelope.error.message, {
      status: response.status,
      code: envelope.error.code,
      details: envelope.error,
      requestId: response.headers.get("x-request-id") ??
        response.headers.get("x-correlation-id") ?? undefined,
      retryAfterMs: runtimeV2RetryAfterMs(response.headers),
      responseBody: raw,
    });
  }
}

function runtimeV2RunPath(runId: string, action: string): string {
  return `/agent-runtime/v2/runs/${encodeURIComponent(runId)}/${action}`;
}

function assertRuntimeV2ResponseIdentity(
  requested: RuntimeV2AssignmentAckPayload["attemptIdentity"],
  returned: RuntimeV2AssignmentAckPayload["attemptIdentity"],
  operation: string,
): void {
  if (!runtimeV2AttemptIdentityEqual(requested, returned)) {
    throw new Error(`OpenLinker runtime v2: ${operation} identity mismatch`);
  }
}

function runtimeV2RetryAfterMs(headers: Headers): number | undefined {
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
  ClaimRuntimeRunResult,
  FetchLike,
  RequestOptions,
  RuntimeHandlers,
  RuntimePullLoopOptions,
  RuntimeWebSocketConnection,
  RuntimeWebSocketFactory,
  RuntimeWebSocketFactoryOptions,
  RuntimeWebSocketLike,
  RuntimeWebSocketOptions,
  TokenProvider,
} from "./client.js";
export type {
  AgentHeartbeatResponse,
  CallAgentRequest,
  ClaimRuntimeRunParams,
  RuntimeAssignment,
  RuntimePullResultRequest,
  RuntimePullRunResponse,
  RuntimeWSClientMessage,
  RuntimeWSServerMessage,
  RunResponse,
} from "./types.js";
