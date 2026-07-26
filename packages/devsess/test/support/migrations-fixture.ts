import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';

type JournalEntry = {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
};

/**
 * Writes a real Drizzle migrations folder — `meta/_journal.json` plus one `.sql` file
 * per journal entry — under `dir`, matching the shape `drizzle-orm`'s migrator reads
 * (see `readMigrationFiles` in `drizzle-orm/migrator`). Lets pglite tests exercise
 * migration counting/staleness against disk, with `count` controlling how many
 * migrations exist. Each migration is a standalone `create table` so it applies cleanly
 * regardless of how many others run before it. Self-contained (brings its own
 * `NodeServices`), so `dir` — typically from `makeTempDir` — is the only input needed.
 *
 * Calling this twice against the same `dir` to *extend* a fixture (e.g. `count: 1` then
 * `count: 2`) regenerates every entry's `when`, including ones already written by the
 * first call — it's not additive. Anyone diffing exact migration counts/timestamps
 * across two calls should account for that rather than assuming earlier entries are
 * untouched.
 */
export const writeMigrationsFixture = (dir: string, opts: { count: number }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;
		const metaDir = path.join(dir, 'meta');
		yield* fs.makeDirectory(metaDir, { recursive: true });

		const entries: Array<JournalEntry> = Array.from(
			{ length: opts.count },
			(_, idx) => ({
				idx,
				version: '7',
				when: Date.now() + idx,
				tag: `${String(idx).padStart(4, '0')}_migration`,
				breakpoints: true,
			}),
		);

		yield* fs.writeFileString(
			path.join(metaDir, '_journal.json'),
			JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
		);

		yield* Effect.forEach(entries, (entry) =>
			fs.writeFileString(
				path.join(dir, `${entry.tag}.sql`),
				`CREATE TABLE IF NOT EXISTS "${entry.tag}" (id serial primary key);\n`,
			),
		);

		return dir;
	}).pipe(Effect.provide(NodeServices.layer));
