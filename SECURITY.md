# Security policy

Report suspected vulnerabilities privately through the repository's GitHub security advisory flow. Do not include real credentials, bucket names, endpoints, plan files, receipts, or client artifacts in a public issue.

The active release candidate on npm's `next` tag and, once available, the current `latest` line
receive best-effort security fixes. Older `0.x` lines do not receive guaranteed backports. This
project provides no response-time, remediation, or long-term-support SLA.

Slice Media Spaces Deployer treats planning, human review, exact confirmation, application,
object read-back, and receipt inspection as separate phases. Credentials must remain
outside source control and are accepted by the CLI only through environment variables during
apply. Plans remain local under `.slicemedia/spaces-deployer/`; they contain local paths and target
metadata even though they contain no credentials. The CLI verifies Git ignore status and refuses
staged, tracked, or reachable-history plans; direct API consumers must provide an equivalent local
storage boundary when persisting plans.

On POSIX, the CLI rejects changed, linked, non-owner, or group/public-accessible private plan paths
and uses bounded no-follow file handles with directory identity rechecks. Node does not provide an
`openat`-style directory-relative creation API, so the remaining local assumption is that another
process under the same OS user does not concurrently replace the validated directory chain during
the final file operation. Native Windows plan-file persistence is not covered by this security
guarantee because the package cannot verify an equivalent ACL or provide POSIX `O_NOFOLLOW`
semantics there. Use a supported POSIX environment, or keep plans in memory and enforce the Windows
storage and same-user process boundary independently.

Before a release, run `pnpm check` and inspect the `npm pack --dry-run` manifest. Never weaken
complete remote HEAD preflight, post-upload identity and metadata verification,
mode-specific key validation, resource limits, private plan storage,
exact plan validation, local drift checks, or credential redaction without a reviewed breaking
change and adversarial tests.

Bucket versioning is optional by default. `requireBucketVersioning: true` (CLI
`--require-bucket-versioning`) explicitly requires enabled bucket versioning and durable object
version IDs. Without that option, no `GetBucketVersioning` permission is needed. Uploads and skipped
objects must provide a durable version ID or a nonempty ETag. Read-back verifies exact version IDs
when available; otherwise it checks the current object's ETag and all planned metadata. The S3
`null` version is mutable and is treated as unversioned. Tests must cover unversioned replacements,
missing identifiers, ETag and metadata mismatches, purge retries, and the strict opt-in checks.

The HEAD-to-PUT interval is not atomic. Enabled bucket versioning limits damage from a racing writer
by retaining prior versions; it does not provide mutual exclusion or an atomic create-only write.
Without versioning, replaced bytes are not preserved and recovery requires redeploying an older build.

Stable schema-v3 plans authorize replacement only of their listed keys under a dedicated prefix.
They bind the cache policy, CDN endpoint ID and derived prefix purge to the plan ID. Before writing,
the CDN origin must match the Spaces target. Purging occurs only after successful upload read-back
and a check that the planned object identities and metadata are current. The only DELETE operation targets the CDN
endpoint's `/cache` resource, never stored objects or the endpoint itself. CDN API tokens are
supplied separately during apply, never serialized, and never forwarded through redirects.
Provider response bodies and raw CDN transport errors are not included in diagnostics. A failed
purge leaves the uploads recorded in a failed receipt; reapplying retries invalidation.

Immutable schema-v2 plans retain their digest-derived namespaces and reject occupied mismatches.
The default mode change does not reinterpret saved plans. Stable plans require adversarial tests
for scope expansion, plan tampering, mismatched origins, partial writes and purge failures.

The package does not manage public access, bucket policy, ACL, CORS, CDN configuration, domains, or
Webflow publishing. Treat those as separate reviewed operations. Read-back validates provider metadata for
the uploaded version or ETag; it is not a remote-body hash or a defense against a malicious storage
administrator.
