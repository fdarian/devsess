import { describe, expect, it } from 'vitest';
import { makeAnsiStripper } from '../../src/cli/ansi';

describe('ANSI stripping', () => {
	it('removes colors and cursor controls split across chunks', () => {
		const strip = makeAnsiStripper();
		expect(strip('before\x1b[3')).toBe('before');
		expect(strip('1mred\x1b[0m\x1b[2')).toBe('red');
		expect(strip('Jafter\n')).toBe('after\n');
	});

	it('removes OSC sequences terminated by BEL or ST', () => {
		const strip = makeAnsiStripper();
		expect(strip('a\x1b]0;title')).toBe('a');
		expect(strip('\x07b\x1b]8;;https://example.com\x1b')).toBe('b');
		expect(strip('\\c')).toBe('c');
	});
});
