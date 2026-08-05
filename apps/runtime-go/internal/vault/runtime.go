// Package vault owns the desktop Client's Vault command boundary.
//
// The transport deliberately speaks in the same tagged command/result shapes
// as the browser application. Storage and cryptographic implementation details
// stay behind this package; the HTTP and Wails adapters never mutate Vault
// state directly.
package vault

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"

	"github.com/google/uuid"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

const persistedStateKey = "awsm.runtime.vaults"

var ErrNotFound = store.ErrStateNotFound

type StateStore interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
}

// CommandError is serialized by the HTTP adapter and mirrors the extension's
// canonical application error shape.
type CommandError struct {
	ID      string
	Message string
}

func (e *CommandError) Error() string { return e.Message }

func commandError(id, message string) *CommandError {
	return &CommandError{ID: id, Message: message}
}

type VaultSummary struct {
	VaultID   string  `json:"vaultId"`
	Label     *string `json:"label"`
	Lifecycle string  `json:"lifecycle"`
	Access    string  `json:"access"`
	Selected  bool    `json:"selected"`
}

type PendingCreationState struct {
	SetupID         string  `json:"setupId"`
	ExpectedVaultID *string `json:"expectedVaultId"`
}

type ClientState struct {
	SelectedVaultID      *string               `json:"selectedVaultId,omitempty"`
	PendingVaultCreation *PendingCreationState `json:"pendingVaultCreation,omitempty"`
	Vaults               []VaultSummary        `json:"vaults"`
}

type RemoteSummary struct {
	RemoteID string `json:"remoteId"`
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"`
	Enabled  bool   `json:"enabled"`
}

type remoteState struct {
	RemoteID string `json:"remoteId"`
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"`
	Enabled  bool   `json:"enabled"`
}

type persistedVault struct {
	VaultID          string        `json:"vaultId"`
	Label            *string       `json:"label"`
	Lifecycle        string        `json:"lifecycle"`
	RecoveryHash     string        `json:"recoveryHash"`
	GenerationID     string        `json:"generationId"`
	Remotes          []remoteState `json:"remotes"`
	RecoveryRevision int           `json:"recoveryRevision"`
}

type pendingState struct {
	Kind             string  `json:"kind"`
	SetupID          string  `json:"setupId"`
	ExpectedVaultID  *string `json:"expectedVaultId"`
	Label            *string `json:"label"`
	PhraseHash       string  `json:"phraseHash"`
	SourceVaultID    string  `json:"sourceVaultId"`
	RecoveryRevision int     `json:"recoveryRevision"`
}

type persistedState struct {
	SelectedVaultID string           `json:"selectedVaultId"`
	Vaults          []persistedVault `json:"vaults"`
	Pending         *pendingState    `json:"pending"`
}

type Runtime struct {
	mu       sync.RWMutex
	store    StateStore
	selected string
	vaults   map[string]*persistedVault
	pending  *pendingState
	notify   func()
}

type runtimeSnapshot struct {
	selected string
	vaults   map[string]*persistedVault
	pending  *pendingState
}

// TransferPackage is the destination-side handoff representation. It is
// expected to arrive inside the authenticated transfer envelope; it is not a
// Vault Event and is never synchronized.
type TransferPackage struct {
	VaultID      string        `json:"vaultId"`
	Label        *string       `json:"label"`
	Lifecycle    string        `json:"lifecycle"`
	RecoveryHash string        `json:"recoveryHash"`
	GenerationID string        `json:"generationId"`
	Remotes      []remoteState `json:"remotes"`
}

