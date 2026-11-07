import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { OpenLinkerClient, OpenLinkerError, prepareAgentTokenMint } from "./client.js";
import type { FetchLike, PreparedAgentTokenMint } from "./client.js";
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

/**
 * A first registration whose pending Agent Token may already have been
 * redeemed by Core but whose result is not saved yet. The endpoint auth header
 * is never written, because that credential was not stored before; only its
 * fingerprint is, and a retry takes the header from the current request.
 */
interface PendingRegistration {
  apiBase: string;
  agentToken: string;
  tokenId: string;
  tokenPrefix: string;
  request: RegisterAgentViaTokenRequest;
  /** Stands in for the endpoint auth header, which is never written: see endpointAuthFingerprint. */
  endpointAuthFingerprint?: string;
  /**
   * Set when this SDK minted the token; a minting start replays only a record
   * whose mint parameters and creator match its own.
   */
  mint?: PendingMint;
  /** The record created the env file, so clearing it removes an otherwise empty file. */
  createdFile?: boolean;
}

/** The normalized token request and a non-secret fingerprint of the minting creator credential. */
interface PendingMint {
  tokenName: string;
  tokenScopes: string[];
  tokenExpiresInMinutes: number;
  creatorFingerprint: string;
}

interface PendingRegistrationJournal {
  load(): Promise<PendingRegistration | undefined>;
  /** Resolves false when the record was not written; the attempt then continues without one. */
  save(record: PendingRegistration): Promise<boolean>;
  /** Removes the record only while it still holds `agentToken`. */
  clear(agentToken: string): Promise<void>;
  /** Syncs the record's directory; rejects on a genuine I/O error. */
  sync(): Promise<void>;
}

/**
 * Pending-registration access for EnvRegistrationStore instances. Keeping it
 * module-private leaves the exported class unchanged, and custom
 * RegistrationStore implementations keep their previous behaviour.
 */
const pendingRegistrationJournals = new WeakMap<RegistrationStore, PendingRegistrationJournal>();

/**
 * One queue per resolved env file path. Every mutation of a registration env
 * file (completed save, pending-record write and pending-record removal) runs
 * as one task on it, from its first read through its final rename or remove,
 * so store instances for the same file in this process cannot interleave, and
 * no completed save's in-flight rename can land during a journal operation.
 * Processes are not coordinated; that remains the pre-existing limitation of
 * sharing one env file between concurrent registrations.
 */
const registrationEnvPathQueues = new Map<string, Promise<void>>();

function onRegistrationEnvPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = canonicalRegistrationEnvPath(path);
  const run = (registrationEnvPathQueues.get(key) ?? Promise.resolve()).then(task);
  const settled = run.then(() => undefined, () => undefined);
  registrationEnvPathQueues.set(key, settled);
  void settled.then(() => {
    if (registrationEnvPathQueues.get(key) === settled) registrationEnvPathQueues.delete(key);
  });
  return run;
}

/**
 * Names one env file however it is reached: the absolute path with its longest
 * existing ancestor directory resolved through symlinks (for example /tmp/x.env
 * and /private/tmp/x.env on macOS). Resolving the nearest existing ancestor,
 * not only the parent, keeps the name stable when the parent is created later.
 *
 * EnvRegistrationStore has always resolved its path with `path.resolve`, which
 * collapses ".." lexically, and does all file I/O on that path; resolving it
 * the same way here keeps the key on the very file the store reads and writes.
 */
function canonicalRegistrationEnvPath(path: string): string {
  const absolute = resolve(path);
  let directory = dirname(absolute);
  let rest = basename(absolute);
  for (;;) {
    try {
      return join(realpathSync(directory), rest);
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return absolute;
      rest = join(basename(directory), rest);
      directory = parent;
    }
  }
}

/**
 * One lock per canonical env file path. It serializes a whole first
 * registration in this process: loading the stored registration and the
 * record, choosing, minting, writing the record, redeeming, and saving or
 * cleaning up. A second start for the same file waits, then reuses the
 * completed registration or replays the matching record. It is taken before
 * any path queue task and is the only lock held across network calls.
 * Processes are not coordinated, as before.
 */
