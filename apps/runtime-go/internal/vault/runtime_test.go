package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/artifactstore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/securestore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

type testSecretStore struct {
	mu     sync.RWMutex
	values map[string][]byte
}

func (s *testSecretStore) Get(service, account string) ([]byte, error) {
	s.mu.RLock()
	value, ok := s.values[service+"\x00"+account]
	s.mu.RUnlock()
	if !ok {
		return nil, securestore.ErrUnavailable
	}
	return append([]byte(nil), value...), nil
}

func (s *testSecretStore) Put(service, account string, value []byte) error {
	s.mu.Lock()
	if s.values == nil {
		s.values = map[string][]byte{}
	}
	s.values[service+"\x00"+account] = append([]byte(nil), value...)
	s.mu.Unlock()
	return nil
}

func (s *testSecretStore) Delete(service, account string) error {
	s.mu.Lock()
	delete(s.values, service+"\x00"+account)
	s.mu.Unlock()
	return nil
}

func memoryDependencies(t *testing.T) Dependencies {
	t.Helper()
	artifacts, err := artifactstore.New(t.TempDir())
	if err != nil {
		t.Fatalf("create test artifacts: %v", err)
	}
	return Dependencies{Artifacts: artifacts, Secrets: &testSecretStore{values: map[string][]byte{}}}
}

func openCompactForTest(t *testing.T, runtime *Runtime, vaultID string, encoded []byte) awsmcrypto.OpenedCompactItem {
	t.Helper()
	value := runtime.vaults[vaultID]
	if value == nil || value.Canonical == nil {
		t.Fatal("test Vault has no canonical state")
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatalf("decode test Vault ID: %v", err)
	}
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatalf("decode test Key Epoch ID: %v", err)
	}
	secret, err := runtime.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatalf("read test Key Epoch Secret: %v", err)
	}
	epoch, err := decodeEpochSecret(secret, vaultIdentifier, epochIdentifier)
	if err != nil {
		t.Fatalf("decode test Key Epoch Secret: %v", err)
	}
	opened, err := awsmcrypto.OpenCompactItem(vaultIdentifier, epochIdentifier, epoch.key, encoded)
	if err != nil {
		t.Fatalf("open compact test item: %v", err)
	}
	return opened
}

type failingState struct {
	delegate *store.MemoryState
	fail     bool
}

func (s *failingState) Put(ctx context.Context, key string, value []byte) error {
	if s.fail {
		return errors.New("injected state failure")
	}
	return s.delegate.Put(ctx, key, value)
}

func (s *failingState) Get(ctx context.Context, key string) ([]byte, error) {
	return s.delegate.Get(ctx, key)
}

func TestVaultCreationSelectionAndClosurePersistAcrossRestart(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	created, err := runtime.Handle(ctx, json.RawMessage(`{"type":"BeginVaultCreation","expectedVaultId":null,"label":"Personal"}`))
	if err != nil {
		t.Fatalf("begin creation: %v", err)
	}
	setup := created.(map[string]string)
	if _, err := awsmcrypto.DecodeRecoveryPhrase(setup["recoveryPhrase"]); err != nil {
		t.Fatalf("BeginVaultCreation Recovery Phrase = %q: %v", setup["recoveryPhrase"], err)
	}
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type":           "ConfirmVaultCreation",
		"setupId":        setup["setupId"],
		"recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm creation: %v", err)
	}
	vaultID := confirmed.(map[string]string)["vaultId"]
	if len(vaultID) != 64 {
		t.Fatalf("Vault ID length = %d, want 64", len(vaultID))
	}

	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type":            "CloseVault",
		"expectedVaultId": vaultID,
	})); err != nil {
		t.Fatalf("close Vault: %v", err)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	value := restarted.State()
	if value.SelectedVaultID == nil || *value.SelectedVaultID != vaultID {
		t.Fatalf("selected Vault = %#v, want %s", value.SelectedVaultID, vaultID)
	}
	if len(value.Vaults) != 1 || value.Vaults[0].Lifecycle != "Closed" || value.Vaults[0].Access != "ReadOnly" {
		t.Fatalf("persisted Vault state = %#v", value.Vaults)
	}
}

func TestRuntimeListLibraryProjectionCommandReturnsSemanticProjection(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Projection command")
	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ListLibraryProjection", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("ListLibraryProjection: %v", err)
	}
	projection, ok := result.(LibraryProjection)
	if !ok {
		t.Fatalf("ListLibraryProjection result = %#v, want LibraryProjection", result)
	}
	if len(projection.Captures) != 0 || len(projection.Collections) != 0 || len(projection.Folders) != 0 || len(projection.Tags) != 0 || len(projection.Notes) != 0 || len(projection.Conflicts) != 0 {
		t.Fatalf("empty LibraryProjection = %#v", projection)
	}
}

func TestConfirmVaultCreationCommitsCanonicalReplicaAndTrustedSecrets(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	created, err := runtime.Handle(ctx, json.RawMessage(`{"type":"BeginVaultCreation","expectedVaultId":null,"label":"Canonical"}`))
	if err != nil {
		t.Fatalf("begin creation: %v", err)
	}
	setup := created.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultCreation", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm creation: %v", err)
	}
	vaultID := confirmed.(map[string]string)["vaultId"]
	value := runtime.vaults[vaultID]
	if value == nil || value.Canonical == nil {
		t.Fatalf("persisted Vault canonical state = %#v", value)
	}
	if value.Canonical.BaselineID == "" || value.Canonical.GenesisID == "" || value.Canonical.KeyEpochID == "" {
		t.Fatalf("canonical identity state = %#v", value.Canonical)
	}
	if len(value.Canonical.CausalFrontier) != 1 || value.Canonical.CausalFrontier[0] != value.Canonical.GenesisID {
		t.Fatalf("canonical frontiers = %#v", value.Canonical)
	}
	for _, itemID := range []string{value.Canonical.BaselineStorageItemID, value.Canonical.GenesisStorageItemID} {
		reader, openErr := dependencies.Artifacts.Open(itemID)
		if openErr != nil {
			t.Fatalf("open persisted opaque item %s: %v", itemID, openErr)
		}
		encoded, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			t.Fatalf("read persisted opaque item: %v", readErr)
		}
		if _, decodeErr := storage.DecodeOpaqueEnvelope(encoded); decodeErr != nil {
			t.Fatalf("persisted item is not an opaque envelope: %v", decodeErr)
		}
	}
	if _, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID)); err != nil {
		t.Fatalf("client Trusted Secret missing: %v", err)
	}
	if _, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID)); err != nil {
		t.Fatalf("epoch Trusted Secret missing: %v", err)
	}
}

