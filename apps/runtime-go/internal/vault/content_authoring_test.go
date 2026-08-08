package vault

import (
	"context"
	"crypto/ed25519"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestRevertCollectionMergeAuthorsAuthenticatedEventAndRestarts(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Collection merge authoring")
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatalf("decode Vault ID: %v", err)
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		t.Fatalf("decode Generation ID: %v", err)
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		t.Fatalf("decode Required Feature Set ID: %v", err)
	}
	credentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		t.Fatalf("decode Client Credential ID: %v", err)
	}
	secretBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("read Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(secretBytes, vaultIdentifier, mustIdentifier(t, value.Canonical.MemberID), credentialID)
	if err != nil {
		t.Fatalf("decode Client Credential: %v", err)
	}
	sourceID := filledCreationID(241)
	destinationID := filledCreationID(242)
	frontier := runtime.replicas[vaultID].State()
	merge, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultIdentifier, GenerationID: generationID,
		ParentRecordIDs: frontier.CausalFrontier, AuthorityParentIDs: frontier.AuthorityFrontier,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 8,
		SignerCredentialID: credentialID, AssertedAt: 1, Body: canonical.Map{0: canonicalSetValues([]canonical.Value{sourceID[:]}), 1: destinationID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign Collections Merged: %v", err)
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatalf("decode Key Epoch ID: %v", err)
	}
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatalf("read Key Epoch: %v", err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatalf("decode Key Epoch: %v", err)
	}
	encodedMerge, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: merge.Bytes,
	})
	zeroBytes(epochSecret.key)
	if err != nil {
		t.Fatalf("seal Collections Merged: %v", err)
	}
	if err := runtime.AdmitOpaqueEvent(ctx, vaultID, encodedMerge); err != nil {
		t.Fatalf("admit Collections Merged: %v", err)
	}

	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RevertCollectionMerge", "expectedVaultId": vaultID, "redirectCauseId": hexIdentifier(merge.RecordID),
	}))
	if err != nil {
		t.Fatalf("RevertCollectionMerge: %v", err)
	}
	resultMap, ok := result.(map[string]string)
	if !ok || resultMap["eventRecordId"] == "" {
		t.Fatalf("RevertCollectionMerge result = %#v", result)
	}
	projection, err := ProjectLibraryProjection(runtime.replicas[vaultID])
	if err != nil {
		t.Fatalf("project after RevertCollectionMerge: %v", err)
	}
	if len(projection.Conflicts) != 0 {
		t.Fatalf("projection conflicts after revert = %#v", projection.Conflicts)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RevertCollectionMerge", "expectedVaultId": vaultID, "redirectCauseId": hexIdentifier(merge.RecordID),
	})); err == nil {
		t.Fatal("RevertCollectionMerge accepted an already-reverted cause")
	} else if command, ok := err.(*CommandError); !ok || command.ID != "CONTENT_COMMAND_INVALID" {
		t.Fatalf("second RevertCollectionMerge error = %#v, want CONTENT_COMMAND_INVALID", err)
	}

	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	restartedProjection, err := restarted.Handle(ctx, mustJSON(map[string]any{
		"type": "ListLibraryProjection", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("ListLibraryProjection after restart: %v", err)
	}
	if restartedProjection.(LibraryProjection).Conflicts != nil && len(restartedProjection.(LibraryProjection).Conflicts) != 0 {
		t.Fatalf("restarted projection conflicts = %#v", restartedProjection.(LibraryProjection).Conflicts)
	}
}

func TestCreateFolderAuthorsContentEventAndRestarts(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Folder authoring")
	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateFolder", "expectedVaultId": vaultID, "name": "Archive", "parentFolderId": nil,
	}))
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	created, ok := result.(map[string]string)
	if !ok || created["folderId"] == "" || created["eventRecordId"] == "" {
		t.Fatalf("CreateFolder result = %#v", result)
	}
	projection, err := ProjectLibraryProjection(runtime.replicas[vaultID])
	if err != nil {
		t.Fatalf("project after CreateFolder: %v", err)
	}
	if len(projection.Folders) != 1 || projection.Folders[0].FolderID != created["folderId"] || projection.Folders[0].Name != "Archive" {
		t.Fatalf("folders after CreateFolder = %#v", projection.Folders)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	restartedProjection, err := restarted.Handle(ctx, mustJSON(map[string]any{
		"type": "ListLibraryProjection", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("ListLibraryProjection after CreateFolder restart: %v", err)
	}
	if folders := restartedProjection.(LibraryProjection).Folders; len(folders) != 1 || folders[0].FolderID != created["folderId"] {
		t.Fatalf("restarted folders = %#v", folders)
	}
}

func TestCreateReviseDeleteRestoreNoteAuthorsObjectClosureAndRestarts(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Note authoring")
	_, collectionID := admitForkBundleRegisteredEvent(t, runtime, dependencies, vaultID, filledCreationID(246))
	title := "First title"
	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateNote", "expectedVaultId": vaultID, "targetKind": "Collection", "targetId": hexIdentifier(collectionID),
		"title": title, "body": "First body",
	}))
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	created, ok := result.(map[string]string)
	if !ok || len(created) != 2 || created["noteId"] == "" || created["eventRecordId"] == "" {
		t.Fatalf("CreateNote result = %#v", result)
	}
	projection, err := ProjectLibraryProjection(runtime.replicas[vaultID])
	if err != nil {
		t.Fatalf("project after CreateNote: %v", err)
	}
	if len(projection.Notes) != 1 || projection.Notes[0].State != "Active" || projection.Notes[0].Versions[0].Body == nil || *projection.Notes[0].Versions[0].Body != "First body" {
		t.Fatalf("notes after CreateNote = %#v", projection.Notes)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ReviseNote", "expectedVaultId": vaultID, "noteId": created["noteId"], "title": "Second title", "body": "Second body",
	})); err != nil {
		t.Fatalf("ReviseNote: %v", err)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "DeleteNote", "expectedVaultId": vaultID, "noteId": created["noteId"],
	})); err != nil {
		t.Fatalf("DeleteNote: %v", err)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RestoreNote", "expectedVaultId": vaultID, "noteId": created["noteId"],
	})); err != nil {
		t.Fatalf("RestoreNote: %v", err)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	projection, err = ProjectLibraryProjection(restarted.replicas[vaultID])
	if err != nil {
		t.Fatalf("project after Note restart: %v", err)
	}
	if len(projection.Notes) != 1 || projection.Notes[0].State != "Active" || len(projection.Notes[0].Versions) != 1 || projection.Notes[0].Versions[0].Body == nil || *projection.Notes[0].Versions[0].Body != "Second body" {
		t.Fatalf("restarted notes = %#v", projection.Notes)
	}
}

