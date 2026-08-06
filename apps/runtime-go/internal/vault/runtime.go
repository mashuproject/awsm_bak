// Package vault owns the desktop Client's Vault command boundary.
//
// The transport deliberately speaks in the same tagged command/result shapes
// as the browser application. Storage and cryptographic implementation details
// stay behind this package; the HTTP and Wails adapters never mutate Vault
// state directly.
package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/artifactstore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/securestore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

const persistedStateKey = "awsm.runtime.vaults"
const trustedSecretService = "awsm.runtime.trusted"

var ErrNotFound = store.ErrStateNotFound

type StateStore interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
}

type Dependencies struct {
	Artifacts *artifactstore.Store
	Secrets   securestore.Store
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

type canonicalReplicaState struct {
	VaultID                   string            `json:"vaultId"`
	GenerationID              string            `json:"generationId"`
	BaselineID                string            `json:"baselineId"`
	GenesisID                 string            `json:"genesisId"`
	KeyEpochID                string            `json:"keyEpochId"`
	RequiredFeatureSetID      string            `json:"requiredFeatureSetId"`
	MemberID                  string            `json:"memberId"`
	ClientCredentialID        string            `json:"clientCredentialId"`
	BaselineStorageItemID     string            `json:"baselineStorageItemId"`
	GenesisStorageItemID      string            `json:"genesisStorageItemId"`
	RecoveryEnvelopeID        string            `json:"recoveryEnvelopeId"`
	RecoveryEnvelopeStorageID string            `json:"recoveryEnvelopeStorageItemId"`
	ClientEnvelopeID          string            `json:"clientEnvelopeId"`
	ClientEnvelopeStorageID   string            `json:"clientEnvelopeStorageItemId"`
	CausalFrontier            []string          `json:"causalFrontier"`
	AuthorityFrontier         []string          `json:"authorityFrontier"`
	ContinuityRecordIDs       []string          `json:"continuityRecordIds"`
	RecordStorageItemIDs      map[string]string `json:"recordStorageItemIds"`
	ObjectStorageItemIDs      map[string]string `json:"objectStorageItemIds"`
}

type persistedVault struct {
	VaultID          string                 `json:"vaultId"`
	Label            *string                `json:"label"`
	Lifecycle        string                 `json:"lifecycle"`
	RecoveryHash     string                 `json:"recoveryHash"`
	GenerationID     string                 `json:"generationId"`
	Remotes          []remoteState          `json:"remotes"`
	RecoveryRevision int                    `json:"recoveryRevision"`
	Canonical        *canonicalReplicaState `json:"canonical,omitempty"`
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
	deps     Dependencies
	selected string
	vaults   map[string]*persistedVault
	replicas map[string]*Replica
	pending  *pendingState
	notify   func()
}

type runtimeSnapshot struct {
	selected string
	vaults   map[string]*persistedVault
	replicas map[string]*Replica
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

func New(ctx context.Context, state StateStore, dependencies Dependencies) (*Runtime, error) {
	if state == nil {
		return nil, errors.New("Vault state store is required")
	}
	runtime := &Runtime{store: state, deps: dependencies, vaults: make(map[string]*persistedVault), replicas: make(map[string]*Replica)}
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
		if value.Canonical != nil {
			replica, err := runtime.openCanonicalReplica(copyValue)
			if err != nil {
				return nil, fmt.Errorf("open Vault %s: %w", value.VaultID, err)
			}
			runtime.replicas[value.VaultID] = replica
		}
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

// AdmitOpaqueEvent is the local destination boundary used by synchronization
// transports. It accepts one opaque Compact Vault Record, verifies its
// authenticated envelope and Event DAG position, then commits the immutable
// bytes and derived frontiers together with Runtime metadata.
func (r *Runtime) AdmitOpaqueEvent(ctx context.Context, vaultID string, encoded []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, err := r.vaultLocked(vaultID)
	if err != nil {
		return err
	}
	if value.Canonical == nil || r.replicas[vaultID] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		return commandError("VAULT_EVENT_INVALID", "The Vault identity is invalid.")
	}
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return commandError("VAULT_EVENT_INVALID", "The Key Epoch identity is invalid.")
	}
	secretBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		return commandError("TRUSTED_SECRET_UNAVAILABLE", "The Key Epoch could not be opened.")
	}
	epochSecret, err := decodeEpochSecret(secretBytes, vaultIdentifier, epochIdentifier)
	if err != nil {
		return commandError("VAULT_EVENT_INVALID", "The Key Epoch is invalid.")
	}
	opened, err := awsmcrypto.OpenCompactItem(vaultIdentifier, epochIdentifier, epochSecret.key, encoded)
	if err != nil || opened.PayloadType != 1 {
		if err == nil {
			err = errors.New("opaque item is not a Vault Record")
		}
		return commandError("VAULT_EVENT_INVALID", "The opaque Vault Record is invalid.")
	}
	event, err := canonical.DecodeEvent(opened.PayloadBytes)
	if err != nil {
		return commandError("VAULT_EVENT_INVALID", "The opaque Vault Record is not a valid Event.")
	}
	if event.VaultID != vaultIdentifier || hexIdentifier(event.GenerationID) != value.GenerationID || hexIdentifier(event.RequiredFeatureSetID) != value.Canonical.RequiredFeatureSetID {
		return commandError("VAULT_EVENT_INVALID", "The Event belongs to another accepted context.")
	}
	nextReplica := r.replicas[vaultID].Clone()
	if err := nextReplica.AdmitKnownEvent(event); err != nil {
		return commandError("VAULT_EVENT_INVALID", "The Event failed authenticated DAG admission.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return commandError("VAULT_EVENT_INVALID", "The opaque Vault Record envelope is invalid.")
	}
	before := r.snapshotLocked()
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return commandError("VAULT_CREATION_STORAGE_FAILED", "The opaque Vault Record could not be stored.")
	}
	state := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(state.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(state.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(state.ContinuityRecordIDs)
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = hexIdentifier(envelope.StorageItemID)
	if event.Family == canonical.LifecycleFamily && event.Type == 2 {
		value.Lifecycle = "Closed"
	}
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return err
	}
	r.signal()
	return nil
}

// AdmitOpaqueObject is the Object counterpart to AdmitOpaqueEvent. Object
// bytes are authenticated independently from Event DAG state and become
// available to Library projections only after content-address verification.
func (r *Runtime) AdmitOpaqueObject(ctx context.Context, vaultID string, encoded []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, err := r.vaultLocked(vaultID)
	if err != nil {
		return err
	}
	if value.Canonical == nil || r.replicas[vaultID] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		return commandError("VAULT_OBJECT_INVALID", "The Vault identity is invalid.")
	}
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return commandError("VAULT_OBJECT_INVALID", "The Key Epoch identity is invalid.")
	}
	secretBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		return commandError("TRUSTED_SECRET_UNAVAILABLE", "The Key Epoch could not be opened.")
	}
	epochSecret, err := decodeEpochSecret(secretBytes, vaultIdentifier, epochIdentifier)
	if err != nil {
		return commandError("VAULT_OBJECT_INVALID", "The Key Epoch is invalid.")
	}
	opened, err := awsmcrypto.OpenCompactItem(vaultIdentifier, epochIdentifier, epochSecret.key, encoded)
	if err != nil || opened.PayloadType != 2 {
		return commandError("VAULT_OBJECT_INVALID", "The opaque Object is invalid.")
	}
	objectIdentifier, err := objectIDFromBytes(vaultIdentifier, opened.PayloadBytes)
	if err != nil {
		return commandError("VAULT_OBJECT_INVALID", "The Object content address is invalid.")
	}
	nextReplica := r.replicas[vaultID].Clone()
	if err := nextReplica.AdmitObject(objectIdentifier, opened.PayloadBytes); err != nil {
		return commandError("VAULT_OBJECT_INVALID", "The Object failed authenticated admission.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return commandError("VAULT_OBJECT_INVALID", "The opaque Object envelope is invalid.")
	}
	before := r.snapshotLocked()
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return commandError("VAULT_CREATION_STORAGE_FAILED", "The opaque Object could not be stored.")
	}
	value.Canonical.ObjectStorageItemIDs[hexIdentifier(objectIdentifier)] = hexIdentifier(envelope.StorageItemID)
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return err
	}
	r.signal()
	return nil
}

