import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { OpenLinkerClient } from "../dist/index.js";

test("Core contracts map to implemented SDK methods", async () => {
  const contractsDir = new URL("../contracts/", import.meta.url);
  const files = (await readdir(contractsDir)).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0);

  for (const file of files) {
    const contract = JSON.parse(await readFile(new URL(file, contractsDir), "utf8"));

    assert.equal(contract.package, "@openlinker/sdk");
    assert.ok(String(contract.scope).startsWith("core"));
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
  }
});
