import { isSea } from 'node:sea';

/** Inside a SEA binary `process.argv[1]` is just the invocation string, not a script to re-run. */
export const selfInvocationArguments = (): Array<string> =>
	isSea() ? [] : [process.argv[1] ?? 'devsess'];

export const selfScriptPath = (): string | undefined =>
	isSea() ? process.execPath : process.argv[1];