func objectIDFromBytes(vaultID canonical.Identifier, encoded []byte) (canonical.Identifier, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return canonical.Identifier{}, err
	}
	objectType, ok := replicaMapNumber(value, 2)
	if !ok {
		return canonical.Identifier{}, errors.New("Object type is invalid")
	}
	return canonical.VaultObjectID(vaultID, objectType, encoded)
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
		return r.listLibrary(input.ExpectedVaultID)
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
	if r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "This Client cannot create a Vault without its secure storage facility.")
	}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{
		Label:          cloneString(pending.Label),
		RecoveryPhrase: phrase,
	})
	if err != nil {
		return nil, commandError("VAULT_CREATION_INVALID", "The Vault creation ceremony could not be prepared.")
	}
	canonicalState := canonicalReplicaFromCreation(prepared)
	storedItems := [][32]byte{
		prepared.BaselineEnvelope.StorageItemID, prepared.GenesisEnvelope.StorageItemID,
		prepared.RecoveryKeyEnvelope.Envelope.StorageItemID, prepared.ClientKeyEnvelope.Envelope.StorageItemID,
	}
	cleanup := func() {
		for _, itemID := range storedItems {
			deleteOpaqueCreationItem(r.deps.Artifacts, itemID)
		}
		_ = r.deps.Secrets.Delete(trustedSecretService, clientSecretAccount(canonicalState.VaultID, canonicalState.ClientCredentialID))
		_ = r.deps.Secrets.Delete(trustedSecretService, epochSecretAccount(canonicalState.VaultID, canonicalState.KeyEpochID))
		wipeCreationSecrets(&prepared)
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, prepared.BaselineEnvelope.StorageItemID, prepared.BaselineEnvelope.Bytes); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Initial Baseline could not be stored.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, prepared.GenesisEnvelope.StorageItemID, prepared.GenesisEnvelope.Bytes); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Genesis could not be stored.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, prepared.RecoveryKeyEnvelope.Envelope.StorageItemID, prepared.RecoveryKeyEnvelope.Envelope.Bytes); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Recovery Key Envelope could not be stored.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, prepared.ClientKeyEnvelope.Envelope.StorageItemID, prepared.ClientKeyEnvelope.Envelope.Bytes); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Client Key Envelope could not be stored.")
	}
	clientSecret, err := encodeClientSecret(prepared)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Client Credential could not be protected.")
	}
	if err := r.deps.Secrets.Put(trustedSecretService, clientSecretAccount(canonicalState.VaultID, canonicalState.ClientCredentialID), clientSecret); err != nil {
		cleanup()
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be stored in secure storage.")
	}
	epochSecret, err := encodeEpochSecret(prepared)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Key Epoch could not be protected.")
	}
	if err := r.deps.Secrets.Put(trustedSecretService, epochSecretAccount(canonicalState.VaultID, canonicalState.KeyEpochID), epochSecret); err != nil {
		cleanup()
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Key Epoch could not be stored in secure storage.")
	}
	id := canonicalState.VaultID
	generation := hexIdentifier(prepared.IDs.GenerationID)
	value := &persistedVault{VaultID: id, Label: cloneString(pending.Label), Lifecycle: "Open", RecoveryHash: pending.PhraseHash, GenerationID: generation, Remotes: []remoteState{}, RecoveryRevision: 1, Canonical: canonicalState}
	replica, err := newReplicaFromPreparedCreation(prepared)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_INVALID", "The authenticated initial Replica could not be opened.")
	}
	r.vaults[id] = value
	r.replicas[id] = replica
	r.selected = id
	r.pending = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		cleanup()
		return nil, err
	}
	wipeCreationSecrets(&prepared)
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
	if value.Canonical == nil || r.replicas[id] == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	clientSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(id, value.Canonical.ClientCredentialID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be opened.")
	}
	vaultID, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Member identity is invalid.")
	}
	credentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential identity is invalid.")
	}
	clientSecret, err := decodeClientSecret(clientSecretBytes, vaultID, memberID, credentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential is invalid.")
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch identity is invalid.")
	}
	epochSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, value.Canonical.KeyEpochID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Key Epoch could not be opened.")
	}
	epochSecret, err := decodeEpochSecret(epochSecretBytes, vaultID, epochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch is invalid.")
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	replicaState := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID,
		ParentRecordIDs: cloneIdentifiers(replicaState.CausalFrontier), AuthorityParentIDs: cloneIdentifiers(replicaState.AuthorityFrontier),
		Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{},
		Family: canonical.LifecycleFamily, Type: 2, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(), Body: canonical.Map{},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Closure Event could not be authored.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Closure Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Closure Event envelope is invalid.")
	}
	if err := r.replicas[id].AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Closure Event could not be admitted.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Closure Event could not be stored.")
	}
	value.Lifecycle = "Closed"
	value.Canonical.CausalFrontier = []string{hexIdentifier(event.RecordID)}
	value.Canonical.AuthorityFrontier = []string{hexIdentifier(event.RecordID)}
	value.Canonical.ContinuityRecordIDs = appendUniqueStrings(value.Canonical.ContinuityRecordIDs, hexIdentifier(event.RecordID))
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = hexIdentifier(envelope.StorageItemID)
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return nil, err
	}
	r.signal()
	return map[string]string{"eventRecordId": hexIdentifier(event.RecordID)}, nil
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

