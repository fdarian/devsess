import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from '@effect/vitest';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

describe('list --names', () => {
	for (const scenario of [
		{ projects: ['alpha'], args: [], output: 'dev\nweb\n' },
		{
			projects: ['alpha', 'beta'],
			args: [],
			output: 'alpha/dev\nalpha/web\nbeta/dev\nbeta/web\n',
		},
		{
			projects: ['alpha', 'beta'],
			args: ['--project', 'beta'],
			output: 'dev\nweb\n',
		},
	]) {
		it(`prints selectors for ${scenario.projects.join(', ')} ${scenario.args.join(' ')}`, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'devsess-names-'));
			try {
				const configPath = join(directory, 'config.json');
				await writeFile(
					configPath,
					JSON.stringify({
						projects: Object.fromEntries(
							scenario.projects.map((name) => [
								name,
								{
									matcher: { type: 'path', path: directory },
									presets: {
										web: { services: { web: { command: 'echo web' } } },
										dev: { services: { web: { command: 'echo dev' } } },
									},
								},
							]),
						),
					}),
				);
				const result = await execute(
					'bun',
					[
						cliPath,
						'list',
						'--names',
						'--config',
						configPath,
						...scenario.args,
					],
					{
						cwd: directory,
						env: {
							...process.env,
							XDG_STATE_HOME: join(directory, 'state'),
							XDG_RUNTIME_DIR: join(directory, 'runtime'),
						},
					},
				);
				expect(result.stdout).toBe(scenario.output);
				expect(result.stderr).toBe('');
				const entries = await readdir(directory, { recursive: true });
				expect(entries).not.toContain('state/devsess');
				expect(entries).not.toContain('runtime');
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}

	it('reports configuration errors instead of swallowing them', async () => {
		const result = await execute('bun', [
			cliPath,
			'list',
			'--names',
			'--config',
			'/devsess-nonexistent-config.json',
		]).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: 1, stdout: '' });
		if (!(result instanceof Error) || !('stderr' in result))
			throw new Error('Expected a failed CLI process');
		expect(result.stderr).toContain('error: NotFound');
	});
});
