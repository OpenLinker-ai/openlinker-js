import type { TaskCallbackAuthentication, WebhookRunCallbackConfig } from "./types.js";

export type TaskCallbackPayloadInput = string | Uint8Array | ArrayBuffer;

export interface CreateWebhookRunCallbackOptions {
  url: string;
  secret?: string;
  token?: string;
  authentication?: TaskCallbackAuthentication;
  metadata?: WebhookRunCallbackConfig["metadata"];
  eventTypes?: string[];
  event_types?: string[];
}

export type TaskCallbackHeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

export function createWebhookRunCallback(
  options: CreateWebhookRunCallbackOptions,
): WebhookRunCallbackConfig {
  const url = options.url.trim();
  if (!url) {
    throw new Error("Task callback URL is required");
  }
  const callback: WebhookRunCallbackConfig = {
    mode: "webhook",
    url,
    secret: options.secret?.trim() || generateTaskCallbackSecret(),
  };
  if (options.token) callback.token = options.token;
  if (options.authentication) callback.authentication = options.authentication;
  if (options.metadata !== undefined) callback.metadata = options.metadata;
  if (options.eventTypes) callback.eventTypes = options.eventTypes;
  if (options.event_types) callback.event_types = options.event_types;
  return callback;
}

export function generateTaskCallbackSecret(byteLength = 32): string {
  if (byteLength <= 0) {
    throw new Error("Task callback secret byte length must be positive");
  }
  const bytes = new Uint8Array(byteLength);
  cryptoForCallbacks().getRandomValues(bytes);
  return hex(bytes);
}

export async function signTaskCallbackPayload(
  payload: TaskCallbackPayloadInput,
  secret: string,
): Promise<string> {
  const crypto = cryptoForCallbacks();
  if (!crypto.subtle) {
    throw new Error("Task callback signing requires Web Crypto subtle API");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, payloadBuffer(payload));
  return hex(new Uint8Array(signature));
}

export async function verifyTaskCallbackSignature(
  payload: TaskCallbackPayloadInput,
  secret: string,
  signature: string,
): Promise<boolean> {
  const expected = await signTaskCallbackPayload(payload, secret);
  return timingSafeEqualHex(expected, normalizeSignature(signature));
}

export async function verifyTaskCallbackHeaders(
  payload: TaskCallbackPayloadInput,
  secret: string,
  headers: TaskCallbackHeaderSource,
): Promise<boolean> {
  const signature = taskCallbackSignatureFromHeaders(headers);
  if (!signature) {
    return false;
  }
  return verifyTaskCallbackSignature(payload, secret, signature);
}

export function taskCallbackSignatureFromHeaders(
  headers: TaskCallbackHeaderSource,
): string | undefined {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get("x-openlinker-signature") ?? headers.get("X-OpenLinker-Signature") ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== "x-openlinker-signature") continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function payloadBuffer(payload: TaskCallbackPayloadInput): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function normalizeSignature(signature: string): string {
  const trimmed = signature.trim().toLowerCase();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

function timingSafeEqualHex(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeSignature(expected);
  const normalizedActual = normalizeSignature(actual);
  const maxLen = Math.max(normalizedExpected.length, normalizedActual.length);
  let diff = normalizedExpected.length ^ normalizedActual.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (normalizedExpected.charCodeAt(i) || 0) ^ (normalizedActual.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cryptoForCallbacks(): Crypto {
  if (!globalThis.crypto) {
    throw new Error("Task callback helpers require Web Crypto");
  }
  return globalThis.crypto;
}
