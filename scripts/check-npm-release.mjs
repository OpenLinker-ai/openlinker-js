import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label) {
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`cannot parse ${label}: ${error.message}`);
  }
}

function runGit(rootDir, args, description) {
  const result = spawnSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`cannot ${description}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.status}`;
    fail(`cannot ${description}: ${detail}`);
  }
  return result.stdout.trimEnd();
}

export function checkNpmRelease(rootDir = packageRoot) {
  const packageJson = readJson(path.join(rootDir, "package.json"), "package.json");
  const packageLock = readJson(path.join(rootDir, "package-lock.json"), "package-lock.json");
  const version = packageJson.version;

  if (typeof version !== "string" || version.trim() === "") {
    fail("package.json.version must be a non-empty string");
  }
  if (packageLock.version !== version) {
    fail(
      `package-lock.json.version is ${JSON.stringify(packageLock.version)}, expected ${JSON.stringify(version)}`,
    );
  }
  if (packageLock.packages?.[""]?.version !== version) {
    fail(
      `package-lock.json packages[\"\"].version is ${JSON.stringify(packageLock.packages?.[""]?.version)}, ` +
        `expected ${JSON.stringify(version)}`,
    );
  }

  const expectedTag = `v${version}`;
  const headSha = runGit(rootDir, ["rev-parse", "--verify", "HEAD^{commit}"], "resolve HEAD");
  const tagSha = runGit(
    rootDir,
    ["rev-parse", "--verify", `refs/tags/${expectedTag}^{commit}`],
    `resolve exact npm release tag ${expectedTag}`,
  );
  if (tagSha !== headSha) {
    fail(`exact npm release tag ${expectedTag} resolves to ${tagSha}, expected current HEAD ${headSha}`);
  }

  const worktreeStatus = runGit(
    rootDir,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    "inspect the Git worktree",
  );
  if (worktreeStatus !== "") {
    fail(`Git worktree must be clean before npm publish; found:\n${worktreeStatus}`);
  }

  return { version, expectedTag, headSha };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const result = checkNpmRelease();
    console.log(`npm release gate passed for @openlinker/sdk@${result.version} (${result.expectedTag})`);
  } catch (error) {
    console.error(`npm release gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
