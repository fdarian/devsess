import { Effect } from 'effect';
import { callDaemon } from '../client';
import { resolvePreset, toServices } from '../preset-resolution';
import type { DaemonRequest } from '../protocol';
import type { CommandOptions } from './daemon';
import {
	decodeRunResponse,
	ensureDaemon,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

const clientEnvironment = () =>
	Object.fromEntries(
		Object.entries(process.env).flatMap((entry) => {
			const key = entry[0];
			const value = entry[1];
			return value === undefined || key === undefined ? [] : [[key, value]];
		}),
	);

/** Starts a selected preset after capturing the client environment at this boundary. */
export const start = (options: CommandOptions, interactive: boolean) =>
	Effect.gen(function* () {
		const resolved = yield* resolvePreset(options, interactive);
		const location = yield* resolveDaemonLocation;
		yield* ensureDaemon(location);
		const request: DaemonRequest = {
			version: 1,
			requestId: requestId(),
			method: 'startRun',
			params: {
				runId: requestId(),
				projectName: resolved.preset.projectName,
				presetName: resolved.preset.presetName,
				canonicalCwd: resolved.invocation.canonicalCwd,
				invocationCwd: resolved.invocation.invocationCwd,
				configSnapshot: {
					projectName: resolved.preset.projectName,
					presetName: resolved.preset.presetName,
					preset: resolved.preset.preset,
				},
				environment: clientEnvironment(),
				services: toServices(resolved.preset.preset, resolved.invocation),
			},
		};
		const run = yield* callDaemon(location.socketPath, request).pipe(
			Effect.flatMap(decodeRunResponse),
		);
		return yield* write(
			`Started ${resolved.preset.projectName}/${resolved.preset.presetName}: ${run.runId}`,
		);
	});
