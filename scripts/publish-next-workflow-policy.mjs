import { isDeepStrictEqual } from "node:util";

import { isAlias, isCollection, isScalar, parseDocument, visit } from "yaml";

const MAX_WORKFLOW_BYTES = 64 * 1024;
const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const pnpmSetupAction = "pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2";
const setupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const uploadArtifactAction = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const downloadArtifactAction = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
const repositoryGate =
  "github.repository == 'slicemedia/spaces-deployer' && github.event.repository.private == false && github.ref == 'refs/heads/main' && vars.SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED == 'true'";
const sourceProof =
  'test "$(git rev-parse --verify HEAD^{commit})" = "$GITHUB_SHA" && test "$(git ls-remote --exit-code origin refs/heads/main | awk \'{print $1}\')" = "$GITHUB_SHA" && test -z "$(git status --porcelain=v1 --untracked-files=all)"';
const npmInstall =
  "npm install --global npm@11.19.0 --ignore-scripts --registry https://registry.npmjs.org/ --userconfig /dev/null";
const npmVersionProof = 'test "$(npm --version)" = "11.19.0"';
const reviewedNpmPathProof =
  'set -euo pipefail\nnpm_global_prefix="$(npm prefix -g)"\nif [[ "$npm_global_prefix" != /* || "$npm_global_prefix" == *:* || "$npm_global_prefix" == *$\'\\n\'* || "$npm_global_prefix" == *$\'\\r\'* ]]; then\n  echo "npm global prefix is not a safe absolute PATH entry" >&2\n  exit 1\nfi\nnpm_global_bin="${npm_global_prefix%/}/bin"\nif [[ ! -d "$npm_global_bin" || ! -x "$npm_global_bin/npm" ]]; then\n  echo "reviewed npm executable was not found in the global npm bin directory" >&2\n  exit 1\nfi\nexport PATH="$npm_global_bin:$PATH"\nif [[ "$(command -v npm)" != "$npm_global_bin/npm" || "$(npm --version)" != "11.19.0" ]]; then\n  echo "reviewed npm 11.19.0 is not first on PATH" >&2\n  exit 1\nfi\nif [[ -z "${GITHUB_PATH:-}" || "$GITHUB_PATH" != /* || "$GITHUB_PATH" == *$\'\\n\'* || "$GITHUB_PATH" == *$\'\\r\'* ]]; then\n  echo "GITHUB_PATH is not a safe absolute command-file path" >&2\n  exit 1\nfi\nprintf \'%s\\n\' "$npm_global_bin" >> "$GITHUB_PATH"\n';
const publishSourceProof = `${sourceProof} && ${npmVersionProof}`;
const privateDenylistStep = {
  run: "node scripts/sanitize.mjs",
  env: {
    SLICEMEDIA_FORBIDDEN_TERMS: "${{ secrets.SLICEMEDIA_FORBIDDEN_TERMS }}",
    SLICEMEDIA_REQUIRE_FORBIDDEN_TERMS: "true",
  },
};

const checkoutStep = {
  uses: checkoutAction,
  with: { "fetch-depth": 0, "persist-credentials": false },
};

