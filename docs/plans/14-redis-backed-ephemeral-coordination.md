# Redis-Backed Ephemeral Coordination

**Document:** `docs/plans/14-redis-backed-ephemeral-coordination.md`

**Status:** Approved implementation plan

**Owner:** Engineering

**Last Updated:** 2026-07-25

**Depends On:** `docs/plans/08-coordination-server-contract-and-two-replica-proof.md`,
`docs/plans/09-account-authentication-and-full-vault-synchronization.md`,
`docs/specifications/protocol/protocol.md`,
`docs/specifications/protocol/http-api.openapi.yaml`,
`docs/specifications/runtime/synchronization.md`,
`docs/architecture/03-zero-knowledge.md`,
`docs/architecture/08-synchronization.md`,
`docs/architecture/15-coordination-server.md`,
`docs/architecture/19-testing-strategy.md`,
`docs/architecture/20-deployment-and-operations.md`, and `ROADMAP.md`

---

# 1. Purpose

This is the decision-complete implementation plan for replacing PostgreSQL-backed one-use Action
Cable ticket rows and Solid Cable with one shared Redis 8 ephemeral-coordination service. It is
written for an implementer starting from a cold checkout with no conversation context. Do not
reopen the decisions recorded here.

The completed work SHALL:

1. store one-use Action Cable credentials only as TTL-bound SHA-256-derived Redis keys;
2. atomically consume each ticket exactly once across Rails processes;
3. use the same Redis service for Action Cable Pub/Sub so a commit in one Rails process can wake a
   WebSocket connected to another;
4. keep HTTP polling sufficient for synchronization correctness when Redis or WebSocket delivery
   is unavailable;
5. remove the PostgreSQL Cable-ticket table, model, association, cleanup Job, recurring schedule,
   and Solid Cable database;
6. expose one opaque 256-bit Cable ticket instead of a storage-driven `uuid.secret` value;
7. operate Redis as a bounded, non-persistent, single-node service in development and retained
   proofs;
8. report Redis loss as degraded ephemeral coordination without making the complete Coordination
   Server unavailable;
9. prove the real Redis ticket and Pub/Sub boundaries with two Rails processes; and
10. leave hosted rollout and highly available Redis topology as explicit Roadmap initiatives.

Redis is an advisory-notification and short-lived WebSocket-authentication dependency. It is not
authoritative storage, is not part of a Vault Backup or operational backup, and must never become
necessary for HTTP polling convergence.

# 2. Fixed Decisions, Scope, and Deferrals

## 2.1 Fixed decisions

- Use the official `redis:8.2.8-alpine` image. Redis 8.2 is the selected Redis 8 LTS line.
- Use one Redis service for both Cable tickets and the Action Cable Redis adapter.
- Keep Redis on an internal service network. Do not publish its port from repository Compose
  configurations except the loopback port required by the GitHub Actions service container.
- Disable RDB snapshots and AOF. Mount no Redis data volume and create no Redis backup.
- Set a 64 MiB dataset limit with the `noeviction` policy. Capacity exhaustion fails new ticket
  issuance rather than evicting an unexpired credential.
- Keep the top-level Coordination Server ready when only Redis is unavailable. Report a degraded
  component and keep authenticated HTTP synchronization available.
- Use a single Redis node. Replication, Sentinel, managed Redis, cluster mode, automatic failover,
  and multi-host deployment are not part of this plan.
- Change the public Cable-ticket value to one unpadded base64url encoding of 32 random bytes.
- Update the sole pre-release schema in place. Do not add a database migration or compatibility
  path for PostgreSQL Cable tickets.
- Change repository code, local Compose, CI, retained proofs, and documentation only. Do not SSH to,
  deploy, restart, or edit the hosted Coordination Server.

## 2.2 Licensing gate

The project owner explicitly approved Redis 8 on 2026-07-25 after reviewing Redis 8's AGPLv3
option and the effect of a strong-copyleft dependency on proprietary AWSM distributions. This
approval is limited to the topology in this plan:

- AWSM communicates with an unmodified Redis server over the Redis protocol;
- the Redis server remains a separate container or separately managed service;
- the repository may reference the official Redis image and use the permissively licensed
  `redis-rb` client;
- no Redis source is copied into AWSM;
- no AGPL Redis server code is statically or dynamically linked into an AWSM executable; and
- AWSM does not patch, fork, embed, or redistribute a modified Redis build.

If implementation would cross one of those boundaries, stop and obtain a new project-owner
decision after identifying the copyright and relicensing consequences. Do not silently replace
Redis with Valkey, copy an AGPL reference implementation, or infer that ownership of AWSM grants
ownership of Redis.

## 2.3 In scope

- a pooled application Redis client for Cable-ticket commands and readiness;
- an environment-namespaced Redis key contract;
- Redis-backed ticket issue and atomic consumption;
- the Action Cable Redis subscription adapter;
- explicit Redis failure mapping and sanitized reporting;
- component-aware readiness that distinguishes degraded ephemeral coordination from unavailable
  authoritative dependencies;
