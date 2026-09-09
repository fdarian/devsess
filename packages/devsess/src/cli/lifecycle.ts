import { Context, Effect, Layer } from 'effect';
import { makeDaemon, type Daemon } from './daemon';

export class DaemonLifecycle extends Context.Service<DaemonLifecycle, {
	readonly daemon: Daemon;
}>()('devsess/cli/DaemonLifecycle') {
	static readonly layer = (options: { socketPath: string; dataDirectory: string }) =>
		Layer.effect(
			DaemonLifecycle,
			Effect.acquireRelease(
				Effect.tryPromise({ try: async () => { const daemon = makeDaemon(options); await daemon.listen(); return daemon; }, catch: (cause) => cause }),
				(daemon) => Effect.tryPromise({ try: () => daemon.close(), catch: (cause) => cause }).pipe(Effect.catch(() => Effect.void)),
			).pipe(Effect.map((daemon) => DaemonLifecycle.of({ daemon }))),
		);
}
