import type {
  AgentCardResponse,
  AgentDetailResponse,
  AgentEvent,
  AgentHeartbeatResponse,
  CallAgentRequest,
  ClaimRuntimeRunParams,
  JsonObject,
  JsonValue,
  ListAgentsParams,
  ListItemsResponse,
  ListRunEventsParams,
  ListRunEventsResponse,
  MarketListResponse,
  RuntimeAssignment,
  RuntimePullResultRequest,
  RuntimePullRunResponse,
  RuntimeWSServerMessage,
  PlatformRunCallbackConfig,
  RunAgentRequest,
  RunArtifactResponse,
  RunMessageResponse,
  RunResponse,
  TaskCallbackConfig,
} from "./types.js";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenLinkerClientOptions {
  baseUrl: string;
  accessToken?: string | (() => string | Promise<string | undefined>) | undefined;
  runtimeToken?: string | (() => string | Promise<string | undefined>) | undefined;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>) | undefined;
  fetch?: FetchLike | undefined;
  sdkAgent?: string | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  headers?: HeadersInit | undefined;
}

export interface StreamRunEventsOptions extends RequestOptions {
  afterSequence?: number | undefined;
}

export interface StreamRunEvent {
  id?: string | undefined;
  event: string;
  data: unknown;
}

export interface StreamRunEventHandlers {
  onEvent?: (event: StreamRunEvent) => void | Promise<void>;
  onTerminal?: (event: StreamRunEvent) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}

export interface ClaimRuntimeRunResult {
  run?: RuntimePullRunResponse | undefined;
  retryAfterMs?: number | undefined;
  maxClaimWaitSeconds?: number | undefined;
}

export interface RuntimeHandlers {
  onReady?: (message: RuntimeWSServerMessage) => void | Promise<void>;
  onAssigned?: (assignment: RuntimeAssignment) => void | Promise<void>;
  onMessage?: (message: RuntimeWSServerMessage) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface RuntimePullLoopOptions extends RequestOptions {
  waitSeconds?: number | undefined;
  heartbeatMs?: number | undefined;
  emptyRetryMs?: number | undefined;
  maxRuns?: number | undefined;
  stopOnEmpty?: boolean | undefined;
}

export interface RuntimeWebSocketFactoryOptions {
  headers: Record<string, string>;
  protocols?: string | string[] | undefined;
}

export interface RuntimeWebSocketLike {
  readyState?: number | undefined;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export type RuntimeWebSocketFactory = (
  url: string,
  options: RuntimeWebSocketFactoryOptions,
) => RuntimeWebSocketLike;

export interface RuntimeWebSocketOptions extends RequestOptions {
  endpoint?: string | undefined;
  heartbeatMs?: number | undefined;
  reconnect?: boolean | undefined;
  reconnectMinMs?: number | undefined;
  reconnectMaxMs?: number | undefined;
  protocols?: string | string[] | undefined;
  webSocketFactory?: RuntimeWebSocketFactory | undefined;
}

export interface RuntimeWebSocketConnection {
  readonly supportsLiveEvents: true;
  readonly ready: Promise<void>;
  close(code?: number, reason?: string): void;
  sendRunEvent(runId: string, event: AgentEvent): void;
  completeRun(runId: string, result: RuntimePullResultRequest): void;
}

export class OpenLinkerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly responseBody: unknown;

  constructor(message: string, options: {
    status: number;
    code: string;
    details?: unknown;
    requestId?: string | undefined;
    retryAfterMs?: number | undefined;
    responseBody?: unknown;
  }) {
    super(message);
    this.name = "OpenLinkerError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.responseBody = options.responseBody;
  }
}

export class OpenLinkerClient {
  readonly baseUrl: string;

  readonly #accessToken:
    | string
    | (() => string | Promise<string | undefined>)
    | undefined;
  readonly #runtimeToken:
    | string
    | (() => string | Promise<string | undefined>)
    | undefined;
  readonly #headers:
    | HeadersInit
    | (() => HeadersInit | Promise<HeadersInit>)
    | undefined;
  readonly #fetch: FetchLike;
  readonly #sdkAgent: string;

