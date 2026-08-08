package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"sort"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// acceptInvitation authors the canonical type-6 Invitation Acceptance Event
// from the exact Join Request, Acceptance Proposal, and Consumed Receipt
// produced by the external invitation ceremony. The Runtime is the servicing
// authenticated Client: it signs the Event, while the proposed Member and
// Credentials remain the identities carried by the proposal.
func (r *Runtime) acceptInvitation(ctx context.Context, id, encodedJoin, encodedProposal, encodedReceipt string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot record Invitation acceptance.")
	}
	if value.Canonical == nil || !value.Canonical.AuthoringAvailable || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated authoring Client Credential is unavailable.")
	}

	decode := func(encoded, label string) (canonical.Value, error) {
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(encoded)
		if decodeErr != nil {
			return nil, commandError("INVITATION_INVALID", label+" is not valid base64url.")
		}
		value, decodeErr := canonical.DecodeValue(decoded)
		if decodeErr != nil {
			return nil, commandError("INVITATION_INVALID", label+" is not canonical.")
		}
		return value, nil
	}
	join, err := decode(encodedJoin, "The Invitation Join Request")
	if err != nil {
		return nil, err
	}
	proposal, err := decode(encodedProposal, "The Invitation Acceptance Proposal")
	if err != nil {
		return nil, err
	}
	receipt, err := decode(encodedReceipt, "The Consumed Invitation receipt")
	if err != nil {
		return nil, err
	}
	body := canonical.Map{0: join, 1: proposal, 2: receipt}
	parsed, err := parseInvitationAcceptance(canonical.Event{EventInput: canonical.EventInput{Body: body}})
	if err != nil {
		return nil, commandError("INVITATION_INVALID", "The Invitation Acceptance payload is invalid.")
	}

	state := r.replicas[id].State()
	if !identifierSetEqual(parsed.proposalAuthorityIDs, identifiersToHex(state.AuthorityFrontier)) {
		return nil, commandError("INVITATION_INVALID", "The Acceptance Proposal Authority Parents are not current.")
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
	signerMember, active := authority.activeClientMember(credentialID)
	if !active || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	if _, active := authority.activeMembers[parsed.memberID]; active {
		return nil, commandError("INVITATION_INVALID", "The Invitation Acceptance reuses an active Member identity.")
	}
	epochID, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Key Epoch identity is invalid.")
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
	dependencies := make([]canonical.Dependency, 0, len(parsed.envelopeSlots))
	preparedEnvelopes := make([]awsmcrypto.KeyEnvelope, 0, len(parsed.envelopeSlots))
	defer func() {
		for index := range preparedEnvelopes {
			zeroBytes(preparedEnvelopes[index].KeyEpochKey)
		}
	}()
	for _, slot := range parsed.envelopeSlots {
		if _, knownEpoch := authority.epochs[slot.epochID]; !knownEpoch {
			return nil, commandError("INVITATION_KEY_UNAVAILABLE", "An Invitation Acceptance Key Epoch is not authenticated locally.")
		}
		encodedEpoch, getErr := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, hexIdentifier(slot.epochID)))
		if getErr != nil {
			return nil, commandError("INVITATION_KEY_UNAVAILABLE", "An Invitation Acceptance Key Epoch is unavailable locally.")
		}
		slotEpoch, decodeErr := decodeEpochSecret(encodedEpoch, vaultID, slot.epochID)
		if decodeErr != nil {
			return nil, commandError("INVITATION_KEY_UNAVAILABLE", "An Invitation Acceptance Key Epoch is invalid.")
		}
		var recipient []byte
		var targetRevision *uint64
		if slot.targetKind == awsmcrypto.ClientCredentialTarget && slot.targetID == parsed.clientCredentialID {
			recipient = parsed.clientWrappingKey
		} else if slot.targetKind == awsmcrypto.RecoveryCredentialTarget && slot.targetID == parsed.recoveryCredentialID {
			recipient = parsed.recoveryWrappingKey
			targetRevision = slot.targetRevision
		} else {
			zeroBytes(slotEpoch.key)
			return nil, commandError("INVITATION_INVALID", "An Invitation Acceptance Envelope slot targets an unexpected Credential.")
		}
		prepared, sealErr := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
			VaultID: vaultID, KeyEpochID: slot.epochID, KeyEpochKey: slotEpoch.key,
			TargetKind: slot.targetKind, TargetCredentialID: slot.targetID, TargetRevision: targetRevision,
			RecipientWrappingPublicKey: recipient,
		})
		zeroBytes(slotEpoch.key)
		if sealErr != nil || prepared.ID != slot.envelopeID {
			return nil, commandError("INVITATION_INVALID", "An Invitation Acceptance Key Envelope does not match its proposed identity.")
		}
		preparedEnvelopes = append(preparedEnvelopes, prepared)
		dependencies = append(dependencies, canonical.Dependency{Type: 7, ID: slot.envelopeID})
	}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: state.CausalFrontier,
		AuthorityParentIDs: state.AuthorityFrontier, Dependencies: dependencies,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily,
		Type: 6, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(), Body: body,
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Acceptance Event could not be authored.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Acceptance Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Acceptance envelope is invalid.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Invitation Acceptance Event could not be stored.")
	}
	cleanup := func() { deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID) }
	storedEnvelopeIDs := make([][32]byte, 0, len(preparedEnvelopes))
	for _, prepared := range preparedEnvelopes {
		if err := storeOpaqueCreationItem(r.deps.Artifacts, prepared.Envelope.StorageItemID, prepared.Envelope.Bytes); err != nil {
			cleanup()
			for _, storageID := range storedEnvelopeIDs {
				deleteOpaqueCreationItem(r.deps.Artifacts, storageID)
			}
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "An Invitation Acceptance Key Envelope could not be stored.")
		}
		storedEnvelopeIDs = append(storedEnvelopeIDs, prepared.Envelope.StorageItemID)
	}
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		cleanup()
		for _, storageID := range storedEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storageID)
		}
		return nil, commandError("INVITATION_INVALID", "The Invitation Acceptance could not be authenticated.")
	}
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	if value.Canonical.KeyEnvelopeStorageItemIDs == nil {
		value.Canonical.KeyEnvelopeStorageItemIDs = map[string]string{}
	}
	for _, prepared := range preparedEnvelopes {
		logicalID := hexIdentifier(prepared.ID)
		storageID := hexIdentifier(prepared.Envelope.StorageItemID)
		value.Canonical.KeyEnvelopeStorageItemIDs[logicalID] = storageID
		bindStorageItemKeyEpoch(value.Canonical, storageID, prepared.KeyEpochID)
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
		for _, storageID := range storedEnvelopeIDs {
			deleteOpaqueCreationItem(r.deps.Artifacts, storageID)
		}
		return nil, err
	}
	r.signal()
	return map[string]string{
		"invitationId":         hexIdentifier(parsed.invitationID),
		"memberId":             hexIdentifier(parsed.memberID),
		"clientCredentialId":   hexIdentifier(parsed.clientCredentialID),
		"recoveryCredentialId": hexIdentifier(parsed.recoveryCredentialID),
		"eventRecordId":        hexIdentifier(event.RecordID),
	}, nil
}
