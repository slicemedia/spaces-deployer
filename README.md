# Slice Media Spaces Deployer

Slice Media Spaces Deployer creates reviewed, content-addressed deployment plans and applies them to DigitalOcean Spaces without deleting or replacing existing object versions.

The package exposes a TypeScript API and the `slicemedia-spaces` CLI. It deliberately has no default endpoint, region, bucket, prefix, release version, credentials, delete operation, or mutable `latest` alias.

## Install

After an npm release is available, install it with the consuming project's package manager:

```sh
# pnpm
pnpm add @slicemedia/spaces-deployer@next

# npm
npm install @slicemedia/spaces-deployer@next

# Yarn
yarn add @slicemedia/spaces-deployer@next
```

Use the command that matches the consuming project. pnpm is used to develop this repository, but
generated projects and package consumers do not need to use pnpm.

The prerelease supports Node.js `^22.13.0` and `^24.0.0`.

The TypeScript API and general CLI behavior are tested on Linux and Windows. The private plan-file
security boundary is supported on POSIX systems only: native Windows does not expose the ownership,
mode, and `O_NOFOLLOW` guarantees enforced by this package. We do not claim equivalent secure plan
persistence on native Windows. Use WSL2/Linux/macOS for CLI plan files, or use the API and keep
plans in memory or in storage protected by an independently enforced owner-only Windows ACL and
same-user locking policy.

## TypeScript API

Planning reads the complete local artifact directory and produces a credential-free schema-v2 plan. Applying requires the exact plan ID and credentials supplied separately from the plan.

The API returns the plan in memory. If a direct API consumer persists it, the consumer must keep it
in ignored local storage with owner-only permissions. Plans contain an absolute local source path
and deployment-target metadata even though they never contain credentials. Native Windows
persistence is outside the package's guaranteed filesystem boundary.

```ts
import { applyDeploymentPlan, createDeploymentPlan } from "@slicemedia/spaces-deployer";

const plan = await createDeploymentPlan({
  directory: "dist",
  endpoint: "https://fra1.digitaloceanspaces.com",
  region: "fra1",
  bucket: "my-assets",
  prefix: "releases",
  releaseVersion: "2026.08.21-1",
});

await applyDeploymentPlan(plan, {
  confirmedPlanId: plan.planId,
  credentials: {
    accessKeyId: process.env.DIGITALOCEAN_SPACES_ACCESS_KEY_ID!,
    secretAccessKey: process.env.DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY!,
  },
});
```

## CLI

The CLI keeps credentials out of arguments and plan files. It reads them only during `apply` from `DIGITALOCEAN_SPACES_ACCESS_KEY_ID`, `DIGITALOCEAN_SPACES_SECRET_ACCESS_KEY`, and the optional `DIGITALOCEAN_SPACES_SESSION_TOKEN`.

```sh
slicemedia-spaces plan \
  --directory dist \
  --endpoint https://fra1.digitaloceanspaces.com \
  --region fra1 \
  --bucket my-assets \
  --prefix releases \
  --release-version 2026.08.21-1 \
  --plan .slicemedia/spaces-deployer/2026.08.21-1.json

slicemedia-spaces apply \
  --plan .slicemedia/spaces-deployer/2026.08.21-1.json \
  --plan-id PLAN_ID \
  --yes
```

`apply` refuses to run without both `--yes` and the exact plan ID. Unknown arguments are rejected, including attempts to pass credentials on the command line. Plans and receipts never contain credentials.

The CLI only reads or writes plan files beneath `.slicemedia/spaces-deployer/`. It creates an exact
local `.gitignore` marker there and writes new plans with owner-only permissions on POSIX systems.
On POSIX it rejects paths outside that directory, symbolic-link or hard-linked storage, weakened ignore
markers, changed directory identities, group/public-writable working directories, private plan
ancestors, and existing plan files with group or public permissions. Plan reads are bounded, and
file handles use no-follow creation/opening plus parent identity and containment checks where Node
and the operating system expose them. Inside a Git
worktree, it also verifies the exact path with `git check-ignore --no-index` and refuses to proceed
if any plan in that directory is staged, tracked, or remains in reachable history. Rewrite affected
history before trying again.
`--json` deliberately returns the reviewed plan or receipt, so do not send that output to shared
logs or public issue trackers.

Node does not expose an `openat`-style API that can bind a new filename to an already opened
directory handle. The POSIX checks therefore assume that another process running as the same OS
user does not concurrently rename or replace the validated private directories during the final
file operation. Other local users are excluded by ownership and permission checks. On Windows,
configure an owner-only ACL on the working directory and prevent concurrent same-user writers;
POSIX mode and `O_NOFOLLOW` guarantees are not available there. Native Windows plan-file
persistence is therefore not part of the package's security guarantee.

## Safety model

