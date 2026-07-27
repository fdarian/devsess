import { describe, expect, it } from '@effect/vitest';
import * as pkg from 'devsess';
import type { DevSession as AsyncDevSession } from 'devsess/async';
import * as pkgAsync from 'devsess/async';
import * as pkgPglite from 'devsess/pglite';

/**
 * Imports through the published package specifiers (`devsess`, `devsess/async`,
 * `devsess/pglite`) rather than relative `src` paths, so a broken `tsup` entry or a stale
 * `package.json` `exports` map shows up here — a relative import would silently keep
 * working even if the built output drifted. Requires `dist/` to be up to date
 * (`bun run build`).
 */
describe('the root entrypoint (.)', () => {
	it('exports the Effect-based API', () => {
		expect(typeof pkg.DevSessions).toBe('function');
		expect(typeof pkg.DevSessions.layer).toBe('object');
		expect(typeof pkg.DevSessions.layerAt).toBe('function');
		expect(typeof pkg.CurrentSession).toBe('function');
		expect(typeof pkg.CurrentSession.layer).toBe('object');
		expect(typeof pkg.CurrentSession.layerOf).toBe('function');
		expect(typeof pkg.ProjectRootNotFoundError).toBe('function');
		expect(typeof pkg.getStickyPort).toBe('function');
		expect(typeof pkg.runManagedSubprocess).toBe('function');
		expect(typeof pkg.publishRunning).toBe('function');
		expect(typeof pkg.awaitRunning).toBe('function');
		expect(typeof pkg.SessionState).toBe('object');
		expect(typeof pkg.SessionState.slot).toBe('function');
		expect(typeof pkg.SessionStateError).toBe('function');
	});

	it('deliberately does not re-export Schema (unlike ./async)', () => {
		expect('Schema' in pkg).toBe(false);
	});

	it('no longer re-exports defineDevCli, cli, or DevPlatform/DevServices', () => {
		expect('defineDevCli' in pkg).toBe(false);
		expect('cli' in pkg).toBe(false);
		expect('makeDevSessionsLayer' in pkg).toBe(false);
	});
});

describe('./async', () => {
	it('exports the Promise-based facade', () => {
		expect(typeof pkgAsync.defineDevCli).toBe('function');
		expect(typeof pkgAsync.createDevSessions).toBe('function');
		expect(typeof pkgAsync.SessionState).toBe('object');
		expect(typeof pkgAsync.SessionState.slot).toBe('function');
		expect(typeof pkgAsync.SessionStateError).toBe('function');
		expect(typeof pkgAsync.cli).toBe('object');
	});

	it('re-exports Schema, unlike the root entrypoint', () => {
		expect(typeof pkgAsync.Schema).toBe('object');
	});
});

describe('./pglite', () => {
	it('exports the pglite/Drizzle adapter', () => {
		expect(typeof pkgPglite.prepareSessionPglite).toBe('function');
		expect(typeof pkgPglite.openLitePglite).toBe('function');
		expect(typeof pkgPglite.createPgliteFromDump).toBe('function');
		expect(typeof pkgPglite.dumpPgliteToFile).toBe('function');
		expect(typeof pkgPglite.migratePglite).toBe('function');
		expect(typeof pkgPglite.buildPgliteDump).toBe('function');
		expect(typeof pkgPglite.ensurePgliteDump).toBe('function');
		expect(typeof pkgPglite.getDbMigrationCount).toBe('function');
		expect(typeof pkgPglite.getExpectedMigrationCount).toBe('function');
		expect(typeof pkgPglite.PgliteError).toBe('function');
	});
});

describe('SessionStateError', () => {
	it('is the exact same class from both `.` and `./async` — not two duplicates', () => {
		expect(pkgAsync.SessionStateError).toBe(pkg.SessionStateError);
	});
});

describe('DevSession type parity (compile-time only)', () => {
	it('rejects an async DevSession where the Effect-based one is required', () => {
		// The async and Effect `DevSession` shapes differ only in what `path()`
		// returns (`string` vs `Effect.Effect<string>`) — there's no runtime guard
		// for this, so `check:type` is what actually enforces it. If this stops
		// erroring, `@ts-expect-error` itself fails the type check, which is the
		// point: it means the two `DevSession` shapes became compatible again.
		const asyncSession: AsyncDevSession = {
			name: 'test-session',
			lastModifiedAt: null,
			path: (relativePath) => relativePath,
			toString: () => 'test-session',
		};

		// @ts-expect-error - async DevSession#path returns a string, not an
		// Effect, so it must not satisfy prepareSessionPglite's Effect DevSession.
		pkgPglite.prepareSessionPglite(asyncSession, { migrationsFolder: '/tmp' });

		expect(true).toBe(true);
	});
});
