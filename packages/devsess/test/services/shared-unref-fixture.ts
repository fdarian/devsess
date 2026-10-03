import { appendFile } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import { Service } from '../../dist/services/index.js';

export const unref = Service.make({
	name: 'unref',
	shared: {
		module: import.meta.url,
		output: Schema.Struct({ pid: Schema.Number }),
	},
	start: (ctx) =>
		Effect.acquireRelease(
			Effect.sync(() => setInterval(() => {}, 1_000).unref()),
			(timer) =>
				Effect.promise(async () => {
					clearInterval(timer);
					await appendFile(`${ctx.dataDir}/events`, 'stopping\n');
					await new Promise<void>((resolve) =>
						setTimeout(resolve, 800).unref(),
					);
					await appendFile(`${ctx.dataDir}/events`, 'stop\n');
				}),
		).pipe(Effect.as({ pid: process.pid })),
});
