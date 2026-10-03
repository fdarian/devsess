import { Effect, Exit, Schema } from 'effect';
import { readDaemonIdentity, sendDaemonRequest } from './daemon-client';

export const publishDaemonReadiness = (value: unknown) =>
	Effect.gen(function* () {
		const identity = yield* readDaemonIdentity;
		if (identity === undefined) return;
		const params = {
			runId: identity.runId,
			service: identity.service,
			...(identity.instanceId === undefined
				? {}
				: { instanceId: identity.instanceId }),
		};
		yield* Effect.acquireRelease(
			Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
				Effect.flatMap((json) =>
					sendDaemonRequest(identity, {
						version: 1,
						requestId: crypto.randomUUID(),
						method: 'publish',
						params: { ...params, value: json },
					}),
				),
				Effect.exit,
			),
			(result) =>
				Exit.isSuccess(result)
					? sendDaemonRequest(identity, {
							version: 1,
							requestId: crypto.randomUUID(),
							method: 'unpublish',
							params,
						}).pipe(Effect.catch(() => Effect.void))
					: Effect.void,
		);
	}).pipe(Effect.catch(() => Effect.void));
