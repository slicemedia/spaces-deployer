import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validateSharedVersionConfiguration } from "./check-versioning.mjs";
import { validateGuardedPublishNextReadiness } from "./assert-publish-next-safe.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const workflowSource = await readFile(
  resolve(repositoryRoot, ".github/workflows/publish-next.yml"),
  "utf8",
);
const changesets = {
  $schema: "https://unpkg.com/@changesets/config@4.0.0/schema.json",
  access: "public",
  baseBranch: "main",
  ignore: [],
};
const privateManifest = {
  name: "@slicemedia/spaces-deployer",
  version: "0.2.0-next.0",
  private: true,
  publishConfig: { access: "public", provenance: true },
};
const publicManifest = { ...privateManifest, private: false };
const releaseEnvironment = {
  GITHUB_REPOSITORY: "slicemedia/spaces-deployer",
  GITHUB_REPOSITORY_VISIBILITY: "public",
  GITHUB_RELEASE_REF: "refs/heads/main",
  GITHUB_RELEASE_SHA: "a".repeat(40),
  SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED: "true",
};
const guardedInvocation = ["--context=publish-next-workflow"];

function validateRelease(overrides = {}) {
  return validateGuardedPublishNextReadiness({
    invocationArguments: Object.hasOwn(overrides, "invocationArguments")
      ? overrides.invocationArguments
      : guardedInvocation,
    changesets,
    environment: overrides.environment ?? releaseEnvironment,
    manifest: overrides.manifest ?? publicManifest,
    workflowSource,
  });
}

test("ordinary version validation rejects a private package state", () => {
  assert.match(
    validateSharedVersionConfiguration({
      changesets,
      packageManifest: privateManifest,
    }).join("\n"),
    /must explicitly declare private=false/u,
  );
});

test("ordinary version validation accepts the explicit public manifest", () => {
  assert.deepEqual(
    validateSharedVersionConfiguration({ changesets, packageManifest: publicManifest }),
    [],
  );
});

test("ordinary version validation fails closed when publication state is not explicit", () => {
  const implicitManifest = { ...publicManifest };
  delete implicitManifest.private;
  assert.match(
    validateSharedVersionConfiguration({
      changesets,
      packageManifest: implicitManifest,
    }).join("\n"),
    /must explicitly declare private=false/u,
  );
  assert.match(
    validateSharedVersionConfiguration({
      changesets,
      packageManifest: { ...publicManifest, private: "false" },
    }).join("\n"),
    /must explicitly declare private=false/u,
  );
});

test("ordinary version validation rejects private-package Changesets overrides", () => {
  assert.match(
    validateSharedVersionConfiguration({
      changesets: {
        ...changesets,
        privatePackages: { tag: false, version: true },
      },
      packageManifest: publicManifest,
    }).join("\n"),
    /must not use privatePackages overrides/u,
  );
});

test("the explicit guarded release-publish context accepts a public manifest", () => {
  assert.deepEqual(validateRelease(), []);
});

test("the guarded release-publish context rejects a private manifest", () => {
  assert.match(validateRelease({ manifest: privateManifest }).join("\n"), /private=false/u);
});

test("release-publish validation rejects missing or wrong invocation and environment guards", () => {
  assert.notDeepEqual(validateGuardedPublishNextReadiness(), []);

  const invalidCases = [
    { invocationArguments: undefined },
    { invocationArguments: [] },
    { invocationArguments: ["--context=release"] },
    { environment: { ...releaseEnvironment, GITHUB_REPOSITORY: undefined } },
    { environment: { ...releaseEnvironment, GITHUB_REPOSITORY: "example/spaces-deployer" } },
    { environment: { ...releaseEnvironment, GITHUB_REPOSITORY_VISIBILITY: "private" } },
    { environment: { ...releaseEnvironment, GITHUB_RELEASE_REF: "refs/heads/release" } },
    { environment: { ...releaseEnvironment, GITHUB_RELEASE_SHA: "not-a-commit" } },
    {
      environment: {
        ...releaseEnvironment,
        SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED: "false",
      },
    },
  ];

  for (const invalid of invalidCases) {
    assert.notDeepEqual(validateRelease(invalid), []);
  }
});

test("package scripts keep ordinary state checks and guarded publication explicit", () => {
  assert.equal(packageJson.scripts["version:check"], "node scripts/check-versioning.mjs");
  assert.match(packageJson.scripts.check, /pnpm version:check/u);
  assert.equal(
    packageJson.scripts["release:publish:check"],
    "node scripts/assert-publish-next-safe.mjs --context=publish-next-workflow",
  );
  assert.doesNotMatch(packageJson.scripts["release:publish:check"], /version:check/u);
});
