import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OpenLinkerClient, OpenLinkerError } from "../dist/index.js";
import type { FetchLike } from "../dist/index.js";
import {
  EnvRegistrationStore,
  ensureAgent,
} from "../dist/runtime.js";
import type {
  AgentRegistration,
  RegistrationStore,
} from "../dist/runtime.js";


class MemoryRegistrationStore implements RegistrationStore {
  registration: AgentRegistration | undefined;

  loadAgentRegistration(): AgentRegistration | undefined {
    return this.registration ? { ...this.registration } : undefined;
  }

  saveAgentRegistration(registration: AgentRegistration): void {
    this.registration = { ...registration };
  }
}

test("ensureAgent registers one pending token and reuses durable registration", async () => {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://api.example.test",
    userToken: "ol_user_creator",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (String(url).endsWith("/creator/agent-tokens")) {
        return jsonResponse({
          id: "token-1",
          prefix: "ol_agent_demo",
          status: "pending_registration",
          plaintext_token: "ol_agent_plaintext",
        });
      }
      return jsonResponse({
        agent: { id: "agent-1", slug: "demo", name: "Demo" },
        agent_token: {
          id: "token-1",
          prefix: "ol_agent_demo",
          status: "active_runtime",
        },
      });
    },
  });
  const store = new MemoryRegistrationStore();

  const first = await ensureAgent({
    slug: "demo",
    name: "Demo",
    apiBase: "https://api.example.test",
    userToken: "ol_user_creator",
    store,
  }, client);
  const second = await ensureAgent({ store }, client);

  assert.deepEqual(second, first);
  assert.equal(first.agentId, "agent-1");
  assert.equal(first.agentToken, "ol_agent_plaintext");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.example.test/api/v1/creator/agent-tokens",
    "https://api.example.test/api/v1/agent-registration/agents",
  ]);
  assert.equal(calls[0]?.auth, "Bearer ol_user_creator");
  assert.equal(calls[1]?.auth, "Bearer ol_agent_plaintext");
  assert.equal(calls[1]?.body.connection_mode, "runtime");
});

test("EnvRegistrationStore preserves unrelated env and writes private mode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openlinker-js-registration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, ".env");
  await writeFile(path, "UNRELATED=value\nOPENLINKER_AGENT_TOKEN=old\n", { mode: 0o644 });
  const store = new EnvRegistrationStore(path);

  await store.saveAgentRegistration({
    agentId: "agent-1",
    agentSlug: "demo",
    agentName: "Demo",
    agentToken: "ol_agent_secret",
    tokenId: "token-1",
    tokenPrefix: "ol_agent_demo",
    apiBase: "https://api.example.test",
    registeredAt: "2026-07-18T00:00:00Z",
    updatedAt: "2026-07-18T00:00:00Z",
  });

  const [raw, details, loaded] = await Promise.all([
    readFile(path, "utf8"),
    stat(path),
    store.loadAgentRegistration(),
  ]);
  assert.equal(details.mode & 0o777, 0o600);
  assert.match(raw, /UNRELATED=value/);
  assert.doesNotMatch(raw, /OPENLINKER_AGENT_TOKEN=old/);
  assert.equal(loaded?.agentId, "agent-1");
  assert.equal(loaded?.agentToken, "ol_agent_secret");
});

const pendingKey = "OPENLINKER_PENDING_REGISTRATION";
const replayBase = "https://api.example.test";