func (r *Runtime) listLibrary(id string) (any, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	if _, err := r.vaultLockedRead(id); err != nil {
		return nil, err
	}
	replica := r.replicas[id]
	if replica == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	items, err := ProjectLibrary(replica)
	if err != nil {
		return nil, commandError("LIBRARY_UNAVAILABLE", "The Vault Library could not be rebuilt from authenticated state.")
	}
	return items, nil
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
		copyValue.Canonical = cloneCanonicalState(value.Canonical)
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
	snapshot := runtimeSnapshot{selected: r.selected, pending: clonePending(r.pending), vaults: make(map[string]*persistedVault, len(r.vaults)), replicas: make(map[string]*Replica, len(r.replicas))}
	for id, value := range r.vaults {
		copyValue := *value
		copyValue.Label = cloneString(value.Label)
		copyValue.Canonical = cloneCanonicalState(value.Canonical)
		copyValue.Remotes = append([]remoteState(nil), value.Remotes...)
		snapshot.vaults[id] = &copyValue
	}
	for id, replica := range r.replicas {
		snapshot.replicas[id] = replica.Clone()
	}
	return snapshot
}

func (r *Runtime) restoreLocked(snapshot runtimeSnapshot) {
	r.selected = snapshot.selected
	r.pending = clonePending(snapshot.pending)
	r.vaults = make(map[string]*persistedVault, len(snapshot.vaults))
	r.replicas = make(map[string]*Replica, len(snapshot.replicas))
	for id, value := range snapshot.vaults {
		copyValue := *value
		copyValue.Label = cloneString(value.Label)
		copyValue.Canonical = cloneCanonicalState(value.Canonical)
		copyValue.Remotes = append([]remoteState(nil), value.Remotes...)
		r.vaults[id] = &copyValue
	}
	for id, replica := range snapshot.replicas {
		r.replicas[id] = replica.Clone()
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
	if value.Canonical != nil {
		for _, identifier := range []string{
			value.Canonical.VaultID, value.Canonical.GenerationID, value.Canonical.BaselineID, value.Canonical.GenesisID, value.Canonical.KeyEpochID, value.Canonical.RequiredFeatureSetID,
			value.Canonical.MemberID, value.Canonical.ClientCredentialID,
			value.Canonical.BaselineStorageItemID, value.Canonical.GenesisStorageItemID,
			value.Canonical.RecoveryEnvelopeID, value.Canonical.RecoveryEnvelopeStorageID,
			value.Canonical.ClientEnvelopeID, value.Canonical.ClientEnvelopeStorageID,
		} {
			if !validDigest(identifier) {
				return errors.New("Vault state contains an invalid canonical identity")
			}
		}
		if len(value.Canonical.CausalFrontier) == 0 || len(value.Canonical.AuthorityFrontier) == 0 || len(value.Canonical.ContinuityRecordIDs) == 0 {
			return errors.New("Vault state contains incomplete canonical frontiers")
		}
		for _, frontier := range [][]string{value.Canonical.CausalFrontier, value.Canonical.AuthorityFrontier, value.Canonical.ContinuityRecordIDs} {
			for _, identifier := range frontier {
				if !validDigest(identifier) {
					return errors.New("Vault state contains an invalid canonical frontier identity")
				}
			}
		}
		if len(value.Canonical.RecordStorageItemIDs) == 0 {
			return errors.New("Vault state contains no canonical Record storage mappings")
		}
		for recordID, storageItemID := range value.Canonical.RecordStorageItemIDs {
			if !validDigest(recordID) || !validDigest(storageItemID) {
				return errors.New("Vault state contains an invalid canonical Record storage mapping")
			}
		}
		for objectID, storageItemID := range value.Canonical.ObjectStorageItemIDs {
			if !validDigest(objectID) || !validDigest(storageItemID) {
				return errors.New("Vault state contains an invalid canonical Object storage mapping")
			}
		}
	}
	return nil
}

func recoveryPhrase() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate Recovery Phrase: %w", err)
	}
	return awsmcrypto.EncodeRecoveryPhrase(bytes)
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

