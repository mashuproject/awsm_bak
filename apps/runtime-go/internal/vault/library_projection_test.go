package vault

import (
	"bytes"
	"crypto/ed25519"
	"sort"
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

func TestProjectLibraryProjectionSeedsCollectionTitleFromBaselineCheckpoint(t *testing.T) {
	prepared := deterministicCreation(t)
	collectionID := filledCreationID(220)
	causeID := filledCreationID(221)
	body, ok := replicaMapValue(prepared.Baseline.Body)
	if !ok {
		t.Fatal("creation Baseline body is not a map")
	}
	contentValue := replicaMapEntryMust(body, 2)
	contentCheckpoint, ok := contentValue.(map[any]any)
	if !ok {
		t.Fatalf("creation content checkpoint is not a canonical map: %T %#v", contentValue, contentValue)
	}
	contentCheckpoint[uint64(4)] = []canonical.Value{canonical.Map{
		0: collectionID[:],
		1: "Saved pages",
		2: canonicalSetValues([]canonical.Value{causeID[:]}),
		3: nil,
		4: []canonical.Value{},
		5: nil,
		6: nil,
		7: nil,
	}}
	checkpointedBaseline, err := canonical.EncodeBaseline(canonical.BaselineInput{
		VaultID:              prepared.Baseline.VaultID,
		GenerationID:         prepared.Baseline.GenerationID,
		Dependencies:         prepared.Baseline.Dependencies,
		RequiredFeatureSetID: prepared.Baseline.RequiredFeatureSetID,
		Extensions:           prepared.Baseline.Extensions,
		Body:                 body,
	})
	if err != nil {
		t.Fatalf("encode checkpointed Baseline: %v", err)
	}
	replica, err := NewReplica(checkpointedBaseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Collections) != 1 {
		t.Fatalf("Collections = %#v, want one checkpointed collection", projection.Collections)
	}
	collection := projection.Collections[0]
	if collection.CollectionID != hexIdentifier(collectionID) || collection.Title != "Saved pages" || collection.ExplicitTitle == nil || *collection.ExplicitTitle != "Saved pages" {
		t.Fatalf("checkpointed Collection projection = %#v", collection)
	}
}

func TestProjectLibraryProjectionSeedsOrganizationStateFromBaselineCheckpoint(t *testing.T) {
	prepared := deterministicCreation(t)
	collectionID := filledCreationID(230)
	collectionTitleCauseID := filledCreationID(231)
	folderID := filledCreationID(232)
	folderCauseID := filledCreationID(233)
	tagID := filledCreationID(234)
	tagCauseID := filledCreationID(235)
	assignmentID := filledCreationID(236)
	assignmentCauseID := filledCreationID(237)
	body, ok := replicaMapValue(prepared.Baseline.Body)
	if !ok {
		t.Fatal("creation Baseline body is not a map")
	}
	contentValue := replicaMapEntryMust(body, 2)
	contentCheckpoint, ok := contentValue.(map[any]any)
	if !ok {
		t.Fatalf("creation content checkpoint is not a canonical map: %T %#v", contentValue, contentValue)
	}
	contentCheckpoint[uint64(4)] = []canonical.Value{canonical.Map{
		0: collectionID[:],
		1: "Saved pages",
		2: canonicalSetValues([]canonical.Value{collectionTitleCauseID[:]}),
		3: folderID[:],
		4: canonicalSetValues([]canonical.Value{folderCauseID[:]}),
		5: nil,
		6: nil,
		7: nil,
	}}
	contentCheckpoint[uint64(5)] = []canonical.Value{canonical.Map{
		0: folderID[:],
		1: "Reading",
		2: canonicalSetValues([]canonical.Value{folderCauseID[:]}),
		3: nil,
		4: []canonical.Value{},
		5: uint64(1),
		6: canonicalSetValues([]canonical.Value{folderCauseID[:]}),
	}}
	contentCheckpoint[uint64(6)] = []canonical.Value{canonical.Map{
		0: tagID[:],
		1: "Reading",
		2: canonicalSetValues([]canonical.Value{tagCauseID[:]}),
		3: nil,
		4: uint64(1),
		5: canonicalSetValues([]canonical.Value{tagCauseID[:]}),
	}}
	contentCheckpoint[uint64(7)] = []canonical.Value{canonical.Map{
		0: assignmentID[:],
		1: assignmentCauseID[:],
		2: tagID[:],
		3: canonical.Map{0: uint64(1), 1: collectionID[:]},
	}}
	checkpointedBaseline, err := canonical.EncodeBaseline(canonical.BaselineInput{
		VaultID:              prepared.Baseline.VaultID,
		GenerationID:         prepared.Baseline.GenerationID,
		Dependencies:         prepared.Baseline.Dependencies,
		RequiredFeatureSetID: prepared.Baseline.RequiredFeatureSetID,
		Extensions:           prepared.Baseline.Extensions,
		Body:                 body,
	})
	if err != nil {
		t.Fatalf("encode checkpointed Baseline: %v", err)
	}
	replica, err := NewReplica(checkpointedBaseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Collections) != 1 || projection.Collections[0].FolderID == nil || *projection.Collections[0].FolderID != hexIdentifier(folderID) {
		t.Fatalf("checkpointed Collection projection = %#v, want folder placement", projection.Collections)
	}
	if len(projection.Folders) != 1 || projection.Folders[0].FolderID != hexIdentifier(folderID) || projection.Folders[0].Name != "Reading" || projection.Folders[0].Lifecycle != "Active" {
		t.Fatalf("checkpointed Folder projection = %#v", projection.Folders)
	}
	if len(projection.Tags) != 1 || projection.Tags[0].TagID != hexIdentifier(tagID) || projection.Tags[0].Name != "Reading" || projection.Tags[0].Lifecycle != "Active" {
		t.Fatalf("checkpointed Tag projection = %#v", projection.Tags)
	}
	if len(projection.TagAssignments) != 1 || projection.TagAssignments[0].AssignmentID != hexIdentifier(assignmentID) || projection.TagAssignments[0].TagID != hexIdentifier(tagID) || !projection.TagAssignments[0].Active {
		t.Fatalf("checkpointed Tag Assignment projection = %#v", projection.TagAssignments)
	}
}

func TestBuildVacuumContentCheckpointPreservesOrganizationState(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	collectionID := filledCreationID(240)
	folderID := filledCreationID(241)
	tagID := filledCreationID(242)
	assignmentID := filledCreationID(243)
	title := "Saved pages"
	checkpoint, err := buildVacuumContentCheckpoint(replica, LibraryProjection{
		Collections:    []LibraryCollection{{CollectionID: hexIdentifier(collectionID), ExplicitTitle: &title, Title: title, FolderID: pointerString(hexIdentifier(folderID))}},
		Folders:        []LibraryFolder{{FolderID: hexIdentifier(folderID), Name: "Reading", Lifecycle: "Active"}},
		Tags:           []LibraryTag{{TagID: hexIdentifier(tagID), Name: "Reading", Lifecycle: "Active"}},
		TagAssignments: []LibraryTagAssignment{{AssignmentID: hexIdentifier(assignmentID), TagID: hexIdentifier(tagID), TargetKind: 1, TargetID: hexIdentifier(collectionID), Active: true}},
	})
	if err != nil {
		t.Fatalf("buildVacuumContentCheckpoint: %v", err)
	}
	collections, ok := replicaMapArray(checkpoint, 4)
	if !ok || len(collections) != 1 {
		t.Fatalf("Collection checkpoint = %#v", collections)
	}
	if folder, err := nullableIdentifier(replicaMapEntryMust(collections[0], 3), "Collection folder"); err != nil || folder == nil || *folder != folderID {
		t.Fatalf("Collection folder checkpoint = %v, %v", folder, err)
	}
	folders, ok := replicaMapArray(checkpoint, 5)
	if !ok || len(folders) != 1 {
		t.Fatalf("Folder checkpoint = %#v", folders)
	}
	if name, ok := replicaMapText(folders[0], 1); !ok || name != "Reading" {
		t.Fatalf("Folder checkpoint = %#v", folders[0])
	}
	tags, ok := replicaMapArray(checkpoint, 6)
	if !ok || len(tags) != 1 {
		t.Fatalf("Tag checkpoint = %#v", tags)
	}
	assignments, ok := replicaMapArray(checkpoint, 7)
	if !ok || len(assignments) != 1 {
		t.Fatalf("Tag assignment checkpoint = %#v", assignments)
	}
}

func TestProjectLibraryProjectionSeedsNoteFromBaselineCheckpoint(t *testing.T) {
	prepared := deterministicCreation(t)
	noteID := filledCreationID(250)
	noteCauseID := filledCreationID(251)
	collectionID := filledCreationID(252)
	contentBody := canonical.Map{0: uint64(1), 1: "A note", 2: "First body", 3: "awsm.note.commonmark"}
	contentBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.Baseline.VaultID[:], 2: uint64(3), 3: prepared.Baseline.RequiredFeatureSetID[:], 4: contentBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatalf("encode Note Content Object: %v", err)
	}
	contentObjectID, err := canonical.VaultObjectID(prepared.Baseline.VaultID, 3, contentBytes)
	if err != nil {
		t.Fatalf("derive Note Content Object ID: %v", err)
	}
	body, ok := replicaMapValue(prepared.Baseline.Body)
	if !ok {
		t.Fatal("creation Baseline body is not a map")
	}
	contentValue := replicaMapEntryMust(body, 2)
	contentCheckpoint, ok := contentValue.(map[any]any)
	if !ok {
		t.Fatalf("creation content checkpoint is not a canonical map: %T %#v", contentValue, contentValue)
	}
	contentCheckpoint[uint64(8)] = []canonical.Value{canonical.Map{
		0: noteID[:],
		1: canonical.Map{0: uint64(1), 1: collectionID[:]},
		2: uint64(1),
		3: []canonical.Value{canonical.Map{
			0: noteCauseID[:], 1: contentObjectID[:], 2: nil,
			3: canonical.Map{0: prepared.Baseline.VaultID[:], 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.ClientCredentialID[:], 3: int64(250)},
		}},
	}}
	dependencies := append(append([]canonical.Dependency(nil), prepared.Baseline.Dependencies...), canonical.Dependency{Type: 6, ID: contentObjectID})
	sort.Slice(dependencies, func(left, right int) bool {
		if dependencies[left].Type != dependencies[right].Type {
			return dependencies[left].Type < dependencies[right].Type
		}
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	checkpointedBaseline, err := canonical.EncodeBaseline(canonical.BaselineInput{
		VaultID:              prepared.Baseline.VaultID,
		GenerationID:         prepared.Baseline.GenerationID,
		Dependencies:         dependencies,
		RequiredFeatureSetID: prepared.Baseline.RequiredFeatureSetID,
		Extensions:           prepared.Baseline.Extensions,
		Body:                 body,
	})
	if err != nil {
		t.Fatalf("encode checkpointed Baseline: %v", err)
	}
	replica, err := NewReplica(checkpointedBaseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitObject(contentObjectID, contentBytes); err != nil {
		t.Fatalf("Admit Note Content Object: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Notes) != 1 {
		t.Fatalf("Notes = %#v, want one checkpointed Note", projection.Notes)
	}
	note := projection.Notes[0]
	if note.NoteID != hexIdentifier(noteID) || note.TargetKind != 1 || note.TargetID != hexIdentifier(collectionID) || note.State != "Active" || len(note.Versions) != 1 {
		t.Fatalf("checkpointed Note projection = %#v", note)
	}
	version := note.Versions[0]
	if version.HeadCauseID != hexIdentifier(noteCauseID) || version.ContentObjectID == nil || *version.ContentObjectID != hexIdentifier(contentObjectID) || version.Title == nil || *version.Title != "A note" || version.Body == nil || *version.Body != "First body" || version.BodyDialect == nil || *version.BodyDialect != "awsm.note.commonmark" || version.AssertedAt != 250 {
		t.Fatalf("checkpointed Note version = %#v", version)
	}
}

func TestProjectLibraryProjectionSeedsCaptureFromBaselineCheckpoint(t *testing.T) {
	prepared := deterministicCreation(t)
	bundleID := filledCreationID(160)
	descriptorID := filledCreationID(161)
	artifactID := filledCreationID(162)
	collectionID := filledCreationID(163)
	assignmentCauseID := filledCreationID(164)
	lifecycleCauseID := filledCreationID(165)
	registrationCauseID := filledCreationID(166)
	descriptorBody := canonical.Map{
		0: uint64(1), 1: bundleID[:], 2: int64(1234), 3: "https://example.test/a", 4: "https://example.test/b",
		5: "awsm.capture.web-page-snapshot", 6: "awsm.adapter.browser-web-page", 7: uint64(1), 8: "Example",
		9: []canonical.Value{canonical.Map{0: artifactID[:], 1: "awsm.artifact.primary"}}, 10: []canonical.Value{}, 11: canonical.Map{0: uint64(1), 1: []byte{0xa1, 0x00, 0x01}},
	}
	descriptorBytes, err := canonical.EncodeValue(canonical.Map{0: uint64(1), 1: prepared.Baseline.VaultID[:], 2: uint64(1), 3: prepared.Baseline.RequiredFeatureSetID[:], 4: descriptorBody, 5: map[string][]byte{}})
	if err != nil {
		t.Fatalf("encode Bundle Descriptor: %v", err)
	}
	derivedDescriptorID, err := canonical.VaultObjectID(prepared.Baseline.VaultID, 1, descriptorBytes)
	if err != nil {
		t.Fatalf("derive Bundle Descriptor ID: %v", err)
	}
	if derivedDescriptorID != descriptorID {
		descriptorID = derivedDescriptorID
	}
	body, ok := replicaMapValue(prepared.Baseline.Body)
	if !ok {
		t.Fatal("creation Baseline body is not a map")
	}
	contentValue := replicaMapEntryMust(body, 2)
	contentCheckpoint, ok := contentValue.(map[any]any)
	if !ok {
		t.Fatalf("creation content checkpoint is not a canonical map: %T %#v", contentValue, contentValue)
	}
	contentCheckpoint[uint64(3)] = []canonical.Value{canonical.Map{
		0: bundleID[:], 1: descriptorID[:], 2: collectionID[:],
		3: canonicalSetValues([]canonical.Value{assignmentCauseID[:]}), 4: uint64(1),
		5: canonicalSetValues([]canonical.Value{lifecycleCauseID[:]}), 6: registrationCauseID[:],
		7: canonical.Map{0: prepared.Baseline.VaultID[:], 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.ClientCredentialID[:], 3: int64(1234)},
	}}
	dependencies := append(append([]canonical.Dependency(nil), prepared.Baseline.Dependencies...), canonical.Dependency{Type: 4, ID: descriptorID}, canonical.Dependency{Type: 5, ID: artifactID})
	sort.Slice(dependencies, func(left, right int) bool {
		if dependencies[left].Type != dependencies[right].Type {
			return dependencies[left].Type < dependencies[right].Type
		}
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	checkpointedBaseline, err := canonical.EncodeBaseline(canonical.BaselineInput{
		VaultID: prepared.Baseline.VaultID, GenerationID: prepared.Baseline.GenerationID, Dependencies: dependencies,
		RequiredFeatureSetID: prepared.Baseline.RequiredFeatureSetID, Extensions: prepared.Baseline.Extensions, Body: body,
	})
	if err != nil {
		t.Fatalf("encode checkpointed Baseline: %v", err)
	}
	replica, err := NewReplica(checkpointedBaseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitObject(descriptorID, descriptorBytes); err != nil {
		t.Fatalf("Admit Bundle Descriptor: %v", err)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Captures) != 1 {
		t.Fatalf("Captures = %#v, want one checkpointed Capture", projection.Captures)
	}
	capture := projection.Captures[0]
	if capture.BundleID != hexIdentifier(bundleID) || capture.CollectionID != hexIdentifier(collectionID) || capture.ArtifactID != hexIdentifier(artifactID) || capture.CapturedAt != 1234 || capture.OriginalURL != "https://example.test/a" || capture.FinalURL != "https://example.test/b" || capture.Title == nil || *capture.Title != "Example" || capture.Lifecycle != "Active" {
		t.Fatalf("checkpointed Capture projection = %#v", capture)
	}
	checkpoint, err := buildVacuumContentCheckpoint(replica, projection)
	if err != nil {
		t.Fatalf("buildVacuumContentCheckpoint: %v", err)
	}
	captures, ok := replicaMapArray(checkpoint, 3)
	if !ok || len(captures) != 1 {
		t.Fatalf("Capture checkpoint = %#v", captures)
	}
	if id, idOK := replicaIdentifier(captures[0], 0); !idOK || id != bundleID {
		t.Fatalf("Capture checkpoint identity = %#v", captures[0])
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
