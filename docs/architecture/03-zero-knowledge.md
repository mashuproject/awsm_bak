# Zero-Knowledge Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/01-system-overview.md`
- `docs/architecture/04-security-model.md`

# Purpose

AWSM's default remote-storage boundary is opaque: a Replica Host can authenticate access, enforce
its own policy, and store or transfer bytes without Vault plaintext or semantic identifiers.

# Boundary

```text
trusted Client Runtime
  plaintext, private keys, Vault IDs, Records, Objects, search
                         |
                  randomized encryption
                         |
opaque Replica Host
  Account/session, local Replica handle, Grants, opaque item IDs,
  byte lengths, storage class, quota, cursors, operational state
```

The Host does not require portable Vault ID, Generation, member, Credential, Record kind, Event
type, parents, dependencies, Key Epoch, title, URL, search term, or plaintext digest. The Client
privately reconstructs all protected relationships after retrieval.

# Necessary leakage

An opaque Host observes Channel identity, request timing, Hosted Replica association, opaque item
equality for byte-identical envelopes, item class and length, inventory growth, ranges, quota use,
and network metadata. Randomized per-destination rewrapping prevents logical equality from being
inherent across Hosts; copying exact outer bytes deliberately retains correlation.

Padding, batching, traffic shaping, private information retrieval, and stronger metadata
obscuring are future candidates. AWSM does not describe the base design as hiding access patterns
or traffic volume.

# Accounts and credentials

The reference Host may receive a username and password over TLS and store a password verifier,
sessions, and Replica Access Grants. It has no email requirement. These values authorize a Channel,
not decryption. Recovery Phrases, Client Credential private keys, Key Epoch Keys, and plaintext
never reach an opaque Host.

# Remote processing exception

Local search and AI preserve the default boundary. Sending plaintext to a remote model or embedding
provider is a separate explicit disclosure and permission choice. It does not weaken opaque Vault
storage, but that particular processing is not zero knowledge.

# Recovery discovery

Recovery may privately scan bounded pages of authorized Compact opaque items and attempt HPKE
opening locally. The Host learns the same inventory reads it would for synchronization but not
which item, Vault, member, or Epoch matched. An optional encrypted local bootstrap catalog is only
a disposable optimization.

An opened candidate remains untrusted until the Client verifies the Continuity Proof, matching
Recovery Credential, Authority State, expected Epoch inventory, current Record and dependency
closure, and selected Frontier. Decryption alone never authenticates a Host-provided post-Vacuum
Baseline.

# Invariants

- Semantic validation and authorization occur in trusted Clients.
- Host policy never becomes portable Vault truth.
- Logs and diagnostics do not disclose protected guesses or inventories.
- Zero knowledge is not a claim of anonymity or traffic-analysis resistance.
- Public claims follow deployed and tested behavior, not this target alone.

# References

- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/protocol/protocol.md`
- `docs/specifications/vault/replica.md`
