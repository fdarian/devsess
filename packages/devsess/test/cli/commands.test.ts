import { describe, expect, it } from '@effect/vitest';
import { daemonLocation } from '../../src/cli/commands';
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
	it('uses a stable per-project daemon endpoint', () => {
		expect(daemonLocation('/tmp/project')).toEqual(
			daemonLocation('/tmp/project'),
		);
		expect(daemonLocation('/tmp/project').socketPath).not.toBe(
			daemonLocation('/tmp/other').socketPath,
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
});
