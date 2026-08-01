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

| Namespace key                            | Family               | Scope        | Mutation           |
| ---------------------------------------- | -------------------- | ------------ | ------------------ |
| `awsm.storage.vault-record`              | Vault Records        | Vault        | immutable          |
| `awsm.storage.key-envelope`              | Vault Objects        | Vault        | immutable          |
| `awsm.storage.vault-object`              | Vault Objects        | Vault        | immutable          |
| `awsm.storage.feature-manifest`          | Vault Objects        | Vault        | immutable          |
| `awsm.storage.artifact-wrapper`          | Vault Objects        | Vault        | immutable          |
| `awsm.storage.replica-state`             | Replica Safety State | Replica      | mutable CAS state  |
| `awsm.storage.logical-resolution`        | Replica Safety State | Replica      | mutable resolution |
| `awsm.storage.vault-directory`           | Installation State   | Installation | mutable            |
| `awsm.storage.installation-selection`    | Installation State   | Installation | mutable            |
| `awsm.storage.installation-wrapping-key` | Trusted Secrets      | Installation | immutable          |
| `awsm.storage.client-secret`             | Trusted Secrets      | Vault        | mutable lifecycle  |
| `awsm.storage.epoch-secret`              | Trusted Secrets      | Vault        | mutable lifecycle  |
| `awsm.storage.command-outcome`           | Execution State      | Vault        | immutable          |
| `awsm.storage.prepared-capture`          | Prepared Data        | Job          | immutable          |
| `awsm.storage.incoming-quarantine`       | Quarantine           | Remote       | immutable          |
| `awsm.storage.library-projection`        | Materializations     | Replica      | replaceable        |
| `awsm.storage.managed-resource`          | Managed Resources    | Installation | immutable          |

Every stored key includes Storage Realm, namespace key, declared scope key, and item key. The
initial canonical local database is created only from an empty database at schema revision `1`;
another local schema is discarded and recreated by the owning Client rather than upgraded or
interpreted through compatibility readers.

The Vault directory's selected Client Credential and Replica Safety State's local authoring
Credential and local member binding are optional. Complete Import installs all three as absent and
stores no Client Secret. Key Epoch Secrets required to read the validated Replica remain Trusted
Secrets protected by the Installation Wrapping Key. The absence of local authoring identity never
changes portable membership facts inside Vault Records.

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
