import type { S3Client } from "@aws-sdk/client-s3";

export interface SpacesDeploymentTarget {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
}

export interface SpacesDeploymentLimits {
  readonly maxFiles: number;
  readonly maxEntries: number;
  readonly maxDirectories: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface SpacesDeploymentFile {
  readonly relativePath: string;
  readonly key: string;
  readonly size: number;
  readonly sha384: string;
  readonly contentType: string;
}

interface DeploymentPlanContents {
  readonly planId: string;
  readonly sourceDirectory: string;
  readonly target: SpacesDeploymentTarget;
  readonly releaseVersion: string;
  readonly artifactSetDigest: string;
  readonly files: readonly SpacesDeploymentFile[];
}

/** Existing schema-v2 plans retain their immutable keys and plan IDs. */
export interface SpacesImmutableDeploymentPlan extends DeploymentPlanContents {
  readonly schemaVersion: 2;
}

export interface SpacesCdnPurge {
  readonly endpointId: string;
  readonly files: readonly string[];
}

export interface SpacesStableDeploymentPlan extends DeploymentPlanContents {
  readonly schemaVersion: 3;
  readonly mode: "stable";
  readonly cacheControl: string;
  readonly cdn: SpacesCdnPurge;
}

export type SpacesDeploymentPlan = SpacesImmutableDeploymentPlan | SpacesStableDeploymentPlan;
export type SpacesDeploymentMode = "stable" | "immutable";

export interface SpacesCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface CreateDeploymentPlanOptions {
  readonly directory: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly releaseVersion: string;
  /** Defaults to stable. Immutable mode continues producing schema-v2 plans. */
  readonly mode?: SpacesDeploymentMode;
  /** Required for stable deployments; credentials are supplied only when applying. */
  readonly cdnEndpointId?: string;
}

export interface ApplyDeploymentPlanOptions {
  readonly confirmedPlanId: string;
  readonly credentials: SpacesCredentials;
  readonly cdnApiToken?: string;
  readonly cdnFetch?: typeof fetch;
  readonly client?: S3Client;
  readonly now?: () => Date;
}

export interface SpacesDeploymentFileReceipt {
  readonly key: string;
  readonly status: "uploaded" | "skipped" | "failed";
  readonly etag?: string;
  readonly versionId?: string;
  readonly previousVersionId?: string;
  readonly error?: string;
}

interface DeploymentReceiptContents {
  readonly operation: "slicemedia.spaces-deployer.deploy";
  readonly status: "applied" | "failed";
  readonly planId: string;
  readonly target: SpacesDeploymentTarget;
  readonly releaseVersion: string;
  readonly artifactSetDigest: string;
  readonly timestamp: string;
  readonly files: readonly SpacesDeploymentFileReceipt[];
}

export interface SpacesCdnPurgeReceipt extends SpacesCdnPurge {
  readonly status: "not-requested" | "requested" | "failed";
  readonly error?: string;
}

export type SpacesDeploymentReceipt = DeploymentReceiptContents &
  (
    | { readonly schemaVersion: 2 }
    | {
        readonly schemaVersion: 3;
        readonly mode: "stable";
        readonly cdn: SpacesCdnPurgeReceipt;
      }
  );

export class SpacesDeploymentError extends Error {
  readonly receipt: SpacesDeploymentReceipt;

  constructor(message: string, receipt: SpacesDeploymentReceipt, cause?: unknown) {
    super(message, { cause });
    this.name = "SpacesDeploymentError";
    this.receipt = receipt;
  }
}
