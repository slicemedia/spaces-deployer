# Security policy

Report suspected vulnerabilities privately through the repository's GitHub security advisory flow. Do not include real credentials, bucket names, endpoints, plan files, receipts, or client artifacts in a public issue.

Slice Media Spaces Deployer treats planning, human review, exact confirmation, application,
version-specific read-back, and receipt inspection as separate phases. Credentials must remain
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
mandatory bucket versioning, complete remote HEAD preflight, exact-version post-upload read-back,
nonempty provider version IDs, digest-derived namespaces, resource limits, private plan storage,
exact plan validation, local drift checks, or credential redaction without a reviewed breaking
change and adversarial tests.

The HEAD-to-PUT interval is not atomic. Bucket versioning limits damage from a racing writer by retaining prior versions; it does not provide mutual exclusion or an atomic create-only write.

The package does not manage public access, bucket policy, ACL, CORS, CDN, domains, or Webflow
publishing. Treat those as separate reviewed operations. Read-back validates provider metadata for
the exact uploaded version; it is not a remote-body hash or a defense against a malicious storage
administrator.
