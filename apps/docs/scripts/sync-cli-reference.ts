const source = new URL('../../../packages/devsess/CLI.md', import.meta.url);
const target = new URL('../src/pages/reference/cli.mdx', import.meta.url);

await Bun.write(target, Bun.file(source));
