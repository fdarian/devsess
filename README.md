# devsess

Monorepo for [`devsess`](packages/devsess) — scaffold dev scripts with reusable dev sessions and a per-session PGlite + Drizzle adapter, built on [Effect](https://effect.website).

## Packages

| Path | Description |
| --- | --- |
| [`packages/devsess`](packages/devsess) | The `devsess` library (published to npm). |
| [`apps/docs`](apps/docs) | Documentation site, built with [Blume](https://useblume.dev). |

## Development

This is a [pnpm](https://pnpm.io) workspace. Install [Bun](https://bun.sh) separately when using Bun; CI installs it with `oven-sh/setup-bun`.

```bash
pnpm install       # install all workspaces
pnpm run build     # build the library (tsup + tsc declarations)
pnpm run check     # typecheck + lint (turbo)
pnpm run format    # biome format
pnpm run docs      # run the docs site locally
```

## Releasing

Publishing is automated via GitHub Actions (`.github/workflows/release.yml`):
bump the version in `packages/devsess/package.json`, commit, then tag and push:

```bash
git tag v0.0.1
git push --tags
```

Requires an `NPM_TOKEN` repository secret. See the release workflow for details.

## License

Apache-2.0
