import { basename } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Schema, Scope } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import { ServiceError } from '../core';
import type { ServiceDefinition } from '../index';
import { runLocal } from '../local';
import { serveHost } from './host';
import { io } from './protocol';

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
			message: `export the shared service \`${args[1]}\` from the file that calls Service.make (${args[0]}); exactly one matching export is required`,
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
		const value = yield* runLocal(session, {
			...def,
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

/** A pending Promise and unref'd handler resources cannot keep the process alive during scope close. */
const lifetime = Effect.acquireUseRelease(
	Effect.sync(() => setInterval(() => {}, 1_000)),
	() => program,
	(timer) => Effect.sync(() => clearInterval(timer)),
);

Effect.runPromise(lifetime).catch((cause) => {
	Effect.runSync(Effect.logError(cause));
	process.exitCode = 1;
});
