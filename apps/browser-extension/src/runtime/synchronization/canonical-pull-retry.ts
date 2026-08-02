import {
  type CanonicalPullSynchronizationJob,
  MAX_AUTOMATIC_PULL_RETRY_ATTEMPTS,
} from "./canonical-state";

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 300_000;

function localTime(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function jitter(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("Pull retry jitter must be finite");
  return Math.min(1, Math.max(0, value));
}

function retryDelay(input: {
  readonly attempt: number;
  readonly random: number;
  readonly hostRetryAfterMs: number | null;
}): number {
  const exponent = input.attempt - 1;
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** exponent);
  const randomized = Math.floor(exponential * (0.5 + jitter(input.random)));
  const hostMinimum =
    input.hostRetryAfterMs === null
      ? 0
      : Math.min(MAX_RETRY_DELAY_MS, localTime(input.hostRetryAfterMs, "Host retry delay"));
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(randomized, hostMinimum));
}

/** Records one bounded local retry without changing the Job's remote snapshot or Quarantine. */
export function nextCanonicalPullRetry(input: {
  readonly previous: CanonicalPullSynchronizationJob;
  readonly nowMs: number;
  readonly random: () => number;
  readonly hostRetryAfterMs: number | null;
}): CanonicalPullSynchronizationJob {
  if (input.previous.state !== 1 || input.previous.stage === 3) {
    throw new TypeError("Only an active nonterminal Synchronization Job can enter retry");
  }
  const nowMs = localTime(input.nowMs, "Pull retry current time");
  if (input.previous.attempt >= MAX_AUTOMATIC_PULL_RETRY_ATTEMPTS) {
    return { ...input.previous, state: 4, retryAfterMs: null };
  }
  const attempt = input.previous.attempt + 1;
  const delayMs = retryDelay({
    attempt,
    random: input.random(),
    hostRetryAfterMs: input.hostRetryAfterMs,
  });
  return {
    ...input.previous,
    state: 2,
    attempt,
    retryAfterMs: nowMs + delayMs,
  };
}

/** Resumes an elapsed waiting Job, or restarts an exhausted Job only on explicit user pull. */
export function resumeCanonicalPullRetry(input: {
  readonly job: CanonicalPullSynchronizationJob;
  readonly nowMs: number;
  readonly force: boolean;
}): CanonicalPullSynchronizationJob {
  const nowMs = localTime(input.nowMs, "Pull retry current time");
  if (input.job.state === 2) {
    if (input.job.retryAfterMs === null) {
      throw new TypeError("A waiting Synchronization Job has no retry time");
    }
    return input.job.retryAfterMs > nowMs
      ? input.job
      : { ...input.job, state: 1, retryAfterMs: null };
  }
  if (input.job.state === 4 && input.force) {
    return { ...input.job, state: 1, attempt: 0, retryAfterMs: null };
  }
  return input.job;
}
