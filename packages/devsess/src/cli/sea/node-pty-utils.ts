import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import devsessPackageJson from '../../../package.json' with { type: 'json' };
import { getSeaAssetBytes } from '../sea';

/**
 * Stands in for node-pty's `lib/utils.js` inside the SEA binary (see `tsdown.exe.config.ts`):
 * the real one resolves `pty.node` relative to its own file, which does not exist in a single
 * executable. The native files are bundled as SEA assets and extracted to a cache directory instead.
 */

const PTY_ASSET = 'node-pty/pty.node';
const SPAWN_HELPER_ASSET = 'node-pty/spawn-helper';

export const assign = Object.assign;

const cacheRoot = () => {
	if (process.platform === 'darwin') return join(homedir(), 'Library/Caches');
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	return xdgCacheHome === undefined || xdgCacheHome === ''
		? join(homedir(), '.cache')
		: xdgCacheHome;
};

const extract = (
	dir: string,
	fileName: string,
	bytes: Uint8Array,
	mode: number,
) => {
	const target = join(dir, fileName);
	if (existsSync(target)) return;
	// Concurrent starts race on the same dir: a rename is atomic, a partial write is not.
	const temp = join(dir, `.${fileName}.${process.pid}.tmp`);
	try {
		writeFileSync(temp, bytes, { mode });
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
};

let extracted: string | undefined;

const extractNativeFiles = () => {
	if (extracted !== undefined) return extracted;
	const pty = getSeaAssetBytes(PTY_ASSET);
	const digest = createHash('sha256').update(pty).digest('hex').slice(0, 12);
	const dir = join(
		cacheRoot(),
		'devsess',
		`${devsessPackageJson.version}-${digest}`,
	);
	mkdirSync(dir, { recursive: true });
	extract(dir, 'pty.node', pty, 0o644);
	if (process.platform === 'darwin')
		extract(dir, 'spawn-helper', getSeaAssetBytes(SPAWN_HELPER_ASSET), 0o755);
	extracted = dir;
	return dir;
};

export const loadNativeModule = (name: string) => {
	if (name !== 'pty')
		throw new Error(
			`Native module ${name} is not bundled in the devsess binary`,
		);
	const dir = extractNativeFiles();
	// The SEA's own `require` only loads built-ins; one created from a real path loads from disk.
	const diskRequire = createRequire(process.execPath);
	return { dir, module: diskRequire(join(dir, `${name}.node`)) as unknown };
};
