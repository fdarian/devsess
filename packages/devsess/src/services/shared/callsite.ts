import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Effect } from 'effect';
import { ServiceError } from '../core';

const packageDir = fileURLToPath(import.meta.url).match(
	/^(.*)\/(?:src|dist)\//,
)?.[1];

export const definitionModule = (stack: string | undefined) =>
	Effect.gen(function* () {
		if (packageDir === undefined)
			return yield* new ServiceError({
				message: 'Unable to identify devsess internal stack frames',
			});
		if (stack !== undefined) {
			for (const frame of stack.split('\n').slice(1)) {
				const match = frame.match(
					/(?:\(|\s|@)((?:file:\/\/|\/)[^\n]*?):\d+:\d+\)?$/,
				);
				const location = match?.[1];
				if (location === undefined) continue;
				const file = yield* Effect.try({
					try: () =>
						location.startsWith('file://')
							? fileURLToPath(location)
							: resolve(location),
					catch: (cause) =>
						new ServiceError({
							message: 'Invalid service callsite path',
							cause,
						}),
				});
				if (
					file.startsWith(`${packageDir}/src/`) ||
					file.startsWith(`${packageDir}/dist/`)
				)
					continue;
				return yield* Effect.try({
					try: () => pathToFileURL(file).href,
					catch: (cause) =>
						new ServiceError({ message: 'Invalid service module URL', cause }),
				});
			}
		}
		return yield* new ServiceError({
			message:
				'Unable to locate the file that calls Service.make for a shared service',
		});
	});
