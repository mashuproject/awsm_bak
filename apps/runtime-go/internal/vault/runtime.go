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
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
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
	Artifacts  *artifactstore.Store
	Secrets    securestore.Store
	HTTPClient *http.Client
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
	VaultID              string  `json:"vaultId"`
	Label                *string `json:"label"`
	Lifecycle            string  `json:"lifecycle"`
	Access               string  `json:"access"`
	ReplicaAvailability  string  `json:"replicaAvailability"`
	MissingArtifactCount int     `json:"missingArtifactCount"`
	ClientCredentialID   string  `json:"clientCredentialId,omitempty"`
	Selected             bool    `json:"selected"`
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

// AuthorityStateSummary is the client-facing, hexadecimal projection of the
// authenticated portable Authority State. It is derived on every request and
// is never a second persisted authority source.
type AuthorityStateSummary struct {
	VaultID                        string                                  `json:"vaultId"`
	ActiveMemberIDs                []string                                `json:"activeMemberIds"`
	AdministratorIDs               []string                                `json:"administratorIds"`
	AdministratorConflicts         []AuthorityAdministratorConflictSummary `json:"administratorConflicts"`
	ActiveInvitationIDs            []string                                `json:"activeInvitationIds"`
	InvitationConflictIDs          []string                                `json:"invitationConflictIds"`
	ActiveClientCredentialIDs      []string                                `json:"activeClientCredentialIds"`
	EffectiveRecoveryCredentialIDs []string                                `json:"effectiveRecoveryCredentialIds"`
	RecoveryConflicts              []AuthorityRecoveryConflictSummary      `json:"recoveryConflicts"`
	KeyEpochConflicts              []AuthorityKeyEpochConflictSummary      `json:"keyEpochConflicts"`
	FeatureSetConflict             *AuthorityFeatureSetConflictSummary     `json:"featureSetConflict,omitempty"`
	CurrentKeyEpochIDs             []string                                `json:"currentKeyEpochIds"`
	Lifecycle                      string                                  `json:"lifecycle"`
}

type AuthorityAdministratorConflictSummary struct {
	MemberID   string                                           `json:"memberId"`
	Candidates []AuthorityAdministratorConflictCandidateSummary `json:"candidates"`
}

type AuthorityAdministratorConflictCandidateSummary struct {
	HeadRecordID  string `json:"headRecordId"`
	Administrator bool   `json:"administrator"`
}

type AuthorityRecoveryConflictSummary struct {
	MemberID   string                                      `json:"memberId"`
	Candidates []AuthorityRecoveryConflictCandidateSummary `json:"candidates"`
}

type AuthorityRecoveryConflictCandidateSummary struct {
	HeadRecordID         string `json:"headRecordId"`
	RecoveryCredentialID string `json:"recoveryCredentialId"`
}

type AuthorityKeyEpochConflictSummary struct {
	Candidates []AuthorityKeyEpochConflictCandidateSummary `json:"candidates"`
}

type AuthorityKeyEpochConflictCandidateSummary struct {
	HeadRecordID string `json:"headRecordId"`
	KeyEpochID   string `json:"keyEpochId"`
}

type AuthorityFeatureSetConflictSummary struct {
	CandidateRecordIDs []string `json:"candidateRecordIds"`
	ManifestIDs        []string `json:"manifestIds"`
}

type RemoteSummary struct {
	RemoteID      string `json:"remoteId"`
	Name          string `json:"name"`
	Endpoint      string `json:"endpoint"`
	Enabled       bool   `json:"enabled"`
	ReplicaHandle string `json:"replicaHandle"`
}

type remoteState struct {
	RemoteID          string `json:"remoteId"`
	Name              string `json:"name"`
	Endpoint          string `json:"endpoint"`
	Enabled           bool   `json:"enabled"`
	ReplicaHandle     string `json:"replicaHandle"`
	LocatorSalt       string `json:"locatorSalt"`
	InventoryPageSize int    `json:"inventoryPageSize"`
}

type canonicalReplicaState struct {
	VaultID                       string            `json:"vaultId"`
	GenerationID                  string            `json:"generationId"`
	PredecessorGenerationID       string            `json:"predecessorGenerationId,omitempty"`
	AdoptionEventID               string            `json:"adoptionEventId,omitempty"`
	BaselineID                    string            `json:"baselineId"`
	GenesisID                     string            `json:"genesisId"`
	KeyEpochID                    string            `json:"keyEpochId"`
	RequiredFeatureSetID          string            `json:"requiredFeatureSetId"`
	BaselineRequiredFeatureSetID  string            `json:"baselineRequiredFeatureSetId"`
	MemberID                      string            `json:"memberId"`
	RecoveryCredentialID          string            `json:"recoveryCredentialId"`
	ClientCredentialID            string            `json:"clientCredentialId"`
	BaselineStorageItemID         string            `json:"baselineStorageItemId"`
	GenesisStorageItemID          string            `json:"genesisStorageItemId"`
	RecoveryEnvelopeID            string            `json:"recoveryEnvelopeId"`
	RecoveryEnvelopeStorageID     string            `json:"recoveryEnvelopeStorageItemId"`
	ClientEnvelopeID              string            `json:"clientEnvelopeId"`
	ClientEnvelopeStorageID       string            `json:"clientEnvelopeStorageItemId"`
	KeyEnvelopeStorageItemIDs     map[string]string `json:"keyEnvelopeStorageItemIds"`
	AuthoringAvailable            bool              `json:"authoringAvailable"`
	CausalFrontier                []string          `json:"causalFrontier"`
	AuthorityFrontier             []string          `json:"authorityFrontier"`
	ContinuityRecordIDs           []string          `json:"continuityRecordIds"`
	RecordStorageItemIDs          map[string]string `json:"recordStorageItemIds"`
	ObjectStorageItemIDs          map[string]string `json:"objectStorageItemIds"`
	FeatureManifestStorageItemIDs map[string]string `json:"featureManifestStorageItemIds"`
	ArtifactStorageItemIDs        map[string]string `json:"artifactStorageItemIds"`
	StorageItemKeyEpochIDs        map[string]string `json:"storageItemKeyEpochIds"`
}

type persistedVault struct {
	VaultID          string                 `json:"vaultId"`
	Label            *string                `json:"label"`
	Lifecycle        string                 `json:"lifecycle"`
	RecoveryHash     string                 `json:"recoveryHash"`
	GenerationID     string                 `json:"generationId"`
	Remotes          []remoteState          `json:"remotes"`
	Quarantine       map[string][]byte      `json:"quarantine,omitempty"`
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
	mu               sync.RWMutex
	store            StateStore
	deps             Dependencies
	selected         string
	vaults           map[string]*persistedVault
	replicas         map[string]*Replica
	pending          *pendingState
	hostedAttachment *pendingHostedAttachment
	notify           func()
}

type pendingHostedAttachment struct {
	SetupID         string
	ExpectedVaultID string
	Endpoint        string
	Name            string
	Session         hostedSession
	Replicas        []hostedReplicaSummary
}

type runtimeSnapshot struct {
	selected         string
	vaults           map[string]*persistedVault
	replicas         map[string]*Replica
	pending          *pendingState
	hostedAttachment *pendingHostedAttachment
}

// TransferPackage is the destination-side Complete Export closure carried by
// the one-use transfer envelope. It is not a Vault Event and is never
// synchronized. The outer transfer envelope supplies confidentiality; this
// package contains only already-encrypted opaque Vault items plus the local
// trusted secrets required to reopen the Replica.
type TransferPackage struct {
	VaultID          string                 `json:"vaultId"`
	Label            *string                `json:"label"`
	Lifecycle        string                 `json:"lifecycle"`
	RecoveryHash     string                 `json:"recoveryHash"`
	GenerationID     string                 `json:"generationId"`
	RecoveryRevision int                    `json:"recoveryRevision"`
	Remotes          []remoteState          `json:"remotes"`
	Canonical        *canonicalReplicaState `json:"canonical"`
	Artifacts        map[string][]byte      `json:"artifacts"`
	TrustedSecrets   map[string][]byte      `json:"trustedSecrets"`
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
		copyValue.Quarantine = cloneQuarantine(value.Quarantine)
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
	candidate, err := transferCandidate(packageValue)
	if err != nil {
		return ClientState{}, commandError("TRANSFER_PACKAGE_INVALID", "The transfer package is invalid.")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return ClientState{}, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "This Client cannot import a Vault without secure local storage.")
	}
	before := r.snapshotLocked()
	if _, exists := r.vaults[packageValue.VaultID]; exists {
		return ClientState{}, commandError("VAULT_IDENTITY_COLLISION", "The destination already contains this Vault.")
	}
	value := &candidate
	stored := make([]string, 0, len(packageValue.Artifacts))
	storedSecrets := make([]string, 0, len(packageValue.TrustedSecrets))
	for storageItemID, encoded := range packageValue.Artifacts {
		decoded, decodeErr := decodeDigest(storageItemID)
		envelope, envelopeErr := storage.DecodeOpaqueEnvelope(encoded)
		if decodeErr != nil || envelopeErr != nil || envelope.StorageItemID != decoded {
			r.restoreLocked(before)
			return ClientState{}, commandError("TRANSFER_PACKAGE_INVALID", "The transfer package contains an invalid opaque item.")
		}
		if err := r.deps.Artifacts.Put(storageItemID, bytes.NewReader(encoded)); err != nil {
			r.restoreLocked(before)
			for _, storedID := range stored {
				_ = r.deps.Artifacts.Delete(storedID)
			}
			for _, account := range storedSecrets {
				_ = r.deps.Secrets.Delete(trustedSecretService, account)
			}
			return ClientState{}, commandError("TRANSFER_PACKAGE_STORAGE_FAILED", "The transfer package could not be stored locally.")
		}
		stored = append(stored, hexIdentifier(decoded))
	}
	for account, secret := range packageValue.TrustedSecrets {
		if err := r.deps.Secrets.Put(trustedSecretService, account, secret); err != nil {
			r.restoreLocked(before)
			for _, storedID := range stored {
				_ = r.deps.Artifacts.Delete(storedID)
			}
			for _, storedAccount := range storedSecrets {
				_ = r.deps.Secrets.Delete(trustedSecretService, storedAccount)
			}
			return ClientState{}, commandError("TRUSTED_SECRET_UNAVAILABLE", "The transfer trusted secret could not be stored.")
		}
		storedSecrets = append(storedSecrets, account)
	}
	r.vaults[value.VaultID] = value
	replica, err := r.openCanonicalReplica(*value)
	if err != nil {
		r.restoreLocked(before)
		for _, storedID := range stored {
			_ = r.deps.Artifacts.Delete(storedID)
		}
		for _, account := range storedSecrets {
			_ = r.deps.Secrets.Delete(trustedSecretService, account)
		}
		return ClientState{}, commandError("TRANSFER_PACKAGE_INVALID", "The transfer package Replica could not be authenticated.")
	}
	r.replicas[value.VaultID] = replica
	r.selected = value.VaultID
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		for _, storedID := range stored {
			_ = r.deps.Artifacts.Delete(storedID)
		}
		for _, account := range storedSecrets {
			_ = r.deps.Secrets.Delete(trustedSecretService, account)
		}
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
	if value.Canonical == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "The authenticated Vault closure is unavailable for export.")
	}
	artifacts := make(map[string][]byte)
	addArtifact := func(storageItemID string) error {
		if _, ok := artifacts[storageItemID]; ok {
			return nil
		}
		reader, openErr := r.deps.Artifacts.Open(storageItemID)
		if openErr != nil {
			return openErr
		}
		encoded, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			return readErr
		}
		if _, decodeErr := storage.DecodeOpaqueEnvelope(encoded); decodeErr != nil {
			return decodeErr
		}
		artifacts[storageItemID] = encoded
		return nil
	}
	for _, storageItemID := range []string{value.Canonical.BaselineStorageItemID, value.Canonical.GenesisStorageItemID} {
		if err := addArtifact(storageItemID); err != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required Vault closure item is unavailable.")
		}
	}
	for _, storageItemID := range value.Canonical.KeyEnvelopeStorageItemIDs {
		if err := addArtifact(storageItemID); err != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required Key Envelope is unavailable.")
		}
	}
	for _, storageItemID := range value.Canonical.RecordStorageItemIDs {
		if err := addArtifact(storageItemID); err != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required Vault Record is unavailable.")
		}
	}
	for _, storageItemID := range value.Canonical.ObjectStorageItemIDs {
		if err := addArtifact(storageItemID); err != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required Vault Object is unavailable.")
		}
	}
	for _, storageItemID := range value.Canonical.FeatureManifestStorageItemIDs {
		if err := addArtifact(storageItemID); err != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required Feature Manifest is unavailable.")
		}
	}
	for _, storageItemID := range value.Canonical.ArtifactStorageItemIDs {
		if err := addArtifact(storageItemID); err != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required Artifact wrapper is unavailable.")
		}
	}
	trustedSecrets := make(map[string][]byte)
	accounts := []string{clientSecretAccount(vaultID, value.Canonical.ClientCredentialID)}
	epochIDs := make(map[string]struct{})
	for _, epochID := range value.Canonical.StorageItemKeyEpochIDs {
		epochIDs[epochID] = struct{}{}
	}
	epochIDs[value.Canonical.KeyEpochID] = struct{}{}
	for epochID := range epochIDs {
		accounts = append(accounts, epochSecretAccount(vaultID, epochID))
	}
	for _, account := range accounts {
		secret, secretErr := r.deps.Secrets.Get(trustedSecretService, account)
		if secretErr != nil {
			return nil, commandError("TRANSFER_PACKAGE_UNAVAILABLE", "A required trusted Vault secret is unavailable.")
		}
		trustedSecrets[account] = secret
	}
	for _, remote := range value.Remotes {
		if secret, secretErr := r.deps.Secrets.Get(trustedSecretService, remoteSessionAccount(remote.RemoteID)); secretErr == nil {
			trustedSecrets[remoteSessionAccount(remote.RemoteID)] = secret
		}
	}
	payload, err := json.Marshal(TransferPackage{
		VaultID: value.VaultID, Label: cloneString(value.Label), Lifecycle: value.Lifecycle,
		RecoveryHash: value.RecoveryHash, GenerationID: value.GenerationID, RecoveryRevision: value.RecoveryRevision,
		Remotes: append([]remoteState(nil), value.Remotes...), Canonical: cloneCanonicalState(value.Canonical),
		Artifacts: artifacts, TrustedSecrets: trustedSecrets,
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
	opened, err := r.openOpaqueWithKnownEpochs(vaultID, value.Canonical, vaultIdentifier, encoded)
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
	var localCredentialID canonical.Identifier
	if value.Canonical.ClientCredentialID != "" {
		localCredentialID, err = decodeHexIdentifier(value.Canonical.ClientCredentialID)
		if err != nil {
			return commandError("VAULT_REPLAY_UNAVAILABLE", "The local Client Credential identity is invalid.")
		}
	}
	if value.Canonical.AuthoringAvailable || event.Family == canonical.AuthorityFamily {
		authority, authorityErr := replayReplicaAuthorityState(nextReplica, nil, nil)
		if authorityErr != nil {
			return commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
		}
		if value.Canonical.ClientCredentialID != "" {
			if _, active := authority.activeClientMember(localCredentialID); !active {
				value.Canonical.AuthoringAvailable = false
			}
		}
		if authority.closed {
			value.Lifecycle = "Closed"
		}
		if value.Canonical.AuthoringAvailable && value.Canonical.ClientCredentialID == "" {
			value.Canonical.AuthoringAvailable = false
		}
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
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, opened.KeyEpochID)
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return err
	}
	r.signal()
	return nil
}