  constructor(options: OpenLinkerClientOptions) {
    if (!options.baseUrl || !options.baseUrl.trim()) {
      throw new Error("OpenLinkerClient requires baseUrl");
    }

    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
      throw new Error("OpenLinkerClient requires a fetch implementation");
    }

    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#accessToken = options.accessToken;
    this.#runtimeToken = options.runtimeToken;
    this.#headers = options.headers;
    this.#fetch = fetchImpl as FetchLike;
    this.#sdkAgent = options.sdkAgent ?? "@openlinker/sdk-js/0.0.0";
  }

  async listAgents(
    params: ListAgentsParams = {},
    options: RequestOptions = {},
  ): Promise<MarketListResponse> {
    const query = new URLSearchParams();
    appendQuery(query, "q", params.query);
    appendQuery(query, "page", params.page);
    appendQuery(query, "size", params.size);
    appendQuery(query, "callable_only", params.callableOnly);
    if (params.tags?.length) {
      query.set("tags", params.tags.filter(Boolean).join(","));
    }
    return this.request("GET", "/agents", undefined, options, query);
  }

  async getAgent(
    slug: string,
    options: RequestOptions = {},
  ): Promise<AgentDetailResponse> {
    return this.request("GET", `/agents/${encodeURIComponent(slug)}`, undefined, options);
  }

  async getAgentCard(
    slug: string,
    options: RequestOptions & { extended?: boolean } = {},
  ): Promise<AgentCardResponse> {
    const suffix = options.extended ? "agent-card.extended.json" : "agent-card.json";
    return this.request(
      "GET",
      `/agents/${encodeURIComponent(slug)}/${suffix}`,
      undefined,
      options,
    );
  }

  async runAgent(
    request: RunAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.request("POST", "/run", toRunRequestBody(request), options);
  }

  async runAgentWithCallbacks(
    request: RunAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    const callback = platformCallbackFromRunRequest(request);
    if (!callback) {
      return this.runAgent(request, options);
    }
    const started = await this.startAgentRun(request, options);
    await this.streamPlatformRunCallbacks(started.run_id, callback, options, true);
    return this.getRun(started.run_id, options);
  }

  async startAgentRun(
    request: RunAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.request("POST", "/runs", toRunRequestBody(request), options);
  }

  async startAgentRunWithCallbacks(
    request: RunAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    const started = await this.startAgentRun(request, options);
    const callback = platformCallbackFromRunRequest(request);
    if (callback) {
      void this.streamPlatformRunCallbacks(started.run_id, callback, options, false).catch(async (error) => {
        await callback.onError?.(error);
      });
    }
    return started;
  }

  async getRun(
    runId: string,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.request("GET", `/runs/${encodeURIComponent(runId)}`, undefined, options);
  }

  async listRunEvents(
    runId: string,
    params: ListRunEventsParams = {},
    options: RequestOptions = {},
  ): Promise<ListRunEventsResponse> {
    const query = new URLSearchParams();
    appendQuery(query, "after_sequence", params.afterSequence);
    appendQuery(query, "limit", params.limit);
    return this.request(
      "GET",
      `/runs/${encodeURIComponent(runId)}/events`,
      undefined,
      options,
      query,
    );
  }

  async listRunArtifacts(
    runId: string,
    options: RequestOptions = {},
  ): Promise<ListItemsResponse<RunArtifactResponse>> {
    return this.request(
      "GET",
      `/runs/${encodeURIComponent(runId)}/artifacts`,
      undefined,
      options,
    );
  }

  async listRunMessages(
    runId: string,
    options: RequestOptions = {},
  ): Promise<ListItemsResponse<RunMessageResponse>> {
    return this.request(
      "GET",
      `/runs/${encodeURIComponent(runId)}/messages`,
      undefined,
      options,
    );
  }

