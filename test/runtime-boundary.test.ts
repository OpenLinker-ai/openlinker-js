import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

import * as RootSDK from "../dist/index.js";
import * as RuntimeSDK from "../dist/runtime.js";

test("package root stays browser-safe while the server Runtime entry is complete", async () => {
  assert.equal("RuntimeWorker" in RootSDK, false);
  assert.equal("FileRuntimeStore" in RootSDK, false);
  assert.equal("NodeRuntimeTransport" in RootSDK, false);
  assert.equal(typeof RuntimeSDK.RuntimeWorker, "function");
  assert.equal(typeof RuntimeSDK.FileRuntimeStore, "function");
  assert.equal(typeof RuntimeSDK.NodeRuntimeTransport, "function");

  const [rootJavaScript, rootTypes, publicTypes] = await Promise.all([
    readFile(new URL("../dist/index.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/types.d.ts", import.meta.url), "utf8"),
  ]);
  for (const boundary of [rootJavaScript, rootTypes]) {
    assert.doesNotMatch(boundary, /node:/);
    assert.doesNotMatch(boundary, /undici|from ["']ws["']/);
    assert.doesNotMatch(boundary, /RuntimeWorker|RuntimeStore|NodeRuntimeTransport/);
  }
  assert.match(publicTypes, /ConnectionMode = "direct_http" \| "mcp_server" \| "runtime"/);
  assert.doesNotMatch(publicTypes, /agent_node/);
});

test("Runtime public names, source filenames, contract filename, and routes are neutral", async () => {
  const versionedPublicNames = Object.keys(RuntimeSDK).filter((name) => /V[0-9]+/.test(name));
  assert.deepEqual(versionedPublicNames, []);

  const sourceFiles = await readdir(new URL("../src/", import.meta.url));
  const testFiles = await readdir(new URL("./", import.meta.url));
  const contractFiles = await readdir(new URL("../contracts/", import.meta.url));
  for (const name of [...sourceFiles, ...testFiles, ...contractFiles].filter(
    (name) => name.includes("runtime"),
  )) {
    assert.doesNotMatch(name, /[.-]v[0-9]+/i);
  }

  assert.ok(contractFiles.includes("core-runtime.json"));
  const contract = JSON.parse(await readFile(
    new URL("../contracts/core-runtime.json", import.meta.url),
    "utf8",
  ));
  assert.equal(contract.websocket.path, "/api/v1/agent-runtime/ws");
  for (const endpoint of contract.endpoints) {
    assert.ok(endpoint.path.startsWith("/api/v1/agent-runtime/"));
  }
});
