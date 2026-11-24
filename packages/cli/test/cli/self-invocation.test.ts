import { describe, expect, it } from '@effect/vitest';
import { homebrewStablePath } from '../../src/cli/self-invocation';

describe('homebrewStablePath', () => {
	it('maps an arm64 Homebrew Cellar path to the opt symlink', () => {
		expect(
			homebrewStablePath('/opt/homebrew/Cellar/devsess/0.1.0/bin/devsess'),
		).toBe('/opt/homebrew/opt/devsess/bin/devsess');
	});

	it('maps an Intel Homebrew Cellar path to the opt symlink', () => {
		expect(
			homebrewStablePath('/usr/local/Cellar/devsess/0.2.3_1/bin/devsess'),
		).toBe('/usr/local/opt/devsess/bin/devsess');
	});

	it('leaves the opt path unchanged', () => {
		expect(homebrewStablePath('/opt/homebrew/opt/devsess/bin/devsess')).toBe(
			'/opt/homebrew/opt/devsess/bin/devsess',
		);
	});

	it('leaves a non-Homebrew path unchanged', () => {
		expect(homebrewStablePath('/Users/me/code/devsess/build/devsess')).toBe(
			'/Users/me/code/devsess/build/devsess',
		);
	});

	it('leaves another formula in the Cellar unchanged', () => {
		expect(
			homebrewStablePath('/opt/homebrew/Cellar/other/1.0.0/bin/devsess'),
		).toBe('/opt/homebrew/Cellar/other/1.0.0/bin/devsess');
	});

	it('leaves a different binary of the devsess formula unchanged', () => {
		expect(
			homebrewStablePath('/opt/homebrew/Cellar/devsess/0.1.0/bin/other'),
		).toBe('/opt/homebrew/Cellar/devsess/0.1.0/bin/other');
	});
});