const firstRegistrationLocks = new Map<string, Promise<void>>();

/**
 * Takes the first-registration lock of an EnvRegistrationStore and returns an
 * idempotent release. Other stores are not locked, as before.
 */
async function lockFirstRegistration(store: RegistrationStore): Promise<() => void> {
  if (!pendingRegistrationJournalFor(store)) return () => {};
  const key = canonicalRegistrationEnvPath((store as EnvRegistrationStore).path);
  const previous = firstRegistrationLocks.get(key) ?? Promise.resolve();
  let unlock = () => {};
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = previous.then(() => held);
  firstRegistrationLocks.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (firstRegistrationLocks.get(key) === tail) firstRegistrationLocks.delete(key);
  };
}

/**
 * Journals only when the store's class is exactly EnvRegistrationStore.
 * Subclasses (for example ones that encrypt or relocate registrations) and
 * custom stores keep their previous behaviour, so no token is written anywhere
 * except through their own save.
 */
function pendingRegistrationJournalFor(
  store: RegistrationStore,
): PendingRegistrationJournal | undefined {
  return Object.getPrototypeOf(store) === EnvRegistrationStore.prototype
    ? pendingRegistrationJournals.get(store)
    : undefined;
}

export class EnvRegistrationStore implements RegistrationStore {
  readonly path: string;
  private operation = Promise.resolve();

  constructor(path = defaultRegistrationEnvPath) {
    this.path = resolve(path.trim() || defaultRegistrationEnvPath);
    const serialized = <T>(task: () => Promise<T>): Promise<T> => {
      const operation = this.operation.then(() => onRegistrationEnvPath(this.path, task));
      this.operation = operation.then(() => undefined, () => undefined);
      return operation;
    };
    pendingRegistrationJournals.set(this, {
      load: () => serialized(() => loadPendingRegistration(this.path)),
      save: (record) => serialized(async () => savePendingRegistration(this.path, record)),
      clear: (agentToken) => serialized(async () => clearPendingRegistration(this.path, agentToken)),
      sync: () => serialized(async () => fsyncDirectory(dirname(this.path))),
    });
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
    const operation = this.operation.then(() => onRegistrationEnvPath(this.path, async () => {
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
    }));
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
  const release = await lockFirstRegistration(store);
  try {
    return await ensureAgentWithStore(input, client, policy, store, release);
  } finally {
    release();
  }
}

async function ensureAgentWithStore(
  input: EnsureAgentRequest,
  client: OpenLinkerClient | undefined,
  policy: RegistrationPolicy,
  store: RegistrationStore,
  releaseFirstRegistrationLock: () => void,
): Promise<AgentRegistration> {
  const stored = await store.loadAgentRegistration();
  // A completed registration is reused, validated or rotated as before,
  // without holding the first-registration lock.
  if (stored) releaseFirstRegistrationLock();
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
    return await redeemNewRegistration(
      sdk,
      store,
      request,
      pendingRegistrationJournalFor(store),
      agentToken,
    );
  }

  if (!userToken && ownsClient) {
    throw new Error("OPENLINKER_USER_TOKEN is required to create an Agent");
  }
  if (!request.slug || !request.name) {
    throw new Error("Agent slug and name are required to create an Agent");
  }
  // Only a first registration is journaled; creating an Agent over an existing
  // stored registration keeps its previous behaviour.
  return await redeemNewRegistration(
    sdk,
    store,
    request,
    stored ? undefined : pendingRegistrationJournalFor(store),
    {
      parameters: {
        tokenName: request.tokenName,
        tokenScopes: request.tokenScopes,
        tokenExpiresInMinutes: input.tokenExpiresInMinutes ?? 0,
      },
      mint: async (prepared) => {
        const tokenRequest = {
          name: request.tokenName,
          scopes: request.tokenScopes,
          ...(input.tokenExpiresInMinutes !== undefined
            ? { expiresInMinutes: input.tokenExpiresInMinutes }
            : {}),
        };
        const pending = prepared
          ? await prepared.createAgentToken(tokenRequest)
          : await sdk.createAgentToken(tokenRequest);
        if (!pending.plaintext_token) {
          throw new Error("platform did not return pending Agent Token plaintext");
        }
        return {
          agentToken: pending.plaintext_token,
          tokenId: pending.id,
          tokenPrefix: pending.prefix,
        };
      },
    },
  );
}

