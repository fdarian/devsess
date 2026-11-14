import { Effect, Layer } from 'effect';
import { Launchctl } from '../../src/cli/launchd';

/** Stands in for launchctl so no test ever reaches the real gui domain. */
export const makeFakeLaunchctl = (options?: {
	loaded?: boolean;
	/** The PID launchd reports for the running job; undefined means loaded but idle. */
	runningPid?: number;
	onBootout?: () => void;
	onKickstart?: () => void;
}) => {
	const calls: Array<string> = [];
	const state = {
		loaded: options?.loaded === true,
		runningPid: options?.runningPid,
	};
	const service = Launchctl.of({
		isLoaded: (label) =>
			Effect.sync(() => {
				calls.push(`print ${label}`);
				return state.loaded;
			}),
		bootstrap: (plistPath) =>
			Effect.sync(() => {
				calls.push(`bootstrap ${plistPath}`);
				state.loaded = true;
			}),
		bootout: (label) =>
			Effect.sync(() => {
				calls.push(`bootout ${label}`);
				state.loaded = false;
				state.runningPid = undefined;
				options?.onBootout?.();
			}),
		runningPid: (label) =>
			Effect.sync(() => {
				calls.push(`print ${label}`);
				return state.runningPid;
			}),
		kickstart: (label, kickOptions) =>
			Effect.sync(() => {
				calls.push(
					kickOptions?.kill === true
						? `kickstart -k ${label}`
						: `kickstart ${label}`,
				);
				options?.onKickstart?.();
			}),
	});
	return { calls, state, layer: Layer.succeed(Launchctl, service) };
};
