# Complete Export and Import Specification

**Document:** `docs/specifications/portability/import-export.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/vault/vault.md`
- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/crypto/crypto.md`

# 1. Purpose

A Complete Export is a standalone encrypted transfer artifact for one authenticated Vault
Generation and exact accepted Frontier. It is not a Replica, Remote, synchronization participant,
or Fork and receives no later Events.

# 2. Coverage

Before completion, the exporter authenticates and includes:

- the exact Baseline and complete descendant Record DAG through the selected Frontier;
- the complete Continuity Proof from Genesis through the Baseline's authenticating Vacuum Event
  and selected Authority Frontier;
- every reachable compact Vault Object, Feature Manifest, and Key Envelope;
- every reachable heavy Artifact wrapper, hydrating or streaming it from authorized Remotes;
- every Key Epoch Key required to read the selected state; and
- a canonical reachability manifest and package integrity inventory.

Reachability from the selected causal Frontier follows every causal parent and every typed
dependency. Reachability from the accepted Authority Frontier follows Authority parents and typed
dependencies, but does not retain an Authority or Lifecycle Event's unrelated causal Content
parents solely because that Event remains in the Continuity Proof. Vault Object references and
Feature Manifest requirements are recursive. Every causal Record must belong to the selected
Generation; Continuity Records may belong to authenticated predecessor Generations.

Materializations, Commands, Jobs, Accounts, sessions, Replica Access Grants, Remotes, local
availability, Channel Authenticators, Client Credential private keys, Recovery Phrase material,
logs, and caches are excluded.

# 3. Package protection

The package begins with magic bytes `41 57 53 4d 45 58 01 00`, a four-byte big-endian header length,
and canonical CBOR header:

```text
{
  0: 1,      // completeExportFormat
  1: salt,   // 16 random bytes
  2: 65536,  // Argon2id memory in KiB
  3: 3,      // iterations
  4: 1,      // parallelism
  5: nonce,  // 24 random bytes
  6: 1048576 // encrypted stream plaintext frame limit
}
```

The normalized user passphrase is UTF-8 NFC and derives a 32-byte package key with Argon2id v1.3
using the exact header parameters. XChaCha20-Poly1305 encrypts independently authenticated frames.
Frame nonce and AAD derivation use the Artifact frame construction with domain
`awsm:complete-export-frame:v1` and authenticate the exact header plus frame index and final flag.

Each encrypted frame has this exact outer representation:

```text
uint32be(frameIndex) || uint8(flags) || uint32be(ciphertextLength) || ciphertext
```

Bit zero of `flags` is the final-frame bit and every other bit is zero. Non-final frames contain
exactly 1,048,576 plaintext bytes. The one final frame contains zero through 1,048,576 plaintext
bytes. Frame indexes begin at zero and are contiguous. The frame nonce is the first 16 bytes of the
header nonce followed by the frame index encoded as `uint64be`. The AAD is the canonical transcript
for domain `awsm:complete-export-frame:v1` over, in order, the exact canonical header bytes,
`uint32be(frameIndex)`, the zero-or-one final byte, `uint32be(plaintextLength)`, and
`uint32be(ciphertextLength)`.

# 4. Plaintext stream

The decrypted stream is a sequence of entries:

```text
uint32be(headerLength) || canonicalEntryHeader || entryBytes

entryHeader = {
  0: entryKind, // 1 Manifest, 2 Opaque Storage Item, 3 Export Key Inventory
  1: entryId,   // 32-byte domain-specific digest
  2: byteLength,
  3: byteDigest
}
```

Manifest is first and Export Key Inventory is last. Opaque items are ordered by Opaque Storage Item
ID. Duplicate IDs, unknown kinds, mismatched lengths, or trailing data are invalid.
Manifest and Export Key Inventory entries each have a portable 16 MiB byte limit. Opaque Storage
Item entries are streamed and use the bounds owned by their canonical storage representation.

`byteDigest` is SHA-256 over the exact entry bytes. An Opaque Storage Item entry uses its canonical
Storage Item ID as `entryId`. Manifest and Export Key Inventory IDs use SHA-256 over the following
exact constructions respectively:

```text
"awsm:complete-export-manifest-entry-id:v1" || 0x00 || uint32be(1) ||
  uint64be(byteLength) || entryBytes

"awsm:complete-export-key-inventory-entry-id:v1" || 0x00 || uint32be(1) ||
  uint64be(byteLength) || entryBytes
```

# 5. Manifest and key inventory

```text
manifest = {
  0: 1,
  1: vaultId,
  2: generationId,
  3: frontier,
  4: requiredFeatureSetId,
  5: typedLogicalRoots,
  6: opaqueItemInventory,
  7: stateDigest,
  8: continuityProofRoots
}

keyInventory = {
  0: 1,
  1: vaultId,
  2: generationId,
  3: keyEpochEntries
}

