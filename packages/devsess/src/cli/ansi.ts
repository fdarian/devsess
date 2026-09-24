export const makeAnsiStripper = () => {
	let state: 'text' | 'start' | 'csi' | 'osc' | 'osc-end' = 'text';
	return (data: string) => {
		let output = '';
		for (const character of data) {
			if (state === 'text') {
				if (character === '\x1b') state = 'start';
				else output += character;
			} else if (state === 'start') {
				state = character === '[' ? 'csi' : character === ']' ? 'osc' : 'text';
			} else if (state === 'csi') {
				if (character >= '@' && character <= '~') state = 'text';
			} else if (state === 'osc') {
				if (character === '\x07') state = 'text';
				else if (character === '\x1b') state = 'osc-end';
			} else {
				state = character === '\\' || character === '\x07' ? 'text' : 'osc';
			}
		}
		return output;
	};
};
