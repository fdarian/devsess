import { Deferred, Effect, Fiber, Queue, Schema } from 'effect';
import type { Scope } from 'effect/Scope';
import { callDaemon } from './client';
import type { DaemonLocation } from './commands/daemon';
import type { DaemonRequest } from './protocol';
import type { RunRecord } from './registry';
import type { DaemonStream, DaemonStreamFrame } from './terminal';

const AttachLease = Schema.Struct({ leaseId: Schema.NonEmptyString });
const decodeAttachLease = Schema.decodeUnknownEffect(AttachLease);
const attachHint =
	'\r\n[devsess] Press Ctrl-] to detach. Press Ctrl-] twice to send a literal Ctrl-]. Ctrl-C is sent to the service.\r\n';

export type AttachAction =
	| { readonly _tag: 'input'; readonly data: string }
	| { readonly _tag: 'resize'; readonly cols: number; readonly rows: number }
	| { readonly _tag: 'detach' };

export type AttachInputState = { readonly awaitingEscape: boolean };

export const parseAttachInput = (
	state: AttachInputState,
	data: Buffer,
): {
	readonly state: AttachInputState;
	readonly actions: ReadonlyArray<AttachAction>;
} => {
	const input = data.toString();
	const actions: Array<AttachAction> = [];
	let pending = '';
	let index = state.awaitingEscape ? 1 : 0;
	if (
		!state.awaitingEscape &&
		input.length > 1 &&
		input.includes('\u001d') &&
		input !== '\u001d\u001d'
	)
		return {
			state: { awaitingEscape: false },
			actions: [{ _tag: 'input', data: input }],
		};
	if (state.awaitingEscape) {
		if (input[0] !== '\u001d')
			return {
				state: { awaitingEscape: false },
				actions: [{ _tag: 'detach' }],
			};
		pending = '\u001d';
	}
	while (index < input.length) {
		if (input[index] !== '\u001d') {
			pending += input[index];
			index += 1;
			continue;
		}
		if (input[index + 1] === '\u001d') {
			pending += '\u001d';
			index += 2;
			continue;
		}
		if (pending.length > 0) actions.push({ _tag: 'input', data: pending });
		if (index + 1 === input.length)
			return { state: { awaitingEscape: true }, actions };
		actions.push({ _tag: 'detach' });
		return { state: { awaitingEscape: false }, actions };
	}
	if (pending.length > 0) actions.push({ _tag: 'input', data: pending });
	return { state: { awaitingEscape: false }, actions };
};

const terminalSize = <E>(error: (message: string) => E) => {
	const cols = process.stdout.columns;
	const rows = process.stdout.rows;
	if (
		typeof cols !== 'number' ||
		typeof rows !== 'number' ||
		cols < 1 ||
		rows < 1
	)
		return Effect.fail(error('Attach requires a terminal with a known size'));
	return Effect.succeed({ cols, rows });
};

const render = <E>(frame: DaemonStreamFrame, error: (message: string) => E) => {
	if (frame._tag === 'output') {
		const event = frame.value;
		if (event.event === 'exit')
			return Effect.fail(error(`Service exited with code ${event.exitCode}`));
		return Effect.sync(() => process.stdout.write(event.data));
	}
	if (frame._tag === 'closed')
		return Effect.fail(error('Daemon output stream closed'));
	if (frame._tag === 'error') return Effect.fail(error(frame.error.message));
	if (frame.value.ok) return Effect.void;
	if (frame.value.error === undefined)
		return Effect.fail(
			error('Daemon rejected attach request without an error'),
		);
	return Effect.fail(error(frame.value.error));
};

export const awaitAttachLease = <E>(
	stream: DaemonStream,
	error: (message: string) => E,
): Effect.Effect<string, E> =>
	Effect.suspend(() =>
		Queue.take(stream.frames).pipe(
			Effect.flatMap((frame) => {
				if (frame._tag === 'output')
					return render(frame, error).pipe(
						Effect.andThen(awaitAttachLease(stream, error)),
					);
				if (frame._tag === 'closed')
					return Effect.fail(error('Daemon output stream closed'));
				if (frame._tag === 'error')
					return Effect.fail(error(frame.error.message));
				if (!frame.value.ok) {
					if (frame.value.error === undefined)
						return Effect.fail(
							error('Daemon rejected attach request without an error'),
						);
					return Effect.fail(error(frame.value.error));
				}
				return decodeAttachLease(frame.value.result).pipe(
					Effect.map((lease) => lease.leaseId),
					Effect.mapError(() =>
						error('Daemon returned an invalid attach lease'),
					),
				);
			}),
		),
	);

