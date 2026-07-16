import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeRuntimeDiscoveryManifest,
  discoverRuntimeURL,
  resolveRuntimeTransportSelection,
  validatePlatformURL,
  validateRuntimeURL,
} from "../dist/runtime.js";

test("Runtime discovery policy fixtures stay consistent with Core transport semantics", async (t) => {
  const fixture = JSON.parse(await readFile(
    new URL("../contracts/runtime-discovery-policy-fixtures.json", import.meta.url),
    "utf8",
  ));
  const connections = new Map();
  for (const item of fixture.cases) {
    await t.test(item.name, () => {
      const connection = decodeRuntimeDiscoveryManifest(item.manifest);
      connections.set(item.name, connection);
      assert.deepEqual({
        allowed: connection.policy.allowedTransports,
        default: connection.policy.defaultTransport,
        heartbeat_interval_ms: connection.policy.heartbeatIntervalMs ?? 5_000,
        session_stale_after_ms: connection.policy.sessionStaleAfterMs ?? 0,
        retry_minimum_ms: connection.policy.retryMinimumMs ?? 250,
        retry_maximum_ms: connection.policy.retryMaximumMs ?? 15_000,
        websocket_probe_interval_ms: connection.policy.websocketProbeIntervalMs ?? 15_000,
        websocket_probe_timeout_ms: connection.policy.websocketProbeTimeoutMs ?? 10_000,
      }, item.expected);
    });
  }
  for (const item of fixture.configured_transport_cases) {
    await t.test(item.name, () => {
      const connection = item.manifest
        ? decodeRuntimeDiscoveryManifest(item.manifest)
        : connections.get(item.manifest_case);
      assert.ok(connection, `unknown fixture ${item.manifest_case}`);
      if (item.error) {
        assert.throws(
          () => resolveRuntimeTransportSelection(item.configured, connection.policy),
          new RegExp(item.error),
        );
        return;
      }
      const selection = resolveRuntimeTransportSelection(item.configured, connection.policy);
      assert.equal(selection.mode, item.effective);
    });
  }
});

test("Runtime discovery is credential-free, bounded, and returns a neutral HTTPS origin", async () => {
  let request;
  const runtimeURL = await discoverRuntimeURL("https://openlinker.example", {
    fetch: async (input, init) => {
      request = { input: String(input), init };
      return new Response(JSON.stringify({
        base_urls: { runtime: "https://runtime.example" },
        runtime: { enabled: true, mtls_required: true },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(runtimeURL, "https://runtime.example");
  assert.equal(request.input, "https://openlinker.example/.well-known/openlinker.json");
  assert.equal(request.init.redirect, "error");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("cookie"), false);
});

test("Runtime origins reject credentials, paths, redirects, and non-mTLS manifests", async () => {
  assert.equal(validateRuntimeURL("https://runtime.example"), "https://runtime.example");
  assert.equal(validatePlatformURL("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  for (const invalid of [
    "http://runtime.example",
    "https://user:secret@runtime.example",
    "https://runtime.example/api/v1",
    "https://runtime.example?token=secret",
    "https://runtime.example#runtime",
  ]) {
    assert.throws(() => validateRuntimeURL(invalid));
  }

  await assert.rejects(discoverRuntimeURL("https://openlinker.example", {
    fetch: async () => new Response("", { status: 302, headers: { location: "https://other.example" } }),
  }), /HTTP 302/);
  await assert.rejects(discoverRuntimeURL("https://openlinker.example", {
    fetch: async () => new Response(JSON.stringify({
      base_urls: { runtime: "https://runtime.example" },
      runtime: { enabled: true, mtls_required: false },
    })),
  }), /required mTLS Runtime address/);
});
