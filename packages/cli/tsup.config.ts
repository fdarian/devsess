import { defineConfig } from 'tsup';

export default defineConfig({
	entry: { cli: 'src/cli.ts' },
	format: ['esm'],
	target: 'node20',
	platform: 'node',
	outDir: 'dist',
	clean: true,
	sourcemap: true,
	dts: false,
	external: ['effect', '@effect/platform-node'],
});