keyEpochEntry = {0: keyEpochId, 1: keyEpochKey}
```

`typedLogicalRoots` is the sorted duplicate-free canonical set of ordinary typed dependency maps
`{0: dependencyType, 1: logicalId}`. It contains the selected Baseline as a Vault Baseline root and
every selected causal Frontier Record as a Vault Record root. `opaqueItemInventory` is the sorted
duplicate-free canonical set of:

```text
{
  0: namespace,     // 1 Record, 2 Key Envelope, 3 Vault Object,
                    // 4 Feature Manifest, 5 Artifact wrapper
  1: logicalId,
  2: storageItemId,
  3: keyEpochId,
  4: byteLength,
  5: byteDigest
}
```

Both `(namespace, logicalId)` and `storageItemId` are unique. `byteLength` is positive and
`byteDigest` is SHA-256 over the exact Opaque Storage Item bytes. The Manifest `stateDigest` is
SHA-256 over the canonical transcript with domain `awsm:complete-export-state-digest:v1` and one
part: the exact canonical Manifest map containing keys `0` through `6` and `8`, with key `7`
omitted. The full encoded Manifest inserts the resulting digest at key `7`.

Key Epoch entries are a sorted duplicate-free canonical set. The importer recomputes each Key Epoch
ID from the Manifest Vault ID and its 32-byte Key Epoch Key. The inventory MUST contain exactly the
duplicate-free Key Epoch ID set referenced by `opaqueItemInventory`; a missing or unreferenced entry
is invalid.

`continuityProofRoots` is the exact accepted Authority Frontier and is encoded at key `8`. Every Continuity
Proof Record and authority-semantic dependency reachable from those roots is present in the opaque
inventory even when a retained proof Event's unrelated causal Content parents are absent.

These values are protected by the whole package encryption. The importer recomputes every Key
Epoch ID, every decryptable Record, Object, Feature Manifest, and Artifact logical ID, every outer
Storage Item ID, the exact reachable inventory, and the state digest before exposing content. A Key
Envelope logical ID commits to recipient-only HPKE plaintext and therefore remains a signed
reachable dependency commitment until its intended Recovery or Client Credential opens it. Import
still validates that the package contains exactly the reachable Key Envelope IDs and authentic
outer wrappers; opening that Envelope later performs the recipient-only logical-ID verification
required by `docs/specifications/crypto/crypto.md`.

# 6. Import

Import decrypts into Prepared Data, validates the entire package, and then atomically installs one
Replica or changes nothing. It creates fresh local Installation State, resolution state, wrappers,
and secure key storage. It never imports Account sessions, Host Grants, or authoring private keys.
Compact Prepared Data is reopened under the package-carried Key Epoch Keys and checked against its
namespace and logical identity. Streamable Artifact wrappers are authenticated frame by frame
against their reachable Artifact Objects without retaining plaintext. Prepared Data remains
unavailable to ordinary Runtime reads until all semantic and authority validation succeeds.
The resulting local Replica has no selected Client Credential, authoring Credential, or local
member binding. It is readable with the imported Epoch keys; authoring becomes available only
after ordinary Recovery or Invitation enrollment establishes current authority.

Authority validation uses the same canonical proof rules as opening an existing Replica. It
verifies the Genesis Client and Recovery possession proofs, authenticates the Initial or successor
Baseline checkpoint and exact dependency closure, replays every selected descendant Event against
the Authority State at its signed Authority Parents, and verifies the complete Continuity Proof and
every Vacuum boundary through the selected Authority Frontier. The importer derives the read-only
Replica Safety State—including Generation, causal and Authority Frontiers, Continuity Records,
active Baseline, current Key Epoch, Required Feature Set, lifecycle, and Vacuum Adoption—from that
validated state. It does not accept a separately asserted local-state snapshot from the package.

If the installation already knows the Vault ID:

- an ancestor package may be retained as a separate Transfer Artifact but does not rewind state;
- a package that can fast-forward the same Generation may be merged through ordinary validated
  immutable union;
- a valid Vacuum successor follows ordinary adoption; and
- divergent work produces an explicit collision flow with Fork, Export, recovery, or postponement.

The Runtime never keeps two active entries claiming one Vault ID and never silently overwrites
local work. To author after a fresh import, the user enrolls a Client Credential through ordinary
Recovery or invitation authority.

# 7. Vacuum and Fork

A pre-Vacuum Complete Export can preserve exact predecessor history. A post-Vacuum Export is
complete for the successor and intentionally lacks omitted Content history, but always includes the
Continuity Proof required for independent authority verification. `Prepare a smaller export`
performs the ordinary informed Vacuum and Adoption first; it is not a compression flag.

A Fork instead derives logical source state, creates fresh identities, keys, authority, Initial
Baseline, and Genesis, and copies no source Event history. Selective cross-Vault import is deferred
and is not an implicit variant of Complete Import.

# 8. Invariants

- Successful import is all-or-nothing.
- Package passphrase possession grants access to that static exported state.
- Export never changes the source Vault.
- Complete means every required wrapper is present and verified.
- The package format has no compatibility reader or legacy Root Key slot.

# References

- `docs/specifications/portability/backup.md`
- `docs/specifications/portability/restore.md`
- `docs/specifications/vault/vacuum.md`