const expectedWorkflow = {
  name: "Publish npm prerelease",
  on: { workflow_dispatch: null },
  permissions: { contents: "none" },
  concurrency: {
    group: "spaces-deployer-publish-next",
    "cancel-in-progress": false,
  },
  jobs: {
    prepare: {
      if: repositoryGate,
      environment: "release-sanitize",
      "runs-on": "ubuntu-latest",
      permissions: { contents: "read" },
      steps: [
        checkoutStep,
        { run: sourceProof },
        privateDenylistStep,
        {
          uses: pnpmSetupAction,
          with: {
            version: "11.21.0",
            runtime: "node@24",
            cache: true,
            install: false,
          },
        },
        { run: npmInstall },
        {
          name: "Prefer reviewed npm CLI",
          shell: "bash",
          run: reviewedNpmPathProof,
        },
        { run: "pnpm install --frozen-lockfile" },
        { run: "pnpm check:quality" },
        { run: "pnpm build" },
        { run: "pnpm sanitize" },
        { run: "pnpm pack:check" },
        { run: "pnpm release:archive" },
        {
          run: "pnpm release:publish:check",
          env: {
            GITHUB_RELEASE_REF: "${{ github.ref }}",
            GITHUB_RELEASE_SHA: "${{ github.sha }}",
            GITHUB_REPOSITORY_VISIBILITY: "${{ github.event.repository.visibility }}",
            SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED: "${{ vars.SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED }}",
          },
        },
        {
          uses: uploadArtifactAction,
          with: {
            name: "npm-package-${{ github.sha }}",
            path: ".npm-release",
            "if-no-files-found": "error",
            "include-hidden-files": true,
            "retention-days": 1,
            "compression-level": 0,
          },
        },
      ],
    },
    publish: {
      needs: "prepare",
      if: `${repositoryGate} && needs.prepare.result == 'success'`,
      environment: "npm-next",
      "runs-on": "ubuntu-latest",
      permissions: { contents: "read", "id-token": "write" },
      steps: [
        checkoutStep,
        { run: sourceProof },
        {
          uses: setupNodeAction,
          with: { "node-version": 24, "check-latest": false },
        },
        { run: npmInstall },
        { run: npmVersionProof },
        {
          uses: downloadArtifactAction,
          with: {
            name: "npm-package-${{ github.sha }}",
            path: ".npm-release",
          },
        },
        {
          run: "node scripts/assert-npm-publication-artifact.mjs",
          env: {
            GITHUB_REPOSITORY_VISIBILITY: "${{ github.event.repository.visibility }}",
            SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED: "${{ vars.SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED }}",
            SLICEMEDIA_RELEASE_ENVIRONMENT: "npm-next",
          },
        },
        { run: publishSourceProof },
        {
          run: "npm publish .npm-release/package.tgz --ignore-scripts --tag next --access public --provenance --registry https://registry.npmjs.org/ --userconfig /dev/null",
        },
      ],
    },
    verify: {
      needs: ["prepare", "publish"],
      if: `${repositoryGate} && needs.prepare.result == 'success' && needs.publish.result == 'success'`,
      "runs-on": "ubuntu-latest",
      permissions: { contents: "read" },
      steps: [
        checkoutStep,
        { run: sourceProof },
        {
          uses: setupNodeAction,
          with: { "node-version": 24, "check-latest": false },
        },
        {
          uses: downloadArtifactAction,
          with: {
            name: "npm-package-${{ github.sha }}",
            path: ".npm-release",
          },
        },
        {
          run: "node scripts/verify-npm-publication.mjs",
          env: { GITHUB_RELEASE_SHA: "${{ github.sha }}" },
        },
      ],
    },
  },
};

export function validatePublishNextWorkflow(source) {
  const errors = [];
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return [`Publish workflow exceeds the ${MAX_WORKFLOW_BYTES}-byte review limit.`];
  }

  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  for (const error of document.errors) {
    errors.push(`Publish workflow YAML is invalid: ${error.message}`);
  }
  for (const warning of document.warnings) {
    errors.push(`Publish workflow YAML warning is not allowed: ${warning.message}`);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) return unique(errors);

  let containsAlias = false;
  let containsFlowCollection = false;
  const multilineScalars = [];
  let containsAnchorOrTag = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node)) containsAlias = true;
      if (isCollection(node) && node.flow === true) containsFlowCollection = true;
      if (
        isScalar(node) &&
        (node.type === "BLOCK_FOLDED" ||
          node.type === "BLOCK_LITERAL" ||
          (typeof node.source === "string" && /[\r\n]/u.test(node.source)))
      ) {
        multilineScalars.push(node);
      }
      if (("anchor" in node && node.anchor !== undefined) || node.tag !== undefined) {
        containsAnchorOrTag = true;
      }
    },
  });
  if (containsAlias) errors.push("Publish workflow YAML aliases are not allowed.");
  if (containsFlowCollection)
    errors.push("Publish workflow flow-style collections are not allowed.");
  if (
    multilineScalars.length !== 1 ||
    multilineScalars[0]?.type !== "BLOCK_LITERAL" ||
    multilineScalars[0]?.value !== reviewedNpmPathProof
  ) {
    errors.push(
      "Publish workflow block or multiline scalars must contain only the exact reviewed npm PATH proof.",
    );
  }
  if (containsAnchorOrTag) errors.push("Publish workflow YAML anchors and tags are not allowed.");

  try {
    const workflow = document.toJS({ maxAliasCount: 0 });
    if (!isDeepStrictEqual(workflow, expectedWorkflow)) {
      errors.push(
        "Publish workflow must match the reviewed prepare, minimal OIDC publish, and no-OIDC verification contracts exactly.",
      );
    }
  } catch (error) {
    errors.push(
      `Publish workflow YAML cannot be converted safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return unique(errors);
}

function unique(errors) {
  return [...new Set(errors)];
}
