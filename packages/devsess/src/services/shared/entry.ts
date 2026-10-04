import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Schema, Scope } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import { DevSessions } from '../../dev-sessions';
import { ServiceError, serviceBrand } from '../core';
import type { ServiceDefinition } from '../index';
import { runLocal } from '../local';
import { serveHost } from './host';
import { hostArguments, hostPaths, io, readyMessage } from './protocol';

const program = Effect.gen(function* () {
	const args = yield* Schema.decodeUnknownEffect(hostArguments)(
		process.argv[2],
	);
	const module = yield* io(
		'Failed to import shared service definition',
		() => import(args.module) as Promise<Record<string, unknown>>,
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
			serviceBrand in value &&
			value[serviceBrand] === true &&
			'name' in value &&
			value.name === args.name,
	);
	const def = candidates[0];
	if (candidates.length !== 1 || def === undefined || def.shared === undefined)
		return yield* new ServiceError({
			message: `export the shared service \`${args.name}\` from the file that calls Service.make (${args.module}); exactly one matching export is required`,
		});
	const scope = yield* Scope.make();
	const output = def.shared.output;
	const session = yield* DevSessions.use((sessions) =>
		sessions.getOrCreate(args.session),
	).pipe(Effect.provide(DevSessions.layerAt(args.root)));
	const paths = hostPaths(yield* session.path(''), def.name);
	const close = Scope.close(scope, Exit.void);
	yield* Effect.gen(function* () {
		const result = yield* runLocal(session, def).pipe(
			Effect.provideService(Scope.Scope, scope),
		);
		const line = yield* Schema.encodeEffect(readyMessage(output))({
			output: result.value,
			ports: result.ports,
		});
		yield* serveHost(paths, line, close);
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
