# Redis-Backed Ephemeral Coordination TDD Evidence

**Document:** `docs/plans/14-redis-backed-ephemeral-coordination-tdd-evidence.md`

**Status:** Complete implementation evidence

**Date:** 2026-07-25

**Base Commit:** `0903536f77a4`

**Implementation Commit:** uncommitted working tree

## Baseline

- The working tree began with the approved Plan 14 and its Roadmap entry uncommitted. Those files
  are preserved as part of this implementation.
- The Coordination Server used PostgreSQL `cable_tickets`, a cleanup Job, and Solid Cable.
- Development used the in-process Action Cable adapter. The retained synchronization proof used
  one Rails process and the in-process adapter.
- Repository Compose and Coordination Server CI had no Redis service.
- No hosted system was inspected or mutated.

## Approved Dependency Boundary

- Redis remains the separate, unmodified official server selected by Plan 14.
- No Redis server source is copied, linked, patched, embedded, or redistributed by AWSM.
- Bundler resolved `redis` 5.4.1, `redis-client` 0.30.1, and `connection_pool` 3.0.2. RubyGems
  metadata reports MIT for all three.
- Repository services use the exact approved `redis:8.2.8-alpine` image.

## RED → GREEN → REFACTOR Record

Results remain sanitized: no ticket, digest, Redis key, Account identifier, Redis URL, credential,
private path, or user data appears in this record.

### Ticket, outage, scrubbing, and readiness slice

RED:

- Command: focused RSpec execution for the Cable-ticket service/request, Cable connection, and
  readiness specs inside the disposable development container.
- Exit status: `1`; 12 examples, 5 failures.
- The response contract still required the discarded storage-driven ticket shape.
- The outage example's candidate was rejected as non-canonical before reaching the injected Redis
  failure.
- Every readiness component incorrectly reported unavailable because the probe dispatcher could
  not invoke its private probe methods.

GREEN:

- The same command exited `0`; 12 examples passed.
- The canonical OpenAPI pattern now accepts exactly 43 base64url characters.
- Real Redis representation, TTL, replay, malformed/expired/deleted-Account behavior, injected
  outage mapping, request scrubbing, and healthy/degraded/unavailable readiness passed.

REFACTOR:

- Added configuration-boundary coverage for validated settings, derived channel prefix, pool
  sizing, one-second timeouts, and disabled command replay.
- Added two-Account binding and explicit three-collision-budget coverage.
- The focused service command exited `0`; 11 examples passed.

### Two-process retained proof

RED:

- Command: `CI=true corepack pnpm test:sync-proof`.
- Exit status: `1`.
- The one-shot schema preparation service exited successfully, but Compose's
  `--abort-on-container-exit` treated that expected exit as a reason to stop the proof before both
  Rails processes and the independent client ran.

GREEN:

- The wrapper now completes schema preparation first, then runs the two Rails services and proof
  client under client-exit control.
- The same command exited `0`.
- A ticket issued through the primary was consumed by the peer, replay was rejected, primary
  broadcasts reached the peer subscription through Redis Pub/Sub, and HTTP polling independently
  observed the committed cursor.

### Production image

RED:

- Command: build the Coordination Server production image, then run its OpenAPI verifier.
- Exit status: `1` during asset precompilation.
- The production configuration gate correctly required the Redis URL, but it also ran during the
  network-independent image build. Plan 14 assigns the required URL check to production server
  boot, not image construction.

GREEN:

- The boundary now recognizes only the `assets:precompile` Rake task as build-time configuration
  and supplies a non-connecting loopback placeholder while Cable configuration is parsed.
- The production image build and OpenAPI verifier both exited `0`.
- A separate production boot probe without `AWSM_REDIS_URL` exited nonzero with the fixed
  configuration-key message before opening a connection.

## Final Verification

### Canonical schema and stale-language audit

- The exact named development and test databases were dropped and recreated from the sole
  canonical schema after inspecting the shared Compose project and volumes. The shared PostgreSQL
  volume itself was preserved.