func cloneCanonicalState(value *canonicalReplicaState) *canonicalReplicaState {
	if value == nil {
		return nil
	}
	copyValue := *value
	copyValue.CausalFrontier = append([]string(nil), value.CausalFrontier...)
	copyValue.AuthorityFrontier = append([]string(nil), value.AuthorityFrontier...)
	copyValue.ContinuityRecordIDs = append([]string(nil), value.ContinuityRecordIDs...)
	copyValue.RecordStorageItemIDs = make(map[string]string, len(value.RecordStorageItemIDs))
	for recordID, storageItemID := range value.RecordStorageItemIDs {
		copyValue.RecordStorageItemIDs[recordID] = storageItemID
	}
	copyValue.ObjectStorageItemIDs = make(map[string]string, len(value.ObjectStorageItemIDs))
	for objectID, storageItemID := range value.ObjectStorageItemIDs {
		copyValue.ObjectStorageItemIDs[objectID] = storageItemID
	}
	return &copyValue
}

func canonicalReplicaFromCreation(prepared PreparedCanonicalVaultCreation) *canonicalReplicaState {
	return &canonicalReplicaState{
		VaultID:                   hexIdentifier(prepared.IDs.VaultID),
		GenerationID:              hexIdentifier(prepared.IDs.GenerationID),
		BaselineID:                hexIdentifier(prepared.Baseline.RecordID),
		GenesisID:                 hexIdentifier(prepared.Genesis.RecordID),
		KeyEpochID:                hexIdentifier(prepared.KeyEpochID),
		RequiredFeatureSetID:      hexIdentifier(prepared.RequiredFeatureSetID),
		MemberID:                  hexIdentifier(prepared.IDs.FirstMemberID),
		ClientCredentialID:        hexIdentifier(prepared.IDs.ClientCredentialID),
		BaselineStorageItemID:     hexIdentifier(prepared.BaselineEnvelope.StorageItemID),
		GenesisStorageItemID:      hexIdentifier(prepared.GenesisEnvelope.StorageItemID),
		RecoveryEnvelopeID:        hexIdentifier(prepared.RecoveryKeyEnvelope.ID),
		RecoveryEnvelopeStorageID: hexIdentifier(prepared.RecoveryKeyEnvelope.Envelope.StorageItemID),
		ClientEnvelopeID:          hexIdentifier(prepared.ClientKeyEnvelope.ID),
		ClientEnvelopeStorageID:   hexIdentifier(prepared.ClientKeyEnvelope.Envelope.StorageItemID),
		CausalFrontier:            []string{hexIdentifier(prepared.Genesis.RecordID)},
		AuthorityFrontier:         []string{hexIdentifier(prepared.Genesis.RecordID)},
		ContinuityRecordIDs:       []string{hexIdentifier(prepared.Genesis.RecordID)},
		RecordStorageItemIDs: map[string]string{
			hexIdentifier(prepared.Baseline.RecordID): hexIdentifier(prepared.BaselineEnvelope.StorageItemID),
			hexIdentifier(prepared.Genesis.RecordID):  hexIdentifier(prepared.GenesisEnvelope.StorageItemID),
		},
		ObjectStorageItemIDs: map[string]string{},
	}
}

