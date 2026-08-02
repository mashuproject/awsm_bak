# Runtime Storage Specification

**Document:** `docs/specifications/runtime/storage.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/storage/object-store.md`
- `docs/specifications/vault/replica.md`

# 1. Purpose

This specification fixes logical persistence semantics without requiring one database, table, or
backend per family. Storage Drivers may combine or split physical stores only while preserving
authority, encryption, scope, transactions, and deletion safety.

# 2. Logical storage families

Every durable namespace belongs to exactly one family:

1. **Vault Records:** immutable Baselines and Events.
2. **Vault Objects:** immutable compact Objects, Key Envelopes, Manifests, and heavy wrappers.
3. **Replica Safety State:** accepted Generation, causal and Authority Frontiers, Continuity Proof
   roots, adoption, local availability, preservation roots, and Garbage Collection fences.
4. **Installation State:** Vault directory, selection, Remotes, preferences, and local
   configuration.
5. **Trusted Secrets:** Client Credential private keys, Recovery-derived secure handles, Key Epoch
   keys, wrapping keys, and Channel Authenticators.
6. **Execution State:** Commands, outcomes, Jobs, leases, checkpoints, retries, and idempotency.
7. **Prepared Data:** trusted local output not yet committed as authority.
8. **Quarantine:** untrusted imported or synchronized bytes awaiting complete validation.
9. **Materializations:** projections, search indexes, secondary indexes, and rebuildable caches.
10. **Managed Resources:** models, OCR packs, dictionaries, and other independently verified tools.
11. **Host Policy State:** Accounts, Channel Principals, Replica Access Grants, sessions, quotas,
    and Hosted Replica lifecycle.

Ephemeral Coordination State, user-owned Transfer Artifacts, and Observability State are adjacent
classes, not application persistence families. There is no `misc` family.

# 3. Namespace registry

Every typed namespace declares one globally scoped canonical key, family, exact local schema
revision, scope key, identity and uniqueness, trust source, validation, encryption,
synchronization, Export and Backup treatment, retention, deletion rule, transaction partners, and
unknown-namespace behavior.

New product features normally add a strict namespace inside an existing family. A Required Vault
Feature owns every new authoritative namespace and its Baseline, reachability, and validation.
Unknown authoritative or Replica Safety namespaces fail closed. Unknown Materializations are
disposable.

The canonical Client registry currently declares these revision-1 namespaces:

| Namespace key                                 | Family               | Scope        | Mutation                  |
| --------------------------------------------- | -------------------- | ------------ | ------------------------- |
| `awsm.storage.vault-record`                   | Vault Records        | Vault        | immutable                 |
| `awsm.storage.key-envelope`                   | Vault Objects        | Vault        | immutable                 |
| `awsm.storage.vault-object`                   | Vault Objects        | Vault        | immutable                 |
| `awsm.storage.feature-manifest`               | Vault Objects        | Vault        | immutable                 |
| `awsm.storage.artifact-wrapper`               | Vault Objects        | Vault        | immutable                 |
| `awsm.storage.replica-state`                  | Replica Safety State | Replica      | mutable CAS state         |
| `awsm.storage.logical-resolution`             | Replica Safety State | Replica      | mutable resolution        |
| `awsm.storage.vault-directory`                | Installation State   | Installation | mutable                   |
| `awsm.storage.installation-selection`         | Installation State   | Installation | mutable                   |
| `awsm.storage.replica-remote`                 | Installation State   | Vault        | mutable                   |
| `awsm.storage.installation-wrapping-key`      | Trusted Secrets      | Installation | immutable                 |
| `awsm.storage.client-secret`                  | Trusted Secrets      | Vault        | mutable lifecycle         |
| `awsm.storage.epoch-secret`                   | Trusted Secrets      | Vault        | mutable lifecycle         |
| `awsm.storage.remote-channel-credential`      | Trusted Secrets      | Remote       | mutable local credential  |
| `awsm.storage.command-outcome`                | Execution State      | Vault        | immutable                 |
| `awsm.storage.replica-garbage-collection-job` | Execution State      | Vault        | mutable conditional state |
| `awsm.storage.pull-synchronization-job`       | Execution State      | Vault        | mutable resumable state   |
| `awsm.storage.prepared-capture`               | Prepared Data        | Job          | immutable                 |
| `awsm.storage.pending-vault-creation`         | Prepared Data        | Installation | mutable conditional state |
| `awsm.storage.incoming-quarantine`            | Quarantine           | Remote       | immutable                 |
| `awsm.storage.library-projection`             | Materializations     | Replica      | replaceable               |
| `awsm.storage.search-materialization`         | Materializations     | Replica      | replaceable               |
| `awsm.storage.managed-resource`               | Managed Resources    | Installation | immutable                 |

