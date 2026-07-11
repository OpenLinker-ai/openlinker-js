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
import type {
  AgentHeartbeatResponse,
  CallAgentRequest,
  ClaimRuntimeRunParams,
  RuntimePullResultRequest,
  RuntimePullRunResponse,
  RunResponse,
} from "./types.js";

export const RuntimeProtocolVersion = 2 as const;
export const RuntimeContractID = "openlinker.runtime.v2" as const;
export const RuntimeContractDigest =
  "d83e011870cf40bf67723fac1c58ca785d37954bf83638b8f67f69240d20dd4f" as const;
export const RuntimeRequiredFeatures = Object.freeze([
  "lease_fence",
  "assignment_confirm",
  "renew",
  "resume",
  "event_ack",
  "result_ack",
  "cancel",
  "persistent_spool",
] as const);

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