func newReplicaFromPreparedCreation(prepared PreparedCanonicalVaultCreation) (*Replica, error) {
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		return nil, err
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		return nil, err
	}
	return replica, nil
}

func (r *Runtime) openCanonicalReplica(value persistedVault) (*Replica, error) {
	if value.Canonical == nil {
		return nil, errors.New("canonical Replica state is missing")
	}
	if r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, securestore.ErrUnavailable
	}
	state := value.Canonical
	if state.VaultID != value.VaultID || state.GenerationID != value.GenerationID {
		return nil, errors.New("canonical Replica identity does not match Vault metadata")
	}
	vaultID, err := decodeHexIdentifier(state.VaultID)
	if err != nil {
		return nil, err
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, err
	}
	epochID, err := decodeHexIdentifier(state.KeyEpochID)
	if err != nil {
		return nil, err
	}
	epochSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(state.VaultID, state.KeyEpochID))
	if err != nil {
		return nil, fmt.Errorf("read Key Epoch Trusted Secret: %w", err)
	}
	epochSecret, err := decodeEpochSecret(epochSecretBytes, vaultID, epochID)
	if err != nil {
		return nil, err
	}
	clientCredentialID, err := decodeHexIdentifier(state.ClientCredentialID)
	if err != nil {
		return nil, err
	}
	memberID, err := decodeHexIdentifier(state.MemberID)
	if err != nil {
		return nil, err
	}
	clientSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(state.VaultID, state.ClientCredentialID))
	if err != nil {
		return nil, fmt.Errorf("read Client Credential Trusted Secret: %w", err)
	}
	clientSecret, err := decodeClientSecret(clientSecretBytes, vaultID, memberID, clientCredentialID)
	if err != nil {
		return nil, err
	}
	readArtifact := func(id string) ([]byte, error) {
		reader, err := r.deps.Artifacts.Open(id)
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(reader)
	}
	baselineBytes, err := readArtifact(state.BaselineStorageItemID)
	if err != nil {
		return nil, fmt.Errorf("read Initial Baseline: %w", err)
	}
	openedBaseline, err := awsmcrypto.OpenCompactItem(vaultID, epochID, epochSecret.key, baselineBytes)
	if err != nil || openedBaseline.PayloadType != 1 {
		if err == nil {
			err = errors.New("Initial Baseline payload type is invalid")
		}
		return nil, err
	}
	if hexIdentifier(openedBaseline.Envelope.StorageItemID) != state.BaselineStorageItemID {
		return nil, errors.New("Initial Baseline Storage Item identity changed")
	}
	baseline, err := canonical.DecodeBaseline(openedBaseline.PayloadBytes)
	if err != nil {
		return nil, fmt.Errorf("decode Initial Baseline: %w", err)
	}
	if baseline.VaultID != vaultID || baseline.GenerationID != generationID || hexIdentifier(baseline.RecordID) != state.BaselineID || hexIdentifier(baseline.RequiredFeatureSetID) != state.RequiredFeatureSetID {
		return nil, errors.New("Initial Baseline identity does not match persisted Replica state")
	}
	genesisBytes, err := readArtifact(state.GenesisStorageItemID)
	if err != nil {
		return nil, fmt.Errorf("read Genesis: %w", err)
	}
	openedGenesis, err := awsmcrypto.OpenCompactItem(vaultID, epochID, epochSecret.key, genesisBytes)
	if err != nil || openedGenesis.PayloadType != 1 {
		if err == nil {
			err = errors.New("Genesis payload type is invalid")
		}
		return nil, err
	}
	if hexIdentifier(openedGenesis.Envelope.StorageItemID) != state.GenesisStorageItemID {
		return nil, errors.New("Genesis Storage Item identity changed")
	}
	genesis, err := canonical.DecodeEvent(openedGenesis.PayloadBytes)
	if err != nil {
		return nil, fmt.Errorf("decode Genesis: %w", err)
	}
	if genesis.VaultID != vaultID || genesis.GenerationID != generationID || hexIdentifier(genesis.RecordID) != state.GenesisID || hexIdentifier(genesis.RequiredFeatureSetID) != state.RequiredFeatureSetID {
		return nil, errors.New("Genesis identity does not match persisted Replica state")
	}
	clientEnvelopeBytes, err := readArtifact(state.ClientEnvelopeStorageID)
	if err != nil {
		return nil, fmt.Errorf("read Client Key Envelope: %w", err)
	}
	clientEnvelope, err := awsmcrypto.OpenKeyEnvelope(awsmcrypto.ClientCredentialTarget, clientSecret.wrappingPrivateKey, clientEnvelopeBytes)
	if err != nil {
		return nil, fmt.Errorf("open Client Key Envelope: %w", err)
	}
	if hexIdentifier(clientEnvelope.ID) != state.ClientEnvelopeID || clientEnvelope.VaultID != vaultID || clientEnvelope.KeyEpochID != epochID || clientEnvelope.TargetCredentialID != clientCredentialID {
		return nil, errors.New("Client Key Envelope identity does not match persisted Replica state")
	}
	recoveryEnvelopeBytes, err := readArtifact(state.RecoveryEnvelopeStorageID)
	if err != nil {
		return nil, fmt.Errorf("read Recovery Key Envelope: %w", err)
	}
	recoveryEnvelope, err := storage.DecodeOpaqueEnvelope(recoveryEnvelopeBytes)
	if err != nil || hexIdentifier(recoveryEnvelope.StorageItemID) != state.RecoveryEnvelopeStorageID {
		if err == nil {
			err = errors.New("Recovery Key Envelope Storage Item identity changed")
		}
		return nil, err
	}
	replica, err := NewReplica(baseline)
	if err != nil {
		return nil, err
	}
	if err := replica.AdmitEvent(genesis, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		return nil, fmt.Errorf("admit persisted Genesis: %w", err)
	}
	if state.RecordStorageItemIDs[state.BaselineID] != state.BaselineStorageItemID || state.RecordStorageItemIDs[state.GenesisID] != state.GenesisStorageItemID {
		return nil, errors.New("initial Record storage mappings do not match canonical Replica state")
	}
	additional := make(map[string]canonical.Event)
	for recordID, storageItemID := range state.RecordStorageItemIDs {
		if recordID == state.BaselineID || recordID == state.GenesisID {
			continue
		}
		encoded, err := readArtifact(storageItemID)
		if err != nil {
			return nil, fmt.Errorf("read persisted Record %s: %w", recordID, err)
		}
		opened, err := awsmcrypto.OpenCompactItem(vaultID, epochID, epochSecret.key, encoded)
		if err != nil || opened.PayloadType != 1 {
			if err == nil {
				err = errors.New("persisted Record payload type is invalid")
			}
			return nil, err
		}
		event, err := canonical.DecodeEvent(opened.PayloadBytes)
		if err != nil {
			return nil, fmt.Errorf("decode persisted Record %s: %w", recordID, err)
		}
		if hexIdentifier(event.RecordID) != recordID || hexIdentifier(opened.Envelope.StorageItemID) != storageItemID {
			return nil, errors.New("persisted Record identity does not match canonical storage mapping")
		}
		additional[recordID] = event
	}
	for len(additional) > 0 {
		progress := false
		for _, recordID := range sortedStringKeys(additional) {
			event := additional[recordID]
			if !replicaParentsAdmitted(replica, event) {
				continue
			}
			if err := replica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
				return nil, fmt.Errorf("admit persisted Record %s: %w", recordID, err)
			}
			delete(additional, recordID)
			progress = true
		}
		if !progress {
			return nil, errors.New("persisted Record graph cannot reach its admitted parents")
		}
	}
	for objectID, storageItemID := range state.ObjectStorageItemIDs {
		encoded, err := readArtifact(storageItemID)
		if err != nil {
			return nil, fmt.Errorf("read persisted Object %s: %w", objectID, err)
		}
		opened, err := awsmcrypto.OpenCompactItem(vaultID, epochID, epochSecret.key, encoded)
		if err != nil || opened.PayloadType != 2 {
			if err == nil {
				err = errors.New("persisted Object payload type is invalid")
			}
			return nil, err
		}
		objectIdentifier, err := decodeHexIdentifier(objectID)
		if err != nil {
			return nil, err
		}
		if err := replica.AdmitObject(objectIdentifier, opened.PayloadBytes); err != nil {
			return nil, fmt.Errorf("admit persisted Object %s: %w", objectID, err)
		}
		if hexIdentifier(opened.Envelope.StorageItemID) != storageItemID {
			return nil, errors.New("persisted Object Storage Item identity changed")
		}
	}
	actual := replica.State()
	if !identifierSetEqual(actual.CausalFrontier, state.CausalFrontier) || !identifierSetEqual(actual.AuthorityFrontier, state.AuthorityFrontier) || !identifierSetEqual(actual.ContinuityRecordIDs, state.ContinuityRecordIDs) {
		return nil, errors.New("persisted Replica frontiers do not match authenticated records")
	}
	return replica, nil
}

