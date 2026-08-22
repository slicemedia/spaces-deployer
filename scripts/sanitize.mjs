import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([".git", "artifacts", "coverage", "node_modules"]);
const maximumFileBytes = 5 * 1024 * 1024;
const localPrivateDirectory = path.resolve(".private");

const sensitivePatterns = [
  ["private key", /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/gu],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ["GitHub token", /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/gu],
  ["DigitalOcean token", /\bdop_v1_[A-Za-z0-9]{32,}\b/gu],
];

const canonicalBrandWords = ["Slice", "Media"];
const canonicalCompactBrand = canonicalBrandWords.join("").toLocaleLowerCase("en-US");
const compactBrandPattern = new RegExp(escapeRegExp(canonicalCompactBrand), "giu");
const separatedBrandPattern = new RegExp(
  `(${escapeRegExp(canonicalBrandWords[0])})([\\s_-]+)(${escapeRegExp(canonicalBrandWords[1])})`,
  "giu",
);

const arguments_ = process.argv.slice(2);
const json = arguments_.includes("--json");
const rootOption = arguments_.indexOf("--root");
const root = path.resolve(rootOption === -1 ? process.cwd() : (arguments_[rootOption + 1] ?? ""));

if (
  rootOption !== -1 &&
  (arguments_[rootOption + 1] === undefined || root === path.parse(root).root)
) {
  throw new Error("--root must identify a non-root directory.");
}

const customTerms = await loadPrivateTerms();
const privateRules = createPrivateRules(customTerms);
const findings = [];
let scannedFiles = 0;

const rootStats = await lstat(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
  throw new Error("A sanitized root must be a real directory.");
}
await visit(root);

const result = { ok: findings.length === 0, scannedFiles, findings };
if (json) console.info(JSON.stringify(result, null, 2));
else if (result.ok) console.info(`Sanitized ${scannedFiles} file(s); no findings.`);
else {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.kind}`);
  }
}
if (!result.ok) process.exitCode = 1;

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && absolute === localPrivateDirectory) continue;
    if (entry.isSymbolicLink()) {
      findings.push({ file: relative(absolute), line: 1, kind: "symbolic link" });
      continue;
    }
    if (entry.isDirectory()) {
      await visit(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = relative(absolute);
    scanText(file, file);
    const stats = await lstat(absolute);
    if (stats.size > maximumFileBytes) {
      findings.push({ file: relative(absolute), line: 1, kind: "file exceeds scan limit" });
      continue;
    }
    const contents = await readFile(absolute);
    if (contents.includes(0)) continue;
    scannedFiles += 1;
    scanText(file, contents.toString("utf8"));
  }
}

function scanText(file, source) {
  for (const [kind, pattern] of sensitivePatterns) {
    for (const match of source.matchAll(pattern)) addFinding(file, source, match.index ?? 0, kind);
  }
  scanBrand(file, source);
  const foldedSource = source.toLocaleLowerCase("en-US");
  for (const rule of privateRules) {
    const haystack = rule.caseInsensitive ? foldedSource : source;
    const needle = rule.caseInsensitive ? rule.needle.toLocaleLowerCase("en-US") : rule.needle;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      addFinding(
        redactPrivatePath(file),
        source,
        index,
        `private rule ${rule.index} (${rule.kind})`,
      );
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
}

function redactPrivatePath(file) {
  const foldedFile = file.toLocaleLowerCase("en-US");
  return privateRules.some((rule) =>
    rule.caseInsensitive
      ? foldedFile.includes(rule.needle.toLocaleLowerCase("en-US"))
      : file.includes(rule.needle),
  )
    ? "[redacted path]"
    : file;
}

function createPrivateRules(terms) {
  return terms.flatMap((term, termIndex) => {
    const rules = [{ index: termIndex + 1, kind: "text", needle: term, caseInsensitive: true }];
    const seenEncodings = new Set();
    const variants = [
      ...new Set([term, term.toLocaleLowerCase("en-US"), term.toLocaleUpperCase("en-US")]),
    ];
    for (const variant of variants) {
      const bytes = Buffer.from(variant, "utf8");
      const base64 = bytes.toString("base64");
      addEncoding("base64", base64, false);
      addEncoding("base64-unpadded", base64.replace(/=+$/u, ""), false);
      addEncoding(
        "base64url",
        base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
        false,
      );
      addEncoding("hex", bytes.toString("hex"), true);
    }
    return rules;

    function addEncoding(kind, needle, caseInsensitive) {
      const key = `${caseInsensitive ? "i" : "s"}:${needle}`;
      if (seenEncodings.has(key)) return;
      seenEncodings.add(key);
      rules.push({ index: termIndex + 1, kind, needle, caseInsensitive });
    }
  });
}

async function loadPrivateTerms() {
  let source = process.env.SLICEMEDIA_FORBIDDEN_TERMS?.trim() ?? "";
  if (!source) {
    try {
      const denylistPath = path.resolve(localPrivateDirectory, "denylist");
      const stats = await lstat(denylistPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
        throw new Error("The local private denylist must be a bounded regular file.");
      }
      source = (await readFile(denylistPath, "utf8")).trim();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  if (!source) {
    if (process.env.SLICEMEDIA_REQUIRE_FORBIDDEN_TERMS === "true") {
      throw new Error("A private forbidden-term JSON array is required for this gate.");
    }
    return [];
  }

  if (Buffer.byteLength(source, "utf8") > 64 * 1024) {
    throw new TypeError("Private forbidden-term input exceeds the size limit.");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError("Private forbidden terms must be a valid JSON array.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 256 ||
    !parsed.every(
      (term) => typeof term === "string" && term.trim().length >= 3 && term.trim().length <= 256,
    )
  ) {
    throw new TypeError("Private forbidden terms must be a JSON array of 3-256 character strings.");
  }
  return [...new Set(parsed.map((term) => term.trim()))];
}

function scanBrand(file, source) {
  for (const match of source.matchAll(compactBrandPattern)) {
    const candidate = match[0];
    if (
      candidate !== canonicalCompactBrand &&
      candidate !== canonicalCompactBrand.toLocaleUpperCase("en-US")
    ) {
      addFinding(file, source, match.index ?? 0, "legacy compact brand");
    }
  }

  for (const match of source.matchAll(separatedBrandPattern)) {
    const [, firstWord, separator, secondWord] = match;
    const isCanonicalProse =
      /^\s+$/u.test(separator) &&
      firstWord === canonicalBrandWords[0] &&
      secondWord === canonicalBrandWords[1];
    if (!isCanonicalProse) {
      addFinding(file, source, match.index ?? 0, "non-canonical separated brand");
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function addFinding(file, source, index, kind) {
  findings.push({ file, line: source.slice(0, index).split("\n").length, kind });
}

function relative(absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}
