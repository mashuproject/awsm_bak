import { DomainValidationError } from "../../domain/errors";
import { timestamp } from "../../domain/validation";
import type { SearchIndexJobState, SearchIndexJobV1 } from "../../drivers/indexeddb/schema";
import { decodeSearchIndexJob } from "../../drivers/indexeddb/search-decode";

const LEASE_DURATION_MS = 30_000;

export interface SearchIndexingGate {
  readonly connected: boolean;
  readonly visible: boolean;
  readonly expectedVaultActive: boolean;
  readonly unlocked: boolean;
  readonly paused: boolean;
  readonly permissionPresent: boolean;
  readonly online: boolean;
}

export type SearchIndexWaitState =
  | "Paused"
  | "WaitingForUnlock"
  | "WaitingForLibrary"
  | "WaitingForPermission"
  | "WaitingForNetwork";

function nextExpiry(now: string): string {
  const parsed = timestamp(now, "searchLease.now");
  return new Date(new Date(parsed).valueOf() + LEASE_DURATION_MS).toISOString();
}

function owner(value: string): string {
  if (value.length === 0 || value.length > 256)
    throw new DomainValidationError("searchLease.owner", "must contain 1 through 256 code units");
  return value;
}

function assertMonotonicTime(job: SearchIndexJobV1, now: string): void {
  timestamp(now, "searchLease.now");
  if (now < job.updatedAt)
    throw new DomainValidationError("searchLease.now", "precedes the durable Job");
}

export function claimSearchIndexLease(
  jobValue: SearchIndexJobV1,
  leaseOwner: string,
  now: string,
): SearchIndexJobV1 | undefined {
  const job = decodeSearchIndexJob(jobValue);
  const claimedBy = owner(leaseOwner);
  assertMonotonicTime(job, now);
  if (job.state === "Paused" || job.state === "Failed" || job.state === "Succeeded")
    return undefined;
  if (
    job.leaseOwner !== undefined &&
    job.leaseOwner !== claimedBy &&
    (job.leaseExpiresAt ?? "") > now
  )
    return undefined;
  const {
    leaseOwner: _priorOwner,
    leaseExpiresAt: _priorExpiry,
    retryAt: _retryAt,
    errorId: _errorId,
    ...durable
  } = job;
  return decodeSearchIndexJob({
    ...durable,
    state: "Running",
    updatedAt: now,
    leaseOwner: claimedBy,
    leaseExpiresAt: nextExpiry(now),
  });
}

export function renewSearchIndexLease(
  jobValue: SearchIndexJobV1,
  leaseOwner: string,
  now: string,
): SearchIndexJobV1 {
  const job = decodeSearchIndexJob(jobValue);
  const claimedBy = owner(leaseOwner);
  assertMonotonicTime(job, now);
  if (
    job.state !== "Running" ||
    job.leaseOwner !== claimedBy ||
    job.leaseExpiresAt === undefined ||
    job.leaseExpiresAt <= now
  )
    throw new DomainValidationError("searchLease", "is not owned or has expired");
  return decodeSearchIndexJob({
    ...job,
    updatedAt: now,
    leaseExpiresAt: nextExpiry(now),
  });
}

export function releaseSearchIndexLease(
  jobValue: SearchIndexJobV1,
  leaseOwner: string,
  nextState: SearchIndexWaitState,
  now: string,
): SearchIndexJobV1 {
  const job = decodeSearchIndexJob(jobValue);
  const claimedBy = owner(leaseOwner);
  assertMonotonicTime(job, now);
  if (job.state !== "Running" || job.leaseOwner !== claimedBy)
    throw new DomainValidationError("searchLease", "is not owned");
  const {
    leaseOwner: _priorOwner,
    leaseExpiresAt: _priorExpiry,
    retryAt: _retryAt,
    errorId: _errorId,
    ...durable
  } = job;
  return decodeSearchIndexJob({ ...durable, state: nextState, updatedAt: now });
}

