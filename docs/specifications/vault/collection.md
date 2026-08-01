# Vault Content and Organization Specification

**Document:** `docs/specifications/vault/collection.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/bundle/bundle.md`
- `docs/specifications/event/event-format.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/vault.md`

# 1. Purpose

This specification owns the base Vault content model, the exact bodies of all 31 Content Events,
and the content checkpoint placed in a Vault Baseline. A Library is a rebuildable view; it is not a
portable entity.

# 2. Common codecs

## 2.1 Typed organization target

```text
{
  0: targetKind, // 1 Collection, 2 Capture
  1: targetId    // Collection ID or Bundle ID
}
```

## 2.2 Scalar value

An optional string is either canonical Unicode text or `null`. Text normalization and size limits
are defined by the active Required Feature Set. The base feature uses Unicode NFC, forbids control
characters other than line feed in Note bodies, and limits labels and titles to 1,024 UTF-8 bytes.

## 2.3 Cause reference sets

Every Cause ID set is sorted, duplicate-free, and contains exact observed current facts. A Cause ID
is a Baseline Cause ID or a descendant Content Event Record ID under
`docs/specifications/core/identifiers.md`. An Event never stores a status, winner selected by time,
or a broad `remove all` marker.

## 2.4 Historical attribution

Capture registration and Note authorship use this non-authoritative presentation record:

```text
{
  0: originVaultId,
  1: memberId,
  2: clientCredentialId,
  3: assertedAt
}
```

For an ordinary Event or same-Vault Vacuum, `originVaultId` is the containing Vault ID and the
member and Credential IDs are the authenticated Event author. A state-only Fork retains the source
attribution tuple without treating those source IDs as destination membership, Credential
authority, DAG ancestry, or dependency. A later Fork preserves the original tuple rather than
rewriting it to the intermediate Vault. Attribution never authorizes an Event.

# 3. Vault and Credential labels

Content type `1`, Vault Label:

```text
{0: label} // nonempty text or null to clear
```

Content type `2`, Client Credential Label:

```text
{0: clientCredentialId, 1: label}
```

Labels use ordinary scalar convergence. A Credential label is shared presentation state and does
not change authority.

# 4. Capture and Collection bodies

Content type `3`, Bundle Registered:

```text
{
  0: bundleId,
  1: bundleDescriptorId, // dependency type 4
  2: assignedCollectionId
}
```

The Event permanently records its initial Collection assignment. The Descriptor dependency reaches
the complete Capture graph.

Content types `4` and `5`, Captures Deleted and Captures Restored:

```text
{0: bundleIds} // nonempty canonical Bundle ID set
```

Content type `6`, Captures Moved:

```text
{
  0: moves,           // nonempty canonical array by Bundle ID
  1: revertsCauseId   // prior Captures Moved cause or null
}

move = {0: bundleId, 1: fromCollectionId, 2: toCollectionId}
```

Content type `7`, Collection Title:

```text
{0: collectionId, 1: title} // title null restores automatic naming
```

Content type `8`, Collections Merged:

```text
{0: sourceCollectionIds, 1: destinationCollectionId}
```

Content type `9`, Collection Merge Reverted:

```text
{0: redirectCauseId} // Collections Merged or Collection Merge Conflict Resolution
```

Content type `10`, Collection Merge Conflict Resolution:

```text
{
  0: conflictingCauseIds, // exact current conflict heads
  1: redirects             // canonical set of {0: sourceCollectionId, 1: destinationCollectionId}
}
```

A conflict resolution's parent state MUST contain the Conflict with exactly the named current Cause
IDs. Its parents descend from every reachable candidate Event; Baseline candidates are observed
through the Baseline rather than named as parents. Its redirects are the complete desired outgoing
edges for the affected identity set and MUST form one exact acyclic graph with at most one
destination per source; an empty set abandons every disputed redirect. The Resolution Event becomes
the controlling reversible redirect fact. Prior heads remain historical facts but cease to affect
current state. Reverting the Resolution removes its replacement redirects and does not reactivate
superseded candidates.

Content type `11`, Collection Folder Placement:

```text
{0: collectionId, 1: folderId} // null means Unfiled
```

# 5. Collection semantics

