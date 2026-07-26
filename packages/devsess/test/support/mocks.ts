import { vi } from 'vitest';

/**
 * Loaded once per test file via `vitest.config.ts`'s `setupFiles`, so every test gets
 * these mocks without repeating `vi.mock` boilerplate. Both mocks default to the real
 * implementation — call `vi.mocked(generateSlug)` / `vi.mocked(getPort)` in a test to
 * override behavior (e.g. `.mockReturnValueOnce('fixed-slug')`), and `vi.restoreAllMocks()`
 * afterwards to go back to the pass-through default.
 */

vi.mock('random-word-slugs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('random-word-slugs')>();
	return { ...actual, generateSlug: vi.fn(actual.generateSlug) };
});

vi.mock('get-port', async (importOriginal) => {
	const actual = await importOriginal<typeof import('get-port')>();
	return { ...actual, default: vi.fn(actual.default) };
});
