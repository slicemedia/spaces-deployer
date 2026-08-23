import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";

import {
  GetBucketVersioningCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  SpacesDeploymentError,
  type ApplyDeploymentPlanOptions,
  type CreateDeploymentPlanOptions,
  type SpacesCredentials,
  type SpacesDeploymentFile,
  type SpacesDeploymentFileReceipt,
  type SpacesDeploymentLimits,
  type SpacesDeploymentPlan,
  type SpacesDeploymentReceipt,
  type SpacesDeploymentTarget,
} from "./types.js";

export const SPACES_DEPLOYMENT_LIMITS: SpacesDeploymentLimits = Object.freeze({
  maxFiles: 1_000,
  maxEntries: 1_500,
  maxDirectories: 1_000,
  maxDepth: 32,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

interface FileMetadata {
  readonly relativePath: string;
  readonly size: number;
  readonly sha384: string;
  readonly contentType: string;
}

type RemoteFileDecision =
  | { readonly action: "upload" }
  | { readonly action: "skip"; readonly etag?: string; readonly versionId: string };

export async function createDeploymentPlan(
  options: CreateDeploymentPlanOptions,
): Promise<SpacesDeploymentPlan> {
  const sourceDirectory = path.resolve(options.directory);
  const target = normalizeTarget(options);
  const releaseVersion = validateReleaseVersion(options.releaseVersion);
  const relativePaths = await listFiles(sourceDirectory);
  if (relativePaths.length === 0) {
    throw new Error("Deployment directory contains no files.");
  }

  assertFileCount(relativePaths.length);
  const expectedSizes: number[] = [];
  let inspectedTotalBytes = 0;
  for (const relativePath of relativePaths) {
    const size = await inspectSourceFile(sourceDirectory, relativePath);
    inspectedTotalBytes += size;
    assertTotalSize(inspectedTotalBytes);
    expectedSizes.push(size);
  }

  const metadata: FileMetadata[] = [];
  let totalBytes = 0;
  for (const [index, relativePath] of relativePaths.entries()) {
    const contents = await readSourceFile(sourceDirectory, relativePath);
    if (contents.byteLength !== expectedSizes[index]) {
      throw new Error(`Deployment source changed while planning: ${relativePath}`);
    }
    assertFileSize(contents.byteLength, relativePath);
    totalBytes += contents.byteLength;
    assertTotalSize(totalBytes);
    metadata.push({
      relativePath,
      size: contents.byteLength,
      sha384: integrity(contents),
      contentType: contentType(relativePath),
    });
  }
  const artifactSetDigest = calculateArtifactSetDigest(metadata);
  const files: SpacesDeploymentFile[] = metadata.map((file) => ({
    ...file,
    key: objectKey(target.prefix, releaseVersion, artifactSetDigest, file.relativePath),
  }));
  const unsignedPlan = {
    schemaVersion: 2 as const,
    sourceDirectory,
    target,
    releaseVersion,
    artifactSetDigest,
    files,
  };
  return { ...unsignedPlan, planId: calculatePlanId(unsignedPlan) };
}

export async function applyDeploymentPlan(
  plan: SpacesDeploymentPlan,
  options: ApplyDeploymentPlanOptions,
): Promise<SpacesDeploymentReceipt> {
  const validatedPlan = validatePlan(plan);
  if (options.confirmedPlanId !== validatedPlan.planId) {
    throw new Error("confirmedPlanId must exactly match the deployment plan ID.");
  }
  const credentials = validateCredentials(options.credentials);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const contents = await preflightContents(validatedPlan);
  const client =
    options.client ??
    new S3Client({
      endpoint: validatedPlan.target.endpoint,
      region: validatedPlan.target.region,
      credentials,
      forcePathStyle: false,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

  await assertBucketVersioning(client, validatedPlan, timestamp, credentials);
  const decisions = await preflightRemoteFiles(client, validatedPlan, timestamp, credentials);
  const receipts: SpacesDeploymentFileReceipt[] = [];

  for (const [index, file] of validatedPlan.files.entries()) {
    const decision = decisions[index];
    if (decision === undefined) {
      failDeployment(
        validatedPlan,
        timestamp,
        `Missing remote preflight decision for ${file.relativePath}.`,
        receipts,
      );
    }
    if (decision.action === "skip") {
      receipts.push({
        key: file.key,
        status: "skipped",
        ...(decision.etag === undefined ? {} : { etag: decision.etag }),
        versionId: decision.versionId,
      });
      continue;
    }

    const body = contents[index];
    if (body === undefined) {
      failDeployment(
        validatedPlan,
        timestamp,
        `Missing preflight contents for ${file.relativePath}.`,
        receipts,
      );
    }
    let response;
    try {
      response = await client.send(
        new PutObjectCommand({
          Bucket: validatedPlan.target.bucket,
          Key: file.key,
          Body: body,
          ContentLength: file.size,
          ContentType: file.contentType,
          CacheControl: IMMUTABLE_CACHE_CONTROL,
          Metadata: {
            sha384: file.sha384,
            "artifact-set-digest": validatedPlan.artifactSetDigest,
          },
        }),
      );
    } catch (error) {
      const errorMessage = redactError(
        error,
        credentials,
        deploymentSensitiveValues(validatedPlan, file),
      );
      const failed = [
        ...receipts,
        { key: file.key, status: "failed" as const, error: errorMessage },
      ];
      failDeployment(validatedPlan, timestamp, `Versioned upload failed: ${errorMessage}`, failed);
    }

    const versionId = response.VersionId;
    if (versionId === undefined || versionId.trim() === "") {
      failDeployment(
        validatedPlan,
        timestamp,
        "DigitalOcean Spaces did not return a version ID for the uploaded object.",
        [
          ...receipts,
          {
            key: file.key,
            status: "failed",
            ...(response.ETag === undefined ? {} : { etag: response.ETag }),
            error: "missing-upload-version-id",
          },
        ],
      );
    }
    await verifyUploadedFile(
      client,
      validatedPlan,
      file,
      versionId,
      response.ETag,
      timestamp,
      credentials,
      receipts,
    );
    receipts.push({
      key: file.key,
      status: "uploaded",
      ...(response.ETag === undefined ? {} : { etag: response.ETag }),
      versionId,
    });
  }

  return deploymentReceipt(validatedPlan, timestamp, "applied", receipts);
}

async function verifyUploadedFile(
  client: S3Client,
  plan: SpacesDeploymentPlan,
  file: SpacesDeploymentFile,
  versionId: string,
  etag: string | undefined,
  timestamp: string,
  credentials: SpacesCredentials,
  completedReceipts: readonly SpacesDeploymentFileReceipt[],
): Promise<void> {
  let response;
  try {
    response = await client.send(
      new HeadObjectCommand({
        Bucket: plan.target.bucket,
        Key: file.key,
        VersionId: versionId,
      }),
    );
  } catch (error) {
    const errorMessage = redactError(error, credentials, deploymentSensitiveValues(plan, file));
    failDeployment(plan, timestamp, `Cannot verify uploaded object version: ${errorMessage}`, [
      ...completedReceipts,
      {
        key: file.key,
        status: "failed",
        ...(etag === undefined ? {} : { etag }),
        versionId,
        error: `post-upload-verification-error: ${errorMessage}`,
      },
    ]);
  }

  if (!remoteFileMatches(response, plan, file) || response.VersionId !== versionId) {
    failDeployment(
      plan,
      timestamp,
      "Uploaded object version did not read back with the planned metadata.",
      [
        ...completedReceipts,
        {
          key: file.key,
          status: "failed",
          ...(etag === undefined ? {} : { etag }),
          versionId,
          error: "post-upload-verification-mismatch",
        },
      ],
    );
  }
}

async function assertBucketVersioning(
  client: S3Client,
  plan: SpacesDeploymentPlan,
  timestamp: string,
  credentials: SpacesCredentials,
): Promise<void> {
  let status: string | undefined;
  try {
    const response = await client.send(
      new GetBucketVersioningCommand({ Bucket: plan.target.bucket }),
    );
    status = response.Status;
  } catch (error) {
    failDeployment(
      plan,
      timestamp,
      `Cannot verify mandatory bucket versioning: ${redactError(
        error,
        credentials,
        deploymentSensitiveValues(plan),
      )}`,
      [],
    );
  }
  if (status !== "Enabled") {
    failDeployment(
      plan,
      timestamp,
      "DigitalOcean Spaces bucket versioning must be Enabled before deployment.",
      [],
    );
  }
}

async function preflightRemoteFiles(
  client: S3Client,
  plan: SpacesDeploymentPlan,
  timestamp: string,
  credentials: SpacesCredentials,
): Promise<readonly RemoteFileDecision[]> {
  const decisions: RemoteFileDecision[] = [];
  for (const file of plan.files) {
    try {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: plan.target.bucket, Key: file.key }),
      );
      if (!remoteFileMatches(response, plan, file)) {
        failDeployment(
          plan,
          timestamp,
          "An object key is occupied by content that does not match the plan.",
          [{ key: file.key, status: "failed", error: "occupied-content-mismatch" }],
        );
      }
      const versionId = response.VersionId;
      if (versionId === undefined || versionId.trim() === "") {
        failDeployment(
          plan,
          timestamp,
          "A matching object did not include an immutable version ID.",
          [{ key: file.key, status: "failed", error: "existing-object-missing-version-id" }],
        );
      }
      decisions.push({
        action: "skip",
        ...(response.ETag === undefined ? {} : { etag: response.ETag }),
        versionId,
      });
    } catch (error) {
      if (error instanceof SpacesDeploymentError) throw error;
      if (isUnambiguousNotFound(error)) {
        decisions.push({ action: "upload" });
        continue;
      }
      failDeployment(
        plan,
        timestamp,
        `Cannot determine whether an object key is available: ${redactError(
          error,
          credentials,
          deploymentSensitiveValues(plan, file),
        )}`,
        [{ key: file.key, status: "failed", error: "remote-preflight-ambiguous" }],
      );
    }
  }
  return decisions;
}

function remoteFileMatches(
  response: {
    readonly CacheControl?: string | undefined;
    readonly ContentLength?: number | undefined;
    readonly ContentType?: string | undefined;
    readonly Metadata?: Readonly<Record<string, string>> | undefined;
  },
  plan: SpacesDeploymentPlan,
  file: SpacesDeploymentFile,
): boolean {
  return (
    response.ContentLength === file.size &&
    response.ContentType === file.contentType &&
    response.CacheControl === IMMUTABLE_CACHE_CONTROL &&
    response.Metadata?.sha384 === file.sha384 &&
    response.Metadata["artifact-set-digest"] === plan.artifactSetDigest
  );
}

function deploymentReceipt(
  plan: SpacesDeploymentPlan,
  timestamp: string,
  status: SpacesDeploymentReceipt["status"],
  files: readonly SpacesDeploymentFileReceipt[],
): SpacesDeploymentReceipt {
  return {
    schemaVersion: 2,
    operation: "slicemedia.spaces-deployer.deploy",
    status,
    planId: plan.planId,
    target: plan.target,
    releaseVersion: plan.releaseVersion,
    artifactSetDigest: plan.artifactSetDigest,
    timestamp,
    files: [...files],
  };
}

function failDeployment(
  plan: SpacesDeploymentPlan,
  timestamp: string,
  message: string,
  files: readonly SpacesDeploymentFileReceipt[],
): never {
  // Provider errors are reduced to redacted strings before reaching this boundary.
  throw new SpacesDeploymentError(message, deploymentReceipt(plan, timestamp, "failed", files));
}

async function preflightContents(plan: SpacesDeploymentPlan): Promise<readonly Uint8Array[]> {
  const preflighted: Uint8Array[] = [];
  let totalBytes = 0;
  for (const file of plan.files) {
    const contents = await readSourceFile(plan.sourceDirectory, file.relativePath);
    totalBytes += contents.byteLength;
    assertTotalSize(totalBytes);
    if (contents.byteLength !== file.size || integrity(contents) !== file.sha384) {
      throw new Error(`Source file changed after planning: ${file.relativePath}`);
    }
    preflighted.push(contents);
  }
  return preflighted;
}

function validatePlan(input: SpacesDeploymentPlan): SpacesDeploymentPlan {
  const plan = exactRecord(
    input,
    [
      "artifactSetDigest",
      "files",
      "planId",
      "releaseVersion",
      "schemaVersion",
      "sourceDirectory",
      "target",
    ],
    "deployment plan",
  );
  if (plan.schemaVersion !== 2) throw new Error("Unsupported Spaces deployment plan schema.");

  const planId = stringField(plan, "planId", "deployment plan");
  const sourceDirectory = stringField(plan, "sourceDirectory", "deployment plan");
  if (path.resolve(sourceDirectory) !== sourceDirectory) {
    throw new Error("Deployment plan sourceDirectory must be an absolute normalized path.");
  }

  const inputTarget = exactRecord(
    plan.target,
    ["bucket", "endpoint", "prefix", "region"],
    "deployment target",
  );
  const targetValues = {
    endpoint: stringField(inputTarget, "endpoint", "deployment target"),
    region: stringField(inputTarget, "region", "deployment target"),
    bucket: stringField(inputTarget, "bucket", "deployment target"),
    prefix: stringField(inputTarget, "prefix", "deployment target"),
  };
  const target = normalizeTarget(targetValues);
  if (
    target.endpoint !== targetValues.endpoint ||
    target.region !== targetValues.region ||
    target.bucket !== targetValues.bucket ||
    target.prefix !== targetValues.prefix
  ) {
    throw new Error("Deployment plan target must contain exact canonical values.");
  }

  const inputReleaseVersion = stringField(plan, "releaseVersion", "deployment plan");
  const releaseVersion = validateReleaseVersion(inputReleaseVersion);
  if (releaseVersion !== inputReleaseVersion) {
    throw new Error("Deployment plan releaseVersion must be canonical.");
  }
  const artifactSetDigest = stringField(plan, "artifactSetDigest", "deployment plan");
  if (!/^sha256-[a-f0-9]{64}$/u.test(artifactSetDigest)) {
    throw new Error("Deployment plan contains an invalid artifact-set digest.");
  }

  if (!Array.isArray(plan.files)) throw new Error("Deployment plan files must be an array.");
  assertFileCount(plan.files.length);
  let totalBytes = 0;
  const files: SpacesDeploymentFile[] = plan.files.map((inputFile, index) => {
    const file = exactRecord(
      inputFile,
      ["contentType", "key", "relativePath", "sha384", "size"],
      `deployment plan file ${index}`,
    );
    const relativePathValue = stringField(file, "relativePath", `deployment plan file ${index}`);
    const relativePath = normalizeRelativePath(relativePathValue);
    if (relativePath !== relativePathValue) {
      throw new Error(`Deployment plan contains a noncanonical path: ${relativePathValue}`);
    }
    const key = stringField(file, "key", `deployment plan file ${index}`);
    const size = file.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Deployment plan contains an invalid file size: ${relativePath}`);
    }
    assertFileSize(size, relativePath);
    totalBytes += size;
    assertTotalSize(totalBytes);
    const sha384 = stringField(file, "sha384", `deployment plan file ${index}`);
    if (!/^sha384-[A-Za-z0-9+/]{64}$/u.test(sha384)) {
      throw new Error(`Deployment plan contains an invalid SHA-384 digest: ${relativePath}`);
    }
    const fileContentType = stringField(file, "contentType", `deployment plan file ${index}`);
    if (fileContentType !== contentType(relativePath)) {
      throw new Error(`Deployment plan contains an invalid content type: ${relativePath}`);
    }
    return { relativePath, key, size, sha384, contentType: fileContentType };
  });

  assertSortedUniqueDeploymentPaths(files.map((file) => file.relativePath));
  const seenKeys = new Set<string>();
  for (const file of files) {
    const { relativePath } = file;
    if (seenKeys.has(file.key)) throw new Error("Deployment plan contains duplicate object keys.");
    if (file.key !== objectKey(target.prefix, releaseVersion, artifactSetDigest, relativePath)) {
      throw new Error("Deployment plan contains an unexpected object key.");
    }
    seenKeys.add(file.key);
  }
  if (files.length === 0) throw new Error("Deployment plan contains no files.");
  const calculatedArtifactSetDigest = calculateArtifactSetDigest(files);
  if (artifactSetDigest !== calculatedArtifactSetDigest) {
    throw new Error("Deployment artifact-set digest does not match its files.");
  }
  const expected = calculatePlanId({
    schemaVersion: 2,
    sourceDirectory,
    target,
    releaseVersion,
    artifactSetDigest,
    files,
  });
  if (planId !== expected) throw new Error("Deployment plan ID does not match its contents.");
  return {
    schemaVersion: 2,
    planId,
    sourceDirectory,
    target,
    releaseVersion,
    artifactSetDigest,
    files,
  };
}

function calculateArtifactSetDigest(files: readonly FileMetadata[]): string {
  const canonical = JSON.stringify(
    files.map((file) => ({
      relativePath: file.relativePath,
      size: file.size,
      sha384: file.sha384,
      contentType: file.contentType,
    })),
  );
  return `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
}

function calculatePlanId(plan: Omit<SpacesDeploymentPlan, "planId">): string {
  const canonical = JSON.stringify({
    schemaVersion: plan.schemaVersion,
    target: plan.target,
    releaseVersion: plan.releaseVersion,
    artifactSetDigest: plan.artifactSetDigest,
    files: plan.files.map((file) => ({
      relativePath: file.relativePath,
      key: file.key,
      size: file.size,
      sha384: file.sha384,
      contentType: file.contentType,
    })),
  });
  return `spaces-${createHash("sha256").update(canonical).digest("hex")}`;
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const directoryStat = await lstat(directory).catch((error: unknown) => {
    throw new Error("Cannot inspect deployment directory.", { cause: error });
  });
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Deployment source must be a real directory.");
  }
  const files: string[] = [];
  const traversal: TraversalState = { entries: 0, directories: 1 };
  assertDirectoryCount(traversal.directories);
  await walk(directory, "", 0, files, traversal);
  files.sort(compareDeploymentPaths);
  assertSortedUniqueDeploymentPaths(files);
  return files;
}

interface TraversalState {
  entries: number;
  directories: number;
}

async function walk(
  root: string,
  relativeDirectory: string,
  depth: number,
  files: string[],
  traversal: TraversalState,
): Promise<void> {
  const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await opendir(directory);
  for await (const entry of entries) {
    traversal.entries += 1;
    assertEntryCount(traversal.entries);
    const relativePath = normalizeRelativePath(
      relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`,
    );
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in deployment sources: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      const childDepth = depth + 1;
      assertDepth(childDepth);
      traversal.directories += 1;
      assertDirectoryCount(traversal.directories);
      await walk(root, relativePath, childDepth, files, traversal);
    } else if (entry.isFile()) {
      files.push(relativePath);
      assertFileCount(files.length);
    } else throw new Error(`Unsupported deployment source entry: ${relativePath}`);
  }
}

function assertEntryCount(count: number): void {
  if (count > SPACES_DEPLOYMENT_LIMITS.maxEntries) {
    throw new Error(
      `Deployment traversal exceeds the ${SPACES_DEPLOYMENT_LIMITS.maxEntries}-entry limit.`,
    );
  }
}

function assertDirectoryCount(count: number): void {
  if (count > SPACES_DEPLOYMENT_LIMITS.maxDirectories) {
    throw new Error(
      `Deployment traversal exceeds the ${SPACES_DEPLOYMENT_LIMITS.maxDirectories}-directory limit.`,
    );
  }
}

function assertDepth(depth: number): void {
  if (depth > SPACES_DEPLOYMENT_LIMITS.maxDepth) {
    throw new Error(
      `Deployment traversal exceeds the ${SPACES_DEPLOYMENT_LIMITS.maxDepth}-level depth limit.`,
    );
  }
}

async function readSourceFile(directory: string, relativePath: string): Promise<Uint8Array> {
  const { absolute, size } = await inspectSourceFileEntry(directory, relativePath);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(absolute, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== size) {
      throw new Error(`Deployment source changed while being opened: ${relativePath}`);
    }
    assertFileSize(opened.size, relativePath);

    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflowProbe = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(
      overflowProbe,
      0,
      overflowProbe.byteLength,
      contents.byteLength,
    );
    const final = await handle.stat();
    if (offset !== contents.byteLength || overflowBytes !== 0 || final.size !== size) {
      throw new Error(`Deployment source changed while being read: ${relativePath}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function inspectSourceFile(directory: string, relativePath: string): Promise<number> {
  return (await inspectSourceFileEntry(directory, relativePath)).size;
}

async function inspectSourceFileEntry(
  directory: string,
  relativePath: string,
): Promise<{ readonly absolute: string; readonly size: number }> {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(directory, ...normalized.split("/"));
  const relative = path.relative(path.resolve(directory), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Deployment source path escapes its directory: ${relativePath}`);
  }
  const stats = await lstat(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Deployment source is not a real file: ${relativePath}`);
  }
  assertFileSize(stats.size, relativePath);
  return { absolute, size: stats.size };
}

function assertFileCount(count: number): void {
  if (count > SPACES_DEPLOYMENT_LIMITS.maxFiles) {
    throw new Error(
      `Deployment contains ${count} files; the conservative limit is ${SPACES_DEPLOYMENT_LIMITS.maxFiles}.`,
    );
  }
}

function assertFileSize(size: number, relativePath: string): void {
  if (size > SPACES_DEPLOYMENT_LIMITS.maxFileBytes) {
    throw new Error(
      `Deployment file exceeds the ${SPACES_DEPLOYMENT_LIMITS.maxFileBytes}-byte limit: ${relativePath}`,
    );
  }
}

function assertTotalSize(size: number): void {
  if (size > SPACES_DEPLOYMENT_LIMITS.maxTotalBytes) {
    throw new Error(
      `Deployment exceeds the ${SPACES_DEPLOYMENT_LIMITS.maxTotalBytes}-byte total limit.`,
    );
  }
}

function normalizeTarget(input: {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
}): SpacesDeploymentTarget {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch (error) {
    throw new Error("endpoint must be an absolute HTTPS URL.", { cause: error });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/")
  ) {
    throw new Error("endpoint must be an HTTPS origin without credentials, path, query, or hash.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(input.region)) {
    throw new Error("region must use lower-case letters, numbers, and hyphens.");
  }
  if (endpoint.hostname !== `${input.region}.digitaloceanspaces.com`) {
    throw new Error("endpoint must be the DigitalOcean Spaces origin for the configured region.");
  }
  if (
    input.bucket.length < 3 ||
    input.bucket.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u.test(input.bucket)
  ) {
    throw new Error("bucket is not a valid Spaces bucket name.");
  }
  return {
    endpoint: endpoint.origin,
    region: input.region,
    bucket: input.bucket,
    prefix: normalizePrefix(input.prefix),
  };
}

function normalizePrefix(value: string): string {
  if (value.includes("\\")) throw new Error("prefix must use forward slashes.");
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  let end = value.length;
  while (end > start && value[end - 1] === "/") end -= 1;
  const normalized = value.slice(start, end);
  if (normalized === "") throw new Error("prefix must contain at least one safe path segment.");
  for (const segment of normalized.split("/")) validatePathSegment(segment, "prefix segment");
  return normalized;
}

function validatePathSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value === "." || value === "..") {
    throw new Error(`${field} must be one safe path segment.`);
  }
  return value;
}

function validateReleaseVersion(value: string): string {
  const releaseVersion = validatePathSegment(value, "releaseVersion");
  if (new Set(["current", "latest"]).has(releaseVersion.toLowerCase())) {
    throw new Error(
      "releaseVersion must be immutable; mutable aliases such as latest are rejected.",
    );
  }
  return releaseVersion;
}

function normalizeRelativePath(value: string): string {
  if (value === "" || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`Invalid relative deployment path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid relative deployment path: ${value}`);
  }
  return segments.join("/");
}

function compareDeploymentPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertSortedUniqueDeploymentPaths(paths: readonly string[]): void {
  let previous: string | undefined;
  const canonicalPaths = new Map<string, string>();
  for (const relativePath of paths) {
    if (previous !== undefined && compareDeploymentPaths(previous, relativePath) >= 0) {
      throw new Error("Deployment plan files must be sorted unique normalized paths.");
    }
    const canonicalPath = relativePath.normalize("NFC");
    const existing = canonicalPaths.get(canonicalPath);
    if (existing !== undefined && existing !== relativePath) {
      throw new Error(
        `Deployment paths must not contain canonically equivalent names: ${JSON.stringify(existing)} and ${JSON.stringify(relativePath)}.`,
      );
    }
    canonicalPaths.set(canonicalPath, relativePath);
    previous = relativePath;
  }
}

function objectKey(
  prefix: string,
  releaseVersion: string,
  artifactSetDigest: string,
  relativePath: string,
): string {
  return [prefix, releaseVersion, artifactSetDigest, relativePath].join("/");
}

function integrity(contents: Uint8Array): string {
  return `sha384-${createHash("sha384").update(contents).digest("base64")}`;
}

function validateCredentials(credentials: SpacesCredentials): SpacesCredentials {
  if (credentials.accessKeyId.trim() === "" || credentials.secretAccessKey.trim() === "") {
    throw new Error("DigitalOcean Spaces credentials must be non-empty.");
  }
  if (credentials.sessionToken !== undefined && credentials.sessionToken.trim() === "") {
    throw new Error("DigitalOcean Spaces session token must be non-empty when provided.");
  }
  return credentials;
}

function redactError(
  error: unknown,
  credentials: SpacesCredentials,
  sensitiveValues: readonly string[] = [],
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    credentials.sessionToken,
    ...sensitiveValues,
  ]
    .filter((value): value is string => value !== undefined && value !== "")
    .sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[REDACTED]");
  }
  return message;
}

function deploymentSensitiveValues(
  plan: SpacesDeploymentPlan,
  file?: SpacesDeploymentFile,
): readonly string[] {
  return [
    plan.target.endpoint,
    plan.target.region,
    plan.target.bucket,
    plan.target.prefix,
    plan.releaseVersion,
    plan.artifactSetDigest,
    file?.key,
    file?.relativePath,
  ].filter((value): value is string => value !== undefined && value !== "");
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  const expected = new Set(expectedKeys);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expected.size ||
    actualKeys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new Error(`${label} must contain exactly these fields: ${expectedKeys.join(", ")}.`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${label} fields must be plain data properties.`);
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string.`);
  return value;
}

function isUnambiguousNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return false;
  const metadata = (error as { readonly $metadata?: unknown }).$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode === 404
  );
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return (
    (
      {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      } as Readonly<Record<string, string>>
    )[extension] ?? "application/octet-stream"
  );
}