- removal of Cable-ticket and Solid Cable PostgreSQL persistence;
- development, test, CI, synchronization-proof, and browser-proof Redis configuration;
- a two-Rails-process black-box ticket and hint proof;
- OpenAPI, architecture, operations, testing, README, prior-plan, and Roadmap reconciliation;
- destruction and recreation of affected pre-release development/test databases; and
- a TDD evidence record created while implementing this plan.

## 2.4 Explicitly deferred

- any mutation of the hosted `awsm.foo` deployment;
- production Redis credentials, private network provisioning, firewall changes, or TLS
  certificates;
- persistence, backups, recovery, replicas, Sentinel, Redis Cluster, or managed failover;
- shared immutable-byte storage or multi-host Rails support;
- replacing Solid Queue or Solid Cache with Redis;
- using Redis for Account sessions, access credentials, refresh credentials, transfer tickets,
  idempotency, rate limits, quotas, Jobs, caches, locks, or canonical synchronization state;
- a fallback to PostgreSQL tickets or Solid Cable when Redis is unavailable;
- protocol version negotiation or support for the superseded `uuid.secret` Cable ticket;
- a user-facing UI change; and
- production load testing, capacity selection, alert routing, or incident-response exercises.

# 3. Security and Correctness Invariants

Implementation and tests SHALL preserve all of these invariants:

1. The raw Cable ticket exists only in the issuing Rails process, the HTTPS response, the browser
   Runtime, and the initial WebSocket request until request scrubbing finishes.
2. Redis stores no raw Cable ticket. Its key contains only a fixed namespace plus the lowercase
   hexadecimal SHA-256 of the complete externally exchanged ticket.
3. Redis stores the owning Account UUID as the value. The Account identifier is server-visible
   operational metadata already allowed by the Coordination Server boundary.
4. A ticket is valid for no more than 60 seconds and disappears without a cleanup Job.
5. `GETDEL` is the only ticket-consumption command. Exactly one concurrent consumer can receive the
   Account UUID.
6. A malformed, unknown, expired, replayed, or deleted-Account ticket is always an
   `AUTHENTICATION_FAILED` outcome at the service boundary.
7. Redis transport, timeout, protocol, command, authentication, and capacity failures are
   `AUTHENTICATION_UNAVAILABLE`, not invalid credentials.
8. Losing the reply after Redis accepted `GETDEL` may burn a ticket, but must never authenticate the
   ticket twice. The browser can obtain another ticket.
9. Action Cable hints contain only `vaultId` and `latestCursor`. Redis receives no plaintext,
   ciphertext, keys, URLs, titles, Object identifiers, membership lists, or semantic metadata.
10. A failed broadcast never rolls back, changes, or obscures a successful authoritative
    PostgreSQL commit.
11. Polling remains sufficient after dropped hints, Redis restart, Redis outage, WebSocket
    disconnection, Rails-process restart, or worker suspension.
12. Diagnostics never include a Redis URL, Redis credential, raw ticket, ticket digest, Redis key,
    Account UUID from a ticket value, request query string, or WebSocket URL containing a ticket.

# 4. Public and Operational Contracts

## 4.1 Cable-ticket HTTP contract

Keep the existing endpoint and response:

```http
POST /api/cable-tickets
Authorization: Bearer <access credential>
Awsm-Protocol-Version: 1
Awsm-Request-ID: <uuid>
```

```json
{
  "ticket": "<opaque credential>",
  "expiresAt": "<RFC 3339 timestamp>"
}
```

Change the sole canonical `ticket` schema to:

```yaml
type: string
pattern: "^[A-Za-z0-9_-]{43}$"
```

The value is the unpadded base64url encoding of exactly 32 random bytes. It has 256 bits of entropy.
It contains no public lookup ID, delimiter, format version, Account identifier, or expiry. Compared
with `uuid.secret`, this removes redundant UUID generation/parsing and reduces the credential from
80 to 43 URL characters without reducing entropy.

Keep status `201` and the existing response property names. Do not add a Redis-specific capability,
storage backend, ticket type, or version to server information or this response.

## 4.2 Cable connection contract

Keep:

```text
/cable?ticket=<percent-encoded opaque ticket>
```

Keep the `actioncable-v1-json` subprotocol, `VaultChangesChannel`, Account-scoped Vault
authorization, subscription identifier, and hint payload unchanged.

`ApplicationCable::Connection#connect` SHALL continue to scrub the ticket from:

- parsed request parameters;
- `QUERY_STRING`;
- `REQUEST_URI`;
- `ORIGINAL_FULLPATH`;
- cached Action Dispatch query parameters; and
- Rack's cached query hash.

The scrub remains in `ensure` so it runs after success, invalid credentials, Redis failure,
database failure, and unexpected exceptions.

## 4.3 Stable failure mapping

