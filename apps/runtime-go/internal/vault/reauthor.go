package vault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// reauthorizeCapture recovers one authenticated Bundle Registered Event into
// the accepted Generation. The source Event remains immutable and is carried
// only by the Descriptor's protected provenance tuple.
func (r *Runtime) reauthorizeCapture(ctx context.Context, id, sourceRecordText string) (any, error) {
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
		return nil, commandError("VAULT_READ_ONLY", "A closed Vault cannot re-author a Capture.")
	}
	if value.Canonical == nil || r.replicas[id] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	vaultID, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The Vault identity is invalid.")
	}
	sourceRecordID, err := decodeHexIdentifier(sourceRecordText)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Record identity is invalid.")
	}
	replica := r.replicas[id]
	sourceRecord, ok := replica.Record(sourceRecordID)
	if !ok || sourceRecord.Event == nil {
		return nil, commandError("VAULT_REAUTHOR_SOURCE_UNAVAILABLE", "The source Bundle Registered Event is unavailable.")
	}
	sourceEvent := *sourceRecord.Event
	if sourceEvent.VaultID != vaultID || sourceEvent.GenerationID == replica.generationID || sourceEvent.Family != canonical.ContentFamily || sourceEvent.Type != 3 {
		return nil, commandError("VAULT_REAUTHOR_INELIGIBLE", "Only a stale Bundle Registered Event may be re-authored.")
	}
	if err := validateContentEvent(sourceEvent); err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Bundle Registered Event is invalid.")
	}
	sourceBody, ok := replicaMapValue(sourceEvent.Body)
	if !ok {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Bundle Registered body is invalid.")
	}
	sourceBundleID, ok := replicaIdentifier(sourceBody, 0)
	if !ok {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Bundle identity is invalid.")
	}
	sourceDescriptorID, ok := replicaIdentifier(sourceBody, 1)
	if !ok {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Descriptor identity is invalid.")
	}
	sourceDescriptor, ok := replica.Object(sourceDescriptorID)
	if !ok || sourceDescriptor.ObjectType != 1 {
		return nil, commandError("VAULT_REAUTHOR_SOURCE_UNAVAILABLE", "The source Bundle Descriptor is unavailable.")
	}
	metadata, err := parseBundleDescriptorMetadata(sourceDescriptor.Body)
	if err != nil || metadata.bundleID != sourceBundleID {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Bundle Descriptor is invalid.")
	}
	profileProvenance, err := reauthorProfileProvenance(sourceDescriptor.Body)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Bundle provenance is invalid.")
	}
	if err := r.verifyReauthorClosure(id, value.Canonical, vaultID, sourceRecord, sourceDescriptor); err != nil {
		return nil, commandError("VAULT_REAUTHOR_SOURCE_UNAVAILABLE", err.Error())
	}

	transcript, err := canonical.Transcript("awsm:recovered-bundle:v1", vaultID[:], sourceRecordID[:])
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Bundle identity could not be derived.")
	}
	recoveredBundleID := sha256.Sum256(transcript)
	for _, event := range replica.Events() {
		if event.Family != canonical.ContentFamily || event.Type != 3 {
			continue
		}
		body, bodyOK := replicaMapValue(event.Body)
		bundleID, bundleOK := replicaIdentifier(body, 0)
		if bodyOK && bundleOK && bundleID == recoveredBundleID {
			descriptorID, descriptorOK := replicaIdentifier(body, 1)
			if !descriptorOK {
				return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Bundle identity is claimed by an invalid Event.")
			}
			return map[string]string{"sourceRecordId": hexIdentifier(sourceRecordID), "bundleId": hexIdentifier(recoveredBundleID), "descriptorObjectId": hexIdentifier(descriptorID), "eventRecordId": hexIdentifier(event.RecordID)}, nil
		}
	}

	currentCollectionID, err := reauthorCollectionID(replica, sourceBody)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", err.Error())
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
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Client Credential is invalid.")
	}
	authority, err := replayReplicaAuthorityState(replica, nil, nil)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Authority State could not be replayed.")
	}
	if _, active := authority.activeClientMember(clientCredentialID); !active {
		return nil, commandError("VAULT_AUTHORING_UNAVAILABLE", "The local Client Credential is not active.")
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
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	descriptorBody, ok := reauthorCanonicalMap(sourceDescriptor.Body)
	if !ok {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The source Descriptor body is invalid.")
	}
	recoveredDescriptorBody := make(canonical.Map, len(descriptorBody))
	for key, item := range descriptorBody {
		recoveredDescriptorBody[key] = item
	}
	recoveredDescriptorBody[1] = recoveredBundleID[:]
	recoveredDescriptorBody[11] = canonical.Map{0: uint64(2), 1: vaultID[:], 2: sourceEvent.GenerationID[:], 3: sourceRecordID[:], 4: sourceBundleID[:], 5: sourceDescriptorID[:], 6: profileProvenance}
	descriptorBytes, err := canonical.EncodeValue(canonical.Map{0: uint64(1), 1: vaultID[:], 2: uint64(1), 3: featureSetID[:], 4: recoveredDescriptorBody, 5: map[string][]byte{}})
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Descriptor could not be encoded.")
	}
	if err := validateReplicaObjectBody(1, recoveredDescriptorBody); err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Descriptor is invalid.")
	}
	descriptorObjectID, err := canonical.VaultObjectID(vaultID, 1, descriptorBytes)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Descriptor identity could not be derived.")
	}
	descriptorEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: descriptorBytes})
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Descriptor could not be protected.")
	}
	descriptorEnvelope, err := storage.DecodeOpaqueEnvelope(descriptorEnvelopeBytes)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Descriptor envelope is invalid.")
	}
	state := replica.State()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultID, GenerationID: state.GenerationID, ParentRecordIDs: state.CausalFrontier, AuthorityParentIDs: state.AuthorityFrontier,
		Dependencies: []canonical.Dependency{{Type: 4, ID: descriptorObjectID}}, RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{},
		Family: canonical.ContentFamily, Type: 3, SignerCredentialID: clientCredentialID, AssertedAt: time.Now().UnixMilli(), Body: canonical.Map{0: recoveredBundleID[:], 1: descriptorObjectID[:], 2: currentCollectionID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Event could not be authored.")
	}
	eventEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Event could not be protected.")
	}
	eventEnvelope, err := storage.DecodeOpaqueEnvelope(eventEnvelopeBytes)
	if err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Event envelope is invalid.")
	}
	nextReplica := replica.Clone()
	if err := nextReplica.AdmitObject(descriptorObjectID, descriptorBytes); err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Descriptor could not be admitted.")
	}
	if err := nextReplica.AdmitEvent(event, ed25519.PublicKey(clientSecret.signingPublicKey)); err != nil {
		return nil, commandError("VAULT_REAUTHOR_INVALID", "The recovered Event could not be admitted.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, descriptorEnvelope.StorageItemID, descriptorEnvelope.Bytes); err != nil {
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The recovered Descriptor could not be stored.")
	}
	if err := storeOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID, eventEnvelope.Bytes); err != nil {
		deleteOpaqueCreationItem(r.deps.Artifacts, descriptorEnvelope.StorageItemID)
		return nil, commandError("VAULT_CREATION_STORAGE_FAILED", "The recovered Event could not be stored.")
	}
	value.Canonical.ObjectStorageItemIDs[hexIdentifier(descriptorObjectID)] = hexIdentifier(descriptorEnvelope.StorageItemID)
	value.Canonical.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = hexIdentifier(eventEnvelope.StorageItemID)
	bindStorageItemKeyEpoch(value.Canonical, hexIdentifier(descriptorEnvelope.StorageItemID), epochID)
	bindStorageItemKeyEpoch(value.Canonical, hexIdentifier(eventEnvelope.StorageItemID), epochID)
	nextState := nextReplica.State()
	value.Canonical.CausalFrontier = identifiersToHex(nextState.CausalFrontier)
	value.Canonical.AuthorityFrontier = identifiersToHex(nextState.AuthorityFrontier)
	value.Canonical.ContinuityRecordIDs = identifiersToHex(nextState.ContinuityRecordIDs)
	r.replicas[id] = nextReplica
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		deleteOpaqueCreationItem(r.deps.Artifacts, descriptorEnvelope.StorageItemID)
		deleteOpaqueCreationItem(r.deps.Artifacts, eventEnvelope.StorageItemID)
		return nil, err
	}
	r.signal()
	return map[string]string{"sourceRecordId": hexIdentifier(sourceRecordID), "bundleId": hexIdentifier(recoveredBundleID), "descriptorObjectId": hexIdentifier(descriptorObjectID), "eventRecordId": hexIdentifier(event.RecordID)}, nil
}

