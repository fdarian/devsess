import { Duration } from 'effect';

export type Healthcheck = {
	test: readonly string[];
	interval?: Duration.Input;
	timeout?: Duration.Input;
	retries?: number;
	startPeriod?: Duration.Input;
};

const dockerDuration = (input: Duration.Input) =>
	`${Duration.toMillis(input)}ms`;

const shellQuote = (part: string) => `'${part.replaceAll("'", "'\\''")}'`;

// `docker run --health-cmd` always goes through a shell, unlike compose's exec-form `CMD`.
const healthCmd = (test: readonly string[]) => {
	if (test[0] === 'CMD-SHELL') return test.slice(1).join(' ');
	if (test[0] === 'CMD') return test.slice(1).map(shellQuote).join(' ');
	return test.join(' ');
};

export const buildRunArgs = (input: {
	image: string;
	container: string;
	root: string;
	session: string;
	uid: number;
	gid: number;
	ports: ReadonlyArray<{ host: number; container: number }>;
	volumes: ReadonlyArray<{ source: string; target: string }>;
	env: Record<string, string>;
	healthcheck: Healthcheck | undefined;
}): string[] => {
	const args = [
		'run',
		'-d',
		'--name',
		input.container,
		'--label',
		`devsess.session=${input.session}`,
		'--label',
		`devsess.root=${input.root}`,
		'--user',
		`${input.uid}:${input.gid}`,
	];
	for (const port of input.ports)
		args.push('-p', `127.0.0.1:${port.host}:${port.container}`);
	for (const volume of input.volumes)
		args.push('-v', `${volume.source}:${volume.target}`);
	for (const entry of Object.entries(input.env))
		args.push('-e', `${entry[0]}=${entry[1]}`);
	const healthcheck = input.healthcheck;
	if (healthcheck) {
		args.push('--health-cmd', healthCmd(healthcheck.test));
		if (healthcheck.interval !== undefined)
			args.push('--health-interval', dockerDuration(healthcheck.interval));
		if (healthcheck.timeout !== undefined)
			args.push('--health-timeout', dockerDuration(healthcheck.timeout));
		if (healthcheck.retries !== undefined)
			args.push('--health-retries', String(healthcheck.retries));
		if (healthcheck.startPeriod !== undefined)
			args.push(
				'--health-start-period',
				dockerDuration(healthcheck.startPeriod),
			);
	}
	args.push(input.image);
	return args;
};

export const selectOrphans = (
	containers: ReadonlyArray<{ id: string; session: string }>,
	existingSessions: ReadonlySet<string>,
) =>
	containers
		.filter((container) => !existingSessions.has(container.session))
		.map((container) => container.id);
