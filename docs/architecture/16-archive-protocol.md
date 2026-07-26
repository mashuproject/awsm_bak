# Archive Protocol Adapter

**Document:** `architecture/16-archive-protocol.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/08-synchronization.md
- architecture/15-coordination-server.md
- specifications/protocol/protocol.md
- specifications/protocol/http-api.openapi.yaml

---

# Purpose

The Archive Protocol separates transport-independent synchronization semantics from the canonical
HTTPS and Action Cable adapters.

# Control Plane

The strict JSON control API is mounted at unversioned `/api` routes and requires protocol header
value `1`, a lowercase UUID request ID, Account bearer authentication, and an idempotency UUID for
mutations. OpenAPI owns shapes and statuses. Unknown fields and undocumented routes fail; there is no
session handshake, negotiation, generic message bus, or compatibility path.

# Opaque Data Plane

Short-lived scoped tickets authorize upload parts and full/ranged downloads. Bodies are opaque
`application/octet-stream`. The Service validates ticket digest, scope, expiry, part/range bounds,
length, and ciphertext SHA-256 without interpreting bytes. PostgreSQL stores no payload bytes.

# Publication and Discovery

One Event closure commit is the publication unit. Full active enumeration bootstraps a Replica;
snapshot-bounded changes use a Delivery Cursor that is independent of Event replay order. Action
Cable publishes an advisory cursor hint only. Polling is the correctness path.

# Generation and Recovery

Successor Generation activation is a compare-and-swap over predecessor ID, predecessor number, and
observed head cursor. Complete retained membership is submitted in sealed pages for safe remote
retention. Superseded membership is available only through explicit recovery until a durable Purge
Job revokes it and safely deletes newly unreferenced bytes.

The same scoped download contract serves remote-only Artifact retrieval and Complete Export. Active
access must name the Account's current Generation; stale Complete Export must name the exact retained
Recovery Snapshot. Transfer metadata and received bytes are verified before trusted use. No protocol
message exposes local availability, Artifact role, plaintext metadata, or a server-side eviction
command.

# Deferred Adapters

Rate limits, quotas, shared byte storage, alternate transports, and compression remain undefined.
Rails Account authentication, Recovery Generations, encrypted Recovery Kits, certified Devices,
Device key envelopes, and key epochs are current protocol resources. Adding deferred adapters
requires an explicit contract decision and MUST NOT introduce a parallel pre-release path.
