# Coordination Server Contract and Two-Replica Proof TDD Evidence

**Document:** `docs/plans/08-coordination-server-contract-and-two-replica-proof-tdd-evidence.md`
**Status:** Implementation evidence
**Owner:** Engineering
**Last Updated:** 2026-07-19
**Plan:** `docs/plans/08-coordination-server-contract-and-two-replica-proof.md`

---

# Purpose

This record preserves RED-before-GREEN evidence for Plan 08. It is not a substitute for the final
verification audit. Each task records the focused failing command, the expected missing behavior,
and the later passing command after production behavior exists.

# Task 1 — Canonical contracts

## RED

Command:

```bash
docker compose exec -T coordination-server bundle exec rspec spec/contracts/openapi_spec.rb spec/requests/service_policy_spec.rb
```

Result: three examples failed. The contract spec raised `ENOENT` for the absent canonical OpenAPI
document, and both request examples reached no `/api/service-policy` implementation. This is the
expected missing-contract/missing-resource RED state.

## Account and Vault Replica schema baseline

Command:

```text
docker compose exec -T coordination-server bundle exec rspec spec/models/account_spec.rb spec/models/vault_replica_spec.rb spec/requests/authentication_spec.rb
```

Expected RED result: `Account` and `VaultReplica` were undefined during spec loading (0 examples, 2 load errors). This establishes that the persistence and authentication slice did not exist before its implementation.

## Provisional Vault lifecycle

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/vaults_spec.rb
```

Expected RED result: 6 examples, 6 failures. Every Vault lifecycle request returned 404 because attachment, Account-scoped lookup, idempotent replay, and activation routes did not exist.

## Opaque upload transfer

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/upload_transfers_spec.rb
```

Expected RED result: 2 examples, 2 failures. Valid and checksum-mismatched part uploads both returned 404 because no ticket transfer or upload-finalization resources existed.

## One-Event closure commit

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/event_commits_spec.rb
```

Expected RED result: 3 examples, 3 failures. Upload creation and commit requests had no Rails resources; strict response validation surfaced the missing JSON protocol responses.

## Successor Generation and recovery

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/generation_recovery_spec.rb
```

Expected RED result: 2 examples, 2 failures. Candidate creation and fenced activation had no routes or protocol responses.

## Recovery purge safety

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/purges_spec.rb
```

Expected RED result: 2 examples, 2 failures. Manual purge creation and fresh-authentication enforcement had no protocol resources.

## Automatic recovery expiry

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/jobs/dispatch_expired_purges_job_spec.rb
```

Expected RED result: spec loading failed with `NameError: uninitialized constant DispatchExpiredPurgesJob`, establishing that recurring expiry dispatch did not exist.

## Purge retry checkpoint regression

Command:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/purges_spec.rb
```

Expected RED result: 3 examples, 1 failure. After an injected storage error, the targeted
Generation had zero membership rows instead of retaining both rows needed to reconstruct the exact
deletion snapshot on retry.

# Final GREEN verification

Focused purge and stale-Generation response verification:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec spec/requests/purges_spec.rb spec/requests/replica_reads_spec.rb
```

Result: 6 examples, 0 failures. The retry retains its durable target snapshot, resumes deletion,
and the stale-Generation outcome supplies the current Generation fence.

Complete Rails verification:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bin/ci
```

Result: RuboCop passed 83 files with no offenses, Bundler Audit and Importmap Audit found no known
vulnerabilities, Brakeman reported zero warnings, and all 28 RSpec examples passed.

Isolated black-box proof from fresh Compose volumes:

```text
corepack pnpm test:sync-proof
```

Result: two independent replicas converged through HTTP, Action Cable, polling, PostgreSQL, and
Disk; the proof also exercised interrupted multipart upload, closure durability, concurrent late
Event fencing, recovery, and verified purge.

Current reconciliation: Plan 14 retained this journey while splitting Rails into primary and peer
processes backed by one non-persistent Redis service. The current proof additionally verifies
cross-process ticket consumption, replay rejection, Redis Pub/Sub delivery, and polling
convergence.
