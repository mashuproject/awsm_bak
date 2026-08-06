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
