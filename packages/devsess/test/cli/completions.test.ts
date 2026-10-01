import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from '@effect/vitest';

const execute = promisify(execFile);

describe('CLI completions', () => {
	for (const shell of ['zsh', 'bash', 'fish']) {
		it(`prints ${shell} callback wiring and repeated aliases`, async () => {
			const result = await execute('bun', [
				'src/cli.ts',
				'completions',
				shell,
				'--alias',
				'dev',
				'--alias',
				'dev-local',
			]);
			expect(result.stderr).toBe('');
			expect(result.stdout).toContain(`command devsess --completions ${shell}`);
			expect(result.stdout).toContain('command devsess list --names');
			expect(result.stdout).toContain('2>/dev/null');
			expect(result.stdout).toContain('--project');
			expect(result.stdout).toContain('--config');
			if (shell === 'fish') {
				expect(result.stdout).toContain('complete -c dev -w devsess');
				expect(result.stdout).toContain('complete -c dev-local -w devsess');
			} else {
				expect(result.stdout).toContain('devsess dev dev-local');
				expect(result.stdout).toContain(
					shell === 'zsh' ? '_devsess_base "$@"' : '\n  _devsess\n',
				);
			}
		});

		it.skipIf(shell === 'fish' && spawnSync('fish', ['--version']).error)(
			`passes ${shell} syntax checking`,
			async () => {
				const result = await execute('bun', [
					'src/cli.ts',
					'completions',
					shell,
					'--alias',
					'dev',
				]);
				const checked = await execute(shell, ['-n', '-c', result.stdout]);
				expect(checked.stderr).toBe('');
			},
		);
	}

	for (const alias of [
		'bad;name',
		'$(touch nope)',
		'-dev',
		'two words',
		'a/b',
	]) {
		it(`rejects unsafe alias ${alias}`, async () => {
			const result = await execute('bun', [
				'src/cli.ts',
				'completions',
				'bash',
				`--alias=${alias}`,
			]).catch((error: unknown) => error);
			expect(result).toMatchObject({ code: 1, stdout: '' });
			if (!(result instanceof Error) || !('stderr' in result))
				throw new Error('Expected alias validation to fail');
			expect(result.stderr).toContain('Invalid completion alias');
		});
	}

	it('rejects unsupported shells', async () => {
		const result = await execute('bun', [
			'src/cli.ts',
			'completions',
			'powershell',
		]).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: 1 });
	});

	it('completes only the first start positional and forwards flag values in bash', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'devsess-completions-'));
		try {
			const result = await execute('bun', [
				'src/cli.ts',
				'completions',
				'bash',
				'--alias',
				'dev',
			]);
			const stub = join(directory, 'devsess');
			const callbackLog = join(directory, 'callback.log');
			await writeFile(
				stub,
				`#!/bin/sh
if [ "$1" = --completions ]; then
  printf '%s\n' '_devsess() { COMPREPLY=(STATIC); }'
else
  printf '%s\n' "$@" > "$CALLBACK_LOG"
  printf '%s\n' dev web
fi
`,
			);
			await chmod(stub, 0o755);
			const script = join(directory, 'completion.bash');
			await writeFile(script, result.stdout);
			const env = {
				...process.env,
				PATH: `${directory}:${process.env.PATH}`,
				CALLBACK_LOG: callbackLog,
			};
			for (const scenario of [
				{ words: "devsess start ''", index: 2, output: 'dev\nweb\n' },
				{
					words: "dev start --project x --config 'a b.json' --service web w",
					index: 8,
					output: 'web\n',
					callback: 'list\n--names\n--project\nx\n--config\na b.json\n',
				},
				{ words: "devsess start --project ''", index: 3, output: 'STATIC\n' },
				{ words: "devsess start dev ''", index: 3, output: 'STATIC\n' },
				{
					words: "devsess start --config=a.json ''",
					index: 3,
					output: 'dev\nweb\n',
				},
				{
					words: "devsess start --project = x ''",
					index: 5,
					output: 'dev\nweb\n',
				},
				{ words: 'devsess start --p', index: 2, output: 'STATIC\n' },
				...['stop', 'restart', 'tail', 'attach'].map((command) => ({
					words: `devsess ${command} ''`,
					index: 2,
					output: 'STATIC\n',
				})),
			]) {
				const completed = await execute(
					'bash',
					[
						'--noprofile',
						'--norc',
						'-c',
						`source "$1"
COMP_WORDS=(${scenario.words}); COMP_CWORD=${scenario.index}
_devsess_custom_completions
printf '%s\\n' "\${COMPREPLY[@]}"`,
						'bash',
						script,
					],
					{ env },
				);
				expect(completed.stdout).toBe(scenario.output);
				expect(completed.stderr).toBe('');
				if ('callback' in scenario)
					expect(await readFile(callbackLog, 'utf8')).toBe(scenario.callback);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