func New(ctx context.Context, state StateStore) (*Runtime, error) {
	if state == nil {
		return nil, errors.New("Vault state store is required")
	}
	runtime := &Runtime{store: state, vaults: make(map[string]*persistedVault)}
	serialized, err := state.Get(ctx, persistedStateKey)
	if errors.Is(err, store.ErrStateNotFound) {
		return runtime, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load Vault state: %w", err)
	}
	var snapshot persistedState
	if err := json.Unmarshal(serialized, &snapshot); err != nil {
		return nil, fmt.Errorf("decode Vault state: %w", err)
	}
	for _, value := range snapshot.Vaults {
		if err := validatePersistedVault(value); err != nil {
			return nil, err
		}
		copyValue := value
		copyValue.Remotes = append([]remoteState(nil), value.Remotes...)
		runtime.vaults[value.VaultID] = &copyValue
	}
	runtime.selected = snapshot.SelectedVaultID
	if runtime.selected != "" {
		if _, ok := runtime.vaults[runtime.selected]; !ok {
			return nil, errors.New("Vault state selects a missing Vault")
		}
	}
	if snapshot.Pending != nil {
		if snapshot.Pending.SetupID == "" ||
			(snapshot.Pending.Kind != "create" && snapshot.Pending.Kind != "fork" && snapshot.Pending.Kind != "replacement") {
			return nil, errors.New("Vault state contains an invalid pending setup")
		}
		// Only creation can resume after a restart: its Recovery Phrase is shown
		// to the user and the setup identity is exposed in ClientState. Fork and
		// replacement phrases are intentionally never persisted, so their
		// transient ceremonies are cancelled on restart instead of stranding the
		// Runtime behind an undiscoverable setup.
		if snapshot.Pending.Kind == "create" {
			runtime.pending = clonePending(snapshot.Pending)
		}
	}
	return runtime, nil
}

func (r *Runtime) SetNotifier(notify func()) {
	r.mu.Lock()
	r.notify = notify
	r.mu.Unlock()
}

func (r *Runtime) State() ClientState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.stateLocked()
}

func (r *Runtime) ImportTransfer(ctx context.Context, payload []byte) (ClientState, error) {
	var packageValue TransferPackage
	if err := decode(json.RawMessage(payload), &packageValue); err != nil {
		return ClientState{}, commandError("TRANSFER_PACKAGE_INVALID", "The transfer package is invalid.")
	}
	candidate := persistedVault{
		VaultID: packageValue.VaultID, Label: packageValue.Label, Lifecycle: packageValue.Lifecycle,
		RecoveryHash: packageValue.RecoveryHash, GenerationID: packageValue.GenerationID,
		Remotes: append([]remoteState(nil), packageValue.Remotes...),
	}
	if err := validatePersistedVault(candidate); err != nil {
		return ClientState{}, commandError("TRANSFER_PACKAGE_INVALID", "The transfer package is invalid.")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if _, exists := r.vaults[packageValue.VaultID]; exists {
		return ClientState{}, commandError("VAULT_IDENTITY_COLLISION", "The destination already contains this Vault.")
	}
	value := &persistedVault{
		VaultID: packageValue.VaultID, Label: cloneString(packageValue.Label), Lifecycle: packageValue.Lifecycle,
		RecoveryHash: packageValue.RecoveryHash, GenerationID: packageValue.GenerationID,
		Remotes: append([]remoteState(nil), packageValue.Remotes...), RecoveryRevision: 1,
	}
	r.vaults[value.VaultID] = value
	r.selected = value.VaultID
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return ClientState{}, err
	}
	r.signal()
	return r.stateLocked(), nil
}

func (r *Runtime) ExportTransfer(vaultID string) ([]byte, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	value, err := r.vaultLockedRead(vaultID)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(TransferPackage{
		VaultID: value.VaultID, Label: cloneString(value.Label), Lifecycle: value.Lifecycle,
		RecoveryHash: value.RecoveryHash, GenerationID: value.GenerationID,
		Remotes: append([]remoteState(nil), value.Remotes...),
	})
	if err != nil {
		return nil, fmt.Errorf("encode transfer package: %w", err)
	}
	return payload, nil
}

// TransferPackageVaultID validates and reads the identity carried by the
// current Runtime-owned transfer snapshot. The Application layer uses it to
// bind a staged transfer to the Vault ID that was authorized when the transfer
// began; a future Complete Export decoder will provide the same check for its
// authenticated manifest.
func TransferPackageVaultID(payload []byte) (string, error) {
	var packageValue TransferPackage
	if err := decode(json.RawMessage(payload), &packageValue); err != nil {
		return "", commandError("TRANSFER_PACKAGE_INVALID", "The transfer package is invalid.")
	}
	candidate := persistedVault{
		VaultID: packageValue.VaultID, Label: packageValue.Label, Lifecycle: packageValue.Lifecycle,
		RecoveryHash: packageValue.RecoveryHash, GenerationID: packageValue.GenerationID,
		Remotes: append([]remoteState(nil), packageValue.Remotes...),
	}
	if err := validatePersistedVault(candidate); err != nil {
		return "", commandError("TRANSFER_PACKAGE_INVALID", "The transfer package is invalid.")
	}
	return packageValue.VaultID, nil
}

