import { basename } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Schema, Scope } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import { Service, type ServiceDefinition } from './index';
import { ServiceError } from './core';
import { io } from './shared-protocol';
import { serveHost } from './shared-host';

const program = Effect.gen(function* () {
	const args = yield* Schema.decodeUnknownEffect(
		Schema.Tuple([Schema.String, Schema.String, Schema.String]),
	)(process.argv.slice(2));
	const module = yield* io(
		() => import(args[0]) as Promise<Record<string, unknown>>,
	);
	const candidates = Object.values(module).filter(
		(
			value,
		): value is ServiceDefinition<
			string,
			string,
			unknown,
			unknown,
			Scope.Scope | FileSystem | Path
		> =>
			typeof value === 'object' &&
			value !== null &&
			'name' in value &&
			value.name === args[1] &&
			'start' in value &&
			'shared' in value,
	);
	const def = candidates[0];
	if (candidates.length !== 1 || def === undefined || def.shared === undefined)
		return yield* new ServiceError({
			message: `Export exactly one shared service named ${args[1]} from ${args[0]}`,
		});
	const scope = yield* Scope.make();
	const output = def.shared.output;
	const session = {
		name: basename(args[2]),
		lastModifiedAt: null,
		path: (relative: string) => Effect.succeed(`${args[2]}/${relative}`),
		toString: () => basename(args[2]),
	};
	const close = Scope.close(scope, Exit.void);
	yield* Effect.gen(function* () {
		const original = { value: undefined as unknown };
		const value = yield* Service.run(session, {
			...def,
			shared: undefined,
			start: (ctx) =>
				def.start(ctx).pipe(
					Effect.tap((value) =>
						Effect.sync(() => {
							original.value = value;
						}),
					),
				),
		}).pipe(Effect.provideService(Scope.Scope, scope));
		const line = yield* Schema.encodeEffect(
			Schema.fromJsonString(
				Schema.Struct({
					output,
					ports: Schema.Record(Schema.String, Schema.Number),
				}),
			),
		)({ output: original.value, ports: value.ports });
		yield* serveHost(`${args[2]}/services/${def.name}`, line, close);
	}).pipe(Effect.ensuring(close));
}).pipe(Effect.provide(NodeServices.layer));

Effect.runPromise(program).catch((cause) => {
	Effect.runSync(Effect.logError(cause));
	process.exitCode = 1;
});