func TestRestartReopensCanonicalReplicaFromOpaqueRecords(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	created, err := runtime.Handle(ctx, json.RawMessage(`{"type":"BeginVaultCreation","expectedVaultId":null,"label":"Restart"}`))
	if err != nil {
		t.Fatalf("begin creation: %v", err)
	}
	setup := created.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultCreation", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm creation: %v", err)
	}
	vaultID := confirmed.(map[string]string)["vaultId"]
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	replica := restarted.replicas[vaultID]
	if replica == nil {
		t.Fatalf("restarted Runtime did not reopen canonical Replica")
	}
	value := restarted.vaults[vaultID]
	if value == nil || value.Canonical == nil {
		t.Fatalf("restarted canonical metadata = %#v", value)
	}
	replicaState := replica.State()
	if hexIdentifier(replicaState.VaultID) != vaultID || hexIdentifier(replicaState.BaselineID) != value.Canonical.BaselineID || len(replicaState.CausalFrontier) != 1 || hexIdentifier(replicaState.CausalFrontier[0]) != value.Canonical.GenesisID {
		t.Fatalf("reopened Replica state = %#v, metadata = %#v", replicaState, value.Canonical)
	}
}

func TestCloseVaultCommitsAuthenticatedLifecycleEvent(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Closure")
	closed, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "CloseVault", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("close Vault: %v", err)
	}
	result, ok := closed.(map[string]string)
	if !ok || len(result["eventRecordId"]) != 64 {
		t.Fatalf("close result = %#v", closed)
	}
	value := runtime.vaults[vaultID]
	if value == nil || value.Canonical == nil || len(value.Canonical.CausalFrontier) != 1 || value.Canonical.CausalFrontier[0] != result["eventRecordId"] {
		t.Fatalf("closed canonical state = %#v", value)
	}
	storageItemID, ok := value.Canonical.RecordStorageItemIDs[result["eventRecordId"]]
	if !ok {
		t.Fatalf("closed event has no Storage Item mapping: %#v", value.Canonical)
	}
	reader, err := dependencies.Artifacts.Open(storageItemID)
	if err != nil {
		t.Fatalf("open closed event artifact: %v", err)
	}
	encoded, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		t.Fatalf("read closed event artifact: %v", err)
	}
	opened := openCompactForTest(t, runtime, vaultID, encoded)
	if opened.PayloadType != 1 {
		t.Fatalf("closed event payload type = %d, want 1", opened.PayloadType)
	}
	event, err := canonical.DecodeEvent(opened.PayloadBytes)
	if err != nil {
		t.Fatalf("decode closed event: %v", err)
	}
	if event.Family != canonical.LifecycleFamily || event.Type != 2 || hexIdentifier(event.RecordID) != result["eventRecordId"] {
		t.Fatalf("closed event = %#v", event)
	}
}

func TestRuntimeAdmitsAuthenticatedOpaqueEventAndPersistsIt(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Event")
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	credentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		t.Fatal(err)
	}
	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		t.Fatal(err)
	}
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatal(err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, memberID, credentialID)
	if err != nil {
		t.Fatal(err)
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		t.Fatal(err)
	}
	replicaState := runtime.replicas[vaultID].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultIdentifier, GenerationID: generationID,
		ParentRecordIDs: replicaState.CausalFrontier, AuthorityParentIDs: replicaState.AuthorityFrontier,
		Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{},
		Family: canonical.ContentFamily, Type: 1, SignerCredentialID: credentialID, AssertedAt: 11, Body: canonical.Map{0: "Next"},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatal(err)
	}
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueEvent(ctx, vaultID, encoded); err != nil {
		t.Fatalf("admit opaque Event: %v", err)
	}
	if value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] == "" || value.Canonical.CausalFrontier[0] != hexIdentifier(event.RecordID) {
		t.Fatalf("admitted Event state = %#v", value.Canonical)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	if _, ok := restarted.replicas[vaultID].Record(event.RecordID); !ok {
		t.Fatal("restart did not retain admitted Event")
	}
}

func TestRuntimeAdmitsAuthenticatedOpaqueObjectAndReloadsIt(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Object")
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatal(err)
	}
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochIdentifier)
	if err != nil {
		t.Fatal(err)
	}
	featureIdentifier := mustIdentifier(t, value.Canonical.RequiredFeatureSetID)
	objectBytes := validTestArtifactObjectBytes(t, vaultIdentifier, featureIdentifier, "runtime object")
	objectID, err := canonical.VaultObjectID(vaultIdentifier, 2, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochIdentifier, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: objectBytes})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueObject(ctx, vaultID, encoded); err != nil {
		t.Fatalf("admit opaque Object: %v", err)
	}
	if value.Canonical.ObjectStorageItemIDs[hexIdentifier(objectID)] == "" {
		t.Fatalf("Object storage mapping = %#v", value.Canonical.ObjectStorageItemIDs)
	}
	if _, ok := runtime.replicas[vaultID].Object(objectID); !ok {
		t.Fatal("Runtime did not retain admitted Object")
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	if _, ok := restarted.replicas[vaultID].Object(objectID); !ok {
		t.Fatal("restart did not retain admitted Object")
	}
}

func TestRuntimeAdmitsAuthenticatedOpaqueFeatureManifestAndReloadsIt(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID := createVaultForTest(t, runtime, "Feature")
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatal(err)
	}
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochIdentifier)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{
		FeatureKey: "awsm.runtime.feature", Revision: 1, Parameters: []byte{4},
		RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestID, err := canonical.FeatureManifestID(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochIdentifier, KeyEpochKey: epochSecret.key, PayloadType: 3, PayloadBytes: manifestBytes})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueFeatureManifest(ctx, vaultID, encoded); err != nil {
		t.Fatalf("admit opaque Feature Manifest: %v", err)
	}
	if value.Canonical.FeatureManifestStorageItemIDs[hexIdentifier(manifestID)] == "" {
		t.Fatalf("Feature Manifest storage mapping = %#v", value.Canonical.FeatureManifestStorageItemIDs)
	}
	if stored, ok := runtime.replicas[vaultID].FeatureManifest(manifestID); !ok || !bytes.Equal(stored.Bytes, manifestBytes) {
		t.Fatalf("Runtime did not retain Feature Manifest = %#v", stored)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	if stored, ok := restarted.replicas[vaultID].FeatureManifest(manifestID); !ok || !bytes.Equal(stored.Bytes, manifestBytes) {
		t.Fatalf("restart did not retain Feature Manifest = %#v", stored)
	}
}

