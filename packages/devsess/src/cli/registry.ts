import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';

const ServiceStateSchema = Schema.Union([
	Schema.Literal('starting'),
	Schema.Literal('running'),
	Schema.Literal('stopping'),
	Schema.Literal('exited'),
	Schema.Literal('failed'),
	Schema.Literal('orphaned'),
]);

export type ServiceState = typeof ServiceStateSchema.Type;

export const ServiceRecordSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	command: Schema.NonEmptyString,
	cwd: Schema.NonEmptyString,
	state: ServiceStateSchema,
	process: Schema.optionalKey(
		Schema.Struct({
			pid: Schema.Int,
			processGroupId: Schema.Int,
			startedAt: Schema.NonEmptyString,
		}),
	),
});

export type ServiceRecord = typeof ServiceRecordSchema.Type;

export const RunRecordSchema = Schema.Struct({
	runId: Schema.NonEmptyString,
	projectName: Schema.NonEmptyString,
	presetName: Schema.NonEmptyString,
	canonicalCwd: Schema.NonEmptyString,
	invocationCwd: Schema.NonEmptyString,
	configSnapshot: Schema.Json,
	startedAt: Schema.NonEmptyString,
	state: ServiceStateSchema,
	daemon: Schema.Struct({
		pid: Schema.Int,
		processGroupId: Schema.Int,
		startedAt: Schema.NonEmptyString,
	}),
	services: Schema.Array(ServiceRecordSchema),
});

export type RunRecord = typeof RunRecordSchema.Type;

class RunAlreadyReserved extends Schema.TaggedErrorClass<RunAlreadyReserved>()(
	'devsess/cli/RunAlreadyReserved',
	{
		runId: Schema.String,
		projectName: Schema.String,
		presetName: Schema.String,
	},
) {}

class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()(
	'devsess/cli/RunNotFound',
	{ runId: Schema.String },
) {}

const StoredRunsSchema = Schema.fromJsonString(Schema.Array(RunRecordSchema));

const isActive = (state: ServiceState) =>
	state === 'starting' || state === 'running' || state === 'stopping';

const writeAtomically = (target: string, content: string) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
		yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
		yield* fileSystem.rename(temporary, target);
	});

export class Registry extends Context.Service<
	Registry,
	{
		readonly reserve: (
			run: RunRecord,
		) => Effect.Effect<
			void,
			PlatformError | Schema.SchemaError | RunAlreadyReserved,
			FileSystem | Path
		>;
		readonly replace: (
			run: RunRecord,
		) => Effect.Effect<
			RunRecord,
			PlatformError | Schema.SchemaError | RunNotFound,
			FileSystem | Path
		>;
		readonly get: (
			runId: string,
		) => Effect.Effect<
			RunRecord,
			PlatformError | Schema.SchemaError | RunNotFound,
			FileSystem | Path
		>;
		readonly list: Effect.Effect<
			ReadonlyArray<RunRecord>,
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
		readonly markOrphans: Effect.Effect<
			ReadonlyArray<RunRecord>,
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
	}
>()('devsess/cli/Registry') {
	static readonly layer = (options: { dataDirectory: string }) =>
		Layer.effect(Registry, makeRegistry(options));
}

const makeRegistry = (options: { dataDirectory: string }) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const semaphore = yield* Semaphore.make(1);
		const target = path.join(options.dataDirectory, 'running.json');
		const read = fileSystem
			.exists(target)
			.pipe(
				Effect.flatMap((exists) =>
					exists
						? fileSystem
								.readFileString(target)
								.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(StoredRunsSchema)),
								)
						: Effect.succeed([] as Array<RunRecord>),
				),
			);
		const persist = (runs: Array<RunRecord>) =>
			writeAtomically(target, JSON.stringify(runs));
		const serialize = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			semaphore.withPermit(effect);
		const reserve = (run: RunRecord) =>
			serialize(
				read.pipe(
					Effect.flatMap(
						(
							runs,
						): Effect.Effect<
							void,
							PlatformError | RunAlreadyReserved,
							FileSystem | Path
						> => {
							const conflicting = runs.find(
								(candidate) =>
									candidate.runId === run.runId ||
									(candidate.projectName === run.projectName &&
										candidate.presetName === run.presetName &&
										isActive(candidate.state)),
							);
							return conflicting === undefined
								? persist([...runs, run])
								: Effect.fail(
										new RunAlreadyReserved({
											runId: conflicting.runId,
											projectName: conflicting.projectName,
											presetName: conflicting.presetName,
										}),
									);
						},
					),
				),
			);
		const replace = (run: RunRecord) =>
			serialize(
				read.pipe(
					Effect.flatMap(
						(
							runs,
						): Effect.Effect<
							RunRecord,
							PlatformError | RunNotFound,
							FileSystem | Path
						> =>
							runs.some((candidate) => candidate.runId === run.runId)
								? persist(
										runs.map((candidate) =>
											candidate.runId === run.runId ? run : candidate,
										),
									).pipe(Effect.as(run))
								: Effect.fail(new RunNotFound({ runId: run.runId })),
					),
				),
			);
		const get = (runId: string) =>
			serialize(
				read.pipe(
					Effect.flatMap((runs) => {
						const run = runs.find((candidate) => candidate.runId === runId);
						return run === undefined
							? Effect.fail(new RunNotFound({ runId }))
							: Effect.succeed(run);
					}),
				),
			);
		const markOrphans = serialize(
			read.pipe(
				Effect.map((runs) =>
					runs.map((run) => ({
						...run,
						state: isActive(run.state) ? ('orphaned' as const) : run.state,
						services: run.services.map((service) => ({
							...service,
							state: isActive(service.state)
								? ('orphaned' as const)
								: service.state,
						})),
					})),
				),
				Effect.tap(persist),
			),
		);
		return Registry.of({
			reserve,
			replace,
			get,
			list: serialize(read),
			markOrphans,
		});
	});
