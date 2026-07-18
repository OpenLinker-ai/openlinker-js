import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OpenLinkerClient } from "../dist/index.js";
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