func TestStorageReliefEvictsOnlyLocalObjectBytesWithWarning(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Relief")
	value := runtime.vaults[vaultID]
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		t.Fatal(err)
	}
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochIdentifier)
	if err != nil {
		t.Fatal(err)
	}
	featureIdentifier := mustIdentifier(t, value.Canonical.RequiredFeatureSetID)
	objectBytes := validTestArtifactObjectBytes(t, vaultIdentifier, featureIdentifier, "storage relief object")
	objectID, err := canonical.VaultObjectID(vaultIdentifier, 2, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochIdentifier, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: objectBytes})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueObject(ctx, vaultID, encoded); err != nil {
		t.Fatalf("admit object: %v", err)
	}
	result, err := runtime.StorageRelief(ctx, vaultID, []string{hexIdentifier(objectID)})
	if err != nil {
		t.Fatalf("Storage Relief: %v", err)
	}
	if len(result.ReleasedObjectIDs) != 1 || result.ReleasedObjectIDs[0] != hexIdentifier(objectID) || result.Warning == "" {
		t.Fatalf("Storage Relief result = %#v", result)
	}
	if _, ok := runtime.replicas[vaultID].Object(objectID); ok {
		t.Fatal("Storage Relief retained the evicted Object")
	}
	if _, ok := value.Canonical.ObjectStorageItemIDs[hexIdentifier(objectID)]; ok {
		t.Fatal("Storage Relief retained the evicted Storage mapping")
	}
}

func TestGarbageCollectionDeletesOnlyUnreferencedOpaqueItems(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID := createVaultForTest(t, runtime, "GC")
	strayID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := dependencies.Artifacts.Put(strayID, bytes.NewReader([]byte("orphan"))); err != nil {
		t.Fatal(err)
	}
	result, err := runtime.GarbageCollect(ctx, vaultID)
	if err != nil {
		t.Fatalf("GarbageCollect: %v", err)
	}
	if len(result.DeletedStorageItemIDs) != 1 || result.DeletedStorageItemIDs[0] != strayID {
		t.Fatalf("GarbageCollect result = %#v", result)
	}
	if _, err := dependencies.Artifacts.Open(strayID); err == nil {
		t.Fatal("Garbage Collection retained an unreferenced item")
	}
	for _, id := range []string{runtime.vaults[vaultID].Canonical.BaselineStorageItemID, runtime.vaults[vaultID].Canonical.GenesisStorageItemID} {
		reader, err := dependencies.Artifacts.Open(id)
		if err != nil {
			t.Fatalf("Garbage Collection removed retained item %s: %v", id, err)
		}
		_ = reader.Close()
	}
}

func TestRuntimeCommandsExposeStorageReliefAndGarbageCollection(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Command storage")
	objectID := admitCompleteExportArtifact(t, runtime, dependencies, vaultID)
	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "StorageRelief", "expectedVaultId": vaultID, "objectIds": []string{hexIdentifier(objectID)},
	}))
	if err != nil {
		t.Fatalf("StorageRelief command: %v", err)
	}
	relief, ok := result.(StorageReliefSummary)
	if !ok || len(relief.ReleasedObjectIDs) != 1 || relief.ReleasedObjectIDs[0] != hexIdentifier(objectID) || relief.Warning == "" {
		t.Fatalf("StorageRelief command result = %#v", result)
	}
	result, err = runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "GarbageCollect", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("GarbageCollect command: %v", err)
	}
	if _, ok := result.(GarbageCollectionSummary); !ok {
		t.Fatalf("GarbageCollect command result = %#v", result)
	}
}

func TestForkCreatesFreshCanonicalReplicaForEmptyVault(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	sourceID := createVaultForTest(t, runtime, "Fork")
	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatal(err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"]}))
	if err != nil {
		t.Fatalf("confirm Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	if forkID == sourceID || runtime.vaults[forkID] == nil || runtime.vaults[forkID].Canonical == nil || runtime.replicas[forkID] == nil {
		t.Fatalf("Fork state = %#v", runtime.vaults[forkID])
	}
	if runtime.vaults[forkID].Canonical.BaselineID == runtime.vaults[sourceID].Canonical.BaselineID || runtime.vaults[forkID].Canonical.GenesisID == runtime.vaults[sourceID].Canonical.GenesisID {
		t.Fatal("Fork reused source canonical identities")
	}
}

func TestRecoverMemberEnrollsFreshClientCredentialAndReopens(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, runtime, "Recovery")
	before := runtime.vaults[vaultID].Canonical.ClientCredentialID
	resultValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RecoverMember", "expectedVaultId": vaultID, "recoveryPhrase": phrase,
	}))
	if err != nil {
		t.Fatalf("RecoverMember: %v", err)
	}
	result, ok := resultValue.(map[string]string)
	if !ok || result["clientCredentialId"] == "" || result["eventRecordId"] == "" {
		t.Fatalf("RecoverMember result = %#v", resultValue)
	}
	value := runtime.vaults[vaultID]
	if value.Canonical.ClientCredentialID == before || value.Canonical.ClientCredentialID != result["clientCredentialId"] {
		t.Fatalf("recovered Client Credential state = %#v, previous = %s", value.Canonical, before)
	}
	if _, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, result["eventRecordId"])); !ok {
		t.Fatal("recovery enrollment Event was not admitted")
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart after recovery: %v", err)
	}
	if restarted.vaults[vaultID].Canonical.ClientCredentialID != result["clientCredentialId"] {
		t.Fatalf("restarted Client Credential = %s, want %s", restarted.vaults[vaultID].Canonical.ClientCredentialID, result["clientCredentialId"])
	}
}