/** Models Core registration, including the idempotent replay of a redeemed token for the same slug. */
function replayCore() {
  const state = {
    pending: new Set<string>(),
    redeemed: new Map<string, { agent: { id: string; slug: string; name: string } }>(),
    slugs: new Set<string>(),
    createTokenCalls: 0,
    registerTokens: [] as string[],
    mintAuth: [] as string[],
    dropAfterCommit: 0,
  };
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string; name?: string };
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (path === "/api/v1/creator/agent-tokens") {
      assert.match(auth, /^Bearer ol_user_/);
      state.mintAuth.push(auth);
      state.createTokenCalls += 1;
      const token = `ol_agent_minted_${state.createTokenCalls}`;
      state.pending.add(token);
      return jsonResponse({
        id: "token-pending",
        prefix: "ol_agent_mint",
        status: "pending_registration",
        plaintext_token: token,
      }, 201);
    }
    assert.equal(path, "/api/v1/agent-registration/agents");
    const token = auth.replace(/^Bearer /, "");
    state.registerTokens.push(token);
    const slug = body.slug ?? "";
    if (state.pending.has(token) && state.slugs.has(slug)) {
      return errorResponse(409, "CONFLICT", "slug 已被占用");
    }
    if (state.pending.has(token)) {
      const response = {
        agent: { id: "agent-1", slug, name: body.name ?? "" },
        agent_token: { id: "token-1", prefix: "ol_agent_reg", status: "active_runtime" },
      };
      state.pending.delete(token);
      state.redeemed.set(token, response);
      state.slugs.add(slug);
      if (state.dropAfterCommit > 0) {
        state.dropAfterCommit -= 1;
        throw new TypeError("fetch failed");
      }
      return jsonResponse(response, 201);
    }
    const replay = state.redeemed.get(token);
    if (replay && replay.agent.slug === slug) return jsonResponse(replay, 201);
    return errorResponse(401, "UNAUTHORIZED", "Agent Token 已过期 / 已撤销 / 已被使用");
  };
  return { state, fetch };
}

/** Embeds the env store but keeps registrations elsewhere, as an encrypting or remote store might. */
class RelocatedRegistrationStore extends EnvRegistrationStore {
  registration: AgentRegistration | undefined;

  override async loadAgentRegistration(): Promise<AgentRegistration | undefined> {
    return this.registration ? { ...this.registration } : undefined;
  }

  override async saveAgentRegistration(registration: AgentRegistration): Promise<void> {
    this.registration = { ...registration };
  }
}

async function tempEnv(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openlinker-js-pending-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, ".env");
}

function pendingLine(record: Record<string, unknown>): string {
  return `${pendingKey}=${JSON.stringify(JSON.stringify({ version: 1, ...record }))}\n`;
}

function readPending(raw: string): Record<string, unknown> | undefined {
  const line = raw.split("\n").find((item) => item.startsWith(`${pendingKey}=`));
  if (!line) return undefined;
  return JSON.parse(JSON.parse(line.slice(pendingKey.length + 1)) as string) as Record<string, unknown>;
}