On application Redis failure, the Cable-ticket HTTP endpoint returns:

```json
{
  "outcome": "AUTHENTICATION_UNAVAILABLE",
  "retryable": true,
  "requestId": "<request ID>"
}
```

with HTTP `503`.

Do not add a new outcome. `AUTHENTICATION_UNAVAILABLE` already exists in the OpenAPI outcome enum.
Do not expose Redis exception classes or messages in the response.

The WebSocket handshake cannot return the JSON outcome contract. A Redis failure during ticket
consumption rejects the connection as unauthorized after safe internal error reporting. The
browser's existing best-effort Cable setup catches this failure and continues one-minute polling.

## 4.4 Readiness contract

Expand `GET /ready` to return a fixed component map:

```json
{
  "status": "ready",
  "components": {
    "database": "ready",
    "opaqueByteStorage": "ready",
    "ephemeralCoordination": "ready"
  }
}
```

Allowed component values are only `ready` and `unavailable`. Allowed top-level values and statuses
are:

| Condition                                   | HTTP | `status`      |
| ------------------------------------------- | ---- | ------------- |
| all three components ready                  | 200  | `ready`       |
| only ephemeral coordination unavailable     | 200  | `degraded`    |
| database or opaque byte storage unavailable | 503  | `unavailable` |
| Redis plus a critical component unavailable | 503  | `unavailable` |

Probe every component independently so the map is complete even when one check fails. Keep the
existing PostgreSQL `SELECT 1` and private byte-storage write/delete probe. Add Redis `PING` through
the application pool. Return no exception text, paths, hostnames, connection URLs, ports, database
names, or credentials.

Report each failed probe through `Rails.error` with only
`component: "readiness"` and one of the fixed component names. Do not include the exception object
in custom context; the error reporter may receive the exception through its normal argument.

# 5. Redis Server and Namespace Contract

## 5.1 Server configuration

Use this logical Redis configuration in repository-controlled Compose services:

```text
image: redis:8.2.8-alpine
save ""
appendonly no
maxmemory 64mb
maxmemory-policy noeviction
```

Add a `redis-cli ping` health check with the same short cadence used by the PostgreSQL health
check. Create no Redis volume. Do not expose Redis through a host port in development or proof
Compose.

CI may bind the service to `127.0.0.1:6379` because GitHub Actions service containers require the
job process to reach it. The CI service remains disposable and stores no user data.

## 5.2 Environment

Add exactly these operational settings:

| Name                   | Purpose                                 | Default                                              |
| ---------------------- | --------------------------------------- | ---------------------------------------------------- |
| `AWSM_REDIS_URL`       | Redis connection URL                    | loopback in development/test; required in production |
| `AWSM_REDIS_NAMESPACE` | keys and Action Cable channel isolation | `awsm:coordination:<Rails.env>`                      |

Rules:

- Development and test default to `redis://127.0.0.1:6379/0` when the environment variable is
  absent so direct host tooling has a deterministic target.
- Production boot fails before serving traffic when `AWSM_REDIS_URL` is missing or empty.
- Accept `redis://` and `rediss://`. Do not parse, reconstruct, normalize, log, or echo the URL.
- The namespace must be 1 through 64 ASCII characters matching
  `\A[a-z0-9][a-z0-9:_-]*\z`. Invalid configuration fails at boot with a message naming only the
  environment-variable key.
- The namespace is operational, not secret. Never include environment-specific private hostnames
  or deployment identifiers in tracked defaults.
- Derive the Action Cable `channel_prefix` by replacing `:` with `_` in the validated namespace.
  Do not introduce a third environment variable for the channel prefix.

The primary synchronization-proof Rails processes share one namespace. The independent second
Coordination Server used by browser server-switching proof uses a different namespace even though
it may share the same disposable Redis container.

## 5.3 Redis ticket key

For a raw ticket string `T`, calculate:

```text
D = lowercase_hex(SHA-256(UTF-8(T)))
K = <AWSM_REDIS_NAMESPACE>:cable-ticket:<D>
V = lowercase Account UUID
```

`D` is exactly 64 lowercase hexadecimal characters. The complete key contains no raw credential.
Do not store a JSON value, timestamp, digest field, ticket UUID, or redundant key metadata.
Expiration is owned solely by Redis TTL.

Do not enumerate ticket keys in production application behavior. Tests may scan only their unique
test namespace to prove representation and clean up isolation.

# 6. Application Redis Boundary

## 6.1 Dependencies

In `apps/coordination-server/Gemfile`:

- add `gem "redis", "~> 5.4"` for Rails 8.1's Action Cable Redis adapter and direct ticket
  commands;
- add `gem "connection_pool", "~> 3.0"` as an explicit direct dependency because application code
  uses it; and
- remove `solid_cable`.

Regenerate `Gemfile.lock` through Bundler. Do not hand-edit the lockfile. Confirm the resolved
`redis-rb` client is permissively licensed and record the resolved versions in the TDD evidence.
Do not add hiredis, Redis modules, a cache framework, or a second Redis client.

