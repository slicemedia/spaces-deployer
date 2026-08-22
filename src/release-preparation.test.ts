import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../scripts/assert-release-preparation-safe.mjs");

function runGuard(overrides: NodeJS.ProcessEnv = {}) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_REPOSITORY: "slicemedia/spaces-deployer",
    GITHUB_REPOSITORY_VISIBILITY: "private",
    ...overrides,
  };
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_TOKEN;
  if (overrides.NODE_AUTH_TOKEN !== undefined) {
    environment.NODE_AUTH_TOKEN = overrides.NODE_AUTH_TOKEN;
  }
  if (overrides.NPM_TOKEN !== undefined) environment.NPM_TOKEN = overrides.NPM_TOKEN;

  return spawnSync(process.execPath, [script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: environment,
  });
}

describe("private release preparation guard", () => {
  it("accepts version-PR-only preparation for the private repository", () => {
    const result = runGuard();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm publication is disabled");
  });

  it("accepts version-PR-only preparation for the public repository", () => {
    const result = runGuard({ GITHUB_REPOSITORY_VISIBILITY: "public" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm publication is disabled");
  });

  it("fails closed when repository visibility is missing or unsupported", () => {
    const result = runGuard({ GITHUB_REPOSITORY_VISIBILITY: "internal" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires an explicit private or public repository visibility");
  });

  it("rejects npm credentials in the version-PR environment", () => {
    const result = runGuard({ NPM_TOKEN: "synthetic-token-that-must-not-be-used" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NPM_TOKEN must not be available");
  });

  it("fails closed when repository identity is missing or unexpected", () => {
    const missing = runGuard({ GITHUB_REPOSITORY: "" });
    const unexpected = runGuard({ GITHUB_REPOSITORY: "example/spaces-deployer" });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("restricted to slicemedia/spaces-deployer");
    expect(unexpected.status).not.toBe(0);
    expect(unexpected.stderr).toContain("restricted to slicemedia/spaces-deployer");
  });
});