A Collection is a stable identity grouping Captures considered observations of one subject. It has
no independent delete state. Deleting a Collection in the interface resolves its current Captures
and emits ordinary deletion Events.

Automatic routing compares exact normalized fragmentless URLs with query parameters significant.
Among active matching Collections, the Collection Tail chosen by causal Event order and then
ascending Record ID wins. If none qualifies, or routing would depend on a Collection merge
conflict, a fresh Collection is created. Disconnected duplicates survive; no automatic merge
occurs.

The Tail supplies automatic title, primary URL, representative thumbnail, and routing preference.
An explicit Collection Title overrides it. Merge redirects source identities to the selected
destination without rewriting original Capture assignments. Acyclic compatible redirects compose;
incompatible redirects create a scoped Collection Merge Conflict.

# 6. Folder bodies and semantics

Content type `12`, Folder Created:

```text
{0: folderId, 1: name, 2: parentFolderId} // parent may be null
```

Content type `13`, Folder Renamed:

```text
{0: folderId, 1: name}
```

Content type `14`, Folder Parent Placement:

```text
{0: folderId, 1: parentFolderId} // null means root level
```

Content types `15` and `16`, Folder Deleted and Folder Restored:

```text
{0: folderId}
```

Content type `17`, Folder Conflict Resolution:

```text
{
  0: conflictingCauseIds,
  1: placements // canonical array of {0: folderId, 1: parentFolderId}
}
```

A Folder contains Collections, never Captures. It has zero or one effective parent, and effective
Folders form an acyclic forest. Names need not be unique. `Unfiled` is a derived view with no ID.
Deleting a Folder does not delete Collections or children; views place them at the nearest active
ancestor or Unfiled. Concurrent moves that collectively create a cycle produce one scoped Folder
Conflict. Resolution requires the parent state to contain exactly every named current Cause ID and
supplies a complete acyclic placement for affected Folders. Its parents descend from every
reachable candidate Event; Baseline candidates are observed through the Baseline.

# 7. Tag bodies and semantics

Content type `18`, Tag Created:

```text
{0: tagId, 1: name}
```

Content type `19`, Tag Renamed:

```text
{0: tagId, 1: name}
```

Content type `20`, Tag Assigned:

```text
{0: assignmentId, 1: tagId, 2: target}
```

`assignmentId` is a fresh random 32-byte stable entity ID scoped to the Vault.

Content type `21`, Tag Removed:

```text
{0: assignmentCauseIds} // exact observed active Tag Assigned causes
```

Content types `22` and `23`, Tag Deleted and Tag Restored:

```text
{0: tagId}
```

Content type `24`, Tags Merged:

```text
{0: sourceTagIds, 1: destinationTagId}
```

The signer MUST be a current Administrator.

Content type `25`, Tag Merge Reverted:

```text
{0: redirectCauseId} // Tags Merged or Tag Merge Conflict Resolution
```

The signer MUST be a current Administrator.

Content type `26`, Tag Merge Conflict Resolution:

```text
{
  0: conflictingCauseIds,
  1: redirects // canonical set of {0: sourceTagId, 1: destinationTagId}
}
```

The signer MUST be an unambiguous current Administrator.

The redirects are the complete desired outgoing edges for the affected identity set and MUST form
one exact acyclic graph with at most one destination per source; an empty set abandons every
disputed redirect. The Resolution Event is the controlling reversible redirect fact. Reverting it
removes the replacement redirects and does not reactivate superseded candidates.

Tag identity is its ID, never normalized name. Duplicate names are valid. Assignments target one
Collection or Capture and use observed-remove semantics. A merge redirects identities without
rewriting assignments; the destination name wins. Compatible acyclic redirects compose.
Incompatible redirects create a scoped Tag Merge Conflict. AWSM may suggest cleanup but never
auto-merges same-name Tags.

# 8. Note Content Object

A Note Content Object is a canonical Vault Object:

```text
{
  0: 1,          // noteContentFormat
  1: title,      // optional text or null
  2: body,       // canonical text
  3: bodyDialect // "awsm.note.commonmark" in the base Required Feature
}
```

