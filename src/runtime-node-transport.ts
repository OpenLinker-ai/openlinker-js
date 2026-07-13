import { readFile } from "node:fs/promises";
import type { ConnectionOptions } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import WebSocket, { type ClientOptions } from "ws";
import { OpenLinkerRuntime } from "./runtime-client.js";
import {
  RuntimeWebSocketSession,
  type RuntimeWebSocketSessionOptions,
} from "./runtime-websocket.js";
import type { RuntimeHelloPayload, RuntimeReadyPayload } from "./runtime-types.js";

const discoveryPath = "/.well-known/openlinker.json";
const discoveryMaxBytes = 64 * 1024;
const runtimeWebSocketPath = "/api/v1/agent-runtime/ws";
const workerAgent = "openlinker-js/runtime-worker";

export interface RuntimeMTLSConfig {
  certFile: string;
  keyFile: string;
  caFile: string;
  serverName?: string | undefined;
}

export interface RuntimeDiscoveryOptions {
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
}

export interface NodeRuntimeTransportOptions {
  runtimeURL: string;
  agentToken: string;
  mtls: RuntimeMTLSConfig;
}

export interface RuntimeWebSocketConnection {
  readonly session: RuntimeWebSocketSession;
  readonly ready: RuntimeReadyPayload;
  readonly done: Promise<void>;
  close(code?: number, reason?: string): void;
}

interface RuntimeTLSMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  serverName?: string | undefined;
}

/**
 * Resolves the dedicated Runtime origin through the public, credential-free
 * platform manifest. Redirects are rejected and no Agent Token or mTLS client
 * certificate is attached to this request.
 */
export async function discoverRuntimeURL(
  platformURL: string,
  options: RuntimeDiscoveryOptions = {},
): Promise<string> {
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
    const manifest = decodeDiscoveryManifest(raw);
    return validateRuntimeURL(manifest.runtimeURL);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Node 20 mTLS HTTP and WebSocket transport for the server-only Runtime entry. */
export class NodeRuntimeTransport {
  readonly runtimeURL: string;
  readonly client: OpenLinkerRuntime;
  private constructor(
    runtimeURL: string,
    private readonly agentToken: string,
    private readonly tls: RuntimeTLSMaterial,
    private readonly dispatcher: Agent,
  ) {
    this.runtimeURL = runtimeURL;
    this.client = new OpenLinkerRuntime({
      baseUrl: runtimeURL,
      agentToken,
      sdkAgent: workerAgent,
      fetch: async (input, init) => {
        return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher,
          redirect: "error",
        }) as unknown as Response;
      },
    });
  }

  static async connect(options: NodeRuntimeTransportOptions): Promise<NodeRuntimeTransport> {
    const runtimeURL = validateRuntimeURL(options.runtimeURL);
    if (!options.agentToken.trim()) throw new Error("Agent Token is required");
    const tls = await loadTLSMaterial(options.mtls);
    const dispatcher = new Agent({
      connect: {
        cert: tls.cert,
        key: tls.key,
        ca: tls.ca,
        servername: tls.serverName,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
      headersTimeout: 35_000,
      bodyTimeout: 0,
      keepAliveTimeout: 90_000,
    });
    return new NodeRuntimeTransport(runtimeURL, options.agentToken, tls, dispatcher);
  }

  async dialWebSocket(
    hello: RuntimeHelloPayload,
    options: RuntimeWebSocketSessionOptions = {},
    signal?: AbortSignal,
  ): Promise<RuntimeWebSocketConnection> {
    const url = new URL(this.runtimeURL);
    url.protocol = "wss:";
    url.pathname = runtimeWebSocketPath;
    const socketOptions: ClientOptions & ConnectionOptions = {
      headers: {
        authorization: `Bearer ${this.agentToken}`,
        "x-openlinker-sdk": workerAgent,
      },
      cert: this.tls.cert,
      key: this.tls.key,
      ca: this.tls.ca,
      servername: this.tls.serverName,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    };
    const socket = new WebSocket(url, [], socketOptions);
    await waitForSocketOpen(socket, signal);
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const session = new RuntimeWebSocketSession(socket as unknown as ConstructorParameters<typeof RuntimeWebSocketSession>[0], {
      ...options,
      onClose: (event) => {
        resolveDone?.();
        options.onClose?.(event);
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

export function validateRuntimeURL(raw: string): string {
  return validateOrigin(raw, false, "Runtime connection address");
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

function decodeDiscoveryManifest(value: unknown): { runtimeURL: string } {
  if (!isObject(value) || !isObject(value.base_urls) || !isObject(value.runtime) ||
    typeof value.base_urls.runtime !== "string" || value.runtime.enabled !== true ||
    value.runtime.mtls_required !== true) {
    throw new Error("OpenLinker connection information does not provide the required mTLS Runtime address");
  }
  return { runtimeURL: value.base_urls.runtime };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForSocketOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
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
      reject(new Error(`Runtime WebSocket closed during handshake (${code} ${reason.toString("utf8")})`));
    };
    const onAbort = () => {
      cleanup();
      socket.terminate();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
