import type {
  AgentCardResponse,
  AgentDetailResponse,
  AgentHeartbeatResponse,
  CallAgentRequest,
  ClaimRuntimeRunParams,
  JsonObject,
  ListAgentsParams,
  ListItemsResponse,
  ListRunEventsParams,
  ListRunEventsResponse,
  MarketListResponse,
  RuntimePullResultRequest,
  RuntimePullRunResponse,
  RunAgentRequest,
  RunArtifactResponse,
  RunMessageResponse,
  RunResponse,
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

export class OpenLinkerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly responseBody: unknown;

  constructor(message: string, options: {
    status: number;
    code: string;
    details?: unknown;
    requestId?: string | undefined;
    responseBody?: unknown;
  }) {
    super(message);
    this.name = "OpenLinkerError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
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

  async startAgentRun(
    request: RunAgentRequest,
    options: RequestOptions = {},
  ): Promise<RunResponse> {
    return this.request("POST", "/runs", toRunRequestBody(request), options);
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
    const query = new URLSearchParams();
    appendQuery(query, "wait", params.wait);
    return this.request(
      "GET",
      "/agent-runtime/runs/claim",
      undefined,
      await this.withRuntimeToken(options),
      query,
    );
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
    return this.request(
      "POST",
      "/agent-runtime/call-agent",
      toCallAgentRequestBody(request),
      await this.withRuntimeToken(options),
    );
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
    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await response.json() as T;
    }
    return await response.text() as T;
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
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}/api/v1${normalizedPath}`);
    query?.forEach((value, key) => {
      url.searchParams.append(key, value);
    });
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
  input: JsonObject;
  metadata?: JsonObject;
} {
  return {
    agent_id: request.agentId,
    input: request.input,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

function toCallAgentRequestBody(request: CallAgentRequest): {
  current_run_id?: string;
  parent_run_id?: string;
  target_agent_id: string;
  reason?: string;
  input: JsonObject;
  metadata?: JsonObject;
} {
  return {
    ...(request.currentRunId ? { current_run_id: request.currentRunId } : {}),
    ...(request.parentRunId ? { parent_run_id: request.parentRunId } : {}),
    target_agent_id: request.targetAgentId,
    ...(request.reason ? { reason: request.reason } : {}),
    input: request.input,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
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
    responseBody: parsed,
  });
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