func (r *Runtime) stateLocked() ClientState {
	state := ClientState{Vaults: make([]VaultSummary, 0, len(r.vaults))}
	if r.selected != "" {
		selected := r.selected
		state.SelectedVaultID = &selected
	}
	if r.pending != nil && r.pending.Kind == "create" {
		expected := cloneString(r.pending.ExpectedVaultID)
		state.PendingVaultCreation = &PendingCreationState{
			SetupID:         r.pending.SetupID,
			ExpectedVaultID: expected,
		}
	}
	ids := make([]string, 0, len(r.vaults))
	for id := range r.vaults {
		ids = append(ids, id)
	}
	// IDs are digests and sorting gives a stable projection without adding an
	// ordering claim to Vault authority.
	sortStrings(ids)
	for _, id := range ids {
		value := r.vaults[id]
		access := "ReadOnly"
		if value.Lifecycle == "Open" {
			access = "Authoring"
		}
		state.Vaults = append(state.Vaults, VaultSummary{
			VaultID:   value.VaultID,
			Label:     cloneString(value.Label),
			Lifecycle: value.Lifecycle,
			Access:    access,
			Selected:  value.VaultID == r.selected,
		})
	}
	return state
}

func (r *Runtime) Handle(ctx context.Context, raw json.RawMessage) (any, error) {
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &kind); err != nil || kind.Type == "" {
		return nil, commandError("APPLICATION_PROTOCOL_INVALID", "Unsupported application Command")
	}
	switch kind.Type {
	case "GetState":
		var input struct {
			Type string `json:"type"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "GetState contains unknown fields")
		}
		return r.State(), nil
	case "BeginVaultCreation":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID *string `json:"expectedVaultId"`
			Label           *string `json:"label"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "BeginVaultCreation contains invalid fields")
		}
		return r.beginCreation(ctx, input.ExpectedVaultID, input.Label)
	case "ConfirmVaultCreation":
		var input struct {
			Type           string `json:"type"`
			SetupID        string `json:"setupId"`
			RecoveryPhrase string `json:"recoveryPhrase"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ConfirmVaultCreation contains invalid fields")
		}
		return r.confirmCreation(ctx, input.SetupID, input.RecoveryPhrase)
	case "CancelVaultCreation":
		var input struct {
			Type    string `json:"type"`
			SetupID string `json:"setupId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CancelVaultCreation contains invalid fields")
		}
		return nil, r.cancelSetup(ctx, input.SetupID, "create")
	case "SelectVault":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID *string `json:"expectedVaultId"`
			VaultID         string  `json:"vaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "SelectVault contains invalid fields")
		}
		return r.selectVault(ctx, input.ExpectedVaultID, input.VaultID)
	case "BeginVaultFork":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "BeginVaultFork contains invalid fields")
		}
		return r.beginFork(ctx, input.ExpectedVaultID)
	case "ConfirmVaultFork":
		var input struct {
			Type           string `json:"type"`
			SetupID        string `json:"setupId"`
			RecoveryPhrase string `json:"recoveryPhrase"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ConfirmVaultFork contains invalid fields")
		}
		return r.confirmFork(ctx, input.SetupID, input.RecoveryPhrase)
	case "CancelVaultFork":
		var input struct {
			Type    string `json:"type"`
			SetupID string `json:"setupId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CancelVaultFork contains invalid fields")
		}
		return nil, r.cancelSetup(ctx, input.SetupID, "fork")
	case "RecoverMember":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RecoveryPhrase  string `json:"recoveryPhrase"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RecoverMember contains invalid fields")
		}
		return r.recoverMember(ctx, input.ExpectedVaultID, input.RecoveryPhrase)
	case "BeginRecoveryPhraseReplacement":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "BeginRecoveryPhraseReplacement contains invalid fields")
		}
		return r.beginReplacement(ctx, input.ExpectedVaultID)
	case "ConfirmRecoveryPhraseReplacement":
		var input struct {
			Type           string `json:"type"`
			SetupID        string `json:"setupId"`
			RecoveryPhrase string `json:"recoveryPhrase"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ConfirmRecoveryPhraseReplacement contains invalid fields")
		}
		return r.confirmReplacement(ctx, input.SetupID, input.RecoveryPhrase)
	case "CancelRecoveryPhraseReplacement":
		var input struct {
			Type    string `json:"type"`
			SetupID string `json:"setupId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CancelRecoveryPhraseReplacement contains invalid fields")
		}
		return nil, r.cancelSetup(ctx, input.SetupID, "replacement")
	case "CloseVault":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CloseVault contains invalid fields")
		}
		return r.closeVault(ctx, input.ExpectedVaultID)
	case "VacuumVault":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "VacuumVault contains invalid fields")
		}
		return r.vacuumVault(ctx, input.ExpectedVaultID)
	case "ListLibrary":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ListLibrary contains invalid fields")
		}
		if err := r.requireVault(input.ExpectedVaultID); err != nil {
			return nil, err
		}
		return []any{}, nil
	case "ListRemotes":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ListRemotes contains invalid fields")
		}
		return r.listRemotes(input.ExpectedVaultID)
	case "RenameRemote":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RemoteID        string `json:"remoteId"`
			Name            string `json:"name"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RenameRemote contains invalid fields")
		}
		return r.renameRemote(ctx, input.ExpectedVaultID, input.RemoteID, input.Name)
	case "SetRemoteEnabled":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RemoteID        string `json:"remoteId"`
			Enabled         bool   `json:"enabled"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "SetRemoteEnabled contains invalid fields")
		}
		return r.setRemoteEnabled(ctx, input.ExpectedVaultID, input.RemoteID, input.Enabled)
	case "RetireRemote":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RemoteID        string `json:"remoteId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RetireRemote contains invalid fields")
		}
		return r.retireRemote(ctx, input.ExpectedVaultID, input.RemoteID)
	case "CreateHostedReplica":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			Endpoint        string `json:"endpoint"`
			Name            string `json:"name"`
			Username        string `json:"username"`
			Password        string `json:"password"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CreateHostedReplica contains invalid fields")
		}
		return r.createRemote(ctx, input.ExpectedVaultID, input.Endpoint, input.Name, input.Username, input.Password)
	case "BeginHostedReplicaAttachment":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			Endpoint        string `json:"endpoint"`
			Name            string `json:"name"`
			Username        string `json:"username"`
			Password        string `json:"password"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "BeginHostedReplicaAttachment contains invalid fields")
		}
		return nil, commandError("HOSTED_REPLICA_ATTACHMENT_UNAVAILABLE", "Hosted Replica attachment is not available in this Runtime slice yet.")
	case "ConfirmHostedReplicaAttachment":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			SetupID         string `json:"setupId"`
			ReplicaHandle   string `json:"replicaHandle"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ConfirmHostedReplicaAttachment contains invalid fields")
		}
		return nil, commandError("HOSTED_REPLICA_ATTACHMENT_UNAVAILABLE", "Hosted Replica attachment is not available in this Runtime slice yet.")
	case "CancelHostedReplicaAttachment":
		var input struct {
			Type    string `json:"type"`
			SetupID string `json:"setupId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CancelHostedReplicaAttachment contains invalid fields")
		}
		return nil, r.cancelSetup(ctx, input.SetupID, "attachment")
	case "MaterializeHostedReplica":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RemoteID        string `json:"remoteId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "MaterializeHostedReplica contains invalid fields")
		}
		return nil, commandError("HOSTED_REPLICA_MATERIALIZATION_UNAVAILABLE", "Hosted Replica materialization is not available in this Runtime slice yet.")
	case "PullHostedReplicas":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "PullHostedReplicas contains invalid fields")
		}
		return nil, commandError("HOSTED_REPLICA_PULL_UNAVAILABLE", "Hosted Replica synchronization is not available in this Runtime slice yet.")
	case "HydrateArtifact":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			ArtifactID      string `json:"artifactId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "HydrateArtifact contains invalid fields")
		}
		return nil, commandError("ARTIFACT_UNAVAILABLE", "This desktop Vault has no verified copy of that Artifact.")
	case "CaptureActivePage":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TabID           *int   `json:"tabId"`
		}
		if err := decode(raw, &input); err != nil || (input.TabID != nil && *input.TabID < 0) {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CaptureActivePage contains invalid fields")
		}
		return nil, commandError("CAPTURE_UNAVAILABLE", "Desktop page capture is not available.")
	case "RecoverHostedMember":
		var input struct {
			Type           string `json:"type"`
			Endpoint       string `json:"endpoint"`
			Username       string `json:"username"`
			Password       string `json:"password"`
			RecoveryPhrase string `json:"recoveryPhrase"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RecoverHostedMember contains invalid fields")
		}
		return nil, commandError("HOSTED_RECOVERY_UNAVAILABLE", "Hosted Vault recovery is not available from this desktop Client yet.")
	default:
		return nil, commandError("APPLICATION_PROTOCOL_INVALID", "Unsupported application Command")
	}
}

