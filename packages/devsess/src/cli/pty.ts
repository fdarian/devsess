import { Data, Effect } from 'effect';
import * as pty from 'node-pty';

export class PtyError extends Data.TaggedError('PtyError')<{
	message: string;
	cause?: unknown;
}> {}

export const spawnPty = (options: {
	command: string;
	args: Array<string>;
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
}) =>
	Effect.acquireRelease(
		Effect.try({
			try: () =>
				pty.spawn(options.command, options.args, {
					cwd: options.cwd,
					env: options.env,
					name: 'xterm-256color',
					cols: options.cols,
					rows: options.rows,
				}),
			catch: (cause) =>
				new PtyError({
					message: `Could not start PTY ${options.command}`,
					cause,
				}),
		}),
		(terminal) =>
			Effect.try({
				try: () => process.kill(-terminal.pid, 'SIGTERM'),
				catch: (cause) =>
					new PtyError({
						message: `Could not stop PTY ${options.command}`,
						cause,
					}),
			}).pipe(Effect.catch(() => Effect.void)),
	);

export const writePty = (terminal: pty.IPty, input: string) =>
	Effect.try({
		try: () => terminal.write(input),
		catch: (cause) =>
			new PtyError({ message: 'Could not write PTY input', cause }),
	});

export const resizePty = (terminal: pty.IPty, cols: number, rows: number) =>
	Effect.try({
		try: () => terminal.resize(cols, rows),
		catch: (cause) => new PtyError({ message: 'Could not resize PTY', cause }),
	});
