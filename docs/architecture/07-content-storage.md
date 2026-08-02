# Content Storage Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/06-bundle-format.md`
- `docs/specifications/runtime/storage.md`

# Purpose

AWSM stores immutable protected semantics independently from physical databases, files, object
stores, and Hosts. Persistence is classified by authority and lifecycle rather than feature name.

# Logical topology

The stable families are Vault Records, Vault Objects, Replica Safety State, Installation State,
Trusted Secrets, Execution State, Prepared Data, Quarantine, Materializations, Managed Resources,
and Host Policy State. A Storage Realm isolates normal, private, test, and temporary use across all
families.

# Two identity layers

```text
protected logical ID
  -> local protected resolution state
       -> Opaque Storage Item ID for one randomized representation
            -> database row, file, object-store key, pack, or remote item
```

Vault Records, compact Objects, Feature Manifests, Key Envelopes, and protected bootstrap catalogs
use one opaque Compact envelope. Large Artifact wrappers use one authenticated Streamable envelope.
Semantic structures are deterministic CBOR; storage framing is fixed binary plus a canonical
header.

# Immutability and transactions

An accepted logical item never changes bytes under the same ID. Physical backends may deduplicate
exact outer bytes, pack items, or move them. Prepared Data and durable Jobs bridge database and
streaming stores where one physical transaction is impossible. Promotion updates authority and
Replica Safety State atomically.

# On-demand availability

An On-demand Replica retains authoritative compact state while intentionally evicting selected
heavy wrappers. It records only its own availability and exact expected Artifact identity. It does
not claim that another copy exists. Hydration may use any Remote that supplies verified bytes.

# Garbage Collection

Vacuum establishes a new shared Baseline but deletes nothing by itself. Local Garbage Collection
traces every recognized Generation, dependency, preservation root, prepared workflow, and safety
fence, then removes only proven-unreachable physical representations. Materializations follow
their own disposable lifecycle. Heavy wrapper cleanup persists its exact Artifact, Storage Item,
and Key Epoch identities in a local Job, fences only those logical/physical pairs, and remains
resumable between idempotent physical deletion and the final safety-state transaction. That
transaction terminalizes the Job with one stable outcome while removing its fences and obsolete
safety state. The latest terminal Job remains until a later heavy cleanup replaces it.

# References

- `docs/specifications/storage/object-store.md`
- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/vault/vacuum.md`
