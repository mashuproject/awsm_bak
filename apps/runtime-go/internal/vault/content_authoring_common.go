package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"fmt"
	"sort"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

type contentObjectDraft struct {
	objectType uint64
	body       canonical.Value
}

type contentAuthoringRequest struct {
	eventType              uint64
	body                   canonical.Value
	bodyFactory            func([]canonical.Identifier) canonical.Value
	dependencies           []canonical.Dependency
	objects                []contentObjectDraft
	objectDependencies     bool
	requireAdministrator   bool
	expectedCausalFrontier []canonical.Identifier
	assertedAt             int64
}

// authorContentEvent is the one authenticated write path for ordinary
// Content Events and their Note Content Objects. It mirrors the browser
// Content Service boundary: validate against the current Replica, sign with
// the active Client Credential, protect every immutable item under the current
// Key Epoch, and commit the derived frontiers atomically.
func (r *Runtime) authorContentEvent(ctx context.Context, id string, request contentAuthoringRequest) (map[string]string, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot author Content Events.")
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
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the Required Feature conflict before authoring Content.")
	}
	if signerMember, active := authority.activeClientMember(credentialID); !active || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	if request.requireAdministrator {
		if _, administrator := authority.administrators[memberID]; !administrator || len(authority.administratorConflicts[memberID]) > 0 {
			return nil, commandError("ADMINISTRATOR_REQUIRED", "An unambiguous Administrator is required for this Content Event.")
		}
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
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	frontier := r.replicas[id].State()
	if request.expectedCausalFrontier != nil && !contentIdentifierSetEqual(request.expectedCausalFrontier, frontier.CausalFrontier) {
		return nil, commandError("VAULT_CONTEXT_CHANGED", "The accepted causal Frontier changed before the Content Event could be authored.")
	}
	dependencies := append([]canonical.Dependency(nil), request.dependencies...)
	sort.Slice(dependencies, func(left, right int) bool {
		if dependencies[left].Type != dependencies[right].Type {
			return dependencies[left].Type < dependencies[right].Type
		}
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	nextReplica := r.replicas[id].Clone()
	objectPayloads := make([]struct {
		id       canonical.Identifier
		bytes    []byte
		envelope []byte
		storage  storage.OpaqueEnvelope
	}, 0, len(request.objects))
	for _, draft := range request.objects {
		if draft.objectType != 3 {
			return nil, commandError("VAULT_OBJECT_INVALID", "Only Note Content Objects may be authored by a Content command.")
		}
		objectBytes, encodeErr := canonical.EncodeValue(canonical.Map{
			0: uint64(1), 1: vaultID[:], 2: draft.objectType, 3: featureSetID[:], 4: draft.body, 5: map[string][]byte{},
		})
		if encodeErr != nil {
			return nil, commandError("VAULT_OBJECT_INVALID", "The Note Content Object could not be encoded.")
		}
		if validateErr := validateReplicaObjectBody(draft.objectType, draft.body); validateErr != nil {
			return nil, commandError("VAULT_OBJECT_INVALID", validateErr.Error())
		}
		objectID, idErr := canonical.VaultObjectID(vaultID, draft.objectType, objectBytes)
		if idErr != nil {
			return nil, commandError("VAULT_OBJECT_INVALID", "The Note Content Object identity could not be derived.")
		}
		if err := nextReplica.AdmitObject(objectID, objectBytes); err != nil {
			return nil, commandError("VAULT_OBJECT_INVALID", "The Note Content Object could not be admitted.")
		}
		envelopeBytes, sealErr := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: objectBytes,
		})
		if sealErr != nil {
			return nil, commandError("VAULT_OBJECT_INVALID", "The Note Content Object could not be protected.")
		}
		envelope, decodeErr := storage.DecodeOpaqueEnvelope(envelopeBytes)
		if decodeErr != nil {
			return nil, commandError("VAULT_OBJECT_INVALID", "The Note Content Object envelope is invalid.")
		}
		objectPayloads = append(objectPayloads, struct {
			id       canonical.Identifier
			bytes    []byte
			envelope []byte
			storage  storage.OpaqueEnvelope
		}{id: objectID, bytes: objectBytes, envelope: envelopeBytes, storage: envelope})
	}
	if request.objectDependencies {
		for _, object := range objectPayloads {
			dependencies = append(dependencies, canonical.Dependency{Type: 6, ID: object.id})
		}
		sort.Slice(dependencies, func(left, right int) bool {
			if dependencies[left].Type != dependencies[right].Type {
				return dependencies[left].Type < dependencies[right].Type
			}
			return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
		})
	}
	body := request.body
	if request.bodyFactory != nil {
		objectIDs := make([]canonical.Identifier, 0, len(objectPayloads))
		for _, object := range objectPayloads {
			objectIDs = append(objectIDs, object.id)
		}
		body = request.bodyFactory(objectIDs)
	}
	assertedAt := request.assertedAt
	if assertedAt == 0 {
		assertedAt = time.Now().UnixMilli()
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: frontier.CausalFrontier,
		AuthorityParentIDs: frontier.AuthorityFrontier, Dependencies: dependencies,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily,
		Type: request.eventType, SignerCredentialID: credentialID, AssertedAt: assertedAt, Body: body,
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", fmt.Sprintf("Content Event could not be authored: %v", err))
	}
	if err := validateContentEvent(event); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", err.Error())
	}
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Content Event could not be admitted.")
	}
	if _, err := ProjectLibraryProjection(nextReplica); err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Content Event could not be projected.")
	}
	eventEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Content Event could not be protected.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(eventEnvelopeBytes)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Content Event envelope is invalid.")
	}
	stored := make([][32]byte, 0, len(objectPayloads)+1)
	cleanup := func() {
		for _, storageID := range stored {
			deleteOpaqueCreationItem(r.deps.Artifacts, storageID)
		}
	}
	for _, object := range objectPayloads {
		objectKey := hexIdentifier(object.id)
		if _, alreadyStored := value.Canonical.ObjectStorageItemIDs[objectKey]; alreadyStored {
			continue
		}
		if err := storeOpaqueCreationItem(r.deps.Artifacts, object.storage.StorageItemID, object.envelope); err != nil {
			cleanup()
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Note Content Object could not be stored.")
		}
		stored = append(stored, object.storage.StorageItemID)
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, eventEnvelopeBytes); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Content Event could not be stored.")
	}
	stored = append(stored, eventEnvelope.StorageItemID)
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	if value.Canonical.ObjectStorageItemIDs == nil {
		value.Canonical.ObjectStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	for _, object := range objectPayloads {
		objectKey := hexIdentifier(object.id)
		if _, exists := value.Canonical.ObjectStorageItemIDs[objectKey]; !exists {
			value.Canonical.ObjectStorageItemIDs[objectKey] = hexIdentifier(object.storage.StorageItemID)
			bindStorageItemKeyEpoch(value.Canonical, hexIdentifier(object.storage.StorageItemID), epochID)
		}
	}
	eventStorageID := hexIdentifier(eventEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = eventStorageID
	bindStorageItemKeyEpoch(value.Canonical, eventStorageID, epochID)
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
	result := map[string]string{"eventRecordId": hexIdentifier(event.RecordID)}
	for index, object := range objectPayloads {
		result[fmt.Sprintf("objectId%d", index)] = hexIdentifier(object.id)
	}
	return result, nil
}

func contentIdentifierSetEqual(left, right []canonical.Identifier) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func (r *Runtime) currentContentFrontier(id string) ([]canonical.Identifier, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := r.vaultLocked(id); err != nil {
		return nil, err
	}
	if r.replicas[id] == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	frontier := r.replicas[id].State().CausalFrontier
	return append([]canonical.Identifier(nil), frontier...), nil
}

func noteContentDraft(title *string, body string) contentObjectDraft {
	var titleValue canonical.Value
	if title != nil {
		titleValue = *title
	}
	return contentObjectDraft{objectType: 3, body: canonical.Map{0: uint64(1), 1: titleValue, 2: body, 3: "awsm.note.commonmark"}}
}
