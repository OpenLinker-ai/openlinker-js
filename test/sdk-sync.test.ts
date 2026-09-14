import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { OpenLinkerClient, OpenLinkerError } from "../dist/index.js";
import {
  OpenLinkerRuntime, RuntimeDelegationUnsupportedError,
  RuntimeDelegatedRunReadPath, buildRuntimeInvocationProof, runtimeDelegationReadAdvertised,
} from "../dist/runtime.js";

const runId = "77777777-7777-4777-8777-777777777777";
const token = `ol_inv_v2.current.${Buffer.from(JSON.stringify({
  audience: "openlinker.runtime.v2/delegation",
})).toString("base64url")}.signature`;
const authorization = {
  token, invocationContext: "ol_ctx_v2.current.payload.signature", idempotencyKey: "read-child",
};

test("platform cancel and recommendation use User Token, Core paths and typed payloads", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new OpenLinkerClient({
    baseUrl: "https://core.example", userToken: "ol_user_test",
    fetch: async (url, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer ol_user_test");
      const path = new URL(String(url)).pathname;
      requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(path.endsWith("/cancel")
        ? { run_id: runId, status: "canceled" }
        : { task_id: "task-1", visibility: "private", recommendations: [{ agent: { slug: "research" } }] });
    },
  });
  assert.equal((await client.cancelRun("run /?#")).status, "canceled");
  const task = await client.recommendTask({ query: "research", templateId: "template-1",
    skillIds: ["skill-1"], mcpTools: ["search"], agentSlugs: ["research"] });
  assert.equal(task.recommendations[0]?.agent.slug, "research");
  assert.deepEqual(requests, [
    { path: "/api/v1/runs/run%20%2F%3F%23/cancel", body: undefined },
    { path: "/api/v1/tasks/recommend", body: { query: "research", template_id: "template-1",
      skill_ids: ["skill-1"], mcp_tools: ["search"], agent_slugs: ["research"] } },
  ]);
});

test("delegated Run read signs exact bytes without User/Agent Token or attachment", async () => {
  const runtime = new OpenLinkerRuntime({
    baseUrl: "https://runtime.example", agentToken: () => { throw new Error("Agent Token leaked"); },
    headers: { Authorization: "Bearer wrong", "OpenLinker-Runtime-Attachment": "wrong" },
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).pathname, RuntimeDelegatedRunReadPath);
      assert.equal(init?.method, "POST");
      const body = new Uint8Array(init!.body as ArrayBuffer);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(body)), { run_id: runId });
      const headers = new Headers(init!.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${token}`);
      assert.equal(headers.get("OpenLinker-Runtime-Attachment"), null);
      assert.equal(headers.get("OpenLinker-Invocation-Context"), authorization.invocationContext);
      assert.equal(headers.get("Idempotency-Key"), authorization.idempotencyKey);
      assert.equal(headers.get("OpenLinker-Invocation-Proof"), await buildRuntimeInvocationProof(token, {
        method: "POST", path: RuntimeDelegatedRunReadPath, body,
        context: authorization.invocationContext, idempotencyKey: authorization.idempotencyKey,
      }));
      return Response.json({ run_id: runId, status: "success", dispatch_state: "terminal", output: { answer: 42 } });
    },
  });
  assert.deepEqual((await runtime.readRuntimeDelegatedRun(authorization, runId, {
    headers: { Authorization: "Bearer override", "OpenLinker-Runtime-Attachment": "override" },
  })).output, { answer: 42 });
});

test("delegated reads reject old capabilities and invalid or cross-Run responses", async () => {
  let calls = 0;
  let response: unknown = { run_id: runId, status: "running", dispatch_state: "pending" };
  const runtime = new OpenLinkerRuntime({ baseUrl: "https://runtime.example", agentToken: "ol_agent_test",
    fetch: async () => { calls++; return Response.json(response); },
  });
  for (const legacy of ["", "ol_agent_test", "ol_inv_v2.current.payload.signature",
    `ol_inv_v2.current.${Buffer.from('{"audience":"other"}').toString("base64url")}.signature`]) {
    assert.equal(runtimeDelegationReadAdvertised(legacy), false);
  }
  await assert.rejects(() => runtime.readRuntimeDelegatedRun({ ...authorization,
    token: "ol_inv_v2.current.payload.signature" }, runId), RuntimeDelegationUnsupportedError);
  await assert.rejects(() => runtime.readRuntimeDelegatedRun(authorization, "invalid"), /UUID/);
  assert.equal(calls, 0);
  assert.equal((await runtime.readRuntimeDelegatedRun(authorization, runId)).status, "running");
  for (const invalid of [
    { run_id: "66666666-6666-4666-8666-666666666666", status: "success", dispatch_state: "terminal" },
    { run_id: runId, status: "success", dispatch_state: "pending" },
    { run_id: runId, status: "success", dispatch_state: "terminal", input: { secret: true } },
    { run_id: runId, status: "success", dispatch_state: "terminal", output: "wrong" },
    { run_id: runId, status: "failed", dispatch_state: "terminal", error_code: 42 },
  ]) {
    response = invalid;
    await assert.rejects(() => runtime.readRuntimeDelegatedRun(authorization, runId));
  }
  const denied = new OpenLinkerClient({ baseUrl: "https://core.example", userToken: "ol_user_test",
    fetch: async () => Response.json({ error: { code: "FORBIDDEN", message: "denied" } }, { status: 403 }) });
  await assert.rejects(() => denied.cancelRun(runId), OpenLinkerError);
});

test("optional contracts map to implemented methods and retain narrow ownership", async () => {
  const tasks = JSON.parse(await readFile(new URL("../contracts/core-tasks.v1.json", import.meta.url), "utf8"));
  assert.deepEqual(tasks.rules.allowed_paths, ["/api/v1/tasks/recommend"]);
  assert.equal(tasks.endpoints.length, 1);
  assert.equal(typeof (OpenLinkerClient.prototype as any)[tasks.endpoints[0].client_method], "function");
  const delegated = JSON.parse(await readFile(new URL("../contracts/core-runtime-delegation.json", import.meta.url), "utf8"));
  assert.equal(delegated.endpoints[0].path, RuntimeDelegatedRunReadPath);
  assert.equal(typeof (OpenLinkerRuntime.prototype as any)[delegated.endpoints[0].client_method], "function");
});