func TestReplicaRejectsRecoveryEnrollmentWithInvalidPossessionProof(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, runtime, "Enrollment proof")
	beforeReplica := runtime.replicas[vaultID].Clone()
	resultValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "RecoverMember", "expectedVaultId": vaultID, "recoveryPhrase": phrase,
	}))
	if err != nil {
		t.Fatalf("RecoverMember: %v", err)
	}
	result := resultValue.(map[string]string)
	record, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, result["eventRecordId"]))
	if !ok || record.Event == nil {
		t.Fatal("enrollment Event was not retained")
	}
	body, ok := replicaMapValue(record.Event.Body)
	if !ok {
		t.Fatalf("enrollment Event body = %#v", record.Event.Body)
	}
	proposalValue, ok := replicaMapEntry(body, 0)
	if !ok {
		t.Fatal("enrollment Event omitted its proposal")
	}
	proposal, ok := replicaMapValue(proposalValue)
	if !ok {
		t.Fatalf("enrollment proposal = %#v", proposalValue)
	}
	tamperedProposal := make(canonical.Map, 6)
	for key := uint64(0); key < 6; key++ {
		value, exists := replicaMapEntry(proposal, key)
		if !exists {
			t.Fatalf("enrollment proposal omitted key %d", key)
		}
		tamperedProposal[key] = value
	}
	tamperedProposal[5] = bytes.Repeat([]byte{0x55}, ed25519.SignatureSize)
	tamperedBody := make(canonical.Map, 4)
	for key := uint64(0); key < 4; key++ {
		value, exists := replicaMapEntry(body, key)
		if !exists {
			t.Fatalf("enrollment Event omitted key %d", key)
		}
		tamperedBody[key] = value
	}
	tamperedBody[0] = tamperedProposal
	value := runtime.vaults[vaultID]
	vaultIdentifier := mustIdentifier(t, vaultID)
	memberID := mustIdentifier(t, value.Canonical.MemberID)
	clientCredentialID := mustIdentifier(t, value.Canonical.ClientCredentialID)
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("open enrolled Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, memberID, clientCredentialID)
	if err != nil {
		t.Fatalf("decode enrolled Client Credential: %v", err)
	}
	input := record.Event.EventInput
	input.Body = tamperedBody
	input.AssertedAt++
	tampered, err := canonical.SignEvent(input, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign tampered enrollment: %v", err)
	}
	if err := beforeReplica.AdmitEvent(tampered, ed25519.PublicKey(clientSecret.signingPublicKey)); err == nil {
		t.Fatal("Replica accepted recovery enrollment with an invalid Client possession proof")
	}
}

func TestRecoveryPhraseReplacementAuthorsAuthenticatedAuthorityEvent(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Replacement")
	oldRecoveryID := runtime.vaults[vaultID].Canonical.RecoveryCredentialID
	startedValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "BeginRecoveryPhraseReplacement", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("begin replacement: %v", err)
	}
	started := startedValue.(map[string]string)
	if _, err := awsmcrypto.DecodeRecoveryPhrase(started["recoveryPhrase"]); err != nil {
		t.Fatalf("replacement phrase is invalid: %v", err)
	}
	confirmedValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmRecoveryPhraseReplacement", "setupId": started["setupId"], "recoveryPhrase": started["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm replacement: %v", err)
	}
	confirmed := confirmedValue.(map[string]any)
	newRecoveryID, ok := confirmed["recoveryCredentialId"].(string)
	if !ok || newRecoveryID == oldRecoveryID || confirmed["revision"] != 1 {
		t.Fatalf("replacement result = %#v", confirmedValue)
	}
	value := runtime.vaults[vaultID]
	if value.Canonical.RecoveryCredentialID != newRecoveryID || value.RecoveryRevision != 1 {
		t.Fatalf("replacement state = %#v", value)
	}
	if _, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, confirmed["eventRecordId"].(string))); !ok {
		t.Fatal("replacement Event was not admitted")
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart after replacement: %v", err)
	}
	if restarted.vaults[vaultID].Canonical.RecoveryCredentialID != newRecoveryID {
		t.Fatalf("restarted recovery Credential = %s, want %s", restarted.vaults[vaultID].Canonical.RecoveryCredentialID, newRecoveryID)
	}
}

func TestReplicaRejectsRecoveryReplacementWithInvalidPossessionProof(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Replacement proof")
	beforeReplica := runtime.replicas[vaultID].Clone()
	before := runtime.vaults[vaultID].Canonical
	startedValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "BeginRecoveryPhraseReplacement", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("begin replacement: %v", err)
	}
	started := startedValue.(map[string]string)
	confirmedValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmRecoveryPhraseReplacement", "setupId": started["setupId"], "recoveryPhrase": started["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm replacement: %v", err)
	}
	confirmed := confirmedValue.(map[string]any)
	record, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, confirmed["eventRecordId"].(string)))
	if !ok || record.Event == nil {
		t.Fatal("replacement Event was not retained")
	}
	body, ok := replicaMapValue(record.Event.Body)
	if !ok {
		t.Fatalf("replacement Event body = %#v", record.Event.Body)
	}
	tamperedBody := make(canonical.Map, 5)
	for key := uint64(0); key < 5; key++ {
		value, exists := replicaMapEntry(body, key)
		if !exists {
			t.Fatalf("replacement Event body omitted key %d", key)
		}
		tamperedBody[key] = value
	}
	tamperedBody[4] = bytes.Repeat([]byte{0x44}, ed25519.SignatureSize)
	clientCredentialID := mustIdentifier(t, before.ClientCredentialID)
	memberID := mustIdentifier(t, before.MemberID)
	vaultIdentifier := mustIdentifier(t, vaultID)
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, before.ClientCredentialID))
	if err != nil {
		t.Fatalf("open Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, memberID, clientCredentialID)
	if err != nil {
		t.Fatalf("decode Client Credential: %v", err)
	}
	input := record.Event.EventInput
	input.Body = tamperedBody
	input.AssertedAt++
	tampered, err := canonical.SignEvent(input, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign tampered replacement: %v", err)
	}
	if err := beforeReplica.AdmitEvent(tampered, ed25519.PublicKey(clientSecret.signingPublicKey)); err == nil {
		t.Fatal("Replica accepted Recovery Replacement with an invalid possession proof")
	}
}

func TestVacuumAdoptsAuthenticatedSuccessorBaselineAndReopens(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID := createVaultForTest(t, runtime, "Vacuum")
	before := cloneCanonicalState(runtime.vaults[vaultID].Canonical)
	resultValue, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "VacuumVault", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("VacuumVault: %v", err)
	}
	result, ok := resultValue.(map[string]string)
	if !ok || result["successorGenerationId"] == "" || result["successorBaselineId"] == "" || result["vacuumEventRecordId"] == "" {
		t.Fatalf("Vacuum result = %#v", resultValue)
	}
	value := runtime.vaults[vaultID]
	if value.GenerationID == before.GenerationID || value.Canonical.GenerationID != result["successorGenerationId"] || value.Canonical.BaselineID != result["successorBaselineId"] || value.Canonical.AdoptionEventID != result["vacuumEventRecordId"] {
		t.Fatalf("Vacuum state = %#v, before = %#v", value, before)
	}
	record, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, result["vacuumEventRecordId"]))
	if !ok || record.Event == nil || record.Event.Family != canonical.LifecycleFamily || record.Event.Type != 1 {
		t.Fatalf("Vacuum Event = %#v", record)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart after Vacuum: %v", err)
	}
	if restarted.vaults[vaultID].Canonical.BaselineID != result["successorBaselineId"] || restarted.vaults[vaultID].Canonical.AdoptionEventID != result["vacuumEventRecordId"] {
		t.Fatalf("restarted Vacuum state = %#v", restarted.vaults[vaultID])
	}
}

