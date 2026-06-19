// Re-exported so consumers can declare CLI options without a direct dependency
// on `@effect/cli`, e.g. `cli.Options.text('local')`.
export * as cli from '@effect/cli';

export { defineDevCli } from './dev/define-cli';
export { SessionState } from './dev/session-state';
export {
	type DevSession,
	DevSessions,
	makeDevSessionsLayer,
} from './dev-sessions';