export function completeSearchIndexJob(
  jobValue: SearchIndexJobV1,
  leaseOwner: string,
  now: string,
): SearchIndexJobV1 {
  const job = decodeSearchIndexJob(jobValue);
  const claimedBy = owner(leaseOwner);
  assertMonotonicTime(job, now);
  if (
    job.state !== "Running" ||
    job.leaseOwner !== claimedBy ||
    job.completedCaptures + job.failedCaptures !== job.totalCaptures
  )
    throw new DomainValidationError("searchIndexJob", "is not owned or has incomplete progress");
  const {
    leaseOwner: _priorOwner,
    leaseExpiresAt: _priorExpiry,
    retryAt: _retryAt,
    errorId: _errorId,
    ...durable
  } = job;
  return decodeSearchIndexJob({
    ...durable,
    state: "Succeeded",
    stage: "Terminal",
    updatedAt: now,
  });
}

export function failSearchIndexJob(
  jobValue: SearchIndexJobV1,
  leaseOwner: string,
  errorId: string,
  now: string,
  retryAt?: string,
): SearchIndexJobV1 {
  const job = decodeSearchIndexJob(jobValue);
  const claimedBy = owner(leaseOwner);
  assertMonotonicTime(job, now);
  if (job.state !== "Running" || job.leaseOwner !== claimedBy)
    throw new DomainValidationError("searchIndexJob", "is not owned");
  if (errorId.length === 0 || errorId.length > 128)
    throw new DomainValidationError("searchIndexJob.errorId", "must contain 1 through 128 units");
  if (retryAt !== undefined && timestamp(retryAt, "searchIndexJob.retryAt") < now)
    throw new DomainValidationError("searchIndexJob.retryAt", "precedes its failure");
  const {
    leaseOwner: _priorOwner,
    leaseExpiresAt: _priorExpiry,
    retryAt: _priorRetryAt,
    errorId: _priorErrorId,
    ...durable
  } = job;
  return decodeSearchIndexJob({
    ...durable,
    state: "Failed",
    updatedAt: now,
    errorId,
    ...(retryAt === undefined ? {} : { retryAt }),
  });
}

export function pauseSearchIndexJob(jobValue: SearchIndexJobV1, now: string): SearchIndexJobV1 {
  const job = decodeSearchIndexJob(jobValue);
  assertMonotonicTime(job, now);
  if (job.state === "Succeeded")
    throw new DomainValidationError("searchIndexJob", "is already complete");
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    retryAt: _retryAt,
    errorId: _errorId,
    ...durable
  } = job;
  return decodeSearchIndexJob({ ...durable, state: "Paused", updatedAt: now });
}

export function resumeSearchIndexJob(jobValue: SearchIndexJobV1, now: string): SearchIndexJobV1 {
  const job = decodeSearchIndexJob(jobValue);
  assertMonotonicTime(job, now);
  if (
    job.state !== "Paused" &&
    job.state !== "Failed" &&
    job.state !== "WaitingForUnlock" &&
    job.state !== "WaitingForLibrary" &&
    job.state !== "WaitingForPermission" &&
    job.state !== "WaitingForNetwork"
  )
    return job;
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    retryAt: _retryAt,
    errorId: _errorId,
    ...durable
  } = job;
  return decodeSearchIndexJob({ ...durable, state: "Created", updatedAt: now });
}

export function indexingWaitState(gate: SearchIndexingGate): SearchIndexWaitState | undefined {
  if (gate.paused) return "Paused";
  if (!gate.connected || !gate.visible) return "WaitingForLibrary";
  if (!gate.expectedVaultActive || !gate.unlocked) return "WaitingForUnlock";
  if (!gate.permissionPresent) return "WaitingForPermission";
  if (!gate.online) return "WaitingForNetwork";
  return undefined;
}

export function isSearchIndexWaitState(value: SearchIndexJobState): value is SearchIndexWaitState {
  return (
    value === "Paused" ||
    value === "WaitingForUnlock" ||
    value === "WaitingForLibrary" ||
    value === "WaitingForPermission" ||
    value === "WaitingForNetwork"
  );
}
