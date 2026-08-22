import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSharedVersionConfiguration } from "./check-versioning.mjs";
import { validatePublishNextWorkflow } from "./publish-next-workflow-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const expectedRepository = "slicemedia/spaces-deployer";
const expectedPackage = "@slicemedia/spaces-deployer";
const expectedInvocationArguments = ["--context=publish-next-workflow"];
const prohibitedCredentialVariables = [
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

export function validatePublishNextInvocation(invocationArguments) {
  const receivedArguments = Array.isArray(invocationArguments) ? invocationArguments : [];
  if (
    receivedArguments.length !== expectedInvocationArguments.length ||
    receivedArguments.some((argument, index) => argument !== expectedInvocationArguments[index])
  ) {
    return [
      "Release-publish validation requires the exact --context=publish-next-workflow invocation guard.",
    ];
  }
  return [];
}

export function validatePublishNextReadiness({
  changesets,
  environment = {},
  manifest = {},
  workflowSource = "",
} = {}) {
  const errors = [];
  errors.push(...validateSharedVersionConfiguration({ changesets, packageManifest: manifest }));
  if (environment.GITHUB_REPOSITORY !== expectedRepository) {
    errors.push(`npm publication is restricted to ${expectedRepository}.`);
  }
  if (environment.GITHUB_REPOSITORY_VISIBILITY !== "public") {
    errors.push("npm publication requires GITHUB_REPOSITORY_VISIBILITY=public.");
  }
  if (environment.GITHUB_RELEASE_REF !== "refs/heads/main") {
    errors.push("npm publication is restricted to refs/heads/main.");
  }
  if (!/^[0-9a-f]{40}$/u.test(environment.GITHUB_RELEASE_SHA ?? "")) {
    errors.push("npm publication requires GITHUB_RELEASE_SHA to be a full commit ID.");
  }
  if (environment.SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED !== "true") {
    errors.push("npm publication requires SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED=true.");
  }
  for (const variable of prohibitedCredentialVariables) {
    if (environment[variable]?.trim()) errors.push(`${variable} must not be available.`);
  }
  if (manifest.private !== false)
    errors.push(`${expectedPackage} must explicitly set private=false.`);
  if (manifest.publishConfig?.access !== "public") {
    errors.push(`${expectedPackage} must publish with public access.`);
  }
  if (manifest.publishConfig?.provenance !== true) {
    errors.push(`${expectedPackage} must publish with provenance.`);
  }
  errors.push(...validatePublishNextWorkflow(workflowSource));
  return [...new Set(errors)];
}

export function validateGuardedPublishNextReadiness({ invocationArguments, ...readiness } = {}) {
  return [
    ...new Set([
      ...validatePublishNextInvocation(invocationArguments),
      ...validatePublishNextReadiness(readiness),
    ]),
  ];
}

export function validatePublishSourceCommit({ expected, head, remote, status }) {
  const errors = [];
  const commitPattern = /^[0-9a-f]{40}$/u;
  if (!commitPattern.test(expected ?? ""))
    errors.push("GITHUB_RELEASE_SHA is not a full commit ID.");
  if (!commitPattern.test(head ?? "")) errors.push("Checked-out HEAD is not a full commit ID.");
  if (!commitPattern.test(remote ?? "")) errors.push("Remote main is not a full commit ID.");
  if (expected !== head) errors.push("Checked-out HEAD does not match GITHUB_RELEASE_SHA.");
  if (expected !== remote) errors.push("GITHUB_RELEASE_SHA is no longer the remote main commit.");
  if (status.trim() !== "") errors.push("Tracked files changed after release validation.");
  return errors;
}

async function inspectPublishSourceCommit(expected) {
  const [{ stdout: headOutput }, { stdout: remoteOutput }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repositoryRoot }),
    execFileAsync("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], {
      cwd: repositoryRoot,
    }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryRoot,
    }),
  ]);
  const remote = remoteOutput.trim().split(/\s+/u)[0] ?? "";
  return validatePublishSourceCommit({
    expected,
    head: headOutput.trim(),
    remote,
    status,
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const changesets = JSON.parse(
    await readFile(resolve(repositoryRoot, ".changeset/config.json"), "utf8"),
  );
  const workflowSource = await readFile(
    resolve(repositoryRoot, ".github/workflows/publish-next.yml"),
    "utf8",
  );
  const errors = validateGuardedPublishNextReadiness({
    invocationArguments: process.argv.slice(2),
    changesets,
    environment: process.env,
    manifest,
    workflowSource,
  });
  if (errors.length === 0) {
    try {
      errors.push(...(await inspectPublishSourceCommit(process.env.GITHUB_RELEASE_SHA)));
    } catch (error) {
      errors.push(
        `Unable to prove the checked-out commit is current remote main: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.info(
      "Public next-tag publication is structurally approved for npm trusted publishing.",
    );
  }
}
