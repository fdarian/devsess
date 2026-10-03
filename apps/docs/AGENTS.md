# docs

Documentation site for `devsess`, built with [Blume](https://useblume.dev) (Astro).

## Dev
- `pnpm dev` — local dev server
- `pnpm build` — static build

Stop the dev server before a regular build or the root `pnpm run check`: Blume prevents concurrent use of its runtime. `pnpm build --isolated` verifies into `.blume-verify/dist/` without stopping dev.

## Layout
- blume.config.ts — site config + navigation
- src/pages/**/*.mdx — pages with title frontmatter; paths define URLs
- The changelog content source reads `packages/devsess/CHANGELOG.md`; builds require no GitHub token or network fetch.
- .blume/ — generated runtime, gitignored
