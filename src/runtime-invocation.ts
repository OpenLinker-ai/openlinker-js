import type {
  RuntimeCallAgentAuthorization,
  RuntimeInvocationProofRequest,
} from "./runtime-types.js";

export const RuntimeCallAgentPath = "/api/v1/agent-runtime/call-agent" as const;

const RuntimeInvocationProofDomain = "openlinker/runtime-v2/invocation-proof";
const encoder = new TextEncoder();

/**
 * Builds the assignment-scoped proof used by Core's Runtime call-agent
 * endpoint. `body` is hashed exactly as supplied and must be sent unchanged.
 */
export async function buildRuntimeInvocationProof(
  token: string,
  request: RuntimeInvocationProofRequest,
): Promise<string> {
  const method = request.method.trim().toUpperCase();
  const path = request.path.trim();
  const context = request.context.trim();
  if (!method || !path.startsWith("/") || !context || !token.startsWith("ol_inv_v2.")) {
    throw new TypeError("OpenLinker Runtime: invalid invocation proof input");
  }
  assertIdempotencyKey(request.idempotencyKey);
  if (!(request.body instanceof Uint8Array)) {
    throw new TypeError("OpenLinker Runtime: invocation proof body must be Uint8Array");
  }
  assertWellFormedUnicode(method, "method");
  assertWellFormedUnicode(path, "path");
  assertWellFormedUnicode(context, "context");

  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("OpenLinker Runtime: Web Crypto is required for invocation proofs");
  }
  const bodyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(request.body)));
  // These keys are already in RFC 8785 UTF-16 order and all values are
  // strings, so JSON.stringify is the exact JCS representation used by Core.
  const canonical = JSON.stringify({
    body_sha256: hex(bodyDigest),
    context,
    idempotency_key: request.idempotencyKey,
    method,
    path,
    version: RuntimeInvocationProofDomain,
  });
  const proofKey = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${RuntimeInvocationProofDomain}\0${token}`),
  ));
  const key = await crypto.subtle.importKey(
    "raw",
    proofKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
  return base64URL(signature);
}

export function assertRuntimeIdempotencyKey(value: string): void {
  assertIdempotencyKey(value);
}

export function assertRuntimeCallAgentAuthorization(
  value: RuntimeCallAgentAuthorization,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("OpenLinker Runtime: delegated call authorization must be an object");
  }
  const allowed = new Set(["invocationContext", "token", "idempotencyKey"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`OpenLinker Runtime: delegated call authorization contains unknown field ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`OpenLinker Runtime: delegated call authorization is missing field ${key}`);
    }
  }
  if (!validCapability(value.invocationContext, "ol_ctx_v2.") || !validCapability(value.token, "ol_inv_v2.")) {
    throw new TypeError("OpenLinker Runtime: delegated call authorization is invalid");
  }
  assertIdempotencyKey(value.idempotencyKey);
  if (value.idempotencyKey !== value.idempotencyKey.trim()) {
    throw new TypeError("OpenLinker Runtime: delegated call idempotencyKey cannot contain surrounding whitespace");
  }
}

function assertIdempotencyKey(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || !/^[\x20-\x7e]+$/.test(value)) {
    throw new TypeError("OpenLinker Runtime: idempotencyKey must be 1-255 printable ASCII characters");
  }
}

function validCapability(value: string, prefix: string): boolean {
  if (typeof value !== "string" || value !== value.trim() || value.length > 8192 || !value.startsWith(prefix)) {
    return false;
  }
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => part.length > 0);
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`OpenLinker Runtime: invocation proof ${label} is not valid Unicode`);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`OpenLinker Runtime: invocation proof ${label} is not valid Unicode`);
    }
  }
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
}

function base64URL(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    value += alphabet.charAt(first >> 2);
    value += alphabet.charAt(((first & 0x03) << 4) | ((second ?? 0) >> 4));
    if (second !== undefined) {
      value += alphabet.charAt(((second & 0x0f) << 2) | ((third ?? 0) >> 6));
    }
    if (third !== undefined) {
      value += alphabet.charAt(third & 0x3f);
    }
  }
  return value;
}
