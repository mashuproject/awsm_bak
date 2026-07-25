# Coordination Server Contract and Two-Replica Proof

**Document:** `docs/plans/08-coordination-server-contract-and-two-replica-proof.md`
**Status:** Implemented foundation; Account and client boundaries superseded by Plan 09
**Owner:** Engineering
**Last Updated:** 2026-07-19
**Depends On:** `docs/plans/06-independent-artifact-vault-graph-and-selective-export.md`,
`docs/plans/07-complete-vault-package-import.md`, and the architecture and specifications
reconciled by this plan

Plan 09 replaced this plan's proof-only authentication, Account/Vault cardinality, and deferred
trusted-client assumptions in place. The opaque coordination, Generation, cursor, purge, and
black-box proof decisions remain historical implementation rationale; current behavior is owned by
Plan 09 and the reconciled specifications.

---

# 1. Purpose

This is the decision-complete implementation plan for the first AWSM Coordination Server contract
and a guarded, non-production Rails proof. The implementer is expected to begin from a cold
checkout with no prior conversation context. Do not reopen decisions recorded here.

The completed proof SHALL demonstrate that two independent synthetic replicas can use the Rails
application to:

1. attach one client-created Vault to an authenticated Account;
2. stage and durably verify opaque encrypted Objects without buffering a large Object in memory;
3. make one encrypted Event visible only after its complete declared Object dependency closure is
   durable;
4. discover accepted commits through a disposable per-Vault delivery cursor;
5. wake another replica through a content-free Action Cable hint and converge through canonical
   refetch;
6. construct and compare-and-swap activate a successor Vault Generation;
7. reject writes from a superseded Generation without attempting an automatic merge;
8. expose an explicit recovery view for superseded encrypted history during an advertised grace
   period;
9. expire superseded Generation snapshots after the server policy or purge them earlier through an
   explicitly confirmed Account action; and
10. preserve the zero-knowledge boundary throughout storage, transfer, diagnostics, testing, and
    failure recovery.

The resulting proof remains non-production. Plan 09 subsequently added real Account
authentication, Account-key enrollment, and the trusted extension Synchronization Service.
Production promotion remains blocked on Device trust and revocation, Account recovery, quotas and
abuse controls, a shared storage adapter, and independent security review.

The formal transport-independent synchronization specifications own protocol semantics. The
OpenAPI document introduced by this plan owns the exact HTTPS resource contract. Rails is one
reference implementation and SHALL NOT redefine the architecture in framework-specific terms.

---

# 2. Scope and Non-Goals

## 2.1 In scope

- one Account directly owning at most one synchronized Vault replica;
- real email/password-derived Account authentication through the public Account/session contract;
- client-generated stable Vault, Generation, Event, Object, request, upload, and Job identifiers;
- one canonical pre-release synchronization and HTTP contract at protocol version `1`;
- an OpenAPI-first JSON control plane and opaque binary transfer plane;
- strict request schemas, stable outcome identifiers, authorization, and idempotency;
- PostgreSQL operational metadata and ownership isolation;
- a custom immutable byte-storage interface and bounded-memory Disk implementation;
- resumable multipart upload, durable finalization, ranged download, and transfer tickets;
- opaque broad Object types needed by the proof: `Event`, `BundleDescriptor`, `Artifact`, and
  `VaultGeneration`;
- atomic visibility of one encrypted Event and its exact client-declared Object dependency closure;
- a server-assigned per-Vault delivery sequence that remains separate from Event replay order;
- paginated active-record enumeration and incremental change retrieval;
- generation-zero remote replica attachment;
- paged successor reachability submission and generation-plus-head compare-and-swap activation;
- explicit superseded-Generation recovery enumeration and download;
- advertised 90-day hosted retention with self-hosted configuration;
- asynchronous automatic expiry and Account-triggered purge of all superseded Generations;
- permanent opaque tombstones preventing purged Object identifier reuse or resurrection;
- content-free Action Cable wake-up hints;
- an isolated Docker Compose black-box scenario driven by two independent Node replicas;
- unit, request, integration, Job, storage, security, contract, and black-box tests;
- repository-root Rails CI integration; and
- complete architecture, specification, product, operations, testing, and Roadmap reconciliation.

## 2.2 Explicitly deferred

- verified email delivery, magic-link, passkey, OAuth, password change, Account Recovery Key, or
  recovery ceremonies;
- Device authentication, Device signing keys, signed requests, enrollment, approval, trust,
  revocation, wrapped Vault keys, or Device-specific authorization;
- shared Vaults, Account memberships, roles, invitations, organizations, tenants, or collaboration;
- billing, subscriptions, plans, storage quotas, reservations, and rate limiting;
- a trusted web Synchronization Service or web Account/recovery product;
- local Full and Selective Replica retention profiles, cache budgets, pinning, and eviction;
- automatic semantic merge or selective reapplication of unpublished stale work;
- automatic merging of a superseded Vault Generation;
- S3, MinIO, cloud-provider, or other shared byte-storage adapters;
- horizontal or multi-region production deployment;
- Backup, Restore, Import, Export, or Secure Scrub behavior;
- server-side Bundle, Event, or Vault semantic validation;
- server-side signature verification while Device trust remains deferred;
- compression negotiation, protocol negotiation, alternate transports, or compatibility paths; and
- preservation or migration of pre-release server development data.

## 2.3 Pre-release data and compatibility policy

The Rails database created by this plan is the sole canonical initial Coordination Server schema.
Use ordinary Rails migration files to construct that schema from an empty database, and commit the
resulting schema artifact. Do not write data-upgrade logic, old-schema detection, compatibility
aliases, dual reads, dual writes, fallback routes, successor names, or version negotiation.

Before verification, delete and recreate Coordination Server development and proof databases and
their opaque Disk storage. Do not preserve development uploads from the scaffold or an intermediate
implementation.

Protocol version `1` is permitted because HTTP messages cross an external persisted/exchanged
boundary. Internal Rails commands, service results, models, view objects, Jobs, and Cable wake-up
signals SHALL NOT gain speculative version fields or successor names.

---

# 3. Fixed Product and Architecture Decisions

## 3.1 Account and Vault ownership

- An Account directly owns zero or more Vaults.
- There is no Membership or Tenant abstraction in this slice.
- A Vault belongs to exactly one Account on the Coordination Server.
- Vault IDs remain client-generated, globally unique, stable, and opaque.
- The server never generates, rewrites, merges, or aliases a Vault ID.
- Duplicate human-readable Vault names are irrelevant because Vault names never cross the server
  boundary in plaintext.
- The same logical contract must work for the hosted service and a configurable self-hosted origin.

## 3.2 Authentication boundary

- HTTPS and Action Cable operations authorize an Account principal only.
- Device ID is not an authorization factor and is not stored as trusted audit metadata by this
  slice.
- The application exposes an `AccountAuthenticator` boundary that returns an Account principal and
  an optional recent-confirmation time.
- The proof adapter is enabled only in the isolated proof environment. Production fails closed when
  no production authenticator is configured.
- No public Account-signup, login, token-issuance, or credential-management endpoint is added.
- Purge requires an Account principal whose authentication was freshly confirmed within five
  minutes. Other synchronization actions require an authenticated Account but not fresh
  confirmation.

## 3.3 Server-visible metadata budget

The server MAY store or observe only:

- internal Account identifier;
- Vault, Generation, Event, Object, request, upload, transfer, and Job identifiers;
- broad Object type;
- encrypted-wrapper byte length and SHA-256 checksum;
- Event ordering timestamp and its sorted unique declared dependency Object IDs;
- active Generation number and root identifier;
- successor predecessor identifier and activation head cursor;
- per-Vault delivery cursor and record pagination position;
- lifecycle states and operational timestamps;
- recovery deadline, counts, and encrypted byte totals; and
- safe operational outcome identifiers and retry guidance.

The server MUST NOT receive or derive Vault names, titles, URLs, notes, tags, Event subtype,
Collection membership, Capture meaning, MIME meaning, Artifact Role, plaintext checksums, Search
tokens, Projections, AI inputs or outputs, unwrapped keys, or any decrypted field.

