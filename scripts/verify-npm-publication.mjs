import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = resolve(repositoryRoot, ".npm-release/package.tgz");
const receiptPath = resolve(repositoryRoot, ".npm-release/receipt.json");
const maximumAttempts = 8;

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const archive = await readFile(archivePath);
  const hashes = {
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    shasum: createHash("sha1").update(archive).digest("hex"),
  };
  const receiptErrors = validatePublicationReceipt(
    receipt,
    manifest,
    hashes,
    process.env.GITHUB_RELEASE_SHA,
  );
  if (receiptErrors.length > 0) throw new Error(receiptErrors.join(" "));

  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await globalThis.fetch(registryUrl, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
      const metadata = await response.json();
      const errors = validateRegistryMetadata(
        metadata,
        manifest.name,
        manifest.version,
        receipt.integrity,
        receipt.shasum,
      );
      if (errors.length > 0) throw new Error(errors.join(" "));
      console.info(
        `Verified ${manifest.name}@${manifest.version}: npm integrity matches the exact local archive and next dist-tag.`,
      );
      break;
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
      await setTimeout(attempt * 2_000);
    }
  }
}

export function validatePublicationReceipt(receipt, manifest, hashes, expectedCommit) {
  const errors = [];
  const expectedKeys = [
    "archive",
    "integrity",
    "name",
    "npmVersion",
    "schemaVersion",
    "shasum",
    "sourceCommit",
    "version",
  ];
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
  ) {
    errors.push("Publication receipt does not match schema 1 exactly.");
    return errors;
  }
  if (receipt.schemaVersion !== 1) errors.push("Publication receipt has an unexpected schema.");
  if (receipt.npmVersion !== "11.19.0") {
    errors.push("Publication receipt was not prepared with npm 11.19.0.");
  }
  if (receipt.name !== manifest.name || receipt.version !== manifest.version) {
    errors.push("Publication receipt package identity does not match the manifest.");
  }
  if (receipt.archive !== ".npm-release/package.tgz") {
    errors.push("Publication receipt does not reference the fixed release archive.");
  }
  if (receipt.integrity !== hashes.integrity || receipt.shasum !== hashes.shasum) {
    errors.push("Publication receipt does not match the exact local archive.");
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit ?? "") || receipt.sourceCommit !== expectedCommit) {
    errors.push("Publication receipt is not bound to GITHUB_RELEASE_SHA.");
  }
  return errors;
}

export function validateRegistryMetadata(
  metadata,
  expectedName,
  expectedVersion,
  expectedIntegrity,
  expectedShasum,
) {
  const errors = [];
  if (metadata?.name !== expectedName) errors.push("Registry package name does not match.");
  const published = metadata?.versions?.[expectedVersion];
  if (published?.name !== expectedName || published?.version !== expectedVersion) {
    errors.push("Registry does not contain the exact published package version.");
  }
  if (published?.dist?.integrity !== expectedIntegrity) {
    errors.push("Registry integrity does not match the exact local archive.");
  }
  if (published?.dist?.shasum !== expectedShasum) {
    errors.push("Registry shasum does not match the exact local archive.");
  }
  if (
    typeof published?.dist?.tarball !== "string" ||
    !published.dist.tarball.startsWith("https://")
  ) {
    errors.push("Registry metadata is missing a secure tarball URL.");
  }
  if (metadata?.["dist-tags"]?.next !== expectedVersion) {
    errors.push("The npm next dist-tag does not reference the published version.");
  }
  return errors;
}
