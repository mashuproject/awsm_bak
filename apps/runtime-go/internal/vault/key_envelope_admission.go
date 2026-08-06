package vault

import (
	"context"

	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// AdmitOpaqueKeyEnvelope is the recipient-verification boundary for a raw
// Key Envelope carried by a Hosted Replica. A Key Envelope is an opaque
// Compact-storage envelope, but it is not a Compact payload and cannot be
// opened with a Key Epoch key. Promotion therefore requires the local Client
// Credential wrapping key plus the authenticated Authority slot whose exact
// logical Envelope ID is being admitted.
func (r *Runtime) AdmitOpaqueKeyEnvelope(ctx context.Context, vaultID string, encoded []byte) error {
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
		return commandError("KEY_ENVELOPE_INVALID", "The Vault identity is invalid.")
	}
	clientCredentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		return commandError("KEY_ENVELOPE_INVALID", "The local Client Credential identity is invalid.")
	}
	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		return commandError("KEY_ENVELOPE_INVALID", "The local Member identity is invalid.")
	}
	secretBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		return commandError("KEY_ENVELOPE_UNAVAILABLE", "The local Client Credential wrapping key is unavailable.")
	}
	clientSecret, err := decodeClientSecret(secretBytes, vaultIdentifier, memberID, clientCredentialID)
	if err != nil {
		return commandError("KEY_ENVELOPE_INVALID", "The local Client Credential is invalid.")
	}
	defer zeroBytes(clientSecret.wrappingPrivateKey)
	opened, err := awsmcrypto.OpenKeyEnvelope(awsmcrypto.ClientCredentialTarget, clientSecret.wrappingPrivateKey, encoded)
	if err != nil || opened.VaultID != vaultIdentifier || opened.TargetCredentialID != clientCredentialID || opened.TargetRevision != nil {
		return commandError("KEY_ENVELOPE_INVALID", "The opaque Key Envelope cannot be verified for this Client Credential.")
	}
	authority, err := replayReplicaAuthorityState(r.replicas[vaultID], nil, nil)
	if err != nil {
		return commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	if _, active := authority.activeClientMember(clientCredentialID); !active {
		return commandError("KEY_ENVELOPE_UNAVAILABLE", "The local Client Credential is not an active Vault target.")
	}
	knownSlot := false
	for _, slot := range authority.epochSlots[opened.KeyEpochID] {
		if slot.targetKind == awsmcrypto.ClientCredentialTarget && slot.targetID == clientCredentialID && slot.targetRevision == nil && slot.envelopeID == opened.ID {
			knownSlot = true
			break
		}
	}
	if !knownSlot {
		return commandError("KEY_ENVELOPE_UNAVAILABLE", "The Key Envelope is not named by an authenticated Authority slot.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil || envelope.StorageClass != storage.CompactStorageClass {
		return commandError("KEY_ENVELOPE_INVALID", "The opaque Key Envelope outer representation is invalid.")
	}
	logicalID := hexIdentifier(opened.ID)
	storageItemID := hexIdentifier(envelope.StorageItemID)
	previousStorageItemID := value.Canonical.KeyEnvelopeStorageItemIDs[logicalID]
	before := r.snapshotLocked()
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return commandError("VAULT_CREATION_STORAGE_FAILED", "The opaque Key Envelope could not be stored.")
	}
	if value.Canonical.KeyEnvelopeStorageItemIDs == nil {
		value.Canonical.KeyEnvelopeStorageItemIDs = map[string]string{}
	}
	value.Canonical.KeyEnvelopeStorageItemIDs[logicalID] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, opened.KeyEpochID)
	if value.Canonical.ClientEnvelopeID == logicalID {
		value.Canonical.ClientEnvelopeStorageID = storageItemID
	}
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		if previousStorageItemID != storageItemID {
			deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID)
		}
		return err
	}
	r.signal()
	return nil
}
