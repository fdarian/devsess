import { Effect, Schema, Stream } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';
import { Identifier } from './identifiers';

export const LogAddressSchema = Schema.Struct({
	runId: Identifier,
	serviceName: Identifier,
});
export type LogAddress = typeof LogAddressSchema.Type;

const NonNegativeInt = Schema.Int.check(
	Schema.makeFilter((value) => value >= 0),
);

export const LogEventSchema = Schema.Struct({
	data: Schema.String,
	offset: NonNegativeInt,
});
export type LogEvent = typeof LogEventSchema.Type;

const LogLineSchema = Schema.fromJsonString(LogEventSchema);
const textEncoder = new TextEncoder();

type Segment = {
	readonly events: Array<LogEvent>;
	readonly content: string;
	readonly bytes: number;
	readonly exists: boolean;
	readonly partial: boolean;
};

type LogState = {
	nextOffset: number;
	currentBytes: number;
	currentExists: boolean;
	currentPartial: boolean;
};

export type LogReplayStream = Stream.Stream<
	LogEvent,
	Schema.SchemaError,
	never
>;

export type LogReplay = ReadonlyArray<LogEvent> | LogReplayStream;

export type LogReplaySnapshot = {
	readonly after: number;
	readonly cutoff: number;
	readonly previous: string;
	readonly current: string;
};

export type LogAppendResult = {
	readonly events: ReadonlyArray<LogEvent>;
	readonly final: LogEvent;
};

export type LogSegments = {
	readonly append: (
		address: LogAddress,
		data: string,
	) => Effect.Effect<
		LogAppendResult,
		PlatformError | Schema.SchemaError,
		FileSystem | Path
	>;
	readonly replay: (
		snapshot: LogReplaySnapshot,
	) => Effect.Effect<
		ReadonlyArray<LogEvent>,
		PlatformError | Schema.SchemaError,
		FileSystem | Path
	>;
	readonly captureReplay: (
		address: LogAddress,
		after: number,
	) => Effect.Effect<
		LogReplaySnapshot,
		PlatformError | Schema.SchemaError,
		FileSystem | Path
	>;
	readonly replayStream: (snapshot: LogReplaySnapshot) => LogReplayStream;
};

const isUtf8Continuation = (value: number) => (value & 0xc0) === 0x80;
const utf8Width = (value: number) =>
	value < 0x80 ? 1 : value < 0xe0 ? 2 : value < 0xf0 ? 3 : 4;

const splitData = (data: string, maxBytes: number) => {
	const encoded = textEncoder.encode(data);
	const chunks: Array<string> = [];
	if (encoded.byteLength === 0) return [''];
	let offset = 0;
	while (offset < encoded.byteLength) {
		let end = Math.min(offset + maxBytes, encoded.byteLength);
		if (end < encoded.byteLength && isUtf8Continuation(encoded[end] ?? 0)) {
			let codePointStart = end - 1;
			while (
				codePointStart > offset &&
				isUtf8Continuation(encoded[codePointStart] ?? 0)
			)
				codePointStart -= 1;
			end = Math.min(
				codePointStart + utf8Width(encoded[codePointStart] ?? 0),
				encoded.byteLength,
			);
		}
		chunks.push(Buffer.from(encoded.subarray(offset, end)).toString('utf8'));
		offset = end;
	}
	return chunks;
};