type decodedEpochSecret struct {
	key []byte
}

type decodedClientSecret struct {
	signingPublicKey   []byte
	signingSecretKey   []byte
	wrappingPrivateKey []byte
}

func decodeEpochSecret(encoded []byte, vaultID, epochID canonical.Identifier) (decodedEpochSecret, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return decodedEpochSecret{}, fmt.Errorf("decode Key Epoch Trusted Secret: %w", err)
	}
	if !canonicalMapHasKeys(value, 5) {
		return decodedEpochSecret{}, errors.New("Key Epoch Trusted Secret fields are invalid")
	}
	if number, ok := canonicalMapNumber(value, 0); !ok || number != 1 {
		return decodedEpochSecret{}, errors.New("Key Epoch Trusted Secret format is invalid")
	}
	encodedVault, ok := canonicalMapBytes(value, 1, 32)
	if !ok || !bytes.Equal(encodedVault, vaultID[:]) {
		return decodedEpochSecret{}, errors.New("Key Epoch Trusted Secret Vault binding is invalid")
	}
	encodedEpoch, ok := canonicalMapBytes(value, 2, 32)
	if !ok || !bytes.Equal(encodedEpoch, epochID[:]) {
		return decodedEpochSecret{}, errors.New("Key Epoch Trusted Secret identity is invalid")
	}
	key, ok := canonicalMapBytes(value, 4, 32)
	if !ok {
		return decodedEpochSecret{}, errors.New("Key Epoch Trusted Secret key is invalid")
	}
	derived, err := awsmcrypto.KeyEpochID(vaultID, key)
	if err != nil || derived != epochID {
		return decodedEpochSecret{}, errors.New("Key Epoch Trusted Secret key binding is invalid")
	}
	return decodedEpochSecret{key: key}, nil
}

