import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		setupFiles: ['./test/support/mocks.ts'],
		// Everything here touches the real filesystem, spawns real child processes,
		// or probes real sockets — keep headroom above vitest's 5s default.
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