Object type is an accepted operational leak. Event subtype is not. `Event` is visible;
`BundleRegistered`, `VaultRenamed`, and other semantic Event types remain encrypted.

## 3.4 Delivery cursor and Event ordering

- Rails assigns one monotonically increasing unsigned `BIGINT` delivery sequence per Vault.
- One accepted Event closure receives one sequence. Vault attachment and Generation activation also
  receive a sequence because they change the remotely visible replica head.
- The delivery sequence answers only “what did this server accept after cursor N?”
- It is operational state, not authoritative Vault history, and never enters an Event, encrypted
  Object, Vault Package, Export, Backup, or local Projection.
- Clients continue to replay Events by the canonical authenticated Event order. The current Runtime
  order is ordering timestamp followed by Event ID.
- An offline Event created with an old timestamp but uploaded today receives a new delivery
  sequence and therefore cannot fall behind an already advanced delivery cursor.

## 3.5 Commit unit

- One atomic synchronization commit contains exactly one encrypted Event Object and its complete
  client-declared immutable Object dependency closure.
- The Event and any new dependencies are finalized as durable but invisible records before commit.
- Commit makes the Event and every newly introduced declared dependency visible together.
- Event batches and arbitrary generic record batches are deferred.
- The server validates that the declared dependency IDs exist, are durable, belong to the same
  Account/Vault and allowed Generation, and are sorted and unique.
- The server cannot decrypt the Event and therefore cannot prove that the declared list is
  semantically complete. Trusted clients remain responsible for decrypting, authenticating, and
  validating the exact Event/Object closure before replay.

## 3.6 Generation activation and garbage collection

- Generation zero is explicitly attached; it is never inferred.
- A successor Generation number must equal the active number plus one.
- Activation compares the active Generation ID, active Generation number, and observed delivery
  head cursor. Comparing only the predecessor root is insufficient because ordinary commits do not
  change that root.
- Any accepted commit after successor preflight causes `VAULT_HEAD_CHANGED`; the candidate remains
  inactive for explicit discard or reconstruction.
- Activation publishes a complete server-visible opaque retained Event/Object ID set. This is the
  accepted metadata leak required for safe remote garbage collection.
- A superseded Generation remains explicitly recoverable for the effective server grace period.
- Hosted AWSM defaults to 90 days. Self-hosted deployments may configure the policy, and clients can
  read the effective value from the service-policy resource.
- The Account may start a freshly confirmed, irreversible purge of all superseded Generations
  before their deadlines.
- Purge deletes only bytes no longer referenced by the active Generation, another retained
  superseded Generation, or an open successor candidate.
- Purged record identifiers remain as minimal tombstones and can never be reused or reuploaded.
- Vault Vacuum and remote purge are not Secure Scrub and cannot erase offline replicas, previously
  downloaded bytes, exports, backups, or in-flight client copies.

## 3.7 Transfer architecture

- Control operations use HTTPS JSON resource endpoints.
- Opaque bytes use provider-neutral transfer tickets.
- The first adapter resolves tickets to Rails Disk streaming endpoints.
- A future shared-storage adapter may resolve the same semantic ticket to signed multipart object
  storage operations without changing the synchronization protocol.
- Upload is resumable by numbered parts. Download supports HTTP byte ranges.
- Finalization verifies exact total byte length and SHA-256 before the record becomes durable.
- No Object payload is stored in PostgreSQL or loaded completely into Rails memory.
- Active Storage is not the AWSM Object model and SHALL NOT own Object identity or integrity.

## 3.8 Notification behavior

- Action Cable sends advisory wake-up hints only.
- A hint contains exactly `vaultId` and `latestCursor`.
- The hint is not trusted state transfer. The receiver refetches through the HTTP contract.
- Missed, duplicated, delayed, or reordered hints do not affect correctness.
- Polling the changes endpoint is always sufficient to converge.

## 3.9 Production gate

The proof may be implemented before the broader independent security review only because it uses a
proof-only Account principal and is explicitly non-production. Do not enable public deployment,
market the server as secure multi-device synchronization, or remove the production fail-closed gate
until the deferred authentication, Device trust, key recovery, quota/abuse, shared storage, client,
and review work is approved and complete.

## 3.10 Scaffold baseline

- At the start of this plan, `apps/coordination-server` contained Rails 8.1.3 on Ruby 3.4.4,
  PostgreSQL 17 development Compose, RSpec, `rspec-given`, Solid Queue, Solid Cable, and the
  generated full-stack Rails shell. Plan 14 later replaced the Cable adapter and ephemeral ticket
  persistence with Redis.
- Do not upgrade Rails, Ruby, PostgreSQL, the JavaScript strategy, or the test framework as part of
  this plan unless an implementation-blocking defect is demonstrated and separately approved.
- The scaffold has no domain routes, models, migrations, or schema. Treat it as an empty reference
  implementation rather than preserving generated placeholder behavior.
- Remove the scaffold-only arithmetic test after real Rails specs exist.
- The generated workflow below `apps/coordination-server/.github` is not repository-root CI. Move
  its useful checks into root workflow configuration and remove the nested workflow rather than
  maintaining two apparent CI definitions.

---

# 4. Canonical Terminology, Authority, and Security Invariants

Use the glossary's exact capitalization: Account, Vault, Vault Generation, Object, Event, Bundle,
Artifact, Runtime, Host, Service, Projection, Materialization, Replica, and Coordination Server.

Use these implementation terms consistently:

- **Vault replica record:** the Coordination Server's operational record that one Account has
  attached one Vault ID.
- **Opaque record:** PostgreSQL metadata plus immutable external ciphertext bytes for one Event or
  Object participating in synchronization.
- **Durable uncommitted record:** verified bytes that are not visible to synchronization readers.
- **Event closure commit:** one transaction publishing an Event and its declared dependencies.
- **Delivery change:** disposable server bookkeeping at one per-Vault cursor position.
- **Generation candidate:** an inactive server-side staging scope for one proposed successor.
- **Generation membership:** the opaque record IDs reachable from one server-visible Generation
  snapshot.
- **Recovery snapshot:** a superseded Generation membership retained temporarily for explicit
  download.
- **Transfer ticket:** a short-lived scoped capability for one upload part or download.
- **Purge Job:** durable non-cancellable deletion of superseded Generation memberships and newly
  unreferenced bytes.

Preserve these invariants:

1. The Coordination Server never requires plaintext or an unwrapped Vault key.
2. Every persistence read and write is scoped through the authenticated Account and named Vault.
3. Opaque record bytes are immutable after durable finalization.
4. Reusing an Object ID with different type, bytes, length, checksum, or Event metadata fails.
5. Durable uncommitted records are not returned by active enumeration, changes, download, or
   recovery endpoints.
6. An Event is never visible before every declared dependency is durable.
7. Database commit, not a notification, defines visibility.
8. Notifications publish only after the authoritative PostgreSQL transaction commits.
9. Clients verify every downloaded byte sequence against the advertised length and SHA-256.
10. Delivery order never replaces canonical Event replay order.
11. A stale Generation cannot append, activate, or resurrect omitted history.
12. Superseded history never enters the active download path.
13. Recovery download never merges history on the server.
14. Purge never removes a byte referenced by any active or retained membership.
15. Purge success is not recorded until the storage adapter confirms the bytes are absent.
16. A missing committed byte is an integrity incident, never an invitation to delete its metadata.
17. Logs, errors, metrics, Jobs, and test output contain no plaintext or keys.
18. Framework-generated IDs, Active Storage signed IDs, filenames, or paths never replace canonical
    client-generated identifiers.
19. Provisional Vaults, uploads, tickets, cursors, candidates, and Jobs are operational and never
    become authoritative Vault content.
20. No compatibility or negotiation behavior exists before a first-release decision.

---

# 5. HTTP and OpenAPI Contract

## 5.1 Authority split

