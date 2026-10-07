import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Mirrors the process birth value the daemon records in its pidfile (see `processBirth` in src/cli/bootstrap.ts). */
export const processBirthOf = (pid: number) => {
	if (process.platform === 'linux') {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const fields = stat
			.slice(stat.lastIndexOf(')') + 2)
			.trim()
			.split(/\s+/);
		const startedAt = fields[19];
		if (startedAt === undefined) throw new Error('Missing process birth value');
		return `linux:${startedAt}`;
	}
	const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
		encoding: 'utf8',
	}).trim();
	if (startedAt.length === 0) throw new Error('Missing process birth value');
	return `ps:${startedAt}`;
};
