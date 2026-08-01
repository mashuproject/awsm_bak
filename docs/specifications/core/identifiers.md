# Identifier Specification

**Document:** `docs/specifications/core/identifiers.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/architecture/glossary.md`

---

# 1. Purpose

This specification defines AWSM's portable entity identities, protected logical content
identities, and Host-local opaque storage identities. Labels, timestamps, Accounts, Hosts, URLs,
and physical locations never determine identity.

# 2. Identifier classes

AWSM uses four distinct classes:

1. generated stable entity IDs identify a logical entity across later Events;
2. Baseline Cause IDs identify checkpointed Content facts after predecessor Content history is
   removed;
3. protected logical content IDs commit to exact canonical authenticated bytes; and
4. Opaque Storage Item IDs commit to one randomized outer storage representation.

A field MUST declare its exact class and semantic type. Generic untyped `id` values are prohibited
at persisted and exchanged boundaries.

# 3. Generated stable entity IDs

The trusted creating Runtime generates 32 cryptographically random bytes for each new:

- Vault;
- Vault Generation;
- Vault Member;
- Client Credential;
- Recovery Credential;
- Invitation;
- Bundle;
- Collection;
- Folder;
- Tag;
- Note; and
- Tag Assignment.

All-zero IDs are invalid. Random generation MUST use a cryptographically secure random source and
MUST NOT encode time, Account, username, Host, label, URL, or storage location.

The 32-byte length is the canonical initial representation. UUID text and alternate byte lengths
are not accepted portable encodings.

A Fork creates fresh IDs for every destination entity. Vacuum retains the Vault ID but creates a
fresh Generation ID. The recovered-Bundle construction below is the sole base deterministic
exception to random Bundle creation.

# 4. Baseline Cause IDs

A Baseline Cause ID is 32 fresh cryptographically random bytes scoped to one Baseline and its
Generation. Baseline construction assigns one ID to every retained Content source cause that later
Content operations must name and reuses that mapping wherever the same cause controls several
checkpoint facts. All-zero and duplicate IDs in one Baseline are invalid.

A Vacuum successor maps those retained predecessor Content Event causes to fresh Baseline Cause
IDs. A state-only Fork does the same while mapping source content into the new Vault. The mapping
does not retain a source Record dependency or source Event identity. Authority and Lifecycle Event
Record IDs remain exact in the separately verifiable Continuity Proof and are never remapped as
Baseline Cause IDs.

After the Baseline, an accepted Content Event's Record ID is the Cause ID for the facts that Event
creates. Content Event bodies that remove, revert, supersede, or resolve state therefore name typed
Cause IDs: either the current Baseline Cause ID or a descendant Content Event Record ID. Causal and
Authority Parent fields always contain Record IDs and never Baseline Cause IDs.

A Cause ID collision between a Baseline fact and a distinct descendant Content Event is an
integrity failure scoped to the affected state. Vacuum creates a new mapping; Cause IDs are not
stable entity identity and never survive as compatibility aliases.

# 5. Protected logical content IDs

The following are 32-byte SHA-256 digests under the exact domain-separated constructions owned by
the Canonical Serialization and cryptography specifications:

- Vault Record ID (`recordId`);
- Object Identifier;
- Artifact ID, which is its compact Artifact Object Identifier;
- Key Envelope logical ID;
- Feature Manifest ID;
- Required Vault Feature Set ID; and
- Key Epoch ID.

Changing any authenticated logical input creates a different ID. Re-encryption, destination
rewrapping, transport framing, physical chunking, range transfer, packing, or storage relocation
does not change a protected logical ID when canonical inner bytes remain exact.

# 6. Opaque Storage Item ID

An Opaque Storage Item ID is the 32-byte SHA-256 digest of one exact canonical randomized outer
storage envelope under `awsm:storage-item-id:v1`.

Privacy-preserving rewrapping for another Hosted Replica creates another envelope and therefore
another Opaque Storage Item ID. Copying the exact envelope bytes preserves the ID and permits
cross-Host equality correlation.

Protected Vault Records and Objects never reference Opaque Storage Item IDs. Replica-local
protected resolution state maps logical IDs to each Remote's opaque IDs.

# 7. Recovered Bundle ID

Event Re-authoring derives the destination Bundle ID as:

```text
SHA-256(Transcript(
  "awsm:recovered-bundle:v1",
  [targetVaultId, sourceRecordId]
))
```

This makes retries and concurrent recovery attempts for the same source Event into the same target
Vault idempotent. A different source Event or target Vault remains distinct.

# 8. Identity collisions

An exact retransmission with identical authenticated bytes and ID is idempotent. Different
authenticated bytes claiming one content ID are an integrity failure.

Different creation facts claiming one generated entity ID are a scoped identity collision. The
affected entity is quarantined; unrelated Vault work continues. Names, titles, and URLs are not
identity and their equality is never a collision.

Two incompatible valid Genesis proofs claiming one Vault ID are an integrity form of Vault Identity
Collision. A client MUST quarantine both claims and MUST NOT overwrite or merge them.

An incoming valid state for a known matching Genesis is the local reconciliation form of Vault
Identity Collision. It represents the same logical Vault. The Runtime classifies same-Generation
ancestry, verified successor Generation, or divergence and follows the exact fast-forward,
Adoption, preservation, Fork, Export, or postponement rules without keeping two active Workspace
entries for one Vault ID.

# 9. Serialization and display

Portable identifiers are canonical 32-byte CBOR byte strings. Human-readable displays MAY use
lower-case base32 without padding and MUST label or type the value. A display encoding is not an
accepted portable serialization and MUST be decoded back to the exact 32 bytes before comparison.

Interfaces SHOULD abbreviate IDs only for presentation and MUST retain a way to inspect or copy the
complete value where diagnosis requires it.

# 10. Scope and lifetime

- A Vault ID remains stable across Vacuum and Replicas.
- A Generation ID is scoped to one Vault and one Baseline root.
- Member, Client Credential, Recovery Credential, Invitation, Collection, Folder, Tag, Note, Tag
  Assignment, and Bundle IDs are scoped to one Vault.
- Baseline Cause IDs are scoped to one Baseline and its successor Generation.
- Record, Envelope, Manifest, and Feature Set IDs are verified within their owning typed domain
  even when equal digest bytes occur elsewhere. Object IDs additionally commit to their Vault ID
  and Object type.
- Opaque Storage Item IDs are meaningful within an exact outer-envelope contract and Hosted Replica
  inventory.
- Account and Replica Access Grant IDs are Host-local policy identifiers defined by that Host's
  executable API contract, not portable Vault identifiers.

An ended or deleted entity ID is never reused for another entity.

# 11. Invariants

- Portable IDs never contain plaintext or content-derived hints.
- Type is always known before an identifier is trusted.
- Content IDs are recomputed before acceptance.
- Generated IDs use 256 bits of secure randomness.
- No content ID includes itself in its digest input.
- Physical optimization never creates a new logical identity.
- Display encodings never become competing persisted formats.

# References

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/crypto.md`