func TestVacuumPreservesCollectionTitleInSuccessorCheckpoint(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID := createVaultForTest(t, runtime, "Vacuum collection")
	collectionID := filledCreationID(222)
	admitForkCollectionTitleEvent(t, runtime, dependencies, vaultID, collectionID, "Saved pages")

	resultValue, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "VacuumVault", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("VacuumVault: %v", err)
	}
	result, ok := resultValue.(map[string]string)
	if !ok {
		t.Fatalf("Vacuum result = %#v", resultValue)
	}
	baselineRecord, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, result["successorBaselineId"]))
	if !ok || baselineRecord.Baseline == nil {
		t.Fatalf("successor Baseline = %#v", baselineRecord)
	}
	body, ok := replicaMapValue(baselineRecord.Baseline.Body)
	if !ok {
		t.Fatal("successor Baseline body is not a map")
	}
	content, ok := replicaMapValue(replicaMapEntryMust(body, 2))
	if !ok {
		t.Fatal("successor content checkpoint is not a map")
	}
	collections, ok := replicaMapArray(content, 4)
	if !ok {
		t.Fatal("successor Collection checkpoint is not an array")
	}
	found := false
	for _, entry := range collections {
		id, idOK := replicaIdentifier(entry, 0)
		title, titleOK := replicaMapNullableText(entry, 1)
		if idOK && id == collectionID && titleOK && title != nil && *title == "Saved pages" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("successor Collection checkpoint = %#v", collections)
	}
	projection, err := ProjectLibraryProjection(runtime.replicas[vaultID])
	if err != nil {
		t.Fatalf("project adopted successor: %v", err)
	}
	if len(projection.Collections) != 1 || projection.Collections[0].Title != "Saved pages" {
		t.Fatalf("adopted Collection projection = %#v", projection.Collections)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart after Collection Vacuum: %v", err)
	}
	projection, err = ProjectLibraryProjection(restarted.replicas[vaultID])
	if err != nil {
		t.Fatalf("project restarted successor: %v", err)
	}
	if len(projection.Collections) != 1 || projection.Collections[0].Title != "Saved pages" {
		t.Fatalf("restarted Collection projection = %#v", projection.Collections)
	}
}

func TestVacuumPreservesActiveCaptureInSuccessorCheckpoint(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	vaultID := createVaultForTest(t, runtime, "Vacuum capture")
	value := runtime.vaults[vaultID]
	vaultIdentifier := mustIdentifier(t, vaultID)
	epochID := mustIdentifier(t, value.Canonical.KeyEpochID)
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatal(err)
	}
	artifactBytes := validTestArtifactObjectBytes(t, vaultIdentifier, mustIdentifier(t, value.Canonical.RequiredFeatureSetID), "vacuum capture artifact")
	artifactID, err := canonical.VaultObjectID(vaultIdentifier, 2, artifactBytes)
	if err != nil {
		t.Fatal(err)
	}
	artifactEnvelope, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: artifactBytes})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueObject(ctx, vaultID, artifactEnvelope); err != nil {
		t.Fatalf("admit Artifact Object: %v", err)
	}
	bundleID, collectionID := admitForkBundleRegisteredEvent(t, runtime, dependencies, vaultID, artifactID)
	resultValue, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "VacuumVault", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("VacuumVault: %v", err)
	}
	result, ok := resultValue.(map[string]string)
	if !ok || result["successorBaselineId"] == "" {
		t.Fatalf("Vacuum result = %#v", resultValue)
	}
	projection, err := ProjectLibraryProjection(runtime.replicas[vaultID])
	if err != nil {
		t.Fatalf("project adopted successor: %v", err)
	}
	if len(projection.Captures) != 1 || projection.Captures[0].BundleID != hexIdentifier(bundleID) || projection.Captures[0].CollectionID != hexIdentifier(collectionID) {
		t.Fatalf("adopted Capture projection = %#v", projection.Captures)
	}
}

func mustIdentifier(t *testing.T, value string) canonical.Identifier {
	t.Helper()
	identifier, err := decodeHexIdentifier(value)
	if err != nil {
		t.Fatal(err)
	}
	return identifier
}

func TestVaultCommandsRejectStaleContextAndKeepCaptureOutOfDesktopUI(t *testing.T) {
	runtime, err := New(context.Background(), store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	_, err = runtime.Handle(context.Background(), json.RawMessage(`{"type":"CaptureActivePage","expectedVaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`))
	command, ok := err.(*CommandError)
	if !ok || command.ID != "CAPTURE_UNAVAILABLE" {
		t.Fatalf("capture error = %#v, want CAPTURE_UNAVAILABLE", err)
	}
	_, err = runtime.Handle(context.Background(), json.RawMessage(`{"type":"SelectVault","expectedVaultId":null,"vaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`))
	command, ok = err.(*CommandError)
	if !ok || command.ID != "VAULT_NOT_FOUND" {
		t.Fatalf("missing Vault error = %#v, want VAULT_NOT_FOUND", err)
	}
}

func TestVaultCommandsRejectStaleSelectedVaultContext(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	first := createVaultForTest(t, runtime, "First")
	second := createVaultForTest(t, runtime, "Second")
	if first == second {
		t.Fatal("test Vault identifiers unexpectedly collided")
	}
	_, err = runtime.Handle(ctx, mustJSON(map[string]any{"type": "CloseVault", "expectedVaultId": first}))
	failure, ok := err.(*CommandError)
	if !ok || failure.ID != "VAULT_CONTEXT_CHANGED" {
		t.Fatalf("stale Vault command error = %#v, want VAULT_CONTEXT_CHANGED", err)
	}
	forkValue, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": second}))
	if err != nil {
		t.Fatalf("begin fork: %v", err)
	}
	forkSetup := forkValue.(map[string]string)
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "SelectVault", "expectedVaultId": second, "vaultId": first,
	})); err != nil {
		t.Fatalf("select another Vault during pending fork: %v", err)
	}
	_, err = runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": forkSetup["setupId"], "recoveryPhrase": forkSetup["recoveryPhrase"],
	}))
	failure, ok = err.(*CommandError)
	if !ok || failure.ID != "VAULT_CONTEXT_CHANGED" {
		t.Fatalf("stale fork confirmation error = %#v, want VAULT_CONTEXT_CHANGED", err)
	}
}

