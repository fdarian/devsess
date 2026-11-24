# devsess

Monorepo for [`devsess`](packages/devsess) — scaffold dev scripts with reusable dev sessions and a per-session PGlite + Drizzle adapter, built on [Effect](https://effect.website). Docs: [devsess.fdarian.com](https://devsess.fdarian.com)

## Packages

| Path | Description |
| --- | --- |
| [`packages/devsess`](packages/devsess) | The `devsess` library (published to npm). |
| [`packages/cli`](packages/cli) | The `devsess` CLI and daemon, released as binaries (`brew install fdarian/tap/devsess`). |
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

The `devsess` CLI for detached, per-worktree service groups lives in `packages/cli`. Its configuration and command behavior are documented in the [CLI reference](packages/cli/docs/cli/index.md).

## License

Apache-2.0
