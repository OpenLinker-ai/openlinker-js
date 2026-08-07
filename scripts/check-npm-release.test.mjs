import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkNpmRelease } from "./check-npm-release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(rootDir, ...args) {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

async function writePackageFiles(rootDir, version = "1.2.3") {
  await writeFile(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: "release-gate-fixture", version }, null, 2)}\n`,
  );
  await writeFile(
    path.join(rootDir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "release-gate-fixture",
        version,
        lockfileVersion: 3,
        packages: { "": { name: "release-gate-fixture", version } },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(rootDir, "README.md"), "fixture\n");
}

async function createFixture({ tag = true } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openlinker-js-release-gate-"));
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "OpenLinker Test");
  git(rootDir, "config", "user.email", "test@openlinker.local");
  git(rootDir, "config", "commit.gpgSign", "false");
  git(rootDir, "config", "tag.gpgSign", "false");
  await writePackageFiles(rootDir);
  git(rootDir, "add", ".");
  git(rootDir, "commit", "--quiet", "-m", "fixture");
  if (tag) {
    git(rootDir, "tag", "v1.2.3");
  }
  return rootDir;
}

async function withFixture(options, callback) {
  const rootDir = await createFixture(options);
  try {
    await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("package lifecycle wires the explicit and automatic gates to one checker", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["release:check"], "node ./scripts/check-npm-release.mjs");
  assert.equal(packageJson.scripts.prepublishOnly, "npm run release:check");
});

test("accepts a clean checkout whose package, lockfile, tag, and HEAD agree", async () => {
  await withFixture({}, async (rootDir) => {
    const result = checkNpmRelease(rootDir);
    assert.equal(result.version, "1.2.3");
    assert.equal(result.expectedTag, "v1.2.3");
    assert.equal(result.headSha, git(rootDir, "rev-parse", "HEAD"));
  });
});

test("rejects a top-level lockfile version mismatch", async () => {
  await withFixture({}, async (rootDir) => {
    const lockPath = path.join(rootDir, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.version = "9.9.9";
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    assert.throws(() => checkNpmRelease(rootDir), /package-lock\.json\.version is "9\.9\.9", expected "1\.2\.3"/);
  });
});

test("rejects a root package lockfile version mismatch", async () => {
  await withFixture({}, async (rootDir) => {
    const lockPath = path.join(rootDir, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages[""].version = "9.9.9";
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    assert.throws(
      () => checkNpmRelease(rootDir),
      /package-lock\.json packages\[""\]\.version is "9\.9\.9", expected "1\.2\.3"/,
    );
  });
});

test("rejects a missing exact npm release tag", async () => {
  await withFixture({ tag: false }, async (rootDir) => {
    assert.throws(() => checkNpmRelease(rootDir), /cannot resolve exact npm release tag v1\.2\.3/);
  });
});

test("rejects an exact npm release tag that points to another commit", async () => {
  await withFixture({}, async (rootDir) => {
    await writeFile(path.join(rootDir, "README.md"), "second commit\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "--quiet", "-m", "move head");
    assert.throws(
      () => checkNpmRelease(rootDir),
      /exact npm release tag v1\.2\.3 resolves to [0-9a-f]{40}, expected current HEAD [0-9a-f]{40}/,
    );
  });
});

test("rejects tracked worktree changes", async () => {
  await withFixture({}, async (rootDir) => {
    await writeFile(path.join(rootDir, "README.md"), "dirty\n");
    assert.throws(
      () => checkNpmRelease(rootDir),
      /Git worktree must be clean before npm publish; found:\n M README\.md/,
    );
  });
});

test("rejects untracked worktree changes", async () => {
  await withFixture({}, async (rootDir) => {
    await writeFile(path.join(rootDir, "untracked.txt"), "dirty\n");
    assert.throws(
      () => checkNpmRelease(rootDir),
      /Git worktree must be clean before npm publish; found:\n\?\? untracked\.txt/,
    );
  });
});

test("rejects a directory that is not a complete Git checkout", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openlinker-js-release-gate-no-git-"));
  try {
    await writePackageFiles(rootDir);
    assert.throws(() => checkNpmRelease(rootDir), /cannot resolve HEAD/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