func TestCreateTagAndFolderOrganizationCommandsReplayAcrossRestart(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Organization authoring")
	folderResult, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateFolder", "expectedVaultId": vaultID, "name": "Archive", "parentFolderId": nil,
	}))
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	folderID := folderResult.(map[string]string)["folderId"]
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RenameFolder", "expectedVaultId": vaultID, "folderId": folderID, "name": "Renamed",
	})); err != nil {
		t.Fatalf("RenameFolder: %v", err)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "DeleteFolder", "expectedVaultId": vaultID, "folderId": folderID,
	})); err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RestoreFolder", "expectedVaultId": vaultID, "folderId": folderID,
	})); err != nil {
		t.Fatalf("RestoreFolder: %v", err)
	}
	tagResult, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateTag", "expectedVaultId": vaultID, "name": "Reading",
	}))
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}
	tagID := tagResult.(map[string]string)["tagId"]
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RenameTag", "expectedVaultId": vaultID, "tagId": tagID, "name": "Books",
	})); err != nil {
		t.Fatalf("RenameTag: %v", err)
	}
	secondTagResult, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateTag", "expectedVaultId": vaultID, "name": "Archive",
	}))
	if err != nil {
		t.Fatalf("Create second Tag: %v", err)
	}
	secondTagID := secondTagResult.(map[string]string)["tagId"]
	mergeResult, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "MergeTags", "expectedVaultId": vaultID, "sourceTagIds": []string{tagID}, "destinationTagId": secondTagID,
	}))
	if err != nil {
		t.Fatalf("MergeTags: %v", err)
	}
	mergeRecordID := mergeResult.(map[string]string)["eventRecordId"]
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RevertTagMerge", "expectedVaultId": vaultID, "redirectCauseId": mergeRecordID,
	})); err != nil {
		t.Fatalf("RevertTagMerge: %v", err)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "DeleteTag", "expectedVaultId": vaultID, "tagId": tagID,
	})); err != nil {
		t.Fatalf("DeleteTag: %v", err)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RestoreTag", "expectedVaultId": vaultID, "tagId": tagID,
	})); err != nil {
		t.Fatalf("RestoreTag: %v", err)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	projection, err := ProjectLibraryProjection(restarted.replicas[vaultID])
	if err != nil {
		t.Fatalf("project organization after restart: %v", err)
	}
	if len(projection.Folders) != 1 || projection.Folders[0].Name != "Renamed" || projection.Folders[0].Lifecycle != "Active" {
		t.Fatalf("restarted folders = %#v", projection.Folders)
	}
	if len(projection.Tags) != 2 {
		t.Fatalf("restarted tags = %#v", projection.Tags)
	}
	for _, tag := range projection.Tags {
		if tag.TagID == tagID && (tag.Name != "Books" || tag.Lifecycle != "Active" || tag.RedirectedTo != nil) {
			t.Fatalf("restarted source Tag = %#v", tag)
		}
		if tag.TagID == secondTagID && (tag.Name != "Archive" || tag.Lifecycle != "Active") {
			t.Fatalf("restarted destination Tag = %#v", tag)
		}
	}
}
