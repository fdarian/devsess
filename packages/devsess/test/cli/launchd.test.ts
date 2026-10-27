import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import { vi } from 'vitest';
import { daemonJob, ensureDaemon } from '../../src/cli/commands/daemon';
import {
	DAEMON_LAUNCHD_LABEL,
	inspectDaemonJob,
	installDaemonJob,
	launchDaemonJob,
	launchdApplies,
	launchdPlistPath,
	parseJobPid,
	removeDaemonJobPlist,
	renderDaemonPlist,
	usesLaunchd,
} from '../../src/cli/launchd';
import { makeFakeLaunchctl } from '../support/fake-launchctl';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const jobIn = (directory: string, nodePath = '/usr/local/bin/node') => ({
	plistPath: join(directory, 'LaunchAgents', `${DAEMON_LAUNCHD_LABEL}.plist`),
	programArguments: [nodePath, '/opt/devsess/cli.js', '__daemon'],
	logsDirectory: join(directory, 'logs'),
});

describe('launchd job', () => {
	it('renders a plist that relaunches only after an unclean exit', () => {
		const plist = renderDaemonPlist({
			label: 'dev.devsess.daemon',
			programArguments: ['/node', '/a&b/cli.js', '__daemon'],
			logPath: '/logs/daemon.log',
		});
		expect(plist).toContain('<key>Label</key>\n\t<string>dev.devsess.daemon');
		expect(plist).toContain('<string>/a&amp;b/cli.js</string>');
		expect(plist).toContain('<key>RunAtLoad</key>\n\t<false/>');
		expect(plist).toContain(
			'<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>',
		);
		expect(plist).toContain(
			'<key>StandardOutPath</key>\n\t<string>/logs/daemon.log</string>',
		);
		expect(plist).toContain(
			'<key>StandardErrorPath</key>\n\t<string>/logs/daemon.log</string>',
		);
	});

	it('lives in the user LaunchAgents directory', () => {
		expect(launchdPlistPath('/Users/me')).toBe(
			'/Users/me/Library/LaunchAgents/dev.devsess.daemon.plist',
		);
	});

	it('applies only on macOS without an explicit XDG location', () => {
		const none = { stateHome: false, runtimeDirectory: false };
		expect(launchdApplies('darwin', none)).toBe(true);
		expect(launchdApplies('linux', none)).toBe(false);
		expect(
			launchdApplies('darwin', { stateHome: true, runtimeDirectory: false }),
		).toBe(false);
		expect(
			launchdApplies('darwin', { stateHome: false, runtimeDirectory: true }),
		).toBe(false);
	});

	it.effect('opts out when either XDG variable is set', () =>
		Effect.gen(function* () {
			const environments: Array<Record<string, string>> = [
				{ XDG_STATE_HOME: '/tmp/s' },
				{ XDG_RUNTIME_DIR: '/tmp/r' },
			];
			for (const env of environments)
				expect(
					yield* usesLaunchd.pipe(
						Effect.provide(
							ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
						),
					),
				).toBe(false);
		}),
	);

	it.effect('installs a missing job once and then leaves it alone', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const job = jobIn(directory);
				const fake = makeFakeLaunchctl();
				yield* installDaemonJob(job).pipe(Effect.provide(fake.layer));
				expect(fake.calls).toEqual([
					`print ${DAEMON_LAUNCHD_LABEL}`,
					`bootstrap ${job.plistPath}`,
				]);
				expect(readFileSync(job.plistPath, 'utf8')).toBe(
					renderDaemonPlist({
						label: DAEMON_LAUNCHD_LABEL,
						programArguments: job.programArguments,
						logPath: join(job.logsDirectory, 'daemon.log'),
					}),
				);
				fake.calls.length = 0;
				yield* installDaemonJob(job).pipe(Effect.provide(fake.layer));
				expect(fake.calls.some((call) => call.startsWith('boot'))).toBe(false);
			}),
		),
	);

	it.effect(
		'bootstraps without rewriting when the plist is current but unloaded',
		() =>
			runTest(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const job = jobIn(directory);
					const seed = makeFakeLaunchctl();
					yield* installDaemonJob(job).pipe(Effect.provide(seed.layer));
					const fake = makeFakeLaunchctl({ loaded: false });
					yield* installDaemonJob(job).pipe(Effect.provide(fake.layer));
					expect(fake.calls.filter((call) => call.startsWith('boot'))).toEqual([
						`bootstrap ${job.plistPath}`,
					]);
				}),
			),
	);

	it.effect('reloads a loaded job whose executable changed', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const before = jobIn(directory, '/old/node');
				const after = jobIn(directory, '/new/node');
				const seed = makeFakeLaunchctl();
				yield* installDaemonJob(before).pipe(Effect.provide(seed.layer));
				const fake = makeFakeLaunchctl({ loaded: true });
				yield* installDaemonJob(after).pipe(Effect.provide(fake.layer));
				expect(fake.calls.filter((call) => call.startsWith('boot'))).toEqual([
					`bootout ${DAEMON_LAUNCHD_LABEL}`,
					`bootstrap ${after.plistPath}`,
				]);
				expect(readFileSync(after.plistPath, 'utf8')).toContain('/new/node');
				expect(
					yield* inspectDaemonJob(after).pipe(Effect.provide(fake.layer)),
				).toEqual({ loaded: true, plist: 'current' });
			}),
		),
	);

	it.effect('reports a missing, outdated, and current plist', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const job = jobIn(directory);
				const fake = makeFakeLaunchctl();
				const inspect = inspectDaemonJob(job).pipe(Effect.provide(fake.layer));
				expect((yield* inspect).plist).toBe('missing');
				mkdirSync(join(directory, 'LaunchAgents'), { recursive: true });
				writeFileSync(job.plistPath, 'stale');
				expect((yield* inspect).plist).toBe('outdated');
				yield* installDaemonJob(job).pipe(Effect.provide(fake.layer));
				expect(yield* inspect).toEqual({ loaded: true, plist: 'current' });
			}),
		),
	);

	it.effect('kickstarts only after the job is installed', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const job = jobIn(directory);
				const fake = makeFakeLaunchctl();
				yield* launchDaemonJob(job).pipe(Effect.provide(fake.layer));
				const actions = fake.calls.filter((call) => !call.startsWith('print'));
				expect(actions).toEqual([
					`bootstrap ${job.plistPath}`,
					`kickstart ${DAEMON_LAUNCHD_LABEL}`,
				]);
			}),
		),
	);

	it.effect('kickstarts with -k when the job still runs a process', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const job = jobIn(directory);
				yield* installDaemonJob(job).pipe(
					Effect.provide(makeFakeLaunchctl().layer),
				);
				const fake = makeFakeLaunchctl({ loaded: true, runningPid: 4242 });
				yield* launchDaemonJob(job).pipe(Effect.provide(fake.layer));
				const actions = fake.calls.filter((call) => !call.startsWith('print'));
				expect(actions).toEqual([`kickstart -k ${DAEMON_LAUNCHD_LABEL}`]);
			}),
		),
	);

	it.effect('kickstarts without -k when the job is loaded but idle', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const job = jobIn(directory);
				yield* installDaemonJob(job).pipe(
					Effect.provide(makeFakeLaunchctl().layer),
				);
				const fake = makeFakeLaunchctl({ loaded: true });
				yield* launchDaemonJob(job).pipe(Effect.provide(fake.layer));
				expect(fake.calls).toContain(`kickstart ${DAEMON_LAUNCHD_LABEL}`);
				expect(fake.calls).not.toContain(
					`kickstart -k ${DAEMON_LAUNCHD_LABEL}`,
				);
			}),
		),
	);

	it.effect('reads the job pid from the top level of launchctl print', () =>
		Effect.sync(() => {
			const running =
				'gui/501/x = {\n\tstate = running\n\tpid = 627\n\tendpoints = {\n\t\tpid = 1\n\t}\n}\n';
			expect(parseJobPid(running)).toBe(627);
			expect(
				parseJobPid(
					'gui/501/x = {\n\tstate = not running\n\tendpoints = {\n\t\tpid = 1\n\t}\n}\n',
				),
			).toBeUndefined();
		}),
	);

	it.effect('removes the plist', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const job = jobIn(directory);
				yield* installDaemonJob(job).pipe(
					Effect.provide(makeFakeLaunchctl().layer),
				);
				yield* removeDaemonJobPlist(job);
				expect(existsSync(job.plistPath)).toBe(false);
				yield* removeDaemonJobPlist(job);
			}),
		),
	);
});

