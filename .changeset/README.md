# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

To record a change for the next release:

```bash
bun changeset
```

Pick the affected package(s) and a semver bump, then commit the generated
markdown file alongside your change. On merge to `main`, the release workflow
opens (or updates) a "Version Packages" PR; merging that PR publishes to npm.

See `.github/workflows/release.yml` for the publish flow (OIDC trusted publishing).
