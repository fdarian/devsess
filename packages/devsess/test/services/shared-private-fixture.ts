import { Effect, Schema } from 'effect';
import { Service } from '../../dist/services/index.js';

const privateService = Service.make({
	name: 'private',
	shared: { output: Schema.Struct({ pid: Schema.Number }) },
	start: () => Effect.succeed({ pid: process.pid }),
});

export const getPrivateService = () => privateService;