The base dialect accepts Unicode NFC CommonMark source with LF line endings. Raw HTML and embedded
data URLs are invalid. Rendering sanitizes output, performs no network fetch, and makes an external
HTTP, HTTPS, or mail link an explicit user action. Attachments, wiki links, rich-text operations,
and collaborative text editing require future Required Features.

Its Object ID and encryption use the Object specifications. Title and body form one immutable
whole-Note revision. A Note target is immutable.

# 9. Note bodies and semantics

Content type `27`, Note Created:

```text
{0: noteId, 1: target, 2: noteContentObjectId} // dependency type 6
```

Content type `28`, Note Revised:

```text
{
  0: noteId,
  1: supersededRevisionCauseIds, // exact current revision heads observed
  2: noteContentObjectId          // dependency type 6
}
```

Content types `29` and `30`, Note Deleted and Note Restored:

```text
{0: noteId, 1: observedHeadCauseIds}
```

Content type `31`, Note Conflict Resolution:

```text
{
  0: noteId,
  1: conflictingHeadCauseIds,
  2: retainedOriginalContentId, // dependency type 6; null means original deleted
  3: splitNotes                 // canonical array by fresh Note ID
}

splitNote = {0: noteId, 1: noteContentObjectId}
```

The resolution's parent state MUST contain the Conflict with exactly every named current Cause ID;
its parents descend from each reachable candidate Event and observe Baseline candidates through the
Baseline. It atomically creates every requested split Note. Each non-null content ID is an exact
dependency. Unique concurrent revisions or revision-versus-deletion produce an N-way Note Conflict;
no timestamp or scalar rule selects a version. Members may keep one version, merge manually,
abandon versions, or keep all as separate Notes. Every active member may edit any Note; authorship
remains historical attribution, not ownership.

# 10. Lifecycle reduction

Capture, Folder, and Tag use one reversible lifecycle state. Causal order wins. For concurrent
opposite operations, the deterministic non-time scalar comparator in
`docs/specifications/event/reducers.md` selects the
effective state while preserving both facts. Note lifecycle is the explicit conflict-producing
exception described above.

Deleting a Tag makes assignments dormant; restoring it reactivates still-observed assignments.
Deleting a Folder leaves placements intact but changes the derived view. Deleting a Capture keeps
it restorable and historically addressable until an adopted Vacuum omits it.

# 11. Content Baseline checkpoint

The `contentCheckpoint` in `vault.md` is:

```text
{
  0: 1,                    // contentCheckpointFormat
  1: vaultLabel,
  2: credentialLabels,
  3: captures,
  4: collections,
  5: folders,
  6: tags,
  7: tagAssignments,
  8: notes,
  9: activeConflicts
}
```

Every array is a canonical set. Lifecycle code `1` is Active and `2` is Deleted. The exact entry
codecs are:

```text
credentialLabel = {
  0: clientCredentialId,
  1: label,
  2: headCauseIds
}

capture = {
  0: bundleId,
  1: bundleDescriptorId,
  2: assignedCollectionId,
  3: assignmentHeadCauseIds,
  4: lifecycleState,
  5: lifecycleHeadCauseIds,
  6: registrationCauseId,
  7: registrationAttribution // section 2.4
}

collection = {
  0: collectionId,
  1: explicitTitle,
  2: titleHeadCauseIds,
  3: folderId,
  4: folderHeadCauseIds,
  5: activeRedirect, // null or {0: destinationCollectionId, 1: controllingCauseId}
  6: intrinsicTail,  // section below; exact-ID Collection before redirects
  7: effectiveTail   // section below; current effective merged view
}

folder = {
  0: folderId,
  1: name,
  2: nameHeadCauseIds,
  3: parentFolderId,
  4: parentHeadCauseIds,
  5: lifecycleState,
  6: lifecycleHeadCauseIds
}

tag = {
  0: tagId,
  1: name,
  2: nameHeadCauseIds,
  3: activeRedirect, // null or {0: destinationTagId, 1: controllingCauseId}
  4: lifecycleState,
  5: lifecycleHeadCauseIds
}

tagAssignment = {
  0: assignmentId,
  1: assignedCauseId,
  2: tagId,
  3: target
}

note = {
  0: noteId,
  1: target,
  2: noteState, // 1 Active, 2 Deleted, 3 Conflict
  3: versions
}

noteVersion = {
  0: headCauseId,
  1: noteContentObjectId, // null is a deletion head
  2: restoreContentObjectId, // displaced content for deletion; otherwise null
  3: authorAttribution        // section 2.4
}
```

