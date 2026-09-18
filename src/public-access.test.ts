import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GetObjectAclCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDeploymentPlan, createDeploymentPlan } from "./deployment.js";
import { verifyPublicObject } from "./public-access.js";
import { SpacesDeploymentError, type SpacesDeploymentPlan } from "./types.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const directories: string[] = [];
const credentials = { accessKeyId: "test-access", secretAccessKey: "test-secret" };
const token = "test-cdn-token";
const endpointId = "12345678-1234-1234-1234-123456789abc";
const publicGrant = {
  Grantee: { Type: "Group", URI: "http://acs.amazonaws.com/groups/global/AllUsers" },
  Permission: "READ",
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("explicit public browser assets", () => {
  it("binds public-read to the plan ID and leaves default plans and uploads without an ACL", async () => {
    const { options, plan } = await fixture();
    const ordinary = await createDeploymentPlan(options);
    expect(ordinary).not.toHaveProperty("acl");
    expect(ordinary.files).toEqual(plan.files);
    expect(ordinary.planId).not.toBe(plan.planId);
    const remote = provider();
    await apply(ordinary, remote);
    expect(remote.publicFetch).not.toHaveBeenCalled();
    for (const [command] of remote.send.mock.calls) {
      if (command instanceof PutObjectCommand) expect(command.input).not.toHaveProperty("ACL");
      expect(command).not.toBeInstanceOf(GetObjectAclCommand);
    }
  });

  it.each(["stable", "immutable"] as const)(
    "rejects added or removed ACLs in saved %s plans",
    async (mode) => {
      const { plan, options } = await fixture(mode);
      const ordinary = await createDeploymentPlan(options);
      const withoutAcl = { ...plan };
      delete (withoutAcl as { acl?: string }).acl;
      for (const changed of [withoutAcl, { ...ordinary, acl: "public-read" as const }]) {
        const remote = provider();
        await expect(apply(changed, remote)).rejects.toThrow("plan ID does not match");
        expect(remote.send).not.toHaveBeenCalled();
        expect(remote.publicFetch).not.toHaveBeenCalled();
        expect(remote.cdnFetch).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["private", "public-read-write", "", null, true])(
    "rejects unsupported ACL %s",
    async (acl) => {
      const { options, plan } = await fixture();
      await expect(
        createDeploymentPlan({ ...options, acl } as unknown as Parameters<
          typeof createDeploymentPlan
        >[0]),
      ).rejects.toThrow("Object ACL");
      const remote = provider();
      await expect(apply({ ...plan, acl } as SpacesDeploymentPlan, remote)).rejects.toThrow();
      expect(remote.send).not.toHaveBeenCalled();
    },
  );

  it("rejects ACL accessors without invoking them", async () => {
    const { plan } = await fixture();
    const getter = vi.fn(() => "public-read");
    const changed = Object.defineProperty({ ...plan }, "acl", { enumerable: true, get: getter });
    const remote = provider();
    await expect(apply(changed, remote)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(remote.send).not.toHaveBeenCalled();
  });

  it.each([
    ["stable", false],
    ["stable", true],
    ["immutable", false],
    ["immutable", true],
  ] as const)(
    "publishes %s files with versioning %s and verifies unsigned contents",
    async (mode, versioned) => {
      const { plan } = await fixture(mode);
      const remote = provider(versioned);
      const receipt = await apply(plan, remote);
      expect(receipt).toMatchObject({ status: "applied", acl: "public-read" });
      for (const file of receipt.files) {
        expect(file.status).toBe("uploaded");
        expect(file.publicUrls).toHaveLength(mode === "stable" ? 2 : 1);
        expect(file.publicUrls?.[0]).toBe(
          `https://neutral-assets.fra1.digitaloceanspaces.com/${file.key}`,
        );
        expect(remote.objects.get(file.key)?.input.ACL).toBe("public-read");
      }
      for (const [, init] of remote.publicFetch.mock.calls) {
        expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
        expect(init?.headers).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
      if (mode === "stable") {
        expect(remote.events.indexOf("public:origin")).toBeLessThan(remote.events.indexOf("purge"));
        expect(remote.events.indexOf("purge")).toBeLessThan(remote.events.indexOf("public:cdn"));
        expect(receipt.files[0]?.publicUrls?.[1]).toBe(
          `https://neutral-assets.fra1.cdn.digitaloceanspaces.com/${plan.files[0]!.key}`,
        );
      } else expect(remote.cdnFetch).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "repairs matching private objects and skips verified public objects, versioned %s",
    async (versioned) => {
      const { plan, options } = await fixture();
      const remote = provider(versioned);
      const first = await apply(await createDeploymentPlan(options), remote);
      remote.events.length = 0;
      const repaired = await apply(plan, remote);
      expect(repaired.files.every((file) => file.status === "uploaded")).toBe(true);
      expect(remote.events.filter((event) => event === "acl")).toHaveLength(2);
      if (versioned) expect(repaired.files[0]?.previousVersionId).toBe(first.files[0]?.versionId);
      remote.events.length = 0;
      const repeat = await apply(plan, remote);
      expect(repeat.files.every((file) => file.status === "skipped")).toBe(true);
      expect(remote.events).not.toContain("put");
      expect(remote.events).toContain("public:cdn");
      remote.objects.get(plan.files[0]!.key)!.publicRead = false;
      const restored = await apply(plan, remote);
      expect(restored.files.map((file) => file.status)).toEqual(["uploaded", "skipped"]);
    },
  );

  it.each(["missing", "denied", "not-found"])(
    "aborts all writes on %s ACL preflight information",
    async (reason) => {
      const { plan, options } = await fixture();
      const remote = provider();
      await apply(await createDeploymentPlan(options), remote);
      remote.events.length = 0;
      const send = remote.send.getMockImplementation()!;
      remote.send.mockImplementation(async (command) => {
        if (command instanceof GetObjectAclCommand && command.input.Key === plan.files[1]!.key) {
          if (reason === "denied") throw new Error(`Denied ${credentials.secretAccessKey}`);
          if (reason === "not-found")
            throw Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 } });
          return {};
        }
        return send(command);
      });
      const error = await failure(apply(plan, remote));
      expect(JSON.stringify(error.receipt)).not.toContain(credentials.secretAccessKey);
      expect(error.receipt.files[0]?.error).toBe("remote-preflight-ambiguous");
      expect(remote.events).not.toContain("put");
      expect(remote.events).not.toContain("purge");
    },
  );

  it.each([403, 404, 302])(
    "fails before purging when unsigned origin returns HTTP %s",
    async (status) => {
      const { plan } = await fixture();
      const remote = provider();
      remote.publicFetch.mockResolvedValue(new Response(token, { status }));
      const error = await failure(apply(plan, remote));
      expect(error.receipt).toMatchObject({
        status: "failed",
        acl: "public-read",
        cdn: { status: "not-requested" },
      });
      expect(error.receipt.files[0]?.status).toBe("failed");
      expect(error.message).toContain(`HTTP ${status}`);
      expect(JSON.stringify(error)).not.toContain(token);
      expect(remote.events).not.toContain("purge");
    },
  );

  it("fails when an upload ignores the requested ACL", async () => {
    const { plan } = await fixture();
    const remote = provider();
    const send = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async (command) => {
      const response = await send(command);
      if (command instanceof PutObjectCommand)
        remote.objects.get(command.input.Key!)!.publicRead = false;
      return response;
    });
    const error = await failure(apply(plan, remote));
    expect(error.message).toContain("HTTP 403");
    expect(remote.events).not.toContain("purge");
  });

  it("records a completed purge when CDN verification fails, then retries without uploading", async () => {
    const { plan } = await fixture();
    const remote = provider();
    const get = remote.publicFetch.getMockImplementation()!;
    remote.publicFetch.mockImplementation(async (url, init) =>
      String(url).includes(".cdn.") ? new Response("unavailable", { status: 503 }) : get(url, init),
    );
    const error = await failure(apply(plan, remote));
    expect(error.receipt).toMatchObject({ status: "failed", cdn: { status: "requested" } });
    expect(error.receipt.files[0]?.publicUrls).toHaveLength(1);
    expect(error.message).toContain("Public CDN");
    remote.publicFetch.mockImplementation(get);
    remote.events.length = 0;
    const retried = await apply(plan, remote);
    expect(retried.status).toBe("applied");
    expect(retried.files.every((file) => file.status === "skipped")).toBe(true);
    expect(remote.events).not.toContain("put");
    expect(remote.events).toContain("purge");
  });

  it("rejects stale public bytes and retries CDN propagation before reporting success", async () => {
    const { plan } = await fixture();
    const file = plan.files.find((candidate) => candidate.size > 0)!;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("x".repeat(file.size)));
    await expect(verifyPublicObject(plan, file, false, request)).rejects.toThrow(
      "bytes do not match",
    );
    const remote = provider();
    const get = remote.publicFetch.getMockImplementation()!;
    let cdnReads = 0;
    remote.publicFetch.mockImplementation(async (url, init) => {
      if (String(url).includes(".cdn.") && cdnReads++ === 0)
        return new Response(null, { status: 404 });
      return get(url, init);
    });
    expect((await apply(plan, remote)).status).toBe("applied");
    expect(cdnReads).toBe(3);
  });

  it("bounds public response streaming and cancels oversized bodies", async () => {
    const { plan } = await fixture();
    const file = plan.files[0]!;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(file.size + 1));
      },
      cancel,
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(verifyPublicObject(plan, file, false, request)).rejects.toThrow(
      "exceeds the planned file size",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("omits transport errors and encodes public paths without signed query parameters", async () => {
    const { plan, options } = await fixture();
    await mkdir(path.join(options.directory, "nested"));
    await writeFile(path.join(options.directory, "nested", "café file.js"), "encoded");
    const encoded = await createDeploymentPlan({ ...options, acl: "public-read" });
    const remote = provider();
    const receipt = await apply(encoded, remote);
    expect(
      receipt.files
        .flatMap((file) => file.publicUrls ?? [])
        .some((url) => url.endsWith("nested/caf%C3%A9%20file.js")),
    ).toBe(true);
    for (const [url] of remote.publicFetch.mock.calls) expect(new URL(String(url)).search).toBe("");
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`redirect ${credentials.secretAccessKey} ${token}`));
    await expect(verifyPublicObject(plan, plan.files[0]!, false, request)).rejects.toThrow(
      "Request failed or timed out",
    );
  });
});