Create `docs/specifications/protocol/http-api.openapi.yaml` as the primary contract for:

- paths and methods;
- authentication requirements;
- HTTP headers and status codes;
- JSON property names and types;
- query and path parameters;
- binary content types and range headers;
- stable outcome payloads; and
- reusable schemas, including the Cable wake-up payload.

The Markdown protocol specifications remain authoritative for transport-independent sequencing,
durability, fencing, recovery, zero-knowledge, and retry semantics. If OpenAPI and protocol prose
conflict, treat it as a design defect and update both atomically rather than choosing one silently.

Use OpenAPI 3.0.3. Hand-author and commit the document. Do not generate it from controllers or
generate controllers from it.

## 5.2 Common HTTP rules

- Mount the canonical control API under `/api` without a versioned route prefix.
- Require `Awsm-Protocol-Version: 1` on every `/api` request and return the same header on every
  `/api` response.
- Reject a missing or different value with `PROTOCOL_VERSION_UNSUPPORTED`. Do not negotiate.
- Require `Awsm-Request-ID: <lowercase UUID>` on every `/api` request, echo it as the same response
  header, and use it as `requestId` in an outcome envelope. It identifies one transport attempt and
  does not make the attempt idempotent.
- Require `Authorization: Bearer <credential>` on Account and control-plane resources.
- Require `Idempotency-Key: <lowercase UUID>` on every mutating control request.
- Use `application/json` with lower camel case property names for control messages.
- Use `application/octet-stream` for opaque transfer bodies.
- Use canonical lowercase UUID text for all current identifiers.
- Use unpadded base64url for 32-byte SHA-256 values.
- Use canonical UTC RFC 3339 timestamps with exactly millisecond precision.
- Encode counters as JSON integers between zero and JavaScript's safe integer maximum. PostgreSQL
  stores byte counters, cursors, and Generation numbers as non-negative `BIGINT` values.
- Require every opaque Object byte length to be at least one and no greater than the advertised
  maximum. Every upload has at least one part.
- Set `additionalProperties: false` on every pre-release JSON object schema.
- Do not include optional human-readable diagnostics in successful responses.

## 5.3 Outcome envelope

Every non-success JSON response uses:

```json
{
  "outcome": "OBJECT_CHECKSUM_MISMATCH",
  "retryable": false,
  "requestId": "01900000-0000-7000-8000-000000000001"
}
```

Only the OpenAPI-defined fields may appear. Retryable responses may add `retryAfterSeconds`.
Object-specific responses may add `relatedObjectId` only when the authenticated Account already has
authority to know that ID. A stale-Generation response adds `currentGenerationId`,
`currentGenerationNumber`, and `headCursor` so a client can fence its unpublished work. Clients
parse `outcome`, never diagnostic prose.

Define and map at least:

- `AUTHENTICATION_FAILED`;
- `AUTHENTICATION_UNAVAILABLE`;
- `RECENT_AUTHENTICATION_REQUIRED`;
- `AUTHORIZATION_DENIED`;
- `PROTOCOL_VERSION_UNSUPPORTED`;
- `REQUEST_INVALID`;
- `IDEMPOTENCY_CONFLICT`;
- `VAULT_ID_UNAVAILABLE`;
- `VAULT_NOT_FOUND`;
- `VAULT_NOT_READY`;
- `OBJECT_ID_CONFLICT`;
- `OBJECT_NOT_DURABLE`;
- `OBJECT_NOT_ACTIVE`;
- `OBJECT_CHECKSUM_MISMATCH`;
- `OBJECT_LENGTH_MISMATCH`;
- `UPLOAD_EXPIRED`;
- `UPLOAD_PART_CONFLICT`;
- `TRANSFER_TICKET_INVALID`;
- `DEPENDENCY_INVALID`;
- `VAULT_GENERATION_SUPERSEDED`;
- `VAULT_HEAD_CHANGED`;
- `GENERATION_CANDIDATE_CONFLICT`;
- `GENERATION_REACHABILITY_INVALID`;
- `RECOVERY_NOT_FOUND`;
- `RECOVERY_EXPIRED`;
- `PURGE_IN_PROGRESS`;
- `SERVER_BUSY`; and
- `STORAGE_UNAVAILABLE`.

Use 400 for malformed canonical input, 401 for missing/invalid Account authentication, 403 for
known but unauthorized Account scope or missing fresh confirmation, 404 for resources that must not
leak cross-Account existence, 409 for immutable identity/idempotency/fence conflicts, 410 for
expired uploads or recovery snapshots, 422 for structurally valid but invalid closure/reachability,
429 only after rate limiting is implemented, 503 for unavailable storage/authentication/service
dependencies, and 500 only for unexpected failures.

## 5.4 Contract enforcement

- Add the `committee` gem for OpenAPI request validation and contract assertions.
- Enable strict request validation for JSON control endpoints in every environment.
- Enable strict response validation in test and proof environments; do not buffer production binary
  streams for schema validation.
- Exclude opaque transfer bodies from JSON middleware parsing. Validate their path, ticket, headers,
  length, range, and checksum explicitly in the transfer controller/service.
- Load the OpenAPI document with strict reference validation during application boot and CI.
- Controller code still enforces authorization, immutability, fencing, and transactional
  invariants; OpenAPI validation is not a security substitute.

---

# 6. Public Resource Contract

The exact JSON schemas and HTTP statuses belong in OpenAPI. Implement the following resources and no
additional product endpoints in this slice.

## 6.1 Service policy

`GET /api/service-policy`

Return the effective:

- recovery retention days;
- upload staging expiry hours;
- transfer ticket lifetime seconds;
- default upload part size bytes;
- maximum upload part count;
- maximum supported Object byte length;
- maximum changes page size;
- maximum record page size; and
- notification transport availability.

This resource reports policy; it does not negotiate a different protocol. The hosted default is 90
recovery days, 24 staging hours, 900 ticket seconds, 8 MiB parts, 10,000 parts, and 500 records per
page. Self-host configuration changes only advertised operational limits, never message schemas or
semantics.

## 6.2 Provisional Vault attachment

`POST /api/vaults`

The request names:

- client-generated `vaultId`;
- `generationId` equal to the encrypted Generation-zero Object ID;
- `generationNumber: 0`;
- Generation Object type, byte length, and SHA-256; and
- canonical request ID through `Idempotency-Key`.

The server creates an Account-owned `Provisional` Vault replica and a Generation-zero upload
resource. It does not expose the Vault through active enumeration or changes. Return the Vault
resource plus the upload resource and a fresh transfer ticket.

`POST /api/vaults/{vaultId}/complete`

Require the Generation-zero Object to be durably finalized. Atomically:

1. mark the Vault `Active`;
2. create active Generation zero;
3. add the Generation Object to its membership;
4. assign the first Vault delivery sequence;
5. record `GenerationActivated`; and
6. publish a Cable hint after commit.

An abandoned provisional Vault and its bytes expire with staging policy. Repeating either request
with the same idempotency key and byte-identical request returns the same logical resource with a
new unexpired transfer ticket when needed. The same Vault ID with any conflicting Account or
metadata returns `VAULT_ID_UNAVAILABLE` without revealing the other owner.

`GET /api/vaults/{vaultId}` returns the authenticated Account's operational replica state, active
Generation identity, current head cursor, and safe byte/count totals. It never returns plaintext
Vault metadata.

## 6.3 Upload resources and transfer tickets

`POST /api/vaults/{vaultId}/uploads`

The request names:

- `objectId`;
- `objectType`;
- `byteLength`;
- `sha256`;
- `targetGenerationId`; and
- for `Event` only, `orderingTimestamp` and a lexically sorted unique
  `dependencyObjectIds` array.

Reject Event metadata on non-Event types and reject an Event without it. Event subtype is never a
field. The target is either the active Generation or the Account's one open candidate.

Every dependency ID must already resolve to an `Uploading`, `DurableUncommitted`, or `Committed`
opaque record in the same Account, Vault, and eligible target scope when the Event upload is
created. Return `DEPENDENCY_INVALID` instead of creating placeholder records. Clients therefore
begin dependency uploads before beginning the Event upload, although dependency byte finalization
may complete in any order before commit.

