// Re-exported so consumers can declare CLI flags/arguments without a direct
// dependency on `effect/cli`, e.g. `cli.Flag.string('local')`.

export { Schema } from 'effect';
export * as cli from 'effect/cli';

export { SessionStateError } from '../dev/session-state';
export { defineDevCli } from './define-cli';
export { createDevSessions, type DevSessionManager } from './dev-sessions';
export type { DevPlatform, DevServices } from './platform';
export type { DevSession } from './session';
export { SessionState } from './session-state';
