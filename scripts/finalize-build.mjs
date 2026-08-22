import { chmod } from "node:fs/promises";
import { URL } from "node:url";

await chmod(new URL("../dist/bin.js", import.meta.url), 0o755);