## 6.2 Pooled application client

Add one small boundary under `Coordination`, named `Coordination::EphemeralCoordination`, that owns:

- environment URL and namespace access;
- validated configuration;
- a lazily created `ConnectionPool`;
- ticket-key derivation;
- `with_redis`;
- `ping`; and
- a test-only pool reset hook needed after configuration stubbing.

Call `Coordination::EphemeralCoordination.validate_configuration!` from one
`Rails.application.config.after_initialize` hook. Validation checks URL presence/scheme, namespace,
and pool size without opening a Redis connection. This makes invalid production configuration fail
at boot while allowing a correctly configured application to boot when the Redis server itself is
temporarily unavailable.

The pool size equals the parsed positive integer value of `RAILS_MAX_THREADS`, defaulting to `5`.
Pool checkout timeout is one second.

Each pooled `Redis` client SHALL use:

```ruby
connect_timeout: 1
read_timeout: 1
write_timeout: 1
reconnect_attempts: 0
```

Disabling automatic command replay is mandatory:

- replaying `SET NX` after a lost response can misclassify a successfully issued key as a
  collision; and
- replaying `GETDEL` after a lost response cannot recover the consumed value and must not create
  ambiguous application behavior.

Action Cable does not use this pool. Rails' Redis adapter owns its subscriber and publisher
connections and may use its normal reconnection behavior.

Do not place a Redis client or pool on an Active Record model, controller, channel, Job, or browser
Runtime boundary.

## 6.3 Safe error reporting

`Coordination::EphemeralCoordination` does not translate all Redis errors globally. The caller owns
the semantic mapping:

- `CableTickets.issue` reports operation `issue`;
- `CableTickets.consume` reports operation `consume`;
- readiness reports the component status; and
- Action Cable adapter/broadcast failures remain handled by the existing notification boundary.

For issue and consume failures, call `Rails.error.report` as handled with fixed context:

```ruby
{ component: "ephemeral_coordination", operation: "issue" }
```

or:

```ruby
{ component: "ephemeral_coordination", operation: "consume" }
```

Never add the ticket, digest, key, Account, Redis command arguments, URL, or request to that
context.

# 7. Cable-Ticket Algorithms

## 7.1 Issue

Keep `Coordination::CableTickets.issue(account)` returning:

```ruby
[raw_ticket, expires_at]
```

Implement this exact sequence:

1. Repeat at most three times.
2. Generate 32 bytes with `SecureRandom.random_bytes(32)`.
3. Encode with the existing unpadded base64url protocol encoder.
4. Derive the namespaced SHA-256 key from the encoded ticket.
5. Execute one Redis `SET key, account.id, nx: true, ex: 60`.
6. On `true`, calculate the response expiry from the successful issue boundary and return the raw
   ticket plus `60.seconds.from_now`.
7. On `false`, discard the candidate and retry with fresh random bytes.
8. If three collisions occur, report a handled fixed
   `ticket_collision_budget_exhausted` operational failure without any candidate material and raise
   `AUTHENTICATION_UNAVAILABLE`, HTTP 503, retryable.

Define a private `Coordination::CableTickets::CollisionBudgetExhausted` error with a fixed,
credential-free message for the handled report. Do not expose it through the HTTP response.

The response timestamp may be slightly later than Redis's actual expiration because it is
calculated after `SET`; that is safe. Redis remains the acceptance authority and never keeps the
ticket longer than 60 seconds from the successful command.

Map `Redis::BaseError` from ticket storage to `AUTHENTICATION_UNAVAILABLE`, HTTP 503,
`retryable: true`. Do not rescue `NoMemoryError`, `SystemExit`, or unrelated application defects.

## 7.2 Consume

Keep `Coordination::CableTickets.consume(raw_ticket)` returning the authenticated `Account` or
raising `Coordination::OutcomeError`.

Implement this exact sequence:

1. Convert the input with `to_s`.
2. Require the complete string to match `\A[A-Za-z0-9_-]{43}\z`.
3. Decode it with the existing base64url decoder and require exactly 32 bytes.
4. Re-encode those bytes with the canonical unpadded encoder and require byte-for-byte equality
   with the input. This rejects non-canonical base64url values before a Redis command.
5. Derive the ticket key from the exact canonical encoded string.
6. Execute exactly one `GETDEL key`.
7. If Redis returns nil, raise `AUTHENTICATION_FAILED`, HTTP 401, not retryable.
8. Validate the returned value as a canonical lowercase UUID.
9. Load that exact Account with `Account.find_by(id:)`.
10. If the Account no longer exists, raise the same `AUTHENTICATION_FAILED` outcome.
11. Return the Account.

Malformed encoding, wrong length, missing keys, expiration, replay, invalid stored values, and
missing Accounts are indistinguishable to the caller. Do not issue a second Redis command to
distinguish them.

