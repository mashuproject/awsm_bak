# Deployment and Operations

**Document:** `architecture/20-deployment-and-operations.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/03-zero-knowledge.md
- architecture/15-coordination-server.md
- architecture/19-testing-strategy.md

---

# Isolated Synchronization Proof

`compose.sync-proof.yml` creates an explicitly named isolated project containing PostgreSQL 17,
non-persistent Redis 8, one schema-preparation process, two Rails test/proof processes, a private
Disk byte volume, and an independent pinned Node 24 client. The Rails processes share PostgreSQL,
Redis, and the same-host proof Disk volume. A ticket issued by the primary is consumed by the peer,
and Redis Pub/Sub carries primary hints to the peer-hosted socket. HTTP polling independently
proves convergence. Proof volumes never reuse development data.

Run the proof only through its cleanup wrapper, which removes the explicitly named proof containers,
network, PostgreSQL volume, disposable Redis state, and opaque-byte volume both before and after
execution:

```bash
corepack pnpm test:sync-proof
```

This heavyweight proof is a local verification gate. Hosted CI does not run it. Run it before
publishing changes to synchronization, protocol, Redis coordination, opaque storage, Generation,
or multi-replica behavior.

# Public Product Surface

Every hosted or self-hosted Coordination Server serves the same public-preview AWSM landing page at
`/`, plus factual `/privacy` and `/security` pages, a `/glossary`, and separate Rails Account
routes. The public pages identify the configured canonical origin and registration availability
without claiming that an arbitrary self-hosted deployment is the official hosted service.

The product surface loads no remote font, script, image, analytics, tracking pixel, or marketing
cookie. Production images copy `/design-system` from the shared workspace before asset precompile;
development mounts that package read-only. `/design-system` is a development/test-only visual
fixture and has no production route.

The four public pages render one Account-independent ERB representation with no CSRF metadata,
session cookie, or `Set-Cookie` response. They advertise five-minute browser freshness and 24-hour
shared-CDN freshness with bounded stale revalidation and origin-error windows. A deployment may
use any compatible CDN or reverse-proxy cache with an exact host/path/method allowlist; a deployment
without one continues to serve the pages through Rails.

Browser authentication writes a random readable functional hint beside the authoritative signed
HttpOnly session cookie. Only browsers carrying the hint request private, no-store
`GET /session/status`; the client then adds Account navigation and the synchronization banner
without implying Vault access. The hint is not authentication and contains no Account data.
Signup, session, Account, API, Cable, transfer, health, readiness, error, redirect, and non-GET/HEAD
responses remain dynamic and outside the shared public-page cache.

Operators purge only the four canonical public URLs after a relevant application deployment,
rollback, configured-origin change, or registration-state change. Deploy and health-check the
origin before purging, then warm and verify cache hits. Staging and production require isolated
origins, processes, configuration, PostgreSQL, Redis, queues, opaque storage, logs, runtime state,
health checks, and cache entries even when colocated.

The isolated client creates and authenticates an ordinary test Account through the public API.
`AWSM_SYNC_PROOF=true` selects proof-only origin and request-forgery behavior; both Rails processes
use the production Redis Action Cable adapter contract and no alternate authenticator.

The separate operational resilience suite is also a local verification gate:

```bash
corepack pnpm test:e2e:coordination
```

It runs two Rails processes and exercises Redis outage and recovery. Hosted CI retains the Rails
unit, static-analysis, security, and production-image jobs, but does not run either heavyweight
Docker proof.

# Storage

PostgreSQL stores Account/Vault scope, opaque immutable metadata, upload state, Generation
membership, Delivery Cursors, idempotency, and Purge Job checkpoints. It MUST NOT store Object
payload bytes. The proof Disk Driver stores ciphertext under a configured non-public root with
least-privilege files, bounded buffers, fsync, atomic rename, range reads, and verified deletion.

A multi-host deployment requires an approved shared immutable-byte Driver and shared Job
infrastructure. Redis already supplies shared ephemeral Cable coordination. Disk is not
horizontally shared. Provider-specific adapters are not present in the proof.

# Health and Integrity

`/up` is liveness. `/ready` independently verifies PostgreSQL, write/delete access to the configured
private storage root, and Redis without reading Vault content. Redis-only loss returns HTTP 200
with degraded ephemeral coordination so authenticated HTTP polling remains available. PostgreSQL
or byte-storage failure returns HTTP 503. A committed byte that is absent or corrupt is an integrity
incident: readiness and reads fail safely, metadata remains intact, and operators receive only
allowlisted operational context.

# Ephemeral Coordination

Repository Compose uses one private `redis:8.2.8-alpine` service for Cable-ticket commands and
Action Cable Pub/Sub. Persistence is disabled, memory is bounded at 64 MiB with `noeviction`, no
Redis volume or backup exists, and no repository Compose port is published. Production requires a
protected `AWSM_REDIS_URL` and a deployment-appropriate namespace. Provisioning and changing the
hosted topology remain separately authorized Roadmap work.

# Jobs and Retention

Hosted recovery defaults to 90 days and self-hosted values are validated at boot and advertised.
A recurring dispatcher creates automatic Purge Jobs for expired superseded Generations. Manual and
automatic deletion use the same durable stages and resume from domain checkpoints; queue state is
not the user-visible source of truth. Operators MUST monitor failed-retryable Jobs and storage
integrity without logging membership lists or ciphertext identifiers by default.

Clients own storage-relief and retrieval Jobs. Operators monitor only allowlisted outcome counters
and transfer failures; diagnostics MUST NOT reveal local availability lists, semantic Artifact roles,
Object identifiers, filenames, URLs, plaintext, or keys. Quota failure is distinct from integrity
failure: the client removes partial local files and may continue through a fresh bounded transient
download.

# Logging and Secrets

Normal logs may contain request ID, internal operational row IDs, operation, stable outcome, broad
Object type, counters, duration, and retry count. They MUST NOT contain bearer credentials, transfer
tickets, Cable credentials, request/response bodies, ciphertext, storage paths, plaintext-derived
metadata, keys, or full recovery memberships. Parameter filtering covers email/password variants,
Recovery Phrase fields, authorization, credentials, tokens, tickets, Device secrets, key
envelopes, Recovery Kits, ciphertext, and salts. Cable ticket consumption removes the raw ticket
from retained request parameters and URL state.

# Backup and Restore

Operational backup must capture PostgreSQL and immutable-byte storage at a mutually consistent
boundary and preserve the distinction between active, recovery, and tombstoned records. It is not a
Vault Backup and cannot produce plaintext. Restoring operational infrastructure does not authorize
resurrection of purged tombstones or reuse of discarded pre-release formats.
Redis ephemeral coordination is deliberately excluded from backup and restore.

# Production Gate

Production promotion still requires quotas and abuse controls, a shared storage Driver, shared
notifications, backup/restore exercises, alerting, incident response, metadata/traffic analysis,
and independent security review of Device/recovery authorization. Email/password Account
authentication, Recovery Phrase enrollment, Device revocation and Future Protection, one-Vault
synchronization, recurring Jobs, extension onboarding/settings, manual encrypted-wrapper storage
relief, on-demand retrieval, stale-Replica discard, and full Vault replacement are implemented.
