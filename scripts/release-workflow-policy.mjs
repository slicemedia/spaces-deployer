import { isDeepStrictEqual } from "node:util";

import { isAlias, isCollection, isScalar, parseDocument, visit } from "yaml";

const MAX_WORKFLOW_BYTES = 64 * 1024;
const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const pnpmSetupAction = "pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2";
const changesetsVersionAction =
  "changesets/action/version@8488615a623b1b9c987934bb89eae8af6a946ac1";

const expectedWorkflow = {
  name: "Release PR",
  on: {
    push: { branches: ["main"] },
  },
  permissions: {
    contents: "none",
  },
  concurrency: {
    group: "spaces-deployer-release-pr",
    "cancel-in-progress": false,
  },
  jobs: {
    version: {
      if: "github.repository == 'slicemedia/spaces-deployer' && vars.SLICEMEDIA_RELEASE_PR_ENABLED == 'true'",
      environment: "release-sanitize",
      "runs-on": "ubuntu-latest",
      permissions: {
        contents: "write",
        "pull-requests": "write",
      },
      steps: [
        {
          uses: checkoutAction,
          with: {
            "fetch-depth": 0,
            "persist-credentials": false,
          },
        },
        {
          run: "node scripts/sanitize.mjs",
          env: {
            SLICEMEDIA_FORBIDDEN_TERMS: "${{ secrets.SLICEMEDIA_FORBIDDEN_TERMS }}",
            SLICEMEDIA_REQUIRE_FORBIDDEN_TERMS: "true",
          },
        },
        {
          uses: pnpmSetupAction,
          with: {
            version: "11.21.0",
            runtime: "node@22",
            cache: true,
            install: false,
          },
        },
        { run: "pnpm install --frozen-lockfile" },
        {
          run: "pnpm release:prepare:check",
          env: {
            GITHUB_REPOSITORY_VISIBILITY: "${{ github.event.repository.visibility }}",
          },
        },
        {
          uses: changesetsVersionAction,
          with: {
            script: "pnpm version-packages",
            "commit-message": "chore: version Spaces Deployer",
            "pr-title": "chore: version Spaces Deployer",
            "pr-draft": "create",
          },
        },
      ],
    },
  },
};

export function validateReleaseWorkflow(source) {
  const errors = [];
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return [`Version-PR workflow exceeds the ${MAX_WORKFLOW_BYTES}-byte review limit.`];
  }

  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  for (const error of document.errors) {
    errors.push(`Version-PR workflow YAML is invalid: ${error.message}`);
  }
  for (const warning of document.warnings) {
    errors.push(`Version-PR workflow YAML warning is not allowed: ${warning.message}`);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) return unique(errors);

  let containsAlias = false;
  let containsFlowCollection = false;
  let containsMultilineScalar = false;
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
        containsMultilineScalar = true;
      }
      if (("anchor" in node && node.anchor !== undefined) || node.tag !== undefined) {
        containsAnchorOrTag = true;
      }
    },
  });
  if (containsAlias) errors.push("Version-PR workflow YAML aliases are not allowed.");
  if (containsFlowCollection) {
    errors.push("Version-PR workflow flow-style collections are not allowed.");
  }
  if (containsMultilineScalar) {
    errors.push("Version-PR workflow block or multiline scalars are not allowed.");
  }
  if (containsAnchorOrTag) {
    errors.push("Version-PR workflow YAML anchors and tags are not allowed.");
  }

  try {
    const workflow = document.toJS({ maxAliasCount: 0 });
    if (!isDeepStrictEqual(workflow, expectedWorkflow)) {
      errors.push(
        "Version-PR workflow must match the reviewed trigger, permissions, concurrency, single job, and ordered step allowlist exactly.",
      );
    }
  } catch (error) {
    errors.push(
      `Version-PR workflow YAML cannot be converted safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return unique(errors);
}

function unique(errors) {
  return [...new Set(errors)];
}
