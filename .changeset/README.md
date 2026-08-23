# Changesets

The initial public `0.1.0` work is consolidated in the root changelog. Add a changeset for every
subsequent user-visible package change:

```sh
pnpm changeset
```

Use patch releases for compatible fixes. While the package remains below `1.0.0`, use a minor
release for compatible features or documented breaking API or plan-schema changes; after `1.0.0`,
breaking changes require a major release. Document every breaking change prominently in its
changeset and release notes.
