import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateReleaseWorkflow } from "./release-workflow-policy.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRepository = "slicemedia/spaces-deployer";
const prohibitedCredentialVariables = ["NODE_AUTH_TOKEN", "NPM_TOKEN"];

const errors = [];
const visibility = process.env.GITHUB_REPOSITORY_VISIBILITY;
if (visibility !== "private" && visibility !== "public") {
  errors.push(
    `Release preparation requires an explicit private or public repository visibility; received ${JSON.stringify(visibility)}.`,
  );
}
if (process.env.GITHUB_REPOSITORY !== expectedRepository) {
  errors.push(`Release preparation is restricted to ${expectedRepository}.`);
}
for (const variable of prohibitedCredentialVariables) {
  if (process.env[variable]?.trim()) {
    errors.push(`${variable} must not be available to the version-PR workflow.`);
  }
}

const packageManifest = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
if (packageManifest.name !== "@slicemedia/spaces-deployer") {
  errors.push("Release preparation found an unexpected package name.");
}
const workflow = await readFile(resolve(workspaceRoot, ".github/workflows/release-pr.yml"), "utf8");
errors.push(...validateReleaseWorkflow(workflow));

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Version-PR release preparation is fail-closed; npm publication is disabled.");
}
