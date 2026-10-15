import { execFile } from 'node:child_process';
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Config, Context, Effect, Layer, Option } from 'effect';
import { DaemonBootstrapError, daemonLogPath } from './bootstrap';

export const DAEMON_LAUNCHD_LABEL = 'dev.devsess.daemon';

const LAUNCHCTL_TIMEOUT_MS = 10_000;
const LAUNCHCTL_SERVICE_NOT_FOUND = 113;
const UNLOAD_TIMEOUT_MS = 5_000;
const UNLOAD_POLL_INTERVAL_MS = 50;

export const launchdPlistPath = (home = homedir()) =>
	join(home, 'Library', 'LaunchAgents', `${DAEMON_LAUNCHD_LABEL}.plist`);

/** Only the default macOS location is launchd-managed; an explicit XDG directory is a deliberate opt-out, which is how every test isolates itself. */
export const launchdApplies = (
	platform: NodeJS.Platform,
	explicit: { stateHome: boolean; runtimeDirectory: boolean },
) => platform === 'darwin' && !explicit.stateHome && !explicit.runtimeDirectory;

export const usesLaunchd = Effect.gen(function* () {
	const stateHome = yield* Config.String('XDG_STATE_HOME').pipe(Config.option);
	const runtimeDirectory = yield* Config.String('XDG_RUNTIME_DIR').pipe(
		Config.option,
	);
	return launchdApplies(process.platform, {
		stateHome: Option.isSome(stateHome),
		runtimeDirectory: Option.isSome(runtimeDirectory),
	});
});

const escapeXml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

/** `KeepAlive.SuccessfulExit = false` relaunches a crashed or killed daemon but leaves a cleanly stopped one down; `RunAtLoad` stays off so the job only runs when a client kickstarts it. */
export const renderDaemonPlist = (options: {
	label: string;
	programArguments: ReadonlyArray<string>;
	logPath: string;
}) =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		'	<key>Label</key>',
		`	<string>${escapeXml(options.label)}</string>`,
		'	<key>ProgramArguments</key>',
		'	<array>',
		...options.programArguments.map(
			(argument) => `		<string>${escapeXml(argument)}</string>`,
		),
		'	</array>',
		'	<key>RunAtLoad</key>',
		'	<false/>',
		'	<key>KeepAlive</key>',
		'	<dict>',
		'		<key>SuccessfulExit</key>',
		'		<false/>',
		'	</dict>',
		'	<key>StandardOutPath</key>',
		`	<string>${escapeXml(options.logPath)}</string>`,
		'	<key>StandardErrorPath</key>',
		`	<string>${escapeXml(options.logPath)}</string>`,
		'</dict>',
		'</plist>',
		'',
	].join('\n');

const runLaunchctl = (args: ReadonlyArray<string>) =>
	Effect.tryPromise({
		try: () =>
			new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
				execFile(
					'launchctl',
					args,
					{ timeout: LAUNCHCTL_TIMEOUT_MS },
					(error, _stdout, stderr) => {
						if (error === null) {
							resolve({ exitCode: 0, stderr });
							return;
						}
						if ('code' in error && typeof error.code === 'number') {
							resolve({ exitCode: error.code, stderr });
							return;
						}
						reject(error);
					},
				);
			}),
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not run launchctl ${args.join(' ')}`,
				cause,
			}),
	});

const guiDomain = Effect.suspend(() => {
	const uid = process.getuid?.();
	if (uid === undefined)
		return new DaemonBootstrapError({
			message: 'Could not determine the user id for the launchd gui domain',
		});
	return Effect.succeed(`gui/${uid}`);
});

const launchctlSucceeds = (args: ReadonlyArray<string>) =>
	runLaunchctl(args).pipe(
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.void
				: new DaemonBootstrapError({
						message: `launchctl ${args.join(' ')} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
					}),
		),
	);

