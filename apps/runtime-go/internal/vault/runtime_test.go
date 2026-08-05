package vault

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

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
	runtime, err := New(ctx, state)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	created, err := runtime.Handle(ctx, json.RawMessage(`{"type":"BeginVaultCreation","expectedVaultId":null,"label":"Personal"}`))
	if err != nil {
		t.Fatalf("begin creation: %v", err)
	}
	setup := created.(map[string]string)
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
	restarted, err := New(ctx, state)
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

func TestVaultCommandsRejectStaleContextAndKeepCaptureOutOfDesktopUI(t *testing.T) {
	runtime, err := New(context.Background(), store.NewMemoryState())
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
	runtime, err := New(ctx, store.NewMemoryState())
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
	runtime, err := New(ctx, state)
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
	restarted, err := New(ctx, state)
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
	runtime, err := New(ctx, state)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Restartable")
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": vaultID})); err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	restarted, err := New(ctx, state)
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
	runtime, err := New(context.Background(), store.NewMemoryState())
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
	runtime, err := New(context.Background(), store.NewMemoryState())
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
	runtime, err := New(ctx, store.NewMemoryState())
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
	destination, err := New(ctx, store.NewMemoryState())
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
	runtime, err := New(ctx, store.NewMemoryState())
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
