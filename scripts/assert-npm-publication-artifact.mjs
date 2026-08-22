import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePublicationReceipt } from "./verify-npm-publication.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const prohibitedEnvironmentVariables = [
  "NODE_AUTH_TOKEN",
  "NPM_CONFIG__AUTH",
  "NPM_CONFIG__AUTHTOKEN",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_USERCONFIG",
  "NPM_TOKEN",
  "YARN_NPM_AUTH_TOKEN",
  "npm_config__auth",
  "npm_config__authtoken",
  "npm_config_globalconfig",
  "npm_config_registry",
  "npm_config_userconfig",
];

export function validatePublicationEnvironment(environment, manifest) {
  const errors = [];
  if (environment.GITHUB_REPOSITORY !== "slicemedia/spaces-deployer") {
    errors.push("Publication is running in an unexpected repository.");
  }
  if (environment.GITHUB_REPOSITORY_VISIBILITY !== "public") {
    errors.push("Publication requires an explicitly public repository.");
  }
  if (environment.GITHUB_REF !== "refs/heads/main") {
    errors.push("Publication is restricted to refs/heads/main.");
  }
  if (!/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? "")) {
    errors.push("Publication requires a full GITHUB_SHA.");
  }
  if (environment.SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED !== "true") {
    errors.push("Publication requires SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED=true.");
  }
  if (environment.SLICEMEDIA_RELEASE_ENVIRONMENT !== "npm-next") {
    errors.push("Publication requires the protected npm-next environment.");
  }
  for (const variable of prohibitedEnvironmentVariables) {
    if (environment[variable]?.trim())
      errors.push(`${variable} must not override npm publication.`);
  }
  if (manifest.name !== "@slicemedia/spaces-deployer" || manifest.private !== false) {
    errors.push("Publication requires the reviewed public Spaces Deployer manifest.");
  }
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
    errors.push("Publication requires public access and provenance in package metadata.");
  }
  return errors;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const errors = validatePublicationEnvironment(process.env, manifest);
  const npmrc = await readFile(resolve(repositoryRoot, ".npmrc"), "utf8");
  if (npmrc !== "engine-strict=true\nsave-exact=true\n") {
    errors.push(
      "Repository .npmrc must not override registry, user configuration, or authentication.",
    );
  }
  try {
    const { stdout: npmVersion } = await execFileAsync("npm", ["--version"], {
      cwd: repositoryRoot,
    });
    if (npmVersion.trim() !== "11.19.0") {
      errors.push("Publication requires npm 11.19.0 exactly.");
    }
  } catch (error) {
    errors.push(
      `Unable to verify npm 11.19.0: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const archivePath = resolve(repositoryRoot, ".npm-release/package.tgz");
  const receiptPath = resolve(repositoryRoot, ".npm-release/receipt.json");
  const [archiveStats, receiptStats] = await Promise.all([lstat(archivePath), lstat(receiptPath)]);
  if (!archiveStats.isFile() || archiveStats.size <= 0 || archiveStats.size > 25 * 1024 * 1024) {
    errors.push("Release archive must be a bounded regular file.");
  }
  if (!receiptStats.isFile() || receiptStats.size <= 0 || receiptStats.size > 16 * 1024) {
    errors.push("Release receipt must be a bounded regular file.");
  }

  if (errors.length === 0) {
    const [archive, receiptSource] = await Promise.all([
      readFile(archivePath),
      readFile(receiptPath, "utf8"),
    ]);
    const receipt = JSON.parse(receiptSource);
    const hashes = {
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      shasum: createHash("sha1").update(archive).digest("hex"),
    };
    errors.push(
      ...validatePublicationReceipt(receipt, manifest, hashes, process.env.GITHUB_SHA),
      ...(await inspectSourceCommit(process.env.GITHUB_SHA)),
    );
  }

  if (errors.length > 0) {
    console.error([...new Set(errors)].join("\n"));
    process.exitCode = 1;
  } else {
    console.info(
      "Exact release archive, source commit, registry boundary, and OIDC environment passed.",
    );
  }
}

async function inspectSourceCommit(expected) {
  const [{ stdout: headOutput }, { stdout: remoteOutput }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repositoryRoot }),
    execFileAsync("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], {
      cwd: repositoryRoot,
    }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryRoot,
    }),
  ]);
  const head = headOutput.trim();
  const remote = remoteOutput.trim().split(/\s+/u)[0] ?? "";
  const errors = [];
  if (expected !== head) errors.push("Checked-out HEAD does not match GITHUB_SHA.");
  if (expected !== remote) errors.push("GITHUB_SHA is no longer current remote main.");
  if (status.trim() !== "")
    errors.push("The release worktree contains unexpected files or changes.");
  return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
