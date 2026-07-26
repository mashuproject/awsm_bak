# Synchronization Architecture

**Document:** `architecture/08-synchronization.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/00-design-principles.md
- architecture/glossary.md
- specifications/protocol/protocol.md
- specifications/event/event-format.md

---

# Purpose

Synchronization makes independently operating trusted client Replicas converge on opaque
authoritative Vault history through an untrusted Coordination Server.

# Authority

Clients own encryption, semantic validation, canonical Event replay, conflict handling, and local
retention. The Coordination Server owns no plaintext and never decides semantic truth. It durably
stores immutable ciphertext, verifies transfer integrity, publishes complete declared Event
closures, maintains operational Generation membership, and exposes delivery discovery.

# Two Orders

Canonical Event replay order is defined by Event metadata and remains independent of transport.
The per-Vault Delivery Cursor is a monotonically increasing acceptance sequence used only to ask
which server changes arrived after a prior observation. A late offline Event may sort earlier for
replay while receiving a later Delivery Cursor. Implementations MUST NOT use cursor order as Event
order.

# Upload and Publication

Clients upload encrypted Objects in resumable parts to an active or candidate Generation scope.
Exact byte length and ciphertext SHA-256 are verified before an Object becomes
`DurableUncommitted`. Invisible durable records become readable only through either:

1. one atomic Event closure commit that publishes the Event and every declared durable dependency;
   or
2. one fenced successor Generation activation that publishes its complete sealed membership.

No incomplete Bundle, Event closure, or Generation is ever visible.

# Pull and Wake-Up

Full active enumeration bootstraps a Replica in lexical Object-ID pages. Incremental changes are
snapshot-bounded by Delivery Cursor. Clients download through scoped tickets, reconstruct ranges,
and independently verify immutable metadata.

Action Cable hints carry only Vault ID and latest cursor. Subscribe-before-fetch, refetch after every
hint, generation-guard reconciliation, coalesce bursts without losing the final wake-up, and poll on
visibility/focus. Correctness MUST survive every hint being lost.

One client coordinator owns active synchronization execution. A Coordination Server switch stages a
second, isolated candidate Account and transport while the source coordinator and Cable remain live.
Candidate hints never enter the active coordinator. Only after trusted reconciliation and atomic
local promotion does the coordinator abort and await source transport, drop queued source wakes,
install the candidate context, and begin candidate Cable delivery. Pull commits independently fence
the observed local Head and remote coverage, so a late response cannot overwrite a local mutation
or cross a server-context boundary.

# Git-Like Server Reconciliation

The Git analogy is authenticated reachability, not mutable files or numeric Generation ordering. An
empty candidate receives the current complete Vault. Independent append-only Events in one active
Generation form a safe union after immutable intersection and complete dependency validation. A
direct successor Generation fast-forwards only when the predecessor identity, number, and exact
recovered authoritative closure prove ancestry. Sibling successors or unavailable ancestry are a
conflict and never an overwrite.

The source and candidate Accounts have independent identities even when their emails match. The
trusted Runtime authenticates each Account, then uses certified Device authority to prove that both
servers expose the same Vault cryptographic identity without exposing a Vault key. The Coordination
Server stores and transfers opaque records but never classifies, merges, or interprets history.

A persisted Server Switch Job and candidate-scoped checkpoints fence comparison, remote staging,
local staging, promotion, and prior-session revocation. Local authority plus Account/server promotion
is one transaction. Candidate authentication can be renewed on the same Job, locking pauses the Job,
and startup resumes idempotently from the last durable boundary. Exact prepared Artifact wrappers
are reusable restart state; malformed or partial wrappers are non-authoritative and removed.

The candidate Event response cursor is the remote-write journal boundary for a same-Generation
union. One candidate-head race may restart comparison only while that boundary has not advanced.
After it advances, a concurrent Generation rewrite becomes a truthful terminal conflict: the source
remains active, the candidate append is retained, and neither side is overwritten.

# Generation Reconciliation

Generation zero is explicit. Vault History Rewrite constructs one inactive successor and submits the
complete retained Object-ID set in globally sorted pages. The Service validates existence and
declared Event dependency closure without interpreting encrypted content.

Activation is a compare-and-swap over predecessor Generation ID, predecessor number, and exact
observed head cursor. A concurrent commit forces the client to keep the candidate isolated, refetch,
and deliberately rebuild or reconcile. The Service never silently resets or merges client state.

# Stale Replica discard

When discovery proves that a local Replica names a superseded Generation, the Runtime makes that
Vault read-only while preserving Export and read access. Resolution offers a Complete encrypted
Export first and requires explicit acknowledgement before permanently discarding unpublished local
state. It downloads and verifies the complete active server Replica, rebuilds Projections, and
atomically replaces the stale Vault in place. It never creates another Vault or silently merges
history.

Preparation journals each replacement Artifact before writing it. Startup removes only those
provisional wrappers and returns pre-activation work to Conflict. Activation replaces all
authoritative and derived Vault state and clears obsolete device-local availability and maintenance
rows in one IndexedDB transaction. Termination after activation therefore observes only the complete
server state.

Superseded server membership remains temporarily available only through explicit recovery
resources. Server recovery retention supports diagnosis and controlled retrieval but never decides
client semantic truth.

# Retry and Isolation

Mutating requests are idempotent within authenticated Account and operation scope. Natural Object,
Event, Vault, and Generation identifiers additionally prevent conflicting reuse. Every query begins
from the authenticated Account's Vault scope. Durable-uncommitted, candidate, superseded, recovery,
and active records MUST NOT leak into one another's read paths.

Synchronized Vacuum is coordinated maintenance. It journals the candidate, creates and seals the
remote successor Generation, records remote activation, and only then commits local deletion. If
authentication expires before remote activation, the client signs out, retains the local candidate
and deleted content, and exposes AuthenticationRequired until reauthentication safely resumes or
discards the interrupted candidate from observed server state.

# Current Product Boundary

The Chrome Host implements Account authentication, client-only Account-key enrollment, one
synchronized Vault per Account, polling and advisory Cable wakes, remote bootstrap, incremental
reconciliation, manual heavy-Artifact storage relief, integrity-checked on-demand retrieval,
Git-like Coordination Server switching, synchronized Vacuum, and explicit stale-Replica discard.
Device request signing and revocation, shared Vaults, automatic retention profiles, pinning,
production quota policy and shared immutable-byte storage remain future work. Rails password change
is an identity operation that revokes sessions without changing Vault cryptography.