If the same Vault already has a durable or committed record with exactly matching immutable
metadata, return `AlreadyDurable` and do not create new bytes. Any difference returns
`OBJECT_ID_CONFLICT`. A purged tombstone always returns `OBJECT_ID_CONFLICT`.

For a new record, return an upload resource containing:

- `uploadId` and state;
- expected metadata;
- server-selected `partSizeBytes` and `partCount`;
- received part numbers;
- staging expiry; and
- a short-lived ticket describing the Disk part URL template, method, and required headers.

`GET /api/vaults/{vaultId}/uploads/{uploadId}` returns resumable status.

`POST /api/vaults/{vaultId}/uploads/{uploadId}/ticket` issues a fresh ticket without changing the
upload.

`PUT /api/transfers/{ticket}/parts/{partNumber}` accepts one opaque part. Require exact
`Content-Length` and `Content-SHA256`. Every non-final part has the advertised part size; the final
part has the exact remainder. A repeated part with the same checksum and length succeeds; a
different repeated part returns `UPLOAD_PART_CONFLICT`.

`POST /api/vaults/{vaultId}/uploads/{uploadId}/complete` requires every part, streams them in order
through whole-Object SHA-256 and length verification, fsyncs and atomically installs the staged
immutable byte file, and marks the record `DurableUncommitted`. A failure leaves the record
invisible and safely retryable or expirable.

## 6.4 One-Event closure commit

`POST /api/vaults/{vaultId}/commits`

The request names:

- active `generationId` and `generationNumber`;
- finalized `eventObjectId`; and
- the exact sorted unique `dependencyObjectIds` already bound to that Event upload.

Under a row lock on the Vault replica, recheck Account ownership and the active Generation. Require
the Event and every dependency to be durable, non-purged, in the same Vault, and eligible for the
active Generation. Reject missing, extra, reordered, duplicate, cross-Vault, candidate-only, or
superseded dependencies.

In one PostgreSQL transaction:

1. mark newly introduced closure records committed;
2. add the Event and all closure records to active Generation membership;
3. create the immutable Event commit record;
4. increment and assign the next delivery sequence;
5. create the `EventCommitted` delivery change; and
6. persist the idempotent result.

After commit, broadcast the new head cursor. Return the Event ID, Generation identity, accepted
dependency IDs, assigned cursor, and `durabilityAcknowledged: true`. This acknowledgement permits a
trusted client retention policy to consider local eviction later; the server itself never commands
eviction.

Repeating the same Event closure or idempotency key returns the original cursor. Any changed body
for the same Event ID or idempotency key returns a conflict.

## 6.5 Active enumeration, changes, and download

`GET /api/vaults/{vaultId}/records`

Return active Generation record metadata in lexical Object ID order with opaque pagination. This is
the full-replica bootstrap path. Never return payload bytes inline.

`GET /api/vaults/{vaultId}/changes?after={cursor}&limit={limit}`

Capture one response snapshot cursor, return changes strictly after `after` and no later than that
snapshot, and return `nextCursor`, `snapshotCursor`, and `hasMore`. Page size defaults to 100 and is
capped at 500. Changes name only safe record metadata and declared closure IDs.

An optional client `generationId` query parameter may assert the caller's expected active
Generation. If it is superseded, return `VAULT_GENERATION_SUPERSEDED` with the current Generation ID,
number, and head cursor so the client can quarantine local unpublished work and begin explicit
reconciliation. Do not merge or silently reset client data.

`POST /api/vaults/{vaultId}/records/{objectId}/downloads`

Allow only active Generation membership. Return expected immutable metadata and a short-lived
download ticket.

`GET /api/transfers/{ticket}` streams bytes and implements a single valid HTTP `Range` request.
Return `Accept-Ranges`, `Content-Length`, `Content-Range` where applicable, `ETag` derived from the
ciphertext SHA-256, and `application/octet-stream`. Reject multipart ranges. Clients must verify the
complete reconstructed length and SHA-256 before accepting an Object.

## 6.6 Successor Generation candidates

`POST /api/vaults/{vaultId}/generation-candidates`

Allow one open candidate per Vault. Require:

- client-generated successor `generationId`;
- `generationNumber` exactly active number plus one;
- active `predecessorGenerationId`;
- observed active `headCursor`;
- successor Generation Object metadata; and
- an idempotency key.

Create an inactive candidate and its Generation Object upload. Candidate records are staged through
the normal upload API with the candidate Generation as target. They remain invisible until
activation.

`PUT /api/vaults/{vaultId}/generation-candidates/{generationId}/retained-pages/{pageNumber}`

Accept at most 1,000 lexically sorted unique record IDs per page. Page numbers begin at zero.
Adjacent pages must preserve global lexical order and may not overlap. Repeating the same page
succeeds; changing an accepted page conflicts.

`POST /api/vaults/{vaultId}/generation-candidates/{generationId}/seal`

Require `pageCount`, `recordCount`, and SHA-256 over the UTF-8 sequence formed by each globally
sorted retained UUID followed by `\n`. Validate every ID as an active record or durable record
staged for this candidate. Automatically include the successor Generation Object itself; the client
does not list it. Require every staged Event's declared dependencies to appear in the candidate
membership. Mark the candidate sealed and immutable.

A successor may declare zero retained records other than its automatically included Generation
Object. It then submits no pages, uses `pageCount: 0`, `recordCount: 0`, and supplies SHA-256 of the
empty byte sequence.

`POST /api/vaults/{vaultId}/generation-candidates/{generationId}/activate`

Require the expected predecessor ID, predecessor number, and preflight head cursor. Under the Vault
row lock, compare all three with current state. Then atomically:

1. commit eligible candidate records;
2. create the successor membership from the sealed set plus Generation Object;
3. mark the predecessor `Superseded` with `supersededAt` and `purgeAfter`;
4. activate the successor;
5. update the Vault head;
6. assign one new delivery sequence;
7. record `GenerationActivated`; and
8. persist the idempotent result.

Broadcast only after commit. The server validates opaque membership existence and declared Event
dependencies but cannot compare the plaintext retained set with the encrypted Generation manifest.

`DELETE /api/vaults/{vaultId}/generation-candidates/{generationId}` discards only an inactive
candidate. Remove candidate-only staged records asynchronously when no other scope references them.
An activated Generation cannot be deleted through this endpoint.

## 6.7 Recovery and purge

`GET /api/vaults/{vaultId}/recoveries`

List superseded Generation IDs/numbers, predecessor/successor relationship, `supersededAt`,
`purgeAfter`, state, record count, and encrypted byte total. Do not return record IDs in this list.

`GET /api/vaults/{vaultId}/recoveries/{generationId}/records`

Enumerate that exact retained membership with lexical pagination while the snapshot is recoverable.
This path is explicit recovery access and never changes the active Generation.

`POST /api/vaults/{vaultId}/recoveries/{generationId}/records/{objectId}/downloads`

Issue a recovery-scoped ticket only while the Generation is `Superseded` and before purge begins.
Normal active download remains forbidden for retired-only records.

`POST /api/vaults/{vaultId}/purges`

Require fresh Account confirmation. If no purge is active, create one durable, non-cancellable Job
covering every currently superseded Generation and return `202 Accepted` plus the Job resource.
Mark those snapshots `Purging` and deny new recovery tickets. Repeating the same request is
idempotent. A different request while one is active returns `PURGE_IN_PROGRESS`.

`GET /api/vaults/{vaultId}/purges/{purgeId}` returns stage, Generation count, record count,
processed bytes, total bytes, retry count, and terminal outcome. These are operational counters and
must not expose record IDs.

Automatic expiry creates the same Job type without Account interaction when `purgeAfter` passes.
The Job removes targeted Generation memberships, determines newly unreferenced records, deletes and
verifies byte absence, and only then converts metadata to permanent tombstones. A partial failure
remains non-terminal and resumes idempotently.

