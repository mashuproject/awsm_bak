package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/completeexport"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestRuntimeExportsCanonicalCompleteExportClosure(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Portable")
	const passphrase = "correct horse battery staple"

	encrypted, err := runtime.ExportComplete(vaultID, passphrase)
	if err != nil {
		t.Fatalf("export Complete Export: %v", err)
	}
	opened, err := completeexport.OpenStream(passphrase, encrypted)
	if err != nil {
		t.Fatalf("open Complete Export: %v", err)
	}
	entries, err := decodeCompleteExportEntries(opened.Plaintext)
	if err != nil {
		t.Fatalf("decode Complete Export entries: %v", err)
	}
	if got := []uint64{entries[0].Header.Kind, entries[1].Header.Kind, entries[2].Header.Kind, entries[3].Header.Kind, entries[4].Header.Kind, entries[5].Header.Kind}; !bytes.Equal([]byte{byte(got[0]), byte(got[1]), byte(got[2]), byte(got[3]), byte(got[4]), byte(got[5])}, []byte{1, 2, 2, 2, 2, 3}) {
		t.Fatalf("Complete Export entry kinds = %v, want [1 2 2 2 2 3]", got)
	}
	manifest, err := completeexport.DecodeManifest(entries[0].Bytes)
	if err != nil {
		t.Fatalf("decode Complete Export Manifest: %v", err)
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatalf("decode Vault ID: %v", err)
	}
	if manifest.VaultID != vaultIdentifier || len(manifest.TypedLogicalRoots) != 2 || len(manifest.OpaqueItemInventory) != 4 {
		t.Fatalf("Complete Export Manifest = %#v", manifest)
	}
	keyInventory, err := completeexport.DecodeKeyInventory(entries[len(entries)-1].Bytes)
	if err != nil {
		t.Fatalf("decode Complete Export Key Inventory: %v", err)
	}
	if len(keyInventory.Entries) != 1 || keyInventory.VaultID != vaultIdentifier {
		t.Fatalf("Complete Export Key Inventory = %#v", keyInventory)
	}
}

func TestRuntimeCompleteExportPreservesPerItemKeyEpochsAcrossImportAndRestart(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, runtime, "Multiple epochs")
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatalf("decode Vault ID: %v", err)
	}
	newKey := bytes.Repeat([]byte{0x5a}, 32)
	newEpochID, err := awsmcrypto.KeyEpochID(vaultIdentifier, newKey)
	if err != nil {
		t.Fatalf("derive second Key Epoch ID: %v", err)
	}
	if err := dependencies.Secrets.Put(trustedSecretService, epochSecretAccount(vaultID, hexIdentifier(newEpochID)), mustEncodeImportedEpochSecret(vaultIdentifier, newEpochID, newKey)); err != nil {
		t.Fatalf("store second Key Epoch: %v", err)
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		t.Fatalf("decode Required Feature Set ID: %v", err)
	}
	objectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultIdentifier[:], 2: uint64(1), 3: featureSetID[:],
		4: canonical.Map{}, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatalf("encode second-epoch Object: %v", err)
	}
	objectID, err := canonical.VaultObjectID(vaultIdentifier, 1, objectBytes)
	if err != nil {
		t.Fatalf("derive second-epoch Object ID: %v", err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: newEpochID, KeyEpochKey: newKey,
		PayloadType: 2, PayloadBytes: objectBytes,
	})
	if err != nil {
		t.Fatalf("seal second-epoch Object: %v", err)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		t.Fatalf("decode second-epoch Object envelope: %v", err)
	}
	if err := storeOpaqueCreationItem(dependencies.Artifacts, envelope.StorageItemID, encoded); err != nil {
		t.Fatalf("store second-epoch Object: %v", err)
	}
	if err := runtime.replicas[vaultID].AdmitObject(objectID, objectBytes); err != nil {
		t.Fatalf("admit second-epoch Object: %v", err)
	}
	value.Canonical.ObjectStorageItemIDs[hexIdentifier(objectID)] = hexIdentifier(envelope.StorageItemID)
	value.Canonical.StorageItemKeyEpochIDs[hexIdentifier(envelope.StorageItemID)] = hexIdentifier(newEpochID)

	complete, err := runtime.ExportComplete(vaultID, phrase)
	if err != nil {
		t.Fatalf("export multi-epoch Complete Export: %v", err)
	}
	opened, err := completeexport.OpenStream(phrase, complete)
	if err != nil {
		t.Fatalf("open multi-epoch Complete Export: %v", err)
	}
	entries, err := decodeCompleteExportEntries(opened.Plaintext)
	if err != nil {
		t.Fatalf("decode multi-epoch Complete Export: %v", err)
	}
	manifest, err := completeexport.DecodeManifest(entries[0].Bytes)
	if err != nil {
		t.Fatalf("decode multi-epoch Manifest: %v", err)
	}
	keyInventory, err := completeexport.DecodeKeyInventory(entries[len(entries)-1].Bytes)
	if err != nil {
		t.Fatalf("decode multi-epoch Key Inventory: %v", err)
	}
	if len(keyInventory.Entries) != 2 {
		t.Fatalf("multi-epoch Key Inventory entries = %d, want 2", len(keyInventory.Entries))
	}
	foundSecondEpoch := false
	for _, item := range manifest.OpaqueItemInventory {
		if item.LogicalID == objectID && item.KeyEpochID == newEpochID {
			foundSecondEpoch = true
			break
		}
	}
	if !foundSecondEpoch {
		t.Fatalf("Manifest did not bind Object %s to its second Key Epoch", hexIdentifier(objectID))
	}

	destinationDependencies := memoryDependencies(t)
	destination, err := New(ctx, store.NewMemoryState(), destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	if _, err := destination.ImportComplete(ctx, phrase, complete); err != nil {
		t.Fatalf("import multi-epoch Complete Export: %v", err)
	}
	if _, ok := destination.replicas[vaultID].Object(objectID); !ok {
		t.Fatalf("imported Replica omitted second-epoch Object %s", hexIdentifier(objectID))
	}
	restarted, err := New(ctx, destination.store, destinationDependencies)
	if err != nil {
		t.Fatalf("restart imported multi-epoch Runtime: %v", err)
	}
	if _, ok := restarted.replicas[vaultID].Object(objectID); !ok {
		t.Fatalf("restarted Replica omitted second-epoch Object %s", hexIdentifier(objectID))
	}
}

