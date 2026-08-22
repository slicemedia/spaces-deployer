# Contributing to Slice Media Spaces Deployer

1. Use only synthetic endpoints, buckets, paths, credentials, and provider responses in code, tests, documentation, and commit history.
2. Preserve the private-plan, plan/apply, exact-version read-back, and receipt boundaries, and add
   regression tests for any safety-sensitive behavior.
3. Treat schema, plan-ID calculation, object-key calculation, receipt operation tags, and exported TypeScript types as public contracts.
4. Add a Changeset for every user-visible change.
5. Run `pnpm check` and `pnpm pack:check` before opening a pull request. CI repeats these gates on
   Node.js 22 and 24 on Linux and Windows; POSIX-only security tests remain explicitly scoped.
6. Do not publish, deploy artifacts, use real credentials, or mutate a real bucket as part of repository tests.
7. Keep provider guarantees and trust boundaries public and testable. Never rely on hidden behavior,
   customer topology, or undocumented credentials for safety.
8. Keep `SLICEMEDIA_RELEASE_PR_ENABLED` unset until the organization explicitly enables automated
   pull-request creation and the branch policy is reviewed. The Release PR workflow may prepare a
   version PR only; it must not publish, tag, or create a GitHub Release.
9. Keep `SLICEMEDIA_NPM_PUBLISH_NEXT_ENABLED` unset until the repository is intentionally public, the
   package is explicitly non-private, and the protected `npm-next` environment and trusted publisher
   have been reviewed. Never add a classic npm token to Actions.
10. Future releases must publish the reviewed artifact to npm under `next` before creating the
    matching Git tag and GitHub Release from the exact version commit. Promotion to `latest` reuses
    that artifact and never rebuilds it.
11. Keep private provenance terms only in the `SLICEMEDIA_FORBIDDEN_TERMS` secret of the protected
    `release-sanitize` environment or an ignored local `.private/denylist` JSON array. Never commit
    or print that input.

By participating, you agree to follow [the Code of Conduct](./CODE_OF_CONDUCT.md).