  async streamRunEvents(
    runId: string,
    handlers: StreamRunEventHandlers = {},
    options: StreamRunEventsOptions = {},
  ): Promise<void> {
    const query = new URLSearchParams();
    appendQuery(query, "after_sequence", options.afterSequence);
    const response = await this.fetchRaw(
      "GET",
      `/runs/${encodeURIComponent(runId)}/stream`,
      undefined,
      options,
      query,
      "text/event-stream",
    );

    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (!response.body) {
      throw new Error("OpenLinker stream response does not expose a body");
    }

    await readEventStream(response.body, handlers);
  }

  private async streamPlatformRunCallbacks(
    runId: string,
    callback: PlatformRunCallbackConfig,
    options: RequestOptions,
    untilTerminal: boolean,
  ): Promise<StreamRunEvent | undefined> {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    }
    let terminal: StreamRunEvent | undefined;
    try {
      const handlers: StreamRunEventHandlers = {
        onEvent: async (event) => {
          if (matchesPlatformCallbackEvent(callback, event)) {
            await callback.onEvent?.(event);
          }
        },
        onTerminal: async (event) => {
          terminal = event;
          await callback.onTerminal?.(event);
          if (untilTerminal) {
            controller.abort();
          }
        },
      };
      if (callback.onClose) {
        handlers.onClose = callback.onClose;
      }
      await this.streamRunEvents(runId, {
        ...handlers,
      }, {
        ...options,
        signal: controller.signal,
        afterSequence: callback.afterSequence,
      });
    } catch (error) {
      if (!(untilTerminal && terminal && isAbortError(error))) {
        throw error;
      }
    } finally {
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
    return terminal;
  }

  async heartbeatAgent(
    options: RequestOptions = {},
  ): Promise<AgentHeartbeatResponse> {
    return this.request(
      "POST",
      "/agent-runtime/heartbeat",
      undefined,
      await this.withRuntimeToken(options),
    );
  }

  async claimRuntimeRun(
    params: ClaimRuntimeRunParams = {},
    options: RequestOptions = {},
  ): Promise<RuntimePullRunResponse | undefined> {
    return (await this.claimRuntimeRunDetailed(params, options)).run;
  }

  async claimRuntimeRunDetailed(
    params: ClaimRuntimeRunParams = {},
    options: RequestOptions = {},
  ): Promise<ClaimRuntimeRunResult> {
    const query = new URLSearchParams();
    appendQuery(query, "wait", params.wait);
    const response = await this.fetchRaw(
      "GET",
      "/agent-runtime/runs/claim",
      undefined,
      await this.withRuntimeToken(options),
      query,
    );
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (response.status === 204) {
      return {
        retryAfterMs: retryAfterMs(response.headers),
        maxClaimWaitSeconds: numberHeader(response.headers, "x-openlinker-max-claim-wait-seconds"),
      };
    }
    return { run: await readResponse<RuntimePullRunResponse>(response) };
  }

  async completeRuntimeRun(
    runId: string,
    result: RuntimePullResultRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.request(
      "POST",
      `/agent-runtime/runs/${encodeURIComponent(runId)}/result`,
      result,
      await this.withRuntimeToken(options),
    );
  }

  async callAgent(
    request: CallAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.callAgentAt("", request, options);
  }

  async callAgentAt(
    endpoint: string,
    request: CallAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.request(
      "POST",
      endpoint || "/agent-runtime/call-agent",
      toCallAgentRequestBody(request),
      await this.withRuntimeToken(options),
    );
  }

