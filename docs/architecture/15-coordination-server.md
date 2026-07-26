# Coordination Server Architecture

**Document:** `architecture/15-coordination-server.md`

**Status:** Draft

**Owner:** Engineering

**Primary Implementation:** Ruby on Rails

**Depends On:**

- architecture/03-zero-knowledge.md
- architecture/08-synchronization.md
- specifications/protocol/protocol.md
- specifications/protocol/http-api.openapi.yaml

---

# Purpose

The Coordination Server synchronizes opaque encrypted Vault records without possessing plaintext or
unwrapped Vault keys. The trusted Runtime owns semantic validation, Event replay, encryption, and
reconciliation. The server owns only authenticated Account scope, durable opaque transfer,
transactional publication, delivery bookkeeping, advisory wake-up hints, and recovery retention.

# Current Boundary

An Account signs up on the Rails web surface and authenticates with normalized email and password.
Rails receives the password over TLS and stores only its password digest. Rotating opaque access and
refresh credentials are digest-only at rest, and reuse of a consumed refresh credential revokes its
logical session. Each Account owns at most one synchronized Vault record with one active Recovery
Generation, one active Key Epoch, certified Devices, opaque Device key envelopes, and exactly one
active Vault Generation.

An empty Account may attach a Vault at its current nonnegative Generation number. The Coordination
Server preserves that supplied identity and number as the Replica's first known active Generation;
it does not renumber the Generation, synthesize predecessor rows, or infer ancestry from encrypted
Generation contents.

The server validates Device certificates, enrollment proofs, revocation state, Recovery Generation
compare-and-swap, and Key Epoch fences, but possesses no Recovery Phrase, recovery private material,
Vault root key, or Device secret. Shared Vaults, roles, invitations, billing, and quotas remain
outside the current boundary. Password change is a Rails identity operation that revokes all
Account and VaultDevice sessions without changing Vault cryptography. The black-box proof uses the
same public Account/session resources as the extension; `AWSM_SYNC_PROOF` selects test adapters only
and never changes authentication semantics.

# Server-Visible Metadata Budget

The server may know Account and Vault operational IDs; broad Object type; ciphertext byte length and
SHA-256; encrypted Object ID; Event ordering timestamp; the exact sorted dependency Object IDs
declared for an Event; Vault Generation identity, number, predecessor, full retained membership,
and recovery deadline; upload state; delivery cursor; Job progress; and safe outcome codes.

The server MUST NOT receive plaintext, keys, semantic Event subtype, titles, URLs, notes, tags,
filenames, search terms, content-derived metadata, or plaintext checksums. Complete retained
membership leaks encrypted graph shape and is accepted solely to make remote deletion safe.

The server does not receive storage-relief policy, local availability rows, semantic Artifact roles,
or eviction commands. Existing active-Generation and Recovery Snapshot download tickets provide
opaque wrappers for on-demand access, Complete Export, server switching, and stale discard.

# Components

- The HTTP control adapter implements the strict OpenAPI 3.0.3 contract under `/api`.
- Transfer tickets authorize one opaque upload or download scope and are stored only as SHA-256
  digests.
- PostgreSQL stores operational metadata, immutable identity, membership, delivery changes,
  idempotency, and Purge Job checkpoints. It never stores Object payload bytes.
- `OpaqueByteStorage` provides immutable byte operations. The proof Disk Driver uses a private root,
  bounded streams, fsync, and same-filesystem atomic installation.
- An ephemeral-coordination adapter stores only TTL-bound Cable-ticket digests and Account binding.
  The reference implementation uses one non-persistent Redis service for this boundary and Action
  Cable Pub/Sub.
- Action Cable publishes `{vaultId, latestCursor}` only after a committed head change. Polling is
  always sufficient. A 60-second, 256-bit opaque, Account-bound Cable ticket is stored under its
  SHA-256-derived Redis key, atomically consumed once, and scrubbed from retained request URL state.
- Solid Queue runs expiry and purge work. A domain Purge Job, not queue state, owns resumability and
  visible progress.

# Publication Model

Uploads become `DurableUncommitted` only after exact length and ciphertext checksum verification.
They remain invisible. One Event closure commit locks its Vault, rechecks the active Generation and
exact dependency declaration, commits the complete durable closure, adds active membership, assigns
one Delivery Cursor, and records one delivery change in the same PostgreSQL transaction.

Generation zero is explicit. A successor is staged as one inactive candidate with paged, globally
sorted reachability. Activation compares predecessor ID, predecessor number, and exact observed head
cursor. It atomically supersedes the predecessor, activates the successor membership, and advances
the Delivery Cursor. An intervening commit makes activation fail without changing either scope.

# Recovery and Deletion

Superseded Generations are accessible only through explicit recovery resources until `purgeAfter`.
The hosted default is 90 days. Manual purge requires recent Account confirmation and snapshots all
currently superseded Generations. Automatic expiry creates the same durable Job.

Purge detaches only targeted memberships, preserves every record referenced by an active, candidate,
or other retained Generation, revokes recovery tickets, verifies byte absence, and finally leaves a
permanent immutable tombstone. Missing committed bytes are integrity incidents, never cleanup hints.

A client may rely on the active server as the sole holder of selected encrypted heavy wrappers only
after it independently verifies active membership plus exact committed type, length, and checksum.
This does not make local availability server state and adds no server deletion API.

# Scaling and Remaining Production Gate

The repository topology uses PostgreSQL, Disk storage, Redis ephemeral coordination, and Solid
Queue. Redis already supports cross-process Cable authentication and advisory hints, but
multi-host Rails still requires an approved shared immutable-byte Driver and shared Job
infrastructure. Production promotion still requires Device/recovery authorization, quotas and
abuse controls, operational backup/restore, independent security review, hosted Redis rollout, and
deployment-specific hardening.
