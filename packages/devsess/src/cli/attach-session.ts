import { Deferred, Effect, Fiber, Queue, Schema } from 'effect';
import type { Scope } from 'effect/Scope';
import { callDaemon } from './client';
import type { DaemonLocation } from './commands';
import type { DaemonRequest } from './protocol';
import type { RunRecord } from './registry';
import type { DaemonStream, DaemonStreamFrame } from './terminal';

const AttachLease = Schema.Struct({ leaseId: Schema.NonEmptyString });
const decodeAttachLease = Schema.decodeUnknownEffect(AttachLease);

type AttachAction =
	| { readonly _tag: 'input'; readonly data: string }
	| { readonly _tag: 'resize'; readonly cols: number; readonly rows: number }
	| { readonly _tag: 'detach' };

const inputActions = (data: Buffer): ReadonlyArray<AttachAction> => {
	const input = data.toString();
	const actions: Array<AttachAction> = [];
	let pending = '';
	let index = 0;
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
		actions.push({ _tag: 'detach' });
		return actions;
	}
	if (pending.length > 0) actions.push({ _tag: 'input', data: pending });
	return actions;
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
	if (frame._tag === 'output')
		return Effect.sync(() => process.stdout.write(frame.value.data));
	if (frame._tag === 'closed')
		return Effect.fail(error('Daemon output stream closed'));
	if (frame.value.ok) return Effect.void;
	if (frame.value.error === undefined)
		return Effect.fail(
			error('Daemon rejected attach request without an error'),
		);
	return Effect.fail(error(frame.value.error));
};

const awaitLease = <E>(
	stream: DaemonStream,
	error: (message: string) => E,
): Effect.Effect<string, E> =>
	Effect.suspend(() =>
		Queue.take(stream.frames).pipe(
			Effect.flatMap((frame) => {
				if (frame._tag === 'output')
					return render(frame, error).pipe(
						Effect.andThen(awaitLease(stream, error)),
					);
				if (frame._tag === 'closed')
					return Effect.fail(error('Daemon output stream closed'));
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
		const leaseId = yield* awaitLease(options.stream, options.error);
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
		let detachTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleDetach = () => {
			detachTimer = setTimeout(() => {
				detachTimer = undefined;
				Queue.offerUnsafe(actions, { _tag: 'detach' });
			}, 25);
		};
		const onInput = (data: Buffer) => {
			const input = data.toString();
			if (detachTimer !== undefined) {
				clearTimeout(detachTimer);
				detachTimer = undefined;
				if (input.startsWith('\u001d')) {
					Queue.offerUnsafe(actions, { _tag: 'input', data: '\u001d' });
					const trailing = input.slice(1);
					if (trailing.length > 0) onInput(Buffer.from(trailing));
					return;
				}
				Queue.offerUnsafe(actions, { _tag: 'detach' });
				return;
			}
			if (input === '\u001d') return scheduleDetach();
			for (const action of inputActions(data))
				Queue.offerUnsafe(actions, action);
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