/** The only code that talks to launchd, so tests substitute a fake instead of touching the real gui domain. */
export class Launchctl extends Context.Service<Launchctl>()(
	'devsess/cli/Launchctl',
	{
		make: Effect.sync(() => ({
			isLoaded: (label: string) =>
				guiDomain.pipe(
					Effect.flatMap((domain) =>
						runLaunchctl(['print', `${domain}/${label}`]),
					),
					Effect.flatMap((result) => {
						if (result.exitCode === 0) return Effect.succeed(true);
						if (result.exitCode === LAUNCHCTL_SERVICE_NOT_FOUND)
							return Effect.succeed(false);
						return new DaemonBootstrapError({
							message: `launchctl print ${label} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
						});
					}),
				),
			bootstrap: (plistPath: string) =>
				guiDomain.pipe(
					Effect.flatMap((domain) =>
						launchctlSucceeds(['bootstrap', domain, plistPath]),
					),
				),
			bootout: (label: string) =>
				guiDomain.pipe(
					Effect.flatMap((domain) =>
						launchctlSucceeds(['bootout', `${domain}/${label}`]),
					),
				),
			/** Without `-k`: a daemon that is already running is never restarted. */
			kickstart: (label: string) =>
				guiDomain.pipe(
					Effect.flatMap((domain) =>
						launchctlSucceeds(['kickstart', `${domain}/${label}`]),
					),
				),
		})),
	},
) {
	static readonly layer = Layer.effect(Launchctl, Launchctl.make);
}

export type DaemonJob = {
	plistPath: string;
	programArguments: ReadonlyArray<string>;
	logsDirectory: string;
};

const desiredPlist = (job: DaemonJob) =>
	renderDaemonPlist({
		label: DAEMON_LAUNCHD_LABEL,
		programArguments: job.programArguments,
		logPath: daemonLogPath(job.logsDirectory),
	});

const readPlist = (plistPath: string) =>
	Effect.try({
		try: () => {
			try {
				return readFileSync(plistPath, 'utf8');
			} catch (cause) {
				if (
					cause instanceof Error &&
					'code' in cause &&
					cause.code === 'ENOENT'
				)
					return undefined;
				throw cause;
			}
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not read launchd plist at ${plistPath}`,
				cause,
			}),
	});

const writePlist = (job: DaemonJob, content: string) =>
	Effect.try({
		try: () => {
			mkdirSync(job.logsDirectory, { recursive: true, mode: 0o700 });
			mkdirSync(dirname(job.plistPath), { recursive: true });
			const staging = `${job.plistPath}.${process.pid}.tmp`;
			writeFileSync(staging, content, { mode: 0o644 });
			renameSync(staging, job.plistPath);
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not write launchd plist at ${job.plistPath}`,
				cause,
			}),
	});

export type DaemonJobState = {
	loaded: boolean;
	plist: 'current' | 'outdated' | 'missing';
};

/** "Current" means the plist is byte-identical to what this CLI would write, which covers the executable, script, daemon flags, and log path at once. */
export const inspectDaemonJob = (job: DaemonJob) =>
	Effect.gen(function* () {
		const launchctl = yield* Launchctl;
		const existing = yield* readPlist(job.plistPath);
		const loaded = yield* launchctl.isLoaded(DAEMON_LAUNCHD_LABEL);
		const plist: DaemonJobState['plist'] =
			existing === undefined
				? 'missing'
				: existing === desiredPlist(job)
					? 'current'
					: 'outdated';
		return { loaded, plist } satisfies DaemonJobState;
	});

/** `launchctl bootout` returns before the job is gone, and bootstrapping while it lingers fails. */
const awaitUnloaded = Effect.gen(function* () {
	const launchctl = yield* Launchctl;
	const deadline = Date.now() + UNLOAD_TIMEOUT_MS;
	while (yield* launchctl.isLoaded(DAEMON_LAUNCHD_LABEL)) {
		if (Date.now() >= deadline)
			return yield* new DaemonBootstrapError({
				message: `launchd job ${DAEMON_LAUNCHD_LABEL} was still loaded ${UNLOAD_TIMEOUT_MS}ms after bootout`,
			});
		yield* Effect.sleep(`${UNLOAD_POLL_INTERVAL_MS} millis`);
	}
});

/** Unloads the job so launchd stops supervising it; reports whether there was a job to unload. */
export const bootoutDaemonJob = Effect.gen(function* () {
	const launchctl = yield* Launchctl;
	if (!(yield* launchctl.isLoaded(DAEMON_LAUNCHD_LABEL))) return false;
	yield* launchctl.bootout(DAEMON_LAUNCHD_LABEL);
	yield* awaitUnloaded;
	return true;
});

/** Idempotent: writes the plist and loads the job only when either is missing or no longer matches. Reloading a stale job stops the daemon it supervises. */
export const installDaemonJob = (job: DaemonJob) =>
	Effect.gen(function* () {
		const launchctl = yield* Launchctl;
		const state = yield* inspectDaemonJob(job);
		if (state.loaded && state.plist === 'current') return;
		if (state.loaded) yield* bootoutDaemonJob;
		if (state.plist !== 'current') yield* writePlist(job, desiredPlist(job));
		yield* launchctl.bootstrap(job.plistPath);
	});

export const removeDaemonJobPlist = (job: DaemonJob) =>
	Effect.try({
		try: () => rmSync(job.plistPath, { force: true }),
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not remove launchd plist at ${job.plistPath}`,
				cause,
			}),
	});

/** Starts the daemon under launchd, installing the job first. Whether it came up is for the caller's handshake to decide. */
export const launchDaemonJob = (job: DaemonJob) =>
	Effect.gen(function* () {
		const launchctl = yield* Launchctl;
		yield* installDaemonJob(job);
		yield* launchctl.kickstart(DAEMON_LAUNCHD_LABEL);
	});
