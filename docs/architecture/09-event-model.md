# Vault Record and Event Model

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/08-synchronization.md`
- `docs/specifications/event/event-format.md`

# Purpose

AWSM has one authenticated hash-linked Vault Record DAG. Events are signed facts; Baselines are
authenticated state roots. Separate content, authority, or lifecycle logs do not exist.

# Record graph

```text
Baseline root
  -> Event A -> Event C
  -> Event B -/

Record parents: causal observations
Typed dependencies: Objects and other immutable data required by a Record
```

Only Events and Baselines are causal Record nodes. Bundle Descriptors, Artifact Objects, Note
Content Objects, Key Envelopes, and Feature Manifests are typed dependencies.

# Event families

- **Content:** Vault label, Captures, Collections, Folders, Tags, and Notes.
- **Authority:** Genesis, membership, administration, Invitations, Credentials, Key Epochs, and
  Required Features.
- **Lifecycle:** Vacuum and Closure.

Every Event names the author's complete authenticated accepted Frontier, exact dependencies,
Required Feature Set, signing Client Credential, asserted timestamp, body, and signature.

Every Event also names a complete Authority Parent Frontier containing the maximal Genesis,
Authority, and Lifecycle Events in its accepted ancestry. This authenticated subgraph of the same
Record set drives authorization and survives as the Continuity Proof across Vacuum; Content Events
do not advance it.

When predecessor Content history is removed, a Baseline assigns fresh Cause IDs to retained Content
facts. Later remove, revert, supersession, and resolution Events can name those facts without making
discarded Content Records parents or dependencies. Descendant Content Event Record IDs act as the
Cause IDs of their facts. Authority and Lifecycle Record IDs remain exact in the Continuity Proof.

# Time and causality

Parent ancestry is the source of causality. `assertedAt` and Capture time remain useful signed audit
and provenance data but never grant authority, resolve conflicts, expire invitations, or select a
winner. Deterministic Record ID ordering is used only for reducer classes that explicitly permit a
non-semantic tie break.

# Conflict behavior

Additive immutability does not eliminate semantic conflict: concurrent authority changes, Note
revisions, merges, or Folder placements may be individually valid yet incompatible together.
Reducers preserve all heads and either compose, select under an approved deterministic rule, or
create a scoped Conflict requiring an authorized resolution descendant.

# Evolution

Required Vault Features define new authoritative types, reducers, codecs, Baseline state, and
reachability. An older client stops before the unsupported Event rather than partially receiving or
writing through it. Advisory Extensions are authenticated but cannot alter required semantics.

# References

- `docs/specifications/event/event.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/authority.md`
