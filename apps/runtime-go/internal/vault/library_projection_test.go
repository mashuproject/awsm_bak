package vault

import (
	"crypto/ed25519"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

func TestProjectLibraryProjectionIncludesCollectionTitle(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	collectionID := filledCreationID(190)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 7,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 200, Body: canonical.Map{0: collectionID[:], 1: "Saved pages"},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Collection Title: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Collection Title: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Collections) != 1 {
		t.Fatalf("Collections = %#v, want one collection", projection.Collections)
	}
	collection := projection.Collections[0]
	if collection.CollectionID != hexIdentifier(collectionID) || collection.Title != "Saved pages" || collection.ExplicitTitle == nil || *collection.ExplicitTitle != "Saved pages" {
		t.Fatalf("Collection projection = %#v", collection)
	}
}

func TestProjectLibraryProjectionIncludesCollectionRedirect(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	sourceID := filledCreationID(191)
	destinationID := filledCreationID(192)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 8,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 201, Body: canonical.Map{0: canonicalSetValues([]canonical.Value{sourceID[:]}), 1: destinationID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Collections Merged: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Collections Merged: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Collections) != 2 {
		t.Fatalf("Collections = %#v, want source and destination", projection.Collections)
	}
	var source, destination LibraryCollection
	for _, collection := range projection.Collections {
		switch collection.CollectionID {
		case hexIdentifier(sourceID):
			source = collection
		case hexIdentifier(destinationID):
			destination = collection
		}
	}
	if source.RedirectedTo == nil || *source.RedirectedTo != hexIdentifier(destinationID) {
		t.Fatalf("source redirect = %#v, want destination", source.RedirectedTo)
	}
	if destination.RedirectedTo != nil {
		t.Fatalf("destination redirect = %#v, want nil", destination.RedirectedTo)
	}
}

func TestProjectLibraryProjectionIncludesFolderState(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	folderID := filledCreationID(193)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 12,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 202, Body: canonical.Map{0: folderID[:], 1: "Reading", 2: nil},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Folder Created: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Folder Created: %v", err)
	}
	rename, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{event.RecordID}, AuthorityParentIDs: []canonical.Identifier{event.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 13,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 203, Body: canonical.Map{0: folderID[:], 1: "Reading list"},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Folder Renamed: %v", err)
	}
	if err := replica.AdmitEvent(rename, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Folder Renamed: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Folders) != 1 {
		t.Fatalf("Folders = %#v, want one folder", projection.Folders)
	}
	folder := projection.Folders[0]
	if folder.FolderID != hexIdentifier(folderID) || folder.Name != "Reading list" || folder.ParentFolderID != nil || folder.Lifecycle != "Active" {
		t.Fatalf("Folder projection = %#v", folder)
	}
}

func TestProjectLibraryProjectionIncludesObservedTagAssignment(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	tagID := filledCreationID(194)
	assignmentID := filledCreationID(195)
	collectionID := filledCreationID(196)
	create, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 18,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 204, Body: canonical.Map{0: tagID[:], 1: "Reading"},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Tag Created: %v", err)
	}
	if err := replica.AdmitEvent(create, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Tag Created: %v", err)
	}
	assign, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{create.RecordID}, AuthorityParentIDs: []canonical.Identifier{create.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 20,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 205, Body: canonical.Map{0: assignmentID[:], 1: tagID[:], 2: canonical.Map{0: uint64(1), 1: collectionID[:]}},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Tag Assigned: %v", err)
	}
	if err := replica.AdmitEvent(assign, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Tag Assigned: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Tags) != 1 || projection.Tags[0].TagID != hexIdentifier(tagID) || projection.Tags[0].Name != "Reading" {
		t.Fatalf("Tags = %#v", projection.Tags)
	}
	if len(projection.TagAssignments) != 1 || projection.TagAssignments[0].AssignmentID != hexIdentifier(assignmentID) || projection.TagAssignments[0].TagID != hexIdentifier(tagID) || projection.TagAssignments[0].TargetID != hexIdentifier(collectionID) || !projection.TagAssignments[0].Active {
		t.Fatalf("Tag assignments = %#v", projection.TagAssignments)
	}
	remove, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{assign.RecordID}, AuthorityParentIDs: []canonical.Identifier{assign.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 21,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 206, Body: canonical.Map{0: canonicalSetValues([]canonical.Value{assign.RecordID[:]})},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Tag Removed: %v", err)
	}
	if err := replica.AdmitEvent(remove, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Tag Removed: %v", err)
	}
	projection, err = ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection after removal: %v", err)
	}
	if len(projection.TagAssignments) != 0 {
		t.Fatalf("Tag assignments after removal = %#v, want empty", projection.TagAssignments)
	}
}

