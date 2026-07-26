// Re-exported so consumers can declare CLI flags/arguments without a direct
// dependency on `effect/unstable/cli`, e.g. `cli.Flag.string('local')`.
export * as cli from 'effect/unstable/cli';

export { defineDevCli } from './dev/define-cli';
export { SessionState, SessionStateError } from './dev/session-state';
export {
	type DevSession,
	DevSessions,
	makeDevSessionsLayer,
} from './dev-sessions';