func TestVaultMutationRollsBackWhenPersistenceFails(t *testing.T) {
	ctx := context.Background()
	state := &failingState{delegate: store.NewMemoryState()}
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Durable")
	state.fail = true
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "CloseVault", "expectedVaultId": vaultID})); err == nil {
		t.Fatal("close unexpectedly succeeded with a failing state store")
	}
	state.fail = false
	current := runtime.State()
	if len(current.Vaults) != 1 || current.Vaults[0].Lifecycle != "Open" || current.SelectedVaultID == nil || *current.SelectedVaultID != vaultID {
		t.Fatalf("in-memory state after failed close = %#v, want the original open Vault", current)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	if restarted.State().Vaults[0].Lifecycle != "Open" {
		t.Fatalf("persisted state after failed close = %#v, want Open", restarted.State().Vaults)
	}
}

func TestVaultDropsUnresumablePendingCeremonyOnRestart(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Restartable")
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": vaultID})); err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	if restarted.State().PendingVaultCreation != nil {
		t.Fatalf("non-creation pending setup leaked into ClientState: %#v", restarted.State().PendingVaultCreation)
	}
	if _, err := restarted.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": vaultID})); err != nil {
		t.Fatalf("new Fork after restart: %v", err)
	}
}

func TestVaultCommandsRejectTrailingJSON(t *testing.T) {
	var target struct {
		Type string `json:"type"`
	}
	if err := decode(json.RawMessage(`{"type":"GetState"}{"type":"GetState"}`), &target); err == nil {
		t.Fatal("trailing JSON unexpectedly decoded")
	}
}

func TestVaultCommandsValidateUnavailableCommandFields(t *testing.T) {
	runtime, err := New(context.Background(), store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	_, err = runtime.Handle(context.Background(), json.RawMessage(`{"type":"CaptureActivePage","expectedVaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tabId":1,"extra":true}`))
	command, ok := err.(*CommandError)
	if !ok || command.ID != "APPLICATION_PROTOCOL_INVALID" {
		t.Fatalf("unavailable command validation error = %#v, want APPLICATION_PROTOCOL_INVALID", err)
	}
}

func TestTransferPackageRoundTripsWithoutCreatingAnEvent(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	created, err := runtime.Handle(ctx, json.RawMessage(`{"type":"BeginVaultCreation","expectedVaultId":null,"label":"Move me"}`))
	if err != nil {
		t.Fatalf("begin creation: %v", err)
	}
	setup := created.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultCreation", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm creation: %v", err)
	}
	vaultID := confirmed.(map[string]string)["vaultId"]
	payload, err := runtime.ExportTransfer(vaultID)
	if err != nil {
		t.Fatalf("export transfer: %v", err)
	}
	var exported TransferPackage
	if err := decode(json.RawMessage(payload), &exported); err != nil {
		t.Fatalf("decode complete transfer package: %v", err)
	}
	if exported.Canonical == nil || len(exported.Artifacts) < 4 || len(exported.TrustedSecrets) != 2 {
		t.Fatalf("transfer package omitted canonical closure: %#v", exported)
	}
	destinationState := store.NewMemoryState()
	destinationDependencies := memoryDependencies(t)
	destination, err := New(ctx, destinationState, destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	if _, err := destination.ImportTransfer(ctx, payload); err != nil {
		t.Fatalf("import transfer: %v", err)
	}
	if len(destination.State().Vaults) != 1 || destination.State().Vaults[0].VaultID != vaultID {
		t.Fatalf("destination state = %#v", destination.State())
	}
	if destination.replicas[vaultID] == nil {
		t.Fatal("destination did not reopen the authenticated Replica from the transfer package")
	}
	restarted, err := New(ctx, destinationState, destinationDependencies)
	if err != nil {
		t.Fatalf("restart imported destination: %v", err)
	}
	if restarted.replicas[vaultID] == nil {
		t.Fatal("restarted destination lost the authenticated Replica")
	}
	if _, err := destination.ImportTransfer(ctx, payload); err == nil {
		t.Fatal("duplicate transfer unexpectedly replaced the destination Vault")
	}
	if packageVaultID, err := TransferPackageVaultID(payload); err != nil || packageVaultID != vaultID {
		t.Fatalf("transfer package Vault ID = %q, %v; want %s", packageVaultID, err, vaultID)
	}
	if _, err := TransferPackageVaultID(append(payload, byte('{'))); err == nil {
		t.Fatal("malformed transfer package identity unexpectedly decoded")
	}
}

func TestHostedReplicaMetadataAcceptsCanonicalHTTPSPaths(t *testing.T) {
	ctx := context.Background()
	endpoint, client := newHostedRuntimeFixture(t)
	dependencies := memoryDependencies(t)
	dependencies.HTTPClient = client
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	created, err := runtime.Handle(ctx, json.RawMessage(`{"type":"BeginVaultCreation","expectedVaultId":null,"label":null}`))
	if err != nil {
		t.Fatalf("begin creation: %v", err)
	}
	setup := created.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultCreation", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm creation: %v", err)
	}
	vaultID := confirmed.(map[string]string)["vaultId"]
	remoteValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": endpoint, "name": "Archive Host", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica: %v", err)
	}
	remote := remoteValue.(RemoteSummary)
	if remote.Endpoint != endpoint || remote.Name != "Archive Host" || remote.ReplicaHandle == "" {
		t.Fatalf("remote metadata = %#v", remote)
	}
	_, err = runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": "https://alice:secret@host.example", "name": "Invalid", "username": "alice", "password": "secret",
	}))
	failure, ok := err.(*CommandError)
	if !ok || failure.ID != "REMOTE_ENDPOINT_INVALID" {
		t.Fatalf("invalid endpoint error = %#v, want REMOTE_ENDPOINT_INVALID", err)
	}
}