func TestProjectLibraryProjectionIncludesNoteRevision(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	noteID := filledCreationID(197)
	collectionID := filledCreationID(198)
	contentBody := canonical.Map{0: uint64(1), 1: "Research", 2: "First body", 3: "awsm.note.commonmark"}
	objectBytes, err := canonical.EncodeValue(canonical.Map{0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(3), 3: prepared.RequiredFeatureSetID[:], 4: contentBody, 5: map[string][]byte{}})
	if err != nil {
		t.Fatalf("Encode Note Content Object: %v", err)
	}
	objectID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 3, objectBytes)
	if err != nil {
		t.Fatalf("Note Content Object ID: %v", err)
	}
	if err := replica.AdmitObject(objectID, objectBytes); err != nil {
		t.Fatalf("Admit Note Content Object: %v", err)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: []canonical.Dependency{{Type: 6, ID: objectID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 27, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 207, Body: canonical.Map{0: noteID[:], 1: canonical.Map{0: uint64(1), 1: collectionID[:]}, 2: objectID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Note Created: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Note Created: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Notes) != 1 {
		t.Fatalf("Notes = %#v, want one note", projection.Notes)
	}
	note := projection.Notes[0]
	if note.NoteID != hexIdentifier(noteID) || note.State != "Active" || len(note.Versions) != 1 || note.Versions[0].Title == nil || *note.Versions[0].Title != "Research" || note.Versions[0].Body == nil || *note.Versions[0].Body != "First body" {
		t.Fatalf("Note projection = %#v", note)
	}
	revised, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{event.RecordID}, AuthorityParentIDs: []canonical.Identifier{event.RecordID},
		Dependencies: []canonical.Dependency{{Type: 6, ID: objectID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 28, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 208, Body: canonical.Map{0: noteID[:], 1: canonicalSetValues([]canonical.Value{event.RecordID[:]}), 2: objectID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Note Revised: %v", err)
	}
	if err := replica.AdmitEvent(revised, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Note Revised: %v", err)
	}
	projection, err = ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection after revision: %v", err)
	}
	if len(projection.Notes) != 1 || projection.Notes[0].State != "Active" || len(projection.Notes[0].Versions) != 1 || projection.Notes[0].Versions[0].HeadCauseID != hexIdentifier(revised.RecordID) {
		t.Fatalf("Note projection after revision = %#v", projection.Notes)
	}
	branch, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{event.RecordID}, AuthorityParentIDs: []canonical.Identifier{event.RecordID},
		Dependencies: []canonical.Dependency{{Type: 6, ID: objectID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 28, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 209, Body: canonical.Map{0: noteID[:], 1: canonicalSetValues([]canonical.Value{event.RecordID[:]}), 2: objectID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign concurrent Note Revised: %v", err)
	}
	if err := replica.AdmitEvent(branch, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit concurrent Note Revised: %v", err)
	}
	projection, err = ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection after conflict: %v", err)
	}
	if len(projection.Notes) != 1 || projection.Notes[0].State != "Conflict" || len(projection.Notes[0].Versions) != 2 {
		t.Fatalf("Note projection after conflict = %#v", projection.Notes)
	}
	resolutionParents := sortUniqueIdentifiers([]canonical.Identifier{revised.RecordID, branch.RecordID})
	resolution, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: resolutionParents, AuthorityParentIDs: resolutionParents,
		Dependencies: []canonical.Dependency{{Type: 6, ID: objectID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 31, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 210, Body: canonical.Map{0: noteID[:], 1: canonicalSetValues([]canonical.Value{revised.RecordID[:], branch.RecordID[:]}), 2: objectID[:], 3: []canonical.Value{}},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Note Conflict Resolution: %v", err)
	}
	if err := replica.AdmitEvent(resolution, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Note Conflict Resolution: %v", err)
	}
	projection, err = ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection after resolution: %v", err)
	}
	if len(projection.Notes) != 1 || projection.Notes[0].State != "Active" || len(projection.Notes[0].Versions) != 1 || projection.Notes[0].Versions[0].HeadCauseID != hexIdentifier(resolution.RecordID) {
		t.Fatalf("Note projection after resolution = %#v", projection.Notes)
	}
}

func TestProjectLibraryProjectionSurfacesCollectionMergeConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	sourceID := filledCreationID(199)
	destinationA := filledCreationID(200)
	destinationB := filledCreationID(201)
	signMerge := func(destination canonical.Identifier, assertedAt int64) canonical.Event {
		event, signErr := canonical.SignEvent(canonical.EventInput{
			VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
			ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
			RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 8,
			SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: assertedAt, Body: canonical.Map{0: canonicalSetValues([]canonical.Value{sourceID[:]}), 1: destination[:]},
		}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
		if signErr != nil {
			t.Fatalf("Sign Collections Merged: %v", signErr)
		}
		return event
	}
	mergeA := signMerge(destinationA, 211)
	mergeB := signMerge(destinationB, 212)
	for _, event := range []canonical.Event{mergeA, mergeB} {
		if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
			t.Fatalf("Admit Collections Merged: %v", err)
		}
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Conflicts) != 1 || projection.Conflicts[0].Kind != "CollectionMerge" {
		t.Fatalf("Collection conflicts = %#v", projection.Conflicts)
	}
}

func TestProjectLibraryProjectionAppliesCollectionMergeResolution(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	publicKey := ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)
	privateKey := ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey)
	if err := replica.AdmitEvent(prepared.Genesis, publicKey); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	sourceID := filledCreationID(202)
	destinationA := filledCreationID(203)
	destinationB := filledCreationID(204)
	sign := func(parents []canonical.Identifier, eventType uint64, body canonical.Value) canonical.Event {
		event, signErr := canonical.SignEvent(canonical.EventInput{
			VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
			ParentRecordIDs: parents, AuthorityParentIDs: parents, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
			Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: eventType,
			SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 220 + int64(eventType), Body: body,
		}, privateKey)
		if signErr != nil {
			t.Fatalf("Sign Content Event %d: %v", eventType, signErr)
		}
		return event
	}
	mergeA := sign([]canonical.Identifier{prepared.Genesis.RecordID}, 8, canonical.Map{
		0: canonicalSetValues([]canonical.Value{sourceID[:]}), 1: destinationA[:],
	})
	mergeB := sign([]canonical.Identifier{prepared.Genesis.RecordID}, 8, canonical.Map{
		0: canonicalSetValues([]canonical.Value{sourceID[:]}), 1: destinationB[:],
	})
	for _, event := range []canonical.Event{mergeA, mergeB} {
		if err := replica.AdmitEvent(event, publicKey); err != nil {
			t.Fatalf("Admit merge: %v", err)
		}
	}
	resolutionParents := sortUniqueIdentifiers([]canonical.Identifier{mergeA.RecordID, mergeB.RecordID})
	resolution := sign(resolutionParents, 10, canonical.Map{
		0: canonicalSetValues([]canonical.Value{mergeA.RecordID[:], mergeB.RecordID[:]}),
		1: []canonical.Value{canonical.Map{0: sourceID[:], 1: destinationB[:]}},
	})
	if err := replica.AdmitEvent(resolution, publicKey); err != nil {
		t.Fatalf("Admit merge resolution: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Conflicts) != 0 {
		t.Fatalf("Collection conflicts after resolution = %#v, want none", projection.Conflicts)
	}
	for _, collection := range projection.Collections {
		if collection.CollectionID == hexIdentifier(sourceID) {
			if collection.RedirectedTo == nil || *collection.RedirectedTo != hexIdentifier(destinationB) {
				t.Fatalf("resolved source redirect = %#v, want %s", collection.RedirectedTo, hexIdentifier(destinationB))
			}
			return
		}
	}
	t.Fatalf("resolved source Collection %s was not projected", hexIdentifier(sourceID))
}

func TestProjectLibraryProjectionSurfacesAndResolvesFolderCycle(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	publicKey := ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)
	privateKey := ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey)
	if err := replica.AdmitEvent(prepared.Genesis, publicKey); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	folderA := filledCreationID(205)
	folderB := filledCreationID(206)
	sign := func(parents []canonical.Identifier, eventType uint64, body canonical.Value, assertedAt int64) canonical.Event {
		event, signErr := canonical.SignEvent(canonical.EventInput{
			VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
			ParentRecordIDs: parents, AuthorityParentIDs: parents, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
			Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: eventType,
			SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: assertedAt, Body: body,
		}, privateKey)
		if signErr != nil {
			t.Fatalf("Sign Folder Event %d: %v", eventType, signErr)
		}
		return event
	}
	createdA := sign([]canonical.Identifier{prepared.Genesis.RecordID}, 12, canonical.Map{0: folderA[:], 1: "A", 2: nil}, 230)
	createdB := sign([]canonical.Identifier{prepared.Genesis.RecordID}, 12, canonical.Map{0: folderB[:], 1: "B", 2: nil}, 231)
	for _, event := range []canonical.Event{createdA, createdB} {
		if err := replica.AdmitEvent(event, publicKey); err != nil {
			t.Fatalf("Admit Folder Created: %v", err)
		}
	}
	moveA := sign([]canonical.Identifier{createdA.RecordID}, 14, canonical.Map{0: folderA[:], 1: folderB[:]}, 232)
	moveB := sign([]canonical.Identifier{createdB.RecordID}, 14, canonical.Map{0: folderB[:], 1: folderA[:]}, 233)
	for _, event := range []canonical.Event{moveA, moveB} {
		if err := replica.AdmitEvent(event, publicKey); err != nil {
			t.Fatalf("Admit Folder Parent Placement: %v", err)
		}
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection with cycle: %v", err)
	}
	if len(projection.Conflicts) != 1 || projection.Conflicts[0].Kind != "Folder" {
		t.Fatalf("Folder conflicts = %#v, want one cycle conflict", projection.Conflicts)
	}
	resolutionParents := sortUniqueIdentifiers([]canonical.Identifier{moveA.RecordID, moveB.RecordID})
	resolution := sign(resolutionParents, 17, canonical.Map{
		0: canonicalSetValues([]canonical.Value{moveA.RecordID[:], moveB.RecordID[:]}),
		1: []canonical.Value{
			canonical.Map{0: folderA[:], 1: nil},
			canonical.Map{0: folderB[:], 1: nil},
		},
	}, 234)
	if err := replica.AdmitEvent(resolution, publicKey); err != nil {
		t.Fatalf("Admit Folder Conflict Resolution: %v", err)
	}
	projection, err = ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection after Folder resolution: %v", err)
	}
	if len(projection.Conflicts) != 0 {
		t.Fatalf("Folder conflicts after resolution = %#v, want none", projection.Conflicts)
	}
	for _, folder := range projection.Folders {
		if folder.FolderID == hexIdentifier(folderA) || folder.FolderID == hexIdentifier(folderB) {
			if folder.ParentFolderID != nil {
				t.Fatalf("resolved Folder %s parent = %v, want nil", folder.FolderID, folder.ParentFolderID)
			}
		}
	}
}

