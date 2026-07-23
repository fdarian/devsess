// Re-exported so consumers can declare CLI flags/arguments without a direct
// dependency on `effect/unstable/cli`, e.g. `cli.Flag.string('local')`.

export { Schema } from 'effect';
export * as cli from 'effect/unstable/cli';

export { defineDevCli } from './define-cli';
export { createDevSessions, type DevSessionManager } from './dev-sessions';
export type { DevSession } from './session';
export { SessionState } from './session-state';
