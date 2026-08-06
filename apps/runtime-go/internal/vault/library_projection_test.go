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
