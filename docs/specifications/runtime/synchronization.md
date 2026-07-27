# Runtime Synchronization Service

**Document:** `specifications/runtime/synchronization.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- runtime.md
- ../protocol/protocol.md
- ../event/event-format.md

---

# Purpose

This specification defines trusted Runtime responsibilities for the implemented opaque
Coordination Server integration.

# Responsibilities

The Synchronization Service SHALL encrypt and semantically validate local authoritative records,
maintain independent local Replica state, upload dependencies before Events, retain local content
until durable closure acknowledgement, fetch snapshot-bounded changes, download and verify opaque
bytes, and replay Events in canonical Event order rather than Delivery Cursor order.

Ordinary Pull SHALL preserve a valid remote-only marker when the same Artifact remains in the active
Generation, while installing newly learned wrappers locally by default. Upload SHALL reuse exact
already-committed remote-only Objects without opening local storage, but MUST fail safely if neither
a verified local wrapper nor an exact durable server Object is available.

It SHALL subscribe before initial fetch, treat Action Cable only as a wake-up, generation-guard
reconciliation, poll after missed lifecycle events, and converge when every hint is lost.

# Coordination Server Switching

Changing Coordination Servers is a persisted reconciliation operation, not logout followed by new
onboarding. The Runtime SHALL keep the source Account, source coordinator, and source Cable active
while it probes and authenticates an isolated candidate context. A failed probe, authentication,
Vault mismatch, integrity failure, or read-only conflict MUST leave the source context active and
capable of synchronizing later mutations.

The Runtime SHALL accept either an empty candidate Account or exactly one candidate Vault with the
same Vault ID and cryptographically verified Root Key. It SHALL authenticate every immutable byte
and dependency closure before classification. It SHALL classify only these outcomes:

- `PublishLocal` when the candidate Account is empty;
- `Union` when both Replicas name the same Generation and their immutable intersection agrees;
- `FastForwardCandidate` when the local direct successor and the candidate's exact recovered base
  prove candidate ancestry;
- `FastForwardLocal` when the candidate direct successor and the source's exact recovered base prove
  local ancestry; or
- conflict when ancestry is unavailable or Generations diverged.

Numeric Generation order alone is never ancestry proof. Different Vault IDs are a candidate failure;
the same Vault ID with a different Root Key or immutable bytes is an integrity failure. The Runtime
MUST NOT overwrite either side to resolve a switch conflict.

Candidate uploads SHALL publish dependencies before Events and use persisted idempotency
checkpoints. Local Replica activation, active Account credential promotion, candidate server
configuration, Projections, name cache, and synchronization state SHALL commit in one IndexedDB
transaction. Only after that commit may the Runtime replace the coordinator, revoke the prior
session, and erase prior credentials. A response from the source context MUST NOT commit after
promotion.

A candidate-head race before any candidate authority changes permits one fresh comparison. The
Runtime SHALL journal the first Event whose returned Delivery Cursor proves that the candidate
accepted new authority before marking its local checkpoint committed. If the candidate Generation
then changes, the operation SHALL terminate as a conflict, retain the source as the active context,
and report truthfully that verified append-only history reached the candidate before the concurrent
change. It MUST NOT retry as a read-only comparison, claim that the candidate was unchanged, or
attempt a compensating deletion.

The persisted Server Switch Job SHALL resume after Worker termination at candidate authentication,
comparison, remote preparation/activation, local preparation/activation, promotion, and prior
revocation. Candidate authentication expiry retains the same Job and expected candidate Account
identity before and after remote application. Locking aborts candidate transport and moves the Job
to `WaitingForUnlock`; unlock revalidates both authority fences before resuming. Byte-identical
prepared Artifact wrappers MAY be reused after validation, while incomplete or mismatched wrappers
MUST be removed and downloaded again.

Remote application (`PublishLocal`, `FastForwardCandidate`, and `Union`) SHALL source a missing
remote-only wrapper through the active source server and stream it to the candidate with bounded
memory. `FastForwardLocal` installs a fully local candidate Replica and atomically clears obsolete
availability and storage-relief rows. Candidate promotion MUST reject a missing dependency and never
promote an incomplete Replica.

# Generation Supersession

Every write names the expected active Generation. On supersession or head conflict, the Runtime
quarantines unpublished local work and performs an explicit reconciliation. It MUST NOT silently
reset, merge recovery history, or append against a stale Generation.

# Stale Replica discard

On a stale Generation, the Runtime SHALL make the synchronized Vault read-only except for reads and
Complete Export. Resolution SHALL require either a successful Export or an explicit two-part skip
confirmation that names permanent loss of unpublished local state. It SHALL download and verify the
complete active server Replica, rebuild Projections, and atomically replace the stale Vault in place.
It SHALL NOT create another Vault, re-author stale content, silently merge, or partially activate.

Preparation journals each replacement Artifact ID before its wrapper write. If the Runtime restarts
before activation, startup SHALL remove only those provisional wrappers and restore the Job to
explicit Conflict. Activation atomically replaces authoritative and derived state and clears stale
availability/maintenance rows. A restart after activation retains the committed server Replica.

# Account Scope

One Account owns at most one synchronized Vault. Rails Account authentication establishes identity
only. The Runtime stores independent Account and VaultDevice sessions, protected local Device
identity, encrypted Recovery Kit metadata, and signed key-epoch envelopes. It never derives Vault
keys from the Account password. Account Commands, credentials, Jobs, checkpoints, Delivery Cursors,
and wake-up hints are operational state and never authoritative Vault history.

# Initial Attach and Device Recovery

For an Account without a synchronized Vault, the Runtime SHALL generate the first Recovery
Generation, Key Epoch, encrypted Recovery Kit, Device identity, Device certificate, and Device key
envelope. It SHALL submit them only after the user confirms all 12 Recovery Phrase words. Initial
attach is atomic; failure leaves the local Vault local-only and retains no phrase.

For an Account with a synchronized Vault but no matching local Device, the Runtime SHALL require the
current Recovery Phrase, decrypt and validate the Recovery Kit, create and certify a fresh Device,
prove possession of its signing key, install every readable Key Epoch, and atomically activate the
verified downloaded Replica. Enrollment never requires another Device to be online.

A returning Device SHALL exchange a signed one-use challenge for a VaultDevice session. Ordinary
Device removal revokes server access but cannot erase previously downloaded content.

# Future Protection and Vault Replacement

Future Protection SHALL use compare-and-swap on the current Recovery Generation. It creates a new
Recovery Phrase, Recovery Generation, and Key Epoch, reissues retained-Device envelopes, and makes
offline unpublished old-epoch work replay under the active epoch before upload. Already published
history retains its original Key Epoch.

Vault replacement SHALL require a current verified Complete Export and explicit safe-storage
confirmation. The Runtime rewrites the exact active closure under a fresh Vault identity and keys,
validates the provisional remote candidate, and activates it with an atomic source fence. Failure
before activation leaves the source authoritative. After activation it atomically promotes local
authority, revokes source Devices, and tracks server purge to completion. The old Recovery Phrase
cannot enroll into the replacement Vault.

Synchronized Vacuum SHALL treat authentication expiry at any remote activation checkpoint as an
authentication boundary, not as local completion. It SHALL retain deleted content and the
journaled candidate, erase authenticated secrets, expose `AuthenticationRequired`, and permit
resume only after successful authentication and current-Replica reconciliation. It MUST NOT commit
local Vacuum deletion before the remote successor Generation is durably activated.

# Operational State

Upload progress, Delivery Cursors, retry schedules, availability, and notification bookkeeping are
local operational state, not authoritative Events and not synchronized content. Commands remain
local requested actions; accepted facts become authoritative Events only through Runtime rules.

Manual storage relief SHALL synchronize first, enumerate only locally present `PRIMARY` and
`SCREENSHOT_FULL` wrappers referenced by Active or Deleted captures, and prove exact active
membership/type/length/checksum immediately before each removal. Skipped or mismatched wrappers stay
local. Sign-out warns when remote-only wrappers depend on Account access but does not delete compact
local content or availability rows.

# Security

The Runtime rejects malformed identifiers, mismatched immutable metadata, ciphertext checksum or
length failures, rollback, omitted dependency closure, and malicious server responses. Plaintext,
unwrapped keys, Search Materializations, Search settings, model references, protected remote
credentials, Search Jobs, Search checkpoints, and content-derived metadata never enter protocol
requests.
