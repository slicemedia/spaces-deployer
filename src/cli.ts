import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { applyDeploymentPlan, createDeploymentPlan } from "./deployment.js";
import {
  SpacesDeploymentError,
  type ApplyDeploymentPlanOptions,
  type CreateDeploymentPlanOptions,
  type SpacesDeploymentPlan,
} from "./types.js";

export interface SpacesOutputWriter {
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
}

export interface SpacesCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly writer?: SpacesOutputWriter;
  readonly createPlan?: typeof createDeploymentPlan;
  readonly applyPlan?: typeof applyDeploymentPlan;
}

interface CliResult<T = unknown> {
  readonly ok: boolean;
  readonly command: string;
  readonly summary: string;
  readonly data: T;
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

const outputWriter: SpacesOutputWriter = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

// Keep this relative path in documented, CLI-friendly form. Node accepts forward
// slashes on every supported platform, while path.resolve() still produces the
// native absolute path used for filesystem security checks.
const PRIVATE_PLAN_DIRECTORY = ".slicemedia/spaces-deployer";
const PRIVATE_IGNORE_CONTENTS = "*\n";
const MAX_PRIVATE_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_IGNORE_BYTES = 32;

interface DirectoryIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly private: boolean;
}

interface PrivatePlanStorage {
  readonly cwd: string;
  readonly privateDirectory: string;
  readonly planParent: string;
  readonly planPath: string;
  readonly directories: readonly DirectoryIdentity[];
}

export async function runSpacesCli(
  argv: readonly string[],
  dependencies: SpacesCliDependencies = {},
): Promise<number> {
  const writer = dependencies.writer ?? outputWriter;
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    writer.error(`[ERROR] ${message(error)}`);
    return 1;
  }
  const json = parsed.flags.has("json");
  const command = parsed.positionals[0] ?? "help";
  try {
    const result = await dispatch(command, parsed, {
      cwd: path.resolve(dependencies.cwd ?? process.cwd()),
      env: dependencies.env ?? process.env,
      createPlan: dependencies.createPlan ?? createDeploymentPlan,
      applyPlan: dependencies.applyPlan ?? applyDeploymentPlan,
    });
    writeResult(result, json, writer);
    return result.ok ? 0 : 1;
  } catch (error) {
    const errorMessage = message(error);
    const result: CliResult<{ readonly error: string; readonly receipt?: unknown }> = {
      ok: false,
      command,
      summary: errorMessage,
      data: {
        error: errorMessage,
        ...(error instanceof SpacesDeploymentError ? { receipt: error.receipt } : {}),
      },
    };
    if (json) writeResult(result, true, writer);
    else writer.error(`[ERROR] ${errorMessage}`);
    return 1;
  }
}

interface DispatchContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly createPlan: typeof createDeploymentPlan;
  readonly applyPlan: typeof applyDeploymentPlan;
}

