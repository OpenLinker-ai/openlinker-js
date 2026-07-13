import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";

import { OpenLinkerClient } from "../dist/index.js";
import {
  RuntimeContractDigest,
  RuntimeContractID,
  RuntimeProtocolVersion,
  RuntimeRequiredFeatures,
  RuntimeV2WebSocketSession,
} from "../dist/runtime.js";

test("Core client v1 contract maps to implemented SDK methods", async () => {
  const contractsDir = new URL("../contracts/", import.meta.url);
  const contract = JSON.parse(
    await readFile(new URL("core-client.v1.json", contractsDir), "utf8"),
  );

  assert.equal(contract.package, "@openlinker/sdk");
  assert.equal(contract.scope, "core");
  assert.ok(Array.isArray(contract.endpoints));
  assert.ok(contract.endpoints.length > 0);

  const forbiddenPrefixes = contract.rules.forbidden_path_prefixes;
  const methods = new Set();
  for (const endpoint of contract.endpoints) {
    assert.equal(typeof endpoint.client_method, "string");
    assert.equal(typeof endpoint.http_method, "string");
    assert.equal(typeof endpoint.path, "string");
    assert.ok(endpoint.path.startsWith("/api/v1/"));
    assert.ok(
      !forbiddenPrefixes.some((prefix) => endpoint.path.startsWith(prefix)),
      `Core SDK contract must not include Cloud/product endpoint ${endpoint.path}`,
    );
    methods.add(endpoint.client_method);
  }

  for (const method of methods) {
    assert.equal(
      typeof OpenLinkerClient.prototype[method],
      "function",
      `OpenLinkerClient missing contract method ${method}`,
    );
  }

  const runCreationEndpoints = contract.endpoints.filter(
    (endpoint) => endpoint.http_method === "POST" &&
      (endpoint.path === "/api/v1/run" || endpoint.path === "/api/v1/runs"),
  );
  assert.equal(runCreationEndpoints.length, 2);
  for (const endpoint of runCreationEndpoints) {
    assert.deepEqual(endpoint.required_headers, ["Idempotency-Key"]);
    assert.deepEqual(endpoint.success_statuses, [200, 201, 202]);
    assert.ok(endpoint.response_fields.includes("replayed"));
  }
});

test("Runtime v2 contract matches the exported handshake manifest", async () => {
  const contractsDir = new URL("../contracts/", import.meta.url);
  const files = await readdir(contractsDir);
  assert.ok(files.includes("core-runtime.v2.json"));
  assert.ok(!files.includes("core-runtime.v1.json"));
  await assert.rejects(access(new URL("core-runtime.v1.json", contractsDir)));

  const rawContract = await readFile(new URL("core-runtime.v2.json", contractsDir));
  const contract = JSON.parse(rawContract.toString("utf8"));
  const digest = createHash("sha256").update(rawContract).digest("hex");

  assert.equal(contract.name, "openlinker-runtime");
  assert.equal(contract.scope, "core-runtime");
  assert.equal(contract.version, "v2");
  assert.equal(contract.protocol_version, RuntimeProtocolVersion);
  assert.equal(contract.runtime_contract_id, RuntimeContractID);
  assert.equal(digest, RuntimeContractDigest);
  assert.deepEqual(contract.required_features, [...RuntimeRequiredFeatures]);
  assert.equal(new Set(contract.required_features).size, contract.required_features.length);
  assert.deepEqual(contract.required_features, [
    "lease_fence",
    "assignment_confirm",
    "renew",
    "resume",
    "event_ack",
    "result_ack",
    "cancel",
    "persistent_spool",
  ]);

  assert.equal(
    contract.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(contract.wire_format, "application/json");
  assert.equal(contract.websocket.path, "/api/v1/agent-runtime/ws");
  assert.equal(contract.websocket.path.includes("/v2/"), false);
  assert.equal(typeof RuntimeV2WebSocketSession, "function");
  assert.equal(contract.websocket.envelope_schema.$ref, "#/$defs/RuntimeMessage");
  assert.ok(contract.websocket.messages.length > 0);
  assert.ok(contract.endpoints.length > 0);

  const messageTypes = new Set();
  for (const message of contract.websocket.messages) {
    assert.equal(typeof message.type, "string");
    assert.ok(!messageTypes.has(message.type), `duplicate message ${message.type}`);
    messageTypes.add(message.type);
    assert.match(message.schema.$ref, /^#\/\$defs\//);
    assert.ok(contract.$defs[message.schema.$ref.slice("#/$defs/".length)]);
  }
  for (const required of [
    "runtime.hello",
    "run.assigned",
    "run.result",
    "runtime.resume",
    "run.cancel",
    "runtime.error",
  ]) {
    assert.ok(messageTypes.has(required), `missing message ${required}`);
  }

  const endpointKeys = new Set();
  for (const endpoint of contract.endpoints) {
    assert.equal(typeof endpoint.client_method, "string");
    assert.equal(typeof endpoint.http_method, "string");
    assert.equal(typeof endpoint.path, "string");
    assert.ok(endpoint.path.startsWith("/api/v1/agent-runtime/"));
    assert.equal(endpoint.path.includes(`/agent-runtime/${contract.version}/`), false);
    const key = `${endpoint.http_method} ${endpoint.path}`;
    assert.ok(!endpointKeys.has(key), `duplicate endpoint ${key}`);
    endpointKeys.add(key);
  }
  assert.ok(endpointKeys.has("POST /api/v1/agent-runtime/call-agent"));

  assert.equal(Object.hasOwn(contract, "legacy_routes"), false);
  for (const definition of [
    "AttemptIdentity",
    "RunResultPayload",
    "ResumeAttempt",
    "PendingCommand",
    "RuntimeCommandsResponse",
  ]) {
    assert.ok(contract.$defs[definition], `missing definition ${definition}`);
  }
  assert.deepEqual(
    contract.$defs.RuntimeErrorBody.properties.code.enum,
    contract.stable_error_codes,
  );
});
