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

export interface SpacesDeploymentPlan {
  readonly schemaVersion: 2;
  readonly planId: string;
  readonly sourceDirectory: string;
  readonly target: SpacesDeploymentTarget;
  readonly releaseVersion: string;
  readonly artifactSetDigest: string;
  readonly files: readonly SpacesDeploymentFile[];
}

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
}

export interface ApplyDeploymentPlanOptions {
  readonly confirmedPlanId: string;
  readonly credentials: SpacesCredentials;
  readonly client?: S3Client;
  readonly now?: () => Date;
}

export interface SpacesDeploymentFileReceipt {
  readonly key: string;
  readonly status: "uploaded" | "skipped" | "failed";
  readonly etag?: string;
  readonly versionId?: string;
  readonly error?: string;
}

export interface SpacesDeploymentReceipt {
  readonly schemaVersion: 2;
  readonly operation: "slicemedia.spaces-deployer.deploy";
  readonly status: "applied" | "failed";
  readonly planId: string;
  readonly target: SpacesDeploymentTarget;
  readonly releaseVersion: string;
  readonly artifactSetDigest: string;
  readonly timestamp: string;
  readonly files: readonly SpacesDeploymentFileReceipt[];
}

export class SpacesDeploymentError extends Error {
  readonly receipt: SpacesDeploymentReceipt;

  constructor(message: string, receipt: SpacesDeploymentReceipt, cause?: unknown) {
    super(message, { cause });
    this.name = "SpacesDeploymentError";
    this.receipt = receipt;
  }
}
