#!/usr/bin/env node

import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';

const program = Effect.sync(() => {
	process.stderr.write(
		'devsess CLI bootstrap is installed; command configuration arrives in the next phase.\n',
	);
});

NodeRuntime.runMain(program);
