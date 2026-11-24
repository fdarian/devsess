import { isSea } from './sea';

/** Inside a SEA binary `process.argv[1]` is just the invocation string, not a script to re-run. */
export const selfInvocationArguments = (): Array<string> =>
	isSea() ? [] : [process.argv[1] ?? 'devsess'];

/**
 * `brew upgrade` deletes the versioned Cellar folder, so anything persisted or compared across an
 * upgrade (the launchd plist, the daemon's reported executable) must name the stable `opt` symlink.
 * Pure string mapping: it never touches the filesystem.
 */
export const homebrewStablePath = (executablePath: string): string =>
	executablePath.replace(
		/^(.*)\/Cellar\/devsess\/[^/]+\/bin\/devsess$/,
		'$1/opt/devsess/bin/devsess',
	);

/** Node resolves `process.execPath` through symlinks, so a Homebrew install reports the Cellar path rather than the opt one. */
export const stableExecPath = (): string =>
	homebrewStablePath(process.execPath);

export const selfScriptPath = (): string | undefined =>
	isSea() ? stableExecPath() : process.argv[1];