## 6.8 Action Cable wake-up channel

Mount Action Cable at `/cable`. Define one `VaultChangesChannel` subscription naming `vaultId`.
Authorize the connection Account and Vault ownership before streaming. The proof-only connection
may accept its isolated credential through a filtered query parameter because standard WebSocket
clients cannot set the HTTP bearer header; this path must be unavailable outside the proof
environment.

Publish exactly:

```json
{
  "vaultId": "01900000-0000-7000-8000-000000000001",
  "latestCursor": 42
}
```

Define this object under OpenAPI components with no extra properties. Send it after Vault
completion, Event commit, and Generation activation. Purge and upload progress do not change active
Vault history and do not publish this hint.

---

# 7. PostgreSQL Persistence Contract

Use PostgreSQL UUID primary keys for server-owned operational rows and UUID columns for canonical
client IDs. Use foreign keys, unique indexes, non-null constraints, enum/check constraints, and
non-negative counter checks as defense in depth. Do not rely on Rails validation alone.

Represent lifecycle states and broad Object types as string columns with explicit PostgreSQL CHECK
constraints. Do not use PostgreSQL enum types or Rails integer-backed enums; the committed schema
must expose readable canonical values and reject unknown values at the database boundary.

## 7.1 Accounts and Vault replicas

`accounts`:

- internal UUID primary key;
- created/updated timestamps.

The canonical Account row stores normalized email, a BCrypt digest of the client-derived
authentication secret, public Account KDF parameters, and the authenticated Account Encryption Key
envelope. Sessions and rotating access/refresh credentials use digest-only rows. The server never
receives the raw password or Account Encryption Key.

`vault_replicas`:

- internal UUID primary key;
- globally unique client `vault_id`;
- Account foreign key;
- state: `Provisional` or `Active`;
- active Generation foreign key when Active;
- non-negative active Generation number;
- non-negative `head_cursor`, starting at zero before first activation;
- provisional expiry; and
- timestamps.

All Vault queries begin from `current_account.vault_replicas`; never fetch by globally unique
Vault ID and authorize afterward.

## 7.2 Opaque records and dependencies

`opaque_records`:

- internal UUID primary key;
- globally unique client `object_id`;
- Vault replica foreign key;
- Object type enum/check;
- non-negative `byte_length` as `BIGINT`;
- exact 32-byte ciphertext SHA-256 as `BYTEA`;
- random server storage key, nullable only after purge;
- state: `Uploading`, `DurableUncommitted`, `Committed`, or `Purged`;
- target active/candidate Generation ID;
- Event ordering timestamp only for Event;
- durable, committed, and purged timestamps; and
- created/updated timestamps.

Keep the `opaque_records` row after purge. Clear its storage key and sensitive transfer state, retain
Vault ID, Object ID, broad type, byte length, ciphertext checksum, and purge timestamp, and reject
all future upload attempts for that ID.

`record_dependencies`:

- Event opaque-record foreign key;
- dependency opaque-record foreign key;
- zero-based ordinal;
- unique Event/ordinal and Event/dependency constraints.

Persist the canonical sorted declaration so commit can compare the request exactly without parsing
ciphertext.

## 7.3 Uploads, parts, and tickets

`uploads` stores upload ID, record foreign key, state, part size/count, expiry, observed total
length/checksum, last activity, and terminal timestamp.

`upload_parts` stores upload, part number, exact byte length, SHA-256, random staging storage key,
and received timestamp. Enforce unique upload/part number.

`transfer_tickets` stores only a SHA-256 digest of the random bearer token, Account/Vault scope,
upload part or download record scope, optional recovery Generation, expiry, revoked/consumed state,
and timestamps. Never persist or log a raw ticket. Upload-part tickets may be reused idempotently for
their one part until expiry; download tickets remain valid for ranged resume until expiry unless
purge revokes them.

## 7.4 Generations and membership

`vault_generations` stores:

- globally unique client Generation ID;
- Vault foreign key;
- non-negative Generation number unique within Vault;
- predecessor Generation foreign key when nonzero;
- Generation Object foreign key;
- state: `Candidate`, `Active`, `Superseded`, `Purging`, or `Purged`;
- candidate baseline cursor;
- sealed page/record counts and reachability SHA-256;
- activated, superseded, purge-after, purge-started, and purged timestamps; and
- timestamps.

Enforce exactly one Active Generation and at most one Candidate per Vault through partial unique
indexes.

`generation_reachability_pages` stores candidate, page number, entry count, page checksum, and
acceptance timestamp with a unique candidate/page constraint.

`generation_reachability_entries` stores candidate, page, zero-based ordinal within the page, and
opaque-record foreign key. Enforce unique page/ordinal and unique candidate/record constraints.
Global order is page number followed by ordinal. Do not store one giant JSON array or retain the raw
request body.

`generation_memberships` stores Generation and opaque-record foreign keys with a unique pair. This
table is the server's explicit recovery/GC reachability source. It is operational replica metadata,
not authoritative Vault content.

## 7.5 Commits and delivery changes

`event_commits` stores Vault, Generation, Event record, assigned cursor, immutable request digest,
and committed timestamp. Event record and Vault/cursor are independently unique.

`delivery_changes` stores Vault, non-negative cursor, kind `EventCommitted` or
`GenerationActivated`, Generation, optional Event commit, and timestamp. Enforce unique
Vault/cursor. Retain delivery metadata in this proof even after payload purge so an old cursor can
observe supersession rather than silently missing it.

## 7.6 Idempotency and purge Jobs

`idempotency_records` stores Account, canonical operation name, idempotency UUID, HTTP method/path,
SHA-256 of the exact request body bytes, logical resource/result reference, status, and timestamps.
Enforce unique Account/operation/key. A replay reconstructs fresh ephemeral transfer tickets rather
than persisting an expired ticket response.

`purge_jobs` stores Vault, client-visible purge ID, state `Pending`, `Running`, `Succeeded`, or
`FailedRetryable`, stage, automatic/manual reason, counters, retry count, safe error outcome, fresh
confirmation time for manual Jobs, and timestamps. Solid Queue schedules execution, but this domain
row owns resumable user-visible status.

`purge_job_generations` snapshots the exact targeted superseded Generations when the Job is created.
Later successor activations are not silently added to an already running manual Job.

---

# 8. Application and Transaction Boundaries

## 8.1 Layering

Keep controllers and channels thin. Use explicit application Services for:

- policy reporting;
- Account authentication and recent-confirmation checks;
- provisional Vault attachment and completion;
- upload creation, part receipt, finalization, and cleanup;
- Event closure commit;
- active enumeration, change paging, and download authorization;
- Generation candidate creation, page acceptance, sealing, activation, and discard;
- recovery enumeration and ticket creation;
- purge creation, execution, and restart reconciliation; and
- post-commit notification.

Services operate on typed input objects and stable outcomes. Do not parse controller exception text
or Active Record validation messages into protocol behavior.

## 8.2 Storage/database visibility boundary

PostgreSQL and external storage cannot share one transaction. Use this ordering:

1. stream and verify bytes into an uncommitted storage key;
2. fsync the file and containing directory;
3. atomically rename it to its immutable staged storage key;
4. commit `DurableUncommitted` metadata in PostgreSQL;
5. later publish it only through Event commit or Generation activation; and
6. clean an orphan staged file after expiry when no committed metadata references it.

A crash before step 4 leaves an orphan storage file safe to remove. A crash after step 4 leaves an
invisible durable record safe to resume or expire. A committed record with missing or corrupt bytes
is an integrity failure: fail readiness and reads, emit only a safe operational alert, and never
silently remove the row or pretend the Object was unavailable.

## 8.3 Concurrency

- Lock the Vault replica row for Vault completion, Event commit, Generation activation, and purge
  snapshot creation.
- Use the locked head cursor as the sole source for the next sequence.
- Allow concurrent uploads because they are invisible.
- Allow concurrent Event commits in request arrival order; the Vault lock serializes cursor
  assignment but does not define Event replay order.
