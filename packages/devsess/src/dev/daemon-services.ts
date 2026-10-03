import { Config, ConfigProvider, Effect, Option } from 'effect';
import { sendDaemonRequest } from './daemon-readiness';

export const reportDaemonService = (
	name: string,
	ports: Readonly<Record<string, number>>,
) =>
	Effect.gen(function* () {
		const provider = ConfigProvider.fromEnv();
		const socketPath = Option.getOrUndefined(
			yield* Config.String('DEVSESS_SOCKET')
				.pipe(Config.option)
				.parse(provider),
		);
		const runId = Option.getOrUndefined(
			yield* Config.String('DEVSESS_RUN_ID')
				.pipe(Config.option)
				.parse(provider),
		);
		const service = Option.getOrUndefined(
			yield* Config.String('DEVSESS_SERVICE')
				.pipe(Config.option)
				.parse(provider),
		);
		const instanceId = Option.getOrUndefined(
			yield* Config.String('DEVSESS_INSTANCE_ID')
				.pipe(Config.option)
				.parse(provider),
		);
		if (
			socketPath === undefined ||
			runId === undefined ||
			service === undefined
		)
			return;
		const identity = { socketPath, runId, service };
		const params = {
			runId,
			service,
			name,
			...(instanceId === undefined ? {} : { instanceId }),
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
