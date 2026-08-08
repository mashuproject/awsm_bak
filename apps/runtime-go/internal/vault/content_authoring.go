package vault

import (
	"context"
	"crypto/ed25519"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// revertCollectionMerge authors the canonical Content type-9 Event. The
// target is checked against the authenticated Replica before signing so a
// stale or unrelated Record cannot be turned into a redirect mutation.
func (r *Runtime) revertCollectionMerge(ctx context.Context, id, causeText string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot author Collection changes.")
	}
	if value.Canonical == nil || !value.Canonical.AuthoringAvailable || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated authoring Client Credential is unavailable.")
	}
	vaultID, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	causeID, err := decodeHexIdentifier(causeText)
	if err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The redirect Cause identity is invalid.")
	}
	cause, ok := r.replicas[id].Record(causeID)
	if !ok || cause.Event == nil || cause.Event.VaultID != vaultID || cause.Event.Family != canonical.ContentFamily || (cause.Event.Type != 8 && cause.Event.Type != 10) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The redirect Cause is not reversible.")
	}
	for _, event := range r.replicas[id].Events() {
		if event.Family != canonical.ContentFamily || event.Type != 9 {
			continue
		}
		if target, targetOK := replicaIdentifier(event.Body, 0); targetOK && target == causeID {
			return nil, commandError("CONTENT_COMMAND_INVALID", "The Collection redirect is already reverted.")
		}
	}
	if err := validateContentEvent(*cause.Event); err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The redirect Cause is invalid.")
	}

	memberID, err := decodeHexIdentifier(value.Canonical.MemberID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Member identity is invalid.")
	}
	credentialID, err := decodeHexIdentifier(value.Canonical.ClientCredentialID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential identity is invalid.")
	}
	clientBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(id, value.Canonical.ClientCredentialID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential could not be opened.")
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultID, memberID, credentialID)
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Client Credential is invalid.")
	}
	defer zeroBytes(clientSecret.signingSecretKey)
	authority, err := replayReplicaAuthorityState(r.replicas[id], nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	if authority.featureSetConflict {
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the Required Feature conflict before authoring Collection changes.")
	}
	if signerMember, active := authority.activeClientMember(credentialID); !active || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Key Epoch identity is invalid.")
	}
	epochBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, value.Canonical.KeyEpochID))
	if err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The current Key Epoch could not be opened.")
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultID, epochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Key Epoch is invalid.")
	}
	defer zeroBytes(epochSecret.key)
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	frontier := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID,
		ParentRecordIDs: frontier.CausalFrontier, AuthorityParentIDs: frontier.AuthorityFrontier,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 9,
		SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(), Body: canonical.Map{0: causeID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Collection Merge Reverted Event could not be authored.")
	}
	if err := validateContentEvent(event); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Collection Merge Reverted Event is invalid.")
	}
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Collection Merge Reverted Event could not be admitted.")
	}
	if _, err := ProjectLibraryProjection(nextReplica); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Collection Merge Reverted Event could not be projected.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Collection Merge Reverted Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Collection Merge Reverted envelope is invalid.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Collection Merge Reverted Event could not be stored.")
	}
	cleanup := func() { deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID) }
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, epochID)
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
	return map[string]string{"eventRecordId": hexIdentifier(event.RecordID)}, nil
}