- Do not hold a PostgreSQL transaction open while streaming Object bytes.
- Do not hold a database lock while broadcasting Cable or deleting large files.
- Generation activation performs membership and head changes in one database transaction. Byte
  cleanup happens later through a Job.

## 8.4 Notification timing

Enqueue/broadcast the Action Cable hint only from an `after_commit` application boundary using the
committed cursor. A notification failure never rolls back an accepted commit. Polling remains the
recovery path.

## 8.5 Idempotency

For each mutating control request, hash HTTP method, canonical path, and exact body bytes. Under an
idempotency row lock:

- a new key begins the operation;
- the same key and digest returns the same logical result;
- the same key with a different digest returns `IDEMPOTENCY_CONFLICT`; and
- a crashed in-progress operation is resolved from the domain resource state rather than rerun
  blindly.

Natural immutable identifiers provide additional safety but do not replace the HTTP idempotency
contract.

---

# 9. Disk Storage Driver

Define an AWSM-owned `OpaqueByteStorage` interface with operations equivalent to:

- create/write/read/delete a staged upload part;
- assemble and verify parts into one immutable staged Object;
- open a full or ranged Object stream;
- test exact Object existence and metadata;
- delete an immutable Object; and
- enumerate only adapter-owned orphan staging keys for reconciliation.

The Disk implementation SHALL:

- store bytes below a configured non-public root;
- use random server storage keys rather than Account, Vault, Object, or filename text in paths;
- validate every resolved path remains below that root;
- create files with least-privilege permissions;
- stream with buffers no larger than 1 MiB;
- use 8 MiB default upload parts while permitting policy configuration;
- compute part and whole-Object SHA-256 incrementally;
- fsync completed files and directories before durable acknowledgement;
- use same-filesystem atomic rename for staged installation;
- reject symlinks and non-regular files;
- support one byte range without reading preceding bytes;
- make repeated deletion idempotent;
- verify absence before reporting purge success; and
- exclude raw bytes, paths, and transfer tokens from logs.

Do not create Active Storage Blob or Attachment rows. If Active Storage remains loaded for the
future Rails shell, it is unrelated and must not be referenced by Coordination Server domain code.

The adapter boundary must be capable of representing future multipart direct-upload and signed
download tickets, but do not implement or retain provider-specific branches in this proof.

---

# 10. Retention, Recovery, and Purge State Machines

## 10.1 Effective policy

Read policy from validated environment configuration with these canonical defaults:

- `AWSM_RECOVERY_RETENTION_DAYS=90`;
- `AWSM_UPLOAD_STAGING_EXPIRY_HOURS=24`;
- `AWSM_TRANSFER_TICKET_LIFETIME_SECONDS=900`;
- `AWSM_UPLOAD_PART_SIZE_BYTES=8388608`;
- `AWSM_MAX_UPLOAD_PARTS=10000`.

Accept a self-hosted recovery duration from zero through 36,500 days. Zero makes a superseded
Generation immediately eligible for automatic purge. Reject invalid configuration at boot; do not
silently substitute another value. Always advertise the effective policy.

## 10.2 Automatic expiry

Run a recurring Solid Queue dispatcher that finds superseded Generations whose `purgeAfter` has
passed and are not already targeted. Create one idempotent automatic purge Job per Vault batch. The
Job uses database checkpoints and may resume after process or storage failure.

## 10.3 Purge stages

Use these durable stages:

1. `Snapshot` — lock the Vault, snapshot target superseded Generations, mark them `Purging`, revoke
   unconsumed recovery tickets, and compute counters.
2. `Detach` — remove only targeted Generation memberships in bounded database batches.
3. `Analyze` — select records with no Active, Candidate, or remaining Superseded membership.
4. `DeleteBytes` — delete each selected storage key idempotently and verify absence.
5. `Tombstone` — clear storage keys, mark records `Purged`, remove upload/part metadata, and retain
   minimal immutable identity metadata.
6. `Complete` — mark Generations `Purged` and the Job `Succeeded` only when every selected byte is
   absent and every tombstone committed.

Failure in any stage persists `FailedRetryable`, safe outcome, counters, and checkpoint. Retry
continues from the checkpoint. Do not support cancellation after `Snapshot`; some bytes may already
be gone.

## 10.4 Recovery boundary

Recovery endpoints expose only the exact superseded Generation selected by the Account. They do not
change the active head, create Events, or copy records into another Generation. A trusted future
client may download these encrypted bytes into an isolated recovery/import workflow. This proof
only demonstrates complete opaque enumeration and verified download.

Once a Generation is `Purging` or `Purged`, new recovery enumeration and tickets return
`RECOVERY_EXPIRED`. A ticket already being consumed may finish before storage deletion; remote purge
must never be described as guaranteed erasure of a client or already transferred copy.

---

# 11. Account Authentication and Test Isolation

The black-box proof signs up and logs in an ordinary test Account through the public Account and
session resources. `AWSM_SYNC_PROOF=true` may select isolated test adapters, but never an alternate
authentication path.

Requirements:

- every environment uses the same Account/session authenticator;
- Rails fails closed when Account or session credentials are absent or invalid;
- raw bearer credentials and Cable query credentials are filtered from logs and exceptions;
- proof Accounts are created through the public Account endpoint;
- both synthetic replicas log in to the same Account but maintain independent local state;
- cross-Account tests use a second credential and prove non-disclosure; and
- no Account secret is committed. A fixed non-secret Compose-only synthetic-parameter HMAC key may be
  supplied through the isolated proof file and must be clearly labeled test-only.

---

# 12. Docker Compose Black-Box Proof

Add a separate `compose.sync-proof.yml` with a distinct project name and isolated volumes. Do not
reuse the developer's PostgreSQL or storage volume.

Services:

1. `postgres-proof`
   - PostgreSQL with an isolated proof database and health check.
2. `redis-proof`
   - non-persistent Redis for shared one-use tickets and Action Cable Pub/Sub.
3. `coordination-proof-prepare`
   - prepares the isolated canonical database once before either Rails process starts.
4. `coordination-proof` and `coordination-proof-peer`
   - Rails in test/proof mode;
   - share PostgreSQL, Redis, namespace, Disk proof volume, and ordinary Account authentication;
   - prove primary issue/broadcast and peer consume/subscription boundaries; and
   - expose health/readiness only to the Compose network.
5. `replica-proof`
   - a pinned `node:24-bookworm-slim` container;
   - waits for Rails readiness;
   - runs one dependency-light `.mjs` black-box program using platform `fetch` and `WebSocket`;
   - imports no Rails application code and reads no database or storage files; and
   - exits nonzero on any mismatch.

The Node program models two independent replica states and exercises:

1. Account-authenticated service policy fetch;
2. provisional Vault attachment and multipart Generation-zero upload;
3. Vault completion and initial Cable hint;
4. interrupted multipart Artifact upload and status-based resume;
5. descriptor and Event upload;
6. rejection of commit before one dependency is durable;
7. successful one-Event closure commit;
8. second-replica wake-up, change fetch, active enumeration, ranged download, byte reassembly, and
   SHA-256 verification;
9. duplicate upload and duplicate commit idempotency;
10. a late offline Event whose ordering timestamp predates the current cursor but whose delivery
    sequence remains discoverable;
11. successor candidate creation, paged retained set, sealing, and activation;
12. a concurrent active commit causing activation to fail with `VAULT_HEAD_CHANGED`;
13. rebuilt candidate activation and stale predecessor write rejection;
14. explicit predecessor recovery enumeration and download;
15. freshly confirmed purge-all initiation and durable completion; and
16. denial of recovery after purge while active shared records remain downloadable.

Also run a lost-notification variant in which the second replica disconnects Cable, changes occur,
and polling alone reaches the identical final active record set.

Provide one documented command that builds, runs, returns the proof-client exit code, and tears down
the isolated project and volumes. Cleanup may be destructive only to the explicitly named proof
project and never the development Compose project.

---

# 13. Error, Privacy, and Operational Behavior

