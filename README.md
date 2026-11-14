# devsess

Monorepo for [`devsess`](packages/devsess) — scaffold dev scripts with reusable dev sessions and a per-session PGlite + Drizzle adapter, built on [Effect](https://effect.website). Docs: [devsess.fdarian.com](https://devsess.fdarian.com)

## Packages

| Path | Description |
| --- | --- |
| [`packages/devsess`](packages/devsess) | The `devsess` library (published to npm). |
| [`packages/cli`](packages/cli) | The `devsess` CLI and daemon, published as `@devsess/cli`. |
| [`apps/docs`](apps/docs) | Documentation site, built with [Blume](https://useblume.dev). |

## Development

This is a [pnpm](https://pnpm.io) workspace. Install [Bun](https://bun.sh) separately when using Bun; CI installs it with `oven-sh/setup-bun`.

```bash
pnpm install       # install all workspaces
pnpm run build     # build the library and the CLI
pnpm run check     # typecheck + lint (turbo)
pnpm run format    # biome format
pnpm run docs      # run the docs site locally
```

The `devsess` CLI for detached, per-worktree service groups lives in `@devsess/cli`. Its configuration and command behavior are documented in the [CLI reference](packages/cli/docs/cli/index.md).

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
