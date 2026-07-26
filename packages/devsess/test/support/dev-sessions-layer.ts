import { NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { makeDevSessionsLayer } from '../../src/dev-sessions';

/**
 * `DevSessions` rooted at `dir`, with the Node platform services (`FileSystem`, `Path`,
 * ...) it depends on already merged in. Most tests need exactly this pair — build the
 * dir with `makeTempDir` first, then `Effect.provide(makeTestDevSessionsLayer(dir))`.
 */
export const makeTestDevSessionsLayer = (dir: string) =>
	makeDevSessionsLayer(dir).pipe(Layer.provideMerge(NodeServices.layer));