## 13.1 Request safety

- Apply bounded request header and JSON body limits before parsing.
- Reject unknown types, fields, malformed UUIDs, invalid timestamps, unsafe integers, invalid
  checksums, unsorted/duplicate lists, and out-of-range page/part numbers.
- Do not deserialize arbitrary Ruby objects.
- Never use client identifiers as SQL fragments, filesystem paths, channel names without scoped
  encoding, or log labels without filtering.
- Use constant-time comparison for bearer and transfer-ticket digests.

## 13.2 Diagnostic allowlist

Logs and structured metrics MAY include:

- Rails request ID;
- internal Account/Vault row IDs where operationally necessary;
- operation name;
- safe outcome identifier;
- HTTP status;
- broad Object type;
- byte and record counters;
- duration and retry count; and
- queue/storage dependency health.

They MUST NOT include:

- bearer or transfer credentials;
- raw request/response bodies;
- Object ciphertext;
- plaintext or plaintext-derived metadata;
- Vault names, titles, URLs, notes, tags, Event subtype, Artifact Role, or filenames;
- checksums of plaintext;
- keys or encrypted key material; or
- full recovery membership lists.

Opaque client IDs and ciphertext checksums may appear only in scoped debugging disabled by default;
normal production-style logs use request and internal operational IDs.

## 13.3 Readiness and integrity

Keep `/up` as liveness. Add a readiness endpoint that checks PostgreSQL, configured byte-storage
root, and required Job/Cable dependencies without reading Vault content. A detected committed-byte
mismatch makes readiness fail and emits a safe integrity outcome.

## 13.4 No product UI

Do not add root, Account, Vault, upload, recovery, purge, Swagger, or administration pages. The
existing Rails layout and generated PWA placeholders remain unused. Because this slice changes no
user-visible UI, rendered screenshot inspection is not required.

---

# 14. Documentation Reconciliation

Documentation changes are part of implementation, not optional cleanup. Reconcile all affected
consumers in the same work:

1. Add Account to the normative glossary and define direct Account-owned Vaults for this canonical
   slice. Keep future shared contexts explicitly future.
2. Update zero-knowledge and security documents with the exact server-visible metadata budget,
   Account-only proof boundary, recovery leak, and production gate.
3. Replace stale Coordination Server `Tenant`, `Block`, mutable registry, Bundle-to-Block mapping,
   OAuth/passkey implementation claims, and server-side content-validation language with opaque
   Object records, Account ownership, declared closures, and adapter boundaries.
4. Replace synchronization drafts that conflate server delivery order with Event replay order.
5. Specify the independent per-Vault delivery cursor, one-Event closure commit, active enumeration,
   Generation-plus-head CAS, explicit recovery, and purge semantics.
6. Replace protocol negotiation, unknown-field preservation, generic message-bus, and alternate
   pre-release path language with the one strict canonical protocol and resource adapter.
7. Update the Object Store and Event-format specifications only where needed to distinguish client
   semantic validation from server-visible opaque dependency metadata.
8. Update operations for proof Disk storage, future shared-storage gate, recurring purge, readiness,
   safe logging, Compose isolation, and operational backup implications.
9. Update testing strategy with OpenAPI conformance, external two-replica proof, cursor/Event-order
   separation, generation head races, recovery, purge, and byte-stream bounds.
10. Reconcile the PRD and README so the scaffold/proof is not described as released production
    synchronization.
11. Verify and update `consistency-review.md` as a review record; do not treat it as authority.
12. At completion, rewrite the Roadmap initiative to remove the now-implemented contract/proof work
    and retain only unresolved Device/recovery cryptography, quotas, shared storage, retention UI,
    web client, and security review.

Search all documentation for stale affected language before completion, including:

```bash
rg -n -i 'blocks?|block registry|bundle.*block|tenant|protocol negotiation|ClientHello|ServerHello|OAuth|passkeys?|event cursor|server cursor|garbage collection' README.md VISION.md ROADMAP.md docs
rg -n 'Coordination Server|Synchronization|Vault Generation|delivery cursor|recovery|purge' README.md VISION.md ROADMAP.md docs
```

Do not remove `Block` where a still-canonical owning specification explicitly defines a legitimate
storage category unrelated to the superseded Coordination Server model. Resolve each occurrence
against its owner rather than performing a blind replacement.

---

# 15. Ordered TDD Implementation Tasks

Every task follows RED–GREEN–REFACTOR. Add the smallest failing test, run it and confirm the expected
failure, implement only enough behavior, run the focused test, refactor, then run the affected
suite. Record the failing and passing commands/results in
`docs/plans/08-coordination-server-contract-and-two-replica-proof-tdd-evidence.md`.

## Task 1: Canonical contracts and initial plan reconciliation

**RED:** add contract-loading specs that fail because the OpenAPI document, strict protocol header,
outcome schemas, and canonical resources do not exist.

**GREEN:** add OpenAPI, Committee loading, shared outcome rendering, and the first formal protocol
reconciliation. Make malformed and unknown fields fail with canonical outcomes.

**REFACTOR:** centralize contract configuration without generating controllers or duplicating JSON
schemas in Ruby.

## Task 2: Account boundary and canonical schema

**RED:** prove unauthenticated, cross-Account, missing-authenticator, duplicate-Vault, and recent-
confirmation behavior fails closed.

**GREEN:** add initial migrations, Account/Vault models, database constraints, authenticator
interface, proof adapter guard, and scoped lookup helpers.

**REFACTOR:** remove controller-level ownership queries and keep all access rooted in the Account
principal.

## Task 3: Disk parts and resumable upload

**RED:** cover multipart receipt, resume, duplicate/conflicting parts, ticket expiry, path traversal,
length/checksum mismatch, interruption, and bounded-memory counters.

**GREEN:** implement storage interface, Disk driver, upload/part/ticket tables, streaming part
receipt, status, ticket renewal, final assembly, fsync, and durable-uncommitted state.

**REFACTOR:** isolate all filesystem behavior behind the driver and use a maximum 1 MiB stream
buffer.

## Task 4: Generation-zero Vault attachment

**RED:** prove provisional Vaults are invisible, incomplete roots cannot activate, conflicting IDs
do not leak ownership, and repeated completion is idempotent.

**GREEN:** implement provisional attachment, root upload integration, expiry, atomic completion,
first cursor assignment, and post-commit hint.

**REFACTOR:** share head-lock and delivery-change primitives with later commit/activation Services.

## Task 5: One-Event closure commit

**RED:** reject missing, extra, unsorted, duplicate, cross-Vault, non-durable, candidate-only,
superseded, and conflicting Event dependencies. Prove no partial visibility at every transaction
failure point.

**GREEN:** implement Event metadata persistence, dependency rows, atomic closure commit, Generation
membership, cursor assignment, idempotent result, and durable acknowledgement.

**REFACTOR:** keep semantic Event parsing absent and make the transaction service transport-
independent.

## Task 6: Active enumeration, changes, and ranged download

**RED:** cover stable paging under concurrent commits, late old-timestamp Events, duplicate changes,
range validation, corrupted bytes, inactive access, and client checksum rejection.

**GREEN:** implement active record paging, snapshot-bounded changes, generation assertion, download
tickets, full/ranged streaming, and safe headers.

**REFACTOR:** share immutable metadata serialization across enumeration, changes, and tickets.

## Task 7: Action Cable hints

**RED:** prove unauthorized and cross-Account subscription rejection, exact payload shape,
after-commit timing, duplicate/delayed hint tolerance, and polling convergence after a missed hint.

**GREEN:** implement proof connection authentication, Vault channel authorization, post-commit
broadcast, and OpenAPI component validation of the payload.

**REFACTOR:** ensure no mutation correctness depends on Cable delivery.

## Task 8: Successor Generation candidate and CAS activation

**RED:** cover one-candidate exclusion, successor numbering, sorted paged reachability, page replay
and conflict, seal checksum/count, missing dependencies, active/candidate mixing, concurrent-head
race, stale activation, and discard cleanup.

