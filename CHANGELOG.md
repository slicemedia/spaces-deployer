# Changelog

## 0.2.1

### Patch Changes

- Allow stable and immutable deployments to buckets with disabled or suspended versioning. Versioned
  objects retain exact-version verification; unversioned objects are verified using their ETag and
  the planned metadata, including the final check before CDN invalidation. No bucket-versioning
  lookup or permission is required by default. Opt in to the previous strict requirement with
  `--require-bucket-versioning` or API `requireBucketVersioning: true`. Existing plans remain valid.

## 0.2.0

### Minor Changes

- Add stable URL deployment with scoped DigitalOcean CDN invalidation as the default. Stable
  schema-v3 plans keep object keys unchanged across releases, bind the cache policy and purge
  scope to the plan ID, verify the CDN origin before uploading, retain previous object versions,
  verify the uploaded and current versions, and fail with a partial receipt if the purge fails.
  Repeated apply skips matching uploads and retries the purge. Include a copyable GitHub Actions
  workflow and browser-revalidating cache headers.

  Breaking change: creating a plan now defaults to stable mode and requires a dedicated prefix and
  CDN endpoint ID; applying it additionally requires a DigitalOcean API token. Use `mode: "immutable"`
  or `--mode immutable` to retain the old behavior. Existing schema-v2 plan files and plan IDs remain
  valid. Exported plan and receipt types are now discriminated unions; narrow on `schemaVersion`
  before accessing stable-only fields. No stored objects or CDN endpoints are deleted.

All notable changes to Slice Media Spaces Deployer are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0

Initial public release candidate, distributed through npm's `next` tag.

- Add a credential-free schema-v2 deployment-plan API and a guarded `plan`/`apply` CLI.
- Store CLI plans beneath ignored, owner-only local storage on supported POSIX systems and reject
  unsafe links, permissions, changed directory identities, tracked paths, and reachable Git history.
- Namespace immutable release objects by release version and a canonical SHA-256 artifact-set
  digest, with SHA-384 integrity metadata for each file.
- Require bucket versioning, complete remote preflight, an exact matching plan ID, explicit human
  confirmation, nonempty provider version IDs, and exact-version post-upload read-back.
- Preserve existing object versions, expose no delete operation, and document the provider's
  non-atomic HEAD-to-PUT interval rather than claiming create-only writes.
- Redact supplied credentials from partial-failure receipts and enforce conservative traversal,
  depth, file-count, and byte limits.
- Validate the TypeScript API and general CLI on Linux and Windows while clearly scoping secure
  persisted plan files to supported POSIX environments.
