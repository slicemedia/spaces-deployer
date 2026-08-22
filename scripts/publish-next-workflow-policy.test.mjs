import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validatePublicationEnvironment } from "./assert-npm-publication-artifact.mjs";
import {
  validatePublishNextReadiness,
  validatePublishSourceCommit,
} from "./assert-publish-next-safe.mjs";
import { calculateArchiveHashes, validatePackResult } from "./prepare-npm-publication.mjs";
import { validatePublishNextWorkflow } from "./publish-next-workflow-policy.mjs";
import { validatePublicationReceipt, validateRegistryMetadata } from "./verify-npm-publication.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = await readFile(
  resolve(repositoryRoot, ".github/workflows/publish-next.yml"),
  "utf8",
);
const commit = "a".repeat(40);
const publicManifest = {
  name: "@slicemedia/spaces-deployer",
  version: "0.2.0",
  private: false,
  publishConfig: { access: "public", provenance: true },
};
const changesets = {
  $schema: "https://unpkg.com/@changesets/config@4.0.0/schema.json",
  access: "public",
  baseBranch: "main",
  ignore: [],
  privatePackages: { tag: false, version: true },
};
const prepareEnvironment = {
  GITHUB_REPOSITORY: "slicemedia/spaces-deployer",
  GITHUB_REPOSITORY_VISIBILITY: "public",
  GITHUB_RELEASE_REF: "refs/heads/main",
  GITHUB_RELEASE_SHA: commit,
  SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED: "true",
};
const publishEnvironment = {
  ...prepareEnvironment,
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: commit,
  SLICEMEDIA_RELEASE_ENVIRONMENT: "npm-next",
};

test("accepts only token-free preparation, minimal OIDC publication, and no-OIDC verification", () => {
  assert.deepEqual(validatePublishNextWorkflow(workflow), []);
  assert.deepEqual(
    validatePublishNextReadiness({
      changesets,
      environment: prepareEnvironment,
      manifest: publicManifest,
      workflowSource: workflow,
    }),
    [],
  );
  assert.deepEqual(validatePublicationEnvironment(publishEnvironment, publicManifest), []);
});

test("rejects changes to every publish trust boundary", () => {
  const mutations = [
    (source) => source.replace("  workflow_dispatch:", "  push:\n    tags:\n      - v*"),
    (source) => source.replace("environment: release-sanitize", "environment: production"),
    (source) => source.replace("environment: npm-next", "environment: production"),
    (source) => source.replace("id-token: write", "id-token: none"),
    (source) =>
      source.replace(
        "  prepare:\n    if:",
        "  prepare:\n    permissions:\n      id-token: write\n    if:",
      ),
    (source) => source.replace("persist-credentials: false", "persist-credentials: true"),
    (source) => source.replace("fetch-depth: 0", "fetch-depth: 1"),
    (source) => source.replace("runtime: node@24", "runtime: node@latest"),
    (source) => source.replace("npm@11.19.0", "npm@12.0.0"),
    (source) =>
      source.replace("${{ secrets.SLICEMEDIA_FORBIDDEN_TERMS }}", "${{ secrets.UNRELATED_VALUE }}"),
    (source) => source.replace('= "11.19.0"', '= "11.19.1"'),
    (source) => source.replace("--tag next", "--tag latest"),
    (source) => source.replace("npm publish .npm-release/package.tgz", "npm publish"),
    (source) =>
      source.replace(
        "--registry https://registry.npmjs.org/",
        "--registry https://registry.example.test/",
      ),
    (source) =>
      source.replace(
        "      - run: npm publish .npm-release/package.tgz --ignore-scripts --tag next --access public --provenance --registry https://registry.npmjs.org/ --userconfig /dev/null",
        "      - run: npm publish .npm-release/package.tgz --ignore-scripts --tag next --access public --provenance --registry https://registry.npmjs.org/ --userconfig /dev/null\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      ),
    (source) =>
      `${source}\n  unexpected:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v0.2.0\n`,
  ];
  for (const mutate of mutations) {
    const mutated = mutate(workflow);
    assert.notEqual(mutated, workflow);
    assert.notDeepEqual(validatePublishNextWorkflow(mutated), []);
  }
});

test("rejects private state, wrong refs, stale commits, disabled gates, and npm overrides", () => {
  const readinessCases = [
    { manifest: { ...publicManifest, private: true } },
    { environment: { ...prepareEnvironment, GITHUB_REPOSITORY_VISIBILITY: "private" } },
    { environment: { ...prepareEnvironment, GITHUB_RELEASE_REF: "refs/heads/feature" } },
    {
      environment: {
        ...prepareEnvironment,
        SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED: "false",
      },
    },
    { environment: { ...prepareEnvironment, NPM_TOKEN: "synthetic-token" } },
  ];
  for (const entry of readinessCases) {
    assert.notDeepEqual(
      validatePublishNextReadiness({
        changesets,
        environment: entry.environment ?? prepareEnvironment,
        manifest: entry.manifest ?? publicManifest,
        workflowSource: workflow,
      }),
      [],
    );
  }

  assert.deepEqual(
    validatePublishSourceCommit({ expected: commit, head: commit, remote: commit, status: "" }),
    [],
  );
  assert.notDeepEqual(
    validatePublishSourceCommit({
      expected: commit,
      head: commit,
      remote: "b".repeat(40),
      status: "",
    }),
    [],
  );
  assert.notDeepEqual(
    validatePublicationEnvironment(
      { ...publishEnvironment, npm_config_registry: "https://registry.example.test/" },
      publicManifest,
    ),
    [],
  );
});

test("binds pack output, receipt, source commit, and registry metadata to one exact archive", () => {
  const hashes = calculateArchiveHashes(Buffer.from("synthetic package archive"));
  const packResult = {
    name: publicManifest.name,
    version: publicManifest.version,
    filename: "synthetic.tgz",
    ...hashes,
  };
  assert.deepEqual(validatePackResult(packResult, publicManifest, hashes), []);

  const receipt = {
    schemaVersion: 1,
    name: publicManifest.name,
    version: publicManifest.version,
    archive: ".npm-release/package.tgz",
    npmVersion: "11.19.0",
    ...hashes,
    sourceCommit: commit,
  };
  assert.deepEqual(validatePublicationReceipt(receipt, publicManifest, hashes, commit), []);

  const metadata = {
    name: publicManifest.name,
    versions: {
      [publicManifest.version]: {
        name: publicManifest.name,
        version: publicManifest.version,
        dist: {
          ...hashes,
          tarball: "https://registry.npmjs.org/example.tgz",
        },
      },
    },
    "dist-tags": { next: publicManifest.version },
  };
  assert.deepEqual(
    validateRegistryMetadata(
      metadata,
      publicManifest.name,
      publicManifest.version,
      hashes.integrity,
      hashes.shasum,
    ),
    [],
  );
  assert.notDeepEqual(
    validateRegistryMetadata(
      metadata,
      publicManifest.name,
      publicManifest.version,
      "sha512-unrelated",
      hashes.shasum,
    ),
    [],
  );
  assert.notDeepEqual(
    validatePublicationReceipt(
      { ...receipt, sourceCommit: "b".repeat(40) },
      publicManifest,
      hashes,
      commit,
    ),
    [],
  );
  assert.notDeepEqual(
    validatePublicationReceipt(
      { ...receipt, npmVersion: "11.18.0" },
      publicManifest,
      hashes,
      commit,
    ),
    [],
  );
});
