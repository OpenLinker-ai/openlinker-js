import { readFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { ConnectionOptions } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import WebSocket, { type ClientOptions } from "ws";
import { OpenLinkerError } from "./client.js";
import { OpenLinkerRuntime } from "./runtime-client.js";
import {
  RuntimeWebSocketError,
  RuntimeWebSocketSession,
  type RuntimeWebSocketSessionOptions,
} from "./runtime-websocket.js";
import type { RuntimeHelloPayload, RuntimeReadyPayload } from "./runtime-types.js";
import {
  RuntimeCredentialManager,
  type RuntimeTLSMaterial,
} from "./runtime-credential-manager.js";
import { assertRuntimeUUID } from "./runtime-codec.js";

const discoveryPath = "/.well-known/openlinker.json";
const discoveryMaxBytes = 64 * 1024;
const runtimeWebSocketPath = "/api/v1/agent-runtime/ws";
const workerAgent = "openlinker-js/runtime-worker";

export const RuntimeFallbackReasonHeader = "OpenLinker-Runtime-Fallback-Reason" as const;
export const RuntimeNodeIDHeader = "OpenLinker-Runtime-Node" as const;
export type RuntimeFallbackReason =
  | "explicit"
  | "websocket_unavailable"
  | "policy_forced"
  | "recovery";

export interface RuntimeMTLSConfig {
  certFile?: string | undefined;
  keyFile?: string | undefined;
  caFile?: string | undefined;
  serverName?: string | undefined;
}

export interface RuntimeDiscoveryOptions {
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
}

export type RuntimeDiscoveryTransportMode = "auto" | "ws" | "pull";

export interface RuntimeTransportPolicy {
  allowedTransports: Array<Exclude<RuntimeDiscoveryTransportMode, "auto">>;
  defaultTransport: RuntimeDiscoveryTransportMode;
  heartbeatIntervalMs?: number | undefined;
  sessionStaleAfterMs?: number | undefined;
  retryMinimumMs?: number | undefined;
  retryMaximumMs?: number | undefined;
  websocketProbeIntervalMs?: number | undefined;
  websocketProbeTimeoutMs?: number | undefined;
}

export interface RuntimeDiscoveryConnection {
  runtimeURL: string;
  policy: RuntimeTransportPolicy;
  mtlsRequired?: boolean | undefined;
  credentialEndpoint?: string | undefined;
  trustBundleEndpoint?: string | undefined;
}

export interface RuntimeTransportSelection {
  mode: RuntimeDiscoveryTransportMode;
  order: Array<Exclude<RuntimeDiscoveryTransportMode, "auto">>;
}

export interface NodeRuntimeTransportOptions {
  runtimeURL: string;
  agentToken: string;
  nodeId: string;
  mtls?: RuntimeMTLSConfig | undefined;
  mtlsRequired?: boolean | undefined;
  tlsMaterial?: RuntimeTLSMaterial | undefined;
  credentialManager?: RuntimeCredentialManager | undefined;
}

export interface RuntimeWebSocketConnection {
  readonly session: RuntimeWebSocketSession;
  readonly ready: RuntimeReadyPayload;
  readonly done: Promise<void>;
  close(code?: number, reason?: string): void;
}

/**
 * Resolves the dedicated Runtime origin through the public, credential-free
 * platform manifest. Redirects are rejected and no Agent Token or mTLS client
 * certificate is attached to this request.
 */
export async function discoverRuntimeConnection(
  platformURL: string,
  options: RuntimeDiscoveryOptions = {},
): Promise<RuntimeDiscoveryConnection> {
  const origin = validatePlatformURL(platformURL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("OpenLinker Runtime discovery requires fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(`${origin}${discoveryPath}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-openlinker-sdk": workerAgent,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`OpenLinker connection information returned HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > discoveryMaxBytes) {
      throw new Error("OpenLinker connection information exceeds 64 KiB");
    }
    const body = await readBoundedBody(response, discoveryMaxBytes);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (cause) {
      throw new Error("OpenLinker connection information is not valid JSON", { cause });
    }
    return decodeRuntimeDiscoveryManifest(raw);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function discoverRuntimeURL(
  platformURL: string,
  options: RuntimeDiscoveryOptions = {},
): Promise<string> {
  return (await discoverRuntimeConnection(platformURL, options)).runtimeURL;
}

/** Node 20 mTLS HTTP and WebSocket transport for the server-only Runtime entry. */
export class NodeRuntimeTransport {
  readonly runtimeURL: string;
  readonly client: OpenLinkerRuntime;
  private constructor(
    runtimeURL: string,
    private readonly agentToken: string,
    private readonly nodeId: string,
    private tls: RuntimeTLSMaterial | undefined,
    private dispatcher: Agent,
    private readonly mtlsRequired: boolean,
    private readonly credentials?: RuntimeCredentialManager,
  ) {
    this.runtimeURL = runtimeURL;
    this.client = new OpenLinkerRuntime({
      baseUrl: runtimeURL,
      agentToken,
      sdkAgent: workerAgent,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set(RuntimeNodeIDHeader, this.nodeId);
        const execute = async () => await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          headers,
          dispatcher: this.dispatcher,
          redirect: "error",
        }) as unknown as Response;
        try {
          return await execute();
        } catch (error) {
          if (!this.credentials || !runtimeCredentialTLSFailure(error)) throw error;
          await this.credentials.ensure(true);
          if (this.mtlsRequired) await this.updateTLS(this.credentials.material(this.tls?.serverName));
          return await execute();
        }
      },
    });
  }

  static async connect(options: NodeRuntimeTransportOptions): Promise<NodeRuntimeTransport> {
    const mtlsRequired = options.mtlsRequired ?? true;
    const runtimeURL = validateRuntimeURL(options.runtimeURL, !mtlsRequired);
    if (!options.agentToken.trim()) throw new Error("Agent Token is required");
    const nodeId = assertRuntimeUUID(options.nodeId, "Runtime Node ID");
    const tls = options.tlsMaterial ?? (mtlsRequired ? await loadTLSMaterial(options.mtls ?? {}) : undefined);
    const dispatcher = createDispatcher(tls, mtlsRequired);
    return new NodeRuntimeTransport(
      runtimeURL, options.agentToken, nodeId, tls, dispatcher, mtlsRequired, options.credentialManager,
    );
  }

  async updateTLS(tls: RuntimeTLSMaterial): Promise<void> {
    const replacement = createDispatcher(tls, true);
    const previous = this.dispatcher;
    this.tls = tls;
    this.dispatcher = replacement;
    await previous.close();
  }

  async dialWebSocket(
    hello: RuntimeHelloPayload,
    options: RuntimeWebSocketSessionOptions = {},
    signal?: AbortSignal,
    fallbackReason?: RuntimeFallbackReason,
  ): Promise<RuntimeWebSocketConnection> {
    const url = new URL(this.runtimeURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = runtimeWebSocketPath;
    const socketOptions: ClientOptions & ConnectionOptions = {
      headers: {
        authorization: `Bearer ${this.agentToken}`,
        "x-openlinker-sdk": workerAgent,
        [RuntimeNodeIDHeader]: this.nodeId,
      },
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    };
    if (this.mtlsRequired && this.tls) {
      socketOptions.cert = this.tls.cert;
      socketOptions.key = this.tls.key;
      socketOptions.ca = this.tls.ca;
      socketOptions.servername = this.tls.serverName;
      socketOptions.rejectUnauthorized = true;
      socketOptions.minVersion = "TLSv1.3";
    }
    if (fallbackReason) {
      assertRuntimeFallbackReason(fallbackReason);
      socketOptions.headers![RuntimeFallbackReasonHeader] = fallbackReason;
    }
    let socket = new WebSocket(url, [], socketOptions);
    try {
      await waitForSocketOpen(socket, signal);
    } catch (error) {
      socket.terminate();
      if (!this.credentials || !this.mtlsRequired || !runtimeCredentialTLSFailure(error)) throw error;
      await this.credentials.ensure(true, signal);
      const material = this.credentials.material(this.tls?.serverName);
      await this.updateTLS(material);
      socketOptions.cert = material.cert;
      socketOptions.key = material.key;
      socketOptions.ca = material.ca;
      socketOptions.servername = material.serverName;
      socket = new WebSocket(url, [], socketOptions);
      await waitForSocketOpen(socket, signal);
    }
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const session = new RuntimeWebSocketSession(socket as unknown as ConstructorParameters<typeof RuntimeWebSocketSession>[0], {
      ...options,
      onClose: (event) => {
        options.onClose?.(event);
        resolveDone?.();
      },
    });
    try {
      const ready = await session.start(hello);
      return {
        session,
        ready,
        done,
        close: (code, reason) => session.close(code, reason),
      };
    } catch (error) {
      socket.close(1011, "Runtime handshake failed");
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

export function validatePlatformURL(raw: string): string {
  return validateOrigin(raw, true, "OpenLinker address");
}

export function validateRuntimeURL(raw: string, allowLoopbackHTTP = false): string {
  return validateOrigin(raw, allowLoopbackHTTP, "Runtime connection address");
}

async function loadTLSMaterial(config: RuntimeMTLSConfig): Promise<RuntimeTLSMaterial> {
  if (!config.certFile?.trim() || !config.keyFile?.trim() || !config.caFile?.trim()) {
    throw new Error("Runtime mTLS cert, key, and CA files are required");
  }
  const [cert, key, ca] = await Promise.all([
    readFile(config.certFile),
    readFile(config.keyFile),
    readFile(config.caFile),
  ]);
  if (!cert.includes(Buffer.from("BEGIN CERTIFICATE")) ||
    !ca.includes(Buffer.from("BEGIN CERTIFICATE")) ||
    !key.includes(Buffer.from("PRIVATE KEY"))) {
    throw new Error("Runtime mTLS files do not contain the expected PEM material");
  }
  return {
    cert,
    key,
    ca,
    ...(config.serverName?.trim() ? { serverName: config.serverName.trim() } : {}),
  };
}

function createDispatcher(tls: RuntimeTLSMaterial | undefined, mtlsRequired: boolean): Agent {
  return new Agent({
    connect: mtlsRequired && tls ? {
      cert: tls.cert,
      key: tls.key,
      ca: tls.ca,
      servername: tls.serverName,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    } : { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    headersTimeout: 35_000,
    bodyTimeout: 0,
    keepAliveTimeout: 90_000,
  });
}

function validateOrigin(raw: string, allowLoopbackHTTP: boolean, label: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${label} must be an absolute HTTPS origin`, { cause });
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must not include credentials, a path, query, or fragment`);
  }
  if (url.protocol !== "https:" && !(
    allowLoopbackHTTP && url.protocol === "http:" && isLoopbackHost(url.hostname)
  )) {
    throw new Error(`${label} must be an absolute HTTPS origin`);
  }
  return url.origin;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized);
}

function runtimeCredentialTLSFailure(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  return ["tls", "ssl", "x509", "certificate", "unknown authority"].some((marker) =>
    message.includes(marker)
  );
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("OpenLinker connection information exceeds 64 KiB");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function decodeRuntimeDiscoveryManifest(value: unknown): RuntimeDiscoveryConnection {
  if (!isObject(value) || !isObject(value.base_urls) || !isObject(value.runtime) ||
    typeof value.base_urls.runtime !== "string" || value.runtime.enabled !== true ||
    typeof value.runtime.mtls_required !== "boolean") {
    throw new Error("OpenLinker connection information does not provide a Runtime address");
  }
  const mtlsRequired = value.runtime.mtls_required;
  const credentialEndpoint = typeof value.runtime.credential_endpoint === "string"
    ? value.runtime.credential_endpoint
    : "";
  return {
    runtimeURL: validateRuntimeURL(value.base_urls.runtime, !mtlsRequired),
    policy: decodeRuntimeTransportPolicy(value.runtime),
    mtlsRequired,
    credentialEndpoint,
    ...(typeof value.runtime.trust_bundle_endpoint === "string"
      ? { trustBundleEndpoint: value.runtime.trust_bundle_endpoint }
      : {}),
  };
}

export function resolveRuntimeTransportSelection(
  configured: RuntimeDiscoveryTransportMode,
  policy: RuntimeTransportPolicy,
): RuntimeTransportSelection {
  if (configured !== "auto" && !policy.allowedTransports.includes(configured)) {
    throw new Error(`configured Runtime transport ${configured} is not allowed by OpenLinker`);
  }
  const mode = configured === "auto" ? policy.defaultTransport : configured;
  if (mode !== "auto") {
    if (!policy.allowedTransports.includes(mode)) {
      throw new Error(`OpenLinker Runtime default transport ${mode} is not allowed`);
    }
    return { mode, order: [mode] };
  }
  return { mode, order: [...policy.allowedTransports] };
}

function decodeRuntimeTransportPolicy(runtime: Record<string, unknown>): RuntimeTransportPolicy {
  const allowedTransports: Array<"ws" | "pull"> = [];
  const rawTransports = hasOwn(runtime, "transports")
    ? runtime.transports
    : ["websocket", "long_poll"];
  if (!Array.isArray(rawTransports)) {
    throw new Error("OpenLinker Runtime transport allowlist is invalid");
  }
  for (const raw of rawTransports) {
    if (typeof raw !== "string") {
      throw new Error("OpenLinker Runtime transport allowlist is invalid");
    }
    const mode = manifestTransportMode(raw);
    if (mode && !allowedTransports.includes(mode)) allowedTransports.push(mode);
  }
  if (allowedTransports.length === 0) {
    throw new Error("OpenLinker Runtime does not allow a transport supported by this SDK");
  }

  const rawDefault = hasOwn(runtime, "default_transport") ? runtime.default_transport : "auto";
  if (typeof rawDefault !== "string") {
    throw new Error("OpenLinker Runtime default transport is invalid");
  }
  const defaultTransport = rawDefault.trim().toLowerCase() === "auto"
    ? "auto"
    : manifestTransportMode(rawDefault);
  if (!defaultTransport) {
    throw new Error(`OpenLinker Runtime default transport ${rawDefault.trim()} is unsupported`);
  }
  if (defaultTransport !== "auto" && !allowedTransports.includes(defaultTransport)) {
    throw new Error(`OpenLinker Runtime default transport ${defaultTransport} is outside its allowlist`);
  }

  const policy: RuntimeTransportPolicy = { allowedTransports, defaultTransport };
  if (!hasOwn(runtime, "transport_policy")) return policy;
  if (!isObject(runtime.transport_policy)) {
    throw new Error("OpenLinker Runtime transport policy is invalid");
  }
  const rawPolicy = runtime.transport_policy;
  if (hasOwn(rawPolicy, "version")) {
    if (rawPolicy.version !== 1) {
      throw new Error(`OpenLinker Runtime transport policy version ${String(rawPolicy.version)} is unsupported`);
    }
  }
  policy.heartbeatIntervalMs = optionalPolicyDuration(rawPolicy, "heartbeat_interval_seconds", 1_000);
  policy.sessionStaleAfterMs = optionalPolicyDuration(rawPolicy, "session_stale_after_seconds", 1_000);
  policy.retryMinimumMs = optionalPolicyDuration(rawPolicy, "retry_minimum_ms", 1);
  policy.retryMaximumMs = optionalPolicyDuration(rawPolicy, "retry_maximum_ms", 1);
  policy.websocketProbeIntervalMs = optionalPolicyDuration(rawPolicy, "websocket_probe_interval_ms", 1);
  policy.websocketProbeTimeoutMs = optionalPolicyDuration(rawPolicy, "websocket_probe_timeout_ms", 1);
  if (policy.retryMaximumMs !== undefined &&
    (policy.retryMinimumMs ?? 250) > policy.retryMaximumMs) {
    throw new Error("OpenLinker Runtime retry maximum is below retry minimum");
  }
  if (policy.sessionStaleAfterMs !== undefined &&
    (policy.heartbeatIntervalMs ?? 5_000) >= policy.sessionStaleAfterMs) {
    throw new Error("OpenLinker Runtime heartbeat interval must be below the Session stale interval");
  }
  return policy;
}

function manifestTransportMode(value: string): "ws" | "pull" | undefined {
  switch (value.trim().toLowerCase()) {
    case "websocket":
    case "ws":
      return "ws";
    case "long_poll":
    case "pull":
      return "pull";
    default:
      return undefined;
  }
}

function optionalPolicyDuration(
  policy: Record<string, unknown>,
  field: string,
  multiplier: number,
): number | undefined {
  if (!hasOwn(policy, field)) return undefined;
  const value = policy[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86_400_000) {
    throw new Error(`OpenLinker Runtime ${field} is outside the supported range`);
  }
  const duration = (value as number) * multiplier;
  if (!Number.isSafeInteger(duration) || duration > 86_400_000) {
    throw new Error(`OpenLinker Runtime ${field} is outside the supported range`);
  }
  return duration;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function waitForSocketOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("unexpected-response", onUnexpectedResponse);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      const text = reason.toString("utf8");
      reject(new RuntimeWebSocketError(
        text || `Runtime WebSocket closed during handshake (${code})`,
        `WS_CLOSE_${code}`,
        code === 1006 || code === 1011,
        code,
      ));
    };
    const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
      cleanup();
      const settle = (error: unknown) => {
        // Handling `unexpected-response` transfers handshake cleanup to us.
        // Terminate after consuming the bounded body and absorb ws's synthetic
        // abort error so the structured Core error remains the only rejection.
        socket.once("error", () => undefined);
        socket.terminate();
        reject(error);
      };
      void runtimeUpgradeError(response).then(settle, settle);
    };
    const onAbort = () => {
      cleanup();
      socket.once("error", () => undefined);
      socket.terminate();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("unexpected-response", onUnexpectedResponse);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runtimeUpgradeError(response: IncomingMessage): Promise<Error> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > discoveryMaxBytes) {
      response.destroy();
      return new Error("Runtime WebSocket upgrade error exceeds 64 KiB");
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Error(`Runtime WebSocket upgrade returned HTTP ${response.statusCode ?? 0}`);
  }
  const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : undefined;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new OpenLinkerError(error.message, {
      status: response.statusCode ?? 0,
      code: error.code,
      responseBody: parsed,
    });
  }
  return new Error(`Runtime WebSocket upgrade returned HTTP ${response.statusCode ?? 0}`);
}

function assertRuntimeFallbackReason(reason: string): asserts reason is RuntimeFallbackReason {
  if (!["explicit", "websocket_unavailable", "policy_forced", "recovery"].includes(reason)) {
    throw new Error(`invalid Runtime fallback reason ${reason}`);
  }
}