async function fixture(mode: "stable" | "immutable" = "stable") {
  const directory = await mkdtemp(path.join(tmpdir(), "slicemedia-public-test-"));
  directories.push(directory);
  await writeFile(path.join(directory, "project.js"), "console.info('public');\n");
  await writeFile(path.join(directory, "project.css"), "");
  const options = {
    directory,
    endpoint: "https://fra1.digitaloceanspaces.com",
    region: "fra1",
    bucket: "neutral-assets",
    prefix: "project/assets",
    releaseVersion: "release-1",
    mode,
    ...(mode === "stable" ? { cdnEndpointId: endpointId } : {}),
  };
  const plan = await createDeploymentPlan({ ...options, acl: "public-read" });
  return { options, plan };
}

function provider(versioned = false) {
  const events: string[] = [];
  const objects = new Map<
    string,
    { input: PutObjectCommandInput; etag: string; versionId?: string; publicRead: boolean }
  >();
  let count = 0;
  const send = vi.fn(async (command: unknown): Promise<Record<string, unknown>> => {
    if (command instanceof PutObjectCommand) {
      events.push("put");
      const etag = `"upload-${++count}"`;
      const versionId = versioned ? `version-${count}` : undefined;
      objects.set(command.input.Key!, {
        input: command.input,
        etag,
        ...(versionId === undefined ? {} : { versionId }),
        publicRead: command.input.ACL === "public-read",
      });
      return { ETag: etag, VersionId: versionId };
    }
    if (command instanceof HeadObjectCommand || command instanceof GetObjectAclCommand) {
      events.push(command instanceof HeadObjectCommand ? "head" : "acl");
      const object = objects.get(command.input.Key!);
      if (object === undefined)
        throw Object.assign(new Error("Not Found"), { $metadata: { httpStatusCode: 404 } });
      if (command.input.VersionId !== undefined)
        expect(command.input.VersionId).toBe(object.versionId);
      if (command instanceof GetObjectAclCommand)
        return { Grants: object.publicRead ? [publicGrant] : [] };
      return {
        ContentLength: object.input.ContentLength,
        ContentType: object.input.ContentType,
        CacheControl: object.input.CacheControl,
        Metadata: object.input.Metadata,
        ETag: object.etag,
        VersionId: object.versionId,
      };
    }
    throw new Error("Unexpected S3 operation");
  });
  const publicFetch = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    events.push(url.hostname.includes(".cdn.") ? "public:cdn" : "public:origin");
    const object = objects.get(decodeURIComponent(url.pathname.slice(1)));
    if (!object?.publicRead) return new Response("private", { status: 403 });
    return new Response(Buffer.from(object.input.Body as Uint8Array), {
      headers: { "Content-Type": object.input.ContentType! },
    });
  });
  const cdnFetch = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "GET")
      return Response.json({
        endpoint: { id: endpointId, origin: "neutral-assets.fra1.digitaloceanspaces.com" },
      });
    events.push("purge");
    return new Response(null, { status: 204 });
  });
  return { events, objects, send, publicFetch, cdnFetch };
}

function apply(plan: SpacesDeploymentPlan, remote: ReturnType<typeof provider>) {
  return applyDeploymentPlan(plan, {
    confirmedPlanId: plan.planId,
    credentials,
    cdnApiToken: token,
    client: { send: remote.send } as unknown as S3Client,
    cdnFetch: remote.cdnFetch,
    publicFetch: remote.publicFetch,
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