describe('ensureDaemon', () => {
	const respond = (socket: import('node:net').Socket) =>
		socket.once('data', (data) => {
			const request = JSON.parse(data.toString()) as { requestId: string };
			socket.end(
				`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: {} })}\n`,
			);
		});

	it.live.skipIf(process.platform !== 'darwin')(
		'installs the job and kickstarts it instead of spawning when launchd applies',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const home = join(directory, 'home');
						mkdirSync(home);
						vi.stubEnv('HOME', home);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => vi.unstubAllEnvs()),
						);
						const location = {
							dataDirectory: join(directory, 'state'),
							logsDirectory: join(directory, 'logs'),
							socketPath: join(directory, 'daemon.sock'),
						};
						const server = createServer(respond);
						yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
						const fake = makeFakeLaunchctl({
							onKickstart: () => server.listen(location.socketPath),
						});
						yield* ensureDaemon(location).pipe(
							Effect.provide(fake.layer),
							Effect.provide(
								ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
							),
						);
						const plistPath = join(
							home,
							'Library',
							'LaunchAgents',
							`${DAEMON_LAUNCHD_LABEL}.plist`,
						);
						expect(daemonJob(location).plistPath).toBe(plistPath);
						expect(readFileSync(plistPath, 'utf8')).toContain(
							location.socketPath,
						);
						expect(
							fake.calls.filter((call) => !call.startsWith('print')),
						).toEqual([
							`bootstrap ${plistPath}`,
							`kickstart ${DAEMON_LAUNCHD_LABEL}`,
						]);
					}),
				),
			),
	);

	it.live('refuses to launch when running inside a daemon process', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const fake = makeFakeLaunchctl();
				const exit = yield* ensureDaemon({
					dataDirectory: join(directory, 'state'),
					logsDirectory: join(directory, 'logs'),
					socketPath: join(directory, 'daemon.sock'),
				}).pipe(
					Effect.provide(fake.layer),
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnv({
								env: { XDG_STATE_HOME: directory, DEVSESS_DAEMON_LAUNCH: '1' },
							}),
						),
					),
					Effect.exit,
				);
				expect(exit._tag).toBe('Failure');
				expect(fake.calls).toEqual([]);
				expect(existsSync(join(directory, 'logs', 'daemon.log'))).toBe(false);
			}),
		),
	);

	it.live('never touches launchd when an XDG location is explicit', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					const server = createServer(respond);
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) =>
								server.listen(socketPath, resolve),
							),
					);
					yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
					const fake = makeFakeLaunchctl();
					yield* ensureDaemon({
						dataDirectory: join(directory, 'state'),
						logsDirectory: join(directory, 'logs'),
						socketPath,
					}).pipe(
						Effect.provide(fake.layer),
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnv({ env: { XDG_STATE_HOME: directory } }),
							),
						),
					);
					expect(fake.calls).toEqual([]);
				}),
			),
		),
	);
});
