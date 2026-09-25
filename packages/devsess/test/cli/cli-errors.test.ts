import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect } from 'effect';
import { vi } from 'vitest';
import { reportCliCause } from '../../src/cli/cli-errors';
import { DaemonClientError } from '../../src/cli/client';
import { CommandError } from '../../src/cli/commands/daemon';
import { ServiceExitError } from '../../src/cli/exit-status';

const execute = promisify(execFile);

describe('CLI errors', () => {
	it.effect(
		'renders tagged errors without a stack and unexpected defects with one',
		() =>
			Effect.gen(function* () {
				const write = vi
					.spyOn(process.stderr, 'write')
					.mockImplementation(() => true);
				yield* reportCliCause(
					Cause.fail(new CommandError({ message: 'First line\nSecond line' })),
				);
				expect(write).toHaveBeenCalledWith('error: First line\nSecond line\n');
				write.mockClear();
				yield* reportCliCause(
					Cause.fail(
						new DaemonClientError({
							message: 'Service engine: cannot verify group',
						}),
					),
				);
				expect(write).toHaveBeenCalledWith(
					'error: Service engine: cannot verify group\n',
				);
				write.mockClear();
				yield* reportCliCause(
					Cause.fail(new ServiceExitError({ exitCode: 143 })),
				);
				expect(write).not.toHaveBeenCalled();
				yield* reportCliCause(Cause.die(new Error('unexpected bug')));
				expect(write.mock.calls.join('')).toContain('unexpected bug');
				expect(write.mock.calls.join('')).toContain('at ');
				write.mockRestore();
			}),
	);

	for (const scenario of [
		{ args: ['docs', 'read', 'nope'], message: 'Unknown docs topic nope' },
		{
			args: ['list', '--config', '/devsess-nonexistent-config.json'],
			message: 'NotFound',
		},
	]) {
		it(`prints a clean error for ${scenario.args.join(' ')}`, async () => {
			const result = await execute('bun', ['src/cli.ts', ...scenario.args], {
				cwd: process.cwd(),
			}).catch((error: unknown) => error);
			expect(result).toMatchObject({ code: 1 });
			if (!(result instanceof Error) || !('stderr' in result))
				throw new Error('Expected a failed CLI process');
			expect(result.stderr).toContain(`error: ${scenario.message}`);
			expect(result.stderr).not.toContain(' at ');
			expect(result.stderr).not.toContain('ERROR (#');
		});
	}

	it('leaves CLI parse errors to the CLI renderer', async () => {
		const result = await execute(
			'bun',
			['src/cli.ts', 'tail', '--lines', '-1'],
			{
				cwd: process.cwd(),
			},
		).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: 1 });
		if (!(result instanceof Error) || !('stderr' in result))
			throw new Error('Expected a failed CLI process');
		expect(result.stderr).not.toContain('error: Help requested');
		expect(result.stderr).toContain('Missing value for flag --lines');
	});

	it('preserves service and cancellation exit codes without printing errors', async () => {
		for (const scenario of [
			{
				effect: 'Effect.fail(new ServiceExitError({ exitCode: 143 }))',
				code: 143,
			},
			{ effect: 'Effect.interrupt', code: 130 },
			{
				effect:
					"Effect.fail(new DaemonStatusError({ message: 'Daemon is not running' }))",
				code: 3,
				stderr: 'error: Daemon is not running\n',
			},
		]) {
			const script = `import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { ServiceExitError } from './src/cli/exit-status.ts'; import { DaemonStatusError } from './src/cli/commands/daemon-control.ts'; import { reportCliCause } from './src/cli/cli-errors.ts'; NodeRuntime.runMain(${scenario.effect}.pipe(Effect.tapCause(reportCliCause)), { disableErrorReporting: true });`;
			const result = await execute('bun', ['-e', script], {
				cwd: process.cwd(),
			}).catch((error: unknown) => error);
			expect(result).toMatchObject({
				code: scenario.code,
				stderr: 'stderr' in scenario ? scenario.stderr : '',
			});
		}
	});
});
