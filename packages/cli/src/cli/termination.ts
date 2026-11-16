export const TERMINATION_POLL_INTERVAL_MS = 25;
export const TERMINATION_PHASE_TIMEOUT_MS = 5_000;
export const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000;

/** Overall bound on stopping a run, so one stuck service cannot hold the daemon's request queue. What outlives it is SIGKILLed. */
export const RUN_STOP_DEADLINE_MS = TERMINATION_PHASE_TIMEOUT_MS * 2;
/** Bounds `settleAfterDeadline` per service, so a stop always replies within `RUN_STOP_DEADLINE_MS` plus this even when `ps` is slow. */
export const RUN_STOP_SETTLE_TIMEOUT_MS = 5_000;
/** Covers the registry writes and prune that run before the stop reply. */
export const STOP_REQUEST_MARGIN_MS = 2_000;
/** The daemon's worst case for a stop; clients must wait at least this long (the menu bar's `stopTimeout` must stay above it). */
export const STOP_REQUEST_TIMEOUT_MS =
	RUN_STOP_DEADLINE_MS + RUN_STOP_SETTLE_TIMEOUT_MS + STOP_REQUEST_MARGIN_MS;
/** How long to wait for a process group to disappear after the deadline's SIGKILL. */
export const FORCE_KILL_SETTLE_TIMEOUT_MS = 1_000;
/** A log append that has not finished by then is abandoned so it cannot block settling a service. */
export const OUTPUT_IDLE_TIMEOUT_MS = TERMINATION_PHASE_TIMEOUT_MS;

/** Under load `ps` takes longer than half a second; a timeout then fails daemon startup. */
export const PROCESS_INSPECTION_TIMEOUT_MS = 3_000;
/** Status reads must answer well inside the 5 s client timeout even when `ps` is slow, so they wait this long for a memory sample at most. */
export const MEMORY_SAMPLE_MAX_WAIT_MS = 250;
/** Minimum spacing between `ps`-based process group liveness checks, independent of how long one check may take. */
export const GROUP_LIVENESS_MIN_INTERVAL_MS = 500;
export const GROUP_LIVENESS_BACKOFF_INITIAL_MS = 25;
export const GROUP_LIVENESS_BACKOFF_MAX_MS = 250;

export const TERMINATION_TERM_SIGNAL = 15;
export const TERMINATION_KILL_SIGNAL = 9;
