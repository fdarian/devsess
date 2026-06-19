import { defineConfig } from 'vocs/config';

export default defineConfig({
	title: 'devsess',
	description:
		'Effect-based dev sessions, sticky ports, managed subprocesses, and per-session PGlite databases for your local dev scripts.',
	sidebar: [
		{
			text: 'Getting Started',
			link: '/getting-started',
		},
		{
			text: 'Dev Sessions',
			link: '/dev-sessions',
		},
		{
			text: 'PGlite Adapter',
			link: '/pglite',
		},
		{
			text: 'API Reference',
			link: '/api',
		},
	],
});
