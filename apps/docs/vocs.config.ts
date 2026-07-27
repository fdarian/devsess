import { Changelog, defineConfig } from 'vocs/config';
import devsessPackageJson from '../../packages/devsess/package.json' with {
	type: 'json',
};

const devsessVersion = devsessPackageJson.version;

export default defineConfig({
	title: 'devsess',
	description:
		'Isolated, managed dev servers — each worktree gets its own session, with its own port and its own database.',
	changelog: Changelog.github({ repo: 'fdarian/devsess' }),
	topNav: [{ text: `v${devsessVersion}`, link: '/changelog' }],
	sidebar: [
		{
			text: 'Introduction',
			link: '/',
		},
		{
			text: 'Getting Started',
			link: '/getting-started',
		},
		{
			text: 'Writing a dev CLI',
			link: '/writing-a-dev-cli',
		},
		{
			text: 'Using without Effect',
			link: '/without-effect',
		},
		{
			text: 'Recipes',
			items: [
				{
					text: 'Ports that Survive Restarts',
					link: '/recipes/ports',
				},
				{
					text: 'Running your Dev Server',
					link: '/recipes/dev-server',
				},
				{
					text: 'A Database per Session',
					link: '/recipes/pglite',
				},
				{
					text: 'Wiring Services Together',
					link: '/recipes/wiring-services',
				},
			],
		},
		{
			text: 'Changelog',
			link: '/changelog',
		},
		{
			text: 'Reference',
			items: [
				{
					text: 'devsess',
					link: '/reference/devsess',
				},
				{
					text: 'devsess/async',
					link: '/reference/async',
				},
				{
					text: 'devsess/pglite',
					link: '/reference/pglite',
				},
			],
		},
	],
	socials: [{ icon: 'github', link: 'https://github.com/fdarian/devsess' }],
});
