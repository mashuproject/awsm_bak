package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"sort"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// activateFeature authors the canonical Authority-family type-14 Event. The
// input contains complete canonical Feature Manifest bytes; the Runtime
// validates the resulting set before sealing the Event and each manifest as a
// separate typed dependency.
func (r *Runtime) activateFeature(ctx context.Context, id string, encodedManifests []string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot activate a Feature.")
	}
	if value.Canonical == nil || !value.Canonical.AuthoringAvailable || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated authoring Client Credential is unavailable.")
	}
	if len(encodedManifests) == 0 {
		return nil, commandError("FEATURE_MANIFEST_INVALID", "Feature Activation requires at least one Manifest.")
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
	if authority.featureSetConflict || len(authority.administratorConflicts) > 0 || len(authority.invitationConflicts) > 0 || len(authority.recoveryConflicts) > 0 || len(authority.keyEpochConflicts) > 0 {
		return nil, commandError("AUTHORITY_CONFLICT", "Resolve the visible Authority conflicts before activating a Feature.")
	}
	signerMember, signerActive := authority.activeClientMember(credentialID)
	if !signerActive || signerMember != memberID {
		return nil, commandError("AUTHORITY_UNAVAILABLE", "This Client Credential is not an active Vault member.")
	}
	if _, administrator := authority.administrators[signerMember]; !administrator {
		return nil, commandError("ADMINISTRATOR_REQUIRED", "Only an Administrator can activate a Feature.")
	}
	existingManifests := r.replicas[id].FeatureManifests()
	manifests := make([]canonical.FeatureManifest, 0, len(encodedManifests))
	seenIDs := make(map[canonical.Identifier]struct{}, len(existingManifests)+len(encodedManifests))
	seenKeys := make(map[string]struct{}, len(existingManifests)+len(encodedManifests))
	for _, existing := range existingManifests {
		seenIDs[existing.ID] = struct{}{}
		seenKeys[existing.FeatureKey] = struct{}{}
	}
	for _, encoded := range encodedManifests {
		manifestBytes, decodeErr := base64.RawURLEncoding.DecodeString(encoded)
		if decodeErr != nil {
			return nil, commandError("FEATURE_MANIFEST_INVALID", "A Feature Manifest encoding is invalid.")
		}
		manifest, decodeErr := canonical.DecodeFeatureManifest(manifestBytes)
		if decodeErr != nil {
			return nil, commandError("FEATURE_MANIFEST_INVALID", "A Feature Manifest is invalid.")
		}
		if _, exists := seenIDs[manifest.ID]; exists {
			return nil, commandError("FEATURE_MANIFEST_INVALID", "Feature Activation repeats a Manifest identity.")
		}
		if _, exists := seenKeys[manifest.FeatureKey]; exists {
			return nil, commandError("FEATURE_MANIFEST_INVALID", "Feature Activation repeats a feature key.")
		}
		if _, exists := seenIDs[manifest.ID]; exists {
			return nil, commandError("FEATURE_MANIFEST_INVALID", "Feature Activation repeats an active Manifest.")
		}
		seenIDs[manifest.ID] = struct{}{}
		seenKeys[manifest.FeatureKey] = struct{}{}
		manifests = append(manifests, manifest)
	}
	type orderedManifest struct {
		manifest     canonical.FeatureManifest
		encodedValue []byte
	}
	ordered := make([]orderedManifest, 0, len(manifests))
	for _, manifest := range manifests {
		encodedValue, encodeErr := canonical.EncodeValue(manifest.Bytes)
		if encodeErr != nil {
			return nil, commandError("FEATURE_MANIFEST_INVALID", "A Feature Manifest cannot be placed in the canonical set.")
		}
		ordered = append(ordered, orderedManifest{manifest: manifest, encodedValue: encodedValue})
	}
	sort.Slice(ordered, func(left, right int) bool {
		return bytes.Compare(ordered[left].encodedValue, ordered[right].encodedValue) < 0
	})
	manifests = make([]canonical.FeatureManifest, 0, len(ordered))
	for _, item := range ordered {
		manifests = append(manifests, item.manifest)
	}
	inputs := make([]canonical.FeatureManifestInput, 0, len(existingManifests)+len(manifests))
	for _, manifest := range existingManifests {
		inputs = append(inputs, manifest.FeatureManifestInput)
	}
	for _, manifest := range manifests {
		inputs = append(inputs, manifest.FeatureManifestInput)
	}
	resultingFeatureSetID, err := canonical.RequiredFeatureSetID(inputs)
	if err != nil {
		return nil, commandError("FEATURE_MANIFEST_INVALID", fmt.Sprintf("The resulting Required Feature Set is invalid: %v", err))
	}
	previousFeatureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The current Required Feature Set identity is invalid.")
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
	featureSetValues := make([]canonical.Value, 0, len(manifests))
	dependencies := make([]canonical.Dependency, 0, len(manifests))
	for _, manifest := range manifests {
		featureSetValues = append(featureSetValues, append([]byte(nil), manifest.Bytes...))
		dependencies = append(dependencies, canonical.Dependency{Type: 8, ID: manifest.ID})
	}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Generation identity is invalid.")
	}
	replicaState := r.replicas[id].State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: generationID, ParentRecordIDs: replicaState.CausalFrontier,
		AuthorityParentIDs: replicaState.AuthorityFrontier, Dependencies: dependencies,
		RequiredFeatureSetID: previousFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily,
		Type: 14, SignerCredentialID: credentialID, AssertedAt: time.Now().UnixMilli(),
		Body: canonical.Map{0: previousFeatureSetID[:], 1: featureSetValues, 2: resultingFeatureSetID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Feature Activation Event could not be authored.")
	}
	encodedEvent, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key,
		PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Feature Activation Event could not be protected.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(encodedEvent)
	if err != nil {
		return nil, commandError("VAULT_EVENT_INVALID", "The Feature Activation envelope is invalid.")
	}
	type storedFeature struct {
		manifest canonical.FeatureManifest
		envelope storage.OpaqueEnvelope
	}
	stored := make([]storedFeature, 0, len(manifests))
	cleanup := func() {
		for _, item := range stored {
			deleteOpaqueCreationItem(r.deps.Artifacts, item.envelope.StorageItemID)
		}
		deleteOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID)
	}
	for _, manifest := range manifests {
		sealed, sealErr := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key,
			PayloadType: 3, PayloadBytes: manifest.Bytes,
		})
		if sealErr != nil {
			cleanup()
			return nil, commandError("FEATURE_MANIFEST_INVALID", "A Feature Manifest could not be protected.")
		}
		decodedEnvelope, decodeErr := storage.DecodeOpaqueEnvelope(sealed)
		if decodeErr != nil {
			cleanup()
			return nil, commandError("FEATURE_MANIFEST_INVALID", "A Feature Manifest envelope is invalid.")
		}
		if err := storeOpaqueCreationItem(r.deps.Artifacts, decodedEnvelope.StorageItemID, sealed); err != nil {
			cleanup()
			return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "A Feature Manifest could not be stored.")
		}
		stored = append(stored, storedFeature{manifest: manifest, envelope: decodedEnvelope})
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, encodedEvent); err != nil {
		cleanup()
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The Feature Activation Event could not be stored.")
	}
	nextReplica := r.replicas[id].Clone()
	for _, item := range stored {
		if err := nextReplica.AdmitFeatureManifest(item.manifest.ID, item.manifest.Bytes); err != nil {
			cleanup()
			return nil, commandError("FEATURE_MANIFEST_INVALID", "The Feature Manifest could not be admitted.")
		}
	}
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		cleanup()
		return nil, commandError("VAULT_EVENT_INVALID", "The Feature Activation Event could not be admitted.")
	}
	if value.Canonical.FeatureManifestStorageItemIDs == nil {
		value.Canonical.FeatureManifestStorageItemIDs = map[string]string{}
	}
	if value.Canonical.RecordStorageItemIDs == nil {
		value.Canonical.RecordStorageItemIDs = map[string]string{}
	}
	if value.Canonical.StorageItemKeyEpochIDs == nil {
		value.Canonical.StorageItemKeyEpochIDs = map[string]string{}
	}
	for _, item := range stored {
		storageItemID := hexIdentifier(item.envelope.StorageItemID)
		value.Canonical.FeatureManifestStorageItemIDs[hexIdentifier(item.manifest.ID)] = storageItemID
		bindStorageItemKeyEpoch(value.Canonical, storageItemID, epochID)
	}
	eventStorageID := hexIdentifier(eventEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = eventStorageID
	bindStorageItemKeyEpoch(value.Canonical, eventStorageID, epochID)
	value.Canonical.RequiredFeatureSetID = hexIdentifier(resultingFeatureSetID)
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
	return map[string]string{"requiredFeatureSetId": hexIdentifier(resultingFeatureSetID), "eventRecordId": hexIdentifier(event.RecordID)}, nil
}
