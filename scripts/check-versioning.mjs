import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function validateSharedVersionConfiguration({ changesets, packageManifest } = {}) {
  const errors = [];
  const reviewedChangesets = changesets ?? {};
  const reviewedManifest = packageManifest ?? {};

  if (reviewedManifest.name !== "@slicemedia/spaces-deployer") {
    errors.push("Package name must remain @slicemedia/spaces-deployer.");
  }
  if (
    typeof reviewedManifest.version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      reviewedManifest.version,
    )
  ) {
    errors.push("Package version must be a valid exact semantic version.");
  }
  if (reviewedChangesets.$schema !== "https://unpkg.com/@changesets/config@4.0.0/schema.json") {
    errors.push("Changesets must use the reviewed v4 configuration schema.");
  }
  if (reviewedChangesets.baseBranch !== "main" || reviewedChangesets.access !== "public") {
    errors.push("Changesets must target main and preserve future public-package access metadata.");
  }
  if (
    reviewedChangesets.privatePackages?.version !== true ||
    reviewedChangesets.privatePackages?.tag !== false
  ) {
    errors.push("Changesets must version, but never tag, the private package.");
  }
  if (!Array.isArray(reviewedChangesets.ignore) || reviewedChangesets.ignore.length !== 0) {
    errors.push("The Spaces Deployer package must not be ignored by Changesets.");
  }
  return errors;
}

export function validatePrivateVersionConfiguration({ changesets, packageManifest } = {}) {
  const errors = validateSharedVersionConfiguration({ changesets, packageManifest });
  if (packageManifest?.private !== true) {
    errors.push("The package must remain private during release preparation.");
  }
  return errors;
}

async function main() {
  const packageManifest = await readJson("package.json");
  const changesets = await readJson(".changeset/config.json");
  const errors = validatePrivateVersionConfiguration({ changesets, packageManifest });

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.info(`Version configuration passed for Spaces Deployer ${packageManifest.version}.`);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(workspaceRoot, relativePath), "utf8"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
