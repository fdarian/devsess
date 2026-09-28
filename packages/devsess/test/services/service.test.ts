import { describe, expect, it } from '@effect/vitest';
import { buildRunArgs, Service, selectOrphans } from '../../src/services';

describe('Docker service arguments', () => {
	it('builds loopback ports, bind mounts, user, labels, env and health flags', () => {
		const def = Service.make({
			name: 'postgres',
			image: 'postgres:17',
			ports: { sql: 5432 },
			volumes: { data: '/var/lib/postgresql/data' },
			env: { POSTGRES_PASSWORD: 'dev' },
			healthcheck: {
				test: ['CMD', 'pg_isready', '-U', 'postgres'],
				interval: '1 second',
				timeout: '2 seconds',
				retries: 30,
				startPeriod: '3 seconds',
			},
		});
		const args = buildRunArgs(def, {
			container: 'devsess-walrus-postgres',
			root: '/project',
			session: 'walrus',
			uid: 501,
			gid: 20,
			ports: { sql: 59000 },
			volumes: {
				data: '/project/.data/sessions/walrus/services/postgres/data',
			},
		});
		expect(args).toEqual([
			'run',
			'-d',
			'--name',
			'devsess-walrus-postgres',
			'--label',
			'devsess.session=walrus',
			'--label',
			'devsess.root=/project',
			'--user',
			'501:20',
			'-p',
			'127.0.0.1:59000:5432',
			'-v',
			'/project/.data/sessions/walrus/services/postgres/data:/var/lib/postgresql/data',
			'-e',
			'POSTGRES_PASSWORD=dev',
			'--health-cmd',
			"'pg_isready' '-U' 'postgres'",
			'--health-interval',
			'1000ms',
			'--health-timeout',
			'2000ms',
			'--health-retries',
			'30',
			'--health-start-period',
			'3000ms',
			'postgres:17',
		]);
	});

	it('selects only containers whose session directory is gone', () => {
		expect(
			selectOrphans(
				[
					{ id: 'one', session: 'walrus' },
					{ id: 'two', session: 'piano' },
				],
				new Set(['piano']),
			),
		).toEqual(['one']);
	});
});