func decodeClientSecret(encoded []byte, vaultID, memberID, credentialID canonical.Identifier) (decodedClientSecret, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return decodedClientSecret{}, fmt.Errorf("decode Client Credential Trusted Secret: %w", err)
	}
	if !canonicalMapHasKeys(value, 8) {
		return decodedClientSecret{}, errors.New("Client Credential Trusted Secret fields are invalid")
	}
	if number, ok := canonicalMapNumber(value, 0); !ok || number != 1 {
		return decodedClientSecret{}, errors.New("Client Credential Trusted Secret format is invalid")
	}
	encodedVault, ok := canonicalMapBytes(value, 1, 32)
	if !ok || !bytes.Equal(encodedVault, vaultID[:]) {
		return decodedClientSecret{}, errors.New("Client Credential Trusted Secret Vault binding is invalid")
	}
	encodedMember, ok := canonicalMapBytes(value, 2, 32)
	if !ok || !bytes.Equal(encodedMember, memberID[:]) {
		return decodedClientSecret{}, errors.New("Client Credential Trusted Secret Member binding is invalid")
	}
	encodedCredential, ok := canonicalMapBytes(value, 3, 32)
	if !ok || !bytes.Equal(encodedCredential, credentialID[:]) {
		return decodedClientSecret{}, errors.New("Client Credential Trusted Secret identity is invalid")
	}
	signingPublicKey, ok := canonicalMapBytes(value, 4, ed25519.PublicKeySize)
	if !ok {
		return decodedClientSecret{}, errors.New("Client Credential signing public key is invalid")
	}
	signingSecretKey, ok := canonicalMapBytes(value, 5, ed25519.PrivateKeySize)
	if !ok || !bytes.Equal(ed25519.PrivateKey(signingSecretKey).Public().(ed25519.PublicKey), signingPublicKey) {
		return decodedClientSecret{}, errors.New("Client Credential signing key binding is invalid")
	}
	wrappingPrivateKey, ok := canonicalMapBytes(value, 7, 32)
	if !ok {
		return decodedClientSecret{}, errors.New("Client Credential wrapping key is invalid")
	}
	return decodedClientSecret{signingPublicKey: signingPublicKey, signingSecretKey: signingSecretKey, wrappingPrivateKey: wrappingPrivateKey}, nil
}