Map `Redis::BaseError` to `AUTHENTICATION_UNAVAILABLE`, HTTP 503, retryable. Although the Action
Cable connection turns both service outcomes into connection rejection, retain the distinction in
the service tests and sanitized error reporting.

No constant-time digest comparison is needed: the Redis key is the digest of a uniformly random
256-bit bearer credential, and `GETDEL` performs one exact key lookup. Do not add a second secret,
lookup UUID, bcrypt digest, HMAC key, or Lua script.

# 8. Action Cable Redis Adapter

Update `config/cable.yml`:

- development uses `adapter: redis`;
- production uses `adapter: redis`;
- test keeps `ENV.fetch("AWSM_CABLE_ADAPTER", "test")`;
- every Redis-adapter environment receives the validated `AWSM_REDIS_URL` and derived
  `channel_prefix`; and
- the synchronization proof sets `AWSM_CABLE_ADAPTER=redis`.

Delete the Solid Cable adapter configuration, `connects_to`, polling interval, and message
retention. Delete the Solid Cable schema/migration files and remove the production `cable`
database from `config/database.yml`.

Keep:

- the `/cable` mount;
- the existing allowed extension origins;
- `VaultChangesChannel.stream_for(vault)`;
- the `{vaultId, latestCursor}` payload;
- Account-to-Vault authorization;
- `VaultNotifier`'s handled failure boundary; and
- subscribe-before-fetch and one-minute polling behavior in the browser Runtime.

Do not make Redis publication part of the PostgreSQL transaction. Keep broadcasts after the
authoritative commit. Do not add an outbox, delivery retry Job, durable message stream, Redis
Stream, or acknowledgment.

# 9. Remove PostgreSQL Ephemeral Persistence

Delete:

- `app/models/cable_ticket.rb`;
- `app/jobs/delete_expired_cable_tickets_job.rb`;
- their dedicated model/Job specs;
- `Account#cable_tickets`;
- the `cable_tickets` table and constraint from the canonical initial migration and `db/schema.rb`;
- the recurring `delete_expired_cable_tickets` entry;
- `db/cable_schema.rb` and any Solid Cable migration directory;
- the production `cable` database entry; and
- the `solid_cable` gem.

Rewrite request and connection specs to inspect Redis instead of Active Record. Do not retain a
stub `CableTicket` constant, no-op cleanup Job, empty migration, deprecated association, or
PostgreSQL fallback.

This is a pre-release canonical replacement:

- do not add a migration that copies or drops deployed Cable tickets;
- do not read both PostgreSQL and Redis;
- do not preserve in-flight development tickets;
- do not bump a protocol version for the discarded ticket representation; and
- do not retain `uuid.secret` parsing.

Before final verification, explicitly recreate the named development/test/proof data owned by this
repository. Inspect the exact Compose project and volumes before deletion. Never use a broad
recursive deletion, wildcard volume removal, or an unresolved environment variable. Do not mutate
the hosted deployment or its databases.

# 10. Development, CI, and Image Configuration

## 10.1 Development Compose

In root `compose.yml`:

- add one `redis` service using the fixed image and non-persistent command from section 5.1;
- add its health check;
- add no Redis volume and no published port;
- preserve PostgreSQL's healthy startup gate, but use Redis only for start ordering; do not block
  Rails startup on Redis health because Redis-only loss is a supported degraded state;
- set `AWSM_REDIS_URL=redis://redis:6379/0`; and
- set `AWSM_REDIS_NAMESPACE=awsm:development`.

Update the root and Coordination Server READMEs so first startup, status inspection, log viewing,
restart, test, and reset commands include Redis where relevant. State clearly that Redis data is
deliberately disposable.

## 10.2 GitHub Actions

In the Coordination Server Rails job:

- add a Redis service using `redis:8.2.8-alpine`;
- publish it only to the job's loopback `6379`;
- add a `redis-cli ping` health check through service options;
- set `AWSM_REDIS_URL=redis://127.0.0.1:6379/0`; and
- set a CI-specific namespace.

The RSpec suite SHALL use the real service for ticket integration tests. Do not replace the proof
with a fake Redis implementation.

Keep the production-image job network-independent: building and running the OpenAPI verifier must
not require a live Redis connection. Production Rails boot, rather than image construction, owns
the required production URL check.

## 10.3 Production configuration without rollout

Make the application image and Rails production configuration Redis-ready, and document the
required secret and private service requirements. Do not add a real hostname, password, certificate,
host path, public port, or hosted topology to tracked files.

Do not execute Kamal, Docker, Compose, SSH, remote Rails, remote database, or remote Redis commands
against a deployed environment while implementing this plan. The hosted rollout is a separate
Roadmap authorization.

# 11. Two-Process Synchronization Proof

## 11.1 Compose topology

Extend `compose.sync-proof.yml` to contain:

