import { Data, Effect } from 'effect';
import type { DevSession } from '../dev-sessions';
import type { RunningService } from './index';

export const serviceBrand = Symbol.for('devsess/ServiceDefinition');

export const withServiceError = (message: string) =>
	Effect.mapError((cause: unknown) =>
		cause instanceof ServiceError
			? cause
			: new ServiceError({ message, cause }),
	);

export const runningService = <Port extends string, A>(result: {
	value: A;
	ports: Readonly<Record<Port, number>>;
}) =>
	({
		...(typeof result.value === 'object' && result.value !== null
			? result.value
			: {}),
		ports: result.ports,
	}) as RunningService<Port, A>;

export class ServiceError extends Data.TaggedError('ServiceError')<{
	message: string;
	cause?: unknown;
}> {}

export type ServiceContext<Port extends string> = {
	readonly session: DevSession;
	readonly ports: Readonly<Record<Port, number>>;
	/** `<session>/services/<service>`, created before `start` runs and kept after it stops. */
	readonly dataDir: string;
};

export const validName = (name: string) =>
	/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
