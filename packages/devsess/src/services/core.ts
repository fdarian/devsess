import { Data } from 'effect';
import type { DevSession } from '../dev-sessions';

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
