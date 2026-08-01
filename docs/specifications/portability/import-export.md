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

`continuityProofRoots` is the exact canonical Authority Frontier for key `3`. Every Continuity
Proof Record and authority-semantic dependency reachable from those roots is present in the opaque
inventory even when a retained proof Event's unrelated causal Content parents are absent.

These values are protected by the whole package encryption. The importer recomputes every Epoch,
logical, outer, reachability, and state digest before exposing content.

# 6. Import

Import decrypts into Prepared Data, validates the entire package, and then atomically installs one
Replica or changes nothing. It creates fresh local Installation State, resolution state, wrappers,
and secure key storage. It never imports Account sessions, Host Grants, or authoring private keys.

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
