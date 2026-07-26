import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		'pglite/index': 'src/pglite/index.ts',
		'async/index': 'src/async/index.ts',
	},
	format: ['esm'],
	target: 'node20',
	platform: 'node',
	outDir: 'dist',
	clean: true,
	sourcemap: true,
	// Declarations are emitted by `tsc -p tsconfig.build.json` (see build script).
	dts: false,
	// Peer dependencies must never be bundled — consumers provide a single instance.
	external: ['effect', '@electric-sql/pglite', 'drizzle-orm'],
});
