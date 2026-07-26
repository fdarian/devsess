import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';

/**
 * Creates a uniquely-named temp directory, recursively removed once the enclosing
 * scope closes (e.g. the scope `it.effect` opens for each test). Everything in this
 * package writes to a real filesystem, so tests exercising `DevSessions`, session
 * state, or pglite need one of these rather than an in-memory stand-in. Self-contained
 * (brings its own `NodeServices`), so `yield* makeTempDir` only needs a `Scope`.
 */
export const makeTempDir = Effect.gen(function* () {
	const fs = yield* FileSystem;
	return yield* fs.makeTempDirectoryScoped({ prefix: 'devsess-test-' });
}).pipe(Effect.provide(NodeServices.layer));