func TestRuntimeImportsCompleteExportAsAuthoringFreeReplica(t *testing.T) {
	ctx := context.Background()
	sourceDependencies := memoryDependencies(t)
	source, err := New(ctx, store.NewMemoryState(), sourceDependencies)
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, source, "Imported")
	complete, err := source.ExportComplete(vaultID, phrase)
	if err != nil {
		t.Fatalf("export Complete Export: %v", err)
	}

	destinationDependencies := memoryDependencies(t)
	destinationState := store.NewMemoryState()
	destination, err := New(ctx, destinationState, destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	state, err := destination.ImportComplete(ctx, phrase, complete)
	if err != nil {
		t.Fatalf("import Complete Export: %v", err)
	}
	if len(state.Vaults) != 1 || state.Vaults[0].VaultID != vaultID || state.Vaults[0].Access != "ReadOnly" {
		t.Fatalf("imported Client state = %#v", state)
	}
	if destination.replicas[vaultID] == nil {
		t.Fatal("Complete Import did not install an authenticated Replica")
	}
	if _, err := destinationDependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, destination.vaults[vaultID].Canonical.ClientCredentialID)); err == nil {
		t.Fatal("Complete Import retained a Client Credential private key")
	}
	restarted, err := New(ctx, destinationState, destinationDependencies)
	if err != nil {
		t.Fatalf("restart imported Runtime: %v", err)
	}
	if restarted.replicas[vaultID] == nil || restarted.State().Vaults[0].Access != "ReadOnly" {
		t.Fatalf("restarted imported state = %#v", restarted.State())
	}
}