- Plans use schema version 2 and are validated as exact plain-data structures before any remote request.
- Every object key is namespaced as `<prefix>/<releaseVersion>/<artifactSetDigest>/<relativePath>`. The artifact-set digest is SHA-256 over canonical metadata for the complete file set; each file also carries SHA-384 integrity metadata.
- Applying re-reads and validates every local file before contacting DigitalOcean Spaces. Source drift fails before any remote request.
- The target bucket must report versioning status `Enabled`. Otherwise applying fails before any `HeadObject` or `PutObject` request.
- Applying completes `HeadObject` preflight for every planned key before the first upload. Only matching size, content type, cache policy, SHA-384 metadata, and artifact-set digest are skipped; occupied mismatches and ambiguous responses fail closed with no uploads started.
- Every successful `PutObject` must return a version ID. Applying then performs `HeadObject` against that exact version and verifies its size, content type, immutable cache policy, SHA-384 metadata, and artifact-set digest before marking it uploaded.
- Existing object versions are never deleted, and the package exposes no delete operation.
- Provider errors included in failure receipts are redacted against the supplied access key, secret key, and session token.
- Fixed resource limits reject more than 1,000 files, 1,500 traversed entries, 1,000 directories
  (including the source root), 32 nested directory levels, any file larger than 64 MiB, or an
  artifact set larger than 256 MiB before upload. Directory enumeration is streamed. These
  intentionally conservative limits bound local traversal and keep the in-memory workflow below
  provider limits.

### Trust boundaries

- Read-back verifies what the provider reports for the exact uploaded version. It does not download
  and rehash the remote body, and it does not treat object metadata as protection against a
  malicious storage administrator.
- The package calls `GetBucketVersioning`, `HeadObject`, and `PutObject`. Configure a dedicated,
  narrowly scoped Spaces key that permits those operations. DigitalOcean may group object write
  permission with delete permission; this package still never issues a delete request.
- Uploading does not configure bucket policies, object ACLs, CORS, CDN settings, custom domains, or
  cache purges. New objects use the bucket's existing access behavior. Browser-hosted assets require
  an independently reviewed public-read or delivery configuration and a retrieval check after
  deployment.
- A successful receipt proves that the planned version was uploaded or that matching provider
  metadata already existed at the planned key. It does not publish a Webflow site, update Webflow
  custom code, or prove that a public CDN URL serves the new object.

### Non-atomic HEAD-to-PUT interval

DigitalOcean Spaces does not support the atomic conditional `PutObject` needed for a true create-only write, including `If-None-Match`. Slice Media Spaces Deployer therefore does not claim atomic no-overwrite behavior and does not send an unsupported condition.

An external writer can create or change a key after the complete HEAD preflight and before this process sends its PUT. Mandatory bucket versioning preserves the prior version in that race, but it does not prevent the race or guarantee which version another reader observes as current. Digest-derived key namespaces prevent legitimate plans with different content from selecting the same key; they do not act as a distributed lock.

## Development and releases

```sh
pnpm install
pnpm check
pnpm pack:check
pnpm changeset
```

Changesets controls package versions. During private incubation and after public launch, the Release
PR workflow can only prepare a draft version PR. It is pinned, receives no npm token or OIDC
permission, and accepts only the expected repository identity and explicit visibility. Keep the
`SLICEMEDIA_RELEASE_PR_ENABLED` repository or organization variable unset until
the organization permits GitHub Actions to create pull requests and the branch policy is reviewed;
setting it to the exact string `true` only activates version-PR preparation after a push to `main`.
There is no manual privileged trigger. The version job uses the main-only `release-sanitize`
environment. CI validates source, tests, build output, sanitization, and the npm package manifest
without publishing.

The separate dormant `Publish npm prerelease` workflow is manual, runs only from the current `main`
commit, and accepts no npm token. Its archive-preparation job uses `release-sanitize`, while the
minimal OIDC publisher is isolated in the protected `npm-next` environment and cannot read the
private denylist. It requires a public repository, an explicitly non-private package, and
`SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED=true`. Leave that variable unset until the npm scope, trusted
publisher, required reviewers, final package name, and first-prerelease readiness gates have all
been verified. Ordinary `pnpm check` and `pnpm version:check` remain fail-closed and require
`private: true`; inherited environment variables cannot relax that rule. The dormant workflow uses
the separate `pnpm release:publish:check`, whose explicit invocation guard and complete repository,
visibility, branch, commit, enablement, credential, and workflow checks instead require
`private: false`. It runs the shared quality, build, and sanitization gates first, then performs that
guarded release check after creating the candidate archive so the final clean-source proof remains
authoritative. The protected main scan, version-PR job, and prerelease preparation job require the
private `SLICEMEDIA_FORBIDDEN_TERMS` environment secret as a non-empty JSON string array and declare
`release-sanitize` explicitly. Pull-request CI contains no secret reference and always runs generic
secret and naming checks. Text, UTF-8 base64, base64url, and hexadecimal rules are derived only at
runtime, and reports contain rule indices and kinds rather than values. Local checks may use the
same JSON in ignored `.private/denylist`; never commit or print it.
Installation, tests, and archive preparation run in a separate job without OIDC
permission. The minimal publishing job receives only that archive, proves its checkout is still
live remote `main`, pins and verifies npm `11.19.0`, and rejects registry, user-configuration, and
classic-token overrides. npm 12 is not allowed implicitly. It publishes the exact archive under
`next` to `https://registry.npmjs.org/` and requires registry
integrity to match the local archive. Only after that succeeds should the matching Git tag and
GitHub Release be created from the exact version commit. Promotion to `latest` must reuse the
already published artifact rather than rebuilding it.

The first public `0.x` prerelease is gated by automated tests, pack inspection, sanitization, and a
clean-room consumer—not a live client deployment. Real client projects and disposable versioned
Spaces buckets become pilots after the first `next` publication. Any discovered issue is fixed in a
further `next` version. Do not promote to `latest` until those pilots cover repeat uploads,
collisions, retained versions, receipt redaction, public retrieval, and project-specific delivery
configuration, and the complete public-readiness review passes.

Licensed under MIT.
