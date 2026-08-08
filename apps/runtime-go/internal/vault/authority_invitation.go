package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"encoding/base64"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// createInvitation authors the canonical type-5 Invitation Creation Event.
// Redemption and cancellation capability seeds are returned once to the
// caller; they are not Vault authority and are never persisted by the
// Runtime. The Redemption Authority identity and receipt verification key
// belong to the independently operated authority service.
func (r *Runtime) createInvitation(ctx context.Context, id string, encodedCapabilities []string, encodedAuthorityID, encodedReceiptKey string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot create an Invitation.")
	}
	if value.Canonical == nil || !value.Canonical.AuthoringAvailable || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated authoring Client Credential is unavailable.")
	}
	if len(encodedCapabilities) == 0 {
		return nil, commandError("INVITATION_INVALID", "An Invitation requires at least one capability.")
	}
	capabilities := make([]canonical.Value, 0, len(encodedCapabilities))
	var previous []byte
	seen := make(map[string]struct{}, len(encodedCapabilities))
	for _, encoded := range encodedCapabilities {
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(encoded)
		if decodeErr != nil {
			return nil, commandError("INVITATION_INVALID", "An Invitation capability is not valid base64url.")
		}
		capability, decodeErr := canonical.DecodeValue(decoded)
		if decodeErr != nil {
			return nil, commandError("INVITATION_INVALID", "An Invitation capability is not canonical.")
		}
		canonicalBytes, encodeErr := canonical.EncodeValue(capability)
		if encodeErr != nil {
			return nil, commandError("INVITATION_INVALID", "An Invitation capability is not canonical.")
		}
		if previous != nil && bytes.Compare(previous, canonicalBytes) >= 0 {
			return nil, commandError("INVITATION_INVALID", "Invitation capabilities must be supplied in canonical order.")
		}
		if _, duplicate := seen[string(canonicalBytes)]; duplicate {
			return nil, commandError("INVITATION_INVALID", "Invitation capabilities must not contain duplicates.")
		}
		seen[string(canonicalBytes)] = struct{}{}
		previous = canonicalBytes
		capabilities = append(capabilities, capability)
	}
	decodeIdentifierBytes := func(encoded string, label string) (canonical.Identifier, error) {
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(encoded)
		if decodeErr != nil || len(decoded) != 32 {
			return canonical.Identifier{}, commandError("INVITATION_INVALID", label+" must be 32-byte base64url.")
		}
		var identifier canonical.Identifier
		copy(identifier[:], decoded)
		if bytes.Equal(identifier[:], make([]byte, 32)) {
			return canonical.Identifier{}, commandError("INVITATION_INVALID", label+" must not be all zeroes.")
		}
		return identifier, nil
	}
	authorityID, err := decodeIdentifierBytes(encodedAuthorityID, "The Redemption Authority identity")
	if err != nil {
		return nil, err
	}
	receiptKey, err := decodeIdentifierBytes(encodedReceiptKey, "The receipt verification key")
	if err != nil {
		return nil, err
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
	defer zeroBytes(clientSecret.signingSecretKey)
	defer zeroBytes(clientSecret.wrappingPrivateKey)
	authority, err := replayReplicaAuthorityState(r.replicas[id], nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	if authority.featureSetConflict || len(authority.administratorConflicts) > 0 || len(authority.recoveryConflicts) > 0 || len(authority.keyEpochConflicts) > 0 || len(authority.invitationConflicts) > 0 {
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the visible Authority conflicts before creating an Invitation.")
	}
	signerMember, active := authority.activeClientMember(credentialID)
	if !active || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	if _, administrator := authority.administrators[signerMember]; !administrator {
		return nil, commandError("ADMINISTRATOR_REQUIRED", "Only an Administrator can create an Invitation.")
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
	invitationID := canonical.Identifier{}
	if _, err := cryptorand.Read(invitationID[:]); err != nil {
		return nil, commandError("INVITATION_INVALID", "The Invitation identity could not be generated.")
	}
	redemptionSeed := make([]byte, ed25519.SeedSize)
	cancellationSeed := make([]byte, ed25519.SeedSize)
	if _, err := cryptorand.Read(redemptionSeed); err != nil {
		return nil, commandError("INVITATION_INVALID", "The Redemption capability could not be generated.")
	}
	if _, err := cryptorand.Read(cancellationSeed); err != nil {
		zeroBytes(redemptionSeed)
		return nil, commandError("INVITATION_INVALID", "The Cancellation capability could not be generated.")
	}
	redemptionPrivate := ed25519.NewKeyFromSeed(redemptionSeed)
	cancellationPrivate := ed25519.NewKeyFromSeed(cancellationSeed)
	redemptionVerifier := append([]byte(nil), redemptionPrivate.Public().(ed25519.PublicKey)...)
	cancellationVerifier := append([]byte(nil), cancellationPrivate.Public().(ed25519.PublicKey)...)
	replicaState := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: replicaState.CausalFrontier,
		AuthorityParentIDs: replicaState.AuthorityFrontier, Dependencies: nil,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily,
		Type: 5, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(),
		Body: canonical.Map{0: invitationID[:], 1: capabilities, 2: redemptionVerifier, 3: cancellationVerifier, 4: authorityID[:], 5: receiptKey[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		zeroBytes(redemptionSeed)
		zeroBytes(cancellationSeed)
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Creation Event could not be authored.")
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		zeroBytes(redemptionSeed)
		zeroBytes(cancellationSeed)
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Creation Event could not be protected.")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		zeroBytes(redemptionSeed)
		zeroBytes(cancellationSeed)
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Creation envelope is invalid.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID, encoded); err != nil {
		zeroBytes(redemptionSeed)
		zeroBytes(cancellationSeed)
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Invitation Creation Event could not be stored.")
	}
	cleanup := func() { deleteOpaqueCreationItem(r.deps.Artifacts, envelope.StorageItemID) }
	nextReplica := r.replicas[id].Clone()
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		cleanup()
		zeroBytes(redemptionSeed)
		zeroBytes(cancellationSeed)
		return nil, commandError("VAULT_EVENT_INVALID", "The Invitation Creation Event could not be admitted.")
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
	nextState := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(nextState.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(nextState.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(nextState.ContinuityRecordIDs)
	r.replicas[id] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		cleanup()
		zeroBytes(redemptionSeed)
		zeroBytes(cancellationSeed)
		return nil, err
	}
	r.signal()
	result := map[string]string{
		"invitationId":           hexIdentifier(invitationID),
		"eventRecordId":          hexIdentifier(event.RecordID),
		"redemptionSecret":       base64.RawURLEncoding.EncodeToString(redemptionSeed),
		"cancellationSecret":     base64.RawURLEncoding.EncodeToString(cancellationSeed),
		"redemptionVerifier":     base64.RawURLEncoding.EncodeToString(redemptionVerifier),
		"cancellationVerifier":   base64.RawURLEncoding.EncodeToString(cancellationVerifier),
		"redemptionAuthorityId":  base64.RawURLEncoding.EncodeToString(authorityID[:]),
		"receiptVerificationKey": base64.RawURLEncoding.EncodeToString(receiptKey[:]),
	}
	zeroBytes(redemptionSeed)
	zeroBytes(cancellationSeed)
	return result, nil
}
