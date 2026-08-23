import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  GetBucketVersioningCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyDeploymentPlan,
  createDeploymentPlan,
  SPACES_DEPLOYMENT_LIMITS,
} from "./deployment.js";
import {
  SpacesDeploymentError,
  type SpacesCredentials,
  type SpacesDeploymentPlan,
} from "./types.js";

const temporaryDirectories: string[] = [];
const credentials: SpacesCredentials = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DigitalOcean Spaces deployment", () => {
  it("uses a deterministic artifact-set digest namespace and changes every key with content", async () => {
    const directory = await fixtureDirectory();
    const options = planOptions(directory);
    const first = await createDeploymentPlan(options);
    const second = await createDeploymentPlan(options);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(2);
    expect(first.planId).toMatch(/^spaces-[a-f0-9]{64}$/u);
    expect(first.artifactSetDigest).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(first.files.map((file) => file.relativePath)).toEqual(["project.css", "project.js"]);
    expect(first.files.map((file) => file.key)).toEqual([
      `releases/release-1/${first.artifactSetDigest}/project.css`,
      `releases/release-1/${first.artifactSetDigest}/project.js`,
    ]);

    await writeFile(path.join(directory, "project.js"), "console.info('changed');\n");
    const changed = await createDeploymentPlan(options);
    expect(changed.artifactSetDigest).not.toBe(first.artifactSetDigest);
    expect(changed.files.map((file) => file.key)).not.toEqual(first.files.map((file) => file.key));

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(credentials.accessKeyId);
    expect(serialized).not.toContain(credentials.secretAccessKey);
  });

  it("normalizes surrounding prefix slashes while preserving safe interior segments", async () => {
    const directory = await fixtureDirectory();
    const plan = await createDeploymentPlan({
      ...planOptions(directory),
      prefix: "///releases/archive///",
    });

    expect(plan.target.prefix).toBe("releases/archive");
    expect(plan.files.every((file) => file.key.startsWith("releases/archive/"))).toBe(true);
  });

  it("rejects a long interior slash run without pathological backtracking", async () => {
    const directory = await fixtureDirectory();
    const prefix = `releases${"/".repeat(100_000)}archive`;
    const startedAt = performance.now();

    await expect(createDeploymentPlan({ ...planOptions(directory), prefix })).rejects.toThrow(
      "prefix segment must be one safe path segment",
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("uses the same UTF-8 byte order when planning and validating paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-order-test-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "a.js"), "a\n");
    await writeFile(path.join(directory, "Z.js"), "z\n");
    const plan = await createDeploymentPlan(planOptions(directory));
    const byKey = new Map(plan.files.map((file) => [file.key, file]));
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        const file = byKey.get(command.input.Key ?? "");
        if (file === undefined) throw new Error("Unexpected key.");
        return matchingHead(plan, file, { VersionId: "existing-version" });
      }
      throw new Error("A matching object must not be uploaded.");
    });

    expect(plan.files.map((file) => file.relativePath)).toEqual(["Z.js", "a.js"]);
    await expect(applyWithClient(plan, send)).resolves.toMatchObject({ status: "applied" });
    expect(send.mock.calls.some((call) => call[0] instanceof PutObjectCommand)).toBe(false);
  });

  it("rejects canonically equivalent deployment paths before any remote request", async () => {
    const plan = await fixturePlan();
    const relativePaths = ["e\u0301.js", "\u00e9.js"] as const;
    const collidingPlan: SpacesDeploymentPlan = {
      ...plan,
      files: plan.files.map((file, index) => {
        const relativePath = relativePaths[index];
        if (relativePath === undefined) throw new Error("Missing collision fixture path.");
        return {
          ...file,
          relativePath,
          key: `${plan.target.prefix}/${plan.releaseVersion}/${plan.artifactSetDigest}/${relativePath}`,
          contentType: "text/javascript; charset=utf-8",
        };
      }),
    };
    const send = vi.fn();

    await expect(applyWithClient(collidingPlan, send)).rejects.toThrow("canonically equivalent");
    expect(send).not.toHaveBeenCalled();
  });

  it("verifies versioning and every key before uploading without unsupported conditions", async () => {
    const plan = await fixturePlan();
    const byKey = new Map(plan.files.map((file) => [file.key, file]));
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        if (command.input.VersionId === undefined) throw notFound();
        const file = byKey.get(command.input.Key ?? "");
        if (file === undefined) throw new Error("Unexpected key.");
        return matchingHead(plan, file, { VersionId: command.input.VersionId });
      }
      if (command instanceof PutObjectCommand) {
        return {
          ETag: '"etag"',
          VersionId: `version-${String(command.input.Key)}`,
        };
      }
      throw new Error("Unexpected command.");
    });

    const receipt = await applyDeploymentPlan(plan, {
      confirmedPlanId: plan.planId,
      credentials,
      client: { send } as unknown as S3Client,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(send).toHaveBeenCalledTimes(7);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketVersioningCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[3]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[4]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[5]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[6]?.[0]).toBeInstanceOf(HeadObjectCommand);
    const verificationCalls = send.mock.calls
      .map((call) => call[0])
      .filter(
        (command): command is HeadObjectCommand =>
          command instanceof HeadObjectCommand && command.input.VersionId !== undefined,
      );
    expect(verificationCalls).toHaveLength(2);
    expect(
      verificationCalls.every((command) => command.input.VersionId?.startsWith("version-")),
    ).toBe(true);
    for (const call of send.mock.calls.filter(
      (candidate) => candidate[0] instanceof PutObjectCommand,
    )) {
      const command = call[0] as PutObjectCommand;
      expect(command.input).toMatchObject({
        Bucket: "neutral-assets",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          "artifact-set-digest": plan.artifactSetDigest,
        },
      });
      expect(command.input).not.toHaveProperty("IfNoneMatch");
    }
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      operation: "slicemedia.spaces-deployer.deploy",
      status: "applied",
      planId: plan.planId,
      artifactSetDigest: plan.artifactSetDigest,
      timestamp: "2026-08-12T12:00:00.000Z",
      files: [
        { status: "uploaded", etag: '"etag"', versionId: expect.stringMatching(/^version-/u) },
        { status: "uploaded", etag: '"etag"', versionId: expect.stringMatching(/^version-/u) },
      ],
    });
  });

  it("fails with a partial receipt when an uploaded version does not read back exactly", async () => {
    const plan = await fixturePlan();
    const byKey = new Map(plan.files.map((file) => [file.key, file]));
    let verificationCount = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        if (command.input.VersionId === undefined) throw notFound();
        verificationCount += 1;
        const file = byKey.get(command.input.Key ?? "");
        if (file === undefined) throw new Error("Unexpected key.");
        const response = matchingHead(plan, file, { VersionId: command.input.VersionId });
        return verificationCount === 2 ? { ...response, ContentLength: file.size + 1 } : response;
      }
      if (command instanceof PutObjectCommand) {
        return { ETag: '"uploaded"', VersionId: `version-${String(command.input.Key)}` };
      }
      throw new Error("Unexpected command.");
    });

    let failure: unknown;
    try {
      await applyWithClient(plan, send);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    const deploymentError = failure as SpacesDeploymentError;
    expect(deploymentError.message).toContain("did not read back");
    expect(deploymentError.receipt).toMatchObject({
      status: "failed",
      files: [
        { key: plan.files[0]!.key, status: "uploaded" },
        {
          key: plan.files[1]!.key,
          status: "failed",
          etag: '"uploaded"',
          versionId: `version-${plan.files[1]!.key}`,
          error: "post-upload-verification-mismatch",
        },
      ],
    });
  });

  it("rejects read-back metadata returned for a different object version", async () => {
    const plan = await fixturePlan();
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        if (command.input.VersionId === undefined) throw notFound();
        expect(command.input.VersionId).toBe("uploaded-version");
        return matchingHead(plan, plan.files[0]!, { VersionId: "different-version" });
      }
      if (command instanceof PutObjectCommand) return { VersionId: "uploaded-version" };
      throw new Error("Unexpected command.");
    });

    let failure: unknown;
    try {
      await applyWithClient(plan, send);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    expect((failure as SpacesDeploymentError).receipt.files).toEqual([
      expect.objectContaining({
        status: "failed",
        versionId: "uploaded-version",
        error: "post-upload-verification-mismatch",
      }),
    ]);
  });

  it("redacts provider errors from post-upload verification receipts", async () => {
    const plan = await fixturePlan();
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        if (command.input.VersionId === undefined) throw notFound();
        throw new Error(`Verification failed for ${credentials.secretAccessKey}`);
      }
      if (command instanceof PutObjectCommand) {
        return { ETag: '"uploaded"', VersionId: "uploaded-version" };
      }
      throw new Error("Unexpected command.");
    });

    let failure: unknown;
    try {
      await applyWithClient(plan, send);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    const deploymentError = failure as SpacesDeploymentError;
    expect(deploymentError.message).toContain("[REDACTED]");
    expect(deploymentError.message).not.toContain(credentials.secretAccessKey);
    expect(JSON.stringify(deploymentError.receipt)).not.toContain(credentials.secretAccessKey);
    expect(deploymentError.receipt.files).toEqual([
      expect.objectContaining({
        status: "failed",
        etag: '"uploaded"',
        versionId: "uploaded-version",
        error: expect.stringMatching(/^post-upload-verification-error: .*\[REDACTED\]$/u),
      }),
    ]);
  });

  it("fails closed when a versioned upload response omits its version ID", async () => {
    const plan = await fixturePlan();
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) throw notFound();
      if (command instanceof PutObjectCommand) return { ETag: '"uploaded"' };
      throw new Error("Unexpected command.");
    });

    let failure: unknown;
    try {
      await applyWithClient(plan, send);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    expect((failure as SpacesDeploymentError).receipt.files).toEqual([
      expect.objectContaining({ status: "failed", error: "missing-upload-version-id" }),
    ]);
  });

  it.each([undefined, "Suspended"])(
    "fails before HEAD or PUT when bucket versioning status is %s",
    async (status) => {
      const plan = await fixturePlan();
      const send = vi.fn().mockResolvedValue({ Status: status });

      await expect(applyWithClient(plan, send)).rejects.toThrow(
        "bucket versioning must be Enabled",
      );
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketVersioningCommand);
    },
  );

  it("redacts provider errors while checking mandatory bucket versioning", async () => {
    const plan = await fixturePlan();
    const send = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Versioning lookup failed for ${credentials.accessKeyId}:${credentials.secretAccessKey}`,
        ),
      );

    let failure: unknown;
    try {
      await applyWithClient(plan, send);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    const serialized = JSON.stringify({
      message: (failure as SpacesDeploymentError).message,
      receipt: (failure as SpacesDeploymentError).receipt,
    });
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(credentials.accessKeyId);
    expect(serialized).not.toContain(credentials.secretAccessKey);
    expect(send).toHaveBeenCalledOnce();
  });

  it("skips occupied keys only when all planned metadata exactly matches", async () => {
    const plan = await fixturePlan();
    const byKey = new Map(plan.files.map((file) => [file.key, file]));
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        const file = byKey.get(command.input.Key ?? "");
        if (file === undefined) throw new Error("Unexpected key.");
        return matchingHead(plan, file, {
          ETag: '"existing"',
          VersionId: "existing-version",
        });
      }
      throw new Error("A matching object must not be uploaded.");
    });

    const receipt = await applyWithClient(plan, send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.some((call) => call[0] instanceof PutObjectCommand)).toBe(false);
    expect(receipt.files).toEqual([
      {
        key: plan.files[0]!.key,
        status: "skipped",
        etag: '"existing"',
        versionId: "existing-version",
      },
      {
        key: plan.files[1]!.key,
        status: "skipped",
        etag: '"existing"',
        versionId: "existing-version",
      },
    ]);
  });

  it.each([undefined, "", "   "])(
    "refuses to skip a matching object with invalid version ID %s",
    async (versionId) => {
      const plan = await fixturePlan();
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
        if (command instanceof HeadObjectCommand) {
          return matchingHead(plan, plan.files[0]!, {
            ETag: '"existing"',
            ...(versionId === undefined ? {} : { VersionId: versionId }),
          });
        }
        throw new Error("A versionless matching object must not be uploaded.");
      });

      let failure: unknown;
      try {
        await applyWithClient(plan, send);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(SpacesDeploymentError);
      expect((failure as SpacesDeploymentError).receipt.files).toEqual([
        {
          key: plan.files[0]!.key,
          status: "failed",
          error: "existing-object-missing-version-id",
        },
      ]);
      expect(send.mock.calls.some((call) => call[0] instanceof PutObjectCommand)).toBe(false);
    },
  );

  it("uploads once and skips every matching object on a repeated apply", async () => {
    const plan = await fixturePlan();
    const byKey = new Map(plan.files.map((file) => [file.key, file]));
    const versions = new Map<string, string>();
    let version = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        const key = command.input.Key ?? "";
        const file = byKey.get(key);
        const versionId = versions.get(key);
        if (file === undefined) throw new Error("Unexpected key.");
        if (versionId === undefined) throw notFound();
        if (command.input.VersionId !== undefined && command.input.VersionId !== versionId) {
          throw notFound();
        }
        return matchingHead(plan, file, { ETag: '"stored"', VersionId: versionId });
      }
      if (command instanceof PutObjectCommand) {
        version += 1;
        const versionId = `version-${version}`;
        versions.set(command.input.Key ?? "", versionId);
        return { ETag: '"stored"', VersionId: versionId };
      }
      throw new Error("Unexpected command.");
    });

    const first = await applyWithClient(plan, send);
    const second = await applyWithClient(plan, send);

    expect(first.files.every((file) => file.status === "uploaded")).toBe(true);
    expect(second.files.every((file) => file.status === "skipped")).toBe(true);
    expect(send.mock.calls.filter((call) => call[0] instanceof PutObjectCommand)).toHaveLength(2);
  });

  it("fails on an occupied content mismatch without writing any preflighted missing key", async () => {
    const plan = await fixturePlan();
    let headCount = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        headCount += 1;
        if (headCount === 1) throw notFound();
        return { ContentLength: 999, Metadata: { sha384: "sha384-mismatch" } };
      }
      throw new Error("PUT must not begin before all HEAD checks pass.");
    });

    await expect(applyWithClient(plan, send)).rejects.toThrow("occupied by content");
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.some((call) => call[0] instanceof PutObjectCommand)).toBe(false);
  });

  it("fails closed on an ambiguous HEAD error and performs no writes", async () => {
    const plan = await fixturePlan();
    let headCount = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) {
        headCount += 1;
        if (headCount === 1) throw notFound();
        throw Object.assign(
          new Error(
            `temporary provider error ${plan.target.bucket} ${plan.files[1]!.key} ${credentials.secretAccessKey}`,
          ),
          { $metadata: { httpStatusCode: 503 } },
        );
      }
      throw new Error("PUT must not begin before all HEAD checks pass.");
    });

    let failure: unknown;
    try {
      await applyWithClient(plan, send);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    expect((failure as SpacesDeploymentError).message).toContain(
      "Cannot determine whether an object key is available",
    );
    expect((failure as SpacesDeploymentError).message).toContain("[REDACTED]");
    expect((failure as SpacesDeploymentError).message).not.toContain(plan.target.bucket);
    expect((failure as SpacesDeploymentError).message).not.toContain(plan.files[1]!.key);
    expect(JSON.stringify(failure)).not.toContain(credentials.secretAccessKey);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.some((call) => call[0] instanceof PutObjectCommand)).toBe(false);
  });

  it("rejects the wrong plan ID and local source drift before any remote request", async () => {
    const plan = await fixturePlan();
    const send = vi.fn();
    await expect(
      applyDeploymentPlan(plan, {
        confirmedPlanId: "spaces-wrong",
        credentials,
        client: { send } as unknown as S3Client,
      }),
    ).rejects.toThrow("exactly match");
    expect(send).not.toHaveBeenCalled();

    await writeFile(
      path.join(plan.sourceDirectory, "project.js"),
      "console.info('changed after plan');\n",
    );
    await expect(applyWithClient(plan, send)).rejects.toThrow("changed after planning");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects noncanonical or extended plan targets before any remote request", async () => {
    const plan = await fixturePlan();
    const send = vi.fn();
    const noncanonicalTarget: SpacesDeploymentPlan = {
      ...plan,
      target: { ...plan.target, prefix: `/${plan.target.prefix}/` },
    };
    const extendedTarget = {
      ...plan,
      target: { ...plan.target, account: "unbound-account" },
    } as SpacesDeploymentPlan;

    await expect(applyWithClient(noncanonicalTarget, send)).rejects.toThrow(
      "exact canonical values",
    );
    await expect(applyWithClient(extendedTarget, send)).rejects.toThrow(
      "must contain exactly these fields",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a redacted failure receipt when a versioned PUT fails", async () => {
    const plan = await fixturePlan();
    const credentialsWithSession = {
      ...credentials,
      sessionToken: "test-session-token",
    };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) throw notFound();
      throw new Error(
        `Provider failure ${credentialsWithSession.accessKeyId}:${credentialsWithSession.secretAccessKey}:${credentialsWithSession.sessionToken}`,
      );
    });

    let failure: unknown;
    try {
      await applyDeploymentPlan(plan, {
        confirmedPlanId: plan.planId,
        credentials: credentialsWithSession,
        client: { send } as unknown as S3Client,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    const deploymentError = failure as SpacesDeploymentError;
    expect(deploymentError.message).toContain("[REDACTED]:[REDACTED]");
    expect(deploymentError.cause).toBeUndefined();
    expect(deploymentError.receipt).toMatchObject({
      status: "failed",
      files: [{ status: "failed", error: expect.stringContaining("[REDACTED]") }],
    });
    expect(JSON.stringify(deploymentError.receipt)).not.toContain(credentials.accessKeyId);
    expect(JSON.stringify(deploymentError.receipt)).not.toContain(credentials.secretAccessKey);
    expect(JSON.stringify(deploymentError.receipt)).not.toContain(
      credentialsWithSession.sessionToken,
    );
  });

  it("redacts overlapping credential values without leaking a suffix", async () => {
    const plan = await fixturePlan();
    const overlappingCredentials = { accessKeyId: "abc", secretAccessKey: "abcdef" };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof HeadObjectCommand) throw notFound();
      throw new Error(`Provider failure ${overlappingCredentials.secretAccessKey}`);
    });

    let failure: unknown;
    try {
      await applyDeploymentPlan(plan, {
        confirmedPlanId: plan.planId,
        credentials: overlappingCredentials,
        client: { send } as unknown as S3Client,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpacesDeploymentError);
    const deploymentError = failure as SpacesDeploymentError;
    expect(deploymentError.message).toContain("Provider failure [REDACTED]");
    expect(deploymentError.message).not.toContain("[REDACTED]def");
    expect(JSON.stringify(deploymentError.receipt)).not.toContain("abcdef");
  });

  it("rejects unsafe or implicit target values", async () => {
    const directory = await fixtureDirectory();
    await expect(
      createDeploymentPlan({ ...planOptions(directory), endpoint: "http://fra1.example.test" }),
    ).rejects.toThrow("HTTPS origin");
    await expect(
      createDeploymentPlan({
        ...planOptions(directory),
        endpoint: "https://s3.amazonaws.com",
      }),
    ).rejects.toThrow("DigitalOcean Spaces origin");
    await expect(
      createDeploymentPlan({ ...planOptions(directory), bucket: "invalid.bucket" }),
    ).rejects.toThrow("valid Spaces bucket name");
    await expect(
      createDeploymentPlan({ ...planOptions(directory), releaseVersion: "../latest" }),
    ).rejects.toThrow("safe path segment");
    await expect(createDeploymentPlan({ ...planOptions(directory), prefix: "" })).rejects.toThrow(
      "at least one safe path segment",
    );
    await expect(
      createDeploymentPlan({ ...planOptions(directory), releaseVersion: "latest" }),
    ).rejects.toThrow("must be immutable");
  });

  it("rejects file-count, per-file, and total-size limits before reading payloads", async () => {
    const tooManyDirectory = await emptyFixtureDirectory("file-count");
    await Promise.all(
      Array.from({ length: SPACES_DEPLOYMENT_LIMITS.maxFiles + 1 }, (_, index) =>
        writeFile(path.join(tooManyDirectory, `${String(index).padStart(4, "0")}.js`), ""),
      ),
    );
    await expect(createDeploymentPlan(planOptions(tooManyDirectory))).rejects.toThrow(
      `conservative limit is ${SPACES_DEPLOYMENT_LIMITS.maxFiles}`,
    );

    const oversizedFileDirectory = await emptyFixtureDirectory("file-size");
    const oversizedFile = path.join(oversizedFileDirectory, "oversized.js");
    await writeFile(oversizedFile, "");
    await truncate(oversizedFile, SPACES_DEPLOYMENT_LIMITS.maxFileBytes + 1);
    await expect(createDeploymentPlan(planOptions(oversizedFileDirectory))).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxFileBytes}-byte limit`,
    );

    const oversizedSetDirectory = await emptyFixtureDirectory("total-size");
    const sparseFileSize = Math.floor(SPACES_DEPLOYMENT_LIMITS.maxTotalBytes / 5) + 1;
    for (let index = 0; index < 5; index += 1) {
      const file = path.join(oversizedSetDirectory, `part-${index}.js`);
      await writeFile(file, "");
      await truncate(file, sparseFileSize);
    }
    await expect(createDeploymentPlan(planOptions(oversizedSetDirectory))).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxTotalBytes}-byte total limit`,
    );
  });

  it("bounds streamed traversal entries, directories, and nesting depth", async () => {
    const tooManyDirectories = await emptyFixtureDirectory("directory-count");
    await Promise.all(
      Array.from({ length: SPACES_DEPLOYMENT_LIMITS.maxDirectories }, (_, index) =>
        mkdir(path.join(tooManyDirectories, `directory-${String(index).padStart(4, "0")}`)),
      ),
    );
    await expect(createDeploymentPlan(planOptions(tooManyDirectories))).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxDirectories}-directory limit`,
    );

    const tooManyEntries = await emptyFixtureDirectory("entry-count");
    const directoryCount = Math.floor(SPACES_DEPLOYMENT_LIMITS.maxEntries / 2);
    const fileCount = SPACES_DEPLOYMENT_LIMITS.maxEntries + 1 - directoryCount;
    await Promise.all([
      ...Array.from({ length: directoryCount }, (_, index) =>
        mkdir(path.join(tooManyEntries, `directory-${String(index).padStart(4, "0")}`)),
      ),
      ...Array.from({ length: fileCount }, (_, index) =>
        writeFile(path.join(tooManyEntries, `file-${String(index).padStart(4, "0")}.js`), ""),
      ),
    ]);
    await expect(createDeploymentPlan(planOptions(tooManyEntries))).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxEntries}-entry limit`,
    );

    const tooDeep = await emptyFixtureDirectory("depth");
    let current = tooDeep;
    for (let depth = 0; depth <= SPACES_DEPLOYMENT_LIMITS.maxDepth; depth += 1) {
      current = path.join(current, `level-${String(depth).padStart(2, "0")}`);
      await mkdir(current);
    }
    await expect(createDeploymentPlan(planOptions(tooDeep))).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxDepth}-level depth limit`,
    );
  }, 15_000);

  it("rechecks resource limits during apply before any remote request", async () => {
    const plan = await fixturePlan();
    await truncate(
      path.join(plan.sourceDirectory, plan.files[0]!.relativePath),
      SPACES_DEPLOYMENT_LIMITS.maxFileBytes + 1,
    );
    const send = vi.fn();

    await expect(applyWithClient(plan, send)).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxFileBytes}-byte limit`,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an oversized serialized plan before reading files or making a remote request", async () => {
    const plan = await fixturePlan();
    const oversizedPlan: SpacesDeploymentPlan = {
      ...plan,
      files: [
        {
          ...plan.files[0]!,
          size: SPACES_DEPLOYMENT_LIMITS.maxFileBytes + 1,
        },
        ...plan.files.slice(1),
      ],
    };
    const send = vi.fn();

    await expect(applyWithClient(oversizedPlan, send)).rejects.toThrow(
      `${SPACES_DEPLOYMENT_LIMITS.maxFileBytes}-byte limit`,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

async function applyWithClient(plan: SpacesDeploymentPlan, send: ReturnType<typeof vi.fn>) {
  return applyDeploymentPlan(plan, {
    confirmedPlanId: plan.planId,
    credentials,
    client: { send } as unknown as S3Client,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });
}

function notFound(): Error & { readonly $metadata: { readonly httpStatusCode: 404 } } {
  return Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 as const } });
}

async function fixturePlan(): Promise<SpacesDeploymentPlan> {
  const directory = await fixtureDirectory();
  return createDeploymentPlan(planOptions(directory));
}

async function fixtureDirectory(): Promise<string> {
  const directory = await emptyFixtureDirectory("artifacts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "project.js"), "console.info('neutral');\n");
  await writeFile(path.join(directory, "project.css"), "[data-slicemedia-ready]{display:block}\n");
  return directory;
}

async function emptyFixtureDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `slicemedia-spaces-${label}-test-`));
  temporaryDirectories.push(directory);
  return directory;
}

function matchingHead(
  plan: SpacesDeploymentPlan,
  file: SpacesDeploymentPlan["files"][number],
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    CacheControl: "public, max-age=31536000, immutable",
    ContentLength: file.size,
    ContentType: file.contentType,
    Metadata: {
      sha384: file.sha384,
      "artifact-set-digest": plan.artifactSetDigest,
    },
    ...extra,
  };
}

function planOptions(directory: string) {
  return {
    directory,
    endpoint: "https://fra1.digitaloceanspaces.com",
    region: "fra1",
    bucket: "neutral-assets",
    prefix: "releases",
    releaseVersion: "release-1",
  } as const;
}