async function dispatch(
  command: string,
  args: ParsedArguments,
  context: DispatchContext,
): Promise<CliResult> {
  if (command === "help" || args.flags.has("help")) {
    return {
      ok: true,
      command: "help",
      summary: "Slice Media Spaces Deployer commands",
      data: [
        "plan --directory <dir> --endpoint <url> --region <region> --bucket <bucket> --prefix <prefix> --release-version <version> --plan .slicemedia/spaces-deployer/<file>.json",
        "apply --plan .slicemedia/spaces-deployer/<file>.json --plan-id <id> --yes",
      ],
    };
  }

  if (command === "plan") {
    assertCommandShape(args, {
      options: ["bucket", "directory", "endpoint", "plan", "prefix", "region", "release-version"],
      flags: ["json"],
    });
    const planPath = resolvePlanPath(context.cwd, requireOption(args, "plan"));
    const storage = await preparePrivatePlanStorage(context.cwd, planPath);
    const prefix = args.options.get("prefix");
    if (prefix === undefined || prefix.trim() === "") throw new Error("Provide --prefix.");
    const options: CreateDeploymentPlanOptions = {
      directory: path.resolve(context.cwd, requireOption(args, "directory")),
      endpoint: requireOption(args, "endpoint"),
      region: requireOption(args, "region"),
      bucket: requireOption(args, "bucket"),
      prefix,
      releaseVersion: requireOption(args, "release-version"),
    };
    const plan = await context.createPlan(options);
    await writePlan(storage, plan);
    await assertPrivateStorageUnchanged(storage);
    await assertPrivateIgnoreMarker(storage);
    await assertPrivatePlanGitState(
      context.cwd,
      path.resolve(context.cwd, PRIVATE_PLAN_DIRECTORY),
      planPath,
    );
    return {
      ok: true,
      command: "plan",
      summary: `Planned ${plan.files.length} content-addressed object(s) as ${plan.planId}.`,
      data: { plan },
    };
  }

  if (command === "apply") {
    assertCommandShape(args, {
      options: ["plan", "plan-id"],
      flags: ["json", "yes"],
    });
    if (!args.flags.has("yes")) throw new Error("Apply requires explicit --yes confirmation.");
    const confirmedPlanId = requireOption(args, "plan-id");
    const planPath = resolvePlanPath(context.cwd, requireOption(args, "plan"));
    const storage = await preparePrivatePlanStorage(context.cwd, planPath);
    const plan = JSON.parse(await readPrivatePlan(storage)) as SpacesDeploymentPlan;
    const credentials = credentialsFromEnvironment(context.env);
    const applyOptions: ApplyDeploymentPlanOptions = { confirmedPlanId, credentials };
    const receipt = await context.applyPlan(plan, applyOptions);
    const uploaded = receipt.files.filter((file) => file.status === "uploaded").length;
    const skipped = receipt.files.filter((file) => file.status === "skipped").length;
    return {
      ok: true,
      command: "apply",
      summary: `Uploaded ${uploaded} versioned object(s); skipped ${skipped} matching object(s).`,
      data: receipt,
    };
  }

  throw new Error(`Unknown command ${JSON.stringify(command)}. Run slicemedia-spaces help.`);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const booleanOptions = new Set(["help", "json", "yes"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equalsAt = value.indexOf("=");
    const name = value.slice(2, equalsAt === -1 ? undefined : equalsAt);
    if (name === "") throw new Error("Invalid empty option name.");
    if (booleanOptions.has(name)) {
      if (equalsAt !== -1) throw new Error(`--${name} does not accept a value.`);
      flags.add(name);
      continue;
    }
    const inline = equalsAt === -1 ? undefined : value.slice(equalsAt + 1);
    const next = argv[index + 1];
    const optionValue = inline ?? next;
    if (optionValue === undefined || (inline === undefined && optionValue.startsWith("--"))) {
      throw new Error(`--${name} requires a value.`);
    }
    if (inline === undefined) index += 1;
    if (options.has(name)) throw new Error(`--${name} may be provided only once.`);
    options.set(name, optionValue);
  }
  return { positionals, options, flags };
}

function requireOption(args: ParsedArguments, name: string): string {
  const value = args.options.get(name);
  if (value === undefined || value.trim() === "") throw new Error(`Provide --${name}.`);
  return value;
}

function assertCommandShape(
  args: ParsedArguments,
  allowed: { readonly options: readonly string[]; readonly flags: readonly string[] },
): void {
  if (args.positionals.length !== 1) throw new Error("Unexpected positional argument.");
  const allowedOptions = new Set(allowed.options);
  for (const name of args.options.keys()) {
    if (!allowedOptions.has(name)) throw new Error(`Unknown option --${name}.`);
  }
  const allowedFlags = new Set(allowed.flags);
  for (const name of args.flags) {
    if (!allowedFlags.has(name)) throw new Error(`Unknown flag --${name}.`);
  }
}

function resolvePlanPath(cwd: string, value: string): string {
  const privateDirectory = path.resolve(cwd, PRIVATE_PLAN_DIRECTORY);
  const planPath = path.resolve(cwd, value);
  const relative = path.relative(privateDirectory, planPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Deployment plans must be stored under ${PRIVATE_PLAN_DIRECTORY} so local paths and deployment targets remain ignored.`,
    );
  }
  if (path.extname(planPath).toLowerCase() !== ".json") {
    throw new Error("Deployment plan files must use the .json extension.");
  }
  return planPath;
}

async function writePlan(storage: PrivatePlanStorage, plan: SpacesDeploymentPlan): Promise<void> {
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  assertBoundedPrivateContents(serialized, MAX_PRIVATE_PLAN_BYTES, "Deployment plan");
  await assertPrivateIgnoreMarker(storage);
  try {
    await writePrivateFileExclusive(storage, storage.planPath, serialized);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readPrivatePlan(storage);
    if (existing !== serialized) {
      throw new Error("Refusing to replace a different deployment plan.", {
        cause: error,
      });
    }
  }
}

async function assertPrivatePlanGitState(
  cwd: string,
  privateDirectory: string,
  planPath: string,
): Promise<void> {
  const gitRoot = await resolveGitRoot(cwd);
  if (gitRoot === undefined) return;

  const canonicalPrivateDirectory = await realpath(privateDirectory);
  const canonicalPlanPath = path.join(
    await realpath(path.dirname(planPath)),
    path.basename(planPath),
  );
  const relativePlan = toGitPath(path.relative(gitRoot, canonicalPlanPath));
  const relativePrivateDirectory = toGitPath(path.relative(gitRoot, canonicalPrivateDirectory));
  if (
    relativePlan === "" ||
    relativePlan.startsWith("../") ||
    relativePrivateDirectory === "" ||
    relativePrivateDirectory.startsWith("../")
  ) {
    throw new Error("Private plan storage must remain inside the current Git worktree.");
  }

  // A case-insensitive, worktree-rooted literal pathspec is intentional here.
  // On case-insensitive filesystems, a differently cased historical or staged
  // spelling can alias the private directory even though Git records it verbatim.
  const privatePathspec = `:(top,icase,literal)${relativePrivateDirectory}`;
  const tracked = await runGit(gitRoot, ["ls-files", "--", privatePathspec]);
  if (!tracked.available || tracked.code !== 0) {
    throw new Error("Could not verify whether private deployment plans are tracked by Git.");
  }
  if (tracked.stdout.trim() !== "") {
    throw new Error(
      "Refusing private deployment storage because a plan is tracked or staged by Git.",
    );
  }

  const history = await runGit(gitRoot, [
    "log",
    "--all",
    "--max-count=1",
    "--format=%H",
    "--",
    privatePathspec,
  ]);
  if (!history.available || history.code !== 0) {
    throw new Error("Could not verify private deployment-plan history.");
  }
  if (history.stdout.trim() !== "") {
    throw new Error(
      "Refusing private deployment storage because a plan remains in reachable Git history.",
    );
  }

  const ignored = await runGit(gitRoot, [
    "check-ignore",
    "--no-index",
    "--quiet",
    "--",
    relativePlan,
  ]);
  if (!ignored.available || ignored.code !== 0) {
    throw new Error("Refusing deployment plan storage because Git does not confirm it is ignored.");
  }
}

async function resolveGitRoot(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.available && result.code === 0) {
    const root = result.stdout.trim();
    if (root === "" || !path.isAbsolute(root)) {
      throw new Error("Git returned an invalid worktree root while checking private plan storage.");
    }
    return realpath(root);
  }
  if (await hasGitMetadata(cwd)) {
    throw new Error("Could not verify private deployment-plan safety in this Git worktree.");
  }
  return undefined;
}

async function hasGitMetadata(start: string): Promise<boolean> {
  let directory = path.resolve(start);
  while (true) {
    try {
      await lstat(path.join(directory, ".git"));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

interface GitResult {
  readonly available: boolean;
  readonly code: number;
  readonly stdout: string;
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error === null) {
        resolve({ available: true, code: 0, stdout });
        return;
      }
      if (error.code === "ENOENT") {
        resolve({ available: false, code: -1, stdout: "" });
        return;
      }
      if (typeof error.code === "number") {
        resolve({ available: true, code: error.code, stdout });
        return;
      }
      reject(
        new Error("Could not execute Git while checking private plan storage.", { cause: error }),
      );
    });
  });
}

function toGitPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function preparePrivatePlanStorage(
  cwd: string,
  planPath: string,
): Promise<PrivatePlanStorage> {
  const localDirectory = path.resolve(cwd, ".slicemedia");
  const privateDirectory = path.resolve(cwd, PRIVATE_PLAN_DIRECTORY);
  await assertWorkspaceDirectory(cwd);
  await ensureRealDirectory(localDirectory, 0o700, true);
  await ensureRealDirectory(privateDirectory, 0o700, true);

  const planParent = path.dirname(planPath);
  const relativeParent = path.relative(privateDirectory, planParent);
  let current = privateDirectory;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await ensureRealDirectory(current, 0o700, true);
  }

  const directories = await capturePrivateDirectoryChain(
    cwd,
    localDirectory,
    privateDirectory,
    planParent,
  );
  const storage: PrivatePlanStorage = {
    cwd,
    privateDirectory,
    planParent,
    planPath,
    directories,
  };
  await assertPrivateStorageUnchanged(storage);

  const ignorePath = path.join(privateDirectory, ".gitignore");
  try {
    await writePrivateFileExclusive(storage, ignorePath, PRIVATE_IGNORE_CONTENTS);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await assertPrivateIgnoreMarker(storage);
  await assertPrivateStorageUnchanged(storage);
  await assertPrivatePlanGitState(cwd, privateDirectory, planPath);
  return storage;
}

async function ensureRealDirectory(
  directory: string,
  mode: number,
  requirePrivatePermissions: boolean,
): Promise<void> {
  try {
    await mkdir(directory, { mode });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Private plan storage must use real directories.");
  }
  if (requirePrivatePermissions && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Private plan directories must not allow group or public access.");
  }
  assertCurrentUserOwns(stats, "Private plan directories");
}

async function readPrivatePlan(storage: PrivatePlanStorage): Promise<string> {
  return readPrivateFile(storage, storage.planPath, MAX_PRIVATE_PLAN_BYTES, "Deployment plan");
}

async function assertPrivateIgnoreMarker(storage: PrivatePlanStorage): Promise<void> {
  const existing = await readPrivateFile(
    storage,
    path.join(storage.privateDirectory, ".gitignore"),
    MAX_IGNORE_BYTES,
    "Private plan ignore marker",
  );
  if (existing !== PRIVATE_IGNORE_CONTENTS) {
    throw new Error(
      "Refusing private plan storage because its .gitignore does not contain the exact private-storage rule.",
    );
  }
}

async function assertWorkspaceDirectory(cwd: string): Promise<void> {
  const stats = await lstat(cwd);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Private plan storage requires a real working directory.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error("The working directory must not allow group or public writes.");
  }
  assertCurrentUserOwns(stats, "The working directory");
  await assertSafeWorkspaceAncestors(cwd);
}

async function capturePrivateDirectoryChain(
  cwd: string,
  localDirectory: string,
  privateDirectory: string,
  planParent: string,
): Promise<readonly DirectoryIdentity[]> {
  const paths = [cwd, localDirectory, privateDirectory];
  const relativeParent = path.relative(privateDirectory, planParent);
  let current = privateDirectory;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }

  const identities: DirectoryIdentity[] = [];
  for (const directory of paths) {
    if (identities.some((identity) => identity.path === directory)) continue;
    identities.push(await captureDirectoryIdentity(directory, directory !== cwd));
  }
  assertCanonicalContainment(identities, cwd, privateDirectory, planParent);
  return identities;
}

async function captureDirectoryIdentity(
  directory: string,
  requirePrivatePermissions: boolean,
): Promise<DirectoryIdentity> {
  const stats = await lstat(directory, { bigint: true });
  assertSafeDirectoryStats(stats, requirePrivatePermissions);
  return {
    path: directory,
    realPath: await realpath(directory),
    device: stats.dev,
    inode: stats.ino,
    private: requirePrivatePermissions,
  };
}

async function assertPrivateStorageUnchanged(storage: PrivatePlanStorage): Promise<void> {
  await assertSafeWorkspaceAncestors(storage.cwd);
  for (const identity of storage.directories) {
    const stats = await lstat(identity.path, { bigint: true }).catch((error: unknown) => {
      throw new Error("Private plan storage changed after it was validated.", { cause: error });
    });
    assertSafeDirectoryStats(stats, identity.private);
    const currentRealPath = await realpath(identity.path);
    if (
      stats.dev !== identity.device ||
      stats.ino !== identity.inode ||
      currentRealPath !== identity.realPath
    ) {
      throw new Error("Private plan storage changed after it was validated.");
    }
  }
  assertCanonicalContainment(
    storage.directories,
    storage.cwd,
    storage.privateDirectory,
    storage.planParent,
  );
  if (path.dirname(storage.planPath) !== storage.planParent) {
    throw new Error("Deployment plan parent changed after validation.");
  }
}

async function assertSafeWorkspaceAncestors(cwd: string): Promise<void> {
  if (process.platform === "win32") return;
  const currentUser = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : undefined;
  let child = await realpath(cwd);
  let visited = 0;
  while (true) {
    const parent = path.dirname(child);
    if (parent === child) return;
    visited += 1;
    if (visited > 256) throw new Error("Working-directory ancestor traversal exceeded its limit.");

    const parentStats = await lstat(parent, { bigint: true });
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new Error("Working-directory ancestors must use real directories.");
    }
    const trustedParentOwner =
      currentUser !== undefined && (parentStats.uid === currentUser || parentStats.uid === 0n);
    if (!trustedParentOwner) {
      throw new Error("Working-directory ancestors must be owned by the current user or root.");
    }
    if ((parentStats.mode & 0o022n) !== 0n) {
      const childStats = await lstat(child, { bigint: true });
      const sticky = (parentStats.mode & 0o1000n) !== 0n;
      const trustedChildOwner =
        currentUser !== undefined && (childStats.uid === currentUser || childStats.uid === 0n);
      if (!sticky || !trustedChildOwner) {
        throw new Error("Working-directory ancestors must not permit group or public replacement.");
      }
    }
    child = parent;
  }
}

function assertSafeDirectoryStats(stats: BigIntStats, requirePrivatePermissions: boolean): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Private plan storage must use real directories.");
  }
  if (process.platform !== "win32") {
    const prohibited = requirePrivatePermissions ? 0o077n : 0o022n;
    if ((stats.mode & prohibited) !== 0n) {
      throw new Error(
        requirePrivatePermissions
          ? "Private plan directories must not allow group or public access."
          : "The working directory must not allow group or public writes.",
      );
    }
  }
  assertCurrentUserOwns(
    stats,
    requirePrivatePermissions ? "Private plan directories" : "The working directory",
  );
}

function assertCanonicalContainment(
  directories: readonly DirectoryIdentity[],
  cwd: string,
  privateDirectory: string,
  planParent: string,
): void {
  const cwdIdentity = directories.find((identity) => identity.path === cwd);
  const privateIdentity = directories.find((identity) => identity.path === privateDirectory);
  const parentIdentity = directories.find((identity) => identity.path === planParent);
  if (
    cwdIdentity === undefined ||
    privateIdentity === undefined ||
    parentIdentity === undefined ||
    !isContainedPath(cwdIdentity.realPath, privateIdentity.realPath) ||
    !isContainedPath(privateIdentity.realPath, parentIdentity.realPath)
  ) {
    throw new Error("Private plan storage must remain inside the validated working directory.");
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function writePrivateFileExclusive(
  storage: PrivatePlanStorage,
  target: string,
  contents: string,
): Promise<void> {
  // Node has no openat-style create relative to a retained directory handle. These identity checks
  // narrow the path race around O_NOFOLLOW; owner-only directories establish the remaining
  // assumption that no competing process under the same OS user replaces the chain concurrently.
  assertPrivateTarget(storage, target);
  await assertPrivateStorageUnchanged(storage);
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(target, flags, 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafePrivateFileStats(opened, "Private file");
    await assertPrivateStorageUnchanged(storage);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    const completed = await handle.stat({ bigint: true });
    assertSafePrivateFileStats(completed, "Private file");
    if (
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== BigInt(Buffer.byteLength(contents, "utf8"))
    ) {
      throw new Error("Private file changed while it was being written.");
    }
    await assertPrivateStorageUnchanged(storage);
  } finally {
    await handle.close();
  }
}

async function readPrivateFile(
  storage: PrivatePlanStorage,
  target: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  assertPrivateTarget(storage, target);
  await assertPrivateStorageUnchanged(storage);
  const before = await lstat(target, { bigint: true });
  assertSafePrivateFileStats(before, label);
  assertBoundedPrivateSize(before.size, maximumBytes, label);

  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(target, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafePrivateFileStats(opened, label);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    assertBoundedPrivateSize(opened.size, maximumBytes, label);
    await assertPrivateStorageUnchanged(storage);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte local file limit.`);
    }

    const completed = await handle.stat({ bigint: true });
    if (
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== opened.size ||
      completed.size !== BigInt(totalBytes)
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    await assertPrivateStorageUnchanged(storage);
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

function assertPrivateTarget(storage: PrivatePlanStorage, target: string): void {
  const parent = path.dirname(target);
  if (
    !storage.directories.some((identity) => identity.path === parent) ||
    !isContainedPath(storage.privateDirectory, target)
  ) {
    throw new Error("Private files must remain inside the validated plan directory.");
  }
}

function assertSafePrivateFileStats(stats: BigIntStats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(`${label} must be one real, non-linked file.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077n) !== 0n) {
    throw new Error(`${label} permissions must not allow group or public access.`);
  }
  assertCurrentUserOwns(stats, label);
}

function assertBoundedPrivateContents(contents: string, maximumBytes: number, label: string): void {
  assertBoundedPrivateSize(BigInt(Buffer.byteLength(contents, "utf8")), maximumBytes, label);
}

function assertBoundedPrivateSize(size: bigint, maximumBytes: number, label: string): void {
  if (size > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte local file limit.`);
  }
}

function assertCurrentUserOwns(stats: { readonly uid: number | bigint }, label: string): void {
  if (
    process.platform !== "win32" &&
    typeof process.geteuid === "function" &&
    BigInt(stats.uid) !== BigInt(process.geteuid())
  ) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

function credentialsFromEnvironment(env: NodeJS.ProcessEnv) {
  const accessKeyId = env.DIGITALOCEAN_SPACES_ACCESS_KEY_ID;
  const secretAccessKey = env.DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY;
  const sessionToken = env.DIGITALOCEAN_SPACES_SESSION_TOKEN;
  if (accessKeyId === undefined || accessKeyId.trim() === "") {
    throw new Error("Set DIGITALOCEAN_SPACES_ACCESS_KEY_ID before apply.");
  }
  if (secretAccessKey === undefined || secretAccessKey.trim() === "") {
    throw new Error("Set DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY before apply.");
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function writeResult(result: CliResult, json: boolean, writer: SpacesOutputWriter): void {
  if (json) writer.info(JSON.stringify(result, null, 2));
  else {
    writer.info(result.summary);
    if (result.command === "help" && Array.isArray(result.data)) {
      for (const line of result.data) writer.info(`  ${String(line)}`);
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