func reauthorProfileProvenance(body canonical.Value) (canonical.Value, error) {
	provenance, ok := replicaMapValue(replicaMapEntryMust(body, 11))
	if !ok {
		return nil, errors.New("Descriptor provenance is invalid")
	}
	kind, ok := replicaMapNumber(provenance, 0)
	if !ok {
		return nil, errors.New("Descriptor provenance kind is invalid")
	}
	field := uint64(1)
	if kind == 2 {
		field = 6
	} else if kind != 1 {
		return nil, errors.New("Descriptor provenance kind is unsupported")
	}
	profile, ok := replicaMapEntry(provenance, field)
	if !ok {
		return nil, errors.New("Descriptor profile provenance is missing")
	}
	if _, ok := profile.([]byte); !ok {
		return nil, errors.New("Descriptor profile provenance is invalid")
	}
	return profile, nil
}

func reauthorCanonicalMap(value canonical.Value) (canonical.Map, bool) {
	switch typed := value.(type) {
	case canonical.Map:
		return typed, true
	case map[any]any:
		converted := make(canonical.Map, len(typed))
		for key, item := range typed {
			unsigned, ok := key.(uint64)
			if !ok {
				return nil, false
			}
			converted[unsigned] = item
		}
		return converted, true
	default:
		return nil, false
	}
}

