import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { SpacesDeploymentFile, SpacesDeploymentPlan } from "./types.js";

export function validateObjectAcl(value: unknown): "public-read" | undefined {
  if (value === undefined || value === "public-read") return value;
  throw new Error("Object ACL must be public-read when provided.");
}

export async function verifyPublicObject(
  plan: SpacesDeploymentPlan,
  file: SpacesDeploymentFile,
  cdn: boolean,
  request: typeof fetch,
): Promise<string> {
  const host = `${plan.target.bucket}.${plan.target.region}.${cdn ? "cdn." : ""}digitaloceanspaces.com`;
  const key = file.key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${host}/${key}`;
  const attempts = cdn ? 3 : 1;
  let error = "Public retrieval failed.";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delay(1_000);
    const result = await probe(url, file, request);
    if (result === undefined) return url;
    error = result;
  }
  throw new Error(`Public ${cdn ? "CDN" : "origin"} verification failed: ${error}`);
}

async function probe(
  url: string,
  file: SpacesDeploymentFile,
  request: typeof fetch,
): Promise<string | undefined> {
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await request(url, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) return `HTTP ${response.status}.`;
    const hash = createHash("sha384");
    let size = 0;
    reader = response.body?.getReader();
    if (reader !== undefined) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > file.size) return "Response exceeds the planned file size.";
        hash.update(chunk.value);
      }
    }
    if (size !== file.size || `sha384-${hash.digest("base64")}` !== file.sha384) {
      return "Response bytes do not match the deployment plan.";
    }
    return undefined;
  } catch {
    // Never include provider bodies, transport diagnostics, or request details in errors.
    return "Request failed or timed out.";
  } finally {
    if (reader !== undefined) await reader.cancel().catch(() => undefined);
    else await response?.body?.cancel().catch(() => undefined);
  }
}
