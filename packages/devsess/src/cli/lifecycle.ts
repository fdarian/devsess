import { Context, Effect, Layer } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import { Daemon, type DaemonError, type DaemonService } from './daemon';
import type { DaemonRequest } from './protocol';

export type DaemonLifecycleService = {
	readonly daemon: DaemonService;
};

export class DaemonLifecycle extends Context.Service<
	DaemonLifecycle,
	DaemonLifecycleService
>()('devsess/cli/DaemonLifecycle') {
	static readonly layer: (options: {
		socketPath: string;
		dataDirectory: string;
	}) => Layer.Layer<DaemonLifecycle, unknown, FileSystem | Path> = (options) =>
		Layer.effect(
			DaemonLifecycle,
			Daemon.pipe(Effect.map((daemon) => DaemonLifecycle.of({ daemon }))),
		).pipe(
			Layer.provideMerge(
				Daemon.layer({
					socketPath: options.socketPath,
					dataDirectory: options.dataDirectory,
					maxLogBytes: 1024 * 1024,
				}),
			),
		);
}