test("ensureAgent resumes a minted registration after a lost response", async (t) => {
  const path = await tempEnv(t);
  await writeFile(path, "UNRELATED=value\n", { mode: 0o600 });
  const core = replayCore();
  core.state.dropAfterCommit = 1;
  const store = new EnvRegistrationStore(path);
  const input = {
    slug: "demo-agent",
    name: "Demo Agent",
    endpointAuthHeader: "Bearer endpoint-secret",
    apiBase: replayBase,
    userToken: "ol_user_creator",
    store,
    fetch: core.fetch,
  };

  await assert.rejects(ensureAgent(input), /fetch failed/);
  const [pendingRaw, pendingStat, loaded] = await Promise.all([
    readFile(path, "utf8"),
    stat(path),
    store.loadAgentRegistration(),
  ]);
  const record = readPending(pendingRaw);
  assert.equal(pendingStat.mode & 0o777, 0o600);
  assert.equal(record?.agent_token, "ol_agent_minted_1");
  assert.equal(record?.api_base, replayBase);
  assert.equal((record?.request as Record<string, unknown>).slug, "demo-agent");
  assert.doesNotMatch(pendingRaw, /endpoint-secret/);
  assert.equal(record?.endpoint_auth_fingerprint, fingerprint("Bearer endpoint-secret"));
  assert.equal(loaded, undefined);

  const registration = await ensureAgent(input);
  assert.equal(registration.agentToken, "ol_agent_minted_1");
  assert.equal(registration.agentId, "agent-1");
  assert.equal(core.state.createTokenCalls, 1);
  assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_1"]);
  const completed = await readFile(path, "utf8");
  assert.equal(readPending(completed), undefined);
  assert.match(completed, /^UNRELATED=value\n/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const again = await ensureAgent(input);
  assert.equal(again.agentToken, "ol_agent_minted_1");
  assert.equal(core.state.registerTokens.length, 2);
});

test("ensureAgent resumes a minted registration after the save fails", {
  skip: process.platform === "win32" || process.getuid?.() === 0
    ? "needs a directory the current user cannot write"
    : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openlinker-js-pending-"));
  t.after(async () => {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });
  const core = replayCore();
  let readOnlyAfterCommit = true;
  const fetch: FetchLike = async (url, init) => {
    const response = await core.fetch(url, init);
    if (readOnlyAfterCommit && String(url).endsWith("/agent-registration/agents")) {
      await chmod(directory, 0o500);
    }
    return response;
  };
  const input = {
    slug: "demo-agent",
    name: "Demo Agent",
    apiBase: replayBase,
    userToken: "ol_user_creator",
    store: new EnvRegistrationStore(join(directory, ".env")),
    fetch,
  };

  await assert.rejects(ensureAgent(input), { code: "EACCES" });
  readOnlyAfterCommit = false;
  await chmod(directory, 0o700);
  const registration = await ensureAgent(input);
  assert.equal(registration.agentToken, "ol_agent_minted_1");
  assert.equal(core.state.createTokenCalls, 1);
  assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_1"]);
});

test("an EnvRegistrationStore subclass keeps its previous registration behaviour", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.dropAfterCommit = 1;
  const input = {
    slug: "demo-agent",
    name: "Demo Agent",
    apiBase: replayBase,
    userToken: "ol_user_creator",
    store: new RelocatedRegistrationStore(path),
    fetch: core.fetch,
  };

  await assert.rejects(ensureAgent(input), /fetch failed/);
  // No plaintext journal is written outside the subclass's own save.
  await assert.rejects(stat(path), { code: "ENOENT" });
  // Exactly as before: a new token is minted and the slug is already taken.
  await assert.rejects(
    ensureAgent(input),
    (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
  );
  assert.equal(core.state.createTokenCalls, 2);
  assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_2"]);
});

test("ensureAgent retries the same supplied token after a lost response", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.pending.add("ol_agent_provided");
  core.state.dropAfterCommit = 1;
  const store = new EnvRegistrationStore(path);
  const input = {
    slug: "provided-agent",
    name: "Provided Agent",
    agentToken: "ol_agent_provided",
    apiBase: replayBase,
    store,
    fetch: core.fetch,
  };

  await assert.rejects(ensureAgent(input), /fetch failed/);
  assert.equal(await store.loadAgentRegistration(), undefined);
  assert.equal(readPending(await readFile(path, "utf8"))?.agent_token, "ol_agent_provided");

  const registration = await ensureAgent(input);
  assert.equal(registration.agentToken, "ol_agent_provided");
  assert.deepEqual(core.state.registerTokens, ["ol_agent_provided", "ol_agent_provided"]);
  assert.equal(readPending(await readFile(path, "utf8")), undefined);
});

/** The request an ensureAgent call with these fields records, in wire form. */
function recordedRequest(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "demo-agent",
    name: "Demo Agent",
    endpoint_url: "https://agent.example.test/old",
    tags: ["agent", "runtime"],
    ability_tags: ["agent", "runtime"],
    skill_ids: [],
    visibility: "private",
    connection_mode: "runtime",
    ...fields,
  };
}

/** The mint section a minting ensureAgent call with these settings records. */
function recordedMint(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_name: "Demo Agent",
    token_scopes: ["agent:pull", "agent:call"],
    token_expires_in_minutes: 0,
    creator_fingerprint: createHash("sha256").update("ol_user_creator").digest("hex").slice(0, 32),
    ...fields,
  };
}