func TestRuntimeExportsAndImportsFeatureManifestClosure(t *testing.T) {
	ctx := context.Background()
	feature := canonical.FeatureManifestInput{
		FeatureKey: "awsm.export.feature", Revision: 1, Parameters: []byte{8},
		RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	}
	sourceDependencies := memoryDependencies(t)
	source, err := New(ctx, store.NewMemoryState(), sourceDependencies)
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{
		RecoveryPhrase:   "abandon amount liar amount expire adjust cage candy arch gather drum buyer",
		FeatureManifests: []canonical.FeatureManifestInput{feature},
	})
	if err != nil {
		t.Fatalf("prepare feature Vault: %v", err)
	}
	vaultID := installPreparedCreationForTest(t, source, sourceDependencies, prepared)
	complete, err := source.ExportComplete(vaultID, prepared.RecoveryPhrase)
	if err != nil {
		t.Fatalf("export feature Complete Export: %v", err)
	}
	opened, err := completeexport.OpenStream(prepared.RecoveryPhrase, complete)
	if err != nil {
		t.Fatalf("open feature Complete Export: %v", err)
	}
	entries, err := decodeCompleteExportEntries(opened.Plaintext)
	if err != nil {
		t.Fatalf("decode feature Complete Export: %v", err)
	}
	manifest, err := completeexport.DecodeManifest(entries[0].Bytes)
	if err != nil {
		t.Fatalf("decode feature Manifest: %v", err)
	}
	featureID := prepared.FeatureManifests[0].ID
	foundFeature := false
	for _, item := range manifest.OpaqueItemInventory {
		if item.Namespace == 4 && item.LogicalID == featureID {
			foundFeature = true
		}
	}
	if !foundFeature {
		t.Fatalf("Complete Export omitted Feature Manifest %s", hexIdentifier(featureID))
	}
	destinationDependencies := memoryDependencies(t)
	destination, err := New(ctx, store.NewMemoryState(), destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	if _, err := destination.ImportComplete(ctx, prepared.RecoveryPhrase, complete); err != nil {
		t.Fatalf("import feature Complete Export: %v", err)
	}
	stored, ok := destination.replicas[vaultID].FeatureManifest(featureID)
	if !ok || !bytes.Equal(stored.Bytes, prepared.FeatureManifests[0].Bytes) {
		t.Fatalf("imported Feature Manifest = %#v", stored)
	}
}

func TestRuntimeCommandsExposeCompleteExportAndImport(t *testing.T) {
	ctx := context.Background()
	source, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, source, "Command Export")
	result, err := source.Handle(ctx, mustJSON(map[string]any{
		"type": "ExportComplete", "expectedVaultId": vaultID, "passphrase": phrase,
	}))
	if err != nil {
		t.Fatalf("ExportComplete command: %v", err)
	}
	packageValue, ok := result.(map[string]string)
	if !ok || packageValue["package"] == "" {
		t.Fatalf("ExportComplete command result = %#v", result)
	}
	complete, err := base64.RawURLEncoding.DecodeString(packageValue["package"])
	if err != nil {
		t.Fatalf("decode ExportComplete command package: %v", err)
	}
	destination, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	importResult, err := destination.Handle(ctx, mustJSON(map[string]any{
		"type": "ImportComplete", "passphrase": phrase, "package": base64.RawURLEncoding.EncodeToString(complete),
	}))
	if err != nil {
		t.Fatalf("ImportComplete command: %v", err)
	}
	encodedState, err := json.Marshal(importResult)
	if err != nil || !bytes.Contains(encodedState, []byte(vaultID)) {
		t.Fatalf("ImportComplete command result = %s, %v", encodedState, err)
	}
}

func TestRuntimeCompleteExportRejectsUnverifiedStreamableArtifact(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Streamable rejection")
	streamPayload := make([]byte, 9+int(storage.FrameTagLength))
	streamPayload[4] = 1 // final frame
	streamPayload[5] = 0
	streamPayload[6] = 0
	streamPayload[7] = 0
	streamPayload[8] = byte(storage.FrameTagLength)
	encoded, err := storage.EncodeOpaqueEnvelope(storage.OpaqueEnvelopeInput{
		StorageClass:         storage.StreamableStorageClass,
		ProtectionParameters: make([]byte, 64),
		Payload:              streamPayload,
	})
	if err != nil {
		t.Fatalf("encode Streamable wrapper: %v", err)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		t.Fatalf("decode Streamable wrapper: %v", err)
	}
	if err := runtime.deps.Artifacts.Put(hexIdentifier(envelope.StorageItemID), bytes.NewReader(encoded)); err != nil {
		t.Fatalf("store Streamable wrapper: %v", err)
	}
	artifactID := filledCreationID(240)
	runtime.vaults[vaultID].Canonical.ArtifactStorageItemIDs[hexIdentifier(artifactID)] = hexIdentifier(envelope.StorageItemID)
	epochID := mustIdentifier(t, runtime.vaults[vaultID].Canonical.KeyEpochID)
	bindStorageItemKeyEpoch(runtime.vaults[vaultID].Canonical, hexIdentifier(envelope.StorageItemID), epochID)

	_, err = runtime.ExportComplete(vaultID, "correct horse battery staple")
	var commandErr *CommandError
	if !errors.As(err, &commandErr) || commandErr.ID != "COMPLETE_EXPORT_UNAVAILABLE" {
		t.Fatalf("ExportComplete error = %v, want COMPLETE_EXPORT_UNAVAILABLE", err)
	}
}