  async runRuntimePullLoop(
    handlers: RuntimeHandlers,
    options: RuntimePullLoopOptions = {},
  ): Promise<void> {
    const waitSeconds = options.waitSeconds ?? 25;
    const heartbeatMs = options.heartbeatMs ?? 60_000;
    const emptyRetryMs = options.emptyRetryMs ?? 5_000;
    let processed = 0;
    let lastHeartbeat = 0;

    while (!options.signal?.aborted && (!options.maxRuns || processed < options.maxRuns)) {
      const now = Date.now();
      if (now - lastHeartbeat >= heartbeatMs) {
        try {
          await this.heartbeatAgent(options);
        } catch (error) {
          await handlers.onError?.(error);
        }
        lastHeartbeat = Date.now();
      }

      try {
        const claim = await this.claimRuntimeRunDetailed({ wait: waitSeconds }, options);
        if (claim.run) {
          await handlers.onAssigned?.(runtimeAssignmentFromPullRun(claim.run));
          processed += 1;
          continue;
        }
        if (options.stopOnEmpty) {
          return;
        }
        await sleep(claim.retryAfterMs ?? emptyRetryMs, options.signal);
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
          return;
        }
        await handlers.onError?.(error);
        const retryAfter = error instanceof OpenLinkerError ? error.retryAfterMs : undefined;
        await sleep(retryAfter ?? emptyRetryMs, options.signal);
      }
    }
  }

  async connectRuntimeWebSocket(
    handlers: RuntimeHandlers,
    options: RuntimeWebSocketOptions = {},
  ): Promise<RuntimeWebSocketConnection> {
    const headers = await this.runtimeWebSocketHeaders(options);
    const url = this.webSocketUrl(options.endpoint ?? "/agent-runtime/ws");
    const connection = new RuntimeWebSocketConnectionImpl(url, headers, handlers, options);
    connection.start();
    return connection;
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
  ): Promise<T> {
    const response = await this.fetchRaw(method, path, body, options, query);
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    return await readResponse<T>(response);
  }

  private async fetchRaw(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    query?: URLSearchParams,
    accept = "application/json",
  ): Promise<Response> {
    const headers = await this.buildHeaders(options, body !== undefined);
    headers.set("accept", accept);
    const init: RequestInit = {
      method,
      headers,
    };
    if (options.signal) {
      init.signal = options.signal;
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return await this.#fetch(this.url(path, query), init);
  }

  private url(path: string, query?: URLSearchParams): string {
    let url: URL;
    if (path.startsWith("http://") || path.startsWith("https://")) {
      url = new URL(path);
    } else {
      const normalizedPath = path
        .replace(/^\/+/, "")
        .replace(/^api\/v1\/?/, "");
      url = new URL(`${this.baseUrl}/api/v1/${normalizedPath}`);
    }
    query?.forEach((value, key) => {
      url.searchParams.append(key, value);
    });
    return url.toString();
  }

  private webSocketUrl(path: string): string {
    const url = new URL(path.startsWith("ws://") || path.startsWith("wss://")
      ? path
      : this.url(path));
    if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    }
    return url.toString();
  }

  private async buildHeaders(
    options: RequestOptions,
    hasBody: boolean,
  ): Promise<Headers> {
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("x-openlinker-sdk", this.#sdkAgent);
    if (hasBody) {
      headers.set("content-type", "application/json");
    }

    const defaultHeaders = await resolveMaybe(this.#headers);
    mergeHeaders(headers, defaultHeaders);
    mergeHeaders(headers, options.headers);

    const token = await resolveMaybe(this.#accessToken);
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return headers;
  }

  private async withRuntimeToken(options: RequestOptions): Promise<RequestOptions> {
    const runtimeToken = await resolveMaybe(this.#runtimeToken);
    if (!runtimeToken) {
      return options;
    }
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${runtimeToken}`);
    return {
      ...options,
      headers,
    };
  }

  private async runtimeWebSocketHeaders(options: RequestOptions): Promise<Record<string, string>> {
    const headers = await this.buildHeaders(await this.withRuntimeToken(options), false);
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
}

function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (base.endsWith("/api/v1")) {
    base = base.slice(0, -"/api/v1".length);
  }
  return base;
}

function appendQuery(
  query: URLSearchParams,
  name: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  query.set(name, String(value));
}

function toRunRequestBody(request: RunAgentRequest): {
  agent_id: string;
  input: JsonValue;
  metadata?: JsonValue;
  task_callback?: JsonValue;
} {
  const taskCallback = webhookCallbackFromRunRequest(request)
    ?? request.taskCallback
    ?? request.pushNotification
    ?? request.pushNotificationConfig;
  return {
    agent_id: request.agentId,
    input: request.input,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(taskCallback ? { task_callback: toTaskCallbackBody(taskCallback) } : {}),
  };
}

function webhookCallbackFromRunRequest(request: RunAgentRequest): TaskCallbackConfig | undefined {
  const callback = request.callback;
  if (!callback) return undefined;
  if ("mode" in callback && callback.mode === "webhook") return callback;
  if ("url" in callback && callback.url) return callback as TaskCallbackConfig;
  return undefined;
}

function platformCallbackFromRunRequest(request: RunAgentRequest): PlatformRunCallbackConfig | undefined {
  const callback = request.callback;
  if (!callback) return undefined;
  if ("mode" in callback && callback.mode === "webhook") return undefined;
  if ("url" in callback && callback.url) return undefined;
  return callback as PlatformRunCallbackConfig;
}

function matchesPlatformCallbackEvent(
  callback: PlatformRunCallbackConfig,
  event: StreamRunEvent,
): boolean {
  return !callback.eventTypes?.length || callback.eventTypes.includes(event.event);
}

function toCallAgentRequestBody(request: CallAgentRequest): {
  current_run_id?: string;
  parent_run_id?: string;
  target_agent_id: string;
  reason?: string;
  input: JsonValue;
  metadata?: JsonValue;
  task_callback?: JsonValue;
} {
  const taskCallback = request.taskCallback ?? request.pushNotification ?? request.pushNotificationConfig;
  return {
    ...(request.currentRunId ? { current_run_id: request.currentRunId } : {}),
    ...(request.parentRunId ? { parent_run_id: request.parentRunId } : {}),
    target_agent_id: request.targetAgentId,
    ...(request.reason ? { reason: request.reason } : {}),
    input: request.input,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(taskCallback ? { task_callback: toTaskCallbackBody(taskCallback) } : {}),
  };
}

function toTaskCallbackBody(config: TaskCallbackConfig): JsonObject {
  const body: JsonObject = {};
  if (config.url) body.url = config.url;
  if (config.token) body.token = config.token;
  if (config.secret) body.secret = config.secret;
  if (config.authentication) {
    body.authentication = {
      ...(config.authentication.scheme ? { scheme: config.authentication.scheme } : {}),
      ...(config.authentication.credentials ? { credentials: config.authentication.credentials } : {}),
    };
  }
  if (config.metadata) body.metadata = config.metadata;
  if (config.eventTypes) body.eventTypes = config.eventTypes;
  if (config.event_types) body.event_types = config.event_types;
  return body;
}

async function resolveMaybe<T>(
  value: T | (() => T | Promise<T>) | undefined,
): Promise<T | undefined> {
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return value;
}

function mergeHeaders(target: Headers, headers: HeadersInit | undefined): void {
  if (!headers) {
    return;
  }
  for (const [key, value] of new Headers(headers)) {
    target.set(key, value);
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json() as T;
  }
  return await response.text() as T;
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    const delay = retryAt - Date.now();
    return delay > 0 ? delay : undefined;
  }
  return undefined;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function runtimeAssignmentFromPullRun(run: RuntimePullRunResponse): RuntimeAssignment {
  return {
    type: "run.assigned",
    run_id: run.run_id,
    agent_id: run.agent_id,
    input: run.input,
    ...(run.metadata !== undefined ? { metadata: run.metadata } : {}),
    source: run.source,
    result_endpoint: run.result_endpoint,
    result_method: run.result_method,
    result_required: run.result_required,
    ...(run.a2a ? { a2a: run.a2a } : {}),
  };
}

function runtimeAssignmentFromWSMessage(message: RuntimeWSServerMessage): RuntimeAssignment {
  return {
    type: message.type,
    run_id: message.run_id ?? "",
    ...(message.agent_id ? { agent_id: message.agent_id } : {}),
    ...(message.input !== undefined ? { input: message.input } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    ...(message.source ? { source: message.source } : {}),
    ...(message.result_endpoint ? { result_endpoint: message.result_endpoint } : {}),
    ...(message.result_method ? { result_method: message.result_method } : {}),
    ...(message.result_required !== undefined ? { result_required: message.result_required } : {}),
    ...(message.a2a ? { a2a: message.a2a } : {}),
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function errorFromResponse(response: Response): Promise<OpenLinkerError> {
  const text = await response.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const errorBody = isRecord(parsed) && isRecord(parsed.error)
    ? parsed.error
    : undefined;
  const codeValue = errorBody?.code;
  const messageValue = errorBody?.message;
  const code = typeof codeValue === "string" ? codeValue : `HTTP_${response.status}`;
  const message = typeof messageValue === "string"
    ? messageValue
    : response.statusText || `OpenLinker request failed with ${response.status}`;
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-correlation-id") ??
    undefined;

  return new OpenLinkerError(message, {
    status: response.status,
    code,
    details: errorBody?.details,
    requestId,
    retryAfterMs: retryAfterMs(response.headers),
    responseBody: parsed,
  });
}

class RuntimeWebSocketConnectionImpl implements RuntimeWebSocketConnection {
  readonly supportsLiveEvents = true;
  readonly ready: Promise<void>;

  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #handlers: RuntimeHandlers;
  readonly #options: RuntimeWebSocketOptions;
  readonly #webSocketFactory: RuntimeWebSocketFactory;
  #socket: RuntimeWebSocketLike | undefined;
  #closed = false;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #reconnectDelayMs: number;
  #resolveReady!: () => void;
  #readyResolved = false;

  constructor(
    url: string,
    headers: Record<string, string>,
    handlers: RuntimeHandlers,
    options: RuntimeWebSocketOptions,
  ) {
    this.#url = url;
    this.#headers = headers;
    this.#handlers = handlers;
    this.#options = options;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#reconnectDelayMs = options.reconnectMinMs ?? 500;
    this.ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  start(): void {
    this.#connect();
  }

  close(code?: number, reason?: string): void {
    this.#closed = true;
    this.#stopHeartbeat();
    this.#socket?.close(code, reason);
  }

  sendRunEvent(runId: string, event: AgentEvent): void {
    this.#send({
      type: "run.event",
      id: `event-${runId}-${Date.now()}`,
      run_id: runId,
      event_type: event.event_type,
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
    });
  }

  completeRun(runId: string, result: RuntimePullResultRequest): void {
    this.#send({
      type: "run.result",
      id: `result-${runId}-${Date.now()}`,
      run_id: runId,
      status: result.status,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.events ? { events: result.events } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.duration_ms !== undefined ? { duration_ms: result.duration_ms } : {}),
    });
  }

  #connect(): void {
    if (this.#closed) {
      return;
    }
    const socket = this.#webSocketFactory(this.#url, {
      headers: this.#headers,
      protocols: this.#options.protocols,
    });
    this.#socket = socket;
    this.#listen(socket, "open", () => {
      this.#reconnectDelayMs = this.#options.reconnectMinMs ?? 500;
      if (!this.#readyResolved) {
        this.#readyResolved = true;
        this.#resolveReady();
      }
      this.#startHeartbeat(socket);
    });
    this.#listen(socket, "message", (event) => {
      void this.#handleMessage((event as { data?: unknown }).data);
    });
    this.#listen(socket, "error", (event) => {
      void this.#handlers.onError?.(event);
    });
    this.#listen(socket, "close", () => {
      this.#stopHeartbeat();
      if (!this.#closed && this.#options.reconnect !== false) {
        this.#scheduleReconnect();
      }
    });
  }

  #listen(socket: RuntimeWebSocketLike, type: string, listener: (event: unknown) => void): void {
    if (socket.addEventListener) {
      socket.addEventListener(type, listener);
      return;
    }
    switch (type) {
      case "open":
        socket.onopen = listener;
        break;
      case "message":
        socket.onmessage = listener as (event: { data: unknown }) => void;
        break;
      case "error":
        socket.onerror = listener;
        break;
      case "close":
        socket.onclose = listener;
        break;
      default:
    }
  }

  #scheduleReconnect(): void {
    const delay = this.#reconnectDelayMs;
    const maxDelay = this.#options.reconnectMaxMs ?? 10_000;
    this.#reconnectDelayMs = Math.min(delay * 2, maxDelay);
    setTimeout(() => this.#connect(), delay);
  }

  #startHeartbeat(socket: RuntimeWebSocketLike): void {
    this.#stopHeartbeat();
    const heartbeatMs = this.#options.heartbeatMs ?? 60_000;
    if (heartbeatMs <= 0) {
      return;
    }
    this.#heartbeatTimer = setInterval(() => {
      if (this.#closed || this.#socket !== socket) {
        return;
      }
      try {
        this.#send({
          type: "heartbeat",
          id: `heartbeat-${Date.now()}`,
        });
      } catch (error) {
        void this.#handlers.onError?.(error);
      }
    }, heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer === undefined) {
      return;
    }
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  async #handleMessage(raw: unknown): Promise<void> {
    const text = typeof raw === "string"
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : String(raw ?? "");
    let message: RuntimeWSServerMessage;
    try {
      message = JSON.parse(text) as RuntimeWSServerMessage;
    } catch (error) {
      await this.#handlers.onError?.(error);
      return;
    }
    await this.#handlers.onMessage?.(message);
    switch (message.type) {
      case "runtime.ready":
        await this.#handlers.onReady?.(message);
        break;
      case "run.assigned":
        await this.#handlers.onAssigned?.(runtimeAssignmentFromWSMessage(message));
        break;
      case "error":
        await this.#handlers.onError?.(runtimeWebSocketError(message));
        break;
      default:
    }
  }

  #send(message: unknown): void {
    if (!this.#socket || (typeof this.#socket.readyState === "number" && this.#socket.readyState !== 1)) {
      throw new Error("OpenLinker runtime websocket is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }
}

function defaultWebSocketFactory(
  url: string,
  options: RuntimeWebSocketFactoryOptions,
): RuntimeWebSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("OpenLinker runtime websocket requires a WebSocket implementation");
  }
  return new WebSocketCtor(url, options.protocols) as RuntimeWebSocketLike;
}

function runtimeWebSocketError(message: RuntimeWSServerMessage): Error {
  if (message.error?.code) {
    return new Error(`OpenLinker runtime websocket error: ${message.error.code}: ${message.error.message}`);
  }
  return new Error(`OpenLinker runtime websocket error: ${message.error?.message ?? "unknown"}`);
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamRunEventHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventId = undefined;
      return;
    }

    const rawData = dataLines.join("\n");
    let data: unknown = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // SSE data is allowed to be plain text.
    }

    const event: StreamRunEvent = {
      id: eventId,
      event: eventName,
      data,
    };
    await handlers.onEvent?.(event);
    if (isTerminalRunEvent(event)) {
      await handlers.onTerminal?.(event);
    }

    eventName = "message";
    eventId = undefined;
    dataLines = [];
  };

  const handleLine = async (line: string): Promise<void> => {
    if (line === "") {
      await dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        eventName = value || "message";
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        eventId = value;
        break;
      default:
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    await handleLine(buffer.replace(/\r$/, ""));
  }
  await dispatch();
  await handlers.onClose?.();
}

function isTerminalRunEvent(event: StreamRunEvent): boolean {
  return (
    event.event === "run.completed" ||
    event.event === "run.failed" ||
    event.event === "run.canceled"
  );
}