test("ensureAgent never replays a pending record that does not match exactly", async (t) => {
  const base = {
    slug: "demo-agent",
    name: "Demo Agent",
    endpointUrl: "https://agent.example.test/old",
    apiBase: replayBase,
    userToken: "ol_user_creator",
  };
  const exact = {
    request: recordedRequest(),
    endpoint_auth_fingerprint: "none",
    mint: recordedMint(),
  };
  const cases = [
    {
      name: "changed slug",
      record: { ...exact, request: recordedRequest({ slug: "old-agent" }) },
      input: base,
      want: "ol_agent_minted_1",
    },
    {
      name: "changed endpoint url",
      record: exact,
      input: { ...base, endpointUrl: "https://agent.example.test/new" },
      want: "ol_agent_minted_1",
    },
    {
      name: "different supplied token",
      record: exact,
      input: { ...base, userToken: "", agentToken: "ol_agent_supplied_b" },
      want: "ol_agent_supplied_b",
    },
    {
      name: "force_new with a different slug",
      record: { ...exact, request: recordedRequest({ slug: "first-agent" }) },
      input: { ...base, slug: "second-agent", policy: "force_new" as const },
      want: "ol_agent_minted_1",
    },
    {
      name: "other platform",
      record: { ...exact, api_base: "https://other.example.test" },
      input: base,
      want: "ol_agent_minted_1",
    },
    {
      name: "changed token scopes",
      record: exact,
      input: { ...base, tokenScopes: ["agent:pull"] },
      want: "ol_agent_minted_1",
    },
    {
      name: "changed token expiry",
      record: exact,
      input: { ...base, tokenExpiresInMinutes: 60 },
      want: "ol_agent_minted_1",
    },
    {
      name: "changed token name",
      record: exact,
      input: { ...base, tokenName: "Renamed token" },
      want: "ol_agent_minted_1",
    },
    {
      name: "different user token",
      record: exact,
      input: { ...base, userToken: "ol_user_other" },
      want: "ol_agent_minted_1",
    },
    {
      name: "record without mint parameters",
      record: { request: recordedRequest(), endpoint_auth_fingerprint: "none" },
      input: base,
      want: "ol_agent_minted_1",
    },
    {
      name: "changed endpoint auth header",
      record: { ...exact, endpoint_auth_fingerprint: fingerprint("Bearer endpoint-a") },
      input: { ...base, endpointAuthHeader: "Bearer endpoint-b" },
      want: "ol_agent_minted_1",
    },
    {
      name: "removed endpoint auth header",
      record: { ...exact, endpoint_auth_fingerprint: fingerprint("Bearer endpoint-a") },
      input: base,
      want: "ol_agent_minted_1",
    },
    {
      name: "record without endpoint auth fingerprint",
      record: { request: recordedRequest(), mint: recordedMint() },
      input: base,
      want: "ol_agent_minted_1",
    },
  ];
  for (const item of cases) {
    const path = await tempEnv(t);
    await writeFile(path, pendingLine({
      api_base: replayBase,
      agent_token: "ol_agent_stale_a",
      ...item.record,
    }), { mode: 0o600 });
    const core = replayCore();
    // The stale token is still redeemable, so replaying it would succeed visibly.
    core.state.pending.add("ol_agent_stale_a");
    core.state.pending.add("ol_agent_supplied_b");

    const registration = await ensureAgent({
      ...item.input,
      store: new EnvRegistrationStore(path),
      fetch: core.fetch,
    });
    assert.deepEqual(core.state.registerTokens, [item.want], item.name);
    assert.equal(registration.agentToken, item.want, item.name);
    assert.equal(readPending(await readFile(path, "utf8")), undefined, item.name);
  }
});

function fingerprint(credential: string): string {
  return createHash("sha256").update(credential).digest("hex").slice(0, 32);
}

test("the creator fingerprint follows the Authorization header the mint sends", async (t) => {
  const cases = [
    {
      name: "header override",
      first: { userToken: "ol_user_creator", headers: { authorization: "Bearer ol_user_override" } },
      second: { userToken: "ol_user_creator", headers: { authorization: "Bearer ol_user_override" } },
      credential: "ol_user_override",
      replays: true,
    },
    {
      name: "header-only auth",
      first: { headers: { authorization: "Bearer ol_user_header_only" } },
      second: { headers: { authorization: "Bearer ol_user_header_only" } },
      credential: "ol_user_header_only",
      replays: true,
    },
    {
      name: "changed header override",
      first: { userToken: "ol_user_creator", headers: { authorization: "Bearer ol_user_override" } },
      second: { userToken: "ol_user_creator", headers: { authorization: "Bearer ol_user_other" } },
      credential: "ol_user_override",
      replays: false,
    },
  ];
  for (const item of cases) {
    const path = await tempEnv(t);
    const core = replayCore();
    core.state.dropAfterCommit = 1;
    const input = { slug: "demo-agent", name: "Demo Agent", apiBase: replayBase };
    const client = (auth: { userToken?: string; headers?: Record<string, string> }) =>
      new OpenLinkerClient({ baseUrl: replayBase, ...auth, fetch: core.fetch });

    await assert.rejects(
      ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client(item.first)),
      /fetch failed/,
    );
    assert.deepEqual(core.state.mintAuth, [`Bearer ${item.credential}`], item.name);
    const record = readPending(await readFile(path, "utf8"));
    assert.equal(
      (record?.mint as Record<string, unknown>).creator_fingerprint,
      fingerprint(item.credential),
      item.name,
    );

    const second = ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client(item.second));
    if (item.replays) {
      assert.equal((await second).agentToken, "ol_agent_minted_1", item.name);
      assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_1"], item.name);
    } else {
      // A different creator credential never replays: it mints as before and
      // meets the slug the first attempt created.
      await assert.rejects(second, (error: unknown) => error instanceof OpenLinkerError && error.status === 409);
      assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_2"], item.name);
    }
  }
});