- one PostgreSQL 17 service;
- one non-persistent Redis 8.2.8 service;
- one one-shot database-prepare service;
- `coordination-proof`, the existing primary Rails process;
- `coordination-proof-peer`, a second Rails process using the same PostgreSQL database, Redis
  service, Redis namespace, and opaque-byte test volume; and
- the existing independent Node 24 `replica-proof` client.

The prepare service runs `bin/rails db:prepare` once after PostgreSQL and Redis are healthy. Both
Rails processes wait for its successful completion before starting. Do not let two Rails processes
race schema preparation.

Both Rails processes set:

```text
AWSM_CABLE_ADAPTER=redis
AWSM_JOB_QUEUE_ADAPTER=async
AWSM_REDIS_URL=redis://redis-proof:6379/0
AWSM_REDIS_NAMESPACE=awsm:sync-proof
AWSM_SYNC_PROOF=true
```

Keep the existing proof-only origin/forgery behavior. Sharing the Disk test volume is acceptable
only in this same-host retained proof; it does not establish a supported shared immutable-byte
production Driver.

## 11.2 Black-box journey

Refactor the Node proof to accept:

```text
AWSM_PROOF_BASE_URL
AWSM_PROOF_CABLE_URL
```

Use the primary URL for control, upload, download, commit, change, and polling requests. For every
Cable connection:

1. request the one-use ticket from the primary URL;
2. connect the WebSocket to the peer URL;
3. wait for the subscription confirmation from the peer;
4. perform the authoritative mutation through the primary; and
5. observe the hint on the peer-hosted socket.

This single journey proves:

- a ticket issued by one Rails process is consumable by another;
- ticket storage is shared and Account-bound;
- `GETDEL` is process-independent;
- Redis Pub/Sub crosses Rails processes;
- the primary broadcast reaches the peer subscriber; and
- the existing HTTP polling path independently observes the same committed cursor.

Add a replay step that attempts to open a second connection with the consumed raw ticket and proves
it is rejected. Never print the ticket in proof errors.

Keep all existing synchronization, upload, commit, Generation, recovery, storage-relief retrieval,
and polling assertions. Do not weaken the proof into a Redis-only smoke test.

## 11.3 Browser proof isolation

The browser server-switching proof composes `compose.sync-proof.yml` with
`compose.browser-proof.yml`. Preserve its two logically independent Coordination Servers:

- the primary and its Cable peer use `awsm:sync-proof`; and
- `coordination-proof-two` uses `awsm:browser-proof:secondary`.

The second server may share the disposable Redis process, but it must not share the ticket or
Action Cable namespace. Update its environment even when its Action Cable adapter remains `async`
for browser-proof behavior.

Ensure `run-browser-proof.sh` still starts only the services it needs plus their dependencies. Do
not force the new peer process into unrelated browser E2E startup unless a browser test explicitly
needs it.

# 12. Required Automated Tests

## 12.1 Redis representation and ticket behavior

Using the real test Redis service, prove:

- issued tickets match exactly 43 base64url characters and decode to 32 bytes;
- the response expiry is present and no more than 60 seconds ahead;
- the only stored key is the namespaced SHA-256 key;
- neither key nor value contains the raw ticket;
- the value is the issuing Account UUID;
- the TTL is positive and at most 60 seconds;
- valid consumption returns the issuing Account and removes the key;
- a second consumption returns `AUTHENTICATION_FAILED`;
- malformed length, alphabet, and non-canonical base64url return `AUTHENTICATION_FAILED` without a
  Redis write;
- forcing the key to expire makes consumption fail;
- deleting the Account before consumption fails safely after removing the one-use key;
- two separate Redis clients consuming concurrently yield exactly one Account and one
  `AUTHENTICATION_FAILED`; and
- tickets for two Accounts cannot authorize one another.

Use a unique namespace per example or example group and delete only keys under that namespace in
test cleanup. Do not call `FLUSHALL` or `FLUSHDB` against a possibly shared developer service.

## 12.2 Failure behavior

Inject or target a deterministic unreachable Redis client and prove:

- ticket issue returns HTTP 503 with `AUTHENTICATION_UNAVAILABLE` and `retryable: true`;
- ticket consumption raises the same service outcome;
- the WebSocket connection rejects and still scrubs every retained URL surface;
- safe logs and error context contain none of the credential sentinels;
- `/ready` returns HTTP 200 and `degraded` when only Redis fails;
- `/ready` returns HTTP 503 when PostgreSQL or byte storage fails regardless of Redis;
- a committed Event remains committed when Redis broadcast fails; and
- subsequent HTTP change polling discovers that commit.

Do not make the entire RSpec process depend on stopping the shared test Redis container. Use
dependency injection or a dedicated unreachable URL/client for outage examples.

## 12.3 Action Cable and browser Runtime

Keep or add tests proving:

