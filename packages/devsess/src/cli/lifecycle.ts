import { Context, Effect, Layer } from 'effect';
import { Daemon, type DaemonError } from './daemon';
import type { DaemonRequest } from './protocol';

export class DaemonLifecycle extends Context.Service<
	DaemonLifecycle,
	{
		readonly daemon: {
			readonly request: (
				incoming: DaemonRequest,
			) => Effect.Effect<unknown, DaemonError>;
		};
	}
>()('devsess/cli/DaemonLifecycle') {
	static readonly layer = (options: {
		socketPath: string;
		dataDirectory: string;
	}) =>
		Layer.effect(
			DaemonLifecycle,
			Daemon.pipe(Effect.map((daemon) => DaemonLifecycle.of({ daemon }))),
		).pipe(
			Layer.provide(
				Daemon.layer({
					socketPath: options.socketPath,
					dataDirectory: options.dataDirectory,
					maxLogBytes: 1024 * 1024,
				}),
			),
		);
}