func (r *Runtime) beginCreation(ctx context.Context, expected, label *string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(expected); err != nil {
		return nil, err
	}
	if r.pending != nil {
		return nil, commandError("VAULT_CREATION_PENDING", "Finish or cancel the existing Vault setup first.")
	}
	if label != nil && len(*label) > 1_024 {
		return nil, commandError("VAULT_LABEL_INVALID", "Vault label is too long.")
	}
	phrase, err := recoveryPhrase()
	if err != nil {
		return nil, err
	}
	setup := &pendingState{Kind: "create", SetupID: uuid.NewString(), ExpectedVaultID: cloneString(expected), Label: cloneString(label), PhraseHash: hashPhrase(phrase)}
	r.pending = setup
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	return map[string]string{"setupId": setup.SetupID, "recoveryPhrase": phrase}, nil
}

func (r *Runtime) confirmCreation(ctx context.Context, setupID, phrase string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	pending := r.pending
	if pending == nil || pending.Kind != "create" || pending.SetupID != setupID {
		return nil, commandError("VAULT_CREATION_NOT_FOUND", "Vault creation setup was not found.")
	}
	if err := r.requireExpectedLocked(pending.ExpectedVaultID); err != nil {
		return nil, err
	}
	if hashPhrase(phrase) != pending.PhraseHash {
		return nil, commandError("RECOVERY_PHRASE_MISMATCH", "The Recovery Phrase does not match.")
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	generation, err := randomID()
	if err != nil {
		return nil, err
	}
	value := &persistedVault{VaultID: id, Label: cloneString(pending.Label), Lifecycle: "Open", RecoveryHash: pending.PhraseHash, GenerationID: generation, Remotes: []remoteState{}, RecoveryRevision: 1}
	r.vaults[id] = value
	r.selected = id
	r.pending = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return map[string]string{"vaultId": id}, nil
}

func (r *Runtime) cancelSetup(ctx context.Context, setupID, kind string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if r.pending == nil || r.pending.SetupID != setupID || r.pending.Kind != kind {
		return commandError("SETUP_NOT_FOUND", "The pending Vault setup was not found.")
	}
	r.pending = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return err
	}
	r.signal()
	return nil
}