- Direct PostgreSQL checks returned true for absence of `public.cable_tickets` in both databases.
- The isolated proof wrapper recreated and removed its PostgreSQL, Redis, and byte-storage state.
- The prior anonymous disposable Redis volume was removed after the service moved to `/data`
  tmpfs. The running Redis container has tmpfs at `/data` and no Docker volume mount.
- Repository searches found no Cable-ticket model/table, cleanup Job/schedule, Solid Cable gem,
  schema/database, or `uuid.secret` implementation. Remaining `CableTickets` names are the current
  public service/endpoint, and historical Plan 08/09 matches explicitly identify their superseded
  adapter context.

### Real Redis and readiness evidence

- The final Rails CI command exited `0`: 63 RSpec examples passed; RuboCop inspected 107 files with
  no offenses; Bundler Audit and Importmap Audit found no vulnerabilities; Brakeman found zero
  warnings.
- Real Redis tests verified 43-character/32-byte ticket encoding, the namespaced SHA-256-only key,
  Account UUID value, positive TTL no greater than 60 seconds, `SET NX EX 60`, one `GETDEL`,
  two-client atomicity, replay, forced expiry, malformed/non-canonical input, invalid stored value,
  deleted Account, Account binding, collision exhaustion, outage mapping, and scrubbed connection
  failures.
- Ticket, readiness, and hint-publication Redis failures report only a fixed credential-free
  operational error and allowlisted context; tests prove the injected endpoint sentinel is absent.
- Readiness tests verified complete healthy, Redis-only degraded HTTP 200, database-unavailable
  HTTP 503 while still probing Redis, and byte-storage-plus-Redis unavailable HTTP 503.
- A request test verified an Event remains committed and appears in canonical polling after Redis
  hint publication fails.
- Runtime `CONFIG GET` returned persistence disabled, 64 MiB maximum memory, and `noeviction`.

### Configuration and retained proof evidence

- All three Compose configuration commands exited `0`.
- The final `CI=true corepack pnpm test:sync-proof` exited `0` from fresh isolated state and proved
  primary issue, peer `GETDEL`, replay rejection, cross-process Redis Pub/Sub, and independent
  polling convergence without weakening the retained upload, commit, Generation, recovery,
  storage-relief retrieval, and purge assertions.
- The GitHub Actions Rails job uses the exact Redis image, loopback-only job port, health check,
  tmpfs, URL, and CI namespace. Repository development and proof services use the exact image,
  private network, non-persistent command, 64 MiB `noeviction` bound, health check, and no volume.
- Production deployment configuration requires the protected URL and a validated production
  namespace without defining a hosted topology, public port, hostname, credential, or persistence.

### Coordination Server E2E outage-recovery scenario

- `CI=true corepack pnpm test:e2e:coordination` exited `0` from fresh isolated state.
- The independent black-box harness kept two Rails processes live while stopping Redis, observed
  degraded HTTP 200 readiness, received retryable `AUTHENTICATION_UNAVAILABLE` from Cable-ticket
  issuance, committed an Event, and found it through authoritative polling.
- After restarting the same disposable Redis service, readiness returned to ready, Cable-ticket
  issuance recovered, and a primary commit reached the peer subscription through Redis Pub/Sub.
- The harness cleaned its isolated Compose project, temporary PostgreSQL state, Redis tmpfs, and
  opaque-byte volume.

### Final commands

All exited `0`:

- `docker compose config`
- `docker compose -f compose.sync-proof.yml config`
- `docker compose -f compose.coordination-e2e.yml config`
- `docker compose -f compose.sync-proof.yml -f compose.browser-proof.yml config`
- focused and full `bundle exec rspec`
- `bin/rubocop`
- `bin/bundler-audit`
- `bin/brakeman --quiet --no-pager --exit-on-warn --exit-on-error`
- `bin/ci`
- `CI=true corepack pnpm test:e2e:coordination`
- `CI=true corepack pnpm test:sync-proof`
- `CI=true corepack pnpm lint`
- `CI=true corepack pnpm typecheck`
- `CI=true corepack pnpm test`
- production image build and OpenAPI verifier
- Prettier write/check for every changed supported file
- `git diff --check`

No hosted server, remote database, remote Redis service, or deployment was inspected or mutated.
No deviation required a new project-owner decision.