const requestFor = (
	action: AttachAction,
	options: {
		run: RunRecord;
		service: RunRecord['services'][number];
		leaseId: string;
		requestId: () => string;
	},
): DaemonRequest => {
	const params = {
		runId: options.run.runId,
		serviceName: options.service.name,
		leaseId: options.leaseId,
	};
	if (action._tag === 'input')
		return {
			version: 1,
			requestId: options.requestId(),
			method: 'input',
			params: { ...params, data: action.data },
		};
	if (action._tag === 'resize')
		return {
			version: 1,
			requestId: options.requestId(),
			method: 'resize',
			params: { ...params, cols: action.cols, rows: action.rows },
		};
	return {
		version: 1,
		requestId: options.requestId(),
		method: 'detach',
		params,
	};
};

/** Runs an attach lease until Ctrl-] is sent; Ctrl-] twice forwards a literal Ctrl-]. */
export const attachSession = <E>(options: {
	readonly location: DaemonLocation;
	readonly run: RunRecord;
	readonly service: RunRecord['services'][number];
	readonly stream: DaemonStream;
	readonly requestId: () => string;
	readonly error: (message: string) => E;
}): Effect.Effect<void, E, Scope> =>
	Effect.gen(function* () {
		if (!process.stdin.isTTY || !process.stdout.isTTY)
			return yield* Effect.fail(
				options.error('Attach requires an interactive terminal'),
			);
		const leaseId = yield* awaitAttachLease(options.stream, options.error);
		yield* Effect.sync(() => process.stdout.write(attachHint));
		const actions = yield* Queue.unbounded<AttachAction>();
		const detached = yield* Deferred.make<void, E>();
		const send = (action: AttachAction) =>
			callDaemon(
				options.location.socketPath,
				requestFor(action, {
					run: options.run,
					service: options.service,
					leaseId,
					requestId: options.requestId,
				}),
			).pipe(
				Effect.asVoid,
				Effect.mapError((cause) => options.error(cause.message)),
			);
		const reader = yield* Effect.forever(
			Queue.take(options.stream.frames).pipe(
				Effect.flatMap((frame) => render(frame, options.error)),
			),
		).pipe(Effect.forkScoped);
		const writer = yield* Effect.forever(
			Queue.take(actions).pipe(
				Effect.flatMap((action) =>
					send(action).pipe(
						Effect.tap(() =>
							action._tag === 'detach'
								? Deferred.succeed(detached, undefined)
								: Effect.void,
						),
					),
				),
			),
		).pipe(Effect.forkScoped);
		const initialSize = yield* terminalSize(options.error);
		yield* send({
			_tag: 'resize',
			cols: initialSize.cols,
			rows: initialSize.rows,
		});
		const rawMode = process.stdin.isRaw === true;
		const wasFlowing = process.stdin.readableFlowing;
		let inputState: AttachInputState = { awaitingEscape: false };
		let detachTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleDetach = () => {
			detachTimer = setTimeout(() => {
				detachTimer = undefined;
				Queue.offerUnsafe(actions, { _tag: 'detach' });
			}, 250);
		};
		const onInput = (data: Buffer) => {
			if (detachTimer !== undefined) clearTimeout(detachTimer);
			detachTimer = undefined;
			const parsed = parseAttachInput(inputState, data);
			inputState = parsed.state;
			for (const action of parsed.actions) Queue.offerUnsafe(actions, action);
			if (inputState.awaitingEscape) scheduleDetach();
		};
		const onResize = () => {
			const cols = process.stdout.columns;
			const rows = process.stdout.rows;
			if (
				typeof cols === 'number' &&
				typeof rows === 'number' &&
				cols > 0 &&
				rows > 0
			)
				Queue.offerUnsafe(actions, { _tag: 'resize', cols, rows });
		};
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.on('data', onInput);
				process.stdout.on('resize', onResize);
			}),
			() =>
				Effect.sync(() => {
					process.stdout.off('resize', onResize);
					process.stdin.off('data', onInput);
					process.stdin.setRawMode(rawMode);
					if (detachTimer !== undefined) clearTimeout(detachTimer);
					if (wasFlowing !== true) process.stdin.pause();
				}),
		).pipe(
			Effect.andThen(
				Effect.raceAllFirst([
					Deferred.await(detached),
					Fiber.join(reader),
					Fiber.join(writer),
				]),
			),
		);
	});
