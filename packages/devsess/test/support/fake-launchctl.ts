import { Effect, Layer } from 'effect';
import { Launchctl } from '../../src/cli/launchd';

/** Stands in for launchctl so no test ever reaches the real gui domain. */
export const makeFakeLaunchctl = (options?: {
	loaded?: boolean;
	onBootout?: () => void;
	onKickstart?: () => void;
}) => {
	const calls: Array<string> = [];
	const state = { loaded: options?.loaded === true };
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
				options?.onBootout?.();
			}),
		kickstart: (label) =>
			Effect.sync(() => {
				calls.push(`kickstart ${label}`);
				options?.onKickstart?.();
			}),
	});
	return { calls, state, layer: Layer.succeed(Launchctl, service) };
};
