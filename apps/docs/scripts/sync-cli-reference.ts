import { mkdir, readdir } from 'node:fs/promises';

const source = new URL('../../../packages/devsess/docs/cli/', import.meta.url);
const target = new URL('../src/pages/reference/cli/', import.meta.url);

await mkdir(target, { recursive: true });
for (const filename of await readdir(source)) {
	if (!filename.endsWith('.md')) continue;
	await Bun.write(
		new URL(filename, target),
		Bun.file(new URL(filename, source)),
	);
}