func TestRuntimeCompleteExportAuthenticatesReachableArtifactStream(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, runtime, "Streamable export")
	artifactID := admitCompleteExportArtifact(t, runtime, dependencies, vaultID)

	encoded, err := runtime.ExportComplete(vaultID, phrase)
	if err != nil {
		t.Fatalf("ExportComplete: %v", err)
	}
	opened, err := completeexport.OpenStream(phrase, encoded)
	if err != nil {
		t.Fatalf("open Complete Export: %v", err)
	}
	entries, err := decodeCompleteExportEntries(opened.Plaintext)
	if err != nil {
		t.Fatalf("decode Complete Export entries: %v", err)
	}
	manifest, err := completeexport.DecodeManifest(entries[0].Bytes)
	if err != nil {
		t.Fatalf("decode Manifest: %v", err)
	}
	found := false
	for _, item := range manifest.OpaqueItemInventory {
		if item.Namespace == 5 && item.LogicalID == artifactID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Complete Export Manifest omitted authenticated Artifact %s", hexIdentifier(artifactID))
	}
}

func TestRuntimeImportsAuthenticatedArtifactStream(t *testing.T) {
	ctx := context.Background()
	sourceDependencies := memoryDependencies(t)
	source, err := New(ctx, store.NewMemoryState(), sourceDependencies)
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, source, "Streamable import")
	artifactID := admitCompleteExportArtifact(t, source, sourceDependencies, vaultID)
	encoded, err := source.ExportComplete(vaultID, phrase)
	if err != nil {
		t.Fatalf("ExportComplete: %v", err)
	}

	destinationDependencies := memoryDependencies(t)
	destination, err := New(ctx, store.NewMemoryState(), destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	state, err := destination.ImportComplete(ctx, phrase, encoded)
	if err != nil {
		t.Fatalf("ImportComplete: %v", err)
	}
	if len(state.Vaults) != 1 || destination.replicas[vaultID] == nil {
		t.Fatalf("imported state = %#v", state)
	}
	if _, ok := destination.replicas[vaultID].Object(artifactID); !ok {
		t.Fatalf("imported Replica omitted Artifact Object %s", hexIdentifier(artifactID))
	}
	storageItemID := destination.vaults[vaultID].Canonical.ArtifactStorageItemIDs[hexIdentifier(artifactID)]
	if storageItemID == "" {
		t.Fatal("imported state omitted Artifact Storage Item mapping")
	}
	if _, err := destinationDependencies.Artifacts.Open(storageItemID); err != nil {
		t.Fatalf("imported Artifact wrapper unavailable: %v", err)
	}
}

func TestRuntimeCompleteExportHonorsExpectedVaultContext(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	first := createVaultForTest(t, runtime, "First export")
	_ = createVaultForTest(t, runtime, "Selected export")
	_, err = runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ExportComplete", "expectedVaultId": first, "passphrase": "correct horse battery staple",
	}))
	var commandErr *CommandError
	if !errors.As(err, &commandErr) || commandErr.ID != "VAULT_CONTEXT_CHANGED" {
		t.Fatalf("stale ExportComplete error = %v, want VAULT_CONTEXT_CHANGED", err)
	}
}

