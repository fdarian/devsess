import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	daemonLocation,
	decodeRunListResponse,
	decodeRunResponse,
} from '../../src/cli/commands';
import { qualifiedPresets, selectPreset } from '../../src/cli/selection';

const project = (projectName: string) => ({
	projectName,
	project: {
		matcher: { type: 'path' as const, path: `/tmp/${projectName}` },
		presets: {
			dev: { services: { web: { command: 'bun dev' } } },
		},
	},
});

describe('CLI command selection', () => {
	it('uses one stable user-scoped daemon endpoint', () => {
		expect(daemonLocation('/tmp/state', '/tmp/runtime')).toEqual(
			daemonLocation('/tmp/state', '/tmp/runtime'),
		);
		expect(daemonLocation('/tmp/state', '/tmp/runtime').socketPath).toBe(
			'/tmp/runtime/devsess.sock',
		);
	});

	it('keeps bare preset ambiguity qualified for non-interactive callers', () => {
		const candidates = qualifiedPresets([project('alpha'), project('beta')]);
		const selection = selectPreset(candidates);
		expect(selection._tag).toBe('AmbiguousPreset');
		if (selection._tag === 'AmbiguousPreset')
			expect(
				selection.candidates.map(
					(candidate) => `${candidate.projectName}/${candidate.presetName}`,
				),
			).toEqual(['alpha/dev', 'beta/dev']);
	});

	it.effect('rejects malformed daemon run responses', () =>
		Effect.gen(function* () {
			const run = yield* Effect.exit(decodeRunResponse({ runId: 'run' }));
			const list = yield* Effect.exit(decodeRunListResponse({}));
			expect(run._tag).toBe('Failure');
			expect(list._tag).toBe('Failure');
		}),
	);
});