A checkpointed Collection Tail is `null` or:

```text
{0: bundleId, 1: registrationCauseId}
```

`intrinsicTail` is selected only from active Captures whose exact assigned Collection ID is the
entry's ID. `effectiveTail` is selected across the current acyclic redirect closure and therefore
preserves automatic naming and routing state through Vacuum. Both use the ordinary Collection Tail
rule before checkpointing. A later Event in the successor Generation causally follows the whole
checkpoint. If a later merge or reversion creates a grouping not represented by the checkpointed
effective view, retained checkpoint tails compare as Baseline siblings by ascending registration
Cause ID; no discarded predecessor ancestry is invented.

`vaultLabel` is `{0: label, 1: headCauseIds}`. `tagAssignments` contains only active observed
assignment facts; retaining each `assignedCauseId` lets a later removal name it even though the
predecessor Event is no longer reachable. A Note in state `1` has exactly one non-null version whose
restore field is null, state `2` has one or more null deletion heads whose restore fields retain
their displaced Note Content Object, and state `3` has every current incompatible head. Each
version retains exactly one current or restore Content Object dependency.
Capture and Note attribution retains only the current checkpoint facts required for presentation.
Its opaque source member and Credential IDs are historical provenance, not target authority, and
do not keep predecessor Events reachable or reconstruct discarded activity history.

`activeConflicts` contains:

```text
{
  0: conflictKind, // 1 Collection merge, 2 Folder, 3 Tag merge, 4 Note
  1: subjectIds,
  2: candidates
}

candidate = {
  0: headCauseId,
  1: canonicalTypeSpecificState
}
```

Collection and Tag candidate state is `{0: redirects}`, where `redirects` is the complete canonical
set of direct `{0: sourceId, 1: destinationId}` edges asserted by that controlling Event. Folder
candidate state is `{0: placements}`, a canonical set of `{0: folderId, 1: parentFolderId}` values.
Note candidate state is
`{0: noteId, 1: contentObjectId}`, where `null` means deletion. These Baseline Cause IDs are opaque
candidate identities in the checkpoint, not reachable Record dependencies. A successor resolution
names the exact candidate IDs stored in its Baseline.

Checkpoint conflict candidates seed the ordinary Collection, Folder, Tag, and Note reducers. A
descendant exact Resolution consumes those Baseline Cause IDs exactly as it would consume current
Event candidates. The ordinary state arrays MUST NOT duplicate a fact retained inside an active
conflict candidate. In particular, a Folder in an active Folder Conflict has a null ordinary
`parentFolderId` and an empty ordinary parent Cause set; its complete candidate placements exist
only in `activeConflicts` until Resolution.

Intrinsic Capture provenance remains in the Descriptor rather than being duplicated by the
checkpoint.

The Baseline dependency set MUST exactly reach every retained Bundle Descriptor, Artifact Object,
Note Content Object, Key Envelope, and Feature Manifest required by these checkpoints. Artifact
wrappers are randomized physical representations resolved through Replica Safety State, not typed
dependencies. The Baseline does not retain superseded Event history merely to explain how current
state arose.

# 12. Vacuum and merge boundaries

Vacuum omits Deleted Captures and their Capture-scoped Tags and Notes. A member must first restore,
copy a Note under a fresh ID and valid target, Fork, Export, or postpone to preserve such data.
Vacuum may omit empty Collections, deleted Folders, and deleted Tags only after checkpointing every
retained relationship without dangling targets. It cannot silently resolve an active conflict.

# 13. Invariants

- Stable IDs, not names or titles, define identity.
- Capture never waits for an organization conflict.
- Separate Notes with equal titles remain separate.
- Collection, Folder, and Tag merges are explicit and reversible.
- Every observed-remove Event names exact facts.
- Every conflict retains all authenticated heads until explicit resolution or Vacuum selection.
- Library, Unfiled, ordering, excerpts, and search are derived views.

# References

- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/vacuum.md`
- `docs/specifications/bundle/bundle.md`
