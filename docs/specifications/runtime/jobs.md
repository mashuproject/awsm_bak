# Runtime Job Framework Specification

**Document:** `docs/specifications/runtime/jobs.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/runtime/runtime.md`
- `docs/specifications/runtime/storage.md`

# 1. Purpose

Jobs provide durable execution for long-running local Client and Host workflows. Job state is
Execution State, not a Vault Record, and never synchronizes merely because the workflow concerns a
Vault.

# 2. Job record

Every typed Job namespace defines a random local Job ID, schema revision, Storage Realm, scope,
workflow idempotency key, creation time, state, stage, attempt, safe progress, cancellation state,
lease, input references, prepared-output references, and stable outcome. Secrets, plaintext
content, private keys, Recovery Phrases, passphrases, and diagnostic exception text are forbidden.

# 3. State machine

```text
Created -> Ready -> Running -> Succeeded
                         |-> Failed
                         |-> Cancelled
                         |-> Waiting -> Ready
```

Each Job type enumerates its exact waiting conditions and cancellation boundary. State transitions
use conditional writes and durable checkpoints. A renewable lease prevents duplicate workers but
never supplies Vault authority.

# 4. Job types

Initial types include Capture, pull synchronization, wrapper hydration, Projection rebuild, Search
indexing, AI processing, Import, Complete Export, Backup, Restore, Fork, Vacuum preparation,
Vacuum Adoption, Storage Relief, and Replica Garbage Collection. Host installations may separately
run admission cleanup, quota, notification, and Hosted Replica reaping Jobs.

# 5. Atomicity across storage systems

A Job prepares immutable output before promotion. When database and wrapper storage cannot share
one transaction, the Job records the exact prepared identities, verifies final bytes, commits the
authoritative or safety pointer once, then performs idempotent cleanup. Restart exposes either the
old valid state or the new valid state, never a half-authoritative graph.

# 6. Retry and cancellation

Retryable failures retain the same logical input and immutable prepared bytes. Backoff has jitter
and a bounded attempt policy. A retry never weakens validation or invents new randomized identity
after an ambiguous successful write.

Cancellation is checked only at a Job-type safe boundary. Work committed before cancellation
remains committed. Vacuum cannot be cancelled after its signed transition is accepted; Garbage
Collection cleanup is separately resumable. Live browser acquisition is not resumed after a crash.

# 7. Maintenance coordination

Local leases serialize only operations whose physical writes cannot safely overlap. They are
narrow, Vault- and Realm-scoped, expire safely, and are revalidated in the final transaction.
Ordinary additive Capture and synchronization are not globally stopped merely because a long Job
exists. A Host uses independent local database transactions for Accounts, Grants, quotas, and
opaque admission.

# 8. Progress and diagnostics

Progress reports exact stage-local counts and bytes when safe, never semantic content. Monotonic
percentage is optional and cannot determine correctness. Stable outcome keys are suitable for user
messages; logs retain no secrets or cross-Vault data.

# 9. Recovery

Startup validates every nonterminal Job against its namespace, Realm, selected Vault or Hosted
Replica, input identities, lease, and prepared bytes. It resumes only declared resumable stages.
Otherwise it fails safely and retains enough evidence for cleanup or explicit user retry.

# 10. Invariants

- Workers are replaceable; durable checkpoints own progress.
- A Job is never a portable member, Credential, Event author, or synchronization fact.
- Interrupted work cannot expose partial authority.
- Cleanup never races a recognized preservation root.
- Every Job namespace belongs to Execution State and declares transaction partners.

# References

- `docs/specifications/runtime/capture.md`
- `docs/specifications/runtime/search.md`
- `docs/specifications/vault/vacuum.md`