export const makeLogSegments = (options: {
	readonly dataDirectory: string;
	readonly maxBytes: number;
}): Effect.Effect<LogSegments, never, FileSystem | Path> =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const states = new Map<string, LogState>();
		const logBase = (address: LogAddress) =>
			path.join(
				options.dataDirectory,
				'logs',
				address.runId,
				address.serviceName,
			);
		const currentPath = (address: LogAddress) => `${logBase(address)}.jsonl`;
		const previousPath = (address: LogAddress) => `${logBase(address)}.1.jsonl`;

		const decodeLine = (
			line: string,
		): Effect.Effect<LogEvent, Schema.SchemaError> =>
			Schema.decodeUnknownEffect(LogLineSchema)(line);
		const decodeLines = (content: string) => {
			const lines = content.split('\n');
			lines.pop();
			const complete = lines.filter((line) => line.length > 0);
			return Effect.forEach(complete, decodeLine, { discard: false });
		};
		const readSegment = (
			target: string,
		): Effect.Effect<Segment, PlatformError | Schema.SchemaError> =>
			fileSystem.exists(target).pipe(
				Effect.flatMap((exists) =>
					exists
						? fileSystem.readFileString(target).pipe(
								Effect.flatMap((content) =>
									decodeLines(content).pipe(
										Effect.map((events) => ({
											events,
											content,
											bytes: textEncoder.encode(content).byteLength,
											exists: true as boolean,
											partial: !content.endsWith('\n'),
										})),
									),
								),
							)
						: Effect.succeed({
								events: [] as Array<LogEvent>,
								content: '',
								bytes: 0,
								exists: false as boolean,
								partial: false,
							}),
				),
			);
		const readSegments = (address: LogAddress) =>
			Effect.all({
				previous: readSegment(previousPath(address)),
				current: readSegment(currentPath(address)),
			});
		const completeLines = function* (content: string) {
			let start = 0;
			for (let index = 0; index < content.length; index += 1) {
				if (content[index] !== '\n') continue;
				const line = content.slice(start, index);
				if (line.length > 0) yield line;
				start = index + 1;
			}
		};
		const readContentStream = (content: string) =>
			Stream.fromIteratorSucceed(completeLines(content)).pipe(
				Stream.mapEffect((line) => decodeLine(line)),
			);
		const loadState = (address: LogAddress) => {
			const key = `${address.runId}:${address.serviceName}`;
			const existing = states.get(key);
			if (existing !== undefined) return Effect.succeed(existing);
			return readSegments(address).pipe(
				Effect.map((segments) => {
					const allEvents = [
						...segments.previous.events,
						...segments.current.events,
					];
					const last = allEvents[allEvents.length - 1];
					const state: LogState = {
						nextOffset: last === undefined ? 0 : last.offset,
						currentBytes: segments.current.bytes,
						currentExists: segments.current.exists,
						currentPartial: segments.current.partial,
					};
					states.set(key, state);
					return state;
				}),
			);
		};
		const rotate = (address: LogAddress, state: LogState) => {
			const current = currentPath(address);
			const previous = previousPath(address);
			return fileSystem
				.makeDirectory(path.dirname(current), { recursive: true })
				.pipe(
					Effect.andThen(
						state.currentExists
							? fileSystem.rename(current, previous)
							: Effect.void,
					),
					Effect.tap(() =>
						Effect.sync(() => {
							state.currentBytes = 0;
							state.currentExists = false;
							state.currentPartial = false;
						}),
					),
				);
		};
		const appendLine = (
			address: LogAddress,
			state: LogState,
			event: LogEvent,
		) => {
			const target = currentPath(address);
			const line = `${JSON.stringify(event)}\n`;
			const lineBytes = textEncoder.encode(line).byteLength;
			const needsRotation =
				state.currentPartial ||
				(state.currentExists &&
					state.currentBytes + lineBytes > options.maxBytes);
			const beforeWrite = needsRotation ? rotate(address, state) : Effect.void;
			return beforeWrite.pipe(
				Effect.andThen(
					fileSystem.makeDirectory(path.dirname(target), { recursive: true }),
				),
				Effect.andThen(
					fileSystem.writeFileString(target, line, {
						flag: 'a',
						mode: 0o600,
					}),
				),
				Effect.tap(() =>
					Effect.sync(() => {
						state.currentBytes += lineBytes;
						state.currentExists = true;
						state.currentPartial = false;
					}),
				),
			);
		};
		const append = (address: LogAddress, data: string) =>
			loadState(address).pipe(
				Effect.flatMap((state) => {
					const chunks = splitData(data, options.maxBytes);
					const events: Array<LogEvent> = [];
					let nextOffset = state.nextOffset;
					for (const chunk of chunks) {
						nextOffset += textEncoder.encode(chunk).byteLength;
						events.push({ data: chunk, offset: nextOffset });
					}
					const final = events[events.length - 1];
					if (final === undefined) return Effect.die('empty log event');
					return Effect.forEach(
						events,
						(event) => appendLine(address, state, event),
						{
							discard: true,
						},
					).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								state.nextOffset = final.offset;
							}),
						),
						Effect.as({ events, final }),
					);
				}),
			);
		const captureReplay = (address: LogAddress, after: number) =>
			loadState(address).pipe(
				Effect.flatMap((state) =>
					readSegments(address).pipe(
						Effect.map((segments) => ({
							after,
							cutoff: state.nextOffset + 1,
							previous: segments.previous.content,
							current: segments.current.content,
						})),
					),
				),
			);
		const replayStream = (snapshot: LogReplaySnapshot): LogReplayStream =>
			readContentStream(snapshot.previous).pipe(
				Stream.concat(readContentStream(snapshot.current)),
				Stream.filter(
					(event) =>
						event.offset > snapshot.after && event.offset < snapshot.cutoff,
				),
			);
		const replay = (snapshot: LogReplaySnapshot) =>
			Effect.all([
				decodeLines(snapshot.previous),
				decodeLines(snapshot.current),
			]).pipe(
				Effect.map((segments) =>
					[...segments[0], ...segments[1]].filter(
						(event) =>
							event.offset > snapshot.after && event.offset < snapshot.cutoff,
					),
				),
			);
		return { append, captureReplay, replay, replayStream };
	});