- only the one-use opaque ticket appears in the WebSocket URL;
- access and refresh credentials never appear there;
- the connection consumes before authorizing;
- Vault subscription remains Account-scoped;
- messages retain exactly `vaultId` and `latestCursor`;
- delayed, duplicate, invalid, and missing hints do not become trusted state transfer;
- Cable ticket HTTP failure creates no socket;
- the background's best-effort Cable connection catches that failure; and
- one-minute passive polling remains registered and operational.

No user-visible surface changes, so rendered visual inspection is not required for this plan.

# 13. Documentation Reconciliation

Update every current claim found by a repository-wide search, not only the documents named here.
At minimum:

- the OpenAPI Cable-ticket schema owns the new opaque wire shape;
- protocol documentation continues to define Action Cable as an advisory wake-up;
- Coordination Server architecture names Redis only as an implementation dependency while keeping
  the abstract ephemeral-coordination boundary clear;
- zero-knowledge documentation explicitly includes Redis in the server-visible metadata/logging
  budget;
- synchronization architecture preserves subscribe-before-fetch and polling sufficiency;
- testing strategy requires real Redis, atomic one-use concurrency, outage degradation, and
  cross-process hints;
- deployment and operations documents the non-persistent single-node repository topology and
  required production configuration without claiming hosted rollout;
- root and server READMEs include Redis in development prerequisites and commands;
- Plan 08 and its TDD evidence no longer claim the current proof uses only in-process Action Cable;
- Plan 09 and its TDD evidence no longer claim current Cable tickets use PostgreSQL or that Redis is
  only future work; and
- stale Solid Cable, Cable-ticket cleanup, cable database, `uuid.secret`, and Redis-candidate prose
  is removed or rewritten.

Do not turn architecture documents into Rails, Redis command, Docker, or gem manuals. Exact
implementation details belong in this plan and operational configuration.

# 14. Roadmap Reconciliation

When this plan is approved but not yet implemented, the existing Redis-backed coordination
initiative remains on the Roadmap with status `Approved` and may link to this plan.

When implementation and evidence are complete:

1. remove the completed Redis-backed coordination initiative entirely;
2. add **Hosted Redis Coordination Rollout** with status `Candidate`;
3. add **Highly Available Ephemeral Coordination** with status `Discovery`; and
4. reword Production Coordination Server Hardening so it references rather than duplicates these
   future boundaries.

The hosted-rollout entry SHALL cover:

- reinspection of the mutable hosted topology;
- private Redis networking and protected credentials;
- an exact application and Redis revision;
- deployment and rollback order;
- degraded-mode and recovery evidence;
- basic capacity and failure monitoring; and
- confirmation that no Redis port or credential becomes public.

The HA entry SHALL leave open:

- standalone replicas plus Sentinel versus a managed service;
- failover and split-brain behavior;
- connection discovery and TLS;
- acceptable ticket loss during failover;
- Action Cable resubscription evidence;
- multi-host capacity and fault injection;
- alerting and incident response; and
- whether persistence remains disabled in the selected provider topology.

Do not mark either follow-up Approved or implement either one under this plan.

# 15. Mandatory TDD and Evidence Workflow

Create:

```text
docs/plans/14-redis-backed-ephemeral-coordination-tdd-evidence.md
```

Record:

- date and commit;
- resolved Ruby dependency versions and verified licenses;
- exact Redis image tag;
- each RED test and why it failed before implementation;
- the corresponding GREEN implementation;
- REFACTOR steps;
- schema and stale-language audit results;
- real Redis representation, TTL, concurrency, replay, and outage evidence;
- the two-process ticket-issue/WebSocket-consume/broadcast journey;
- polling convergence independent of hints;
- readiness healthy/degraded/unavailable evidence;
- Compose and CI configuration validation;
- exact commands, exit statuses, and relevant sanitized results; and
- any deviation that received an explicit project-owner decision.

Do not include raw tickets, digests, Redis keys, Account IDs, URLs containing credentials, Redis
URLs, private deployment details, environment dumps, database contents, or user data.

Follow RED → GREEN → REFACTOR. Do not write passing assertions after implementation and present
them as prior RED evidence.

# 16. Cold-Start Implementation Order

An implementer starting cold SHALL proceed in this order:

1. Read repository `AGENTS.md`, any local override, this plan, its dependencies, and the current
   Roadmap entry completely.
2. Inspect `git status --short --ignored`; preserve unrelated user changes and ignored local state.
3. Create the Plan 14 TDD evidence document and record the clean baseline without secrets.
4. Add Redis to the Rails CI service and local/proof Compose so RED tests can reach a real server;
   validate Compose configuration before starting containers.
5. Add the Ruby client dependencies and application Redis boundary; record resolved licenses.
6. Write RED representation, TTL, atomic-consumption, replay, failure, and readiness tests.
7. Implement the opaque ticket schema, issue/consume algorithms, and stable Redis failure mapping.
8. Write RED cross-process Action Cable proof expectations.
9. Switch Action Cable to Redis and make the two-process proof pass.
10. Remove Solid Cable and PostgreSQL Cable-ticket persistence in one canonical replacement.
11. Update browser fixtures and best-effort Cable/polling tests.
12. Recreate only the explicit repository-owned pre-release development/test/proof data affected by
    the canonical schema replacement.
