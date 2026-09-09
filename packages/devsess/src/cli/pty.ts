import { Effect, Schema } from 'effect';
import * as pty from 'node-pty';

export class PtyError extends Schema.TaggedErrorClass<PtyError>()('PtyError', {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

type PtyOptions = {
	command: string;
	args: Array<string>;
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
};

export const createPty = (options: PtyOptions) =>
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
	});

export const spawnPty = (options: PtyOptions) =>
	Effect.acquireRelease(createPty(options), (terminal) =>
		terminatePty(terminal, options.command).pipe(
			Effect.catch((error) => Effect.logError(error.message)),
		),
	);

const signalGroup = (
	pid: number,
	signal: NodeJS.Signals | 0,
	command: string,
) =>
	Effect.tryPromise({
		try: () =>
			new Promise<boolean>((resolve, reject) => {
				try {
					process.kill(-pid, signal);
					resolve(true);
				} catch (cause) {
					if (
						cause instanceof Error &&
						'code' in cause &&
						cause.code === 'ESRCH'
					) {
						resolve(false);
						return;
					}
					reject(cause);
				}
			}),
		catch: (cause) =>
			new PtyError({ message: `Could not stop PTY ${command}`, cause }),
	});

const waitForExit = (
	pid: number,
	command: string,
	remaining: number,
): Effect.Effect<boolean, PtyError> =>
	signalGroup(pid, 0, command).pipe(
		Effect.flatMap((alive) => {
			if (!alive || remaining <= 0) return Effect.succeed(alive);
			return Effect.sleep('20 millis').pipe(
				Effect.andThen(waitForExit(pid, command, remaining - 1)),
			);
		}),
	);

export const terminatePty = (terminal: pty.IPty, command: string) =>
	signalGroup(terminal.pid, 'SIGTERM', command).pipe(
		Effect.flatMap((signalled) =>
			signalled
				? waitForExit(terminal.pid, command, 250).pipe(
						Effect.flatMap((alive) =>
							alive
								? signalGroup(terminal.pid, 'SIGKILL', command).pipe(
										Effect.asVoid,
									)
								: Effect.void,
						),
					)
				: Effect.void,
		),
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
