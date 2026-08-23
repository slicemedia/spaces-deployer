# Changelog

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