13. Run focused tests, then complete Rails, proof, extension, image, documentation, and stale-term
    verification.
14. Reconcile all canonical documentation and the Roadmap exactly as sections 13 and 14 require.
15. Format every changed file, rerun all affected checks, inspect the full diff, and record final
    evidence.

If the real Redis client cannot express atomic `GETDEL`, stop and investigate the resolved
dependency. Do not substitute `GET` followed by `DEL`. A minimal Lua compare/delete script is not
needed for the approved opaque-digest key design and must not be introduced without revising this
plan.

# 17. Required Verification Commands

Discover final commands from current manifests, but the completed implementation SHALL run at least:

```bash
docker compose config
docker compose -f compose.sync-proof.yml config
docker compose -f compose.sync-proof.yml -f compose.browser-proof.yml config
```

```bash
cd apps/coordination-server
bundle exec rspec
bin/rubocop
bin/bundler-audit
bin/brakeman --quiet --no-pager --exit-on-warn --exit-on-error
bin/ci
```

```bash
cd ../..
corepack pnpm test:sync-proof
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
```

```bash
docker build -f apps/coordination-server/Dockerfile -t awsm-coordination-server .
docker run --rm --entrypoint test awsm-coordination-server \
  -r /docs/specifications/protocol/http-api.openapi.yaml
```

Format and verify every changed Markdown, YAML, JSON, TypeScript, and JavaScript file with the
repository-pinned tools. At minimum:

```bash
corepack pnpm exec prettier --write <changed supported files>
corepack pnpm exec prettier --check <changed supported files>
git diff --check
```

Run final stale-language searches, adjusting patterns to cover actual changes:

```bash
rg -n \
  'CableTicket|cable_tickets|DeleteExpiredCableTicketsJob|solid_cable|Solid Cable|uuid\\.secret|ephemeral PostgreSQL|Redis.*Roadmap' \
  README.md ROADMAP.md docs apps compose*.yml .github
```

Every remaining match must describe a still-current contract, a deliberate test name, or retained
historical TDD evidence reconciled with the new canonical behavior.

# 18. Acceptance Criteria

This plan is complete only when:

- the public Cable ticket is one canonical 43-character, 256-bit opaque value;
- Redis stores only a namespaced SHA-256 key, Account UUID value, and TTL;
- `SET NX EX 60` issues and `GETDEL` consumes tickets exactly once;
- malformed, expired, replayed, and deleted-Account tickets fail identically;
- Redis failures return retryable `AUTHENTICATION_UNAVAILABLE` for HTTP issue requests;
- request URL scrubbing covers success and every failure path;
- production and development Action Cable use Redis rather than Solid Cable;
- two Rails processes prove cross-process ticket consumption and hint delivery;
- polling proves convergence independently of Redis hints;
- PostgreSQL contains no Cable-ticket table or model;
- Solid Cable code, gem, schema, and database configuration are absent;
- no cleanup Job or recurring ticket schedule remains;
- Redis is non-persistent, memory-bounded, private in repository Compose, and absent from backups;
- readiness reports Redis-only loss as degraded HTTP 200 and critical dependency loss as HTTP 503;
- local Compose, CI, retained proofs, and production configuration agree on the Redis contract;
- hosted deployment remains unchanged;
- all required documentation is canonical and the Roadmap contains only unresolved future work;
- all required checks pass without introduced warnings; and
- the evidence document contains sanitized RED, GREEN, REFACTOR, proof, and final verification
  records.

# 19. Fixed Decisions Checklist

Before reporting completion, verify every item:

- [x] Official Redis `8.2.8-alpine`, not Valkey, is used.
- [x] Redis remains a separate unmodified service under the approved licensing boundary.
- [x] One Redis service backs tickets and Action Cable Pub/Sub.
- [x] Redis persistence and data volumes are disabled.
- [x] Memory is bounded at 64 MiB with `noeviction`.
- [x] Ticket entropy is 256 bits and wire length is exactly 43 base64url characters.
- [x] Redis keys contain only the namespace and SHA-256 digest.
- [x] Ticket values contain only the Account UUID.
- [x] TTL is exactly 60 seconds at issue.
- [x] Consumption is one atomic `GETDEL`.
- [x] Application command replay is disabled.
- [x] PostgreSQL and Solid Cable ticket persistence are removed without compatibility.
- [x] Redis-only outage keeps HTTP polling ready and reports degraded state.
- [x] Two Rails processes prove shared issue/consume and Pub/Sub delivery.
- [x] Hosted rollout and HA remain deferred Roadmap work.
- [x] No remote host or deployment mutation occurred.
- [x] No secrets or credential-derived values entered code, docs, tests, logs, evidence, or commits.
