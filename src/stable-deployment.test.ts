import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GetBucketVersioningCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDeploymentPlan, createDeploymentPlan } from "./deployment.js";
import { SpacesDeploymentError, type SpacesDeploymentPlan } from "./types.js";

const directories: string[] = [];
const endpointId = "12345678-1234-1234-1234-123456789abc";
const token = "test-cdn-token";
const credentials = { accessKeyId: "test-access", secretAccessKey: "test-secret" };

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("stable URL deployments", () => {
  it("defaults to fixed keys while binding contents, release, cache policy and CDN to the plan", async () => {
    const { plan, options } = await fixture();
    expect(plan).toMatchObject({
      schemaVersion: 3,
      mode: "stable",
      cacheControl: "public, max-age=0, s-maxage=300, must-revalidate",
      cdn: { endpointId, files: ["/project/assets/*"] },
    });
    expect(plan.files.map((file) => file.key)).toEqual([
      "project/assets/project.css",
      "project/assets/project.js",
    ]);
    expect(await createDeploymentPlan(options)).toEqual(plan);
    await writeFile(path.join(options.directory, "project.js"), "console.info('updated');\n");
    const next = await createDeploymentPlan({ ...options, releaseVersion: "release-2" });
    expect(next.files.map((file) => file.key)).toEqual(plan.files.map((file) => file.key));
    expect(next.artifactSetDigest).not.toBe(plan.artifactSetDigest);
    expect(next.planId).not.toBe(plan.planId);
    const other = await createDeploymentPlan({
      ...options,
      releaseVersion: "release-2",
      cdnEndpointId: "87654321-1234-1234-1234-123456789abc",
    });
    expect(other.planId).not.toBe(next.planId);
    expect(JSON.stringify(plan)).not.toContain(token);
  });

  it("updates the same keys, retains prior versions and purges only after all read-backs", async () => {
    const { plan, options } = await fixture();
    const remote = provider();
    const first = await apply(plan, remote);
    expect(first).toMatchObject({
      status: "applied",
      schemaVersion: 3,
      cdn: { status: "requested" },
    });
    expect(remote.events).toEqual([
      "cdn:GET",
      "versioning",
      "head:current",
      "head:current",
      "put",
      "head:version",
      "put",
      "head:version",
      "head:current",
      "head:current",
      "cdn:DELETE",
    ]);
    await writeFile(path.join(options.directory, "project.js"), "console.info('new version');\n");
    const next = await createDeploymentPlan({ ...options, releaseVersion: "release-2" });
    const second = await apply(next, remote);
    for (const [index, receipt] of second.files.entries()) {
      expect(receipt.previousVersionId).toBe(first.files[index]?.versionId);
      expect(receipt.versionId).not.toBe(receipt.previousVersionId);
      const retained = remote.versions.get(receipt.key)!;
      expect(retained).toHaveLength(2);
      expect(retained[1]!.input.CacheControl).toBe(
        "public, max-age=0, s-maxage=300, must-revalidate",
      );
    }
    expect(
      Buffer.from(
        remote.versions.get("project/assets/project.js")![1]!.input.Body as Uint8Array,
      ).toString(),
    ).toContain("new version");
    const [url, request] = remote.cdnFetch.mock.calls.at(-1)!;
    expect(url).toBe(`https://api.digitalocean.com/v2/cdn/endpoints/${endpointId}/cache`);
    expect(request).toMatchObject({
      method: "DELETE",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: ["/project/assets/*"] }),
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a failed purge without uploading matching objects again", async () => {
    const { plan } = await fixture();
    const remote = provider();
    remote.purgeStatus = 429;
    const error = await failure(apply(plan, remote));
    expect(error.receipt).toMatchObject({
      status: "failed",
      cdn: { status: "failed", error: "DigitalOcean CDN purge failed with HTTP 429." },
      files: [{ status: "uploaded" }, { status: "uploaded" }],
    });
    expect(JSON.stringify(error)).not.toContain(token);
    const writes = remote.events.filter((event) => event === "put").length;
    remote.purgeStatus = 204;
    const retried = await apply(plan, remote);
    expect(retried.files.every((file) => file.status === "skipped")).toBe(true);
    expect(retried).toMatchObject({ status: "applied", cdn: { status: "requested" } });
    expect(remote.events.filter((event) => event === "put")).toHaveLength(writes);
    expect(remote.events.filter((event) => event === "cdn:DELETE")).toHaveLength(2);
  });

  it("retains rollback references when a replacement upload fails", async () => {
    const { plan, options } = await fixture();
    const remote = provider();
    const first = await apply(plan, remote);
    await writeFile(path.join(options.directory, "project.js"), "console.info('replacement');\n");
    const next = await createDeploymentPlan({ ...options, releaseVersion: "release-2" });
    const send = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async (command) => {
      if (command instanceof PutObjectCommand) throw new Error("Provider upload unavailable");
      return send(command);
    });
    const error = await failure(apply(next, remote));
    expect(error.receipt.files[0]).toMatchObject({
      status: "failed",
      previousVersionId: first.files[0]!.versionId,
    });
    expect(error.receipt).toMatchObject({ cdn: { status: "not-requested" } });
  });

  it.each([401, 403, 500, 302, 200])(
    "does not report success for purge HTTP %s",
    async (status) => {
      const { plan } = await fixture();
      const remote = provider();
      remote.purgeStatus = status;
      const error = await failure(apply(plan, remote));
      expect(error.receipt).toMatchObject({ status: "failed", cdn: { status: "failed" } });
      expect(error.message).toContain(`HTTP ${status}`);
      expect(JSON.stringify(error)).not.toContain(token);
    },
  );

  it.each(["GET", "DELETE"])("redacts transport failures during CDN %s", async (method) => {
    const { plan } = await fixture();
    const remote = provider();
    const request = remote.cdnFetch.getMockImplementation()!;
    remote.cdnFetch.mockImplementation(async (url, init) => {
      if (init?.method === method)
        throw new Error(`Transport leaked ${token} ${credentials.secretAccessKey}`);
      return request(url, init);
    });
    const error = await failure(apply(plan, remote));
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain(token);
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain(credentials.secretAccessKey);
    expect(error.cause).toBeUndefined();
    if (method === "GET") expect(remote.send).not.toHaveBeenCalled();
  });

  it.each([
    { endpoint: { id: endpointId, origin: "other-assets.fra1.digitaloceanspaces.com" } },
    { endpoint: { id: endpointId, origin: "neutral-assets.nyc3.digitaloceanspaces.com" } },
    { endpoint: { id: "other-id", origin: "neutral-assets.fra1.digitaloceanspaces.com" } },
    {},
  ])("rejects unrelated or malformed CDN metadata before any object request", async (body) => {
    const { plan } = await fixture();
    const remote = provider();
    remote.cdnFetch.mockResolvedValueOnce(Response.json(body));
    await expect(apply(plan, remote)).rejects.toBeInstanceOf(SpacesDeploymentError);
    expect(remote.send).not.toHaveBeenCalled();
    expect(remote.cdnFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 500])(
    "rejects CDN preflight HTTP %s before uploading",
    async (status) => {
      const { plan } = await fixture();
      const remote = provider();
      remote.cdnFetch.mockResolvedValueOnce(new Response(token, { status }));
      const error = await failure(apply(plan, remote));
      expect(error.receipt).toMatchObject({ cdn: { status: "not-requested" }, files: [] });
      expect(remote.send).not.toHaveBeenCalled();
    },
  );

  it("requires the CDN token and unchanged local contents before contacting either API", async () => {
    const { plan, options } = await fixture();
    const remote = provider();
    await expect(
      applyDeploymentPlan(plan, {
        confirmedPlanId: plan.planId,
        credentials,
        client: { send: remote.send } as unknown as S3Client,
        cdnFetch: remote.cdnFetch,
      }),
    ).rejects.toThrow("CDN API token");
    await writeFile(path.join(options.directory, "project.js"), "changed since planning");
    await expect(apply(plan, remote)).rejects.toThrow("Source file changed");
    expect(remote.send).not.toHaveBeenCalled();
    expect(remote.cdnFetch).not.toHaveBeenCalled();
  });

  it.each(["Suspended", undefined])(
    "requires bucket versioning (%s) before stable replacements",
    async (status) => {
      const { plan } = await fixture();
      const remote = provider();
      remote.send.mockResolvedValueOnce({ Status: status });
      const error = await failure(apply(plan, remote));
      expect(error.message).toContain("versioning must be Enabled");
      expect(remote.events).toEqual(["cdn:GET"]);
    },
  );

  it("does not start uploads if any existing object lacks a recoverable version ID", async () => {
    const { plan } = await fixture();
    const remote = provider();
    const send = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand && command.input.Key?.endsWith(".js"))
        return { ContentLength: 100 };
      return send(command);
    });
    const error = await failure(apply(plan, remote));
    expect(error.receipt).toMatchObject({ cdn: { status: "not-requested" } });
    expect(remote.events).not.toContain("put");
    expect(remote.events).not.toContain("cdn:DELETE");
  });

  it.each(["upload", "read-back", "current"])(
    "withholds invalidation after a failure during %s",
    async (stage) => {
      const { plan } = await fixture();
      const remote = provider();
      const send = remote.send.getMockImplementation()!;
      remote.send.mockImplementation(async (command) => {
        if (
          stage === "upload" &&
          command instanceof PutObjectCommand &&
          command.input.Key?.endsWith(".js")
        )
          throw new Error("upload unavailable");
        const result = await send(command);
        if (
          command instanceof HeadObjectCommand &&
          ((stage === "read-back" && command.input.VersionId !== undefined) ||
            (stage === "current" && command.input.VersionId === undefined))
        ) {
          return { ...result, VersionId: "different-version" };
        }
        return result;
      });
      const error = await failure(apply(plan, remote));
      expect(error.receipt).toMatchObject({ status: "failed", cdn: { status: "not-requested" } });
      expect(remote.events).not.toContain("cdn:DELETE");
    },
  );

  it("rejects broadened purge scope, policy changes, endpoint changes and unexpected keys before requests", async () => {
    const { plan } = await fixture();
    const remote = provider();
    for (const changed of [
      { ...plan, cdn: { ...plan.cdn, files: ["/*"] } },
      { ...plan, cdn: { ...plan.cdn, files: ["/project/*"] } },
      { ...plan, cdn: { ...plan.cdn, files: [...plan.cdn.files, "/other/*"] } },
      { ...plan, cdn: { ...plan.cdn, endpointId: "87654321-1234-1234-1234-123456789abc" } },
      { ...plan, cacheControl: "public, max-age=31536000, immutable" },
      {
        ...plan,
        files: plan.files.map((file) => ({ ...file, key: `other/${file.relativePath}` })),
      },
      { ...plan, mode: "immutable" },
    ])
      await expect(apply(changed as SpacesDeploymentPlan, remote)).rejects.toThrow();
    expect(remote.send).not.toHaveBeenCalled();
    expect(remote.cdnFetch).not.toHaveBeenCalled();
  });

  it("rejects broad or unsafe prefixes, invalid endpoint IDs and ambiguous mode options", async () => {
    const { options } = await fixture();
    for (const prefix of ["/", "project", "project/*", "project/../assets", "project//assets"]) {
      await expect(createDeploymentPlan({ ...options, prefix })).rejects.toThrow();
    }
    for (const cdnEndpointId of [
      "",
      "invalid",
      `${endpointId}/cache`,
      `${endpointId}?override=1`,
    ]) {
      await expect(createDeploymentPlan({ ...options, cdnEndpointId })).rejects.toThrow("UUID");
    }
    await expect(createDeploymentPlan({ ...options, mode: "immutable" })).rejects.toThrow(
      "only supported for stable",
    );
    await expect(createDeploymentPlan({ ...options, mode: "other" as "stable" })).rejects.toThrow(
      "mode must be",
    );
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "slicemedia-stable-test-"));
  directories.push(directory);
  await writeFile(path.join(directory, "project.js"), "console.info('first');\n");
  await writeFile(path.join(directory, "project.css"), "[data-wft-ready]{display:block}\n");
  const options = {
    directory,
    endpoint: "https://fra1.digitaloceanspaces.com",
    region: "fra1",
    bucket: "neutral-assets",
    prefix: "project/assets",
    releaseVersion: "release-1",
    cdnEndpointId: endpointId,
  };
  const plan = await createDeploymentPlan(options);
  if (plan.schemaVersion !== 3) throw new Error("Expected stable plan");
  return { plan, options };
}

