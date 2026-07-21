import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeCredentialManager } from "../dist/runtime.js";

test("Runtime credential manager generates one private Node key per data directory", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openlinker-runtime-credential-"));
  t.after(() => rm(dataDir, { force: true, recursive: true }));
  const options = {
    dataDir,
    credentialEndpoint: "http://127.0.0.1:8080/api/v1/runtime-credentials",
    agentToken: "ol_agent_test",
    nodeVersion: "openlinker-js/runtime-worker",
    capacity: 1,
  };
  await RuntimeCredentialManager.open(options);
  const path = join(dataDir, "runtime-credential.json");
  const initial = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  assert.match(initial.privateKeyPEM!, /BEGIN PRIVATE KEY/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await RuntimeCredentialManager.open(options);
  const reopened = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  assert.equal(reopened.nodeId, initial.nodeId);
  assert.equal(reopened.privateKeyPEM, initial.privateKeyPEM);
  assert.equal(reopened.publicKeyThumbprint, initial.publicKeyThumbprint);
});
