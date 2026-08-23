import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = resolve(repositoryRoot, ".npm-release/package.tgz");
const receiptPath = resolve(repositoryRoot, ".npm-release/receipt.json");
const executeFile = promisify(execFile);
const npmRegistry = "https://registry.npmjs.org/";
const expectedRepository = "https://github.com/slicemedia/spaces-deployer";
const expectedWorkflowPath = "/.github/workflows/publish-next.yml";
const expectedSourceReference = "refs/heads/main";
const slsaProvenancePredicate = "https://slsa.dev/provenance/v1";
const slsaGitHubWorkflowBuildType =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const registryRequestTimeoutMilliseconds = 30_000;
const npmCommandTimeoutMilliseconds = 60_000;

export const registryPollIntervalMilliseconds = 15_000;
export const registryAvailabilityWindowMilliseconds = 18 * 60_000;

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

  await waitForPublicationAvailability(async () => {
    const registryUrl = `${npmRegistry}${encodeURIComponent(manifest.name)}`;
    const metadata = await fetchRegistryJson(registryUrl, "registry package metadata");
    const metadataErrors = validateRegistryMetadata(
      metadata,
      manifest.name,
      manifest.version,
      receipt.integrity,
      receipt.shasum,
    );
    if (metadataErrors.length > 0) throw new Error(metadataErrors.join(" "));

    const attestationUrl = metadata.versions[manifest.version].dist.attestations.url;
    const attestationDocument = await fetchRegistryJson(
      attestationUrl,
      "registry provenance attestations",
    );
    const provenanceErrors = validateProvenanceAttestations(
      attestationDocument,
      manifest.name,
      manifest.version,
      receipt.integrity,
      receipt.sourceCommit,
    );
    if (provenanceErrors.length > 0) throw new Error(provenanceErrors.join(" "));

    const auditReport = await auditPublishedPackage(manifest.name, manifest.version);
    const auditErrors = validateNpmAuditReport(
      auditReport,
      manifest.name,
      manifest.version,
      attestationUrl,
    );
    if (auditErrors.length > 0) throw new Error(auditErrors.join(" "));
  });

  console.info(
    `Verified ${manifest.name}@${manifest.version}: npm integrity, signed provenance, source commit, and next dist-tag match the exact local archive.`,
  );
}

export async function waitForPublicationAvailability(
  inspectPublication,
  {
    availabilityWindowMilliseconds = registryAvailabilityWindowMilliseconds,
    logger = console.info,
    now = Date.now,
    pollIntervalMilliseconds = registryPollIntervalMilliseconds,
    sleep = sleepFor,
  } = {},
) {
  const maximumAttempts = Math.floor(availabilityWindowMilliseconds / pollIntervalMilliseconds) + 1;
  const deadline = now() + availabilityWindowMilliseconds;
  let lastError;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await inspectPublication();
    } catch (error) {
      lastError = error;
      const remainingMilliseconds = deadline - now();
      if (attempt === maximumAttempts || remainingMilliseconds <= 0) break;
      const delay = Math.min(pollIntervalMilliseconds, remainingMilliseconds);
      logger(
        `npm is still processing the publication; retrying registry and provenance verification in ${Math.ceil(delay / 1_000)} seconds (attempt ${attempt}/${maximumAttempts}).`,
      );
      await sleep(delay);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `npm publication did not become fully verifiable within 18 minutes. Last verification failure: ${reason}`,
  );
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
  if (published?.dist?.attestations?.provenance?.predicateType !== slsaProvenancePredicate) {
    errors.push("Registry metadata is missing SLSA provenance.");
  }
  if (!isExactAttestationUrl(published?.dist?.attestations?.url, expectedName, expectedVersion)) {
    errors.push("Registry metadata has an unexpected provenance attestation URL.");
  }
  if (metadata?.["dist-tags"]?.next !== expectedVersion) {
    errors.push("The npm next dist-tag does not reference the published version.");
  }
  return errors;
}

export function validateProvenanceAttestations(
  document,
  expectedName,
  expectedVersion,
  expectedIntegrity,
  expectedCommit,
) {
  if (!Array.isArray(document?.attestations)) {
    return ["Registry provenance response does not contain attestations."];
  }
  const expectedSha512 = integrityToSha512Hex(expectedIntegrity);
  if (expectedSha512 === undefined) {
    return ["Expected npm integrity is not a canonical SHA-512 value."];
  }

  const candidates = document.attestations.filter(
    (attestation) => attestation?.predicateType === slsaProvenancePredicate,
  );
  if (candidates.length === 0) return ["Registry response is missing the SLSA provenance bundle."];

  for (const candidate of candidates) {
    const statement = decodeDsseStatement(candidate?.bundle?.dsseEnvelope);
    if (
      statement !== undefined &&
      validateSlsaStatement(
        statement,
        expectedName,
        expectedVersion,
        expectedSha512,
        expectedCommit,
      ).length === 0
    ) {
      return [];
    }
  }
  return [
    "SLSA provenance does not bind the exact package archive to the expected repository workflow and source commit.",
  ];
}

export function validateNpmAuditReport(
  report,
  expectedName,
  expectedVersion,
  expectedAttestationUrl,
) {
  const errors = [];
  if (!Array.isArray(report?.invalid) || !Array.isArray(report?.verified)) {
    return ["npm signature audit did not return its reviewed JSON schema."];
  }
  if (report.invalid.length > 0) errors.push("npm signature audit found an invalid package.");
  const target = report.verified.find(
    (entry) => entry?.name === expectedName && entry?.version === expectedVersion,
  );
  if (target === undefined) {
    errors.push("npm signature audit did not verify the exact published package.");
    return errors;
  }
  if (target.registry !== npmRegistry) {
    errors.push("npm signature audit used an unexpected registry.");
  }
  if (
    target?.attestations?.url !== expectedAttestationUrl ||
    target?.attestations?.provenance?.predicateType !== slsaProvenancePredicate
  ) {
    errors.push("npm signature audit did not cryptographically verify the expected provenance.");
  }
  return errors;
}