func (r *Runtime) selectVault(ctx context.Context, expected *string, id string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(expected); err != nil {
		return nil, err
	}
	if _, ok := r.vaults[id]; !ok {
		return nil, commandError("VAULT_NOT_FOUND", "The selected Vault was not found.")
	}
	r.selected = id
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return r.stateLocked(), nil
}

func (r *Runtime) beginFork(ctx context.Context, id string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	if value.Lifecycle != "Open" {
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot be Forked from this Client.")
	}
	if r.pending != nil {
		return nil, commandError("VAULT_SETUP_PENDING", "Finish or cancel the existing Vault setup first.")
	}
	phrase, err := recoveryPhrase()
	if err != nil {
		return nil, err
	}
	r.pending = &pendingState{Kind: "fork", SetupID: uuid.NewString(), ExpectedVaultID: cloneString(&id), SourceVaultID: id, PhraseHash: hashPhrase(phrase), Label: cloneString(value.Label)}
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	return map[string]string{"setupId": r.pending.SetupID, "recoveryPhrase": phrase}, nil
}

func (r *Runtime) confirmFork(ctx context.Context, setupID, phrase string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	pending := r.pending
	if pending == nil || pending.Kind != "fork" || pending.SetupID != setupID {
		return nil, commandError("VAULT_FORK_NOT_FOUND", "Vault Fork setup was not found.")
	}
	if err := r.requireExpectedLocked(pending.ExpectedVaultID); err != nil {
		return nil, err
	}
	if hashPhrase(phrase) != pending.PhraseHash {
		return nil, commandError("RECOVERY_PHRASE_MISMATCH", "The Recovery Phrase does not match.")
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	generation, err := randomID()
	if err != nil {
		return nil, err
	}
	label := cloneString(pending.Label)
	if label != nil {
		forkLabel := *label + " (Fork)"
		label = &forkLabel
	}
	source := r.vaults[pending.SourceVaultID]
	r.vaults[id] = &persistedVault{VaultID: id, Label: label, Lifecycle: "Open", RecoveryHash: pending.PhraseHash, GenerationID: generation, Remotes: append([]remoteState(nil), source.Remotes...), RecoveryRevision: 1}
	r.selected = id
	r.pending = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return map[string]string{"vaultId": id}, nil
}

func (r *Runtime) recoverMember(ctx context.Context, id, phrase string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	if hashPhrase(phrase) != value.RecoveryHash {
		return nil, commandError("RECOVERY_PHRASE_MISMATCH", "The Recovery Phrase does not match.")
	}
	member, err := randomID()
	if err != nil {
		return nil, err
	}
	credential, err := randomID()
	if err != nil {
		return nil, err
	}
	event, err := randomID()
	if err != nil {
		return nil, err
	}
	value.Lifecycle = "Open"
	r.selected = id
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return map[string]string{"memberId": member, "clientCredentialId": credential, "eventRecordId": event}, nil
}

func (r *Runtime) beginReplacement(ctx context.Context, id string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	if value.Lifecycle != "Open" {
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot replace its Recovery Phrase.")
	}
	if r.pending != nil {
		return nil, commandError("VAULT_SETUP_PENDING", "Finish or cancel the existing Vault setup first.")
	}
	phrase, err := recoveryPhrase()
	if err != nil {
		return nil, err
	}
	r.pending = &pendingState{Kind: "replacement", SetupID: uuid.NewString(), ExpectedVaultID: cloneString(&id), PhraseHash: hashPhrase(phrase), RecoveryRevision: value.RecoveryRevision + 1}
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	return map[string]string{"setupId": r.pending.SetupID, "recoveryPhrase": phrase}, nil
}

func (r *Runtime) confirmReplacement(ctx context.Context, setupID, phrase string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	pending := r.pending
	if pending == nil || pending.Kind != "replacement" || pending.SetupID != setupID {
		return nil, commandError("RECOVERY_REPLACEMENT_NOT_FOUND", "Recovery Phrase replacement setup was not found.")
	}
	if err := r.requireExpectedLocked(pending.ExpectedVaultID); err != nil {
		return nil, err
	}
	if hashPhrase(phrase) != pending.PhraseHash {
		return nil, commandError("RECOVERY_PHRASE_MISMATCH", "The Recovery Phrase does not match.")
	}
	value, err := r.vaultLocked(requiredString(pending.ExpectedVaultID))
	if err != nil {
		return nil, err
	}
	event, err := randomID()
	if err != nil {
		return nil, err
	}
	credential, err := randomID()
	if err != nil {
		return nil, err
	}
	value.RecoveryHash = pending.PhraseHash
	value.RecoveryRevision = pending.RecoveryRevision
	r.pending = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return map[string]any{"recoveryCredentialId": credential, "revision": value.RecoveryRevision, "eventRecordId": event}, nil
}

func (r *Runtime) closeVault(ctx context.Context, id string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	if value.Lifecycle == "Closed" {
		return nil, commandError("VAULT_ALREADY_CLOSED", "This Vault is already closed.")
	}
	event, err := randomID()
	if err != nil {
		return nil, err
	}
	value.Lifecycle = "Closed"
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return map[string]string{"eventRecordId": event}, nil
}

func (r *Runtime) vacuumVault(ctx context.Context, id string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	if value.Lifecycle != "Open" {
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot be vacuumed.")
	}
	predecessor := value.GenerationID
	successor, err := randomID()
	if err != nil {
		return nil, err
	}
	vacuumEvent, err := randomID()
	if err != nil {
		return nil, err
	}
	baseline, err := randomID()
	if err != nil {
		return nil, err
	}
	value.GenerationID = successor
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return map[string]string{"predecessorGenerationId": predecessor, "successorGenerationId": successor, "vacuumEventRecordId": vacuumEvent, "successorBaselineId": baseline}, nil
}

func (r *Runtime) listRemotes(id string) (any, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLockedRead(id)
	if err != nil {
		return nil, err
	}
	result := make([]RemoteSummary, 0, len(value.Remotes))
	for _, remote := range value.Remotes {
		result = append(result, RemoteSummary{RemoteID: remote.RemoteID, Name: remote.Name, Endpoint: remote.Endpoint, Enabled: remote.Enabled})
	}
	return result, nil
}

func (r *Runtime) renameRemote(ctx context.Context, id, remoteID, name string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	if len(name) < 1 || len(name) > 256 {
		return nil, commandError("REMOTE_NAME_INVALID", "Hosted Replica name is invalid.")
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	for index := range value.Remotes {
		if value.Remotes[index].RemoteID == remoteID {
			value.Remotes[index].Name = name
			if err := r.persistLocked(ctx); err != nil {
				r.restoreLocked(before)
				return nil, err
			}
			r.signal()
			return RemoteSummary{RemoteID: remoteID, Name: name, Endpoint: value.Remotes[index].Endpoint, Enabled: value.Remotes[index].Enabled}, nil
		}
	}
	return nil, commandError("REMOTE_NOT_FOUND", "The Hosted Replica was not found.")
}

func (r *Runtime) setRemoteEnabled(ctx context.Context, id, remoteID string, enabled bool) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	for index := range value.Remotes {
		if value.Remotes[index].RemoteID == remoteID {
			value.Remotes[index].Enabled = enabled
			if err := r.persistLocked(ctx); err != nil {
				r.restoreLocked(before)
				return nil, err
			}
			r.signal()
			remote := value.Remotes[index]
			return RemoteSummary{RemoteID: remote.RemoteID, Name: remote.Name, Endpoint: remote.Endpoint, Enabled: remote.Enabled}, nil
		}
	}
	return nil, commandError("REMOTE_NOT_FOUND", "The Hosted Replica was not found.")
}

func (r *Runtime) retireRemote(ctx context.Context, id, remoteID string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	for index := range value.Remotes {
		if value.Remotes[index].RemoteID == remoteID {
			value.Remotes = append(value.Remotes[:index], value.Remotes[index+1:]...)
			if err := r.persistLocked(ctx); err != nil {
				r.restoreLocked(before)
				return nil, err
			}
			r.signal()
			return map[string]any{"remoteId": remoteID, "removed": true, "deletedPreparedItemCount": 0}, nil
		}
	}
	return nil, commandError("REMOTE_NOT_FOUND", "The Hosted Replica was not found.")
}

func (r *Runtime) createRemote(ctx context.Context, id, endpoint, name, username, password string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	if err := validateEndpoint(endpoint); err != nil {
		return nil, err
	}
	if len(name) < 1 || len(name) > 256 || len(username) < 1 || len(username) > 256 || len(password) < 1 || len(password) > 1_024 {
		return nil, commandError("REMOTE_CREDENTIAL_INVALID", "Hosted Replica credentials are invalid.")
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	remoteID := uuid.NewString()
	value.Remotes = append(value.Remotes, remoteState{RemoteID: remoteID, Name: name, Endpoint: endpoint, Enabled: true})
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		return nil, err
	}
	r.signal()
	return RemoteSummary{RemoteID: remoteID, Name: name, Endpoint: endpoint, Enabled: true}, nil
}

func (r *Runtime) requireVault(id string) error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if err := r.requireExpectedLocked(&id); err != nil {
		return err
	}
	_, err := r.vaultLockedRead(id)
	return err
}

