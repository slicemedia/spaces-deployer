import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runSpacesCli, type SpacesOutputWriter } from "./cli.js";
import {
  SpacesDeploymentError,
  type SpacesDeploymentPlan,
  type SpacesDeploymentReceipt,
} from "./types.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("slicemedia-spaces", () => {
  const privatePlanPath = path.join(".slicemedia", "spaces-deployer", "release-1.json");

  it("identifies the standalone product in help output", async () => {
    const output: string[] = [];

    const exitCode = await runSpacesCli(["help"], {
      writer: collectingWriter(output),
    });

    expect(exitCode).toBe(0);
    expect(output[0]).toBe("Slice Media Spaces Deployer commands");
  });

  it("writes a credential-free plan with JSON output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
    temporaryDirectories.push(cwd);
    const output: string[] = [];
    const plan = samplePlan(cwd);
    const createPlan = vi.fn().mockResolvedValue(plan);

    const exitCode = await runSpacesCli(
      [
        "plan",
        "--directory",
        "dist",
        "--endpoint",
        "https://fra1.digitaloceanspaces.com",
        "--region",
        "fra1",
        "--bucket",
        "neutral-assets",
        "--prefix",
        "releases",
        "--release-version",
        "release-1",
        "--plan",
        privatePlanPath,
        "--json",
      ],
      { cwd, writer: collectingWriter(output), createPlan },
    );

    expect(exitCode).toBe(0);
    expect(createPlan).toHaveBeenCalledWith({
      directory: path.join(cwd, "dist"),
      endpoint: "https://fra1.digitaloceanspaces.com",
      region: "fra1",
      bucket: "neutral-assets",
      prefix: "releases",
      releaseVersion: "release-1",
    });
    const absolutePlanPath = path.join(cwd, privatePlanPath);
    expect(JSON.parse(await readFile(absolutePlanPath, "utf8"))).toEqual(plan);
    expect(
      await readFile(path.join(cwd, ".slicemedia", "spaces-deployer", ".gitignore"), "utf8"),
    ).toBe("*\n");
    if (process.platform !== "win32") {
      expect((await lstat(absolutePlanPath)).mode & 0o077).toBe(0);
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({ ok: true, data: { plan } });
    expect(JSON.parse(output.join("\n")).data).toEqual({ plan });
  });

  it("proves private plan storage is ignored when a Git worktree exists", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-git-test-"));
    temporaryDirectories.push(cwd);
    await git(cwd, ["init", "--quiet"]);
    const errors: string[] = [];

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan: vi.fn().mockResolvedValue(samplePlan(cwd)),
    });
    // The zero exit status is the portable proof that Git considers the path
    // ignored. Printable output is quoted on Windows because its native path
    // contains backslashes, so it is intentionally suppressed here.
    await git(cwd, ["check-ignore", "--no-index", "--quiet", "--", privatePlanPath]);

    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("requires --yes and the exact plan ID before invoking apply", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
    temporaryDirectories.push(cwd);
    const plan = samplePlan(cwd);
    const createPlan = vi.fn().mockResolvedValue(plan);
    await runSpacesCli(planArguments(), { cwd, writer: collectingWriter([]), createPlan });
    const applyPlan = vi.fn().mockResolvedValue(sampleReceipt(plan));

    const errors: string[] = [];
    expect(
      await runSpacesCli(["apply", "--plan", privatePlanPath, "--plan-id", plan.planId], {
        cwd,
        writer: collectingWriter([], errors),
        applyPlan,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain("--yes");
    expect(applyPlan).not.toHaveBeenCalled();

    expect(
      await runSpacesCli(["apply", "--plan", privatePlanPath, "--plan-id", plan.planId, "--yes"], {
        cwd,
        env: {
          DIGITALOCEAN_SPACES_ACCESS_KEY_ID: "access",
          DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY: "secret",
        },
        writer: collectingWriter([]),
        applyPlan,
      }),
    ).toBe(0);
    expect(applyPlan).toHaveBeenCalledWith(plan, {
      confirmedPlanId: plan.planId,
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    });
  });

  it("returns a machine-readable partial failure receipt only when JSON is requested", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
    temporaryDirectories.push(cwd);
    const plan = samplePlan(cwd);
    await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([]),
      createPlan: vi.fn().mockResolvedValue(plan),
    });
    const receipt: SpacesDeploymentReceipt = {
      ...sampleReceipt(plan),
      status: "failed",
      files: [{ key: plan.files[0]!.key, status: "failed", error: "verification-failed" }],
    };
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runSpacesCli(
      ["apply", "--plan", privatePlanPath, "--plan-id", plan.planId, "--yes", "--json"],
      {
        cwd,
        env: {
          DIGITALOCEAN_SPACES_ACCESS_KEY_ID: "access",
          DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY: "secret",
        },
        writer: collectingWriter(output, errors),
        applyPlan: vi
          .fn()
          .mockRejectedValue(new SpacesDeploymentError("verification failed", receipt)),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: false,
      command: "apply",
      data: { error: "verification failed", receipt },
    });

    const humanErrors: string[] = [];
    await runSpacesCli(["apply", "--plan", privatePlanPath, "--plan-id", plan.planId, "--yes"], {
      cwd,
      env: {
        DIGITALOCEAN_SPACES_ACCESS_KEY_ID: "access",
        DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY: "secret",
      },
      writer: collectingWriter([], humanErrors),
      applyPlan: vi
        .fn()
        .mockRejectedValue(new SpacesDeploymentError("verification failed", receipt)),
    });
    expect(humanErrors.join("\n")).toContain("verification failed");
    expect(humanErrors.join("\n")).not.toContain(plan.target.bucket);
    expect(humanErrors.join("\n")).not.toContain(plan.files[0]!.key);
  });

  it("rejects unknown options instead of accepting credentials on the command line", async () => {
    const errors: string[] = [];
    expect(
      await runSpacesCli([...planArguments(), "--secret-access-key", "do-not-accept"], {
        writer: collectingWriter([], errors),
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain("Unknown option --secret-access-key");
  });

  it("refuses plan paths outside private ignored storage", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
    temporaryDirectories.push(cwd);
    const createPlan = vi.fn();
    const errors: string[] = [];

    const exitCode = await runSpacesCli(
      planArguments().map((value) => (value === privatePlanPath ? "plan.json" : value)),
      { cwd, writer: collectingWriter([], errors), createPlan },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("must be stored under .slicemedia/spaces-deployer");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("fails closed when the private-storage ignore marker was weakened", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
    temporaryDirectories.push(cwd);
    const privateDirectory = path.join(cwd, ".slicemedia", "spaces-deployer");
    await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([]),
      createPlan: vi.fn().mockResolvedValue(samplePlan(cwd)),
    });
    await writeFile(path.join(privateDirectory, ".gitignore"), "!*.json\n");
    const errors: string[] = [];
    const createPlan = vi.fn();

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("exact private-storage rule");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("rechecks the ignore marker after planning and before writing plan bytes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-race-test-"));
    temporaryDirectories.push(cwd);
    const planPath = path.join(cwd, privatePlanPath);
    const errors: string[] = [];
    const createPlan = vi.fn(async () => {
      await writeFile(path.join(cwd, ".slicemedia", "spaces-deployer", ".gitignore"), "!*.json\n");
      return samplePlan(cwd);
    });

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("exact private-storage rule");
    await expect(lstat(planPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the private plan directory is group or publicly accessible",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
      temporaryDirectories.push(cwd);
      const privateDirectory = path.join(cwd, ".slicemedia", "spaces-deployer");
      await mkdir(privateDirectory, { recursive: true, mode: 0o755 });
      await chmod(privateDirectory, 0o755);
      const errors: string[] = [];
      const createPlan = vi.fn();

      const exitCode = await runSpacesCli(planArguments(), {
        cwd,
        writer: collectingWriter([], errors),
        createPlan,
      });

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("must not allow group or public access");
      expect(createPlan).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed when the .slicemedia directory is group or publicly accessible",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
      temporaryDirectories.push(cwd);
      const localDirectory = path.join(cwd, ".slicemedia");
      await mkdir(localDirectory, { mode: 0o755 });
      await chmod(localDirectory, 0o755);
      const errors: string[] = [];
      const createPlan = vi.fn();

      const exitCode = await runSpacesCli(planArguments(), {
        cwd,
        writer: collectingWriter([], errors),
        createPlan,
      });

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("must not allow group or public access");
      expect(createPlan).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed when a working-directory ancestor permits untrusted replacement",
    async () => {
      const outer = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-parent-test-"));
      temporaryDirectories.push(outer);
      const cwd = path.join(outer, "workspace");
      await mkdir(cwd, { mode: 0o700 });
      await chmod(outer, 0o777);
      const errors: string[] = [];
      const createPlan = vi.fn();

      const exitCode = await runSpacesCli(planArguments(), {
        cwd,
        writer: collectingWriter([], errors),
        createPlan,
      });

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("must not permit group or public replacement");
      expect(createPlan).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed when a nested plan ancestor is group or publicly accessible",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
      temporaryDirectories.push(cwd);
      const localDirectory = path.join(cwd, ".slicemedia");
      const privateDirectory = path.join(localDirectory, "spaces-deployer");
      const nestedDirectory = path.join(privateDirectory, "nested");
      await mkdir(localDirectory, { mode: 0o700 });
      await mkdir(privateDirectory, { mode: 0o700 });
      await mkdir(nestedDirectory, { mode: 0o755 });
      await chmod(nestedDirectory, 0o755);
      const errors: string[] = [];
      const createPlan = vi.fn();
      const nestedPlanPath = path.join(
        ".slicemedia",
        "spaces-deployer",
        "nested",
        "release-1.json",
      );

      const exitCode = await runSpacesCli(
        planArguments().map((value) => (value === privatePlanPath ? nestedPlanPath : value)),
        { cwd, writer: collectingWriter([], errors), createPlan },
      );

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("must not allow group or public access");
      expect(createPlan).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symbolic-link private storage before creating a plan",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
      const outside = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-outside-test-"));
      temporaryDirectories.push(cwd, outside);
      await symlink(outside, path.join(cwd, ".slicemedia"), "dir");
      const errors: string[] = [];
      const createPlan = vi.fn();

      const exitCode = await runSpacesCli(planArguments(), {
        cwd,
        writer: collectingWriter([], errors),
        createPlan,
      });

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("must use real directories");
      expect(createPlan).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a private-directory symlink swap before writing any plan bytes",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-race-test-"));
      const outside = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-outside-test-"));
      temporaryDirectories.push(cwd, outside);
      const privateDirectory = path.join(cwd, ".slicemedia", "spaces-deployer");
      const movedDirectory = path.join(cwd, ".slicemedia", "validated-directory");
      const errors: string[] = [];
      const createPlan = vi.fn(async () => {
        await rename(privateDirectory, movedDirectory);
        await symlink(outside, privateDirectory, "dir");
        return samplePlan(cwd);
      });

      const exitCode = await runSpacesCli(planArguments(), {
        cwd,
        writer: collectingWriter([], errors),
        createPlan,
      });

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toMatch(
        /Private plan storage (?:changed after it was validated|must use real directories)/u,
      );
      await expect(lstat(path.join(outside, "release-1.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a symbolic-link or hard-linked plan file",
    async () => {
      for (const linkType of ["symbolic", "hard"] as const) {
        const cwd = await mkdtemp(path.join(tmpdir(), `slicemedia-spaces-${linkType}-test-`));
        const outside = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-outside-test-"));
        temporaryDirectories.push(cwd, outside);
        const localDirectory = path.join(cwd, ".slicemedia");
        const privateDirectory = path.join(localDirectory, "spaces-deployer");
        const outsideFile = path.join(outside, `${linkType}-target.json`);
        const planPath = path.join(cwd, privatePlanPath);
        await mkdir(localDirectory, { mode: 0o700 });
        await mkdir(privateDirectory, { mode: 0o700 });
        await writeFile(outsideFile, "outside sentinel\n", { mode: 0o600 });
        if (linkType === "symbolic") await symlink(outsideFile, planPath, "file");
        else await link(outsideFile, planPath);
        const errors: string[] = [];

        const exitCode = await runSpacesCli(planArguments(), {
          cwd,
          writer: collectingWriter([], errors),
          createPlan: vi.fn().mockResolvedValue(samplePlan(cwd)),
        });

        expect(exitCode).toBe(1);
        expect(errors.join("\n")).toContain("must be one real, non-linked file");
        expect(await readFile(outsideFile, "utf8")).toBe("outside sentinel\n");
      }
    },
  );

  it("refuses a plan that is staged or tracked by Git", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-git-test-"));
    temporaryDirectories.push(cwd);
    await git(cwd, ["init", "--quiet"]);
    const plan = samplePlan(cwd);
    await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([]),
      createPlan: vi.fn().mockResolvedValue(plan),
    });
    await git(cwd, ["add", "--force", "--", privatePlanPath]);
    const errors: string[] = [];

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan: vi.fn(),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("tracked or staged by Git");
  }, 15_000);

  it("refuses a case-variant private plan that is staged by Git", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-git-test-"));
    temporaryDirectories.push(cwd);
    await git(cwd, ["init", "--quiet"]);
    const caseVariantPath = path.join(
      [".", "Slice", "Media"].join(""),
      ["Spaces", "Deployer"].join("-"),
      "case-variant.json",
    );
    await mkdir(path.join(cwd, path.dirname(caseVariantPath)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(cwd, caseVariantPath), "synthetic private plan fixture\n");
    await git(cwd, ["add", "--force", "--", caseVariantPath]);
    const errors: string[] = [];
    const createPlan = vi.fn();

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("tracked or staged by Git");
    expect(createPlan).not.toHaveBeenCalled();
  }, 15_000);

  it("refuses a plan path that remains in reachable Git history", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-git-test-"));
    temporaryDirectories.push(cwd);
    await git(cwd, ["init", "--quiet"]);
    await git(cwd, ["config", "user.name", "Synthetic Test"]);
    await git(cwd, ["config", "user.email", "synthetic@example.invalid"]);
    const plan = samplePlan(cwd);
    await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([]),
      createPlan: vi.fn().mockResolvedValue(plan),
    });
    await git(cwd, ["add", "--force", "--", privatePlanPath]);
    await git(cwd, ["commit", "--quiet", "-m", "add synthetic plan fixture"]);
    await git(cwd, ["rm", "--quiet", "--cached", "--", privatePlanPath]);
    await git(cwd, ["commit", "--quiet", "-m", "remove synthetic plan fixture"]);
    const errors: string[] = [];

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan: vi.fn(),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("reachable Git history");
  }, 15_000);

  it("refuses a case-variant private plan that remains in reachable Git history", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-git-test-"));
    temporaryDirectories.push(cwd);
    await git(cwd, ["init", "--quiet"]);
    await git(cwd, ["config", "user.name", "Synthetic Test"]);
    await git(cwd, ["config", "user.email", "synthetic@example.invalid"]);
    const caseVariantPath = path.join(
      [".", "Slice", "Media"].join(""),
      ["Spaces", "Deployer"].join("-"),
      "case-variant.json",
    );
    await mkdir(path.join(cwd, path.dirname(caseVariantPath)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(cwd, caseVariantPath), "synthetic private plan fixture\n");
    await git(cwd, ["add", "--force", "--", caseVariantPath]);
    await git(cwd, ["commit", "--quiet", "-m", "add case-variant synthetic fixture"]);
    await git(cwd, ["rm", "--quiet", "--", caseVariantPath]);
    await git(cwd, ["commit", "--quiet", "-m", "remove case-variant synthetic fixture"]);
    const errors: string[] = [];
    const createPlan = vi.fn();

    const exitCode = await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([], errors),
      createPlan,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("reachable Git history");
    expect(createPlan).not.toHaveBeenCalled();
  }, 15_000);

  it.runIf(process.platform !== "win32")(
    "refuses to apply a plan with group or public permissions",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
      temporaryDirectories.push(cwd);
      const plan = samplePlan(cwd);
      await runSpacesCli(planArguments(), {
        cwd,
        writer: collectingWriter([]),
        createPlan: vi.fn().mockResolvedValue(plan),
      });
      await chmod(path.join(cwd, privatePlanPath), 0o644);
      const errors: string[] = [];
      const applyPlan = vi.fn();

      const exitCode = await runSpacesCli(
        ["apply", "--plan", privatePlanPath, "--plan-id", plan.planId, "--yes"],
        {
          cwd,
          env: {
            DIGITALOCEAN_SPACES_ACCESS_KEY_ID: "access",
            DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY: "secret",
          },
          writer: collectingWriter([], errors),
          applyPlan,
        },
      );

      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("must not allow group or public access");
      expect(applyPlan).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized local plan before parsing or applying it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "slicemedia-spaces-cli-test-"));
    temporaryDirectories.push(cwd);
    const plan = samplePlan(cwd);
    await runSpacesCli(planArguments(), {
      cwd,
      writer: collectingWriter([]),
      createPlan: vi.fn().mockResolvedValue(plan),
    });
    await truncate(path.join(cwd, privatePlanPath), 16 * 1024 * 1024 + 1);
    const errors: string[] = [];
    const applyPlan = vi.fn();

    const exitCode = await runSpacesCli(
      ["apply", "--plan", privatePlanPath, "--plan-id", plan.planId, "--yes"],
      {
        cwd,
        env: {
          DIGITALOCEAN_SPACES_ACCESS_KEY_ID: "access",
          DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY: "secret",
        },
        writer: collectingWriter([], errors),
        applyPlan,
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("local file limit");
    expect(applyPlan).not.toHaveBeenCalled();
  });
});

