import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ServiceState = 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'orphaned';
export type ServiceRecord = { name: string; command: string; cwd: string; pid: number; logPath: string; state: ServiceState };
export type RunRecord = { runId: string; projectName: string; presetName: string; invocationCwd: string; configSnapshot: unknown; startedAt: string; state: ServiceState; services: Array<ServiceRecord> };
export type Registry = {
	reserve: (run: RunRecord) => Promise<void>;
	update: (runId: string, update: (run: RunRecord) => RunRecord) => Promise<RunRecord>;
	list: () => Promise<Array<RunRecord>>;
	appendLog: (service: ServiceRecord, data: string) => Promise<number>;
	readLog: (service: ServiceRecord, after: number) => Promise<{ data: string; offset: number }>;
	markOrphans: () => Promise<Array<RunRecord>>;
};

const registryPath = (dataDirectory: string) => join(dataDirectory, 'running.json');
const readRecords = async (dataDirectory: string): Promise<Array<RunRecord>> => {
	try { return JSON.parse(await readFile(registryPath(dataDirectory), 'utf8')) as Array<RunRecord>; }
	catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause; }
};
const writeRecords = async (dataDirectory: string, runs: Array<RunRecord>) => {
	const target = registryPath(dataDirectory);
	const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await mkdir(dirname(target), { recursive: true });
	await writeFile(temporary, JSON.stringify(runs), { mode: 0o600 });
	await rename(temporary, target);
};

/** Every read-modify-write is serialized, and replacement is atomic. */
export const makeRegistry = (dataDirectory: string): Registry => {
	let tail: Promise<void> = Promise.resolve();
	const serialize = <A>(operation: () => Promise<A>) => {
		const result = tail.then(operation);
		tail = result.then(() => undefined, () => undefined);
		return result;
	};
	return {
		reserve: (run) => serialize(async () => { const runs = await readRecords(dataDirectory); if (runs.some((candidate) => candidate.runId === run.runId)) throw new Error(`Run ${run.runId} is already reserved`); runs.push(run); await writeRecords(dataDirectory, runs); }),
		update: (runId, update) => serialize(async () => { const runs = await readRecords(dataDirectory); const index = runs.findIndex((run) => run.runId === runId); if (index < 0) throw new Error(`Run ${runId} was not found`); const current = runs[index]; if (current === undefined) throw new Error(`Run ${runId} was not found`); const next = update(current); runs[index] = next; await writeRecords(dataDirectory, runs); return next; }),
		list: () => serialize(() => readRecords(dataDirectory)),
		appendLog: (service, data) => serialize(async () => { await mkdir(dirname(service.logPath), { recursive: true }); await appendFile(service.logPath, data); return (await readFile(service.logPath)).byteLength; }),
		readLog: (service, after) => serialize(async () => { try { const data = await readFile(service.logPath, 'utf8'); const bytes = Buffer.from(data); return { data: bytes.subarray(after).toString(), offset: bytes.byteLength }; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { data: '', offset: after }; throw cause; } }),
		markOrphans: () => serialize(async () => { const runs = await readRecords(dataDirectory); const orphaned = runs.map((run) => ({ ...run, state: 'orphaned' as const, services: run.services.map((service) => ({ ...service, state: service.state === 'running' || service.state === 'starting' || service.state === 'stopping' ? 'orphaned' as const : service.state })) })); await writeRecords(dataDirectory, orphaned); return orphaned; }),
	};
};