func (r *Runtime) admitOpaqueVacuum(ctx context.Context, vaultID string, baselineEncoded, eventEncoded []byte) error {
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
		return commandError("VAULT_VACUUM_INVALID", "The Vault identity is invalid.")
	}
	baselineOpened, err := r.openOpaqueWithKnownEpochs(vaultID, value.Canonical, vaultIdentifier, baselineEncoded)
	if err != nil || baselineOpened.PayloadType != 1 {
		return commandError("VAULT_VACUUM_INVALID", "The successor Baseline envelope is invalid.")
	}
	eventOpened, err := r.openOpaqueWithKnownEpochs(vaultID, value.Canonical, vaultIdentifier, eventEncoded)
	if err != nil || eventOpened.PayloadType != 1 {
		return commandError("VAULT_VACUUM_INVALID", "The Vacuum Event envelope is invalid.")
	}
	baseline, err := canonical.DecodeBaseline(baselineOpened.PayloadBytes)
	if err != nil || baseline.VaultID != vaultIdentifier {
		return commandError("VAULT_VACUUM_INVALID", "The successor Baseline is invalid.")
	}
	event, err := canonical.DecodeEvent(eventOpened.PayloadBytes)
	if err != nil || event.VaultID != vaultIdentifier || event.GenerationID != r.replicas[vaultID].generationID {
		return commandError("VAULT_VACUUM_INVALID", "The Vacuum Event context is invalid.")
	}
	if baseline.GenerationID == r.replicas[vaultID].generationID {
		if value.Canonical.AdoptionEventID != "" {
			adoptionID, adoptionErr := decodeHexIdentifier(value.Canonical.AdoptionEventID)
			if adoptionErr == nil && event.RecordID == adoptionID {
				return nil
			}
		}
		return commandError("VAULT_VACUUM_INVALID", "The successor Baseline is not a new Generation.")
	}
	nextReplica, err := r.replicas[vaultID].AdoptVacuum(baseline, event)
	if err != nil {
		return commandError("VAULT_VACUUM_INVALID", "The Vacuum Event could not be adopted.")
	}
	localCredentialID, localCredentialErr := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if localCredentialErr != nil {
		return commandError("VAULT_REPLAY_UNAVAILABLE", "The local Client Credential identity is invalid.")
	}
	if value.Canonical.AuthoringAvailable {
		authority, authorityErr := replayReplicaAuthorityState(nextReplica, nil, nil)
		if authorityErr != nil {
			return commandError("VAULT_VACUUM_INVALID", "The successor Authority State could not be replayed.")
		}
		if _, active := authority.activeClientMember(localCredentialID); !active {
			value.Canonical.AuthoringAvailable = false
		}
	}
	baselineEnvelope, err := storage.DecodeOpaqueEnvelope(baselineEncoded)
	if err != nil {
		return commandError("VAULT_VACUUM_INVALID", "The successor Baseline envelope is invalid.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(eventEncoded)
	if err != nil {
		return commandError("VAULT_VACUUM_INVALID", "The Vacuum Event envelope is invalid.")
	}
	before := r.snapshotLocked()
	if err := storeOpaqueCreationItem(r.deps.Artifacts, baselineEnvelope.StorageItemID, baselineEncoded); err != nil {
		return commandError("VAULT_CREATION_STORAGE_FAILED", "The successor Baseline could not be stored.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, eventEncoded); err != nil {
		deleteOpaqueCreationItem(r.deps.Artifacts, baselineEnvelope.StorageItemID)
		return commandError("VAULT_CREATION_STORAGE_FAILED", "The Vacuum Event could not be stored.")
	}
	predecessorGenerationID := value.GenerationID
	value.GenerationID = hexIdentifier(baseline.GenerationID)
	value.Canonical.GenerationID = value.GenerationID
	value.Canonical.PredecessorGenerationID = predecessorGenerationID
	value.Canonical.BaselineID = hexIdentifier(baseline.RecordID)
	value.Canonical.BaselineStorageItemID = hexIdentifier(baselineEnvelope.StorageItemID)
	value.Canonical.AdoptionEventID = hexIdentifier(event.RecordID)
	state := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(state.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(state.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(state.ContinuityRecordIDs)
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	baselineStorageItemID := hexIdentifier(baselineEnvelope.StorageItemID)
	eventStorageItemID := hexIdentifier(eventEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(baseline.RecordID)] = baselineStorageItemID
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = eventStorageItemID
	bindStorageItemKeyEpoch(value.Canonical, baselineStorageItemID, baselineOpened.KeyEpochID)
	bindStorageItemKeyEpoch(value.Canonical, eventStorageItemID, eventOpened.KeyEpochID)
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, baselineEnvelope.StorageItemID)
		deleteOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID)
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
	opened, err := r.openOpaqueWithKnownEpochs(vaultID, value.Canonical, vaultIdentifier, encoded)
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
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.ObjectStorageItemIDs[hexIdentifier(objectIdentifier)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, opened.KeyEpochID)
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return err
	}
	r.signal()
	return nil
}

// AdmitOpaqueFeatureManifest is the synchronization destination boundary for
// an authenticated Compact Feature Manifest (payload type 3). Feature
// Manifest bytes are content-addressed independently from the Event DAG and
// are retained as a dependency projection for the accepted Replica.
func (r *Runtime) AdmitOpaqueFeatureManifest(ctx context.Context, vaultID string, encoded []byte) error {
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
		return commandError("FEATURE_MANIFEST_INVALID", "The Vault identity is invalid.")
	}
	opened, err := r.openOpaqueWithKnownEpochs(vaultID, value.Canonical, vaultIdentifier, encoded)
	if err != nil || opened.PayloadType != 3 {
		return commandError("FEATURE_MANIFEST_INVALID", "The opaque Feature Manifest is invalid.")
	}
	manifestID, err := canonical.FeatureManifestID(opened.PayloadBytes)
	if err != nil {
		return commandError("FEATURE_MANIFEST_INVALID", "The opaque Feature Manifest is not canonical.")
	}
	nextReplica := r.replicas[vaultID].Clone()
	if err := nextReplica.AdmitFeatureManifest(manifestID, opened.PayloadBytes); err != nil {
		return commandError("FEATURE_MANIFEST_INVALID", "The Feature Manifest failed authenticated admission.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil || envelope.StorageClass != storage.CompactStorageClass {
		return commandError("FEATURE_MANIFEST_INVALID", "The opaque Feature Manifest envelope is invalid.")
	}
	before := r.snapshotLocked()
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return commandError("VAULT_CREATION_STORAGE_FAILED", "The opaque Feature Manifest could not be stored.")
	}
	if value.Canonical.FeatureManifestStorageItemIDs == nil {
		value.Canonical.FeatureManifestStorageItemIDs = map[string]string{}
	}
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.FeatureManifestStorageItemIDs[hexIdentifier(manifestID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, opened.KeyEpochID)
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return err
	}
	r.signal()
	return nil
}

type StorageReliefSummary struct {
	ReleasedObjectIDs []string `json:"releasedObjectIds"`
	Warning           string   `json:"warning"`
}

type GarbageCollectionSummary struct {
	DeletedStorageItemIDs []string `json:"deletedStorageItemIds"`
}

// StorageRelief removes only selected local Object materializations. It never
// edits Vault Records, asks a Remote for redundancy proof, or blocks when no
// Remote exists; the warning is deliberately returned every time.
func (r *Runtime) StorageRelief(ctx context.Context, vaultID string, objectIDs []string) (StorageReliefSummary, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.storageReliefLocked(ctx, vaultID, objectIDs)
}

func (r *Runtime) storageReliefExpected(ctx context.Context, vaultID string, objectIDs []string) (StorageReliefSummary, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireExpectedLocked(&vaultID); err != nil {
		return StorageReliefSummary{}, err
	}
	return r.storageReliefLocked(ctx, vaultID, objectIDs)
}

func (r *Runtime) storageReliefLocked(ctx context.Context, vaultID string, objectIDs []string) (StorageReliefSummary, error) {
	value, err := r.vaultLocked(vaultID)
	if err != nil {
		return StorageReliefSummary{}, err
	}
	if value.Canonical == nil || r.replicas[vaultID] == nil || r.deps.Artifacts == nil {
		return StorageReliefSummary{}, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	ids := append([]string(nil), objectIDs...)
	sortStrings(ids)
	unique := ids[:0]
	for _, id := range ids {
		if id == "" || !validDigest(id) {
			return StorageReliefSummary{}, commandError("OBJECT_ID_INVALID", "Storage Relief received an invalid Object ID.")
		}
		if len(unique) == 0 || unique[len(unique)-1] != id {
			unique = append(unique, id)
		}
	}
	if len(unique) == 0 {
		return StorageReliefSummary{}, commandError("OBJECT_ID_INVALID", "Storage Relief requires at least one Object ID.")
	}
	before := r.snapshotLocked()
	type removedItem struct {
		id   string
		data []byte
	}
	removed := make([]removedItem, 0, len(unique))
	nextReplica := r.replicas[vaultID].Clone()
	for _, objectID := range unique {
		storageItemID, ok := value.Canonical.ObjectStorageItemIDs[objectID]
		if !ok {
			return StorageReliefSummary{}, commandError("OBJECT_NOT_FOUND", "The selected Object is not locally materialized.")
		}
		objectIdentifier, err := decodeHexIdentifier(objectID)
		if err != nil {
			return StorageReliefSummary{}, commandError("OBJECT_ID_INVALID", "Storage Relief received an invalid Object ID.")
		}
		if _, ok := nextReplica.Object(objectIdentifier); !ok {
			return StorageReliefSummary{}, commandError("OBJECT_NOT_FOUND", "The selected Object is not locally materialized.")
		}
		reader, err := r.deps.Artifacts.Open(storageItemID)
		if err != nil {
			return StorageReliefSummary{}, commandError("OBJECT_NOT_FOUND", "The selected Object bytes are unavailable locally.")
		}
		data, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			return StorageReliefSummary{}, commandError("OBJECT_NOT_FOUND", "The selected Object bytes are unavailable locally.")
		}
		if err := r.deps.Artifacts.Delete(storageItemID); err != nil {
			for _, prior := range removed {
				_ = r.deps.Artifacts.Put(prior.id, bytes.NewReader(prior.data))
			}
			return StorageReliefSummary{}, commandError("OBJECT_RELIEF_FAILED", "Storage Relief could not remove the local Object.")
		}
		removed = append(removed, removedItem{id: storageItemID, data: data})
		delete(value.Canonical.ObjectStorageItemIDs, objectID)
		delete(value.Canonical.StorageItemKeyEpochIDs, storageItemID)
		nextReplica.ReleaseObject(objectIdentifier)
	}
	r.replicas[vaultID] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		for _, item := range removed {
			_ = r.deps.Artifacts.Put(item.id, bytes.NewReader(item.data))
		}
		return StorageReliefSummary{}, err
	}
	r.signal()
	return StorageReliefSummary{ReleasedObjectIDs: unique, Warning: "Storage Relief removed local Object bytes. Without another retained Replica or export, this data may be unrecoverable."}, nil
}

// GarbageCollect authenticates the selected Runtime state and removes only
// artifact-store files that no accepted Vault currently references. It does
// not infer age, Remote durability, or semantic reachability from filenames.
func (r *Runtime) GarbageCollect(ctx context.Context, vaultID string) (GarbageCollectionSummary, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.garbageCollectLocked(ctx, vaultID)
}

func (r *Runtime) garbageCollectExpected(ctx context.Context, vaultID string) (GarbageCollectionSummary, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireExpectedLocked(&vaultID); err != nil {
		return GarbageCollectionSummary{}, err
	}
	return r.garbageCollectLocked(ctx, vaultID)
}

func (r *Runtime) garbageCollectLocked(ctx context.Context, vaultID string) (GarbageCollectionSummary, error) {
	_ = ctx
	if _, err := r.vaultLocked(vaultID); err != nil {
		return GarbageCollectionSummary{}, err
	}
	if r.replicas[vaultID] == nil || r.deps.Artifacts == nil {
		return GarbageCollectionSummary{}, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	retained := make(map[string]struct{})
	for _, value := range r.vaults {
		if value.Canonical == nil {
			continue
		}
		for _, storageItemID := range []string{
			value.Canonical.BaselineStorageItemID, value.Canonical.GenesisStorageItemID,
			value.Canonical.RecoveryEnvelopeStorageID, value.Canonical.ClientEnvelopeStorageID,
		} {
			retained[storageItemID] = struct{}{}
		}
		for _, storageItemID := range value.Canonical.RecordStorageItemIDs {
			retained[storageItemID] = struct{}{}
		}
		for _, storageItemID := range value.Canonical.ObjectStorageItemIDs {
			retained[storageItemID] = struct{}{}
		}
		for _, storageItemID := range value.Canonical.FeatureManifestStorageItemIDs {
			retained[storageItemID] = struct{}{}
		}
		for _, storageItemID := range value.Canonical.ArtifactStorageItemIDs {
			retained[storageItemID] = struct{}{}
		}
	}
	ids, err := r.deps.Artifacts.ListIDs()
	if err != nil {
		return GarbageCollectionSummary{}, commandError("GARBAGE_COLLECTION_FAILED", "The local artifact inventory could not be read.")
	}
	deleted := make([]string, 0)
	for _, storageItemID := range ids {
		if _, ok := retained[storageItemID]; ok {
			continue
		}
		if err := r.deps.Artifacts.Delete(storageItemID); err != nil {
			return GarbageCollectionSummary{DeletedStorageItemIDs: deleted}, commandError("GARBAGE_COLLECTION_FAILED", "Garbage Collection could not remove an unreferenced local item.")
		}
		deleted = append(deleted, storageItemID)
	}
	return GarbageCollectionSummary{DeletedStorageItemIDs: deleted}, nil
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
	if _, err := transferCandidate(packageValue); err != nil {
		return "", commandError("TRANSFER_PACKAGE_INVALID", "The transfer package is invalid.")
	}
	return packageValue.VaultID, nil
}

func transferCandidate(packageValue TransferPackage) (persistedVault, error) {
	if packageValue.Canonical == nil || len(packageValue.Artifacts) == 0 || len(packageValue.TrustedSecrets) < 2 {
		return persistedVault{}, errors.New("Complete transfer package closure is incomplete")
	}
	candidate := persistedVault{
		VaultID: packageValue.VaultID, Label: cloneString(packageValue.Label), Lifecycle: packageValue.Lifecycle,
		RecoveryHash: packageValue.RecoveryHash, GenerationID: packageValue.GenerationID,
		Remotes: append([]remoteState(nil), packageValue.Remotes...), RecoveryRevision: packageValue.RecoveryRevision,
		Canonical: cloneCanonicalState(packageValue.Canonical),
	}
	if candidate.Canonical.VaultID != candidate.VaultID || candidate.Canonical.GenerationID != candidate.GenerationID {
		return persistedVault{}, errors.New("Complete transfer package identity does not match")
	}
	if err := validatePersistedVault(candidate); err != nil {
		return persistedVault{}, err
	}
	for storageItemID, encoded := range packageValue.Artifacts {
		id, err := decodeDigest(storageItemID)
		if err != nil {
			return persistedVault{}, err
		}
		envelope, err := storage.DecodeOpaqueEnvelope(encoded)
		if err != nil || envelope.StorageItemID != id {
			return persistedVault{}, errors.New("Complete transfer package opaque identity is invalid")
		}
	}
	clientAccount := clientSecretAccount(candidate.VaultID, candidate.Canonical.ClientCredentialID)
	if _, ok := packageValue.TrustedSecrets[clientAccount]; !ok {
		return persistedVault{}, errors.New("Complete transfer package Client Credential secret is missing")
	}
	epochIDs := make(map[string]struct{})
	for _, epochID := range candidate.Canonical.StorageItemKeyEpochIDs {
		epochIDs[epochID] = struct{}{}
	}
	epochIDs[candidate.Canonical.KeyEpochID] = struct{}{}
	for epochID := range epochIDs {
		if _, ok := packageValue.TrustedSecrets[epochSecretAccount(candidate.VaultID, epochID)]; !ok {
			return persistedVault{}, errors.New("Complete transfer package Key Epoch secret is missing")
		}
	}
	return candidate, nil
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
		if value.Lifecycle == "Open" && value.Canonical != nil && value.Canonical.AuthoringAvailable {
			access = "Authoring"
		}
		replicaAvailability, missingArtifactCount := r.replicaAvailabilityLocked(id)
		clientCredentialID := ""
		if value.Canonical != nil {
			clientCredentialID = value.Canonical.ClientCredentialID
		}
		state.Vaults = append(state.Vaults, VaultSummary{
			VaultID:              value.VaultID,
			Label:                cloneString(value.Label),
			Lifecycle:            value.Lifecycle,
			Access:               access,
			ReplicaAvailability:  replicaAvailability,
			MissingArtifactCount: missingArtifactCount,
			ClientCredentialID:   clientCredentialID,
			Selected:             value.VaultID == r.selected,
		})
	}
	return state
}