async function fetchRegistryJson(url, description) {
  const response = await globalThis.fetch(url, {
    headers: { accept: "application/json" },
    signal: globalThis.AbortSignal.timeout(registryRequestTimeoutMilliseconds),
  });
  if (!response.ok) throw new Error(`${description} returned HTTP ${response.status}`);
  return response.json();
}

async function auditPublishedPackage(name, version) {
  const auditDirectory = await mkdtemp(join(tmpdir(), "slicemedia-spaces-npm-audit-"));
  const environment = npmAuditEnvironment();
  try {
    await writeFile(
      join(auditDirectory, "package.json"),
      `${JSON.stringify({ name: "slicemedia-publication-audit", private: true, version: "0.0.0" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const versionResult = await runNpm(["--version"], auditDirectory, environment);
    if (versionResult.stdout.trim() !== "11.19.0") {
      throw new Error("Provenance verification requires the reviewed npm 11.19.0 CLI.");
    }
    try {
      await runNpm(
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          `${name}@${version}`,
          "--registry",
          npmRegistry,
          "--userconfig",
          "/dev/null",
        ],
        auditDirectory,
        environment,
      );
    } catch {
      throw new Error("npm could not install the exact package for provenance verification.");
    }

    let output;
    try {
      const result = await runNpm(
        [
          "audit",
          "signatures",
          "--json",
          "--include-attestations",
          "--registry",
          npmRegistry,
          "--userconfig",
          "/dev/null",
        ],
        auditDirectory,
        environment,
      );
      output = result.stdout;
    } catch (error) {
      output = typeof error?.stdout === "string" ? error.stdout : undefined;
      if (output === undefined) {
        throw new Error("npm could not complete cryptographic provenance verification.", {
          cause: error,
        });
      }
    }
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("npm signature audit did not return valid JSON.");
    }
  } finally {
    await rm(auditDirectory, { force: true, recursive: true });
  }
}

function runNpm(arguments_, cwd, environment) {
  return executeFile("npm", arguments_, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout: npmCommandTimeoutMilliseconds,
  });
}

function npmAuditEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/iu.test(name) || /^npm_config_.*auth/iu.test(name)) {
      delete environment[name];
    }
  }
  environment.NPM_CONFIG_REGISTRY = npmRegistry;
  environment.NPM_CONFIG_USERCONFIG = "/dev/null";
  return environment;
}

function isExactAttestationUrl(value, expectedName, expectedVersion) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const prefix = "/-/npm/v1/attestations/";
  if (
    url.origin !== "https://registry.npmjs.org" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(prefix)
  ) {
    return false;
  }
  const identity = url.pathname.slice(prefix.length);
  const separator = identity.lastIndexOf("@");
  if (separator <= 0) return false;
  try {
    return (
      decodeURIComponent(identity.slice(0, separator)) === expectedName &&
      decodeURIComponent(identity.slice(separator + 1)) === expectedVersion
    );
  } catch {
    return false;
  }
}

function integrityToSha512Hex(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return undefined;
  const encoded = integrity.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.byteLength !== 64 || digest.toString("base64") !== encoded) return undefined;
  return digest.toString("hex");
}

function decodeDsseStatement(envelope) {
  if (
    envelope?.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope?.payload !== "string"
  ) {
    return undefined;
  }
  try {
    const payload = Buffer.from(envelope.payload, "base64");
    if (payload.toString("base64") !== envelope.payload) return undefined;
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return undefined;
  }
}

function validateSlsaStatement(
  statement,
  expectedName,
  expectedVersion,
  expectedSha512,
  expectedCommit,
) {
  const errors = [];
  const expectedPurl = `pkg:npm/${encodeURIComponent(expectedName).replaceAll("%2F", "/")}@${encodeURIComponent(expectedVersion)}`;
  if (statement?._type !== "https://in-toto.io/Statement/v1") {
    errors.push("Provenance has an unexpected in-toto statement type.");
  }
  if (statement?.predicateType !== slsaProvenancePredicate) {
    errors.push("Provenance has an unexpected predicate type.");
  }
  if (
    !Array.isArray(statement?.subject) ||
    statement.subject.length !== 1 ||
    statement.subject[0]?.name !== expectedPurl ||
    statement.subject[0]?.digest?.sha512 !== expectedSha512
  ) {
    errors.push("Provenance subject does not match the exact npm archive.");
  }

  const buildDefinition = statement?.predicate?.buildDefinition;
  const workflow = buildDefinition?.externalParameters?.workflow;
  if (buildDefinition?.buildType !== slsaGitHubWorkflowBuildType) {
    errors.push("Provenance has an unexpected GitHub Actions build type.");
  }
  if (
    workflow?.repository !== expectedRepository ||
    workflow?.path !== expectedWorkflowPath ||
    workflow?.ref !== expectedSourceReference
  ) {
    errors.push("Provenance does not identify the reviewed publication workflow.");
  }
  const sourceDependency = buildDefinition?.resolvedDependencies?.find(
    (dependency) =>
      dependency?.uri === `git+${expectedRepository}@${expectedSourceReference}` &&
      dependency?.digest?.gitCommit === expectedCommit,
  );
  if (sourceDependency === undefined) {
    errors.push("Provenance does not identify the exact release source commit.");
  }
  return errors;
}
