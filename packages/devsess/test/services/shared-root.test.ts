import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { definitionModule } from '../../src/services/shared/callsite';
import { findSharedRoot } from '../../src/services/shared/root';

it('stops at the inner worktree .git file, not the outer checkout .git directory', async () => {
	const outer = await mkdtemp(join(tmpdir(), 'devsess-root-'));
	const inner = join(outer, '.claude/worktrees/inner');
	const project = join(inner, 'packages/app');
	try {
		await mkdir(join(outer, '.git'));
		await mkdir(project, { recursive: true });
		for (const dir of [outer, inner, project])
			await writeFile(join(dir, 'package.json'), '{}');
		await writeFile(join(inner, '.git'), 'gitdir: outer/.git/worktrees/inner');
		expect(
			await Effect.runPromise(
				findSharedRoot(project).pipe(Effect.provide(NodeServices.layer)),
			),
		).toBe(inner);
		await rm(join(inner, 'package.json'));
		expect(
			await Effect.runPromise(
				findSharedRoot(project).pipe(Effect.provide(NodeServices.layer)),
			),
		).toBe(project);
	} finally {
		await rm(outer, { recursive: true, force: true });
	}
});

it('falls back to the current project without a git boundary', async () => {
	const outer = await mkdtemp(join(tmpdir(), 'devsess-root-'));
	const project = join(outer, 'packages/app');
	try {
		await mkdir(project, { recursive: true });
		await writeFile(join(outer, 'package.json'), '{}');
		expect(
			await Effect.runPromise(
				findSharedRoot(project).pipe(Effect.provide(NodeServices.layer)),
			),
		).toBe(project);
	} finally {
		await rm(outer, { recursive: true, force: true });
	}
});

it.each([
	'Error\n    at make (/fixture/service.ts:10:2)',
	'Error\n    at make (file:///fixture/service.ts:10:2)',
	'Error\nmake@file:///fixture/service.ts:10:2',
	'Error\n    at /fixture/service.ts:10:2',
])('captures Node/Bun callsite format: %s', (stack) => {
	expect(definitionModule(stack)).toBe('file:///fixture/service.ts');
});