Every stored key includes Storage Realm, namespace key, declared scope key, and item key. The
initial canonical local database is created only from an empty database at schema revision `1`;
another local schema is discarded and recreated by the owning Client rather than upgraded or
interpreted through compatibility readers.

A pull Synchronization Job retains one canonical Quarantine reference for every downloaded opaque
item: its Opaque Storage Item ID and the exact 32-byte locator supplied by that Remote's inventory.
The outer bytes stay in Remote-scoped Quarantine under the same Storage Item ID. A checkpoint may
add one such reference only with the matching downloaded outer bytes; it never rewrites or drops a
retained locator. When trusted opening later establishes an item's protected logical identity, the
Client recomputes that Remote's locator before it can accept or promote the representation.

A trusted pull promotion is one exact prior-Replica and prior-Job compare-and-swap. It writes only
the validated immutable Compact representations and their protected local resolutions, advances
the accepted Replica state and local Job together, and deletes exactly the Remote-scoped Quarantine
references that it consumed. It invalidates Frontier-bound Library and Search Materializations in
the same commit. It never turns a Quarantine checkpoint into semantic authority by itself, and it
never drops ciphertext that the Client cannot yet open.

The Vault directory's selected Client Credential and Replica Safety State's local authoring
Credential and local member binding are optional. Complete Import installs all three as absent and
stores no Client Secret. Key Epoch Secrets required to read the validated Replica remain Trusted
Secrets protected by the Installation Wrapping Key. The absence of local authoring identity never
changes portable membership facts inside Vault Records.

A pending Vault creation is installation-wrapped Prepared Data, keyed by one random setup ID. It
contains the exact local private creation material and protected initial Envelope and Compact
parameters needed to survive a Client restart, but never the Recovery Phrase or its entropy. A
confirmation derives the Recovery Credential from the phrase supplied then, verifies the retained
Recovery Envelope, and atomically creates the initial Replica while exact-byte compare-and-swap
deleting the pending item. Cancellation performs the same exact-byte conditional deletion without
creating a Vault. Pending creation data is never synchronized, exported, or backed up.

The Client may enumerate this singleton local namespace only to rediscover the random setup ID
after a UI or Runtime restart. It may present that ID's resumable status and expected local Vault
context to its own UI, but never the protected creation material, Recovery Phrase, or phrase
entropy. A second creation is rejected until the pending setup is confirmed or cancelled.

# 4. Storage Realms

A Storage Realm cross-cuts every family. Normal, private/incognito, temporary, test, and future
isolated realms cannot discover, unlock, synchronize, promote, or retain one another's state unless
an explicit bridge contract permits it. Realm is scope, not a twelfth family.

# 5. Object placement

One logical Artifact Object may have a compact authoritative representation in a transactional
store and a heavy encrypted wrapper in a streaming backend. The Storage Driver preserves one
logical Artifact identity, verifies the exact wrapper contract, and uses Prepared Data plus
Execution State where the physical systems cannot commit atomically.

Randomized outer envelope bytes and Opaque Storage Item IDs are placement identities. Protected
logical IDs remain stable across backends. Protected local resolution state maps logical IDs to
available opaque representations per Remote.

