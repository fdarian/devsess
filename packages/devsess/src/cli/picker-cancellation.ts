import { Effect } from 'effect';
import { Terminal } from 'effect/Terminal';

export const cancelPicker = () =>
	Terminal.pipe(
		Effect.flatMap((terminal) => terminal.display('\n')),
		Effect.andThen(Effect.interrupt),
	);
