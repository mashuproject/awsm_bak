package vault

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// deliverKeyEnvelope authors the canonical Authority-family type-13 Event for
// one eligible target and one already established Key Epoch. The Event carries
// only the new envelope slot; the envelope bytes remain a separate opaque
// dependency so a Replica can deliver it independently from the Event.
func (r *Runtime) deliverKeyEnvelope(ctx context.Context, id, epochIDText string, targetKind uint64, targetIDText string, targetRevision *uint64) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot deliver a Key Envelope.")
	}
	if value.Canonical == nil || !value.Canonical.AuthoringAvailable || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated authoring Client Credential is unavailable.")
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
	secretBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(id, value.Canonical.ClientCredentialID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be opened.")
	}
	clientSecret, err := decodeClientSecret(secretBytes, vaultID, memberID, credentialID)
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential is invalid.")
	}
	defer zeroBytes(clientSecret.signingSecretKey)
	defer zeroBytes(clientSecret.wrappingPrivateKey)
	authority, err := replayReplicaAuthorityState(r.replicas[id], nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	if authority.featureSetConflict {
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the Required Feature conflict before delivering a Key Envelope.")
	}
	if _, active := authority.activeClientMember(credentialID); !active {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	epochID, err := decodeHexIdentifier(epochIDText)
	if err != nil {
		return nil, commandError("KEY_EPOCH_INVALID", "The target Key Epoch identity is invalid.")
	}
	if _, established := authority.epochs[epochID]; !established {
		return nil, commandError("KEY_EPOCH_INVALID", "The target Key Epoch is not established by authenticated Authority history.")
	}
	targetID, err := decodeHexIdentifier(targetIDText)
	if err != nil {
		return nil, commandError("KEY_ENVELOPE_INVALID", "The target Credential identity is invalid.")
	}
	var wrappingPublicKey []byte
	switch targetKind {
	case awsmcrypto.ClientCredentialTarget:
		if targetRevision != nil {
			return nil, commandError("KEY_ENVELOPE_INVALID", "A Client Key Envelope target cannot have a revision.")
		}
		if _, active := authority.activeClientMember(targetID); !active {
			return nil, commandError("KEY_ENVELOPE_INVALID", "The target Client Credential is not active.")
		}
		descriptor, ok := authority.clientCertificates[targetID]
		if !ok || len(descriptor.wrappingKey) != 32 {
			return nil, commandError("AUTHORITY_UNAVAILABLE", "The target Client Credential wrapping key is unavailable.")
		}
		wrappingPublicKey = descriptor.wrappingKey
	case awsmcrypto.RecoveryCredentialTarget:
		if targetRevision == nil {
			return nil, commandError("KEY_ENVELOPE_INVALID", "A Recovery Key Envelope target requires a revision.")
		}
		revision, active := authority.recoveryTargets[targetID]
		if !active || revision != *targetRevision {
			return nil, commandError("KEY_ENVELOPE_INVALID", "The target Recovery Credential is not effective.")
		}
		descriptor, ok := authority.recoveryCredentials[targetID]
		if !ok || len(descriptor.wrappingKey) != 32 {
			return nil, commandError("AUTHORITY_UNAVAILABLE", "The target Recovery Credential wrapping key is unavailable.")
		}
		wrappingPublicKey = descriptor.wrappingKey
	default:
		return nil, commandError("KEY_ENVELOPE_INVALID", "The target Credential kind is invalid.")
	}
	for _, slot := range authority.epochSlots[epochID] {
		if slot.targetKind != targetKind || slot.targetID != targetID || !sameOptionalUint64(slot.targetRevision, targetRevision) {
			continue
		}
		storageID, ok := value.Canonical.KeyEnvelopeStorageItemIDs[hexIdentifier(slot.envelopeID)]
		if !ok || storageID == "" {
			continue
		}
		reader, openErr := r.deps.Artifacts.Open(storageID)
		if openErr == nil {
			_ = reader.Close()
			return nil, commandError("KEY_ENVELOPE_ALREADY_AVAILABLE", "The target Key Envelope is already materialized.")
		}
	}
	targetEpochBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, epochIDText))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The target Key Epoch could not be opened.")
	}
	targetEpoch, err := decodeEpochSecret(targetEpochBytes, vaultID, epochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The target Key Epoch is invalid.")
	}
	defer zeroBytes(targetEpoch.key)
	envelope, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: targetEpoch.key,
		TargetKind: targetKind, TargetCredentialID: targetID,
		TargetRevision: targetRevision, RecipientWrappingPublicKey: wrappingPublicKey,
	})
	if err != nil {
		return nil, commandError("KEY_ENVELOPE_INVALID", "The Key Envelope could not be created.")
	}
	currentEpochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Key Epoch identity is invalid.")
	}
	currentEpochBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, value.Canonical.KeyEpochID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The current Key Epoch could not be opened.")
	}
	currentEpoch, err := decodeEpochSecret(currentEpochBytes, vaultID, currentEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Key Epoch is invalid.")
	}
	defer zeroBytes(currentEpoch.key)
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	slot := canonical.Map{0: epochID[:], 1: targetKind, 2: targetID[:], 3: optionalEpochRevisionValue(targetRevision), 4: envelope.ID[:]}
	replicaState := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: replicaState.CausalFrontier,
		AuthorityParentIDs: replicaState.AuthorityFrontier, Dependencies: []canonical.Dependency{{Type: 7, ID: envelope.ID}},
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily,
		Type: 13, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(),
		Body: canonical.Map{0: canonicalSetValues([]canonical.Value{slot})},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Delivery Event could not be authored.")
	}
	encodedEvent, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: currentEpochID, KeyEpochKey: currentEpoch.key,
		PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Delivery Event could not be protected.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(encodedEvent)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Delivery envelope is invalid.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.Envelope.StorageItemID, envelope.Envelope.Bytes); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Key Envelope could not be stored.")
	}
	cleanup := func() {
		deleteOpaqueCreationItem(r.deps.Artifacts, envelope.Envelope.StorageItemID)
		deleteOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID)
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, encodedEvent); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Key Delivery Event could not be stored.")
	}
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		cleanup()
		return nil, commandError("VAULT_EVENT_INVALID", fmt.Sprintf("The Key Delivery Event could not be admitted: %v", err))
	}
	if value.Canonical.KeyEnvelopeStorageItemIDs == nil {
		value.Canonical.KeyEnvelopeStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	// Replace any stale local materialization for this logical target/epoch.
	// The authenticated slot remains part of the Event history; only the local
	// opaque mapping is refreshed by this delivery.
	for _, slot := range authority.epochSlots[epochID] {
		if slot.targetKind != targetKind || slot.targetID != targetID || !sameOptionalUint64(slot.targetRevision, targetRevision) {
			continue
		}
		oldEnvelopeID := hexIdentifier(slot.envelopeID)
		oldStorageID := value.Canonical.KeyEnvelopeStorageItemIDs[oldEnvelopeID]
		delete(value.Canonical.KeyEnvelopeStorageItemIDs, oldEnvelopeID)
		if oldStorageID != "" {
			delete(value.Canonical.StorageItemKeyEpochIDs, oldStorageID)
		}
	}
	envelopeStorageID := hexIdentifier(envelope.Envelope.StorageItemID)
	envelopeID := hexIdentifier(envelope.ID)
	if oldStorageID := value.Canonical.KeyEnvelopeStorageItemIDs[envelopeID]; oldStorageID != "" && oldStorageID != envelopeStorageID {
		delete(value.Canonical.StorageItemKeyEpochIDs, oldStorageID)
	}
	value.Canonical.KeyEnvelopeStorageItemIDs[envelopeID] = envelopeStorageID
	bindStorageItemKeyEpoch(value.Canonical, envelopeStorageID, epochID)
	if targetKind == awsmcrypto.ClientCredentialTarget && targetID == credentialID {
		value.Canonical.ClientEnvelopeID = envelopeID
		value.Canonical.ClientEnvelopeStorageID = envelopeStorageID
	}
	localRecoveryID, recoveryErr := decodeHexIdentifier(value.Canonical.RecoveryCredentialID)
	if recoveryErr == nil && targetKind == awsmcrypto.RecoveryCredentialTarget && targetID == localRecoveryID {
		value.Canonical.RecoveryEnvelopeID = envelopeID
		value.Canonical.RecoveryEnvelopeStorageID = envelopeStorageID
	}
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	eventStorageID := hexIdentifier(eventEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = eventStorageID
	bindStorageItemKeyEpoch(value.Canonical, eventStorageID, currentEpochID)
	nextState := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(nextState.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(nextState.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(nextState.ContinuityRecordIDs)
	r.replicas[id] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		cleanup()
		return nil, err
	}
	r.signal()
	return map[string]string{
		"keyEpochId": hexIdentifier(epochID), "targetCredentialId": hexIdentifier(targetID),
		"envelopeId": envelopeID, "eventRecordId": hexIdentifier(event.RecordID),
	}, nil
}