// replicaAvailabilityLocked derives the user-facing local availability state
// from the authenticated Library projection and loaded Object closure. It is
// intentionally not persisted: a restarted Runtime rebuilds the same answer
// from authenticated Records and local opaque bytes.
func (r *Runtime) replicaAvailabilityLocked(vaultID string) (string, int) {
	replica := r.replicas[vaultID]
	if replica == nil {
		return "Unavailable", 0
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		return "Unavailable", 0
	}
	missing := 0
	for _, capture := range projection.Captures {
		if capture.Lifecycle == "Active" && !capture.AvailableLocally {
			missing++
		}
	}
	if missing > 0 {
		return "Sparse", missing
	}
	return "Complete", 0
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
	case "RotateKeyEpoch":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RotateKeyEpoch contains invalid fields")
		}
		return r.rotateKeyEpoch(ctx, input.ExpectedVaultID)
	case "EndClientCredential":
		var input struct {
			Type                     string `json:"type"`
			ExpectedVaultID          string `json:"expectedVaultId"`
			TargetClientCredentialID string `json:"targetClientCredentialId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "EndClientCredential contains invalid fields")
		}
		return r.endClientCredential(ctx, input.ExpectedVaultID, input.TargetClientCredentialID)
	case "EndMembership":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TargetMemberID  string `json:"targetMemberId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "EndMembership contains invalid fields")
		}
		return r.endMembership(ctx, input.ExpectedVaultID, input.TargetMemberID)
	case "DeliverKeyEnvelope":
		var input struct {
			Type               string  `json:"type"`
			ExpectedVaultID    string  `json:"expectedVaultId"`
			KeyEpochID         string  `json:"keyEpochId"`
			TargetKind         uint64  `json:"targetKind"`
			TargetCredentialID string  `json:"targetCredentialId"`
			TargetRevision     *uint64 `json:"targetRevision"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "DeliverKeyEnvelope contains invalid fields")
		}
		return r.deliverKeyEnvelope(ctx, input.ExpectedVaultID, input.KeyEpochID, input.TargetKind, input.TargetCredentialID, input.TargetRevision)
	case "GrantAdministrator":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TargetMemberID  string `json:"targetMemberId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "GrantAdministrator contains invalid fields")
		}
		return r.changeAdministrator(ctx, input.ExpectedVaultID, input.TargetMemberID, true)
	case "EndAdministrator":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TargetMemberID  string `json:"targetMemberId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "EndAdministrator contains invalid fields")
		}
		return r.changeAdministrator(ctx, input.ExpectedVaultID, input.TargetMemberID, false)
	case "CreateInvitation":
		var input struct {
			Type                   string   `json:"type"`
			ExpectedVaultID        string   `json:"expectedVaultId"`
			Capabilities           []string `json:"capabilities"`
			RedemptionAuthorityID  string   `json:"redemptionAuthorityId"`
			ReceiptVerificationKey string   `json:"receiptVerificationKey"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CreateInvitation contains invalid fields")
		}
		return r.createInvitation(ctx, input.ExpectedVaultID, input.Capabilities, input.RedemptionAuthorityID, input.ReceiptVerificationKey)
	case "AcceptInvitation":
		var input struct {
			Type               string `json:"type"`
			ExpectedVaultID    string `json:"expectedVaultId"`
			JoinRequest        string `json:"joinRequest"`
			AcceptanceProposal string `json:"acceptanceProposal"`
			ConsumedReceipt    string `json:"consumedReceipt"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "AcceptInvitation contains invalid fields")
		}
		return r.acceptInvitation(ctx, input.ExpectedVaultID, input.JoinRequest, input.AcceptanceProposal, input.ConsumedReceipt)
	case "CancelInvitation":
		var input struct {
			Type                string `json:"type"`
			ExpectedVaultID     string `json:"expectedVaultId"`
			CancellationRequest string `json:"cancellationRequest"`
			CancelledReceipt    string `json:"cancelledReceipt"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CancelInvitation contains invalid fields")
		}
		return r.cancelInvitation(ctx, input.ExpectedVaultID, input.CancellationRequest, input.CancelledReceipt)
	case "ResolveInvitationConflict":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			Resolution      string `json:"resolution"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ResolveInvitationConflict contains invalid fields")
		}
		return r.resolveInvitationConflict(ctx, input.ExpectedVaultID, input.Resolution)
	case "ActivateFeature":
		var input struct {
			Type            string   `json:"type"`
			ExpectedVaultID string   `json:"expectedVaultId"`
			Manifests       []string `json:"manifests"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ActivateFeature contains invalid fields")
		}
		return r.activateFeature(ctx, input.ExpectedVaultID, input.Manifests)
	case "ExportComplete":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			Passphrase      string `json:"passphrase"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ExportComplete contains invalid fields")
		}
		encoded, err := r.exportCompleteExpected(input.ExpectedVaultID, input.Passphrase)
		if err != nil {
			return nil, err
		}
		return map[string]string{"package": base64.RawURLEncoding.EncodeToString(encoded)}, nil
	case "ImportComplete":
		var input struct {
			Type       string `json:"type"`
			Passphrase string `json:"passphrase"`
			Package    string `json:"package"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ImportComplete contains invalid fields")
		}
		encoded, err := base64.RawURLEncoding.DecodeString(input.Package)
		if err != nil {
			return nil, commandError("COMPLETE_IMPORT_INVALID", "The Complete Import package encoding is invalid.")
		}
		return r.ImportComplete(ctx, input.Passphrase, encoded)
	case "ListLibrary":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ListLibrary contains invalid fields")
		}
		return r.listLibrary(input.ExpectedVaultID)
	case "ListLibraryProjection":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ListLibraryProjection contains invalid fields")
		}
		return r.listLibraryProjection(input.ExpectedVaultID)
	case "ListCollections", "ListFolders", "ListTags", "ListTagAssignments", "ListNotes", "ListLibraryConflicts":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", input.Type+" contains invalid fields")
		}
		value, err := r.listLibraryProjection(input.ExpectedVaultID)
		if err != nil {
			return nil, err
		}
		projection := value.(LibraryProjection)
		switch input.Type {
		case "ListCollections":
			return projection.Collections, nil
		case "ListFolders":
			return projection.Folders, nil
		case "ListTags":
			return projection.Tags, nil
		case "ListTagAssignments":
			return clientTagAssignmentSummaries(projection.TagAssignments), nil
		case "ListNotes":
			return clientNoteSummaries(projection.Notes), nil
		default:
			return projection.Conflicts, nil
		}
	case "Search":
		var input struct {
			Type            string   `json:"type"`
			ExpectedVaultID string   `json:"expectedVaultId"`
			Query           string   `json:"query"`
			Scope           string   `json:"scope"`
			Hosts           []string `json:"hosts"`
			CollectionIDs   []string `json:"collectionIds"`
			TagIDs          []string `json:"tagIds"`
			CapturedFrom    *int64   `json:"capturedFrom"`
			CapturedBefore  *int64   `json:"capturedBefore"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "Search contains invalid fields")
		}
		query, err := makeSearchQuery(input.Scope, input.Query, input.Hosts, input.CollectionIDs, input.TagIDs, input.CapturedFrom, input.CapturedBefore)
		if err != nil {
			return nil, err
		}
		results, _, err := r.searchProjection(ctx, input.ExpectedVaultID, query)
		return results, err
	case "SearchCoverage":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "SearchCoverage contains invalid fields")
		}
		_, coverage, err := r.loadSearchMaterialization(ctx, input.ExpectedVaultID)
		return coverage, err
	case "GetAuthorityState":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "GetAuthorityState contains invalid fields")
		}
		return r.listAuthorityState(input.ExpectedVaultID)
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
		return r.beginHostedReplicaAttachment(ctx, input.ExpectedVaultID, input.Endpoint, input.Name, input.Username, input.Password)
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
		return r.confirmHostedReplicaAttachment(ctx, input.ExpectedVaultID, input.SetupID, input.ReplicaHandle)
	case "CancelHostedReplicaAttachment":
		var input struct {
			Type    string `json:"type"`
			SetupID string `json:"setupId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CancelHostedReplicaAttachment contains invalid fields")
		}
		return nil, r.cancelHostedReplicaAttachment(input.SetupID)
	case "MaterializeHostedReplica":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RemoteID        string `json:"remoteId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "MaterializeHostedReplica contains invalid fields")
		}
		return r.materializeHostedReplica(ctx, input.ExpectedVaultID, input.RemoteID)
	case "PullHostedReplicas":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "PullHostedReplicas contains invalid fields")
		}
		return r.pullHostedReplicas(ctx, input.ExpectedVaultID)
	case "HydrateArtifact":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			ArtifactID      string `json:"artifactId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "HydrateArtifact contains invalid fields")
		}
		return r.hydrateArtifact(ctx, input.ExpectedVaultID, input.ArtifactID)
	case "StorageRelief":
		var input struct {
			Type            string   `json:"type"`
			ExpectedVaultID string   `json:"expectedVaultId"`
			ObjectIDs       []string `json:"objectIds"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "StorageRelief contains invalid fields")
		}
		return r.storageReliefExpected(ctx, input.ExpectedVaultID, input.ObjectIDs)
	case "GarbageCollect":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "GarbageCollect contains invalid fields")
		}
		return r.garbageCollectExpected(ctx, input.ExpectedVaultID)
	case "ReauthorizeCapture":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			SourceRecordID  string `json:"sourceRecordId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ReauthorizeCapture contains invalid fields")
		}
		return r.reauthorizeCapture(ctx, input.ExpectedVaultID, input.SourceRecordID)
	case "RevertCollectionMerge":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RedirectCauseID string `json:"redirectCauseId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RevertCollectionMerge contains invalid fields")
		}
		return r.revertCollectionMerge(ctx, input.ExpectedVaultID, input.RedirectCauseID)
	case "CreateFolder":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID string  `json:"expectedVaultId"`
			Name            string  `json:"name"`
			ParentFolderID  *string `json:"parentFolderId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CreateFolder contains invalid fields")
		}
		return r.createFolder(ctx, input.ExpectedVaultID, input.Name, input.ParentFolderID)
	case "SetCollectionTitle":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID string  `json:"expectedVaultId"`
			CollectionID    string  `json:"collectionId"`
			Title           *string `json:"title"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "SetCollectionTitle contains invalid fields")
		}
		return r.setCollectionTitle(ctx, input.ExpectedVaultID, input.CollectionID, input.Title)
	case "MergeCollections":
		var input struct {
			Type                    string   `json:"type"`
			ExpectedVaultID         string   `json:"expectedVaultId"`
			SourceCollectionIDs     []string `json:"sourceCollectionIds"`
			DestinationCollectionID string   `json:"destinationCollectionId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "MergeCollections contains invalid fields")
		}
		return r.mergeCollections(ctx, input.ExpectedVaultID, input.SourceCollectionIDs, input.DestinationCollectionID)
	case "ResolveCollectionMergeConflict":
		var input struct {
			Type                 string   `json:"type"`
			ExpectedVaultID      string   `json:"expectedVaultId"`
			SubjectCollectionIDs []string `json:"subjectCollectionIds"`
			ConflictingCauseIDs  []string `json:"conflictingCauseIds"`
			Redirects            []struct {
				SourceCollectionID      string `json:"sourceCollectionId"`
				DestinationCollectionID string `json:"destinationCollectionId"`
			} `json:"redirects"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ResolveCollectionMergeConflict contains invalid fields")
		}
		redirects := make([]contentRedirectInput, 0, len(input.Redirects))
		for _, redirect := range input.Redirects {
			redirects = append(redirects, contentRedirectInput{source: redirect.SourceCollectionID, destination: redirect.DestinationCollectionID})
		}
		return r.resolveCollectionMergeConflict(ctx, input.ExpectedVaultID, input.SubjectCollectionIDs, input.ConflictingCauseIDs, redirects)
	case "PlaceCollectionInFolder":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID string  `json:"expectedVaultId"`
			CollectionID    string  `json:"collectionId"`
			FolderID        *string `json:"folderId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "PlaceCollectionInFolder contains invalid fields")
		}
		return r.placeCollectionInFolder(ctx, input.ExpectedVaultID, input.CollectionID, input.FolderID)
	case "RenameFolder":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			FolderID        string `json:"folderId"`
			Name            string `json:"name"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RenameFolder contains invalid fields")
		}
		return r.renameFolder(ctx, input.ExpectedVaultID, input.FolderID, input.Name)
	case "PlaceFolder":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID string  `json:"expectedVaultId"`
			FolderID        string  `json:"folderId"`
			ParentFolderID  *string `json:"parentFolderId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "PlaceFolder contains invalid fields")
		}
		return r.placeFolder(ctx, input.ExpectedVaultID, input.FolderID, input.ParentFolderID)
	case "ResolveFolderConflict":
		var input struct {
			Type                string   `json:"type"`
			ExpectedVaultID     string   `json:"expectedVaultId"`
			SubjectFolderIDs    []string `json:"subjectFolderIds"`
			ConflictingCauseIDs []string `json:"conflictingCauseIds"`
			Placements          []struct {
				FolderID       string  `json:"folderId"`
				ParentFolderID *string `json:"parentFolderId"`
			} `json:"placements"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ResolveFolderConflict contains invalid fields")
		}
		placements := make([]contentFolderPlacementInput, 0, len(input.Placements))
		for _, placement := range input.Placements {
			placements = append(placements, contentFolderPlacementInput{folder: placement.FolderID, parent: placement.ParentFolderID})
		}
		return r.resolveFolderConflict(ctx, input.ExpectedVaultID, input.SubjectFolderIDs, input.ConflictingCauseIDs, placements)
	case "DeleteFolder", "RestoreFolder":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			FolderID        string `json:"folderId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", input.Type+" contains invalid fields")
		}
		eventType := uint64(15)
		if input.Type == "RestoreFolder" {
			eventType = 16
		}
		return r.lifecycleFolder(ctx, input.ExpectedVaultID, input.FolderID, eventType)
	case "MoveCaptures":
		var input struct {
			Type                    string   `json:"type"`
			ExpectedVaultID         string   `json:"expectedVaultId"`
			BundleIDs               []string `json:"bundleIds"`
			DestinationCollectionID string   `json:"destinationCollectionId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "MoveCaptures contains invalid fields")
		}
		return r.moveCaptures(ctx, input.ExpectedVaultID, input.BundleIDs, input.DestinationCollectionID)
	case "DeleteCaptures", "RestoreCaptures":
		var input struct {
			Type            string   `json:"type"`
			ExpectedVaultID string   `json:"expectedVaultId"`
			BundleIDs       []string `json:"bundleIds"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", input.Type+" contains invalid fields")
		}
		eventType := uint64(4)
		if input.Type == "RestoreCaptures" {
			eventType = 5
		}
		return r.lifecycleCaptures(ctx, input.ExpectedVaultID, input.BundleIDs, eventType)
	case "CreateTag":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			Name            string `json:"name"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CreateTag contains invalid fields")
		}
		return r.createTag(ctx, input.ExpectedVaultID, input.Name)
	case "MergeTags":
		var input struct {
			Type             string   `json:"type"`
			ExpectedVaultID  string   `json:"expectedVaultId"`
			SourceTagIDs     []string `json:"sourceTagIds"`
			DestinationTagID string   `json:"destinationTagId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "MergeTags contains invalid fields")
		}
		return r.mergeTags(ctx, input.ExpectedVaultID, input.SourceTagIDs, input.DestinationTagID)
	case "RevertTagMerge":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			RedirectCauseID string `json:"redirectCauseId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RevertTagMerge contains invalid fields")
		}
		return r.revertTagMerge(ctx, input.ExpectedVaultID, input.RedirectCauseID)
	case "ResolveTagMergeConflict":
		var input struct {
			Type                string   `json:"type"`
			ExpectedVaultID     string   `json:"expectedVaultId"`
			SubjectTagIDs       []string `json:"subjectTagIds"`
			ConflictingCauseIDs []string `json:"conflictingCauseIds"`
			Redirects           []struct {
				SourceTagID      string `json:"sourceTagId"`
				DestinationTagID string `json:"destinationTagId"`
			} `json:"redirects"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ResolveTagMergeConflict contains invalid fields")
		}
		redirects := make([]contentRedirectInput, 0, len(input.Redirects))
		for _, redirect := range input.Redirects {
			redirects = append(redirects, contentRedirectInput{source: redirect.SourceTagID, destination: redirect.DestinationTagID})
		}
		return r.resolveTagMergeConflict(ctx, input.ExpectedVaultID, input.SubjectTagIDs, input.ConflictingCauseIDs, redirects)
	case "RenameTag":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TagID           string `json:"tagId"`
			Name            string `json:"name"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RenameTag contains invalid fields")
		}
		return r.renameTag(ctx, input.ExpectedVaultID, input.TagID, input.Name)
	case "AssignTag":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TagID           string `json:"tagId"`
			TargetKind      string `json:"targetKind"`
			TargetID        string `json:"targetId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "AssignTag contains invalid fields")
		}
		return r.assignTag(ctx, input.ExpectedVaultID, input.TagID, input.TargetKind, input.TargetID)
	case "RemoveTagAssignments":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TagID           string `json:"tagId"`
			TargetKind      string `json:"targetKind"`
			TargetID        string `json:"targetId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "RemoveTagAssignments contains invalid fields")
		}
		return r.removeTagAssignments(ctx, input.ExpectedVaultID, input.TagID, input.TargetKind, input.TargetID)
	case "DeleteTag", "RestoreTag":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			TagID           string `json:"tagId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", input.Type+" contains invalid fields")
		}
		eventType := uint64(22)
		if input.Type == "RestoreTag" {
			eventType = 23
		}
		return r.tagEvent(ctx, input.ExpectedVaultID, input.TagID, eventType, nil)
	case "CreateNote":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID string  `json:"expectedVaultId"`
			TargetKind      string  `json:"targetKind"`
			TargetID        string  `json:"targetId"`
			Title           *string `json:"title"`
			Body            string  `json:"body"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "CreateNote contains invalid fields")
		}
		return r.createNote(ctx, input.ExpectedVaultID, input.TargetKind, input.TargetID, input.Title, input.Body)
	case "ReviseNote":
		var input struct {
			Type            string  `json:"type"`
			ExpectedVaultID string  `json:"expectedVaultId"`
			NoteID          string  `json:"noteId"`
			Title           *string `json:"title"`
			Body            string  `json:"body"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ReviseNote contains invalid fields")
		}
		return r.reviseNote(ctx, input.ExpectedVaultID, input.NoteID, input.Title, input.Body)
	case "DeleteNote", "RestoreNote":
		var input struct {
			Type            string `json:"type"`
			ExpectedVaultID string `json:"expectedVaultId"`
			NoteID          string `json:"noteId"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", input.Type+" contains invalid fields")
		}
		eventType := uint64(29)
		if input.Type == "RestoreNote" {
			eventType = 30
		}
		return r.lifecycleNote(ctx, input.ExpectedVaultID, input.NoteID, eventType)
	case "ResolveNoteConflict":
		var input struct {
			Type                string   `json:"type"`
			ExpectedVaultID     string   `json:"expectedVaultId"`
			NoteID              string   `json:"noteId"`
			ConflictingCauseIDs []string `json:"conflictingCauseIds"`
			RetainedOriginal    *struct {
				Title *string `json:"title"`
				Body  string  `json:"body"`
			} `json:"retainedOriginal"`
			SplitNotes []struct {
				Title *string `json:"title"`
				Body  string  `json:"body"`
			} `json:"splitNotes"`
		}
		if err := decode(raw, &input); err != nil {
			return nil, commandError("APPLICATION_PROTOCOL_INVALID", "ResolveNoteConflict contains invalid fields")
		}
		var retainedTitle *string
		var retainedBody *string
		if input.RetainedOriginal != nil {
			retainedTitle = input.RetainedOriginal.Title
			retainedBody = &input.RetainedOriginal.Body
		}
		split := make([]noteSplitInput, 0, len(input.SplitNotes))
		for _, item := range input.SplitNotes {
			split = append(split, noteSplitInput{title: item.Title, body: item.Body})
		}
		return r.resolveNoteConflict(ctx, input.ExpectedVaultID, input.NoteID, input.ConflictingCauseIDs, retainedTitle, retainedBody, split)
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
		return r.recoverHostedMember(ctx, input.Endpoint, input.Username, input.Password, input.RecoveryPhrase)
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
	for _, feature := range prepared.FeatureManifests {
		storedItems = append(storedItems, feature.Envelope.StorageItemID)
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
	for _, feature := range prepared.FeatureManifests {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, feature.Envelope.StorageItemID, feature.Envelope.Bytes); err != nil {
			cleanup()
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Feature Manifest could not be stored.")
		}
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
	value := &persistedVault{VaultID: id, Label: cloneString(pending.Label), Lifecycle: "Open", RecoveryHash: pending.PhraseHash, GenerationID: generation, Remotes: []remoteState{}, RecoveryRevision: 0, Canonical: canonicalState}
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
	source := r.vaults[pending.SourceVaultID]
	if source == nil || source.Canonical == nil || r.replicas[pending.SourceVaultID] == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The source Vault Replica is unavailable.")
	}
	if r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "This Client cannot Fork a Vault without its secure storage facility.")
	}
	sourceVaultIdentifier, err := decodeHexIdentifier(source.VaultID)
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The source Vault identity is invalid.")
	}
	sourceEpochIdentifier, err := decodeHexIdentifier(source.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The source Key Epoch identity is invalid.")
	}
	sourceProjection, err := ProjectLibraryProjection(r.replicas[pending.SourceVaultID])
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The source Library state could not be authenticated.")
	}
	sourceContentCheckpoint, err := buildVacuumContentCheckpoint(r.replicas[pending.SourceVaultID], sourceProjection)
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The source Library state could not be reduced for Fork.")
	}
	sourceContentMap, ok := replicaMapValue(sourceContentCheckpoint)
	if !ok {
		return nil, commandError("VAULT_FORK_INVALID", "The source Fork content checkpoint is invalid.")
	}
	sourceLabelCheckpoint, ok := replicaMapValue(replicaMapEntryMust(sourceContentMap, 1))
	if !ok {
		return nil, commandError("VAULT_FORK_INVALID", "The source Vault label checkpoint is invalid.")
	}
	label, ok := replicaMapNullableText(sourceLabelCheckpoint, 0)
	if !ok {
		return nil, commandError("VAULT_FORK_INVALID", "The source Vault label checkpoint is invalid.")
	}
	sourceRequiredFeatureSetID, err := decodeHexIdentifier(source.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The source Required Feature Set identity is invalid.")
	}
	featureInputs, err := forkFeatureInputs(r.replicas[pending.SourceVaultID], sourceRequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", err.Error())
	}
	var sourceEpochKey []byte
	if len(source.Canonical.ObjectStorageItemIDs) > 0 || len(source.Canonical.ArtifactStorageItemIDs) > 0 {
		encodedEpoch, secretErr := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(source.VaultID, source.Canonical.KeyEpochID))
		if secretErr != nil {
			return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The source Key Epoch could not be opened.")
		}
		epochSecret, decodeErr := decodeEpochSecret(encodedEpoch, sourceVaultIdentifier, sourceEpochIdentifier)
		if decodeErr != nil {
			return nil, commandError("VAULT_FORK_INVALID", "The source Key Epoch is invalid.")
		}
		sourceEpochKey = append([]byte(nil), epochSecret.key...)
		zeroBytes(epochSecret.key)
		defer zeroBytes(sourceEpochKey)
	}
	temporary, err := PrepareCanonicalVaultCreation(CreationInput{Label: label, RecoveryPhrase: phrase, FeatureManifests: featureInputs})
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The canonical Fork ceremony could not be prepared.")
	}
	mappings, err := prepareForkObjectMappings(r.replicas[pending.SourceVaultID], source.Canonical, temporary.IDs.VaultID, temporary.RequiredFeatureSetID)
	if err != nil {
		wipeCreationSecrets(&temporary)
		return nil, commandError("VAULT_FORK_INVALID", err.Error())
	}
	mappedContentCheckpoint, err := mapForkContentCheckpoint(sourceContentCheckpoint, mappings)
	if err != nil {
		wipeCreationSecrets(&temporary)
		return nil, commandError("VAULT_FORK_INVALID", err.Error())
	}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{
		Label: label, ContentCheckpoint: mappedContentCheckpoint, RecoveryPhrase: phrase,
		FeatureManifests: featureInputs, IDs: &temporary.IDs,
		ClientSigningSeed: temporary.ClientKeys.SigningSeed, ClientWrappingPrivateKey: temporary.ClientKeys.WrappingPrivateKey,
		KeyEpochKey: temporary.KeyEpochKey,
	})
	wipeCreationSecrets(&temporary)
	if err != nil {
		return nil, commandError("VAULT_FORK_INVALID", "The canonical Fork ceremony could not be prepared.")
	}
	canonicalState := canonicalReplicaFromCreation(prepared)
	storedItems := [][32]byte{prepared.BaselineEnvelope.StorageItemID, prepared.GenesisEnvelope.StorageItemID, prepared.RecoveryKeyEnvelope.Envelope.StorageItemID, prepared.ClientKeyEnvelope.Envelope.StorageItemID}
	for _, feature := range prepared.FeatureManifests {
		storedItems = append(storedItems, feature.Envelope.StorageItemID)
	}
	cleanup := func() {
		for _, itemID := range storedItems {
			deleteOpaqueCreationItem(r.deps.Artifacts, itemID)
		}
		for _, itemID := range canonicalState.RecordStorageItemIDs {
			if decoded, decodeErr := decodeHexIdentifier(itemID); decodeErr == nil {
				deleteOpaqueCreationItem(r.deps.Artifacts, decoded)
			}
		}
		for _, itemID := range canonicalState.ObjectStorageItemIDs {
			if decoded, decodeErr := decodeHexIdentifier(itemID); decodeErr == nil {
				deleteOpaqueCreationItem(r.deps.Artifacts, decoded)
			}
		}
		for _, itemID := range canonicalState.ArtifactStorageItemIDs {
			if decoded, decodeErr := decodeHexIdentifier(itemID); decodeErr == nil {
				deleteOpaqueCreationItem(r.deps.Artifacts, decoded)
			}
		}
		for _, itemID := range canonicalState.FeatureManifestStorageItemIDs {
			if decoded, decodeErr := decodeHexIdentifier(itemID); decodeErr == nil {
				deleteOpaqueCreationItem(r.deps.Artifacts, decoded)
			}
		}
		_ = r.deps.Secrets.Delete(trustedSecretService, clientSecretAccount(canonicalState.VaultID, canonicalState.ClientCredentialID))
		_ = r.deps.Secrets.Delete(trustedSecretService, epochSecretAccount(canonicalState.VaultID, canonicalState.KeyEpochID))
		wipeCreationSecrets(&prepared)
	}
	for index, item := range []struct {
		id   [32]byte
		data []byte
	}{
		{prepared.BaselineEnvelope.StorageItemID, prepared.BaselineEnvelope.Bytes},
		{prepared.GenesisEnvelope.StorageItemID, prepared.GenesisEnvelope.Bytes},
		{prepared.RecoveryKeyEnvelope.Envelope.StorageItemID, prepared.RecoveryKeyEnvelope.Envelope.Bytes},
		{prepared.ClientKeyEnvelope.Envelope.StorageItemID, prepared.ClientKeyEnvelope.Envelope.Bytes},
	} {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, item.id, item.data); err != nil {
			cleanup()
			return nil, commandError("VAULT_FORK_STORAGE_FAILED", fmt.Sprintf("The Fork item %d could not be stored.", index))
		}
	}
	for _, feature := range prepared.FeatureManifests {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, feature.Envelope.StorageItemID, feature.Envelope.Bytes); err != nil {
			cleanup()
			return nil, commandError("VAULT_FORK_STORAGE_FAILED", "The Fork Feature Manifest could not be stored.")
		}
	}
	clientSecret, err := encodeClientSecret(prepared)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_FORK_STORAGE_FAILED", "The Fork Client Credential could not be protected.")
	}
	if err := r.deps.Secrets.Put(trustedSecretService, clientSecretAccount(canonicalState.VaultID, canonicalState.ClientCredentialID), clientSecret); err != nil {
		cleanup()
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Fork Client Credential could not be stored.")
	}
	epochSecret, err := encodeEpochSecret(prepared)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_FORK_STORAGE_FAILED", "The Fork Key Epoch could not be protected.")
	}
	if err := r.deps.Secrets.Put(trustedSecretService, epochSecretAccount(canonicalState.VaultID, canonicalState.KeyEpochID), epochSecret); err != nil {
		cleanup()
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Fork Key Epoch could not be stored.")
	}
	id := canonicalState.VaultID
	value := &persistedVault{VaultID: id, Label: cloneString(label), Lifecycle: "Open", RecoveryHash: pending.PhraseHash, GenerationID: canonicalState.GenerationID, Remotes: []remoteState{}, RecoveryRevision: 0, Canonical: canonicalState}
	replica, err := newReplicaFromPreparedCreation(prepared)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_FORK_INVALID", "The authenticated Fork Replica could not be opened.")
	}
	objectMappings := mappings.objects
	if err := reauthorForkArtifactObjects(r.replicas[pending.SourceVaultID], replica, prepared, canonicalState, source.Canonical, sourceVaultIdentifier, sourceEpochIdentifier, sourceEpochKey, objectMappings, r.deps); err != nil {
		cleanup()
		return nil, commandError("VAULT_FORK_INVALID", err.Error())
	}
	if err := reauthorForkNoteObjects(r.replicas[pending.SourceVaultID], replica, prepared, canonicalState, source.Canonical, sourceVaultIdentifier, sourceEpochIdentifier, sourceEpochKey, objectMappings, r.deps); err != nil {
		cleanup()
		return nil, commandError("VAULT_FORK_INVALID", err.Error())
	}
	if err := reauthorForkBundleObjects(r.replicas[pending.SourceVaultID], replica, prepared, canonicalState, source.Canonical, sourceVaultIdentifier, sourceEpochIdentifier, sourceEpochKey, objectMappings, mappings.bundles, r.deps); err != nil {
		cleanup()
		return nil, commandError("VAULT_FORK_INVALID", err.Error())
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

func (r *Runtime) recoverMember(ctx context.Context, id, phrase string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.recoverMemberLocked(ctx, id, phrase)
}

func (r *Runtime) recoverMemberLocked(ctx context.Context, id, phrase string) (any, error) {
	before := r.snapshotLocked()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	if value.RecoveryHash != "" && hashPhrase(phrase) != value.RecoveryHash {
		return nil, commandError("RECOVERY_PHRASE_MISMATCH", "The Recovery Phrase does not match.")
	}
	if value.Lifecycle != "Open" {
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot enroll a Client Credential.")
	}
	if value.Canonical == nil || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	vaultID, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Member identity is invalid.")
	}
	recoveryCredentialID, err := decodeHexIdentifier(value.Canonical.RecoveryCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Recovery Credential identity is invalid.")
	}
	currentEpochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch identity is invalid.")
	}
	entropy, err := awsmcrypto.DecodeRecoveryPhrase(phrase)
	if err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase is invalid.")
	}
	recoveryKeys, err := awsmcrypto.DeriveRecoveryCredential(entropy)
	zeroBytes(entropy)
	if err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase could not derive its credential.")
	}
	defer wipeCredentialKeys(&recoveryKeys)
	authority, err := replayReplicaAuthorityState(r.replicas[id], nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	recoveryRevision, effective := authority.recoveryTargets[recoveryCredentialID]
	if !effective {
		return nil, commandError("RECOVERY_KEY_INVALID", "The Recovery Phrase does not match an effective Recovery Credential.")
	}
	type recoveredEpoch struct {
		id      canonical.Identifier
		display uint64
		key     []byte
	}
	orderedEpochs := sortedIdentifierKeys(authority.epochs)
	sort.Slice(orderedEpochs, func(left, right int) bool {
		leftDisplay := authority.epochs[orderedEpochs[left]]
		rightDisplay := authority.epochs[orderedEpochs[right]]
		if leftDisplay != rightDisplay {
			return leftDisplay < rightDisplay
		}
		return bytes.Compare(orderedEpochs[left][:], orderedEpochs[right][:]) < 0
	})
	recoveredEpochs := make([]recoveredEpoch, 0, len(orderedEpochs))
	for _, readableEpochID := range orderedEpochs {
		var slot *keyEpochEnvelopeSlot
		for index := range authority.epochSlots[readableEpochID] {
			candidate := authority.epochSlots[readableEpochID][index]
			if candidate.targetKind == awsmcrypto.RecoveryCredentialTarget && candidate.targetID == recoveryCredentialID &&
				candidate.targetRevision != nil && *candidate.targetRevision == recoveryRevision {
				if slot != nil {
					return nil, commandError("RECOVERY_KEY_INVALID", "The authenticated Recovery Key Envelope slots are ambiguous.")
				}
				copyOfSlot := candidate
				slot = &copyOfSlot
			}
		}
		if slot == nil {
			return nil, commandError("RECOVERY_KEY_UNAVAILABLE", "A readable Key Epoch does not have an accepted Recovery Key Envelope.")
		}
		storageID, exists := value.Canonical.KeyEnvelopeStorageItemIDs[hexIdentifier(slot.envelopeID)]
		if !exists || storageID == "" {
			return nil, commandError("RECOVERY_KEY_UNAVAILABLE", "A readable Recovery Key Envelope is unavailable.")
		}
		reader, openErr := r.deps.Artifacts.Open(storageID)
		if openErr != nil {
			return nil, commandError("RECOVERY_KEY_UNAVAILABLE", "A readable Recovery Key Envelope is unavailable.")
		}
		recoveryEnvelopeBytes, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			return nil, commandError("RECOVERY_KEY_UNAVAILABLE", "A readable Recovery Key Envelope is unavailable.")
		}
		openedRecovery, openErr := awsmcrypto.OpenKeyEnvelope(awsmcrypto.RecoveryCredentialTarget, recoveryKeys.WrappingPrivateKey, recoveryEnvelopeBytes)
		if openErr != nil || openedRecovery.ID != slot.envelopeID || openedRecovery.VaultID != vaultID || openedRecovery.KeyEpochID != readableEpochID ||
			openedRecovery.TargetCredentialID != recoveryCredentialID || openedRecovery.TargetRevision == nil || *openedRecovery.TargetRevision != recoveryRevision {
			return nil, commandError("RECOVERY_KEY_INVALID", "The Recovery Phrase does not open an authenticated Recovery Key Envelope.")
		}
		recoveredEpochs = append(recoveredEpochs, recoveredEpoch{id: readableEpochID, display: authority.epochs[readableEpochID], key: openedRecovery.KeyEpochKey})
		defer zeroBytes(openedRecovery.KeyEpochKey)
	}
	if len(recoveredEpochs) == 0 {
		return nil, commandError("RECOVERY_KEY_INVALID", "The Vault has no readable Key Epoch.")
	}
	currentEpochIndex := -1
	for index := range recoveredEpochs {
		if recoveredEpochs[index].id == currentEpochID {
			currentEpochIndex = index
			break
		}
	}
	if currentEpochIndex < 0 {
		return nil, commandError("RECOVERY_KEY_INVALID", "The Recovery Phrase does not open the accepted current Key Epoch.")
	}
	clientKeys, err := awsmcrypto.CreateClientCredentialKeys(nil, nil)
	if err != nil {
		return nil, commandError("CLIENT_CREDENTIAL_INVALID", "A fresh Client Credential could not be created.")
	}
	defer wipeCredentialKeys(&clientKeys)
	credentialBytes, err := randomID()
	if err != nil {
		return nil, err
	}
	clientCredentialID, err := decodeHexIdentifier(credentialBytes)
	if err != nil {
		return nil, err
	}
	clientEnvelopes := make([]awsmcrypto.KeyEnvelope, 0, len(recoveredEpochs))
	for _, recovered := range recoveredEpochs {
		clientEnvelope, sealErr := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
			VaultID: vaultID, KeyEpochID: recovered.id, KeyEpochKey: recovered.key,
			TargetKind: awsmcrypto.ClientCredentialTarget, TargetCredentialID: clientCredentialID,
			RecipientWrappingPublicKey: clientKeys.WrappingPublicKey,
		})
		if sealErr != nil {
			return nil, commandError("CLIENT_CREDENTIAL_INVALID", "The Client Key Envelope could not be created.")
		}
		challenge, challengeErr := awsmcrypto.OpenKeyEnvelope(awsmcrypto.ClientCredentialTarget, clientKeys.WrappingPrivateKey, clientEnvelope.Envelope.Bytes)
		if challengeErr != nil || challenge.ID != clientEnvelope.ID || challenge.VaultID != vaultID || challenge.KeyEpochID != recovered.id ||
			!bytes.Equal(challenge.KeyEpochKey, recovered.key) || challenge.TargetCredentialID != clientCredentialID {
			zeroBytes(challenge.KeyEpochKey)
			return nil, commandError("CLIENT_CREDENTIAL_INVALID", "The Client wrapping-key challenge failed.")
		}
		zeroBytes(challenge.KeyEpochKey)
		clientEnvelopes = append(clientEnvelopes, clientEnvelope)
	}
	clientEnvelope := clientEnvelopes[currentEpochIndex]
	certificate := canonical.Map{0: clientCredentialID[:], 1: memberID[:], 2: clientKeys.SigningPublicKey, 3: clientKeys.WrappingPublicKey}
	slots := make([]canonical.Value, 0, len(clientEnvelopes))
	dependencies := make([]canonical.Dependency, 0, len(clientEnvelopes))
	for _, envelope := range clientEnvelopes {
		slots = append(slots, canonical.Map{0: envelope.KeyEpochID[:], 1: uint64(2), 2: clientCredentialID[:], 3: nil, 4: envelope.ID[:]})
		dependencies = append(dependencies, canonical.Dependency{Type: 7, ID: envelope.ID})
	}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	proposalPrefix := canonical.Map{
		0: vaultID[:], 1: memberID[:], 2: canonicalSetValues(identifiersToValues(r.replicas[id].State().AuthorityFrontier)),
		3: certificate, 4: canonicalSetValues(slots),
	}
	proposalBytes, err := canonical.EncodeValue(proposalPrefix)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment proposal could not be encoded.")
	}
	proposalSignatureTranscript, err := canonical.Transcript("awsm:client-enrollment-proposal:v1", proposalBytes)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment proposal could not be signed.")
	}
	proposal := canonical.Map{0: vaultID[:], 1: memberID[:], 2: proposalPrefix[2], 3: certificate, 4: proposalPrefix[4], 5: ed25519.Sign(clientKeys.SigningSecretKey, proposalSignatureTranscript)}
	proposalEncoded, err := canonical.EncodeValue(proposal)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment proposal could not be encoded.")
	}
	proposalIDTranscript, err := canonical.Transcript("awsm:client-enrollment-proposal-id:v1", proposalEncoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment proposal identity could not be derived.")
	}
	proposalIDDigest := sha256.Sum256(proposalIDTranscript)
	recoveryAuthorizationTranscript, err := canonical.Transcript("awsm:recovery-client-enrollment-authorization:v1", proposalIDDigest[:])
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Recovery authorization could not be signed.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	state := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: state.CausalFrontier, AuthorityParentIDs: state.AuthorityFrontier,
		Dependencies: dependencies, RequiredFeatureSetID: featureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 9, SignerCredentialID: clientCredentialID,
		AssertedAt: time.Now().UnixMilli(), Body: canonical.Map{0: proposal, 1: uint64(2), 2: recoveryCredentialID[:], 3: ed25519.Sign(recoveryKeys.SigningSecretKey, recoveryAuthorizationTranscript)},
	}, ed25519.PrivateKey(clientKeys.SigningSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment Event could not be authored.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: currentEpochID, KeyEpochKey: recoveredEpochs[currentEpochIndex].key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment envelope is invalid.")
	}
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientKeys.SigningPublicKey)); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Client Enrollment Event could not be admitted.")
	}
	clientSecret, err := encodeClientCredentialSecret(vaultID, memberID, clientCredentialID, clientKeys)
	if err != nil {
		return nil, commandError("CLIENT_CREDENTIAL_INVALID", "The Client Credential could not be protected.")
	}
	storedClientEnvelopeIDs := make([][32]byte, 0, len(clientEnvelopes))
	for _, envelope := range clientEnvelopes {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.Envelope.StorageItemID, envelope.Envelope.Bytes); err != nil {
			for _, storedID := range storedClientEnvelopeIDs {
				deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
			}
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Client Key Envelope could not be stored.")
		}
		storedClientEnvelopeIDs = append(storedClientEnvelopeIDs, envelope.Envelope.StorageItemID)
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		for _, storedID := range storedClientEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
		}
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Client Enrollment Event could not be stored.")
	}
	if err := r.deps.Secrets.Put(trustedSecretService, clientSecretAccount(id, credentialBytes), clientSecret); err != nil {
		for _, storedID := range storedClientEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
		}
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The recovered Client Credential could not be stored.")
	}
	value.Canonical.ClientCredentialID = credentialBytes
	for _, clientEnvelope := range clientEnvelopes {
		envelopeID := hexIdentifier(clientEnvelope.ID)
		storageID := hexIdentifier(clientEnvelope.Envelope.StorageItemID)
		value.Canonical.KeyEnvelopeStorageItemIDs[envelopeID] = storageID
		bindStorageItemKeyEpoch(value.Canonical, storageID, clientEnvelope.KeyEpochID)
	}
	value.Canonical.ClientEnvelopeID = hexIdentifier(clientEnvelope.ID)
	value.Canonical.ClientEnvelopeStorageID = hexIdentifier(clientEnvelope.Envelope.StorageItemID)
	value.Canonical.KeyEnvelopeStorageItemIDs[value.Canonical.ClientEnvelopeID] = value.Canonical.ClientEnvelopeStorageID
	bindStorageItemKeyEpoch(value.Canonical, value.Canonical.ClientEnvelopeStorageID, currentEpochID)
	value.Canonical.AuthoringAvailable = true
	nextState := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(nextState.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(nextState.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(nextState.ContinuityRecordIDs)
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, currentEpochID)
	r.replicas[id] = nextReplica
	r.selected = id
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		_ = r.deps.Secrets.Delete(trustedSecretService, clientSecretAccount(id, credentialBytes))
		for _, storedID := range storedClientEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
		}
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return nil, err
	}
	r.signal()
	return map[string]string{"memberId": value.Canonical.MemberID, "clientCredentialId": credentialBytes, "eventRecordId": hexIdentifier(event.RecordID)}, nil
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
	if value.Lifecycle != "Open" || value.Canonical == nil || r.replicas[value.VaultID] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_READ_ONLY", "A closed or unavailable Vault cannot replace its Recovery Credential.")
	}
	vaultID, err := decodeHexIdentifier(value.VaultID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Member identity is invalid.")
	}
	oldRecoveryID, err := decodeHexIdentifier(value.Canonical.RecoveryCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Recovery Credential identity is invalid.")
	}
	currentEpochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch identity is invalid.")
	}
	secretBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(value.VaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be opened.")
	}
	clientCredentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential identity is invalid.")
	}
	clientSecret, err := decodeClientSecret(secretBytes, vaultID, memberID, clientCredentialID)
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential is invalid.")
	}
	entropy, err := awsmcrypto.DecodeRecoveryPhrase(phrase)
	if err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase is invalid.")
	}
	recoveryKeys, err := awsmcrypto.DeriveRecoveryCredential(entropy)
	zeroBytes(entropy)
	if err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase could not derive its credential.")
	}
	defer wipeCredentialKeys(&recoveryKeys)
	newRecoveryIDText, err := randomID()
	if err != nil {
		return nil, err
	}
	newRecoveryID, err := decodeHexIdentifier(newRecoveryIDText)
	if err != nil {
		return nil, err
	}
	revision := uint64(pending.RecoveryRevision)
	authority, err := replayReplicaAuthorityState(r.replicas[value.VaultID], nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	type replacementEpoch struct {
		id  canonical.Identifier
		key []byte
	}
	orderedEpochs := sortedIdentifierKeys(authority.epochs)
	sort.Slice(orderedEpochs, func(left, right int) bool {
		leftDisplay := authority.epochs[orderedEpochs[left]]
		rightDisplay := authority.epochs[orderedEpochs[right]]
		if leftDisplay != rightDisplay {
			return leftDisplay < rightDisplay
		}
		return bytes.Compare(orderedEpochs[left][:], orderedEpochs[right][:]) < 0
	})
	replacementEpochs := make([]replacementEpoch, 0, len(orderedEpochs))
	for _, readableEpochID := range orderedEpochs {
		encodedEpoch, getErr := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(value.VaultID, hexIdentifier(readableEpochID)))
		if getErr != nil {
			return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "A readable Key Epoch could not be opened.")
		}
		epochSecret, decodeErr := decodeEpochSecret(encodedEpoch, vaultID, readableEpochID)
		if decodeErr != nil {
			return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "A readable Key Epoch is invalid.")
		}
		replacementEpochs = append(replacementEpochs, replacementEpoch{id: readableEpochID, key: epochSecret.key})
		defer zeroBytes(epochSecret.key)
	}
	if len(replacementEpochs) == 0 {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault has no readable Key Epoch.")
	}
	currentEpochIndex := -1
	for index := range replacementEpochs {
		if replacementEpochs[index].id == currentEpochID {
			currentEpochIndex = index
			break
		}
	}
	if currentEpochIndex < 0 {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Key Epoch is not readable.")
	}
	recoveryEnvelopes := make([]awsmcrypto.KeyEnvelope, 0, len(replacementEpochs))
	for _, readableEpoch := range replacementEpochs {
		recoveryEnvelope, sealErr := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
			VaultID: vaultID, KeyEpochID: readableEpoch.id, KeyEpochKey: readableEpoch.key,
			TargetKind: awsmcrypto.RecoveryCredentialTarget, TargetCredentialID: newRecoveryID,
			TargetRevision: &revision, RecipientWrappingPublicKey: recoveryKeys.WrappingPublicKey,
		})
		if sealErr != nil {
			return nil, commandError("RECOVERY_KEY_INVALID", "The replacement Recovery Key Envelope could not be created.")
		}
		challenge, challengeErr := awsmcrypto.OpenKeyEnvelope(awsmcrypto.RecoveryCredentialTarget, recoveryKeys.WrappingPrivateKey, recoveryEnvelope.Envelope.Bytes)
		if challengeErr != nil || challenge.ID != recoveryEnvelope.ID || challenge.VaultID != vaultID || challenge.KeyEpochID != readableEpoch.id ||
			!bytes.Equal(challenge.KeyEpochKey, readableEpoch.key) || challenge.TargetCredentialID != newRecoveryID || challenge.TargetRevision == nil || *challenge.TargetRevision != revision {
			zeroBytes(challenge.KeyEpochKey)
			return nil, commandError("RECOVERY_KEY_INVALID", "The replacement Recovery wrapping-key challenge failed.")
		}
		zeroBytes(challenge.KeyEpochKey)
		recoveryEnvelopes = append(recoveryEnvelopes, recoveryEnvelope)
	}
	descriptor := canonical.Map{0: newRecoveryID[:], 1: memberID[:], 2: revision, 3: recoveryKeys.SigningPublicKey, 4: recoveryKeys.WrappingPublicKey}
	descriptorBytes, err := canonical.EncodeValue(descriptor)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The replacement Recovery Credential could not be encoded.")
	}
	slotValues := make([]canonical.Value, 0, len(recoveryEnvelopes))
	dependencies := make([]canonical.Dependency, 0, len(recoveryEnvelopes))
	for _, recoveryEnvelope := range recoveryEnvelopes {
		slotValues = append(slotValues, canonical.Map{0: recoveryEnvelope.KeyEpochID[:], 1: uint64(1), 2: newRecoveryID[:], 3: revision, 4: recoveryEnvelope.ID[:]})
		dependencies = append(dependencies, canonical.Dependency{Type: 7, ID: recoveryEnvelope.ID})
	}
	slots := canonicalSetValues(slotValues)
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	slotsBytes, err := canonical.EncodeValue(slots)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The replacement Recovery Key Envelope slot could not be encoded.")
	}
	authorityParents := canonicalSetValues(identifiersToValues(r.replicas[value.VaultID].State().AuthorityFrontier))
	possessionTranscript, err := canonical.Transcript("awsm:recovery-replacement-possession:v1", vaultID[:], memberID[:], mustCanonical(authorityParents), descriptorBytes, slotsBytes)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The replacement Recovery Credential could not be signed.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	replicaState := r.replicas[value.VaultID].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: replicaState.CausalFrontier, AuthorityParentIDs: replicaState.AuthorityFrontier,
		Dependencies: dependencies, RequiredFeatureSetID: featureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 11, SignerCredentialID: clientCredentialID,
		AssertedAt: time.Now().UnixMilli(), Body: canonical.Map{0: memberID[:], 1: canonicalSetValues([]canonical.Value{oldRecoveryID[:]}), 2: descriptor, 3: slots, 4: ed25519.Sign(ed25519.PrivateKey(recoveryKeys.SigningSecretKey), possessionTranscript)},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Recovery Replacement Event could not be authored.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: currentEpochID, KeyEpochKey: replacementEpochs[currentEpochIndex].key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Recovery Replacement Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Recovery Replacement envelope is invalid.")
	}
	nextReplica := r.replicas[value.VaultID].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Recovery Replacement Event could not be admitted.")
	}
	storedRecoveryEnvelopeIDs := make([][32]byte, 0, len(recoveryEnvelopes))
	for _, recoveryEnvelope := range recoveryEnvelopes {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, recoveryEnvelope.Envelope.StorageItemID, recoveryEnvelope.Envelope.Bytes); err != nil {
			for _, storedID := range storedRecoveryEnvelopeIDs {
				deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
			}
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The replacement Recovery Key Envelope could not be stored.")
		}
		storedRecoveryEnvelopeIDs = append(storedRecoveryEnvelopeIDs, recoveryEnvelope.Envelope.StorageItemID)
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		for _, storedID := range storedRecoveryEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
		}
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Recovery Replacement Event could not be stored.")
	}
	value.RecoveryHash = pending.PhraseHash
	value.RecoveryRevision = pending.RecoveryRevision
	value.Canonical.RecoveryCredentialID = newRecoveryIDText
	for _, recoveryEnvelope := range recoveryEnvelopes {
		envelopeID := hexIdentifier(recoveryEnvelope.ID)
		storageID := hexIdentifier(recoveryEnvelope.Envelope.StorageItemID)
		value.Canonical.KeyEnvelopeStorageItemIDs[envelopeID] = storageID
		bindStorageItemKeyEpoch(value.Canonical, storageID, recoveryEnvelope.KeyEpochID)
	}
	currentRecoveryEnvelope := recoveryEnvelopes[currentEpochIndex]
	value.Canonical.RecoveryEnvelopeID = hexIdentifier(currentRecoveryEnvelope.ID)
	value.Canonical.RecoveryEnvelopeStorageID = hexIdentifier(currentRecoveryEnvelope.Envelope.StorageItemID)
	value.Canonical.KeyEnvelopeStorageItemIDs[value.Canonical.RecoveryEnvelopeID] = value.Canonical.RecoveryEnvelopeStorageID
	bindStorageItemKeyEpoch(value.Canonical, value.Canonical.RecoveryEnvelopeStorageID, currentEpochID)
	nextState := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(nextState.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(nextState.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(nextState.ContinuityRecordIDs)
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, currentEpochID)
	r.replicas[value.VaultID] = nextReplica
	r.pending = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		for _, storedID := range storedRecoveryEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storedID)
		}
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		return nil, err
	}
	r.signal()
	return map[string]any{"recoveryCredentialId": newRecoveryIDText, "revision": pending.RecoveryRevision, "eventRecordId": hexIdentifier(event.RecordID)}, nil
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
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, epochID)
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
	if value.Canonical == nil || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	replica := r.replicas[id]
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_REQUIRES_REPLAY", "The authenticated Library projection is unavailable for Vacuum.")
	}
	authorityCheckpoint, err := buildVacuumAuthorityCheckpoint(replica)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_REQUIRES_REPLAY", err.Error())
	}
	vaultID, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	clientCredentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential identity is invalid.")
	}
	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Member identity is invalid.")
	}
	clientBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(id, value.Canonical.ClientCredentialID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be opened.")
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultID, memberID, clientCredentialID)
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential is invalid.")
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch identity is invalid.")
	}
	epochBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, value.Canonical.KeyEpochID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Key Epoch could not be opened.")
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultID, epochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch is invalid.")
	}
	defer zeroBytes(epochSecret.key)
	predecessorGenerationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The predecessor Generation identity is invalid.")
	}
	successorGenerationText, err := randomID()
	if err != nil {
		return nil, err
	}
	successorGenerationID, err := decodeHexIdentifier(successorGenerationText)
	if err != nil {
		return nil, err
	}
	frontier := replica.State()
	oldContent, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The predecessor content checkpoint is invalid.")
	}
	lifecycleCheckpoint := canonical.Map{0: uint64(1)}
	contentCheckpoint, err := buildVacuumContentCheckpoint(replica, projection)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_REQUIRES_REPLAY", err.Error())
	}
	dependencies, retainedObjects, retainedArtifacts, err := vacuumCaptureObjectClosure(replica, value.Canonical, projection, r.deps.Artifacts)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_REQUIRES_REPLAY", err.Error())
	}
	predecessorState := canonical.Map{0: oldContent, 1: authorityCheckpoint, 2: lifecycleCheckpoint}
	successorState := canonical.Map{0: contentCheckpoint, 1: authorityCheckpoint, 2: lifecycleCheckpoint}
	predecessorStateBytes, err := canonical.EncodeValue(predecessorState)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The predecessor state checkpoint is invalid.")
	}
	successorStateBytes, err := canonical.EncodeValue(successorState)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The successor state checkpoint is invalid.")
	}
	predecessorTranscript, err := canonical.Transcript("awsm:vacuum-predecessor-state:v1", predecessorStateBytes)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The predecessor state digest could not be computed.")
	}
	successorTranscript, err := canonical.Transcript("awsm:vacuum-successor-state:v1", successorStateBytes)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The successor state digest could not be computed.")
	}
	predecessorDigest := sha256.Sum256(predecessorTranscript)
	successorDigest := sha256.Sum256(successorTranscript)
	omissionEntries := make([]canonical.Value, 0)
	for _, capture := range projection.captureState {
		if capture.lifecycleCode != 2 {
			continue
		}
		bundleID, decodeErr := decodeHexIdentifier(capture.bundleID)
		if decodeErr != nil {
			return nil, commandError("VAULT_VACUUM_INVALID", "The omitted Capture identity is invalid.")
		}
		omissionEntries = append(omissionEntries, canonical.Map{0: uint64(1), 1: bundleID[:], 2: uint64(1)})
	}
	omissionCheckpoint := canonical.Map{0: uint64(1), 1: canonicalSetValues(omissionEntries)}
	omissionBytes, err := canonical.EncodeValue(omissionCheckpoint)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The omission checkpoint is invalid.")
	}
	omissionTranscript, err := canonical.Transcript("awsm:vacuum-omission:v1", omissionBytes)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The omission digest could not be computed.")
	}
	omissionDigest := sha256.Sum256(omissionTranscript)
	predecessorCommitment := canonical.Map{
		0: predecessorGenerationID[:], 1: canonicalSetValues(identifiersToValues(frontier.CausalFrontier)), 2: predecessorDigest[:],
	}
	baselineBody := canonical.Map{0: uint64(1), 1: uint64(2), 2: contentCheckpoint, 3: authorityCheckpoint, 4: lifecycleCheckpoint, 5: predecessorCommitment}
	baseline, err := canonical.EncodeBaseline(canonical.BaselineInput{
		VaultID: vaultID, GenerationID: successorGenerationID,
		Dependencies:         dependencies,
		RequiredFeatureSetID: replica.baseline.RequiredFeatureSetID,
		Extensions:           cloneExtensions(replica.baseline.Extensions), Body: baselineBody,
	})
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The successor Baseline could not be created.")
	}
	baselineEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: baseline.Bytes})
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The successor Baseline could not be protected.")
	}
	baselineEnvelope, err := storage.DecodeOpaqueEnvelope(baselineEnvelopeBytes)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The successor Baseline envelope is invalid.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: predecessorGenerationID, ParentRecordIDs: frontier.CausalFrontier, AuthorityParentIDs: frontier.AuthorityFrontier,
		Dependencies: []canonical.Dependency{{Type: 2, ID: baseline.RecordID}}, RequiredFeatureSetID: featureSetID,
		Extensions: map[string][]byte{}, Family: canonical.LifecycleFamily, Type: 1, SignerCredentialID: clientCredentialID,
		AssertedAt: time.Now().UnixMilli(), Body: canonical.Map{0: predecessorGenerationID[:], 1: canonicalSetValues(identifiersToValues(frontier.CausalFrontier)), 2: successorGenerationID[:], 3: baseline.RecordID[:], 4: predecessorDigest[:], 5: successorDigest[:], 6: omissionDigest[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The Vacuum Event could not be authored.")
	}
	eventEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The Vacuum Event could not be protected.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(eventEnvelopeBytes)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The Vacuum Event envelope is invalid.")
	}
	nextReplica, err := r.replicas[id].AdoptVacuum(baseline, event)
	if err != nil {
		return nil, commandError("VAULT_VACUUM_INVALID", "The Vacuum Event could not be adopted.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, baselineEnvelope.StorageItemID, baselineEnvelope.Bytes); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The successor Baseline could not be stored.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, eventEnvelope.Bytes); err != nil {
		deleteOpaqueCreationItem(r.deps.Artifacts, baselineEnvelope.StorageItemID)
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Vacuum Event could not be stored.")
	}
	predecessorGenerationText := value.GenerationID
	value.GenerationID = successorGenerationText
	value.Canonical.GenerationID = successorGenerationText
	value.Canonical.PredecessorGenerationID = predecessorGenerationText
	value.Canonical.BaselineID = hexIdentifier(baseline.RecordID)
	value.Canonical.BaselineStorageItemID = hexIdentifier(baselineEnvelope.StorageItemID)
	value.Canonical.AdoptionEventID = hexIdentifier(event.RecordID)
	nextState := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(nextState.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(nextState.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(nextState.ContinuityRecordIDs)
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	baselineStorageItemID := hexIdentifier(baselineEnvelope.StorageItemID)
	eventStorageItemID := hexIdentifier(eventEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(baseline.RecordID)] = baselineStorageItemID
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = eventStorageItemID
	bindStorageItemKeyEpoch(value.Canonical, baselineStorageItemID, epochID)
	bindStorageItemKeyEpoch(value.Canonical, eventStorageItemID, epochID)
	for objectID := range value.Canonical.ObjectStorageItemIDs {
		if _, retained := retainedObjects[objectID]; retained {
			continue
		}
		storageItemID := value.Canonical.ObjectStorageItemIDs[objectID]
		delete(value.Canonical.ObjectStorageItemIDs, objectID)
		delete(value.Canonical.StorageItemKeyEpochIDs, storageItemID)
	}
	for artifactID := range value.Canonical.ArtifactStorageItemIDs {
		if _, retained := retainedArtifacts[artifactID]; retained {
			continue
		}
		storageItemID := value.Canonical.ArtifactStorageItemIDs[artifactID]
		delete(value.Canonical.ArtifactStorageItemIDs, artifactID)
		delete(value.Canonical.StorageItemKeyEpochIDs, storageItemID)
	}
	r.replicas[id] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, baselineEnvelope.StorageItemID)
		deleteOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID)
		return nil, err
	}
	r.signal()
	return map[string]string{"predecessorGenerationId": hexIdentifier(predecessorGenerationID), "successorGenerationId": successorGenerationText, "vacuumEventRecordId": hexIdentifier(event.RecordID), "successorBaselineId": hexIdentifier(baseline.RecordID)}, nil
}

func vacuumCaptureObjectClosure(replica *Replica, state *canonicalReplicaState, projection LibraryProjection, artifacts *artifactstore.Store) ([]canonical.Dependency, map[string]struct{}, map[string]struct{}, error) {
	if replica == nil || state == nil || artifacts == nil {
		return nil, nil, nil, errors.New("Vacuum Capture Object closure is unavailable")
	}
	activeDependencies := make(map[canonical.Dependency]struct{})
	retainedObjects := make(map[string]struct{})
	retainedArtifacts := make(map[string]struct{})
	for _, capture := range projection.captureState {
		if capture.lifecycleCode != 1 {
			continue
		}
		bundleID, err := decodeHexIdentifier(capture.bundleID)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("Capture %s identity is invalid", capture.bundleID)
		}
		descriptor, ok := replica.Object(capture.descriptorID)
		if !ok || descriptor.ObjectType != 1 {
			return nil, nil, nil, fmt.Errorf("Capture %s Descriptor Object is unavailable", capture.bundleID)
		}
		metadata, err := parseBundleDescriptorMetadata(descriptor.Body)
		if err != nil || metadata.bundleID != bundleID {
			return nil, nil, nil, fmt.Errorf("Capture %s Descriptor Object is invalid", capture.bundleID)
		}
		if err := requireVacuumObjectStorage(state, artifacts, capture.descriptorID, true); err != nil {
			return nil, nil, nil, err
		}
		activeDependencies[canonical.Dependency{Type: 4, ID: capture.descriptorID}] = struct{}{}
		retainedObjects[hexIdentifier(capture.descriptorID)] = struct{}{}
		body, ok := replicaMapValue(descriptor.Body)
		if !ok {
			return nil, nil, nil, fmt.Errorf("Capture %s Descriptor Object body is invalid", capture.bundleID)
		}
		references, ok := replicaMapArray(body, 9)
		if !ok {
			return nil, nil, nil, fmt.Errorf("Capture %s Descriptor Object references are invalid", capture.bundleID)
		}
		for _, reference := range references {
			artifactID, ok := replicaIdentifier(reference, 0)
			if !ok {
				return nil, nil, nil, fmt.Errorf("Capture %s Artifact identity is invalid", capture.bundleID)
			}
			artifactObject, ok := replica.Object(artifactID)
			if !ok || artifactObject.ObjectType != 2 {
				return nil, nil, nil, fmt.Errorf("Capture %s Artifact Object is unavailable", capture.bundleID)
			}
			if err := requireVacuumObjectStorage(state, artifacts, artifactID, true); err != nil {
				return nil, nil, nil, err
			}
			activeDependencies[canonical.Dependency{Type: 5, ID: artifactID}] = struct{}{}
			retainedObjects[hexIdentifier(artifactID)] = struct{}{}
			if storageItemID, exists := state.ArtifactStorageItemIDs[hexIdentifier(artifactID)]; exists {
				if err := requireVacuumStorageItem(artifacts, storageItemID); err != nil {
					return nil, nil, nil, err
				}
				retainedArtifacts[hexIdentifier(artifactID)] = struct{}{}
			}
		}
	}
	for _, note := range projection.noteState {
		for _, version := range note.versions {
			for _, objectID := range []*canonical.Identifier{version.contentID, version.restoreID} {
				if objectID == nil {
					continue
				}
				object, ok := replica.Object(*objectID)
				if !ok || object.ObjectType != 3 {
					return nil, nil, nil, fmt.Errorf("Note %s Content Object is unavailable", hexIdentifier(note.noteID))
				}
				if err := requireVacuumObjectStorage(state, artifacts, *objectID, true); err != nil {
					return nil, nil, nil, err
				}
				activeDependencies[canonical.Dependency{Type: 6, ID: *objectID}] = struct{}{}
				retainedObjects[hexIdentifier(*objectID)] = struct{}{}
			}
		}
	}
	dependencies := make(map[canonical.Dependency]struct{})
	for _, dependency := range replica.baseline.Dependencies {
		if dependency.Type == 4 || dependency.Type == 5 {
			if _, retained := activeDependencies[dependency]; !retained {
				continue
			}
		}
		dependencies[dependency] = struct{}{}
	}
	for dependency := range activeDependencies {
		dependencies[dependency] = struct{}{}
	}
	result := make([]canonical.Dependency, 0, len(dependencies))
	for dependency := range dependencies {
		result = append(result, dependency)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].Type != result[right].Type {
			return result[left].Type < result[right].Type
		}
		return bytes.Compare(result[left].ID[:], result[right].ID[:]) < 0
	})
	return result, retainedObjects, retainedArtifacts, nil
}

func requireVacuumObjectStorage(state *canonicalReplicaState, artifacts *artifactstore.Store, objectID canonical.Identifier, compact bool) error {
	storageItemID, ok := state.ObjectStorageItemIDs[hexIdentifier(objectID)]
	if !ok {
		return fmt.Errorf("Vacuum Object %s has no local Storage mapping", hexIdentifier(objectID))
	}
	return requireVacuumStorageItem(artifacts, storageItemID)
}

func requireVacuumStorageItem(artifacts *artifactstore.Store, storageItemID string) error {
	if !validDigest(storageItemID) {
		return fmt.Errorf("Vacuum Storage Item %s identity is invalid", storageItemID)
	}
	reader, err := artifacts.Open(storageItemID)
	if err != nil {
		return fmt.Errorf("Vacuum Storage Item %s is unavailable", storageItemID)
	}
	_ = reader.Close()
	return nil
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
		result = append(result, RemoteSummary{RemoteID: remote.RemoteID, Name: remote.Name, Endpoint: remote.Endpoint, Enabled: remote.Enabled, ReplicaHandle: remote.ReplicaHandle})
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

func (r *Runtime) listLibraryProjection(id string) (any, error) {
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
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		return nil, commandError("LIBRARY_UNAVAILABLE", "The Vault Library could not be rebuilt from authenticated state.")
	}
	return projection, nil
}

func authorityStateSummary(vaultID string, state AuthorityState) AuthorityStateSummary {
	result := AuthorityStateSummary{
		VaultID:                        vaultID,
		ActiveMemberIDs:                identifiersToHex(state.ActiveMemberIDs),
		AdministratorIDs:               identifiersToHex(state.AdministratorIDs),
		AdministratorConflicts:         make([]AuthorityAdministratorConflictSummary, 0, len(state.AdministratorConflicts)),
		ActiveInvitationIDs:            identifiersToHex(state.ActiveInvitationIDs),
		InvitationConflictIDs:          identifiersToHex(state.InvitationConflictIDs),
		ActiveClientCredentialIDs:      identifiersToHex(state.ActiveClientCredentialIDs),
		EffectiveRecoveryCredentialIDs: identifiersToHex(state.EffectiveRecoveryCredentialIDs),
		RecoveryConflicts:              make([]AuthorityRecoveryConflictSummary, 0, len(state.RecoveryConflicts)),
		KeyEpochConflicts:              make([]AuthorityKeyEpochConflictSummary, 0, len(state.KeyEpochConflicts)),
		CurrentKeyEpochIDs:             identifiersToHex(state.CurrentKeyEpochIDs),
		Lifecycle:                      state.Lifecycle,
	}
	for _, conflict := range state.AdministratorConflicts {
		candidateSummary := make([]AuthorityAdministratorConflictCandidateSummary, 0, len(conflict.Candidates))
		for _, candidate := range conflict.Candidates {
			candidateSummary = append(candidateSummary, AuthorityAdministratorConflictCandidateSummary{
				HeadRecordID:  hexIdentifier(candidate.HeadRecordID),
				Administrator: candidate.Administrator,
			})
		}
		result.AdministratorConflicts = append(result.AdministratorConflicts, AuthorityAdministratorConflictSummary{
			MemberID:   hexIdentifier(conflict.MemberID),
			Candidates: candidateSummary,
		})
	}
	for _, conflict := range state.RecoveryConflicts {
		candidateSummary := make([]AuthorityRecoveryConflictCandidateSummary, 0, len(conflict.Candidates))
		for _, candidate := range conflict.Candidates {
			candidateSummary = append(candidateSummary, AuthorityRecoveryConflictCandidateSummary{
				HeadRecordID:         hexIdentifier(candidate.HeadRecordID),
				RecoveryCredentialID: hexIdentifier(candidate.RecoveryCredentialID),
			})
		}
		result.RecoveryConflicts = append(result.RecoveryConflicts, AuthorityRecoveryConflictSummary{
			MemberID:   hexIdentifier(conflict.MemberID),
			Candidates: candidateSummary,
		})
	}
	for _, conflict := range state.KeyEpochConflicts {
		candidateSummary := make([]AuthorityKeyEpochConflictCandidateSummary, 0, len(conflict.Candidates))
		for _, candidate := range conflict.Candidates {
			candidateSummary = append(candidateSummary, AuthorityKeyEpochConflictCandidateSummary{
				HeadRecordID: hexIdentifier(candidate.HeadRecordID),
				KeyEpochID:   hexIdentifier(candidate.KeyEpochID),
			})
		}
		result.KeyEpochConflicts = append(result.KeyEpochConflicts, AuthorityKeyEpochConflictSummary{Candidates: candidateSummary})
	}
	if state.FeatureSetConflict != nil {
		result.FeatureSetConflict = &AuthorityFeatureSetConflictSummary{
			CandidateRecordIDs: identifiersToHex(state.FeatureSetConflict.CandidateRecordIDs),
			ManifestIDs:        identifiersToHex(state.FeatureSetConflict.ManifestIDs),
		}
	}
	return result
}

func (r *Runtime) listAuthorityState(id string) (any, error) {
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
	state, err := replica.AuthorityState()
	if err != nil {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "The Vault Authority State could not be rebuilt from authenticated state.")
	}
	return authorityStateSummary(id, state), nil
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
			return RemoteSummary{RemoteID: remoteID, Name: name, Endpoint: value.Remotes[index].Endpoint, Enabled: value.Remotes[index].Enabled, ReplicaHandle: value.Remotes[index].ReplicaHandle}, nil
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
			return RemoteSummary{RemoteID: remote.RemoteID, Name: remote.Name, Endpoint: remote.Endpoint, Enabled: remote.Enabled, ReplicaHandle: remote.ReplicaHandle}, nil
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
			if r.deps.Secrets != nil {
				_ = r.deps.Secrets.Delete(trustedSecretService, remoteSessionAccount(remoteID))
			}
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
	if r.deps.Secrets == nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "This Client cannot retain a Hosted Replica session.")
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	session, err := signInHostedReplica(ctx, endpoint, username, password, r.deps.HTTPClient)
	if err != nil {
		return nil, commandError("REMOTE_AUTHENTICATION_FAILED", "Hosted Replica sign-in failed.")
	}
	host, err := newHostedReplicaHTTP(endpoint, session.AccessToken, r.deps.HTTPClient)
	if err != nil {
		return nil, commandError("REMOTE_ENDPOINT_INVALID", "Hosted Replica endpoint is invalid.")
	}
	created, err := host.createReplica(ctx)
	if err != nil {
		return nil, commandError("REMOTE_CREATE_FAILED", "The Hosted Replica could not be created.")
	}
	if !hasHostedReplicaSyncCapabilities(created.Capabilities) {
		return nil, commandError("REMOTE_CAPABILITY_INVALID", "The Hosted Replica does not provide full synchronization access.")
	}
	remoteID := uuid.NewString()
	remote := remoteState{RemoteID: remoteID, Name: name, Endpoint: endpoint, Enabled: true, ReplicaHandle: created.ReplicaHandle, LocatorSalt: hex.EncodeToString(created.LocatorSalt[:]), InventoryPageSize: 100}
	if err := r.deps.Secrets.Put(trustedSecretService, remoteSessionAccount(remoteID), mustEncodeHostedSession(session)); err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Hosted Replica session could not be stored.")
	}
	value.Remotes = append(value.Remotes, remote)
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		_ = r.deps.Secrets.Delete(trustedSecretService, remoteSessionAccount(remoteID))
		return nil, err
	}
	r.signal()
	return RemoteSummary{RemoteID: remoteID, Name: name, Endpoint: endpoint, Enabled: true, ReplicaHandle: created.ReplicaHandle}, nil
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
		copyValue.Remotes = cloneRemoteStates(value.Remotes)
		copyValue.Quarantine = cloneQuarantine(value.Quarantine)
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
	snapshot := runtimeSnapshot{selected: r.selected, pending: clonePending(r.pending), hostedAttachment: cloneHostedAttachment(r.hostedAttachment), vaults: make(map[string]*persistedVault, len(r.vaults)), replicas: make(map[string]*Replica, len(r.replicas))}
	for id, value := range r.vaults {
		copyValue := *value
		copyValue.Label = cloneString(value.Label)
		copyValue.Canonical = cloneCanonicalState(value.Canonical)
		copyValue.Remotes = cloneRemoteStates(value.Remotes)
		copyValue.Quarantine = cloneQuarantine(value.Quarantine)
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
	r.hostedAttachment = cloneHostedAttachment(snapshot.hostedAttachment)
	r.vaults = make(map[string]*persistedVault, len(snapshot.vaults))
	r.replicas = make(map[string]*Replica, len(snapshot.replicas))
	for id, value := range snapshot.vaults {
		copyValue := *value
		copyValue.Label = cloneString(value.Label)
		copyValue.Canonical = cloneCanonicalState(value.Canonical)
		copyValue.Remotes = cloneRemoteStates(value.Remotes)
		copyValue.Quarantine = cloneQuarantine(value.Quarantine)
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
	if !validDigest(value.VaultID) || !validDigest(value.GenerationID) || (value.RecoveryHash != "" && !validDigest(value.RecoveryHash)) {
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
		if uuid.Validate(remote.ReplicaHandle) != nil || !validDigest(remote.LocatorSalt) || remote.InventoryPageSize < 1 || remote.InventoryPageSize > 500 {
			return errors.New("Vault state contains an invalid Hosted Replica binding")
		}
	}
	for storageItemID, encoded := range value.Quarantine {
		if !validDigest(storageItemID) || len(encoded) == 0 {
			return errors.New("Vault state contains an invalid Quarantine item")
		}
		envelope, err := storage.DecodeOpaqueEnvelope(encoded)
		if err != nil || hexIdentifier(envelope.StorageItemID) != storageItemID {
			return errors.New("Vault state contains an invalid Quarantine envelope")
		}
	}
	if value.Canonical != nil {
		for _, identifier := range []string{
			value.Canonical.VaultID, value.Canonical.GenerationID, value.Canonical.BaselineID, value.Canonical.GenesisID, value.Canonical.KeyEpochID, value.Canonical.RequiredFeatureSetID, value.Canonical.BaselineRequiredFeatureSetID,
			value.Canonical.MemberID, value.Canonical.ClientCredentialID,
			value.Canonical.RecoveryCredentialID,
			value.Canonical.BaselineStorageItemID, value.Canonical.GenesisStorageItemID,
			value.Canonical.RecoveryEnvelopeID, value.Canonical.RecoveryEnvelopeStorageID,
			value.Canonical.ClientEnvelopeID, value.Canonical.ClientEnvelopeStorageID,
		} {
			if !validDigest(identifier) {
				return errors.New("Vault state contains an invalid canonical identity")
			}
		}
		if value.Canonical.AdoptionEventID != "" {
			if !validDigest(value.Canonical.AdoptionEventID) || !validDigest(value.Canonical.PredecessorGenerationID) || value.Canonical.AdoptionEventID == value.Canonical.GenesisID {
				return errors.New("Vault state contains an invalid Vacuum Adoption")
			}
		} else if value.Canonical.PredecessorGenerationID != "" {
			return errors.New("Vault state contains an incomplete Vacuum Adoption")
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
		for manifestID, storageItemID := range value.Canonical.FeatureManifestStorageItemIDs {
			if !validDigest(manifestID) || !validDigest(storageItemID) {
				return errors.New("Vault state contains an invalid canonical Feature Manifest storage mapping")
			}
		}
		for artifactID, storageItemID := range value.Canonical.ArtifactStorageItemIDs {
			if !validDigest(artifactID) || !validDigest(storageItemID) {
				return errors.New("Vault state contains an invalid canonical Artifact storage mapping")
			}
		}
		for envelopeID, storageItemID := range value.Canonical.KeyEnvelopeStorageItemIDs {
			if !validDigest(envelopeID) || !validDigest(storageItemID) {
				return errors.New("Vault state contains an invalid canonical Key Envelope storage mapping")
			}
		}
		for _, envelopeID := range []string{value.Canonical.RecoveryEnvelopeID, value.Canonical.ClientEnvelopeID} {
			storageItemID, ok := value.Canonical.KeyEnvelopeStorageItemIDs[envelopeID]
			if !ok || storageItemID == "" {
				return errors.New("Vault state is missing a current Key Envelope storage mapping")
			}
		}
		for storageItemID, epochID := range value.Canonical.StorageItemKeyEpochIDs {
			if !validDigest(storageItemID) || !validDigest(epochID) {
				return errors.New("Vault state contains an invalid canonical Storage Item Key Epoch mapping")
			}
		}
		storageItemIDs := canonicalStorageItemIDs(value.Canonical)
		if len(value.Canonical.StorageItemKeyEpochIDs) != len(storageItemIDs) {
			return errors.New("Vault state contains an incomplete canonical Storage Item Key Epoch inventory")
		}
		for _, storageItemID := range storageItemIDs {
			if _, ok := value.Canonical.StorageItemKeyEpochIDs[storageItemID]; !ok {
				return errors.New("Vault state is missing a canonical Storage Item Key Epoch mapping")
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

func canonicalStorageItemIDs(state *canonicalReplicaState) []string {
	if state == nil {
		return nil
	}
	ids := make(map[string]struct{})
	for _, storageItemID := range []string{
		state.BaselineStorageItemID, state.GenesisStorageItemID,
		state.RecoveryEnvelopeStorageID, state.ClientEnvelopeStorageID,
	} {
		if storageItemID != "" {
			ids[storageItemID] = struct{}{}
		}
	}
	for _, mappings := range []map[string]string{
		state.RecordStorageItemIDs, state.ObjectStorageItemIDs, state.KeyEnvelopeStorageItemIDs,
		state.FeatureManifestStorageItemIDs, state.ArtifactStorageItemIDs,
	} {
		for _, storageItemID := range mappings {
			if storageItemID != "" {
				ids[storageItemID] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(ids))
	for storageItemID := range ids {
		result = append(result, storageItemID)
	}
	sortStrings(result)
	return result
}

func bindStorageItemKeyEpoch(state *canonicalReplicaState, storageItemID string, epochID [32]byte) {
	if state.StorageItemKeyEpochIDs == nil {
		state.StorageItemKeyEpochIDs = map[string]string{}
	}
	state.StorageItemKeyEpochIDs[storageItemID] = hexIdentifier(epochID)
}

func (r *Runtime) openOpaqueWithKnownEpochs(vaultID string, state *canonicalReplicaState, vaultIdentifier canonical.Identifier, encoded []byte) (awsmcrypto.OpenedCompactItem, error) {
	if state == nil {
		return awsmcrypto.OpenedCompactItem{}, errors.New("canonical Replica state is missing")
	}
	epochIDs := make(map[string]struct{})
	for _, epochIDText := range state.StorageItemKeyEpochIDs {
		if validDigest(epochIDText) {
			epochIDs[epochIDText] = struct{}{}
		}
	}
	if validDigest(state.KeyEpochID) {
		epochIDs[state.KeyEpochID] = struct{}{}
	}
	ordered := make([]string, 0, len(epochIDs))
	for epochIDText := range epochIDs {
		ordered = append(ordered, epochIDText)
	}
	sortStrings(ordered)
	for _, epochIDText := range ordered {
		epochID, err := decodeHexIdentifier(epochIDText)
		if err != nil {
			continue
		}
		encodedSecret, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, epochIDText))
		if err != nil {
			continue
		}
		secret, err := decodeEpochSecret(encodedSecret, vaultIdentifier, epochID)
		if err != nil {
			continue
		}
		opened, openErr := awsmcrypto.OpenCompactItem(vaultIdentifier, epochID, secret.key, encoded)
		zeroBytes(secret.key)
		if openErr == nil {
			return opened, nil
		}
	}
	return awsmcrypto.OpenedCompactItem{}, errors.New("Compact authentication failed for every known Key Epoch")
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

func cloneQuarantine(value map[string][]byte) map[string][]byte {
	if value == nil {
		return nil
	}
	copyValue := make(map[string][]byte, len(value))
	for storageItemID, encoded := range value {
		copyValue[storageItemID] = append([]byte(nil), encoded...)
	}
	return copyValue
}

func cloneRemoteStates(values []remoteState) []remoteState {
	if values == nil {
		return nil
	}
	copyValues := make([]remoteState, len(values))
	copy(copyValues, values)
	return copyValues
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

func cloneHostedAttachment(value *pendingHostedAttachment) *pendingHostedAttachment {
	if value == nil {
		return nil
	}
	copyValue := *value
	copyValue.Replicas = make([]hostedReplicaSummary, len(value.Replicas))
	copy(copyValue.Replicas, value.Replicas)
	for index := range copyValue.Replicas {
		copyValue.Replicas[index].Capabilities = append([]string(nil), value.Replicas[index].Capabilities...)
	}
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
	copyValue.FeatureManifestStorageItemIDs = make(map[string]string, len(value.FeatureManifestStorageItemIDs))
	for manifestID, storageItemID := range value.FeatureManifestStorageItemIDs {
		copyValue.FeatureManifestStorageItemIDs[manifestID] = storageItemID
	}
	copyValue.ArtifactStorageItemIDs = make(map[string]string, len(value.ArtifactStorageItemIDs))
	for artifactID, storageItemID := range value.ArtifactStorageItemIDs {
		copyValue.ArtifactStorageItemIDs[artifactID] = storageItemID
	}
	copyValue.KeyEnvelopeStorageItemIDs = make(map[string]string, len(value.KeyEnvelopeStorageItemIDs))
	for envelopeID, storageItemID := range value.KeyEnvelopeStorageItemIDs {
		copyValue.KeyEnvelopeStorageItemIDs[envelopeID] = storageItemID
	}
	copyValue.StorageItemKeyEpochIDs = make(map[string]string, len(value.StorageItemKeyEpochIDs))
	for storageItemID, epochID := range value.StorageItemKeyEpochIDs {
		copyValue.StorageItemKeyEpochIDs[storageItemID] = epochID
	}
	return &copyValue
}

func canonicalReplicaFromCreation(prepared PreparedCanonicalVaultCreation) *canonicalReplicaState {
	featureMappings := make(map[string]string, len(prepared.FeatureManifests))
	for _, feature := range prepared.FeatureManifests {
		featureMappings[hexIdentifier(feature.ID)] = hexIdentifier(feature.Envelope.StorageItemID)
	}
	canonicalState := &canonicalReplicaState{
		VaultID:                      hexIdentifier(prepared.IDs.VaultID),
		GenerationID:                 hexIdentifier(prepared.IDs.GenerationID),
		BaselineID:                   hexIdentifier(prepared.Baseline.RecordID),
		GenesisID:                    hexIdentifier(prepared.Genesis.RecordID),
		KeyEpochID:                   hexIdentifier(prepared.KeyEpochID),
		RequiredFeatureSetID:         hexIdentifier(prepared.RequiredFeatureSetID),
		BaselineRequiredFeatureSetID: hexIdentifier(prepared.RequiredFeatureSetID),
		MemberID:                     hexIdentifier(prepared.IDs.FirstMemberID),
		RecoveryCredentialID:         hexIdentifier(prepared.IDs.RecoveryCredentialID),
		ClientCredentialID:           hexIdentifier(prepared.IDs.ClientCredentialID),
		BaselineStorageItemID:        hexIdentifier(prepared.BaselineEnvelope.StorageItemID),
		GenesisStorageItemID:         hexIdentifier(prepared.GenesisEnvelope.StorageItemID),
		RecoveryEnvelopeID:           hexIdentifier(prepared.RecoveryKeyEnvelope.ID),
		RecoveryEnvelopeStorageID:    hexIdentifier(prepared.RecoveryKeyEnvelope.Envelope.StorageItemID),
		ClientEnvelopeID:             hexIdentifier(prepared.ClientKeyEnvelope.ID),
		ClientEnvelopeStorageID:      hexIdentifier(prepared.ClientKeyEnvelope.Envelope.StorageItemID),
		AuthoringAvailable:           true,
		CausalFrontier:               []string{hexIdentifier(prepared.Genesis.RecordID)},
		AuthorityFrontier:            []string{hexIdentifier(prepared.Genesis.RecordID)},
		ContinuityRecordIDs:          []string{hexIdentifier(prepared.Genesis.RecordID)},
		RecordStorageItemIDs: map[string]string{
			hexIdentifier(prepared.Baseline.RecordID): hexIdentifier(prepared.BaselineEnvelope.StorageItemID),
			hexIdentifier(prepared.Genesis.RecordID):  hexIdentifier(prepared.GenesisEnvelope.StorageItemID),
		},
		ObjectStorageItemIDs:          map[string]string{},
		FeatureManifestStorageItemIDs: featureMappings,
		ArtifactStorageItemIDs:        map[string]string{},
		KeyEnvelopeStorageItemIDs: map[string]string{
			hexIdentifier(prepared.RecoveryKeyEnvelope.ID): hexIdentifier(prepared.RecoveryKeyEnvelope.Envelope.StorageItemID),
			hexIdentifier(prepared.ClientKeyEnvelope.ID):   hexIdentifier(prepared.ClientKeyEnvelope.Envelope.StorageItemID),
		},
		StorageItemKeyEpochIDs: map[string]string{
			hexIdentifier(prepared.BaselineEnvelope.StorageItemID):             hexIdentifier(prepared.KeyEpochID),
			hexIdentifier(prepared.GenesisEnvelope.StorageItemID):              hexIdentifier(prepared.KeyEpochID),
			hexIdentifier(prepared.RecoveryKeyEnvelope.Envelope.StorageItemID): hexIdentifier(prepared.KeyEpochID),
			hexIdentifier(prepared.ClientKeyEnvelope.Envelope.StorageItemID):   hexIdentifier(prepared.KeyEpochID),
		},
	}
	for _, feature := range prepared.FeatureManifests {
		canonicalState.StorageItemKeyEpochIDs[hexIdentifier(feature.Envelope.StorageItemID)] = hexIdentifier(prepared.KeyEpochID)
	}
	return canonicalState
}

func newReplicaFromPreparedCreation(prepared PreparedCanonicalVaultCreation) (*Replica, error) {
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		return nil, err
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		return nil, err
	}
	for _, feature := range prepared.FeatureManifests {
		if err := replica.AdmitFeatureManifest(feature.ID, feature.Bytes); err != nil {
			return nil, err
		}
	}
	return replica, nil
}

func (r *Runtime) openPersistedCompact(state *canonicalReplicaState, vaultID [32]byte, storageItemID string, encoded []byte) (awsmcrypto.OpenedCompactItem, error) {
	if state == nil {
		return awsmcrypto.OpenedCompactItem{}, errors.New("canonical Replica state is missing")
	}
	epochIDText, ok := state.StorageItemKeyEpochIDs[storageItemID]
	if !ok || !validDigest(epochIDText) {
		return awsmcrypto.OpenedCompactItem{}, fmt.Errorf("Storage Item %s has no valid Key Epoch binding", storageItemID)
	}
	epochID, err := decodeHexIdentifier(epochIDText)
	if err != nil {
		return awsmcrypto.OpenedCompactItem{}, err
	}
	encodedSecret, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(state.VaultID, epochIDText))
	if err != nil {
		return awsmcrypto.OpenedCompactItem{}, fmt.Errorf("read Key Epoch Trusted Secret: %w", err)
	}
	secret, err := decodeEpochSecret(encodedSecret, vaultID, epochID)
	if err != nil {
		return awsmcrypto.OpenedCompactItem{}, err
	}
	defer zeroBytes(secret.key)
	return awsmcrypto.OpenCompactItem(vaultID, epochID, secret.key, encoded)
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
	var clientSecret decodedClientSecret
	if state.AuthoringAvailable {
		clientSecretBytes, secretErr := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(state.VaultID, state.ClientCredentialID))
		if secretErr != nil {
			return nil, fmt.Errorf("read Client Credential Trusted Secret: %w", secretErr)
		}
		clientSecret, err = decodeClientSecret(clientSecretBytes, vaultID, memberID, clientCredentialID)
		if err != nil {
			return nil, err
		}
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
	openedBaseline, err := r.openPersistedCompact(state, vaultID, state.BaselineStorageItemID, baselineBytes)
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
	if baseline.VaultID != vaultID || baseline.GenerationID != generationID || hexIdentifier(baseline.RecordID) != state.BaselineID || hexIdentifier(baseline.RequiredFeatureSetID) != state.BaselineRequiredFeatureSetID {
		return nil, errors.New("Initial Baseline identity does not match persisted Replica state")
	}
	genesisBytes, err := readArtifact(state.GenesisStorageItemID)
	if err != nil {
		return nil, fmt.Errorf("read Genesis: %w", err)
	}
	openedGenesis, err := r.openPersistedCompact(state, vaultID, state.GenesisStorageItemID, genesisBytes)
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
	if genesis.VaultID != vaultID || (state.AdoptionEventID == "" && genesis.GenerationID != generationID) || hexIdentifier(genesis.RecordID) != state.GenesisID || hexIdentifier(genesis.RequiredFeatureSetID) != state.BaselineRequiredFeatureSetID {
		return nil, errors.New("Genesis identity does not match persisted Replica state")
	}
	clientEnvelopeBytes, err := readArtifact(state.ClientEnvelopeStorageID)
	if err != nil {
		return nil, fmt.Errorf("read Client Key Envelope: %w", err)
	}
	clientEnvelope, envelopeErr := storage.DecodeOpaqueEnvelope(clientEnvelopeBytes)
	if envelopeErr != nil || hexIdentifier(clientEnvelope.StorageItemID) != state.ClientEnvelopeStorageID {
		return nil, errors.New("Client Key Envelope storage identity does not match persisted Replica state")
	}
	if state.AuthoringAvailable {
		openedClient, openErr := awsmcrypto.OpenKeyEnvelope(awsmcrypto.ClientCredentialTarget, clientSecret.wrappingPrivateKey, clientEnvelopeBytes)
		if openErr != nil {
			return nil, fmt.Errorf("open Client Key Envelope: %w", openErr)
		}
		if hexIdentifier(openedClient.ID) != state.ClientEnvelopeID || openedClient.VaultID != vaultID || openedClient.KeyEpochID != epochID || openedClient.TargetCredentialID != clientCredentialID {
			return nil, errors.New("Client Key Envelope identity does not match persisted Replica state")
		}
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
	if state.RecordStorageItemIDs[state.BaselineID] != state.BaselineStorageItemID || state.RecordStorageItemIDs[state.GenesisID] != state.GenesisStorageItemID {
		return nil, errors.New("initial Record storage mappings do not match canonical Replica state")
	}
	if state.AdoptionEventID != "" {
		return r.openAdoptedCanonicalReplica(value, state, vaultID, generationID, epochSecret, baseline, genesis, readArtifact)
	}
	replica, err := NewReplica(baseline)
	if err != nil {
		return nil, err
	}
	genesisCredentialID, genesisSigningKey, err := genesisCredential(genesis)
	if err != nil || genesisCredentialID == (canonical.Identifier{}) || len(genesisSigningKey) != ed25519.PublicKeySize {
		return nil, errors.New("Genesis Client Credential certificate is invalid")
	}
	if err := replica.AdmitEvent(genesis, ed25519.PublicKey(genesisSigningKey)); err != nil {
		return nil, fmt.Errorf("admit persisted Genesis: %w", err)
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
		opened, err := r.openPersistedCompact(state, vaultID, storageItemID, encoded)
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
			if err := replica.AdmitKnownEvent(event); err != nil {
				return nil, fmt.Errorf("admit persisted Record %s: %w", recordID, err)
			}
			delete(additional, recordID)
			progress = true
		}
		if !progress {
			return nil, errors.New("persisted Record graph cannot reach its admitted parents")
		}
	}
	if err := validateReplicaKeyEpochHistory(replica, state); err != nil {
		return nil, fmt.Errorf("persisted Key Epoch Authority history is invalid: %w", err)
	}
	for objectID, storageItemID := range state.ObjectStorageItemIDs {
		encoded, err := readArtifact(storageItemID)
		if err != nil {
			return nil, fmt.Errorf("read persisted Object %s: %w", objectID, err)
		}
		opened, err := r.openPersistedCompact(state, vaultID, storageItemID, encoded)
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
	if err := r.admitPersistedFeatureManifests(replica, state, vaultID, state.FeatureManifestStorageItemIDs, readArtifact); err != nil {
		return nil, err
	}
	actual := replica.State()
	if !identifierSetEqual(actual.CausalFrontier, state.CausalFrontier) || !identifierSetEqual(actual.AuthorityFrontier, state.AuthorityFrontier) || !identifierSetEqual(actual.ContinuityRecordIDs, state.ContinuityRecordIDs) {
		return nil, errors.New("persisted Replica frontiers do not match authenticated records")
	}
	return replica, nil
}

func (r *Runtime) openAdoptedCanonicalReplica(value persistedVault, state *canonicalReplicaState, vaultID, generationID canonical.Identifier, epochSecret decodedEpochSecret, baseline canonical.Baseline, genesis canonical.Event, readArtifact func(string) ([]byte, error)) (*Replica, error) {
	predecessorGenerationID, err := decodeHexIdentifier(state.PredecessorGenerationID)
	if err != nil {
		return nil, errors.New("Vacuum predecessor Generation identity is invalid")
	}
	var predecessorBaselineID canonical.Identifier
	for _, dependency := range genesis.Dependencies {
		if dependency.Type == 2 {
			predecessorBaselineID = dependency.ID
			break
		}
	}
	if predecessorBaselineID == (canonical.Identifier{}) {
		return nil, errors.New("Genesis does not identify its predecessor Baseline")
	}
	predecessorStorageItemID, ok := state.RecordStorageItemIDs[hexIdentifier(predecessorBaselineID)]
	if !ok {
		return nil, errors.New("Vacuum predecessor Baseline storage mapping is missing")
	}
	predecessorBytes, err := readArtifact(predecessorStorageItemID)
	if err != nil {
		return nil, fmt.Errorf("read predecessor Baseline: %w", err)
	}
	openedPredecessor, err := r.openPersistedCompact(state, vaultID, predecessorStorageItemID, predecessorBytes)
	if err != nil || openedPredecessor.PayloadType != 1 {
		return nil, errors.New("predecessor Baseline envelope is invalid")
	}
	predecessorBaseline, err := canonical.DecodeBaseline(openedPredecessor.PayloadBytes)
	if err != nil || predecessorBaseline.RecordID != predecessorBaselineID || predecessorBaseline.GenerationID != predecessorGenerationID || predecessorBaseline.VaultID != vaultID {
		return nil, errors.New("predecessor Baseline identity is invalid")
	}
	oldReplica, err := NewReplica(predecessorBaseline)
	if err != nil {
		return nil, err
	}
	_, genesisSigningKey, err := genesisCredential(genesis)
	if err != nil {
		return nil, err
	}
	if err := oldReplica.AdmitEvent(genesis, ed25519.PublicKey(genesisSigningKey)); err != nil {
		return nil, fmt.Errorf("admit predecessor Genesis: %w", err)
	}
	oldEvents := make(map[string]canonical.Event)
	newEvents := make(map[string]canonical.Event)
	var adoption canonical.Event
	foundAdoption := false
	for recordID, storageItemID := range state.RecordStorageItemIDs {
		if recordID == state.BaselineID || recordID == state.GenesisID || recordID == hexIdentifier(predecessorBaselineID) {
			continue
		}
		encoded, err := readArtifact(storageItemID)
		if err != nil {
			return nil, fmt.Errorf("read persisted Record %s: %w", recordID, err)
		}
		opened, err := r.openPersistedCompact(state, vaultID, storageItemID, encoded)
		if err != nil || opened.PayloadType != 1 {
			return nil, errors.New("persisted Vacuum Record envelope is invalid")
		}
		event, err := canonical.DecodeEvent(opened.PayloadBytes)
		if err != nil || hexIdentifier(event.RecordID) != recordID || hexIdentifier(opened.Envelope.StorageItemID) != storageItemID {
			return nil, errors.New("persisted Vacuum Record identity is invalid")
		}
		if recordID == state.AdoptionEventID {
			adoption = event
			foundAdoption = true
			continue
		}
		if event.GenerationID == predecessorGenerationID {
			oldEvents[recordID] = event
		} else if event.GenerationID == generationID {
			newEvents[recordID] = event
		} else {
			return nil, errors.New("persisted Record belongs to an unknown Vacuum Generation")
		}
	}
	if !foundAdoption || adoption.Family != canonical.LifecycleFamily || adoption.Type != 1 {
		return nil, errors.New("Vacuum Adoption Event is missing or invalid")
	}
	for len(oldEvents) > 0 {
		progress := false
		for _, recordID := range sortedStringKeys(oldEvents) {
			event := oldEvents[recordID]
			if !replicaParentsAdmitted(oldReplica, event) {
				continue
			}
			if err := oldReplica.AdmitKnownEvent(event); err != nil {
				return nil, fmt.Errorf("admit predecessor Record %s: %w", recordID, err)
			}
			delete(oldEvents, recordID)
			progress = true
		}
		if !progress {
			return nil, errors.New("predecessor Vacuum graph cannot reach its admitted parents")
		}
	}
	if !replicaParentsAdmitted(oldReplica, adoption) {
		return nil, errors.New("Vacuum Adoption Event parents are not admitted")
	}
	replica, err := oldReplica.AdoptVacuum(baseline, adoption)
	if err != nil {
		return nil, err
	}
	for len(newEvents) > 0 {
		progress := false
		for _, recordID := range sortedStringKeys(newEvents) {
			event := newEvents[recordID]
			if !replicaParentsAdmitted(replica, event) {
				continue
			}
			if err := replica.AdmitKnownEvent(event); err != nil {
				return nil, fmt.Errorf("admit successor Record %s: %w", recordID, err)
			}
			delete(newEvents, recordID)
			progress = true
		}
		if !progress {
			return nil, errors.New("successor Vacuum graph cannot reach its admitted parents")
		}
	}
	for objectID, storageItemID := range state.ObjectStorageItemIDs {
		encoded, err := readArtifact(storageItemID)
		if err != nil {
			return nil, fmt.Errorf("read persisted Object %s: %w", objectID, err)
		}
		opened, err := r.openPersistedCompact(state, vaultID, storageItemID, encoded)
		if err != nil || opened.PayloadType != 2 {
			return nil, errors.New("persisted Object envelope is invalid")
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
	if err := r.admitPersistedFeatureManifests(replica, state, vaultID, state.FeatureManifestStorageItemIDs, readArtifact); err != nil {
		return nil, err
	}
	actual := replica.State()
	if !identifierSetEqual(actual.CausalFrontier, state.CausalFrontier) || !identifierSetEqual(actual.AuthorityFrontier, state.AuthorityFrontier) || !identifierSetEqual(actual.ContinuityRecordIDs, state.ContinuityRecordIDs) {
		return nil, errors.New("persisted adopted Replica frontiers do not match authenticated records")
	}
	return replica, nil
}

func (r *Runtime) admitPersistedFeatureManifests(replica *Replica, state *canonicalReplicaState, vaultID canonical.Identifier, mappings map[string]string, readArtifact func(string) ([]byte, error)) error {
	for manifestIDText, storageItemID := range mappings {
		encoded, err := readArtifact(storageItemID)
		if err != nil {
			return fmt.Errorf("read persisted Feature Manifest %s: %w", manifestIDText, err)
		}
		opened, err := r.openPersistedCompact(state, vaultID, storageItemID, encoded)
		if err != nil || opened.PayloadType != 3 {
			if err == nil {
				err = errors.New("persisted Feature Manifest payload type is invalid")
			}
			return fmt.Errorf("open persisted Feature Manifest %s: %w", manifestIDText, err)
		}
		manifestID, err := decodeHexIdentifier(manifestIDText)
		if err != nil {
			return err
		}
		derivedID, err := canonical.FeatureManifestID(opened.PayloadBytes)
		if err != nil || derivedID != manifestID {
			return fmt.Errorf("persisted Feature Manifest %s identity is invalid", manifestIDText)
		}
		if err := replica.AdmitFeatureManifest(manifestID, opened.PayloadBytes); err != nil {
			return fmt.Errorf("admit persisted Feature Manifest %s: %w", manifestIDText, err)
		}
		envelope, err := storage.DecodeOpaqueEnvelope(encoded)
		if err != nil || hexIdentifier(envelope.StorageItemID) != storageItemID {
			return fmt.Errorf("persisted Feature Manifest %s Storage Item identity changed", manifestIDText)
		}
	}
	return nil
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

func remoteSessionAccount(remoteID string) string {
	return "remote-session:" + remoteID
}

type persistedHostedSession struct {
	Username         string `json:"username"`
	SessionID        string `json:"sessionId"`
	AccessToken      string `json:"accessToken"`
	AccessExpiresAt  int64  `json:"accessExpiresAt"`
	RefreshToken     string `json:"refreshToken"`
	RefreshExpiresAt int64  `json:"refreshExpiresAt"`
}

func mustEncodeHostedSession(session hostedSession) []byte {
	encoded, err := json.Marshal(persistedHostedSession{Username: session.Username, SessionID: session.SessionID, AccessToken: session.AccessToken, AccessExpiresAt: session.AccessExpiresAt, RefreshToken: session.RefreshToken, RefreshExpiresAt: session.RefreshExpiresAt})
	if err != nil {
		panic(err)
	}
	return encoded
}

func decodeHostedSession(encoded []byte) (hostedSession, error) {
	var value persistedHostedSession
	if err := decode(encoded, &value); err != nil || value.Username == "" || value.SessionID == "" || value.AccessToken == "" || value.RefreshToken == "" {
		return hostedSession{}, errors.New("Hosted Replica session state is invalid")
	}
	return hostedSession{Username: value.Username, SessionID: value.SessionID, AccessToken: value.AccessToken, AccessExpiresAt: value.AccessExpiresAt, RefreshToken: value.RefreshToken, RefreshExpiresAt: value.RefreshExpiresAt}, nil
}

func hasHostedReplicaSyncCapabilities(capabilities []string) bool {
	needed := map[string]bool{"awsm.replica.inventory.read": false, "awsm.replica.item.read": false, "awsm.replica.item.write": false}
	for _, capability := range capabilities {
		if _, ok := needed[capability]; ok {
			needed[capability] = true
		}
	}
	for _, present := range needed {
		if !present {
			return false
		}
	}
	return true
}

func encodeClientSecret(prepared PreparedCanonicalVaultCreation) ([]byte, error) {
	return encodeClientCredentialSecret(prepared.IDs.VaultID, prepared.IDs.FirstMemberID, prepared.IDs.ClientCredentialID, prepared.ClientKeys)
}

func encodeClientCredentialSecret(vaultID, memberID, credentialID [32]byte, keys awsmcrypto.CredentialKeys) ([]byte, error) {
	return canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultID[:], 2: memberID[:], 3: credentialID[:],
		4: keys.SigningPublicKey, 5: keys.SigningSecretKey, 6: keys.WrappingPublicKey, 7: keys.WrappingPrivateKey,
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

func wipeCredentialKeys(keys *awsmcrypto.CredentialKeys) {
	if keys == nil {
		return
	}
	for _, value := range [][]byte{
		keys.SigningSeed, keys.SigningPublicKey, keys.SigningSecretKey,
		keys.WrappingPrivateKey, keys.WrappingPublicKey,
	} {
		zeroBytes(value)
	}
}

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func identifiersToValues(values []canonical.Identifier) []canonical.Value {
	result := make([]canonical.Value, len(values))
	for index, value := range values {
		result[index] = append([]byte(nil), value[:]...)
	}
	return result
}

func cloneExtensions(value map[string][]byte) map[string][]byte {
	if value == nil {
		return map[string][]byte{}
	}
	result := make(map[string][]byte, len(value))
	for key, bytesValue := range value {
		result[key] = append([]byte(nil), bytesValue...)
	}
	return result
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
