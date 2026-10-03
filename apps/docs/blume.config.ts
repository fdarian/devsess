import { readFile } from 'node:fs/promises';
import { defineConfig } from 'blume';
import { custom, filesystem } from 'blume/sources';
import devsessPackageJson from '../../packages/devsess/package.json' with {
	type: 'json',
};

export default defineConfig({
	title: 'devsess',
	description:
		'Isolated, managed dev servers — each worktree gets its own session, with its own port and its own database.',
	content: {
		sources: [
			filesystem({ root: 'src/pages' }),
			custom({
				name: 'changelog',
				staged: true,
				async load() {
					const changelog = await readFile(
						new URL('../../packages/devsess/CHANGELOG.md', import.meta.url),
						'utf8',
					);
					if (!changelog.startsWith('# devsess\n')) {
						throw new Error('Expected the devsess changelog package heading.');
					}
					const text = changelog.slice('# devsess\n'.length);
					return {
						entries: [
							{
								ref: 'changelog.md',
								data: { title: 'Changelog' },
								body: { format: 'md', text },
								raw: `---\ntitle: Changelog\n---\n${text}`,
							},
						],
						diagnostics: [],
					};
				},
			}),
		],
	},
	navigation: {
		actions: [{ label: `v${devsessPackageJson.version}`, href: '/changelog' }],
		sidebar: [
			{ label: 'Introduction', href: '/' },
			'/getting-started',
			'/writing-a-dev-cli',
			'/without-effect',
			{
				label: 'Recipes',
				items: [
					{ label: 'Ports that Survive Restarts', href: '/recipes/ports' },
					{ label: 'Running your Dev Server', href: '/recipes/dev-server' },
					{ label: 'A Database per Session', href: '/recipes/pglite' },
					{
						label: 'Wiring Services Together',
						href: '/recipes/wiring-services',
					},
				],
			},
			'/changelog',
			{
				label: 'Reference',
				items: ['/reference/devsess', '/reference/async', '/reference/pglite'],
			},
		],
	},
	footer: { socials: { github: 'https://github.com/fdarian/devsess' } },
	markdown: { externalLinks: true },
});
