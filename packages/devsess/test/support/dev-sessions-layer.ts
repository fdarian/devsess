import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { DevSessions } from '../../src/dev-sessions';

/**
 * `DevSessions` rooted at `dir`, with the Node platform services (`FileSystem`, `Path`,
 * ...) it depends on already merged in. Most tests need exactly this pair — build the
 * dir with `makeTempDir` first, then `Effect.provide(makeTestDevSessionsLayer(dir))`.
 */
export const makeTestDevSessionsLayer = (dir: string) =>
	DevSessions.layerAt(dir).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Where `DevSessions.layerAt(rootDir)` (and thus `makeTestDevSessionsLayer`) actually
 * stores session directories — tests that poke the filesystem directly (rather than
 * going through `getSessions`/`createSession`) need this to find them.
 */
export const sessionsStorageDir = (rootDir: string) =>
	join(rootDir, '.data', 'sessions');
