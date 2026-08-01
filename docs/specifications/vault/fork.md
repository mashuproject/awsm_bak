# Fork, Historical View, and Event Re-authoring Specification

**Document:** `docs/specifications/vault/fork.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/vault/vault.md`
- `docs/specifications/vault/collection.md`
- `docs/specifications/bundle/manifest.md`

# 1. Purpose

This specification defines three distinct preservation tools: read-only Historical View, state-
only Fork into a new Vault, and recovery of eligible Capture work through Event Re-authoring.
None rewrites an existing Event.

# 2. Historical View

A Historical View derives state at one fully authenticated available Record Frontier. The Runtime
verifies the complete available causal and dependency closure plus the applicable Continuity Proof
and uses ordinary reducers. Viewing does not change selected Generation, accepted current Frontier,
Replica Safety State, or Event parents. Capture while viewing still appends against the current
Frontier.

# 3. Fork preflight

Any member with plaintext access may Fork because portable governance cannot prevent independent
copying. The Client MUST verify every required source Record, Object, and heavy wrapper at the
selected Frontier. Missing or corrupt source content blocks Fork, although wrappers may stream
through bounded memory.

The interface identifies the exact source state and explains that the destination is independent,
will not receive later source Events, and does not preserve source history or authority. Source
state remains unchanged on every outcome.

A stable-ID collision is quarantined integrity input, not an unresolved Content Conflict. A
state-only Fork MUST NOT choose, merge, or silently omit colliding creation candidates. It fails
preflight until eligible Capture content is re-authored under a fresh identity or the collision is
otherwise absent from the selected source state.

# 4. Identity map

Fork creates fresh random IDs for the destination Vault, Generation, first member, first Client and
Recovery Credentials, initial Key Epoch, Collections, Folders, Tags, Tag Assignments, Notes, and
ordinary Bundles. It builds a complete one-to-one source-to-destination mapping in Prepared Data.
For every retained Content cause that later Content operations must name, it also assigns a fresh
destination Baseline Cause ID and uses that mapping consistently wherever the same cause controls
several checkpoint facts.

Every Vault Object is rebuilt under the destination Vault ID. Bundle Descriptors contain mapped
Bundle IDs and Artifact references. Artifact Objects preserve logical payload and representation
metadata but receive new Object IDs; wrappers are re-encrypted with the destination Epoch. Note
Content Objects and all organization targets are similarly rebuilt. No source signature, Event
Record ID, Key Envelope, or private key is reused.

# 5. Fork state

The destination Initial Baseline contains:

- the effective Vault label, but no source Client Credential labels;
- all active and Deleted Captures selected by the source Frontier;
- intrinsic Capture provenance and timestamps;
- effective Collection title, redirect, Folder, Tag, assignment, Note, and lifecycle state;
- every unresolved Collection, Folder, Tag, and Note Content Conflict represented by its complete
  mapped candidate state; and
- the destination's new single member, Administrator, Credentials, Epoch, Envelopes, and Required
  Feature Set.

It contains no source membership, Administrator, Credential, Recovery, Key Epoch, transition,
Event DAG, signature, or lifecycle authority history. Source member and Client Credential IDs MAY
remain only inside the content specification's historical-attribution tuple; there they are opaque
provenance and confer no destination authority. Genesis authenticates the Initial Baseline.

The destination does not copy source Cause IDs. Every retained source Content fact or conflict
candidate that later operations may name receives a fresh Baseline Cause ID. The mapping is
protected by the Baseline state but is not a source Record dependency, provenance pointer, or
invented ancestry. The destination starts a new Continuity Proof at its own Genesis and copies no
source Continuity Proof.

# 6. Activation

The Client prepares and verifies the complete destination, atomically installs one new local
Replica and secure secrets, then reports success. Failure before activation leaves no active
destination and does not clean source bytes. Several independent Forks may coexist and never merge
automatically.

# 7. Event Re-authoring eligibility

Event Re-authoring recovers a valid Capture fact whose source Event cannot continue in the chosen
Generation, typically unpublished predecessor work after Vacuum. It does not replay Authority or
Lifecycle Events, organization commands, membership, roles, Credentials, or an arbitrary stale
branch.

The recovering member MUST be active and permitted to register a Capture at the target parents.
The Client authenticates the source Bundle Registered Event, Descriptor, Artifact Objects, and
every wrapper. The source Capture must not depend on an unsupported feature in the target.

# 8. Re-authored Bundle construction

The target Bundle ID is the recovered-Bundle construction in
`docs/specifications/core/identifiers.md` using target Vault ID
and source Record ID. The Client rebuilds the Descriptor with Event Re-authoring provenance from
`docs/specifications/bundle/manifest.md`, mapped or current Artifact references, and the target
Required Feature Set.

Within the same Vault, an Artifact Object already valid under the target Vault ID and readable
Epoch may be reused unchanged. Otherwise the Client rebuilds its Object and re-encrypts its wrapper
under the current target Epoch. It then emits an ordinary Bundle Registered Event with a current
Collection assignment. The source Record ID is protected provenance, not a target parent or
dependency.

Retrying the same source Record into the same target Vault derives the same Bundle ID. An existing
identical accepted result is success; incompatible bytes claiming that ID are an integrity failure.

# 9. Invariants

- Historical View never rewinds writable state.
- Fork creates a new Vault and leaves the source untouched.
- Fork copies logical state, not source history or authority.
- Fork remaps continuing fact causes and preserves author identifiers only as non-authoritative
  historical attribution.
- Event Re-authoring creates a new signed Event and never edits or rebases the source Event.
- No recovered source Record becomes reachable merely through a protected provenance commitment.
- Missing required source bytes prevent silent partial preservation.

# References

- `docs/specifications/core/identifiers.md`
- `docs/specifications/vault/vacuum.md`
- `docs/specifications/portability/import-export.md`