/** Adds a mint-only credential, as a client with its own mint authorization might. */
class MintAuthorizationClient extends OpenLinkerClient {
  mintCalls = 0;

  override async createAgentToken(
    ...[request, options = {}]: Parameters<OpenLinkerClient["createAgentToken"]>
  ): ReturnType<OpenLinkerClient["createAgentToken"]> {
    this.mintCalls += 1;
    return await super.createAgentToken(request, {
      ...options,
      headers: { authorization: "Bearer ol_user_mint_only" },
    });
  }
}

test("a client that overrides createAgentToken keeps minting through it, without a journal", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.dropAfterCommit = 1;
  const client = new MintAuthorizationClient({
    baseUrl: replayBase,
    userToken: "ol_user_creator",
    fetch: core.fetch,
  });
  const input = { slug: "demo-agent", name: "Demo Agent", apiBase: replayBase };

  await assert.rejects(ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client), /fetch failed/);
  assert.equal(client.mintCalls, 1);
  assert.deepEqual(core.state.mintAuth, ["Bearer ol_user_mint_only"]);
  await assert.rejects(stat(path), { code: "ENOENT" });

  // Exactly as before: no replay, the override mints again and meets the slug.
  await assert.rejects(
    ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client),
    (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
  );
  assert.equal(client.mintCalls, 2);
  assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_2"]);
});

test("a prototype replacement of createAgentToken is still used, without a journal", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.dropAfterCommit = 1;
  const builtin = OpenLinkerClient.prototype.createAgentToken;
  let mintCalls = 0;
  OpenLinkerClient.prototype.createAgentToken = async function patchedCreateAgentToken(
    this: OpenLinkerClient,
    ...[request, options = {}]: Parameters<OpenLinkerClient["createAgentToken"]>
  ) {
    mintCalls += 1;
    return await builtin.call(this, request, {
      ...options,
      headers: { authorization: "Bearer ol_user_mint_only" },
    });
  };
  t.after(() => {
    OpenLinkerClient.prototype.createAgentToken = builtin;
  });
  const client = new OpenLinkerClient({ baseUrl: replayBase, userToken: "ol_user_creator", fetch: core.fetch });
  const input = { slug: "demo-agent", name: "Demo Agent", apiBase: replayBase };

  await assert.rejects(ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client), /fetch failed/);
  assert.equal(mintCalls, 1);
  assert.deepEqual(core.state.mintAuth, ["Bearer ol_user_mint_only"]);
  await assert.rejects(stat(path), { code: "ENOENT" });

  await assert.rejects(
    ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client),
    (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
  );
  assert.equal(mintCalls, 2);
  assert.deepEqual(core.state.registerTokens, ["ol_agent_minted_1", "ol_agent_minted_2"]);
});

/**
 * Runs `onRead` before each synchronous read of `path`, standing in for
 * another writer acting between a read and the re-read that guards a write.
 */
function interceptSyncReads(
  t: { after(fn: () => void): void },
  path: string,
  onRead: (count: number) => void,
): () => number {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const original = fs.readFileSync;
  let count = 0;
  const restore = () => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  };
  fs.readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (file === path) onRead(++count);
    return (original as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  t.after(restore);
  return () => {
    restore();
    return count;
  };
}

