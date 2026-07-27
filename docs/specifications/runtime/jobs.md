# Runtime Job Framework Specification

**Document:** `specifications/runtime/jobs.md`

**Version:** 1.0

**Status:** Draft

---

# 1. Purpose

The Runtime Job Framework provides durable execution of long-running operations.

It is responsible for scheduling, persistence, retries, progress reporting, cancellation, and recovery.

Application services define Job Types.

The Job Framework executes them.

---

# 2. Design Goals

The Job Framework MUST provide:

- durable execution
- resumable execution
- retries
- prioritization
- cancellation
- deterministic state transitions

---

# 3. Architecture

```
Service

↓

Job Scheduler

↓

Job Repository

↓

Worker

↓

Completion
```

Services submit Jobs.

Workers execute Jobs.

The Scheduler coordinates execution.

---

# 4. Job Types

Standard Job Types include:

- Capture Job
- Synchronization Job
- AI Job
- Projection Job
- Garbage Collection Job
- Vault Vacuum Job
- Import Job
- Export Job
- Backup Job
- Restore Job
- Storage Relief Job

Future Job Types MAY be introduced.

A Storage Relief Job is Vault-scoped and persisted. Its immutable estimate records candidate count
and exact safe-integer ciphertext bytes. Per-Artifact checkpoints progress through candidate,
verified, evicting, and terminal outcomes; proof metadata is durable before file removal. The Job
checks cancellation only between candidates, retains completed evictions, reports stable skip
reasons, resumes non-terminal work after restart, and never resumes a cancelled Job automatically.

Only one Capture, Import, Export, Vacuum, applying Server Switch, or Storage Relief operation may own
the affected Vault maintenance lease. Waiting for unlock or authentication is persisted and resumes
only after the same Vault context is revalidated.

---

# 5. Job Structure

Every Job SHALL contain:

- Job ID
- Job Type
- Job Version
- Creation Time
- Current State
- Priority
- Payload

Optional fields:

- Parent Job
- Correlation ID
- Retry Count
- Progress

---

# 6. Job States

Jobs transition through:

```
Created

↓

Queued

↓

Ready

↓

Running

↓

Succeeded
```

Alternative terminal states:

```
Running

↓

Failed
```

```
Running

↓

Cancelled
```

Retryable failures:

```
Failed

↓

Retry Waiting

↓

Queued
```

---

# 7. Scheduler

The Scheduler SHALL:

- select runnable Jobs
- respect priorities
- respect dependencies
- avoid duplicate execution

---

# 8. Workers

Workers execute Jobs.

Workers SHALL:

- report progress
- report completion
- report failure

Workers SHALL NOT manage retries.

---

# 9. Priorities

Suggested priorities:

- Critical
- High
- Normal
- Low
- Background

Scheduling policy is implementation-defined.

---

# 10. Dependencies

Jobs MAY depend upon other Jobs.

Dependent Jobs SHALL remain blocked until prerequisites complete successfully.

Job dependencies form a directed acyclic graph. The MVP MAY execute the graph sequentially, but the dependency model SHALL remain explicit.

Example:

```
Capture

↓

Encrypt Bundle Descriptor and Artifact wrappers

↓

Prepare Artifact wrappers and atomically store the Bundle graph records

↓

Synchronize Bundle
```

---

# 11. Progress

Jobs MAY expose progress.

Progress SHOULD be monotonic.

Progress reporting SHALL NOT affect Job correctness.

---

# 12. Retries

Retry policy SHALL include:

- retry limit
- delay strategy
- retry reason

Permanent failures SHALL terminate the Job.

---

# 13. Cancellation

Jobs MAY be cancelled.

Cancellation SHALL leave persistent state consistent.

Completed Jobs cannot be cancelled.

---

# 14. Persistence

Job state SHALL survive Runtime restarts.

Restarting the Runtime SHALL restore pending Jobs.

---

# 15. Recovery

The Scheduler SHALL detect interrupted Jobs.

Interrupted Jobs SHALL return to an executable state unless explicitly marked unrecoverable.

Live browser page acquisition is explicitly non-resumable because the external page may have changed. An interrupted Capture Job SHALL be marked Failed and require a new user-initiated Capture Command.

Capture recovery SHALL first check the original Command outcome. If the authoritative transaction committed before interruption, recovery SHALL mark the Job Succeeded without emitting another Event. Otherwise no partial Bundle or Event may exist.

---

# 16. Events

Job lifecycle events MAY include:

- JobQueued
- JobStarted
- JobProgress
- JobSucceeded
- JobFailed
- JobCancelled

These are Runtime Events.

They are not synchronized between replicas.

---

# 17. Diagnostics

The Job Framework SHOULD expose:

- queue depth
- running jobs
- retry counts
- execution times
- worker utilization

---

# 18. Invariants

## Complete Vault Import Job

The browser Runtime persists only the current/latest Workspace-scoped Import Job. Its states are
Created, Running, Succeeded, Failed, and Cancelled; its stages are Acquire, Authenticate, Validate,
Prepare, Rebuild, and Commit. Created/Authenticate is the sole retryable authentication state.
Running begins only after Root Key authentication and carries the authenticated destination Vault
ID. Progress describes encrypted operational bytes and entries and is monotonic within a stage.

A non-terminal Import Job owns the Workspace management lease. Passphrase, source filename,
temporary path, Root Key, derived key, Vault name, and decrypted package data SHALL NOT enter the
Job. Restart makes a non-terminal Import Job fail with `IMPORT_INTERRUPTED`; Import does not resume
because its passphrase is not persisted. Success is written in the destination activation
transaction. Cancellation before activation is terminal and idempotent.

## Search Indexing Job

The browser Runtime persists one current Search indexing Job per Vault and provider generation.
Its stages are Discover, Keyword, Semantic, Validate, and Terminal. Its states are Created,
Running, Paused, WaitingForUnlock, WaitingForLibrary, WaitingForPermission, WaitingForNetwork,
Failed, and Succeeded.

Discovery orders authoritative Captures by Bundle ID and writes one durable checkpoint per
Capture. Each checkpoint binds the source revision, keyword state, semantic state, attempt count,
and last stable error identifier. A renewable 30-second lease identifies the active Library
owner; it SHALL be renewed no later than every ten seconds, and a different owner may claim only
after expiry.

Indexing runs only while the Library is connected and visible, the expected Vault is active and
unlocked, the user has not paused, required provider permission exists, and a remote provider is
online. Losing any gate aborts the current plaintext batch and releases the lease to the exact
waiting state. Committed Capture rows remain available.

A Capture materialization, its checkpoint, Job counters, and projection revision SHALL commit
atomically. A failed Capture, its attempt count, safe error identifier, retry deadline, and Job
failure SHALL also commit atomically. Resume resets failed checkpoints to Pending and retains the
same generation unless a changed authoritative Vault generation, Search schema, tokenizer, or
provider identity requires rebuild.

Search Jobs, checkpoints, leases, errors, and retry deadlines are local operational records. They
SHALL NOT synchronize or enter Export, Import, Backup, or diagnostics containing Vault
identifiers.

Jobs are durable.

Workers are stateless.

Schedulers are deterministic.

Retries are centrally managed.

Services define behavior.

The Job Framework defines execution.

---

# References

- `docs/specifications/runtime/runtime.md`
- `docs/specifications/runtime/synchronization.md`
- `docs/specifications/runtime/capture.md`
- `docs/specifications/portability/backup.md`
- `docs/specifications/portability/restore.md`
