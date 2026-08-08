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
