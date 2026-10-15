import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

const root = dirname(fileURLToPath(import.meta.url));
const nodePtyShim = resolve(root, 'src/cli/sea/node-pty-utils.ts');
const nodePtyLib = `${join('node-pty', 'lib')}/`;

const nodePtyPrebuilds = join(
	dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),
	'prebuilds',
	`${process.platform}-${process.arch}`,
);

const docsDir = join(root, 'docs/cli');
const docAssets = Object.fromEntries(
	readdirSync(docsDir)
		.filter((file) => file.endsWith('.md'))
		.map((file) => [`docs/cli/${file}`, join(docsDir, file)]),
);

const assets: Record<string, string> = {
	...docAssets,
	'node-pty/pty.node': join(nodePtyPrebuilds, 'pty.node'),
	...(process.platform === 'darwin'
		? { 'node-pty/spawn-helper': join(nodePtyPrebuilds, 'spawn-helper') }
		: {}),
};

export default defineConfig({
	entry: { cli: 'src/cli.ts' },
	format: ['esm'],
	platform: 'node',
	target: 'node25',
	// The bundle is only the SEA's main script; keep it out of `dist`, which is the npm output.
	outDir: 'build/bundle',
	// node-pty's unixTerminal.js reads `__dirname` at load time; its value is irrelevant
	// because the shim returns an absolute directory, but it must be defined in ESM.
	shims: true,
	clean: false,
	dts: false,
	// A SEA has no node_modules, so every dependency has to end up in the one chunk.
	deps: { alwaysBundle: [/.*/], onlyBundle: false },
	plugins: [
		{
			name: 'devsess-node-pty-sea-utils',
			resolveId(source, importer) {
				if (source !== './utils' || importer === undefined) return null;
				if (!importer.replaceAll('\\', '/').includes(`/${nodePtyLib}`))
					return null;
				return nodePtyShim;
			},
		},
	],
	exe: {
		fileName: 'devsess',
		outDir: 'build',
		seaConfig: { assets, useCodeCache: true },
	},
});