func TestProjectLibraryProjectionSurfacesAndResolvesTagMergeConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	publicKey := ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)
	privateKey := ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey)
	if err := replica.AdmitEvent(prepared.Genesis, publicKey); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	tagSource := filledCreationID(207)
	tagA := filledCreationID(208)
	tagB := filledCreationID(209)
	sign := func(parents []canonical.Identifier, eventType uint64, body canonical.Value, assertedAt int64) canonical.Event {
		event, signErr := canonical.SignEvent(canonical.EventInput{
			VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
			ParentRecordIDs: parents, AuthorityParentIDs: parents, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
			Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: eventType,
			SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: assertedAt, Body: body,
		}, privateKey)
		if signErr != nil {
			t.Fatalf("Sign Tag Event %d: %v", eventType, signErr)
		}
		return event
	}
	created := []canonical.Event{
		sign([]canonical.Identifier{prepared.Genesis.RecordID}, 18, canonical.Map{0: tagSource[:], 1: "Source"}, 240),
		sign([]canonical.Identifier{prepared.Genesis.RecordID}, 18, canonical.Map{0: tagA[:], 1: "A"}, 241),
		sign([]canonical.Identifier{prepared.Genesis.RecordID}, 18, canonical.Map{0: tagB[:], 1: "B"}, 242),
	}
	for _, event := range created {
		if err := replica.AdmitEvent(event, publicKey); err != nil {
			t.Fatalf("Admit Tag Created: %v", err)
		}
	}
	mergeA := sign([]canonical.Identifier{created[0].RecordID, created[1].RecordID}, 24, canonical.Map{0: canonicalSetValues([]canonical.Value{tagSource[:]}), 1: tagA[:]}, 243)
	mergeB := sign([]canonical.Identifier{created[0].RecordID, created[2].RecordID}, 24, canonical.Map{0: canonicalSetValues([]canonical.Value{tagSource[:]}), 1: tagB[:]}, 244)
	for _, event := range []canonical.Event{mergeA, mergeB} {
		if err := replica.AdmitEvent(event, publicKey); err != nil {
			t.Fatalf("Admit Tags Merged: %v", err)
		}
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection with tag conflict: %v", err)
	}
	if len(projection.Conflicts) != 1 || projection.Conflicts[0].Kind != "TagMerge" {
		t.Fatalf("Tag conflicts = %#v, want one conflict", projection.Conflicts)
	}
	resolutionParents := sortUniqueIdentifiers([]canonical.Identifier{mergeA.RecordID, mergeB.RecordID})
	resolution := sign(resolutionParents, 26, canonical.Map{
		0: canonicalSetValues([]canonical.Value{mergeA.RecordID[:], mergeB.RecordID[:]}),
		1: []canonical.Value{canonical.Map{0: tagSource[:], 1: tagB[:]}},
	}, 245)
	if err := replica.AdmitEvent(resolution, publicKey); err != nil {
		t.Fatalf("Admit Tag Merge Conflict Resolution: %v", err)
	}
	projection, err = ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection after tag resolution: %v", err)
	}
	if len(projection.Conflicts) != 0 {
		t.Fatalf("Tag conflicts after resolution = %#v, want none", projection.Conflicts)
	}
	for _, tag := range projection.Tags {
		if tag.TagID == hexIdentifier(tagSource) {
			if tag.RedirectedTo == nil || *tag.RedirectedTo != hexIdentifier(tagB) {
				t.Fatalf("resolved tag redirect = %#v, want %s", tag.RedirectedTo, hexIdentifier(tagB))
			}
			return
		}
	}
	t.Fatalf("resolved source Tag %s was not projected", hexIdentifier(tagSource))
}
