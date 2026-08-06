package vault

import (
	"context"
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

func TestVaultCommandsFailClosedForUnimplementedHostedOperations(t *testing.T) {
	runtime, err := New(context.Background(), store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	commands := []struct {
		name string
		raw  string
	}{
		{
			name: "HOSTED_REPLICA_ATTACHMENT_UNAVAILABLE",
			raw:  `{"type":"BeginHostedReplicaAttachment","expectedVaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","endpoint":"https://host.example","name":"Host","username":"alice","password":"secret"}`,
		},
		{
			name: "HOSTED_REPLICA_MATERIALIZATION_UNAVAILABLE",
			raw:  `{"type":"MaterializeHostedReplica","expectedVaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","remoteId":"00000000-0000-4000-8000-000000000000"}`,
		},
		{
			name: "HOSTED_REPLICA_PULL_UNAVAILABLE",
			raw:  `{"type":"PullHostedReplicas","expectedVaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
		},
	}
	for _, commandInput := range commands {
		t.Run(commandInput.name, func(t *testing.T) {
			_, commandErr := runtime.Handle(context.Background(), json.RawMessage(commandInput.raw))
			failure, ok := commandErr.(*CommandError)
			if !ok || failure.ID != commandInput.name {
				t.Fatalf("command error = %#v, want %s", commandErr, commandInput.name)
			}
		})
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
	destination, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	if _, err := destination.ImportTransfer(ctx, payload); err != nil {
		t.Fatalf("import transfer: %v", err)
	}
	if len(destination.State().Vaults) != 1 || destination.State().Vaults[0].VaultID != vaultID {
		t.Fatalf("destination state = %#v", destination.State())
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
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
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
		"endpoint": "https://host.example/aws", "name": "Archive Host", "username": "alice", "password": "secret",
	}))
	if err != nil {
		t.Fatalf("create Hosted Replica metadata: %v", err)
	}
	remote := remoteValue.(RemoteSummary)
	if remote.Endpoint != "https://host.example/aws" || remote.Name != "Archive Host" {
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

func mustJSON(value map[string]any) json.RawMessage {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return bytes
}

func createVaultForTest(t *testing.T, runtime *Runtime, label string) string {
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
	return confirmed.(map[string]string)["vaultId"]
}