func reauthorCollectionID(replica *Replica, sourceBody canonical.Value) (canonical.Identifier, error) {
	sourceID, ok := replicaIdentifier(sourceBody, 2)
	if !ok {
		return canonical.Identifier{}, errors.New("The source Collection identity is invalid")
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		return canonical.Identifier{}, errors.New("The current Library projection is unavailable")
	}
	for _, collection := range projection.Collections {
		if collection.CollectionID == hexIdentifier(sourceID) {
			return sourceID, nil
		}
	}
	if len(projection.Collections) == 0 {
		return canonical.Identifier{}, errors.New("No current Collection can receive the recovered Capture")
	}
	collectionID, err := decodeHexIdentifier(projection.Collections[0].CollectionID)
	if err != nil {
		return canonical.Identifier{}, errors.New("The current Collection identity is invalid")
	}
	return collectionID, nil
}

func (r *Runtime) verifyReauthorClosure(vaultText string, state *canonicalReplicaState, vaultID canonical.Identifier, sourceRecord canonical.Record, descriptor ReplicaObject) error {
	if state == nil || sourceRecord.Event == nil {
		return errors.New("the source closure is unavailable")
	}
	recordStorageID, ok := state.RecordStorageItemIDs[hexIdentifier(sourceRecord.RecordID)]
	if !ok {
		return errors.New("the source Event wrapper is unavailable")
	}
	if err := verifyReauthorOpaque(r, vaultText, state, vaultID, recordStorageID, 1, sourceRecord.Bytes); err != nil {
		return err
	}
	descriptorStorageID, ok := state.ObjectStorageItemIDs[hexIdentifier(descriptor.ObjectID)]
	if !ok {
		return errors.New("the source Descriptor wrapper is unavailable")
	}
	if err := verifyReauthorOpaque(r, vaultText, state, vaultID, descriptorStorageID, 2, descriptor.Bytes); err != nil {
		return err
	}
	entries, ok := replicaMapArray(descriptor.Body, 9)
	if !ok || len(entries) == 0 {
		return errors.New("the source Descriptor Artifact references are invalid")
	}
	for _, entry := range entries {
		artifactID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return errors.New("the source Artifact identity is invalid")
		}
		artifact, ok := r.replicas[vaultText].Object(artifactID)
		if !ok || artifact.ObjectType != 2 {
			return errors.New("the source Artifact Object is unavailable")
		}
		storageID, ok := state.ObjectStorageItemIDs[hexIdentifier(artifactID)]
		if !ok {
			return errors.New("the source Artifact wrapper is unavailable")
		}
		if err := verifyReauthorOpaque(r, vaultText, state, vaultID, storageID, 2, artifact.Bytes); err != nil {
			return err
		}
	}
	return nil
}

func verifyReauthorOpaque(r *Runtime, vaultText string, state *canonicalReplicaState, vaultID canonical.Identifier, storageID string, payloadType uint64, expected []byte) error {
	reader, err := r.deps.Artifacts.Open(storageID)
	if err != nil {
		return fmt.Errorf("required source wrapper %s is unavailable", storageID)
	}
	encoded, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		return fmt.Errorf("required source wrapper %s is unreadable", storageID)
	}
	opened, err := r.openOpaqueWithKnownEpochs(vaultText, state, vaultID, encoded)
	if err != nil || opened.PayloadType != payloadType || !bytes.Equal(opened.PayloadBytes, expected) {
		return fmt.Errorf("required source wrapper %s failed authenticated verification", storageID)
	}
	return nil
}
