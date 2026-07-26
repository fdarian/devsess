# @devsess/config

Shared TypeScript config presets for the monorepo. Not published.

## Presets
- `tsconfig-library.json` — no-dom base for library packages (e.g. `packages/devsess`)
- `tsconfig.json` — DOM base for browser/docs apps (e.g. `apps/docs`)
- `tsconfig-server.json` — no-dom base for server/Node apps

## Usage
In consumer package's tsconfig: `"extends": "@devsess/config/tsconfig-library"`