func admitCompleteExportArtifact(t *testing.T, runtime *Runtime, dependencies Dependencies, vaultID string) canonical.Identifier {
	t.Helper()
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		t.Fatal(err)
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatal(err)
	}
	secretBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := decodeEpochSecret(secretBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("authenticated Artifact export payload")
	digest := awsmcrypto.ArtifactPayloadDigest(plaintext)
	artifactBody := canonical.Map{
		0: uint64(1), 1: "awsm.artifact.capture", 2: "application/vnd.awsm.web-page+zip",
		3: "awsm.representation.web-page-zip", 4: uint64(len(plaintext)), 5: digest[:],
		6: canonical.Map{0: uint64(1), 1: uint64(storage.FramePlaintextLimit), 2: uint64(storage.FrameTagLength), 3: uint64(len(plaintext)), 4: digest[:]},
		7: []byte{0x01},
	}
	objectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultIdentifier[:], 2: uint64(2), 3: featureSetID[:], 4: artifactBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	artifactID, err := canonical.VaultObjectID(vaultIdentifier, 2, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epoch.key,
		PayloadType: 2, PayloadBytes: objectBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueObject(context.Background(), vaultID, compact); err != nil {
		t.Fatalf("admit Artifact Object: %v", err)
	}
	stream, err := awsmcrypto.SealArtifactStream(awsmcrypto.ArtifactStreamInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epoch.key,
		ArtifactID: artifactID, Plaintext: plaintext, PlaintextDigest: digest,
		ProtectionParameters: bytes.Repeat([]byte{0x27}, 64),
	})
	if err != nil {
		t.Fatalf("seal Artifact stream: %v", err)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(stream)
	if err != nil {
		t.Fatalf("decode Artifact stream: %v", err)
	}
	if err := dependencies.Artifacts.Put(hexIdentifier(envelope.StorageItemID), bytes.NewReader(stream)); err != nil {
		t.Fatal(err)
	}
	value.Canonical.ArtifactStorageItemIDs[hexIdentifier(artifactID)] = hexIdentifier(envelope.StorageItemID)
	bindStorageItemKeyEpoch(value.Canonical, hexIdentifier(envelope.StorageItemID), epochID)
	return artifactID
}

func installPreparedCreationForTest(t *testing.T, runtime *Runtime, dependencies Dependencies, prepared PreparedCanonicalVaultCreation) string {
	t.Helper()
	canonicalState := canonicalReplicaFromCreation(prepared)
	for _, item := range []struct {
		id   [32]byte
		data []byte
	}{
		{prepared.BaselineEnvelope.StorageItemID, prepared.BaselineEnvelope.Bytes},
		{prepared.GenesisEnvelope.StorageItemID, prepared.GenesisEnvelope.Bytes},
		{prepared.RecoveryKeyEnvelope.Envelope.StorageItemID, prepared.RecoveryKeyEnvelope.Envelope.Bytes},
		{prepared.ClientKeyEnvelope.Envelope.StorageItemID, prepared.ClientKeyEnvelope.Envelope.Bytes},
	} {
		if err := storeOpaqueCreationItem(dependencies.Artifacts, item.id, item.data); err != nil {
			t.Fatalf("store prepared closure item: %v", err)
		}
	}
	for _, feature := range prepared.FeatureManifests {
		if err := storeOpaqueCreationItem(dependencies.Artifacts, feature.Envelope.StorageItemID, feature.Envelope.Bytes); err != nil {
			t.Fatalf("store prepared Feature Manifest: %v", err)
		}
	}
	clientSecret, err := encodeClientSecret(prepared)
	if err != nil {
		t.Fatalf("encode prepared Client secret: %v", err)
	}
	if err := dependencies.Secrets.Put(trustedSecretService, clientSecretAccount(canonicalState.VaultID, canonicalState.ClientCredentialID), clientSecret); err != nil {
		t.Fatalf("store prepared Client secret: %v", err)
	}
	epochSecret, err := encodeEpochSecret(prepared)
	if err != nil {
		t.Fatalf("encode prepared Epoch secret: %v", err)
	}
	if err := dependencies.Secrets.Put(trustedSecretService, epochSecretAccount(canonicalState.VaultID, canonicalState.KeyEpochID), epochSecret); err != nil {
		t.Fatalf("store prepared Epoch secret: %v", err)
	}
	vaultID := canonicalState.VaultID
	runtime.vaults[vaultID] = &persistedVault{VaultID: vaultID, Label: nil, Lifecycle: "Open", RecoveryHash: hashPhrase(prepared.RecoveryPhrase), GenerationID: canonicalState.GenerationID, Remotes: []remoteState{}, Canonical: canonicalState}
	replica, err := newReplicaFromPreparedCreation(prepared)
	if err != nil {
		t.Fatalf("open prepared Replica: %v", err)
	}
	runtime.replicas[vaultID] = replica
	runtime.selected = vaultID
	return vaultID
}

func decodeCompleteExportEntries(plaintext []byte) ([]completeexport.Entry, error) {
	entries := make([]completeexport.Entry, 0)
	for offset := 0; offset < len(plaintext); {
		if len(plaintext)-offset < 4 {
			return nil, errCompleteExportEntriesTruncated
		}
		headerLength := int(binary.BigEndian.Uint32(plaintext[offset : offset+4]))
		offset += 4
		if headerLength < 1 || len(plaintext)-offset < headerLength {
			return nil, errCompleteExportEntriesTruncated
		}
		header, err := completeexport.DecodeEntryHeader(plaintext[offset : offset+headerLength])
		if err != nil {
			return nil, err
		}
		offset += headerLength
		if uint64(len(plaintext)-offset) < header.ByteLength {
			return nil, errCompleteExportEntriesTruncated
		}
		body := append([]byte(nil), plaintext[offset:offset+int(header.ByteLength)]...)
		offset += int(header.ByteLength)
		entries = append(entries, completeexport.Entry{Header: header, Bytes: body})
	}
	return entries, nil
}

var errCompleteExportEntriesTruncated = &completeExportEntriesError{}

type completeExportEntriesError struct{}

func (*completeExportEntriesError) Error() string { return "Complete Export entries are truncated" }