func (r *Runtime) vaultLocked(id string) (*persistedVault, error) {
	value, ok := r.vaults[id]
	if !ok {
		return nil, commandError("VAULT_NOT_FOUND", "The selected Vault was not found.")
	}
	return value, nil
}

func (r *Runtime) vaultLockedRead(id string) (*persistedVault, error) {
	value, ok := r.vaults[id]
	if !ok {
		return nil, commandError("VAULT_NOT_FOUND", "The selected Vault was not found.")
	}
	return value, nil
}

func (r *Runtime) requireExpectedLocked(expected *string) error {
	if expected == nil {
		if r.selected != "" {
			return commandError("VAULT_CONTEXT_CHANGED", "The selected Vault changed.")
		}
		return nil
	}
	if r.selected != *expected {
		return commandError("VAULT_CONTEXT_CHANGED", "The selected Vault changed.")
	}
	return nil
}

func (r *Runtime) persistLocked(ctx context.Context) error {
	snapshot := persistedState{SelectedVaultID: r.selected, Pending: r.pending, Vaults: make([]persistedVault, 0, len(r.vaults))}
	for _, value := range r.vaults {
		copyValue := *value
		copyValue.Remotes = append([]remoteState(nil), value.Remotes...)
		snapshot.Vaults = append(snapshot.Vaults, copyValue)
	}
	serialized, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("encode Vault state: %w", err)
	}
	if err := r.store.Put(ctx, persistedStateKey, serialized); err != nil {
		return fmt.Errorf("persist Vault state: %w", err)
	}
	return nil
}