type RegistrationInput = Parameters<typeof registrationRequest>[0] & { apiBase: string };
type PendingToken = Pick<PendingRegistration, "agentToken" | "tokenId" | "tokenPrefix">;

interface MintAttempt {
  parameters: Omit<PendingMint, "creatorFingerprint">;
  /** Mints with `prepared` when given, so the fingerprinted credential is the one sent. */
  mint: (prepared?: PreparedAgentTokenMint) => Promise<PendingToken>;
}

/**
 * Redeems a pending Agent Token for a new Agent and saves the result.
 *
 * With a journal, the token and request are recorded before Core is asked to
 * redeem them. If the process stops, the response is lost or the save fails
 * after Core committed the registration, the next start sends the same token
 * and request again instead of minting a new token; Core answers that exact
 * replay with the original registration. `token` is either the caller's
 * pending token or the parameters and function that mint one for a fresh
 * attempt.
 */
async function redeemNewRegistration(
  sdk: OpenLinkerClient,
  store: RegistrationStore,
  request: RegistrationInput,
  journalIfAny: PendingRegistrationJournal | undefined,
  token: string | MintAttempt,
): Promise<AgentRegistration> {
  const body = registrationRequest(request);
  const apiBase = sdk.baseUrl;
  let journal = journalIfAny;
  // A journaled minting start resolves the client's request headers once. The
  // creator fingerprint comes from the Authorization header they carry (a
  // header override or the User Token), and a mint below sends exactly those
  // headers, so a refreshing provider cannot record one credential and mint
  // with another; the providers are still called once per start.
  let prepared: PreparedAgentTokenMint | undefined;
  let mint: PendingMint | undefined;
  if (journal && typeof token !== "string") {
    prepared = await prepareAgentTokenMint(sdk);
    if (prepared) {
      mint = {
        ...token.parameters,
        creatorFingerprint: creatorCredentialFingerprint(
          authorizationCredential(prepared.authorization),
        ),
      };
    } else {
      // Not an OpenLinkerClient, so its credential is unknown: keep the
      // previous flow without a record.
      journal = undefined;
    }
  }
  // Only a minting start replays a record. With a supplied token, an exactly
  // matching record holds that same token and request, which is what the flow
  // below sends anyway, so replaying it first would only repeat it.
  if (journal && mint) {
    const previous = await journal.load();
    // A record that differs in any way (platform, request, mint parameters or
    // creator) is never replayed; it stays until the attempt below replaces it.
    if (previous && pendingRegistrationMatches(previous, apiBase, body, mint)) {
      // An earlier start may have written this record and then failed to
      // sync its directory, so confirm it is durable before Core is asked to
      // redeem it.
      await journal.sync();
      const replay: PendingRegistration = {
        ...previous,
        request: {
          ...previous.request,
          ...(body.endpointAuthHeader ? { endpointAuthHeader: body.endpointAuthHeader } : {}),
        },
      };
      try {
        return await redeemPendingRegistration(sdk, store, request, journal, replay);
      } catch (error) {
        if (!isDefinitiveRegistrationRejection(error)) throw error;
        // Core refused the recorded attempt outright (for example its token
        // expired unused) and its record is gone. Continue with the normal flow
        // instead of rethrowing: without the record this start would have
        // minted a fresh token, and a stale record must not turn a start that
        // succeeds today into a failure.
      }
    }
  }
  const fresh = typeof token === "string"
    ? { agentToken: token, tokenId: "", tokenPrefix: "" }
    : await token.mint(prepared);
  const attempt: PendingRegistration = { ...fresh, apiBase, request: body, ...(mint ? { mint } : {}) };
  if (journal && !(await journal.save(attempt))) journal = undefined;
  return await redeemPendingRegistration(sdk, store, request, journal, attempt);
}