func TestHostedReplicaAttachmentMaterializationAndPull(t *testing.T) {
	ctx := context.Background()
	fixture := newHostedSyncFixture(t)
	dependencies := memoryDependencies(t)
	dependencies.HTTPClient = fixture.Client
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Hosted")
	created, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Primary", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica: %v", err)
	}
	primary := created.(RemoteSummary)
	materializedValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "MaterializeHostedReplica", "expectedVaultId": vaultID, "remoteId": primary.RemoteID,
	}))
	if err != nil {
		t.Fatalf("materialize Hosted Replica: %v", err)
	}
	materialized := materializedValue.(map[string]any)
	if materialized["materializedCompactItemCount"].(int) == 0 || len(fixture.Items) == 0 {
		t.Fatalf("materialization summary = %#v, fixture items = %d", materialized, len(fixture.Items))
	}
	rewrapped := false
	for logicalID, localStorageItemID := range runtime.vaults[vaultID].Canonical.RecordStorageItemIDs {
		logicalIdentifier, decodeErr := decodeHexIdentifier(logicalID)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		locator, locatorErr := deriveHostedReplicaLocator(fixture.Salt, hostedNamespaceRecord, logicalIdentifier)
		if locatorErr != nil {
			t.Fatal(locatorErr)
		}
		for storageItemID, item := range fixture.Items {
			if item.Locator == locator && hexIdentifier(storageItemID) != localStorageItemID {
				rewrapped = true
				break
			}
		}
		if rewrapped {
			break
		}
	}
	if !rewrapped {
		t.Fatal("Hosted Replica materialization reused every local Record Storage Item ID")
	}
	attachmentValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "BeginHostedReplicaAttachment", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Existing", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("begin Hosted Replica attachment: %v", err)
	}
	attachment := attachmentValue.(map[string]any)
	if attachment["setupId"].(string) == "" || len(attachment["replicas"].([]map[string]any)) == 0 {
		t.Fatalf("attachment result = %#v", attachment)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmHostedReplicaAttachment", "expectedVaultId": vaultID,
		"setupId": attachment["setupId"], "replicaHandle": fixture.Handle,
	})); err != nil {
		t.Fatalf("confirm Hosted Replica attachment: %v", err)
	}
	pulledValue, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "PullHostedReplicas", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("pull Hosted Replicas: %v", err)
	}
	pulled := pulledValue.([]map[string]string)
	if len(pulled) != 2 || pulled[0]["status"] != "Completed" || pulled[1]["status"] != "Completed" {
		t.Fatalf("pull summary = %#v", pulled)
	}
}

func TestHostedReplicaPullAdoptsVacuumSuccessor(t *testing.T) {
	ctx := context.Background()
	fixture := newHostedSyncFixture(t)
	sourceDependencies := memoryDependencies(t)
	sourceDependencies.HTTPClient = fixture.Client
	source, err := New(ctx, store.NewMemoryState(), sourceDependencies)
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, source, "Hosted Vacuum")
	collectionID := filledCreationID(224)
	admitForkCollectionTitleEvent(t, source, sourceDependencies, vaultID, collectionID, "Saved pages")
	preVacuumExport, err := source.ExportComplete(vaultID, phrase)
	if err != nil {
		t.Fatalf("export pre-Vacuum source: %v", err)
	}
	if _, err := source.Handle(ctx, mustJSON(map[string]any{"type": "VacuumVault", "expectedVaultId": vaultID})); err != nil {
		t.Fatalf("Vacuum source: %v", err)
	}
	remoteValue, err := source.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Hosted Vacuum", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create source Hosted Replica: %v", err)
	}
	remote := remoteValue.(RemoteSummary)
	if _, err := source.Handle(ctx, mustJSON(map[string]any{"type": "MaterializeHostedReplica", "expectedVaultId": vaultID, "remoteId": remote.RemoteID})); err != nil {
		t.Fatalf("materialize source Vacuum successor: %v", err)
	}

	destinationDependencies := memoryDependencies(t)
	destinationDependencies.HTTPClient = fixture.Client
	destination, err := New(ctx, store.NewMemoryState(), destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	if _, err := destination.ImportComplete(ctx, phrase, preVacuumExport); err != nil {
		t.Fatalf("import pre-Vacuum destination: %v", err)
	}
	if _, err := destination.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Hosted Vacuum", "username": "alice", "password": "secret",
	})); err != nil {
		t.Fatalf("create destination Hosted Replica: %v", err)
	}
	pulledValue, err := destination.Handle(ctx, mustJSON(map[string]any{"type": "PullHostedReplicas", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("pull Vacuum successor: %v", err)
	}
	pulled := pulledValue.([]map[string]string)
	if len(pulled) != 1 || pulled[0]["status"] != "Completed" {
		t.Fatalf("pull Vacuum successor status = %#v", pulled)
	}
	projection, err := ProjectLibraryProjection(destination.replicas[vaultID])
	if err != nil {
		t.Fatalf("project pulled Vacuum successor: %v", err)
	}
	if len(projection.Collections) != 1 || projection.Collections[0].CollectionID != hexIdentifier(collectionID) || projection.Collections[0].Title != "Saved pages" {
		t.Fatalf("pulled Collection projection = %#v", projection.Collections)
	}
}

func TestHostedReplicaMaterializesFeatureManifestItems(t *testing.T) {
	ctx := context.Background()
	fixture := newHostedSyncFixture(t)
	dependencies := memoryDependencies(t)
	dependencies.HTTPClient = fixture.Client
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	feature := canonical.FeatureManifestInput{FeatureKey: "awsm.hosted.feature", Revision: 1, Parameters: []byte{3}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{}}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{RecoveryPhrase: "abandon amount liar amount expire adjust cage candy arch gather drum buyer", FeatureManifests: []canonical.FeatureManifestInput{feature}})
	if err != nil {
		t.Fatalf("prepare feature Vault: %v", err)
	}
	vaultID := installPreparedCreationForTest(t, runtime, dependencies, prepared)
	created, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Feature Host", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica: %v", err)
	}
	remote := created.(RemoteSummary)
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "MaterializeHostedReplica", "expectedVaultId": vaultID, "remoteId": remote.RemoteID})); err != nil {
		t.Fatalf("materialize Hosted Replica: %v", err)
	}
	featureID := prepared.FeatureManifests[0].ID
	locator, err := deriveHostedReplicaLocator(fixture.Salt, hostedNamespaceFeatureSet, featureID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range fixture.Items {
		if item.Locator == locator {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Hosted Replica materialization omitted Feature Manifest %s", hexIdentifier(featureID))
	}
}

func TestHostedReplicaPullAdmitsFeatureManifestItems(t *testing.T) {
	ctx := context.Background()
	fixture := newHostedSyncFixture(t)
	dependencies := memoryDependencies(t)
	dependencies.HTTPClient = fixture.Client
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Feature pull")
	created, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Feature Pull Host", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica: %v", err)
	}
	remote := created.(RemoteSummary)
	vaultIdentifier := mustIdentifier(t, vaultID)
	value := runtime.vaults[vaultID]
	epochID := mustIdentifier(t, value.Canonical.KeyEpochID)
	secretBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := decodeEpochSecret(secretBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{FeatureKey: "awsm.pull.feature", Revision: 1, Parameters: []byte{6}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	manifestID, err := canonical.FeatureManifestID(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epoch.key, PayloadType: 3, PayloadBytes: manifestBytes})
	if err != nil {
		t.Fatal(err)
	}
	locator, err := deriveHostedReplicaLocator(fixture.Salt, hostedNamespaceFeatureSet, manifestID)
	if err != nil {
		t.Fatal(err)
	}
	fixture.addItem(t, locator, compact)
	result, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "PullHostedReplicas", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("pull Hosted Replica: %v", err)
	}
	status := result.([]map[string]string)
	if len(status) != 1 || status[0]["remoteId"] != remote.RemoteID || status[0]["status"] != "Completed" {
		t.Fatalf("pull status = %#v", status)
	}
	if stored, ok := runtime.replicas[vaultID].FeatureManifest(manifestID); !ok || !bytes.Equal(stored.Bytes, manifestBytes) {
		t.Fatalf("pulled Feature Manifest = %#v", stored)
	}
}

