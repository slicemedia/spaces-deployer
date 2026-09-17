import type { SpacesCdnPurge, SpacesStableDeploymentPlan } from "./types.js";

// Browsers revalidate on their next request; shared caches may keep a copy for
// five minutes. A successful deployment explicitly purges the project prefix.
export const STABLE_CACHE_CONTROL = "public, max-age=0, s-maxage=300, must-revalidate";

export function createCdnPurge(endpointId: string | undefined, prefix: string): SpacesCdnPurge {
  if (
    typeof endpointId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(endpointId)
  ) {
    throw new Error("Stable deployments require a cdnEndpointId UUID.");
  }
  if (prefix.split("/").length < 2) {
    throw new Error("Stable deployments require a dedicated prefix such as project/assets.");
  }
  return { endpointId: endpointId.toLowerCase(), files: [`/${prefix}/*`] };
}

export function validateCdnToken(token: string | undefined): string {
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new Error("Stable deployments require a non-empty DigitalOcean CDN API token.");
  }
  return token;
}

export async function verifyCdnEndpoint(
  plan: SpacesStableDeploymentPlan,
  token: string,
  request: typeof fetch,
): Promise<void> {
  const response = await cdnRequest(plan, token, request, false);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("DigitalOcean CDN returned invalid endpoint metadata.");
  }
  if (typeof body !== "object" || body === null || !("endpoint" in body)) {
    throw new Error("DigitalOcean CDN returned invalid endpoint metadata.");
  }
  const endpoint = body.endpoint;
  const expectedOrigin = `${plan.target.bucket}.${new URL(plan.target.endpoint).hostname}`;
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    !("id" in endpoint) ||
    endpoint.id !== plan.cdn.endpointId ||
    !("origin" in endpoint) ||
    endpoint.origin !== expectedOrigin
  ) {
    throw new Error("The CDN endpoint does not belong to the planned Spaces bucket and region.");
  }
}

export async function requestCdnPurge(
  plan: SpacesStableDeploymentPlan,
  token: string,
  request: typeof fetch,
): Promise<void> {
  const response = await cdnRequest(plan, token, request, true);
  // Do not log provider bodies: they may contain credentials or account data.
  await response.body?.cancel().catch(() => undefined);
}

async function cdnRequest(
  plan: SpacesStableDeploymentPlan,
  token: string,
  request: typeof fetch,
  purge: boolean,
): Promise<Response> {
  const operation = purge ? "purge" : "endpoint verification";
  let response: Response;
  try {
    response = await request(
      `https://api.digitalocean.com/v2/cdn/endpoints/${plan.cdn.endpointId}${purge ? "/cache" : ""}`,
      {
        method: purge ? "DELETE" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(purge ? { "Content-Type": "application/json" } : {}),
        },
        ...(purge ? { body: JSON.stringify({ files: plan.cdn.files }) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    // Do not propagate a transport error that could echo an Authorization header.
    throw new Error(`DigitalOcean CDN ${operation} request failed or timed out.`);
  }
  if (response.status !== (purge ? 204 : 200)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`DigitalOcean CDN ${operation} failed with HTTP ${response.status}.`);
  }
  return response;
}
