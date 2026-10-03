import { Effect } from 'effect';
import { readDaemonIdentity, sendDaemonRequest } from './daemon-client';

export const reportDaemonService = (
	name: string,
	ports: Readonly<Record<string, number>>,
) =>
	Effect.gen(function* () {
		const identity = yield* readDaemonIdentity;
		if (identity === undefined) return;
		const params = {
			runId: identity.runId,
			service: identity.service,
			name,
			...(identity.instanceId === undefined
				? {}
				: { instanceId: identity.instanceId }),
		};
		const send = (method: string, values: Readonly<Record<string, unknown>>) =>
			sendDaemonRequest(
				identity,
				{ version: 1, requestId: crypto.randomUUID(), method, params: values },
				250,
			).pipe(Effect.catch(() => Effect.void));
		yield* Effect.acquireRelease(
			send('reportService', {
				...params,
				...(Object.keys(ports).length === 0 ? {} : { ports }),
			}),
			() => send('retractService', params),
		);
	}).pipe(Effect.catch(() => Effect.void));
