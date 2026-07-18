import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { OpenLinkerClient } from "./client.js";
import type { FetchLike } from "./client.js";
import type {
  RegisterAgentViaTokenRequest,
  RegisterAgentViaTokenResponse,
} from "./types.js";

export const defaultRegistrationEnvPath = ".env";
export const defaultRegistrationAPIBase = "https://api.openlinker.ai";

export type RegistrationPolicy =
  | "reuse_existing"
  | "rotate_token"
  | "force_new"
  | "validate_only";

export interface AgentRegistration {
  agentId: string;
  agentSlug: string;
  agentName: string;
  agentToken: string;
  tokenId: string;
  tokenPrefix: string;
  apiBase: string;
  registeredAt: string;
  updatedAt: string;
}

export interface RegistrationStore {
  loadAgentRegistration(): AgentRegistration | undefined | Promise<AgentRegistration | undefined>;
  saveAgentRegistration(registration: AgentRegistration): void | Promise<void>;
}

export interface EnsureAgentRequest {
  slug?: string;
  name?: string;
  description?: string;
  endpointUrl?: string;
  endpointAuthHeader?: string;
  pricePerCallCents?: number;
  tags?: string[];
  skillIds?: string[];
  visibility?: string;
  connectionMode?: string;
  mcpToolName?: string;
  tokenName?: string;
  tokenScopes?: string[];
  tokenExpiresInMinutes?: number;
  policy?: RegistrationPolicy;
  userToken?: string;
  agentToken?: string;
  apiBase?: string;
  store?: RegistrationStore;
  envPath?: string;
  fetch?: FetchLike;
}

export class EnvRegistrationStore implements RegistrationStore {
  readonly path: string;
  private operation = Promise.resolve();

  constructor(path = defaultRegistrationEnvPath) {
    this.path = resolve(path.trim() || defaultRegistrationEnvPath);
  }

