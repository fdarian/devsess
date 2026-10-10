export const TERMINATION_POLL_INTERVAL_MS = 25;
export const TERMINATION_PHASE_TIMEOUT_MS = 5_000;
export const STOP_REQUEST_MARGIN_MS = 1_000;
export const STOP_REQUEST_TIMEOUT_MS =
	TERMINATION_PHASE_TIMEOUT_MS * 2 + STOP_REQUEST_MARGIN_MS;
export const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000;

/** Overall bound on stopping a run, so one stuck service cannot hold the daemon's request queue. What outlives it is SIGKILLed. */
export const RUN_STOP_DEADLINE_MS = TERMINATION_PHASE_TIMEOUT_MS * 2;
/** How long to wait for a process group to disappear after the deadline's SIGKILL. */
export const FORCE_KILL_SETTLE_TIMEOUT_MS = 1_000;
/** A log append that has not finished by then is abandoned so it cannot block settling a service. */
export const OUTPUT_IDLE_TIMEOUT_MS = TERMINATION_PHASE_TIMEOUT_MS;

export const PROCESS_INSPECTION_TIMEOUT_MS = 500;
export const GROUP_LIVENESS_BACKOFF_INITIAL_MS = 25;
export const GROUP_LIVENESS_BACKOFF_MAX_MS = 250;

export const TERMINATION_TERM_SIGNAL = 15;
export const TERMINATION_KILL_SIGNAL = 9;
