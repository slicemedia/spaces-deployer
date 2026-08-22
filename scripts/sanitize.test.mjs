import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { parse } from "yaml";

const sanitizer = fileURLToPath(new URL("./sanitize.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const privateTerm = "retired-product-name";

test("detects private terms and runtime-derived encodings without printing their values", async () => {
  const encodings = [
    privateTerm,
    Buffer.from(privateTerm, "utf8").toString("base64"),
    Buffer.from(privateTerm.toLocaleUpperCase("en-US"), "utf8").toString("base64"),
    Buffer.from(privateTerm, "utf8").toString("base64url"),
    Buffer.from(privateTerm, "utf8").toString("hex").toLocaleUpperCase("en-US"),
  ];

  for (const [index, encoding] of encodings.entries()) {
    await withFixture(`content-${index}.txt`, encoding, async (directory) => {
      const run = await runSanitizer(directory, { terms: [privateTerm] });
      assert.equal(run.code, 1);
      assert.equal(run.result.ok, false);
      assert.ok(run.result.findings.some(({ kind }) => kind.startsWith("private rule 1")));
      const output = `${run.stdout}\n${run.stderr}`;
      assert.doesNotMatch(output, new RegExp(escapeRegExp(privateTerm), "iu"));
      assert.doesNotMatch(output, new RegExp(escapeRegExp(encoding), "u"));
    });
  }

  await withFixture(`${privateTerm}.txt`, "fixture", async (directory) => {
    const run = await runSanitizer(directory, { terms: [privateTerm] });
    assert.equal(run.code, 1);
    assert.ok(run.result.findings.some(({ file }) => file === "[redacted path]"));
    assert.doesNotMatch(run.stdout, new RegExp(escapeRegExp(privateTerm), "iu"));
  });
});

test("fails closed when a protected gate has no private denylist", async () => {
  await withFixture("fixture.txt", "safe fixture", async (directory) => {
    const run = await runSanitizer(directory, { required: true });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /private forbidden-term JSON array is required/u);
  });
});

test("rejects invalid private input without echoing it", async () => {
  const invalidInput = "sensitive-invalid-input";
  await withFixture("fixture.txt", "safe fixture", async (directory) => {
    const run = await runSanitizer(directory, { rawTerms: invalidInput, required: true });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /must be a valid JSON array/u);
    assert.doesNotMatch(run.stderr, new RegExp(escapeRegExp(invalidInput), "u"));
  });
});

test("loads an ignored local JSON denylist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "spaces-deployer-local-denylist-"));
  try {
    await mkdir(path.join(directory, ".private"));
    await writeFile(
      path.join(directory, ".private/denylist"),
      `${JSON.stringify([privateTerm])}\n`,
      "utf8",
    );
    await mkdir(path.join(directory, "nested/.private"), { recursive: true });
    await writeFile(path.join(directory, "fixture.txt"), "safe fixture", "utf8");
    await writeFile(path.join(directory, "nested/.private/fixture.txt"), privateTerm, "utf8");
    const run = await runSanitizer(directory, { cwd: directory, required: true });
    assert.equal(run.code, 1);
    assert.ok(run.result.findings.some(({ kind }) => kind.startsWith("private rule 1")));
    assert.doesNotMatch(run.stdout, new RegExp(escapeRegExp(privateTerm), "iu"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects every noncanonical compact brand casing", async () => {
  const variants = nonCanonicalCompactCaseVariants();
  const directory = await mkdtemp(path.join(tmpdir(), "spaces-deployer-brand-casing-"));
  try {
    for (const [index, variant] of variants.entries()) {
      await writeFile(path.join(directory, `variant-${index}.txt`), variant, "utf8");
    }
    const run = await runSanitizer(directory);
    assert.equal(run.code, 1);
    assert.equal(run.result.findings.length, variants.length);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("allows canonical branding and neutral Webflow terminology", async () => {
  const allowed = [
    "Slice Media Spaces Deployer",
    "@slicemedia/spaces-deployer",
    "github.com/slicemedia/spaces-deployer",
    "SLICEMEDIA_FORBIDDEN_TERMS",
    "window.slicemedia",
    "Webflow CMS and Designer integration",
    "Slice\nMedia",
  ].join("\n");

  await withFixture("allowed.txt", allowed, async (directory) => {
    const run = await runSanitizer(directory);
    assert.equal(run.code, 0, JSON.stringify(run.result?.findings));
    assert.equal(run.result.ok, true);
    assert.deepEqual(run.result.findings, []);
  });
});

test("pull-request CI is secret-free and the main private scan uses its protected environment", async () => {
  const ciSource = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ciSource, /\bsecrets\s*\./u);
  const ciWorkflow = parse(ciSource);
  assert.deepEqual(ciWorkflow.jobs.validate.steps[1], {
    run: "node scripts/sanitize.mjs",
  });

  const privateWorkflow = parse(
    await readFile(path.join(repositoryRoot, ".github/workflows/private-sanitize.yml"), "utf8"),
  );
  assert.deepEqual(privateWorkflow, {
    name: "Private sanitization",
    on: { push: { branches: ["main"] } },
    permissions: { contents: "read" },
    jobs: {
      sanitize: {
        if: "github.repository == 'slicemedia/spaces-deployer' && github.ref == 'refs/heads/main'",
        environment: "release-sanitize",
        "runs-on": "ubuntu-latest",
        steps: [
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: { "persist-credentials": false },
          },
          {
            run: "node scripts/sanitize.mjs",
            env: {
              SLICEMEDIA_FORBIDDEN_TERMS: "${{ secrets.SLICEMEDIA_FORBIDDEN_TERMS }}",
              SLICEMEDIA_REQUIRE_FORBIDDEN_TERMS: "true",
            },
          },
        ],
      },
    },
  });
});

async function withFixture(name, contents, verify) {
  const directory = await mkdtemp(path.join(tmpdir(), "spaces-deployer-sanitize-"));
  try {
    await writeFile(path.join(directory, name), contents, "utf8");
    await verify(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function runSanitizer(root, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment = { ...process.env };
    delete environment.SLICEMEDIA_FORBIDDEN_TERMS;
    delete environment.SLICEMEDIA_REQUIRE_FORBIDDEN_TERMS;
    if (options.terms !== undefined) {
      environment.SLICEMEDIA_FORBIDDEN_TERMS = JSON.stringify(options.terms);
    }
    if (options.rawTerms !== undefined) {
      environment.SLICEMEDIA_FORBIDDEN_TERMS = options.rawTerms;
    }
    if (options.required === true) environment.SLICEMEDIA_REQUIRE_FORBIDDEN_TERMS = "true";
    const child = spawn(process.execPath, [sanitizer, "--root", root, "--json"], {
      cwd: options.cwd ?? repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      let result = null;
      if (stdout.trim()) result = JSON.parse(stdout);
      resolvePromise({ code, result, stderr, stdout });
    });
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function nonCanonicalCompactCaseVariants() {
  const canonical = "slicemedia";
  const uppercase = canonical.toLocaleUpperCase("en-US");
  const variants = [];
  for (let mask = 0; mask < 2 ** canonical.length; mask += 1) {
    const candidate = [...canonical]
      .map((character, index) =>
        (mask & (1 << index)) === 0 ? character : character.toLocaleUpperCase("en-US"),
      )
      .join("");
    if (candidate !== canonical && candidate !== uppercase) variants.push(candidate);
  }
  return variants;
}
