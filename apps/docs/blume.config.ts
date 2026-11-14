import { readFile } from 'node:fs/promises';
import { withPreset } from '@fdarian/blume-preset';
import { defineConfig } from 'blume';
import { posthog } from 'blume/analytics';
import { custom, filesystem } from 'blume/sources';
import devsessPackageJson from '../../packages/devsess/package.json' with {
	type: 'json',
};

const ph = process.env.POSTHOG_KEY;

async function loadChangelog(options: {
	packageDir: string;
	packageName: string;
	ref: string;
}) {
	const changelog = await readFile(
		new URL(
			`../../packages/${options.packageDir}/CHANGELOG.md`,
			import.meta.url,
		),
		'utf8',
	);
	const heading = `# ${options.packageName}\n`;
	if (!changelog.startsWith(heading)) {
		throw new Error(
			`Expected the ${options.packageName} changelog package heading.`,
		);
	}
	const text = changelog.slice(heading.length);
	return {
		ref: options.ref,
		data: { title: options.packageName },
		body: { format: 'md' as const, text },
		raw: `---\ntitle: ${JSON.stringify(options.packageName)}\n---\n${text}`,
	};
}

export default defineConfig(
	withPreset({
		title: 'devsess',
		...(ph ? { analytics: [posthog({ key: ph })] } : {}),
		description:
			'Isolated, managed dev servers — each worktree gets its own session, with its own port and its own database.',
		content: {
			sources: [
				filesystem({ root: 'src/pages' }),
				custom({
					name: 'changelog',
					staged: true,
					async load() {
						return {
							entries: [
								await loadChangelog({
									packageDir: 'devsess',
									packageName: 'devsess',
									ref: 'changelog.md',
								}),
								await loadChangelog({
									packageDir: 'cli',
									packageName: '@devsess/cli',
									ref: 'changelog/cli.md',
								}),
							],
							diagnostics: [],
						};
					},
				}),
			],
		},
		navigation: {
			actions: [
				{ label: `v${devsessPackageJson.version}`, href: '/changelog' },
			],
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
							label: 'Postgres per Session with Docker',
							href: '/recipes/postgres-service',
						},
						{
							label: 'Wiring Services Together',
							href: '/recipes/wiring-services',
						},
					],
				},
				{
					label: 'Changelog',
					items: [
						{ label: 'devsess', href: '/changelog' },
						{ label: '@devsess/cli', href: '/changelog/cli' },
					],
				},
				{
					label: 'Reference',
					items: [
						{
							label: 'CLI',
							href: '/reference/cli',
							items: [
								'/reference/cli/configuration',
								'/reference/cli/running',
								'/reference/cli/selecting',
								'/reference/cli/logs',
								'/reference/cli/attach',
								'/reference/cli/completions',
								'/reference/cli/daemon',
								'/reference/cli/troubleshooting',
							],
						},
						'/reference/devsess',
						'/reference/async',
						'/reference/pglite',
						'/reference/services',
					],
				},
			],
		},
		footer: { socials: { github: 'https://github.com/fdarian/devsess' } },
	}),
);