function planArguments(): string[] {
  return [
    "plan",
    "--directory",
    "dist",
    "--endpoint",
    "https://fra1.digitaloceanspaces.com",
    "--region",
    "fra1",
    "--bucket",
    "neutral-assets",
    "--prefix",
    "releases",
    "--release-version",
    "release-1",
    "--plan",
    path.join(".slicemedia", "spaces-deployer", "release-1.json"),
  ];
}

function samplePlan(cwd: string): SpacesDeploymentPlan {
  const artifactSetDigest = `sha256-${"a".repeat(64)}`;
  return {
    schemaVersion: 2,
    planId: "spaces-plan-id",
    sourceDirectory: path.join(cwd, "dist"),
    target: {
      endpoint: "https://fra1.digitaloceanspaces.com",
      region: "fra1",
      bucket: "neutral-assets",
      prefix: "releases",
    },
    releaseVersion: "release-1",
    artifactSetDigest,
    files: [
      {
        relativePath: "project.js",
        key: `releases/release-1/${artifactSetDigest}/project.js`,
        size: 1,
        sha384: `sha384-${"A".repeat(64)}`,
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  };
}

function sampleReceipt(plan: SpacesDeploymentPlan): SpacesDeploymentReceipt {
  return {
    schemaVersion: 2,
    operation: "slicemedia.spaces-deployer.deploy",
    status: "applied",
    planId: plan.planId,
    target: plan.target,
    releaseVersion: plan.releaseVersion,
    artifactSetDigest: plan.artifactSetDigest,
    timestamp: "2026-08-12T12:00:00.000Z",
    files: [{ key: plan.files[0]!.key, status: "uploaded" }],
  };
}

function collectingWriter(info: string[], errors: string[] = []): SpacesOutputWriter {
  return {
    info: (value) => info.push(value),
    error: (value) => errors.push(value),
  };
}

async function git(cwd: string, args: readonly string[]) {
  return execFileAsync("git", [...args], { cwd, encoding: "utf8" });
}