test("a pending-record write keeps a registration another start completed meanwhile", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.slugs.add("taken-agent");
  const completedA = "OPENLINKER_AGENT_ID=\"agent-a\"\nOPENLINKER_AGENT_TOKEN=\"ol_agent_completed_a\"\n";
  // Start A saves its completed registration between start B's read and the
  // re-read before B's rename.
  const stop = interceptSyncReads(t, path, (count) => {
    if (count === 2) writeFileSync(path, completedA, { mode: 0o600 });
  });

  await assert.rejects(
    ensureAgent({
      slug: "taken-agent",
      name: "Taken Agent",
      apiBase: replayBase,
      userToken: "ol_user_creator",
      store: new EnvRegistrationStore(path),
      fetch: core.fetch,
    }),
    (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
  );
  stop();
  const loaded = await new EnvRegistrationStore(path).loadAgentRegistration();
  assert.equal(loaded?.agentToken, "ol_agent_completed_a");
  assert.equal(readPending(await readFile(path, "utf8")), undefined);
});

test("a contended pending-record write is given up and the start continues as before", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  let writes = 0;
  // Another writer changes the file before every guarding re-read.
  const stop = interceptSyncReads(t, path, (count) => {
    if (count % 2 === 0) writeFileSync(path, `OTHER_WRITER=${++writes}\n`, { mode: 0o600 });
  });

  const registration = await ensureAgent({
    slug: "demo-agent",
    name: "Demo Agent",
    apiBase: replayBase,
    userToken: "ol_user_creator",
    store: new EnvRegistrationStore(path),
    fetch: core.fetch,
  });
  assert.equal(stop(), 6);
  assert.equal(registration.agentToken, "ol_agent_minted_1");
  const raw = await readFile(path, "utf8");
  assert.equal(readPending(raw), undefined);
  assert.match(raw, /^OTHER_WRITER=3\n/);
});

test("a refreshing token provider fingerprints the credential it mints with", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  let calls = 0;
  const client = new OpenLinkerClient({
    baseUrl: replayBase,
    userToken: () => `ol_user_rotating_${++calls}`,
    fetch: core.fetch,
  });
  const input = { slug: "demo-agent", name: "Demo Agent", apiBase: replayBase };

  // Without a journal: one provider call for the mint and one inside the
  // registration request, as before this change.
  await ensureAgent({ ...input, slug: "memory-agent", store: new MemoryRegistrationStore() }, client);
  const callsPerStart = calls;
  assert.equal(callsPerStart, 2);

  core.state.dropAfterCommit = 1;
  core.state.mintAuth.length = 0;
  calls = 0;
  await assert.rejects(ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client), /fetch failed/);
  assert.equal(calls, callsPerStart);
  assert.deepEqual(core.state.mintAuth, ["Bearer ol_user_rotating_1"]);
  const record = readPending(await readFile(path, "utf8"));
  assert.equal(
    (record?.mint as Record<string, unknown>).creator_fingerprint,
    fingerprint("ol_user_rotating_1"),
  );

  // The next start sees another credential, so it does not replay; it mints
  // with that same credential, exactly as before.
  await assert.rejects(
    ensureAgent({ ...input, store: new EnvRegistrationStore(path) }, client),
    (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
  );
  assert.equal(calls, 2 * callsPerStart);
  assert.deepEqual(core.state.mintAuth, ["Bearer ol_user_rotating_1", `Bearer ol_user_rotating_${callsPerStart + 1}`]);
});