func (r *Runtime) snapshotLocked() runtimeSnapshot {
	snapshot := runtimeSnapshot{selected: r.selected, pending: clonePending(r.pending), vaults: make(map[string]*persistedVault, len(r.vaults))}
	for id, value := range r.vaults {
		copyValue := *value
		copyValue.Label = cloneString(value.Label)
		copyValue.Remotes = append([]remoteState(nil), value.Remotes...)
		snapshot.vaults[id] = &copyValue
	}
	return snapshot
}

func (r *Runtime) restoreLocked(snapshot runtimeSnapshot) {
	r.selected = snapshot.selected
	r.pending = clonePending(snapshot.pending)
	r.vaults = make(map[string]*persistedVault, len(snapshot.vaults))
	for id, value := range snapshot.vaults {
		copyValue := *value
		copyValue.Label = cloneString(value.Label)
		copyValue.Remotes = append([]remoteState(nil), value.Remotes...)
		r.vaults[id] = &copyValue
	}
}

func (r *Runtime) signal() {
	if r.notify != nil {
		r.notify()
	}
}

func decode(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validatePersistedVault(value persistedVault) error {
	if !validDigest(value.VaultID) || !validDigest(value.RecoveryHash) || !validDigest(value.GenerationID) {
		return errors.New("Vault state contains an invalid Vault")
	}
	if value.Lifecycle != "Open" && value.Lifecycle != "Closed" {
		return errors.New("Vault state contains an invalid lifecycle")
	}
	for _, remote := range value.Remotes {
		if _, err := uuid.Parse(remote.RemoteID); err != nil || len(remote.Name) < 1 || len(remote.Name) > 256 {
			return errors.New("Vault state contains an invalid Hosted Replica")
		}
		if err := validateEndpoint(remote.Endpoint); err != nil {
			return errors.New("Vault state contains an invalid Hosted Replica endpoint")
		}
	}
	return nil
}

func recoveryPhrase() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate Recovery Phrase: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func hashPhrase(phrase string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(phrase)))
	return hex.EncodeToString(digest[:])
}

func randomID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate Vault identifier: %w", err)
	}
	digest := sha256.Sum256(bytes)
	return hex.EncodeToString(digest[:]), nil
}

func validDigest(value string) bool {
	bytes, err := hex.DecodeString(value)
	return err == nil && len(bytes) == sha256.Size
}

func validateEndpoint(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" || parsed.String() != value {
		return commandError("REMOTE_ENDPOINT_INVALID", "Hosted Replica endpoint must be a canonical HTTPS URL.")
	}
	return nil
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func clonePending(value *pendingState) *pendingState {
	if value == nil {
		return nil
	}
	copyValue := *value
	copyValue.ExpectedVaultID = cloneString(value.ExpectedVaultID)
	copyValue.Label = cloneString(value.Label)
	return &copyValue
}
func requiredString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func sortStrings(values []string) {
	for index := 1; index < len(values); index++ {
		current := values[index]
		position := index - 1
		for position >= 0 && values[position] > current {
			values[position+1] = values[position]
			position--
		}
		values[position+1] = current
	}
}
