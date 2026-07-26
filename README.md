# devsess

Monorepo for [`devsess`](packages/devsess) — scaffold dev scripts with reusable dev sessions and a per-session PGlite + Drizzle adapter, built on [Effect](https://effect.website).

## Packages

| Path | Description |
| --- | --- |
| [`packages/devsess`](packages/devsess) | The `devsess` library (published to npm). |
| [`apps/docs`](apps/docs) | Documentation site, built with [vocs](https://vocs.dev). |

## Development

This is a [Bun](https://bun.sh) workspace.

```bash
bun install        # install all workspaces
bun run build      # build the library (tsup + tsc declarations)
bun run check      # typecheck + lint (turbo)
bun run format     # biome format
bun run docs       # run the docs site locally
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
