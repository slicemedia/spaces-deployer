import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(repositoryRoot, ".npm-release");
const archivePath = resolve(releaseDirectory, "package.tgz");
const receiptPath = resolve(releaseDirectory, "receipt.json");

export function calculateArchiveHashes(contents) {
  return {
    integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    shasum: createHash("sha1").update(contents).digest("hex"),
  };
}

export function validatePackResult(result, manifest, hashes) {
  const errors = [];
  if (result?.name !== manifest.name) errors.push("npm pack returned an unexpected package name.");
  if (result?.version !== manifest.version) errors.push("npm pack returned an unexpected version.");
  if (typeof result?.filename !== "string" || basename(result.filename) !== result.filename) {
    errors.push("npm pack returned an unsafe archive filename.");
  }
  if (result?.integrity !== hashes.integrity)
    errors.push("npm pack integrity does not match the archive.");
  if (result?.shasum !== hashes.shasum) errors.push("npm pack shasum does not match the archive.");
  return errors;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  if (manifest.name !== "@slicemedia/spaces-deployer" || manifest.private !== false) {
    throw new Error("Release archive requires the reviewed public Spaces Deployer manifest.");
  }
  const npmVersion = (await run("npm", ["--version"])).trim();
  if (npmVersion !== "11.19.0") throw new Error("Release archive requires npm 11.19.0 exactly.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "slicemedia-npm-pack-"));
  try {
    const output = await run("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryDirectory,
    ]);
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error("npm pack must return exactly one archive record.");
    }
    const result = parsed[0];
    if (typeof result?.filename !== "string" || basename(result.filename) !== result.filename) {
      throw new Error("npm pack returned an unsafe archive filename.");
    }
    const temporaryArchive = resolve(temporaryDirectory, result?.filename ?? "");
    const contents = await readFile(temporaryArchive);
    const hashes = calculateArchiveHashes(contents);
    const errors = validatePackResult(result, manifest, hashes);
    if (errors.length > 0) throw new Error(errors.join("\n"));

    const sourceCommit = (await run("git", ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Unable to record source commit.");

    await rm(releaseDirectory, { force: true, recursive: true });
    await mkdir(releaseDirectory, { mode: 0o700 });
    await copyFile(temporaryArchive, archivePath, constants.COPYFILE_EXCL);
    await writeFile(
      receiptPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: manifest.name,
          version: manifest.version,
          archive: ".npm-release/package.tgz",
          integrity: hashes.integrity,
          npmVersion,
          shasum: hashes.shasum,
          sourceCommit,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.info(
      `Prepared ${manifest.name}@${manifest.version} as one integrity-recorded archive.`,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, CI: "1" },
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
      if (code === 0) resolvePromise(stdout);
      else
        rejectPromise(new Error(`${command} failed with status ${code ?? "unknown"}.\n${stderr}`));
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
