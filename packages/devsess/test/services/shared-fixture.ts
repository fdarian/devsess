import { appendFile } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import { Service } from '../../dist/services/index.js';

export const fixture = Service.make({
	name: 'fixture',
	ports: ['api'],
	shared: {
		output: Schema.Struct({ pid: Schema.Number }),
	},
	start: (ctx) =>
		Effect.acquireRelease(
			Effect.promise(async () => {
				await appendFile(`${ctx.dataDir}/events`, `start ${process.pid}\n`);
				return { pid: process.pid };
			}),
			() =>
				Effect.promise(async () => {
					await appendFile(`${ctx.dataDir}/events`, 'stopping\n');
					await new Promise((resolve) => setTimeout(resolve, 500));
					await appendFile(`${ctx.dataDir}/events`, 'stop\n');
				}),
		),
});
