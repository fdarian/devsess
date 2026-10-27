import { defineComponents } from 'blume';

export default defineComponents({
	layout: {
		TableOfContents: { component: './islands/Chapters.tsx', client: 'load' },
	},
});
