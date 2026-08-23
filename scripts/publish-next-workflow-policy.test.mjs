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
import {
  registryAvailabilityWindowMilliseconds,
  registryPollIntervalMilliseconds,
  validateNpmAuditReport,
  validateProvenanceAttestations,
  validatePublicationReceipt,
  validateRegistryMetadata,
  waitForPublicationAvailability,
} from "./verify-npm-publication.mjs";

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

test("fails closed unless the reviewed global npm is first on PATH for preparation", () => {
  assert.equal(workflow.match(/npm_global_prefix="\$\(npm prefix -g\)"/gu)?.length, 1);
  const mutations = [
    (source) => source.replace('"$npm_global_prefix" != /*', '"$npm_global_prefix" == ""'),
    (source) => source.replace('! -x "$npm_global_bin/npm"', '! -e "$npm_global_bin/npm"'),
    (source) => source.replace('export PATH="$npm_global_bin:$PATH"', 'export PATH="$PATH"'),
    (source) => source.replace('"$(command -v npm)" != "$npm_global_bin/npm" || ', ""),
    (source) => source.replace('"$(npm --version)" != "11.19.0"', '"11.19.0" != "11.19.0"'),
    (source) => source.replace('"$GITHUB_PATH" != /*', '"$GITHUB_PATH" == ""'),
    (source) =>
      source.replace(
        'printf \'%s\\n\' "$npm_global_bin" >> "$GITHUB_PATH"',
        'printf \'%s\\n\' "$PATH" >> "$GITHUB_PATH"',
      ),
    (source) => source.replace("        run: |\n", "        run: >\n"),
    (source) =>
      source.replace(
        "      - run: pnpm install --frozen-lockfile",
        "      - run: |\n          pnpm install --frozen-lockfile",
      ),
  ];
  for (const mutate of mutations) {
    const mutated = mutate(workflow);
    assert.notEqual(mutated, workflow);
    assert.notDeepEqual(validatePublishNextWorkflow(mutated), []);
  }
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
    (source) => source.replace("timeout-minutes: 25", "timeout-minutes: 10"),
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
          attestations: {
            url: `https://registry.npmjs.org/-/npm/v1/attestations/%40slicemedia%2fspaces-deployer@${publicManifest.version}`,
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
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
  const metadataWithoutProvenance = JSON.parse(JSON.stringify(metadata));
  delete metadataWithoutProvenance.versions[publicManifest.version].dist.attestations;
  assert.notDeepEqual(
    validateRegistryMetadata(
      metadataWithoutProvenance,
      publicManifest.name,
      publicManifest.version,
      hashes.integrity,
      hashes.shasum,
    ),
    [],
  );
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/%40slicemedia/spaces-deployer@${publicManifest.version}`,
        digest: {
          sha512: Buffer.from(hashes.integrity.slice("sha512-".length), "base64").toString("hex"),
        },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/slicemedia/spaces-deployer",
            path: ".github/workflows/publish-next.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/slicemedia/spaces-deployer@refs/heads/main",
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  const provenance = {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      },
    ],
  };
  assert.deepEqual(
    validateProvenanceAttestations(
      provenance,
      publicManifest.name,
      publicManifest.version,
      hashes.integrity,
      commit,
    ),
    [],
  );
  for (const path of [
    "/.github/workflows/publish-next.yml",
    ".github/workflows/publish-next.yml/extra",
  ]) {
    const wrongWorkflowPathStatement = JSON.parse(JSON.stringify(statement));
    wrongWorkflowPathStatement.predicate.buildDefinition.externalParameters.workflow.path = path;
    const wrongWorkflowPathProvenance = JSON.parse(JSON.stringify(provenance));
    wrongWorkflowPathProvenance.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(wrongWorkflowPathStatement),
    ).toString("base64");
    assert.deepEqual(
      validateProvenanceAttestations(
        wrongWorkflowPathProvenance,
        publicManifest.name,
        publicManifest.version,
        hashes.integrity,
        commit,
      ),
      [
        "SLSA provenance does not bind the exact package archive to the expected repository workflow and source commit.",
      ],
      `accepted noncanonical workflow path ${path}`,
    );
  }
  const attestationUrl = metadata.versions[publicManifest.version].dist.attestations.url;
  const auditReport = {
    invalid: [],
    missing: [],
    verified: [
      {
        name: publicManifest.name,
        version: publicManifest.version,
        registry: "https://registry.npmjs.org/",
        attestations: {
          url: attestationUrl,
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    ],
  };
  assert.deepEqual(
    validateNpmAuditReport(
      auditReport,
      publicManifest.name,
      publicManifest.version,
      attestationUrl,
    ),
    [],
  );
  const wrongCommitStatement = JSON.parse(JSON.stringify(statement));
  wrongCommitStatement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
    "b".repeat(40);
  assert.notDeepEqual(
    validateProvenanceAttestations(
      {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payloadType: "application/vnd.in-toto+json",
                payload: Buffer.from(JSON.stringify(wrongCommitStatement)).toString("base64"),
              },
            },
          },
        ],
      },
      publicManifest.name,
      publicManifest.version,
      hashes.integrity,
      commit,
    ),
    [],
  );
  const wrongDigestStatement = JSON.parse(JSON.stringify(statement));
  wrongDigestStatement.subject[0].digest.sha512 = "0".repeat(128);
  assert.notDeepEqual(
    validateProvenanceAttestations(
      {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payloadType: "application/vnd.in-toto+json",
                payload: Buffer.from(JSON.stringify(wrongDigestStatement)).toString("base64"),
              },
            },
          },
        ],
      },
      publicManifest.name,
      publicManifest.version,
      hashes.integrity,
      commit,
    ),
    [],
  );
  assert.notDeepEqual(
    validateNpmAuditReport(
      { ...auditReport, invalid: [{ name: "synthetic-invalid-package" }] },
      publicManifest.name,
      publicManifest.version,
      attestationUrl,
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

test("polls immediately at a fixed gentle cadence within the bounded availability window", async () => {
  assert.equal(registryPollIntervalMilliseconds, 15_000);
  assert.equal(registryAvailabilityWindowMilliseconds, 18 * 60_000);

  let clock = 0;
  const inspectionTimes = [];
  const delays = [];
  const result = await waitForPublicationAvailability(
    async () => {
      inspectionTimes.push(clock);
      if (inspectionTimes.length < 3) throw new Error("publication is still processing");
      return "verified";
    },
    {
      availabilityWindowMilliseconds: 30_000,
      logger() {},
      now: () => clock,
      pollIntervalMilliseconds: 15_000,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
    },
  );
  assert.equal(result, "verified");
  assert.deepEqual(inspectionTimes, [0, 15_000, 30_000]);
  assert.deepEqual(delays, [15_000, 15_000]);

  clock = 0;
  let attempts = 0;
  await assert.rejects(
    waitForPublicationAvailability(
      async () => {
        attempts += 1;
        throw new Error("publication is still processing");
      },
      {
        availabilityWindowMilliseconds: 30_000,
        logger() {},
        now: () => clock,
        pollIntervalMilliseconds: 15_000,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    ),
    /did not become fully verifiable/u,
  );
  assert.equal(attempts, 3);
});
