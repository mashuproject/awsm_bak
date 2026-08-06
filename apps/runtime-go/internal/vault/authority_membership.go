package vault

import (
	"context"
	"crypto/ed25519"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// endMembership authors the canonical Authority-family type-2 Membership End
// Event. A member may resign its own membership; an unambiguous Administrator
// may end another active member. The Event never erases prior access.
func (r *Runtime) endMembership(ctx context.Context, id, targetIDText string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot end membership.")
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
	targetMemberID, err := decodeHexIdentifier(targetIDText)
	if err != nil {
		return nil, commandError("MEMBER_INVALID", "The target Member identity is invalid.")
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
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the Required Feature conflict before ending membership.")
	}
	signerMember, signerActive := authority.activeClientMember(credentialID)
	if !signerActive || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	if _, targetActive := authority.activeMembers[targetMemberID]; !targetActive {
		return nil, commandError("MEMBER_INVALID", "The target Member is not active.")
	}
	if targetMemberID != signerMember {
		if _, administrator := authority.administrators[signerMember]; !administrator || len(authority.administratorConflicts[signerMember]) > 0 {
			return nil, commandError("ADMINISTRATOR_REQUIRED", "Only an unambiguous Administrator can end another member.")
		}
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
		AuthorityParentIDs: replicaState.AuthorityFrontier, Dependencies: nil,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily,
		Type: 2, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(),
		Body: canonical.Map{0: targetMemberID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Membership End Event could not be authored.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key,
		PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Membership End Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Membership End envelope is invalid.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Membership End Event could not be stored.")
	}
	cleanup := func() { deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID) }
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		cleanup()
		return nil, commandError("VAULT_EVENT_INVALID", "The Membership End Event could not be admitted.")
	}
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	storageItemID := hexIdentifier(envelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
	bindStorageItemKeyEpoch(value.Canonical, storageItemID, epochID)
	nextAuthority, err := nextReplica.AuthorityState()
	if err != nil {
		cleanup()
		r.restoreLocked(before)
		return nil, commandError("VAULT_EVENT_INVALID", "The Membership End Authority State could not be derived.")
	}
	if nextAuthority.Lifecycle == "Closed" {
		value.Lifecycle = "Closed"
	}
	nextReplay, err := replayReplicaAuthorityState(nextReplica, nil, nil)
	if err != nil {
		cleanup()
		r.restoreLocked(before)
		return nil, commandError("VAULT_EVENT_INVALID", "The Membership End Authority State could not be replayed.")
	}
	if _, active := nextReplay.activeClientMember(credentialID); !active {
		value.Canonical.AuthoringAvailable = false
	}
	// A derived Closed state blocks every subsequent authoring operation, even
	// when this particular Credential was not the target of the Event.
	if value.Lifecycle == "Closed" {
		value.Canonical.AuthoringAvailable = false
	}
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
	return map[string]string{"targetMemberId": hexIdentifier(targetMemberID), "eventRecordId": hexIdentifier(event.RecordID)}, nil
}
