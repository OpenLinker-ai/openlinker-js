import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverRuntimeURL,
  validatePlatformURL,
  validateRuntimeURL,
} from "../dist/runtime.js";

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