test("ensureAgent keeps the error and drops the record when Core refuses registration", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.slugs.add("taken-agent");

  await assert.rejects(
    ensureAgent({
      slug: "taken-agent",
      name: "Taken Agent",
      apiBase: replayBase,
      userToken: "ol_user_creator",
      store: new EnvRegistrationStore(path),
      fetch: core.fetch,
    }),
    (error: unknown) => error instanceof OpenLinkerError
      && error.status === 409
      && error.message === "slug 已被占用",
  );
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("a refused attempt does not remove a record another attempt wrote", async (t) => {
  const path = await tempEnv(t);
  const core = replayCore();
  core.state.slugs.add("taken-agent");
  const concurrent = pendingLine({
    api_base: replayBase,
    agent_token: "ol_agent_concurrent_a",
    request: recordedRequest({ slug: "other-agent" }),
  });
  const fetch: FetchLike = async (url, init) => {
    if (String(url).endsWith("/agent-registration/agents")) {
      // Attempt A records its token while this attempt's redemption is in flight.
      await writeFile(path, concurrent, { mode: 0o600 });
    }
    return await core.fetch(url, init);
  };

  await assert.rejects(
    ensureAgent({
      slug: "taken-agent",
      name: "Taken Agent",
      apiBase: replayBase,
      userToken: "ol_user_creator",
      store: new EnvRegistrationStore(path),
      fetch,
    }),
    (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
  );
  assert.equal(readPending(await readFile(path, "utf8"))?.agent_token, "ol_agent_concurrent_a");
});

test("pending cleanup keeps a completed registration written after the comparison", async (t) => {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const originalReadFileSync = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  });
  const completed = "OPENLINKER_AGENT_ID=\"agent-elsewhere\"\n"
    + "OPENLINKER_AGENT_TOKEN=\"ol_agent_completed_elsewhere\"\n";
  for (const existing of ["", "UNRELATED=value\n"]) {
    const path = await tempEnv(t);
    if (existing) await writeFile(path, existing, { mode: 0o600 });
    const core = replayCore();
    core.state.slugs.add("taken-agent");
    let reads = 0;
    // Reads 1 and 2 are the pending-record write and its guard; the cleanup
    // then reads once to compare (3) and once more right before mutating (4).
    // Another writer completes a registration between those two.
    fs.readFileSync = ((file: unknown, ...rest: unknown[]) => {
      if (file === path && ++reads === 4) {
        fs.writeFileSync(path, `${String(originalReadFileSync(path, "utf8"))}${completed}`);
      }
      return (originalReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        ensureAgent({
          slug: "taken-agent",
          name: "Taken Agent",
          apiBase: replayBase,
          userToken: "ol_user_creator",
          store: new EnvRegistrationStore(path),
          fetch: core.fetch,
        }),
        (error: unknown) => error instanceof OpenLinkerError && error.status === 409,
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
    assert.equal(reads, 4, existing || "file created by the record");
    const loaded = await new EnvRegistrationStore(path).loadAgentRegistration();
    assert.equal(loaded?.agentToken, "ol_agent_completed_elsewhere");
    assert.ok((await readFile(path, "utf8")).startsWith(existing));
  }
});

test("ensureAgent continues normally after a matching record is refused", async (t) => {
  const path = await tempEnv(t);
  await writeFile(path, pendingLine({
    api_base: replayBase,
    agent_token: "ol_agent_expired_unused",
    request: recordedRequest({ endpoint_url: undefined }),
    endpoint_auth_fingerprint: "none",
    mint: recordedMint(),
  }), { mode: 0o600 });
  const core = replayCore();

  const registration = await ensureAgent({
    slug: "demo-agent",
    name: "Demo Agent",
    apiBase: replayBase,
    userToken: "ol_user_creator",
    store: new EnvRegistrationStore(path),
    fetch: core.fetch,
  });
  assert.equal(registration.agentToken, "ol_agent_minted_1");
  assert.deepEqual(core.state.registerTokens, ["ol_agent_expired_unused", "ol_agent_minted_1"]);
  assert.equal(readPending(await readFile(path, "utf8")), undefined);
});

test("ensureAgent leaves a completed registration and its stale record untouched", async (t) => {
  const core = replayCore();
  const completedPath = await tempEnv(t);
  const original = "OPENLINKER_AGENT_ID=\"agent-1\"\nOPENLINKER_AGENT_TOKEN=\"ol_agent_active\"\n"
    + pendingLine({ api_base: replayBase, agent_token: "ol_agent_stale", request: recordedRequest() });
  await writeFile(completedPath, original, { mode: 0o600 });
  const reused = await ensureAgent({
    apiBase: replayBase,
    userToken: "ol_user_creator",
    store: new EnvRegistrationStore(completedPath),
    fetch: core.fetch,
  });
  assert.equal(reused.agentToken, "ol_agent_active");
  assert.equal(core.state.registerTokens.length, 0);
  assert.equal(await readFile(completedPath, "utf8"), original);
});

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
