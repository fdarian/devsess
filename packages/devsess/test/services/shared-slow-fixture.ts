import { Effect, Schema } from 'effect';
import { Service } from '../../dist/services/index.js';

export const slow = Service.make({
	name: 'slow',
	shared: { output: Schema.Struct({ pid: Schema.Number }) },
	start: () => Effect.sleep('65 seconds').pipe(Effect.as({ pid: process.pid })),
});
