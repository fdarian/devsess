import { Context, Effect, Layer, type Schema, Semaphore } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';
import { makeLogFanout } from './log-fanout';
import {
	type LogAddress,
	type LogEvent,
	type LogReplay,
	makeLogSegments,
} from './log-segments';

export type { LogAddress, LogEvent } from './log-segments';
export { LogAddressSchema, LogEventSchema } from './log-segments';

export class Logs extends Context.Service<
	Logs,
	{
		readonly append: (
			address: LogAddress,
			data: string,
		) => Effect.Effect<
			LogEvent,
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
		readonly replayAndSubscribe: (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) => Effect.Effect<
			{
				readonly replay: ReadonlyArray<LogEvent>;
				readonly flush: Effect.Effect<void>;
				readonly unsubscribe: Effect.Effect<void>;
			},
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
		readonly replayAndSubscribeLazy?: (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) => Effect.Effect<
			{
				readonly replay: LogReplay;
				readonly flush: Effect.Effect<void>;
				readonly unsubscribe: Effect.Effect<void>;
			},
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
	}
>()('devsess/cli/Logs') {
	static readonly layer = (options: {
		dataDirectory: string;
		maxBytes: number;
	}) => Layer.effect(Logs, makeLogs(options));
}

const makeLogs = (options: { dataDirectory: string; maxBytes: number }) =>
	Effect.gen(function* () {
		const semaphore = yield* Semaphore.make(1);
		const segments = yield* makeLogSegments(options);
		const fanout = makeLogFanout();
		const append = (address: LogAddress, data: string) =>
			semaphore.withPermit(
				segments.append(address, data).pipe(
					Effect.tap((result) => fanout.notify(address, result.events)),
					Effect.map((result) => result.final),
				),
			);
		const replayAndSubscribe = (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) =>
			semaphore.withPermit(
				segments
					.replay(address, after)
					.pipe(
						Effect.flatMap((replay) =>
							fanout.subscribe(address, replay, listener),
						),
					),
			);
		const replayAndSubscribeLazy = (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) =>
			semaphore.withPermit(
				Effect.succeed(segments.replayStream(address, after)).pipe(
					Effect.flatMap((replay) =>
						fanout.subscribe(address, replay, listener),
					),
				),
			);
		return { append, replayAndSubscribe, replayAndSubscribeLazy };
	});

export type LogsService = Context.Service.Shape<typeof Logs>;
