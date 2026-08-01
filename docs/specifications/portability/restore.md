# Restore Specification

**Document:** `docs/specifications/portability/restore.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/portability/backup.md`
- `docs/specifications/portability/import-export.md`

# 1. Purpose

Restore installs one fully verified Backup Snapshot as local Replica state. It never rewrites the
Backup, invents missing authority, or silently overwrites an existing Vault.

# 2. Validation

Before activation, Restore decrypts into Prepared Data and verifies package framing, Snapshot and
entry digests, Vault Record and Object canonical forms, all signatures and authority, Required
Features, Baseline authentication, the complete current causal and dependency closure, the complete
Continuity Proof, every wrapper, and the final state digest. It does not require discarded Content
parents named only inside retained Continuity Event bytes.

Unknown Required Features, unavailable entries, corrupt wrappers, wrong protection secrets, or
incomplete history fail the entire Restore. No partially restored Vault appears in the Workspace.

# 3. Activation

For an unknown Vault ID, activation creates one local Replica, secure Key Epoch storage, protected
resolution and Replica Safety State, and fresh Installation State. It creates no Account, Remote,
Replica Access Grant, Recovery Phrase, or Client Credential private key.

For a known Vault ID, Restore applies the same collision rules as Complete Import:

- never rewind an active descendant;
- fast-forward only after ordinary immutable and semantic validation;
- verify and explicitly adopt a Vacuum successor;
- preserve divergent or unpublished local work through an offered safe outcome; and
- never keep two active Workspace entries with the same Vault ID.

# 4. Authoring after restore

Restored epoch keys permit reading the static Snapshot but do not impersonate a member. Continued
authoring requires an active Client Credential enrolled through a valid current Recovery Phrase or
Invitation. If the restored state is Closed or the user is a former member, it remains readable
and Forkable but not writable in that Vault.

# 5. Superseded state

A predecessor-generation Snapshot may be viewed, exported, or Forked in isolation. It does not
merge into the successor. The user may restore it as a state-only Fork with fresh identity and
authority when independent continued work is desired.

# 6. Failure and cleanup

Activation is one atomic safety-state transition. Failure before it leaves no active Replica.
Cleanup of Prepared Data is idempotent and cannot delete Backup bytes or another Realm's state.

# 7. Invariants

- Restore is client-side and fully authenticated.
- A Host receipt never proves Snapshot validity.
- Epoch key possession alone does not create Event-authoring authority.
- Existing local work is never silently discarded.
- Restore does not make a Backup into a live Replica.

# References

- `docs/specifications/vault/replica.md`
- `docs/specifications/vault/vacuum.md`
