import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateReleaseWorkflow } from "./release-workflow-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = await readFile(
  resolve(repositoryRoot, ".github/workflows/release-pr.yml"),
  "utf8",
);
const changesetsStep =
  "      - uses: changesets/action/version@8488615a623b1b9c987934bb89eae8af6a946ac1 # v2.1.1";

test("accepts only the canonical version-PR workflow", () => {
  assert.deepEqual(validateReleaseWorkflow(workflow), []);
});

test("rejects block-style, flow-style, and reusable workflow additions", () => {
  expectRejected(
    beforeChangesets(
      "      - uses: actions/setup-node@1111111111111111111111111111111111111111",
      "      - run: echo unreviewed-step",
    ),
  );
  expectRejected(
    beforeChangesets(
      "      - { uses: actions/setup-node@1111111111111111111111111111111111111111 }",
      '      - { run: "echo unreviewed-flow-step" }',
    ),
  );
  expectRejected(
    `${workflow}\n  unexpected:\n    uses: example/release/.github/workflows/publish.yml@1111111111111111111111111111111111111111\n`,
  );
});

test("rejects flow collections and block or multiline command scalars", () => {
  expectRejected(workflow.replace("    branches:\n      - main", "    branches: [main]"));
  expectRejected(
    workflow.replace(
      "      - run: pnpm install --frozen-lockfile",
      "      - run: |-\n          pnpm install --frozen-lockfile",
    ),
  );
});

test("requires the activation variable and credential-free checkout", () => {
  expectRejected(workflow.replace(" && vars.SLICEMEDIA_RELEASE_PR_ENABLED == 'true'", ""));
  expectRejected(workflow.replace("environment: release-sanitize", "environment: production"));
  expectRejected(workflow.replace("persist-credentials: false", "persist-credentials: true"));
  expectRejected(workflow.replace("          persist-credentials: false\n", ""));
});

test("rejects changes to every reviewed workflow boundary", () => {
  const mutations = [
    (source) => source.replace("on:\n", "on:\n  workflow_dispatch:\n"),
    (source) => source.replace("      - main", "      - release"),
    (source) => source.replace("  contents: none", "  contents: read"),
    (source) => source.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    (source) => source.replace("      contents: write", "      contents: read"),
    (source) =>
      source.replace(
        "      - run: pnpm install --frozen-lockfile\n      - run: pnpm release:prepare:check",
        "      - run: pnpm release:prepare:check\n      - run: pnpm install --frozen-lockfile",
      ),
    (source) =>
      source.replace(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@1111111111111111111111111111111111111111",
      ),
    (source) => source.replace("          cache: true", "          cache: false"),
    (source) =>
      source.replace("${{ secrets.SLICEMEDIA_FORBIDDEN_TERMS }}", "${{ secrets.UNRELATED_VALUE }}"),
    (source) =>
      source.replace(
        "${{ github.event.repository.visibility }}",
        "${{ vars.REPOSITORY_VISIBILITY }}",
      ),
    (source) =>
      source.replace(
        "          script: pnpm version-packages",
        "          version-script: pnpm version-packages",
      ),
    (source) => source.replace("  contents: none", "  id-token: write"),
    (source) =>
      source.replace(
        "      - run: pnpm install --frozen-lockfile",
        "      - run: pnpm install --frozen-lockfile\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      ),
  ];
  for (const mutate of mutations) expectRejected(mutate(workflow));
});

function beforeChangesets(...lines) {
  return workflow.replace(changesetsStep, `${lines.join("\n")}\n${changesetsStep}`);
}

function expectRejected(source) {
  assert.notDeepEqual(validateReleaseWorkflow(source), []);
}