async function redeemPendingRegistration(
  sdk: OpenLinkerClient,
  store: RegistrationStore,
  request: RegistrationInput,
  journal: PendingRegistrationJournal | undefined,
  attempt: PendingRegistration,
): Promise<AgentRegistration> {
  let registered: RegisterAgentViaTokenResponse;
  try {
    registered = await sdk.registerAgentViaToken(attempt.agentToken, attempt.request);
  } catch (error) {
    // Core refuses the same token and request the same way again, so a
    // definitive rejection drops this attempt's record and the next start
    // behaves as before. Any other failure (network, timeout, 408, 429, 5xx or
    // an unreadable success) may follow a committed registration, so the
    // record stays for the next start to replay.
    if (journal && isDefinitiveRegistrationRejection(error)) {
      await journal.clear(attempt.agentToken).catch(() => undefined);
    }
    throw error;
  }
  const registration = registeredResponse(request, attempt.agentToken, registered);
  // If this save fails the record stays, so the next start can replay.
  await store.saveAgentRegistration(registration);
  // The saved registration takes precedence on every later start, so a record
  // left by a failed cleanup is not consulted again.
  await journal?.clear(attempt.agentToken).catch(() => undefined);
  return registration;
}

/**
 * Whether a record is exactly the attempt a minting start would make: same
 * platform, every recorded request field equal, the same endpoint auth header
 * (by fingerprint), and the same mint parameters and creator. A record without
 * mint parameters or an endpoint auth fingerprint never matches.
 */
function pendingRegistrationMatches(
  record: PendingRegistration,
  apiBase: string,
  request: RegisterAgentViaTokenRequest,
  mint: PendingMint,
): boolean {
  return record.apiBase === apiBase
    && record.endpointAuthFingerprint !== undefined
    && record.endpointAuthFingerprint === endpointAuthFingerprint(request.endpointAuthHeader)
    && record.mint !== undefined
    && mint.creatorFingerprint !== ""
    && JSON.stringify(comparableRequest(record.request))
      === JSON.stringify(comparableRequest(request))
    && JSON.stringify(comparableMint(record.mint)) === JSON.stringify(comparableMint(mint));
}

function comparableMint(mint: PendingMint): unknown[] {
  return [mint.tokenName, mint.tokenScopes, mint.tokenExpiresInMinutes, mint.creatorFingerprint];
}

/**
 * Lowercase hex SHA-256 of the creator credential the mint request sends,
 * truncated to 32 characters; it identifies the creator without storing it.
 */
function creatorCredentialFingerprint(credential: string): string {
  const token = credential.trim();
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 32) : "";
}

/**
 * Identifies the exact endpoint auth header bytes without storing the
 * credential: lowercase hex SHA-256 truncated to 32 characters, or "none" when
 * there is no header.
 */
function endpointAuthFingerprint(header: string | undefined): string {
  return header
    ? createHash("sha256").update(header, "utf8").digest("hex").slice(0, 32)
    : "none";
}

/** The credential in an Authorization header: its Bearer token, or the whole value otherwise. */
function authorizationCredential(header: string): string {
  const value = header.trim();
  const bearer = /^bearer\s+/i.exec(value);
  return (bearer ? value.slice(bearer[0].length) : value).trim();
}

/** Treats an absent field like its empty value, as the other SDKs' records omit them. */
function comparableRequest(request: RegisterAgentViaTokenRequest): unknown[] {
  return [
    request.slug ?? "",
    request.name,
    request.description ?? "",
    request.endpointUrl ?? "",
    request.pricePerCallCents ?? 0,
    request.tags ?? [],
    request.abilityTags ?? [],
    request.skillIds ?? [],
    request.visibility ?? "",
    request.connectionMode ?? "",
    request.mcpToolName ?? "",
  ];
}

/** A 4xx answer Core would repeat for the same token and request; 408 and 429 are retryable. */
function isDefinitiveRegistrationRejection(error: unknown): boolean {
  return error instanceof OpenLinkerError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429;
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
  return parseRegistrationEnv(await readFile(path, "utf8"));
}

