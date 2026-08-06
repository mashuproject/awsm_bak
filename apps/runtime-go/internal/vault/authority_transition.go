package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

type keyEpochTransitionEnvelope struct {
	slot     keyEpochEnvelopeSlot
	envelope awsmcrypto.KeyEnvelope
}

// rotateKeyEpoch authors the canonical Authority-family type-12 transition for
// the current unambiguous Administrator. The fresh Epoch key is retained only
// in the local trusted store and in recipient Key Envelopes; the Event carries
// the identity and exact target-slot set, never the key itself.
func (r *Runtime) rotateKeyEpoch(ctx context.Context, id string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot rotate its Key Epoch.")
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
	credentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential identity is invalid.")
	}
	clientSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(id, value.Canonical.ClientCredentialID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be opened.")
	}
	clientSecret, err := decodeClientSecret(clientSecretBytes, vaultID, memberID, credentialID)
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential is invalid.")
	}
	authority, err := replayReplicaAuthorityState(r.replicas[id], nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	if authority.featureSetConflict || len(authority.administratorConflicts) > 0 || len(authority.keyEpochConflicts) > 0 || len(authority.recoveryConflicts) > 0 || len(authority.invitationConflicts) > 0 {
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the visible Authority conflicts before rotating the Key Epoch.")
	}
	signerMember, ok := authority.activeClientMember(credentialID)
	if !ok || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	if _, ok := authority.administrators[signerMember]; !ok {
		return nil, commandError("ADMINISTRATOR_REQUIRED", "Only an Administrator can rotate the Key Epoch.")
	}
	parentEpochIDs := sortedIdentifierKeys(authority.heads)
	if len(parentEpochIDs) != 1 {
		return nil, commandError("KEY_EPOCH_CONFLICT", "Resolve the current Key Epoch conflict before rotating.")
	}
	parentEpochID := parentEpochIDs[0]
	parentEpochSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, hexIdentifier(parentEpochID)))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The current Key Epoch could not be opened.")
	}
	parentEpochSecret, err := decodeEpochSecret(parentEpochSecretBytes, vaultID, parentEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Key Epoch is invalid.")
	}
	defer zeroBytes(parentEpochSecret.key)
	newKey := make([]byte, 32)
	if _, err := cryptorand.Read(newKey); err != nil {
		return nil, fmt.Errorf("generate Key Epoch key: %w", err)
	}
	defer zeroBytes(newKey)
	newEpochID, err := awsmcrypto.KeyEpochID(vaultID, newKey)
	if err != nil {
		return nil, commandError("KEY_EPOCH_INVALID", "The new Key Epoch could not be identified.")
	}
	maximum := uint64(0)
	for _, epochID := range parentEpochIDs {
		if display := authority.epochs[epochID]; display > maximum {
			maximum = display
		}
	}
	displayNumber := maximum + 1
	targets := make([]keyEpochTransitionEnvelope, 0, len(authority.recoveryTargets)+len(authority.clientTargets))
	for _, targetID := range sortedIdentifierKeys(authority.recoveryTargets) {
		descriptor, ok := authority.recoveryCredentials[targetID]
		if !ok || len(descriptor.wrappingKey) == 0 {
			return nil, commandError("AUTHORITY_UNAVAILABLE", "A Recovery Credential target is missing its wrapping key.")
		}
		revision := authority.recoveryTargets[targetID]
		envelope, sealErr := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
			VaultID: vaultID, KeyEpochID: newEpochID, KeyEpochKey: newKey,
			TargetKind: awsmcrypto.RecoveryCredentialTarget, TargetCredentialID: targetID,
			TargetRevision: &revision, RecipientWrappingPublicKey: descriptor.wrappingKey,
		})
		if sealErr != nil {
			return nil, commandError("KEY_EPOCH_INVALID", "A Recovery Key Envelope could not be created.")
		}
		targets = append(targets, keyEpochTransitionEnvelope{slot: keyEpochEnvelopeSlot{
			epochID: newEpochID, targetKind: awsmcrypto.RecoveryCredentialTarget, targetID: targetID,
			targetRevision: &revision, envelopeID: envelope.ID,
		}, envelope: envelope})
	}
	for _, targetID := range sortedIdentifierKeys(authority.clientTargets) {
		descriptor, ok := authority.clientCertificates[targetID]
		if !ok || len(descriptor.wrappingKey) == 0 {
			return nil, commandError("AUTHORITY_UNAVAILABLE", "A Client Credential target is missing its wrapping key.")
		}
		envelope, sealErr := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
			VaultID: vaultID, KeyEpochID: newEpochID, KeyEpochKey: newKey,
			TargetKind: awsmcrypto.ClientCredentialTarget, TargetCredentialID: targetID,
			RecipientWrappingPublicKey: descriptor.wrappingKey,
		})
		if sealErr != nil {
			return nil, commandError("KEY_EPOCH_INVALID", "A Client Key Envelope could not be created.")
		}
		targets = append(targets, keyEpochTransitionEnvelope{slot: keyEpochEnvelopeSlot{
			epochID: newEpochID, targetKind: awsmcrypto.ClientCredentialTarget, targetID: targetID,
			envelopeID: envelope.ID,
		}, envelope: envelope})
	}
	if len(targets) == 0 {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "The Vault has no eligible Key Epoch targets.")
	}
	sort.Slice(targets, func(left, right int) bool {
		leftValue := canonical.Map{0: targets[left].slot.epochID[:], 1: targets[left].slot.targetKind, 2: targets[left].slot.targetID[:], 3: optionalEpochRevisionValue(targets[left].slot.targetRevision), 4: targets[left].slot.envelopeID[:]}
		rightValue := canonical.Map{0: targets[right].slot.epochID[:], 1: targets[right].slot.targetKind, 2: targets[right].slot.targetID[:], 3: optionalEpochRevisionValue(targets[right].slot.targetRevision), 4: targets[right].slot.envelopeID[:]}
		leftBytes, _ := canonical.EncodeValue(leftValue)
		rightBytes, _ := canonical.EncodeValue(rightValue)
		return bytes.Compare(leftBytes, rightBytes) < 0
	})
	slots := make([]canonical.Value, 0, len(targets))
	dependencies := make([]canonical.Dependency, 0, len(targets))
	for _, target := range targets {
		slots = append(slots, canonical.Map{0: target.slot.epochID[:], 1: target.slot.targetKind, 2: target.slot.targetID[:], 3: optionalEpochRevisionValue(target.slot.targetRevision), 4: target.slot.envelopeID[:]})
		dependencies = append(dependencies, canonical.Dependency{Type: 7, ID: target.slot.envelopeID})
	}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	replicaState := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: replicaState.CausalFrontier,
		AuthorityParentIDs: replicaState.AuthorityFrontier, Dependencies: dependencies,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily,
		Type: 12, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(),
		Body: canonical.Map{0: canonicalSetValues(identifiersToValues(parentEpochIDs)), 1: newEpochID[:], 2: displayNumber, 3: canonicalSetValues(slots)},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Epoch Transition Event could not be authored.")
	}
	encodedEvent, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: parentEpochID, KeyEpochKey: parentEpochSecret.key,
		PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Epoch Transition Event could not be protected.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(encodedEvent)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Epoch Transition envelope is invalid.")
	}
	newEpochSecret, err := encodeRuntimeEpochSecret(vaultID, newEpochID, displayNumber, newKey)
	if err != nil {
		return nil, commandError("KEY_EPOCH_INVALID", "The new Key Epoch secret could not be encoded.")
	}
	if err := r.deps.Secrets.Put(trustedSecretService, epochSecretAccount(id, hexIdentifier(newEpochID)), newEpochSecret); err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The new Key Epoch could not be stored.")
	}
	stored := make([][32]byte, 0, len(targets)+1)
	cleanup := func() {
		for _, storageID := range stored {
			deleteOpaqueCreationItem(r.deps.Artifacts, storageID)
		}
		_ = r.deps.Secrets.Delete(trustedSecretService, epochSecretAccount(id, hexIdentifier(newEpochID)))
	}
	for _, target := range targets {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, target.envelope.Envelope.StorageItemID, target.envelope.Envelope.Bytes); err != nil {
			cleanup()
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "A Key Epoch Envelope could not be stored.")
		}
		stored = append(stored, target.envelope.Envelope.StorageItemID)
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, encodedEvent); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Key Epoch Transition Event could not be stored.")
	}
	stored = append(stored, eventEnvelope.StorageItemID)
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		cleanup()
		return nil, commandError("VAULT_EVENT_INVALID", "The Key Epoch Transition Event could not be admitted.")
	}
	if value.Canonical.KeyEnvelopeStorageItemIDs == nil {
		value.Canonical.KeyEnvelopeStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	var clientEnvelope awsmcrypto.KeyEnvelope
	var recoveryEnvelope awsmcrypto.KeyEnvelope
	localRecoveryID, err := decodeHexIdentifier(value.Canonical.RecoveryCredentialID)
	if err != nil {
		cleanup()
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Recovery Credential identity is invalid.")
	}
	for _, target := range targets {
		storageID := hexIdentifier(target.envelope.Envelope.StorageItemID)
		envelopeID := hexIdentifier(target.envelope.ID)
		value.Canonical.KeyEnvelopeStorageItemIDs[envelopeID] = storageID
		bindStorageItemKeyEpoch(value.Canonical, storageID, newEpochID)
		if target.slot.targetKind == awsmcrypto.ClientCredentialTarget && target.slot.targetID == credentialID {
			clientEnvelope = target.envelope
		}
		if target.slot.targetKind == awsmcrypto.RecoveryCredentialTarget && target.slot.targetID == localRecoveryID {
			recoveryEnvelope = target.envelope
		}
	}
	if clientEnvelope.ID == (canonical.Identifier{}) || recoveryEnvelope.ID == (canonical.Identifier{}) {
		cleanup()
		r.restoreLocked(before)
		return nil, commandError("AUTHORITY_UNAVAILABLE", "The local Client and Recovery targets are not both eligible.")
	}
	eventStorageID := hexIdentifier(eventEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = eventStorageID
	bindStorageItemKeyEpoch(value.Canonical, eventStorageID, parentEpochID)
	value.Canonical.KeyEpochID = hexIdentifier(newEpochID)
	value.Canonical.ClientEnvelopeID = hexIdentifier(clientEnvelope.ID)
	value.Canonical.ClientEnvelopeStorageID = hexIdentifier(clientEnvelope.Envelope.StorageItemID)
	value.Canonical.RecoveryEnvelopeID = hexIdentifier(recoveryEnvelope.ID)
	value.Canonical.RecoveryEnvelopeStorageID = hexIdentifier(recoveryEnvelope.Envelope.StorageItemID)
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
	return map[string]any{"keyEpochId": hexIdentifier(newEpochID), "displayNumber": displayNumber, "eventRecordId": hexIdentifier(event.RecordID)}, nil
}

func optionalEpochRevisionValue(value *uint64) canonical.Value {
	if value == nil {
		return nil
	}
	return *value
}

func encodeRuntimeEpochSecret(vaultID, epochID canonical.Identifier, displayNumber uint64, key []byte) ([]byte, error) {
	if len(key) != 32 {
		return nil, errors.New("Key Epoch key must contain 32 bytes")
	}
	return canonical.EncodeValue(canonical.Map{0: uint64(1), 1: vaultID[:], 2: epochID[:], 3: displayNumber, 4: append([]byte(nil), key...)})
}