func canonicalMapHasKeys(value canonical.Value, count int) bool {
	switch typed := value.(type) {
	case canonical.Map:
		if len(typed) != count {
			return false
		}
		for index := 0; index < count; index++ {
			if _, ok := typed[uint64(index)]; !ok {
				return false
			}
		}
		return true
	case map[any]any:
		if len(typed) != count {
			return false
		}
		for index := 0; index < count; index++ {
			if _, ok := typed[uint64(index)]; !ok {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func canonicalMapValue(value canonical.Value, key uint64) (canonical.Value, bool) {
	switch typed := value.(type) {
	case canonical.Map:
		entry, ok := typed[key]
		return entry, ok
	case map[any]any:
		entry, ok := typed[key]
		return entry, ok
	default:
		return nil, false
	}
}

func canonicalMapBytes(value canonical.Value, key uint64, length int) ([]byte, bool) {
	entry, ok := canonicalMapValue(value, key)
	if !ok {
		return nil, false
	}
	bytesValue, ok := entry.([]byte)
	return bytesValue, ok && len(bytesValue) == length
}

func canonicalMapNumber(value canonical.Value, key uint64) (uint64, bool) {
	entry, ok := canonicalMapValue(value, key)
	if !ok {
		return 0, false
	}
	number, ok := entry.(uint64)
	return number, ok
}

func decodeHexIdentifier(value string) (canonical.Identifier, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return canonical.Identifier{}, errors.New("identifier must contain exactly 32 bytes")
	}
	var identifier canonical.Identifier
	copy(identifier[:], decoded)
	return identifier, nil
}

func identifierSetEqual(left []canonical.Identifier, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index, value := range left {
		if hexIdentifier(value) != right[index] {
			return false
		}
	}
	return true
}

func identifiersToHex(values []canonical.Identifier) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = hexIdentifier(value)
	}
	return result
}

func appendUniqueStrings(values []string, value string) []string {
	for _, current := range values {
		if current == value {
			return append([]string(nil), values...)
		}
	}
	result := append([]string(nil), values...)
	result = append(result, value)
	sortStrings(result)
	return result
}

func replicaParentsAdmitted(replica *Replica, event canonical.Event) bool {
	for _, parent := range event.ParentRecordIDs {
		if _, ok := replica.Record(parent); !ok {
			return false
		}
	}
	for _, parent := range event.AuthorityParentIDs {
		if _, ok := replica.Record(parent); !ok {
			return false
		}
	}
	return true
}

func sortedStringKeys[Value any](values map[string]Value) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sortStrings(keys)
	return keys
}

func hexIdentifier(value [32]byte) string {
	return hex.EncodeToString(value[:])
}

func clientSecretAccount(vaultID, credentialID string) string {
	return "client-secret:" + vaultID + ":" + credentialID
}

func epochSecretAccount(vaultID, epochID string) string {
	return "epoch-secret:" + vaultID + ":" + epochID
}

func encodeClientSecret(prepared PreparedCanonicalVaultCreation) ([]byte, error) {
	return canonical.EncodeValue(canonical.Map{
		0: uint64(1),
		1: prepared.IDs.VaultID[:],
		2: prepared.IDs.FirstMemberID[:],
		3: prepared.IDs.ClientCredentialID[:],
		4: prepared.ClientKeys.SigningPublicKey,
		5: prepared.ClientKeys.SigningSecretKey,
		6: prepared.ClientKeys.WrappingPublicKey,
		7: prepared.ClientKeys.WrappingPrivateKey,
	})
}

func encodeEpochSecret(prepared PreparedCanonicalVaultCreation) ([]byte, error) {
	return canonical.EncodeValue(canonical.Map{
		0: uint64(1),
		1: prepared.IDs.VaultID[:],
		2: prepared.KeyEpochID[:],
		3: uint64(0),
		4: prepared.KeyEpochKey,
	})
}

func storeOpaqueCreationItem(artifacts *artifactstore.Store, storageItemID [32]byte, encoded []byte) error {
	if artifacts == nil {
		return securestore.ErrUnavailable
	}
	return artifacts.Put(hexIdentifier(storageItemID), bytes.NewReader(encoded))
}

func deleteOpaqueCreationItem(artifacts *artifactstore.Store, storageItemID [32]byte) {
	if artifacts == nil {
		return
	}
	_ = artifacts.Delete(hexIdentifier(storageItemID))
}

func wipeCreationSecrets(prepared *PreparedCanonicalVaultCreation) {
	for _, value := range [][]byte{
		prepared.ClientKeys.SigningSeed, prepared.ClientKeys.SigningPublicKey, prepared.ClientKeys.SigningSecretKey,
		prepared.ClientKeys.WrappingPrivateKey, prepared.ClientKeys.WrappingPublicKey,
		prepared.RecoveryKeys.SigningSeed, prepared.RecoveryKeys.SigningPublicKey, prepared.RecoveryKeys.SigningSecretKey,
		prepared.RecoveryKeys.WrappingPrivateKey, prepared.RecoveryKeys.WrappingPublicKey,
		prepared.KeyEpochKey, prepared.ClientKeyEnvelope.KeyEpochKey, prepared.ClientKeyEnvelope.Bytes,
		prepared.RecoveryKeyEnvelope.KeyEpochKey, prepared.RecoveryKeyEnvelope.Bytes,
	} {
		for index := range value {
			value[index] = 0
		}
	}
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