function parseRegistrationEnv(content: string): Map<string, string> {
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

/** Rewrites only the given keys and keeps every other line of the file as it is. */
async function writeRegistrationEnv(
  path: string,
  values: Map<string, string>,
  keys: readonly string[] = registrationEnvKeys,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = renderRegistrationEnv(existing, values, keys);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
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

/** Returns `existing` with only the given keys rewritten from `values`; other lines are kept. */
function renderRegistrationEnv(
  existing: string,
  values: Map<string, string>,
  keys: readonly string[],
): string {
  const managed = new Set<string>(keys);
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
  for (const key of keys) {
    const value = values.get(key);
    if (!seen.has(key) && value) output.push(`${key}=${JSON.stringify(value)}`);
  }
  while (output.at(-1) === "") output.pop();
  return `${output.join("\n")}\n`;
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

/**
 * Holds the in-progress first registration beside the completed keys in the
 * same private env file, so it shares their location, 0600 mode and ignore
 * rules; loaders that only read the completed keys skip it.
 */
const pendingRegistrationEnvKey = "OPENLINKER_PENDING_REGISTRATION";
const pendingRegistrationVersion = 1;
/**
 * Keeps the record well below the line limit of other SDKs' env readers. A
 * request within Core's field limits needs a few KiB; a larger one is sent
 * without a record, as before.
 */
const maxPendingRegistrationBytes = 16 * 1024;

async function loadPendingRegistration(path: string): Promise<PendingRegistration | undefined> {
  let values: Map<string, string>;
  try {
    values = await readRegistrationEnv(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return decodePendingRegistration(values.get(pendingRegistrationEnvKey));
}

const pendingRegistrationWriteAttempts = 3;

/**
 * Writes the record without losing data another writer stores meanwhile: it
 * renders from one read, re-reads right before the rename and replaces the
 * file only if it is unchanged, otherwise it renders again from the fresh
 * content, a bounded number of times. Returns false when the record was not
 * written (still contended, or too large), so the attempt continues without
 * one, exactly as before the journal existed.
 *
 * It runs as one task on the env file's path queue, synchronously, so no other
 * store instance's mutation in this process can interleave. There is no
 * cross-process lock: another process's write between the final re-read and
 * the rename can still be lost, the same pre-existing limitation as concurrent
 * registrations against one env file. The directory is synced after the
 * rename, so the record is durable before the token is redeemed.
 */
function savePendingRegistration(path: string, record: PendingRegistration): boolean {
  makePendingRegistrationDirectory(dirname(path));
  for (let attempt = 0; attempt < pendingRegistrationWriteAttempts; attempt += 1) {
    const before = readIfPresent(path);
    const content = before?.toString("utf8") ?? "";
    const values = parseRegistrationEnv(content);
    const previous = decodePendingRegistration(values.get(pendingRegistrationEnvKey));
    const encoded = JSON.stringify({
      version: pendingRegistrationVersion,
      api_base: record.apiBase,
      agent_token: record.agentToken,
      ...(record.tokenId ? { token_id: record.tokenId } : {}),
      ...(record.tokenPrefix ? { token_prefix: record.tokenPrefix } : {}),
      request: pendingRequestToJson(record.request),
      endpoint_auth_fingerprint: endpointAuthFingerprint(record.request.endpointAuthHeader),
      ...(record.mint
        ? {
          mint: {
            token_name: record.mint.tokenName,
            token_scopes: record.mint.tokenScopes,
            token_expires_in_minutes: record.mint.tokenExpiresInMinutes,
            creator_fingerprint: record.mint.creatorFingerprint,
          },
        }
        : {}),
      ...(before === undefined || previous?.createdFile ? { created_file: true } : {}),
    });
    if (Buffer.byteLength(encoded, "utf8") > maxPendingRegistrationBytes) return false;
    values.set(pendingRegistrationEnvKey, encoded);
    const rendered = renderRegistrationEnv(content, values, [pendingRegistrationEnvKey]);
    if (replaceRegistrationEnvIfUnchanged(path, rendered, before)) return true;
  }
  return false;
}

/**
 * Creates `directory` as `mkdir -p` does and then syncs the parent of every
 * directory it created, top down, so the record's path is durable before the
 * token is redeemed. It runs before the record is written, so a failed sync
 * leaves no record behind.
 */
function makePendingRegistrationDirectory(directory: string): void {
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (firstCreated === undefined) return;
  const created: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    created.unshift(current);
    if (current === firstCreated || dirname(current) === current) break;
  }
  for (const each of created) fsyncDirectory(dirname(each));
}

/**
 * Atomically replaces `path` with `content` in mode 0600, but only if the file
 * still holds `before` (or is still absent) when re-read right before the
 * rename. Reports whether it replaced the file. Synchronous throughout.
 */
function replaceRegistrationEnvIfUnchanged(
  path: string,
  content: string,
  before: Buffer | undefined,
): boolean {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (!sameRegistrationEnv(readIfPresent(path), before)) return false;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

const unsupportedDirectorySyncCodes = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * Flushes a directory's entries so a rename or remove inside it is durable.
 * Platforms or file systems that cannot sync a directory (Windows, or EINVAL,
 * ENOTSUP and EOPNOTSUPP) skip it; any other error is thrown.
 */
function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // A directory that cannot be synced is skipped; a genuine I/O error is
    // reported, so a record write fails before the token is redeemed.
    if (!unsupportedDirectorySyncCodes.has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing to recover; the descriptor is released either way.
      }
    }
  }
}

function sameRegistrationEnv(current: Buffer | undefined, before: Buffer | undefined): boolean {
  return current === undefined ? before === undefined : before !== undefined && current.equals(before);
}

/**
 * Removes this attempt's record and never another writer's data. It decides
 * from one read of the file, then re-reads it immediately before mutating and
 * leaves everything untouched if anything changed: a newer record, a completed
 * registration or any other line written meanwhile survives, and only this
 * attempt's leftover record may remain.
 *
 * - The whole file is deleted only if this record created it and the file
 *   holds nothing but this attempt's own pending key.
 * - Otherwise only the pending key is removed, and only while it still holds
 *   `agentToken`; completed keys and other lines are kept as they are.
 *
 * It runs as one task on the env file's path queue, synchronously, so no other
 * store instance's mutation in this process can interleave between the
 * comparison, the re-read and the mutation. There is no cross-process lock:
 * another process can still write between the re-read and the rename or
 * unlink, the same pre-existing limitation as concurrent registrations against
 * one env file.
 */
function clearPendingRegistration(path: string, agentToken: string): void {
  const before = readIfPresent(path);
  if (!before) return;
  const content = before.toString("utf8");
  const record = decodePendingRegistration(
    parseRegistrationEnv(content).get(pendingRegistrationEnvKey),
  );
  if (!record || record.agentToken !== agentToken.trim()) return;
  if (record.createdFile && registrationEnvHasOnlyKey(content, pendingRegistrationEnvKey)) {
    if (!sameRegistrationEnv(readIfPresent(path), before)) return;
    rmSync(path, { force: true });
    fsyncDirectory(dirname(path));
    return;
  }
  replaceRegistrationEnvIfUnchanged(
    path,
    renderRegistrationEnv(content, new Map(), [pendingRegistrationEnvKey]),
    before,
  );
}

function readIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function registrationEnvHasOnlyKey(content: string, key: string): boolean {
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith("export ")) line = line.slice(7).trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1 || line.slice(0, separator).trim() !== key) return false;
  }
  return true;
}