func TestHostedReplicaPullReportsAuthenticatedAdmissionFailure(t *testing.T) {
	ctx := context.Background()
	fixture := newHostedSyncFixture(t)
	dependencies := memoryDependencies(t)
	dependencies.HTTPClient = fixture.Client
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Hosted admission failure")
	created, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Archive", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica: %v", err)
	}
	remote := created.(RemoteSummary)
	vaultIdentifier := mustIdentifier(t, vaultID)
	value := runtime.vaults[vaultID]
	epochID := mustIdentifier(t, value.Canonical.KeyEpochID)
	secretBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatalf("read Key Epoch: %v", err)
	}
	epoch, err := decodeEpochSecret(secretBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatalf("decode Key Epoch: %v", err)
	}
	logicalID := filledCreationID(253)
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epoch.key, PayloadType: 2, PayloadBytes: []byte("not a canonical Object"),
	})
	if err != nil {
		t.Fatalf("seal invalid Object: %v", err)
	}
	locator, err := deriveHostedReplicaLocator(fixture.Salt, hostedNamespaceObject, logicalID)
	if err != nil {
		t.Fatalf("derive invalid Object locator: %v", err)
	}
	fixture.addItem(t, locator, encoded)
	pulledValue, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "PullHostedReplicas", "expectedVaultId": vaultID}))
	if err != nil {
		t.Fatalf("pull Hosted Replica: %v", err)
	}
	pulled := pulledValue.([]map[string]string)
	if len(pulled) != 1 || pulled[0]["remoteId"] != remote.RemoteID || pulled[0]["status"] != "Failed" {
		t.Fatalf("pull failure summary = %#v", pulled)
	}
}

func TestHostedReplicaHydratesKnownArtifactStream(t *testing.T) {
	ctx := context.Background()
	fixture := newHostedSyncFixture(t)
	dependencies := memoryDependencies(t)
	dependencies.HTTPClient = fixture.Client
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Hydration")
	created, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "CreateHostedReplica", "expectedVaultId": vaultID,
		"endpoint": fixture.Endpoint, "name": "Archive", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica: %v", err)
	}
	remote := created.(RemoteSummary)
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	value := runtime.vaults[vaultID]
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		t.Fatal(err)
	}
	objectBytes := validTestArtifactObjectBytes(t, vaultIdentifier, featureSetID, "hosted artifact")
	objectID, err := objectIDFromBytes(vaultIdentifier, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	secretBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatal(err)
	}
	epochID, _ := decodeHexIdentifier(value.Canonical.KeyEpochID)
	epoch, err := decodeEpochSecret(secretBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epoch.key, PayloadType: 2, PayloadBytes: objectBytes})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.AdmitOpaqueObject(ctx, vaultID, compact); err != nil {
		t.Fatalf("admit Artifact Object: %v", err)
	}
	locator, err := deriveHostedReplicaLocator(fixture.Salt, hostedNamespaceArtifact, objectID)
	if err != nil {
		t.Fatal(err)
	}
	streamPayload := append([]byte{0, 0, 0, 0, 1, 0, 0, 0, 16}, make([]byte, 16)...)
	stream, err := storage.EncodeOpaqueEnvelope(storage.OpaqueEnvelopeInput{StorageClass: storage.StreamableStorageClass, ProtectionParameters: make([]byte, 64), Payload: streamPayload})
	if err != nil {
		t.Fatal(err)
	}
	fixture.addItem(t, locator, stream)
	hydratedValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "HydrateArtifact", "expectedVaultId": vaultID, "artifactId": hexIdentifier(objectID),
	}))
	if err != nil {
		t.Fatalf("hydrate Artifact: %v", err)
	}
	hydrated := hydratedValue.(map[string]string)
	if hydrated["remoteId"] != remote.RemoteID || hydrated["artifactId"] != hexIdentifier(objectID) {
		t.Fatalf("hydration result = %#v", hydrated)
	}
}

func mustJSON(value map[string]any) json.RawMessage {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return bytes
}

func createVaultForTest(t *testing.T, runtime *Runtime, label string) string {
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, label)
	return vaultID
}

func createVaultWithPhraseForTest(t *testing.T, runtime *Runtime, label string) (string, string) {
	t.Helper()
	ctx := context.Background()
	selected := runtime.State().SelectedVaultID
	created, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "BeginVaultCreation", "expectedVaultId": selected, "label": label,
	}))
	if err != nil {
		t.Fatalf("begin %s creation: %v", label, err)
	}
	setup := created.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultCreation", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm %s creation: %v", label, err)
	}
	return confirmed.(map[string]string)["vaultId"], setup["recoveryPhrase"]
}
