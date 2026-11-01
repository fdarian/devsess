import { defineComponents } from 'blume';

export default defineComponents({
	layout: {
		TableOfContents: {
			component: '@fdarian/blume-preset/chapters.tsx',
			client: 'load',
		},
	},
});