/** Ignores a damaged or unknown-version record instead of blocking start-up; the next attempt replaces it. */
function decodePendingRegistration(raw: string | undefined): PendingRegistration | undefined {
  if (!raw?.trim()) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isJsonRecord(decoded) || decoded.version !== pendingRegistrationVersion) return undefined;
  const agentToken = typeof decoded.agent_token === "string" ? decoded.agent_token.trim() : "";
  const apiBase = typeof decoded.api_base === "string" ? decoded.api_base : "";
  const request = pendingRequestFromJson(decoded.request);
  if (!agentToken || !apiBase || !request) return undefined;
  const mint = pendingMintFromJson(decoded.mint);
  return {
    apiBase,
    agentToken,
    tokenId: typeof decoded.token_id === "string" ? decoded.token_id : "",
    tokenPrefix: typeof decoded.token_prefix === "string" ? decoded.token_prefix : "",
    request,
    ...(typeof decoded.endpoint_auth_fingerprint === "string" && decoded.endpoint_auth_fingerprint
      ? { endpointAuthFingerprint: decoded.endpoint_auth_fingerprint }
      : {}),
    ...(mint ? { mint } : {}),
    ...(decoded.created_file === true ? { createdFile: true } : {}),
  };
}

/** A malformed mint section counts as absent, so the record never replays. */
function pendingMintFromJson(value: unknown): PendingMint | undefined {
  if (!isJsonRecord(value)) return undefined;
  const { token_name: tokenName, token_scopes: tokenScopes } = value;
  const { token_expires_in_minutes: expires, creator_fingerprint: creator } = value;
  if (
    typeof tokenName !== "string"
    || !Array.isArray(tokenScopes)
    || !tokenScopes.every((scope) => typeof scope === "string")
    || typeof expires !== "number"
    || !Number.isInteger(expires)
    || typeof creator !== "string"
  ) {
    return undefined;
  }
  return {
    tokenName,
    tokenScopes: [...(tokenScopes as string[])],
    tokenExpiresInMinutes: expires,
    creatorFingerprint: creator,
  };
}