**GREEN:** implement candidate staging, pages, seal, full membership validation, three-field CAS,
atomic activation, predecessor recovery deadline, delivery change, and stale-write rejection.

**REFACTOR:** batch membership SQL without loading the full retained set into application memory.

## Task 9: Recovery and purge

**RED:** cover exact Generation enumeration, active/recovery path separation, deadline expiry,
fresh-confirmation requirement, purge-all snapshot, active/shared-byte retention, retry after each
storage/database failure, ticket revocation, absence verification, and tombstone non-resurrection.

**GREEN:** implement recovery resources, recurring expiry, durable purge state machine, bounded
membership batches, storage deletion, tombstones, restart resume, and safe progress.

**REFACTOR:** use one purge implementation for automatic and manual triggers.

## Task 10: Independent Compose proof

**RED:** add the Node proof scenario and observe failure against missing external endpoints,
notification, race, recovery, and purge behavior.

**GREEN:** add isolated proof Compose topology, setup script, actual HTTP/WebSocket two-replica flow,
lost-notification polling scenario, deterministic teardown, and CI command.

**REFACTOR:** keep the client independent of Rails code and use only the OpenAPI contract and
protocol semantics.

## Task 11: Operations, CI, and full documentation

**RED:** make root CI fail on the nested undiscovered Rails workflow, stale docs, formatting,
OpenAPI drift, missing proof execution, or unverified security checks.

**GREEN:** move Rails CI to repository-root workflow configuration, add readiness and recurring Job
configuration, complete every documentation reconciliation, prune the Roadmap, and run the full
verification matrix.

**REFACTOR:** remove scaffold-only tests, unused compatibility-shaped code, dead routes, and
duplicated documentation.

---

# 16. Required Verification

Discover exact available versions from the final manifests, but the completed change SHALL run and
report at least:

```bash
cd apps/coordination-server
bin/rubocop
bin/bundler-audit
bin/importmap audit
bin/brakeman --quiet --no-pager --exit-on-warn --exit-on-error
bundle exec rspec
bin/ci
```

From the repository root:

```bash
docker compose -f compose.sync-proof.yml up --build --abort-on-container-exit --exit-code-from replica-proof
docker compose -f compose.sync-proof.yml down --volumes --remove-orphans
corepack pnpm exec prettier --check docs/plans/08-coordination-server-contract-and-two-replica-proof.md docs/plans/08-coordination-server-contract-and-two-replica-proof-tdd-evidence.md docs/specifications/protocol/http-api.openapi.yaml
git diff --check
```

Also run focused specs throughout development and final searches from section 14. The proof teardown
command is authorized only for the explicitly named isolated proof Compose project. Never attach it
to the development volume or use an unresolved project name.

Required test groups:

- OpenAPI load, strict request, strict response, and path coverage;
- model constraints and cross-Account authorization;
- storage driver property/failure tests;
- request specs for every success and stable outcome;
- multipart/range bounded-memory integration tests;
- Event closure atomicity and idempotency tests;
- cursor concurrency and Event-order separation tests;
- Action Cable authorization and hint tests;
- Generation candidate and CAS race tests;
- recovery, time-travel expiry, purge restart, and tombstone tests;
- counters beyond 4 GiB without allocating equivalent memory;
- malicious/corrupt transfer response rejection by the proof client;
- two-replica black-box convergence; and
- zero-knowledge/log-capture assertions using sentinel plaintext that must never appear in server
  persistence, logs, outcomes, or hints.

No rendered visual inspection is required because no user-visible interface is added. If
implementation adds any visible page despite this plan, stop: that is a scope change requiring user
clarification and the full visual policy.

---

# 17. Acceptance Criteria

The work is complete only when all statements are true:

1. One canonical strict OpenAPI HTTP contract exists and loads in Rails and CI.
2. Protocol version `1` has no negotiation, alternate route, fallback, or compatibility reader.
3. An Account directly owns at most one synchronized Vault replica record.
4. Every environment uses real Account/session authentication and fails closed without credentials.
5. PostgreSQL never stores opaque Object payload bytes.
6. Disk upload and download remain bounded-memory beyond 4 GiB.
7. Interrupted multipart upload resumes without accepting conflicting parts.
8. Finalization verifies exact ciphertext length and SHA-256 before durable acknowledgement.
9. Durable-uncommitted records are invisible to every read path.
10. One Event becomes visible only with its complete declared durable dependency closure.
11. Duplicate uploads, parts, commits, and idempotency replays are harmless.
12. Same identifiers with different immutable metadata fail safely.
13. The server delivery cursor is monotonic and remains independent of canonical Event order.
14. A late offline Event is discoverable after an already advanced cursor.
15. Active enumeration can bootstrap a complete opaque current replica.
16. Action Cable hints contain only Vault ID and latest cursor, and polling alone converges.
17. Generation zero is explicit.
18. Successor activation checks predecessor ID, number, and exact observed head cursor.
19. An intervening commit prevents activation without losing active or candidate data.
20. A superseded Generation cannot append or reactivate omitted history.
21. Superseded history is accessible only through explicit recovery endpoints during policy.
22. Hosted policy defaults to 90 days and self-hosted policy is validated and advertised.
23. Manual purge requires fresh Account confirmation and targets all snapshotted superseded
    Generations.
24. Purge never deletes active, candidate, or other retained-Generation bytes.
25. Purge resumes after failure and succeeds only after verified byte absence.
26. Purged IDs retain tombstones and can never be reused.
27. No plaintext, key, semantic Event type, content-derived metadata, or raw credential reaches
    server persistence, logs, metrics, errors, or hints.
28. Two independent black-box replicas converge through actual HTTP, Disk, PostgreSQL, and Action
    Cable boundaries.
29. The proof also converges after missing all Cable hints.
30. Plan 08 itself does not claim quota behavior, Device trust, recovery cryptography, or shared
    storage; Plan 09 owns the subsequently implemented extension Synchronization Service and UI.
31. Repository-root CI actually discovers and runs Rails checks and the Compose proof.
32. Every affected canonical document reflects the resulting design.
33. The Roadmap contains only unresolved forward-looking work.
34. All required formatting, lint, security, unit, integration, Job, contract, and black-box checks
    pass with exact commands reported.

---

# 18. Fixed Decisions Checklist

- [x] Guarded non-production proof, now exercised through the canonical Account contract.
- [x] Account principal only; no Device authorization claim.
- [x] Account directly owns at most one synchronized Vault; no Membership or Tenant model.
- [x] Hosted and self-hosted use one protocol contract.
- [x] OpenAPI is primary for HTTPS shapes; Markdown owns transport-independent semantics.
- [x] Resource endpoints, not a single generic message endpoint or verb-style RPC surface.
- [x] Protocol header version `1`; no versioned route or negotiation.
- [x] JSON control plane plus ticketed opaque binary data plane.
- [x] Disk adapter first; S3 or another shared adapter is not required by this proof.
- [x] Custom immutable byte storage, not Active Storage identity.
- [x] Broad Object types visible; Event subtype hidden.
- [x] One Event closure per commit.
- [x] Server delivery sequence separate from Event replay order.
- [x] Polling remains sufficient; Action Cable is an advisory hint.
- [x] Generation zero plus successor compare-and-swap activation are in the proof.
- [x] Activation compares predecessor ID, number, and head cursor.
- [x] Complete opaque retained-ID set is server-visible for safe GC.
- [x] Hosted recovery defaults to 90 days and self-hosted policy is advertised.
- [x] Explicit recovery view; no automatic merge.
- [x] Account may purge all superseded Generations early after fresh confirmation.
- [x] Purge is durable, non-cancellable, asynchronous, and verified.
- [x] Permanent tombstones prevent resurrection.
- [x] Quotas, rate limiting, real authentication, Device trust, shared storage, client sync, and UI
      remain deferred.
- [x] Independent Node clients drive an isolated Compose black-box proof.
- [x] No visual inspection unless scope changes to add UI.
- [x] No pre-release compatibility or development-data preservation.