  async loadAgentRegistration(): Promise<AgentRegistration | undefined> {
    await this.operation;
    let values: Map<string, string>;
    try {
      values = await readRegistrationEnv(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const registration: AgentRegistration = {
      agentId: values.get("OPENLINKER_AGENT_ID") ?? "",
      agentSlug: values.get("OPENLINKER_AGENT_SLUG") ?? "",
      agentName: values.get("OPENLINKER_AGENT_NAME") ?? "",
      agentToken: values.get("OPENLINKER_AGENT_TOKEN") ?? "",
      tokenId: values.get("OPENLINKER_AGENT_TOKEN_ID") ?? "",
      tokenPrefix: values.get("OPENLINKER_AGENT_TOKEN_PREFIX") ?? "",
      apiBase: values.get("OPENLINKER_API_BASE") ?? "",
      registeredAt: values.get("OPENLINKER_REGISTERED_AT") ?? "",
      updatedAt: values.get("OPENLINKER_UPDATED_AT") ?? "",
    };
    return registration.agentId || registration.agentToken ? registration : undefined;
  }

  async saveAgentRegistration(registration: AgentRegistration): Promise<void> {
    const operation = this.operation.then(async () => {
      let values: Map<string, string>;
      try {
        values = await readRegistrationEnv(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        values = new Map();
      }
      setEnv(values, "OPENLINKER_AGENT_ID", registration.agentId);
      setEnv(values, "OPENLINKER_AGENT_SLUG", registration.agentSlug);
      setEnv(values, "OPENLINKER_AGENT_NAME", registration.agentName);
      setEnv(values, "OPENLINKER_AGENT_TOKEN", registration.agentToken);
      setEnv(values, "OPENLINKER_AGENT_TOKEN_ID", registration.tokenId);
      setEnv(values, "OPENLINKER_AGENT_TOKEN_PREFIX", registration.tokenPrefix);
      setEnv(values, "OPENLINKER_API_BASE", registration.apiBase);
      setEnv(values, "OPENLINKER_REGISTERED_AT", registration.registeredAt);
      setEnv(values, "OPENLINKER_UPDATED_AT", registration.updatedAt);
      await writeRegistrationEnv(this.path, values);
    });
    this.operation = operation.catch(() => undefined);
    await operation;
  }
}

export async function ensureAgent(
  input: EnsureAgentRequest,
  client?: OpenLinkerClient,
): Promise<AgentRegistration> {
  const policy = input.policy ?? "reuse_existing";
  if (!["reuse_existing", "rotate_token", "force_new", "validate_only"].includes(policy)) {
    throw new TypeError(`unsupported registration policy ${policy}`);
  }
  const store = input.store ?? new EnvRegistrationStore(input.envPath);
  const stored = await store.loadAgentRegistration();
  const userToken = first(input.userToken, process.env.OPENLINKER_USER_TOKEN);
  const agentToken = first(
    input.agentToken,
    process.env.OPENLINKER_AGENT_TOKEN,
    stored?.agentToken,
  );
  const apiBase = first(
    input.apiBase,
    process.env.OPENLINKER_API_BASE,
    stored?.apiBase,
    client?.baseUrl,
    defaultRegistrationAPIBase,
  );
  const request = {
    ...input,
    slug: first(input.slug, stored?.agentSlug),
    name: first(input.name, stored?.agentName),
    visibility: first(input.visibility, "private"),
    connectionMode: normalizeRegistrationConnectionMode(input.connectionMode),
    tokenName: first(input.tokenName, input.name, input.slug, "JavaScript runtime worker"),
    tokenScopes: input.tokenScopes?.length ? [...input.tokenScopes] : ["agent:pull", "agent:call"],
    tags: input.tags?.length ? [...input.tags] : ["agent", "runtime"],
    skillIds: [...(input.skillIds ?? [])],
    userToken,
    agentToken,
    apiBase,
    policy,
  };

  if (stored && policy === "reuse_existing" && agentToken) {
    return effectiveRegistration(stored, request);
  }

  const ownsClient = !client;
  const sdk = client ?? new OpenLinkerClient({
    baseUrl: apiBase,
    userToken,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    sdkAgent: "@openlinker/sdk/register-v2",
  });

  if (policy === "validate_only") {
    if (!stored || !agentToken) {
      throw new Error("no stored Agent registration is available to validate");
    }
    if (!userToken && ownsClient) {
      throw new Error("OPENLINKER_USER_TOKEN is required to validate registration");
    }
    const tokens = await sdk.listAgentTokens({ agentId: stored.agentId, limit: 50 });
    const valid = tokens.items.some((token) => (
      token.id === stored.tokenId
      && token.status === "active_runtime"
      && !token.revoked_at
    ));
    if (!valid) throw new Error("no valid stored Agent registration found");
    return effectiveRegistration(stored, request);
  }

  if (stored && policy === "rotate_token") {
    if (!stored.agentId) throw new Error("stored Agent ID is required to rotate token");
    const token = await sdk.createAgentToken({
      name: request.tokenName,
      agentId: stored.agentId,
      scopes: request.tokenScopes,
      ...(input.tokenExpiresInMinutes !== undefined
        ? { expiresInMinutes: input.tokenExpiresInMinutes }
        : {}),
    });
    if (!token.plaintext_token) throw new Error("platform did not return Agent Token plaintext");
    const now = new Date().toISOString();
    const registration: AgentRegistration = {
      agentId: stored.agentId,
      agentSlug: first(request.slug, stored.agentSlug),
      agentName: first(request.name, stored.agentName),
      agentToken: token.plaintext_token,
      tokenId: token.id,
      tokenPrefix: token.prefix,
      apiBase,
      registeredAt: stored.registeredAt || now,
      updatedAt: now,
    };
    await store.saveAgentRegistration(registration);
    return registration;
  }

  if (!stored && policy === "reuse_existing" && agentToken) {
    const registered = await sdk.registerAgentViaToken(
      agentToken,
      registrationRequest(request),
    );
    const registration = registeredResponse(request, agentToken, registered);
    await store.saveAgentRegistration(registration);
    return registration;
  }

  if (!userToken && ownsClient) {
    throw new Error("OPENLINKER_USER_TOKEN is required to create an Agent");
  }
  if (!request.slug || !request.name) {
    throw new Error("Agent slug and name are required to create an Agent");
  }
  const pending = await sdk.createAgentToken({
    name: request.tokenName,
    scopes: request.tokenScopes,
    ...(input.tokenExpiresInMinutes !== undefined
      ? { expiresInMinutes: input.tokenExpiresInMinutes }
      : {}),
  });
  if (!pending.plaintext_token) {
    throw new Error("platform did not return pending Agent Token plaintext");
  }
  const registered = await sdk.registerAgentViaToken(
    pending.plaintext_token,
    registrationRequest(request),
  );
  const registration = registeredResponse(request, pending.plaintext_token, registered);
  await store.saveAgentRegistration(registration);
  return registration;
}

function registrationRequest(request: {
  slug: string;
  name: string;
  description?: string;
  endpointUrl?: string;
  endpointAuthHeader?: string;
  pricePerCallCents?: number;
  tags: string[];
  skillIds: string[];
  visibility: string;
  connectionMode: string;
  mcpToolName?: string;
}): RegisterAgentViaTokenRequest {
  return {
    ...(request.slug ? { slug: request.slug } : {}),
    name: request.name,
    ...(request.description ? { description: request.description } : {}),
    ...(request.endpointUrl ? { endpointUrl: request.endpointUrl } : {}),
    ...(request.endpointAuthHeader ? { endpointAuthHeader: request.endpointAuthHeader } : {}),
    ...(request.pricePerCallCents !== undefined
      ? { pricePerCallCents: request.pricePerCallCents }
      : {}),
    tags: request.tags,
    abilityTags: request.tags,
    skillIds: request.skillIds,
    visibility: request.visibility,
    connectionMode: request.connectionMode,
    ...(request.mcpToolName ? { mcpToolName: request.mcpToolName } : {}),
  };
}

function registeredResponse(
  request: { apiBase: string },
  agentToken: string,
  response: RegisterAgentViaTokenResponse,
): AgentRegistration {
  const now = new Date().toISOString();
  return {
    agentId: response.agent.id,
    agentSlug: response.agent.slug,
    agentName: response.agent.name,
    agentToken,
    tokenId: response.agent_token.id,
    tokenPrefix: response.agent_token.prefix,
    apiBase: request.apiBase,
    registeredAt: now,
    updatedAt: now,
  };
}

function effectiveRegistration(
  stored: AgentRegistration,
  request: { slug: string; name: string; agentToken: string; apiBase: string },
): AgentRegistration {
  return {
    ...stored,
    agentSlug: first(request.slug, stored.agentSlug),
    agentName: first(request.name, stored.agentName),
    agentToken: first(request.agentToken, stored.agentToken),
    apiBase: first(request.apiBase, stored.apiBase),
  };
}

function normalizeRegistrationConnectionMode(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (["", "runtime", "runtime_ws", "runtime_pull", "agent_node"].includes(
    normalized.toLowerCase(),
  )) return "runtime";
  return normalized;
}

function first(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) return value.trim();
  }
  return "";
}

const registrationEnvKeys = [
  "OPENLINKER_API_BASE",
  "OPENLINKER_AGENT_ID",
  "OPENLINKER_AGENT_SLUG",
  "OPENLINKER_AGENT_NAME",
  "OPENLINKER_AGENT_TOKEN",
  "OPENLINKER_AGENT_TOKEN_ID",
  "OPENLINKER_AGENT_TOKEN_PREFIX",
  "OPENLINKER_REGISTERED_AT",
  "OPENLINKER_UPDATED_AT",
] as const;

async function readRegistrationEnv(path: string): Promise<Map<string, string>> {
  const content = await readFile(path, "utf8");
  const values = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith("export ")) line = line.slice(7).trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), unquoteEnv(line.slice(separator + 1).trim()));
  }
  return values;
}

async function writeRegistrationEnv(path: string, values: Map<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const managed = new Set<string>(registrationEnvKeys);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of existing.split(/\r?\n/)) {
    let candidate = raw.trim();
    if (candidate.startsWith("export ")) candidate = candidate.slice(7).trim();
    const separator = candidate.indexOf("=");
    const key = separator > 0 ? candidate.slice(0, separator).trim() : "";
    if (!managed.has(key)) {
      if (raw || output.length) output.push(raw);
      continue;
    }
    seen.add(key);
    const value = values.get(key);
    if (value) output.push(`${key}=${JSON.stringify(value)}`);
  }
  for (const key of registrationEnvKeys) {
    const value = values.get(key);
    if (!seen.has(key) && value) output.push(`${key}=${JSON.stringify(value)}`);
  }
  while (output.at(-1) === "") output.pop();
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${output.join("\n")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function setEnv(values: Map<string, string>, key: string, value: string): void {
  if (value.trim()) values.set(key, value.trim());
  else values.delete(key);
}

function unquoteEnv(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded === "string") return decoded;
    } catch {
      // Preserve malformed user-owned values verbatim.
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