# 6. Sparse availability

Replica Safety State distinguishes verified local, remotely resolvable, expected but unavailable,
and corrupt. Storage Relief may remove a heavy wrapper after a clear, non-blocking warning that the
Client cannot verify another usable copy. Compact authority and resolution state remain sufficient
to retrieve known missing bytes when a configured Remote supplies them.

# 7. Deletion and Garbage Collection

No family is deleted by age or apparent duplication alone. Garbage Collection traces every active
Generation, Continuity Proof, dependency, local preservation root, Prepared workflow, and safety
fence. It deletes only an exact unreachable opaque representation, never a logical identity still
required by a recognized state. A Continuity Event's unrelated causal Content parent ID does not
retain that Content Record; its signed Authority Parents and authority-validation dependencies do.

The Runtime first authenticates and replays the selected Replica. A nonempty Garbage Collection
fence prevents collection. For an adopted successor, Genesis and the complete Continuity Proof stay
reachable while Genesis's Initial Baseline and unrelated predecessor Content may be reclaimed when
no explicit preservation root retains them. Compact bytes, matching Logical Resolutions, and
newly-unused Epoch Secrets are one exact prior-state compare-and-swap.

Heavy Artifact wrappers cross the transactional-store boundary. The trace may identify an
unreachable wrapper, but its protected Logical Resolution and required Epoch Secret remain until a
durable Replica Garbage Collection Job completes lease-serialized physical cleanup. Physical
deduplication keeps a wrapper whenever any retained logical resolution names the same Opaque
Storage Item ID. Failure or restart therefore leaves either a resumable cleanup identity or the old
safe state, never an untracked missing wrapper.

Physical deduplication retains the shared wrapper, not an unreachable logical alias resolution.
That alias resolution may be removed in the compact transaction only when its Key Epoch agrees
with the retained resolution for the exact wrapper; conflicting Epoch claims fail closed.

The Job records every exact logical Artifact ID, Opaque Storage Item ID, and Key Epoch ID plus the
already-committed compact outcome. Its deterministic candidate-set idempotency key and random local
Job ID are Execution State, not Vault identity. One initial Replica-state compare-and-swap installs
the Job and a duplicate-free set of logical Artifact plus Storage Item pairs as Garbage Collection
fences before physical removal. Capture, known-Vault Import, synchronization, and any other trusted
path that can promote wrapper bytes MUST reject either a fenced logical Artifact ID or fenced
Storage Item ID; unrelated Artifact identities and ordinary additive work remain available.

A conditional Job transition acquires or renews the narrow cleanup lease. Lease time is local
operational scheduling state and never orders Vault Events or supplies authority. Removal is
idempotent. The final compare-and-swap requires the same leased Job and current Replica Safety
State, then removes every candidate Logical Resolution, any newly unused Epoch Secret, and the
fences while replacing the leased Job with one Succeeded record containing the stable complete
outcome. A crash before that transaction leaves the complete resumable identity; a crash after it
leaves the result. A live lease prevents duplicate workers; an expired lease increments the attempt
and resumes the same candidates. The latest terminal Job is retained locally until the initial
transaction for a later heavy cleanup conditionally removes it while installing the new Job and
fences. A resumed Job does not absorb newly discovered unreachable compact state: that state and
its required Epoch Secrets remain for a later collection.

Materializations may be replaced when their generation, corpus revision, algorithm, tokenizer,
model, vector, quantization, ranking, or schema identity changes. Vacuum invalidates predecessor-
Generation Materializations rather than migrating them.

# 8. Invariants

- Persisted bytes do not become authority merely by existing.
- Replica Safety State is not a disposable preference cache.
- Prepared Data and Quarantine never share promotion assumptions.
- Trusted Secrets never enter ordinary export, logs, or Host policy storage.
- Physical optimization cannot change logical Vault semantics.

# References

- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/runtime/jobs.md`
- `docs/specifications/runtime/search.md`