function provider() {
  const events: string[] = [];
  const versions = new Map<string, Array<{ id: string; input: PutObjectCommandInput }>>();
  let counter = 0;
  const send = vi.fn(async (command: unknown): Promise<Record<string, unknown>> => {
    if (command instanceof GetBucketVersioningCommand) {
      events.push("versioning");
      return { Status: "Enabled" };
    }
    if (command instanceof PutObjectCommand) {
      events.push("put");
      const id = `version-${++counter}`;
      const key = command.input.Key!;
      versions.set(key, [...(versions.get(key) ?? []), { id, input: command.input }]);
      return { VersionId: id, ETag: `"${id}"` };
    }
    if (command instanceof HeadObjectCommand) {
      events.push(command.input.VersionId === undefined ? "head:current" : "head:version");
      const history = versions.get(command.input.Key!);
      const version =
        command.input.VersionId === undefined
          ? history?.at(-1)
          : history?.find((item) => item.id === command.input.VersionId);
      if (version === undefined)
        throw Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 } });
      return {
        VersionId: version.id,
        ETag: `"${version.id}"`,
        CacheControl: version.input.CacheControl,
        ContentLength: version.input.ContentLength,
        ContentType: version.input.ContentType,
        Metadata: version.input.Metadata,
      };
    }
    throw new Error("Unexpected object operation");
  });
  const remote = {
    events,
    versions,
    send,
    purgeStatus: 204,
    cdnFetch: vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      events.push(`cdn:${init?.method}`);
      if (init?.method === "GET")
        return Response.json({
          endpoint: { id: endpointId, origin: "neutral-assets.fra1.digitaloceanspaces.com" },
        });
      return new Response(remote.purgeStatus === 204 ? null : `Provider body ${token}`, {
        status: remote.purgeStatus,
      });
    }),
  };
  return remote;
}

function apply(plan: SpacesDeploymentPlan, remote: ReturnType<typeof provider>) {
  return applyDeploymentPlan(plan, {
    confirmedPlanId: plan.planId,
    credentials,
    cdnApiToken: token,
    client: { send: remote.send } as unknown as S3Client,
    cdnFetch: remote.cdnFetch,
  });
}

async function failure(promise: Promise<unknown>): Promise<SpacesDeploymentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SpacesDeploymentError);
    return error as SpacesDeploymentError;
  }
  throw new Error("Expected deployment failure");
}
