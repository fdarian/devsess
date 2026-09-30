import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';

/** Stable folder names and SQL let repeated calls extend an already-applied fixture. */
export const writeMigrationsFixture = (dir: string, opts: { count: number }) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;
		yield* fs.makeDirectory(dir, { recursive: true });
		yield* Effect.forEach(
			Array.from({ length: opts.count }, (_, idx) => idx),
			(idx) =>
				Effect.gen(function* () {
					const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, idx))
						.toISOString()
						.replaceAll(/[-:T]/g, '')
						.slice(0, 14);
					const tag = `${String(idx).padStart(4, '0')}_migration`;
					const migrationDir = path.join(dir, `${timestamp}_${tag}`);
					yield* fs.makeDirectory(migrationDir, { recursive: true });
					yield* fs.writeFileString(
						path.join(migrationDir, 'migration.sql'),
						`CREATE TABLE IF NOT EXISTS "${tag}" (id serial primary key);\n`,
					);
				}),
		);
		return dir;
	}).pipe(Effect.provide(NodeServices.layer));
