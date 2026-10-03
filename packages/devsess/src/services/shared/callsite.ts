import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ServiceError } from '../core';

const packageDir = fileURLToPath(import.meta.url).match(
	/^(.*)\/(?:src|dist)\//,
)?.[1];

export const definitionModule = (stack: string | undefined) => {
	if (stack !== undefined) {
		for (const frame of stack.split('\n').slice(1)) {
			const match = frame.match(
				/(?:\(|\s|@)((?:file:\/\/|\/)[^\n]*?):\d+:\d+\)?$/,
			);
			const location = match?.[1];
			if (location === undefined) continue;
			const file = location.startsWith('file://')
				? fileURLToPath(location)
				: resolve(location);
			if (packageDir === undefined)
				throw new ServiceError({
					message: 'Unable to identify devsess internal stack frames',
				});
			if (
				file.startsWith(`${packageDir}/src/`) ||
				file.startsWith(`${packageDir}/dist/`)
			)
				continue;
			return pathToFileURL(file).href;
		}
	}
	throw new ServiceError({
		message:
			'Unable to locate the file that calls Service.make for a shared service',
	});
};