/** Uses the wire field names, as the Go and Python SDKs do for the same record. */
function pendingRequestToJson(request: RegisterAgentViaTokenRequest): Record<string, unknown> {
  return {
    ...(request.slug !== undefined ? { slug: request.slug } : {}),
    name: request.name,
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.endpointUrl !== undefined ? { endpoint_url: request.endpointUrl } : {}),
    ...(request.pricePerCallCents !== undefined
      ? { price_per_call_cents: request.pricePerCallCents }
      : {}),
    ...(request.tags !== undefined ? { tags: request.tags } : {}),
    ...(request.abilityTags !== undefined ? { ability_tags: request.abilityTags } : {}),
    ...(request.skillIds !== undefined ? { skill_ids: request.skillIds } : {}),
    ...(request.visibility !== undefined ? { visibility: request.visibility } : {}),
    ...(request.connectionMode !== undefined ? { connection_mode: request.connectionMode } : {}),
    ...(request.mcpToolName !== undefined ? { mcp_tool_name: request.mcpToolName } : {}),
  };
}

function pendingRequestFromJson(value: unknown): RegisterAgentViaTokenRequest | undefined {
  if (!isJsonRecord(value) || typeof value.name !== "string") return undefined;
  const text = (key: string): string | undefined | null => {
    const field = value[key];
    if (field === undefined) return undefined;
    return typeof field === "string" ? field : null;
  };
  const list = (key: string): string[] | undefined | null => {
    const field = value[key];
    if (field === undefined) return undefined;
    return Array.isArray(field) && field.every((item) => typeof item === "string")
      ? [...(field as string[])]
      : null;
  };
  const price = value.price_per_call_cents;
  if (price !== undefined && (typeof price !== "number" || !Number.isFinite(price))) {
    return undefined;
  }
  const slug = text("slug");
  const description = text("description");
  const endpointUrl = text("endpoint_url");
  const visibility = text("visibility");
  const connectionMode = text("connection_mode");
  const mcpToolName = text("mcp_tool_name");
  const tags = list("tags");
  const abilityTags = list("ability_tags");
  const skillIds = list("skill_ids");
  if ([slug, description, endpointUrl, visibility, connectionMode, mcpToolName, tags, abilityTags, skillIds]
    .includes(null)) {
    return undefined;
  }
  return {
    name: value.name,
    ...(slug ? { slug } : {}),
    ...(description ? { description } : {}),
    ...(endpointUrl ? { endpointUrl } : {}),
    ...(typeof price === "number" ? { pricePerCallCents: price } : {}),
    ...(tags ? { tags } : {}),
    ...(abilityTags ? { abilityTags } : {}),
    ...(skillIds ? { skillIds } : {}),
    ...(visibility ? { visibility } : {}),
    ...(connectionMode ? { connectionMode } : {}),
    ...(mcpToolName ? { mcpToolName } : {}),
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
