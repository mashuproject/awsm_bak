package vault

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// reauthorForkContentEvents carries the deliberately small first Fork slice:
// a content label has no object or authority dependencies, so it can be
// signed again against the destination Genesis without importing source
// history. More involved content closures fail closed until their identity and
// heavy-wrapper mappings are implemented.
func reauthorForkContentEvents(
	source *Replica,
	destination *Replica,
	creation PreparedCanonicalVaultCreation,
	state *canonicalReplicaState,
	sourceState *canonicalReplicaState,
	sourceVaultID canonical.Identifier,
	sourceEpochID canonical.Identifier,
	sourceEpochKey []byte,
	artifacts Dependencies,
) error {
	if source == nil || destination == nil || state == nil || sourceState == nil || artifacts.Artifacts == nil {
		return errors.New("Fork content preparation is unavailable")
	}
	if len(sourceState.ObjectStorageItemIDs) > 0 || len(sourceState.ArtifactStorageItemIDs) > 0 {
		if len(sourceEpochKey) != 32 {
			return errors.New("Fork source Key Epoch is unavailable")
		}
		objectMappings := make(map[canonical.Identifier]canonical.Identifier)
		bundleMappings := make(map[canonical.Identifier]canonical.Identifier)
		if err := reauthorForkArtifactObjects(source, destination, creation, state, sourceState, sourceVaultID, sourceEpochID, sourceEpochKey, objectMappings, artifacts); err != nil {
			return err
		}
		if err := reauthorForkBundleObjects(source, destination, creation, state, sourceState, sourceVaultID, sourceEpochID, sourceEpochKey, objectMappings, bundleMappings, artifacts); err != nil {
			return err
		}
		return reauthorForkContentEventsWithMappings(source, destination, creation, state, objectMappings, bundleMappings, artifacts)
	}
	return reauthorForkContentEventsWithMappings(source, destination, creation, state, nil, nil, artifacts)
}

func reauthorForkContentEventsWithMappings(
	source *Replica,
	destination *Replica,
	creation PreparedCanonicalVaultCreation,
	state *canonicalReplicaState,
	objectMappings map[canonical.Identifier]canonical.Identifier,
	bundleMappings map[canonical.Identifier]canonical.Identifier,
	artifacts Dependencies,
) error {
	content := make([]canonical.Event, 0)
	for _, event := range source.Events() {
		if event.Family == canonical.ContentFamily {
			if event.Type != 1 && event.Type != 3 {
				return fmt.Errorf("Fork Content Event type %d re-authoring is not implemented by this Runtime", event.Type)
			}
			if event.Type == 1 && len(event.Dependencies) != 0 {
				return fmt.Errorf("Fork Content Event type %d re-authoring is not implemented by this Runtime", event.Type)
			}
			content = append(content, event)
		}
	}
	if len(content) == 0 {
		return nil
	}
	sort.Slice(content, func(left, right int) bool {
		return bytes.Compare(content[left].RecordID[:], content[right].RecordID[:]) < 0
	})
	translated := make(map[canonical.Identifier]canonical.Identifier, len(content))
	collectionMappings := make(map[canonical.Identifier]canonical.Identifier)
	stored := make([]string, 0, len(content))
	cleanup := func() {
		for _, storageItemID := range stored {
			_ = artifacts.Artifacts.Delete(storageItemID)
		}
	}
	for len(content) > 0 {
		progress := false
		for index := 0; index < len(content); index++ {
			sourceEvent := content[index]
			parents := make([]canonical.Identifier, 0, len(sourceEvent.ParentRecordIDs)+1)
			ready := true
			for _, parent := range sourceEvent.ParentRecordIDs {
				if mapped, ok := translated[parent]; ok {
					parents = append(parents, mapped)
					continue
				}
				if parent == source.genesisID {
					parents = append(parents, creation.Genesis.RecordID)
					continue
				}
				// Authority and lifecycle ancestry is intentionally not copied
				// into a state-only Fork; the fresh Genesis is the authority root.
				if record, ok := source.Record(parent); ok && record.Event != nil &&
					record.Event.Family != canonical.ContentFamily {
					parents = append(parents, creation.Genesis.RecordID)
					continue
				}
				ready = false
				break
			}
			if !ready {
				continue
			}
			parents = append(parents, creation.Genesis.RecordID)
			parents = sortUniqueIdentifiers(parents)
			authorityParents := []canonical.Identifier{creation.Genesis.RecordID}
			body := sourceEvent.Body
			dependencies := append([]canonical.Dependency(nil), sourceEvent.Dependencies...)
			if sourceEvent.Type == 3 {
				if objectMappings == nil || bundleMappings == nil {
					return errors.New("Fork Bundle Registered dependencies are unavailable")
				}
				mappedBody, mappedDependencies, err := reauthorForkBundleRegistered(sourceEvent.Body, sourceEvent.Dependencies, objectMappings, bundleMappings, collectionMappings)
				if err != nil {
					cleanup()
					return err
				}
				body = mappedBody
				dependencies = mappedDependencies
			}
			event, err := canonical.SignEvent(canonical.EventInput{
				VaultID: creation.IDs.VaultID, GenerationID: creation.IDs.GenerationID,
				ParentRecordIDs: parents, AuthorityParentIDs: authorityParents,
				Dependencies: dependencies, RequiredFeatureSetID: creation.RequiredFeatureSetID,
				Extensions: cloneEventExtensions(sourceEvent.Extensions), Family: canonical.ContentFamily,
				Type: sourceEvent.Type, SignerCredentialID: creation.IDs.ClientCredentialID,
				AssertedAt: sourceEvent.AssertedAt, Body: body,
			}, ed25519.PrivateKey(creation.ClientKeys.SigningSecretKey))
			if err != nil {
				cleanup()
				return fmt.Errorf("sign Fork Content Event: %w", err)
			}
			encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
				VaultID: creation.IDs.VaultID, KeyEpochID: creation.KeyEpochID,
				KeyEpochKey: creation.KeyEpochKey, PayloadType: 1, PayloadBytes: event.Bytes,
			})
			if err != nil {
				cleanup()
				return fmt.Errorf("protect Fork Content Event: %w", err)
			}
			envelope, err := storage.DecodeOpaqueEnvelope(encoded)
			if err != nil {
				cleanup()
				return fmt.Errorf("decode Fork Content Event envelope: %w", err)
			}
			if err := storeOpaqueCreationItem(artifacts.Artifacts, envelope.StorageItemID, encoded); err != nil {
				cleanup()
				return fmt.Errorf("store Fork Content Event: %w", err)
			}
			storageItemID := hexIdentifier(envelope.StorageItemID)
			stored = append(stored, storageItemID)
			state.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
			if err := destination.AdmitEvent(event, ed25519.PublicKey(creation.ClientKeys.SigningPublicKey)); err != nil {
				cleanup()
				return fmt.Errorf("admit Fork Content Event: %w", err)
			}
			translated[sourceEvent.RecordID] = event.RecordID
			content = append(content[:index], content[index+1:]...)
			index--
			progress = true
		}
		if !progress {
			cleanup()
			return errors.New("Fork Content Event graph cannot reach the fresh Genesis")
		}
	}
	next := destination.State()
	state.CausalFrontier = identifiersToHex(next.CausalFrontier)
	state.AuthorityFrontier = identifiersToHex(next.AuthorityFrontier)
	state.ContinuityRecordIDs = identifiersToHex(next.ContinuityRecordIDs)
	return nil
}

func reauthorForkBundleRegistered(body canonical.Value, dependencies []canonical.Dependency, objectMappings map[canonical.Identifier]canonical.Identifier, bundleMappings map[canonical.Identifier]canonical.Identifier, collectionMappings map[canonical.Identifier]canonical.Identifier) (canonical.Value, []canonical.Dependency, error) {
	value, ok := replicaMapValue(body)
	if !ok || !replicaMapHasKeys(value, 3) {
		return nil, nil, errors.New("Fork Bundle Registered body is invalid")
	}
	sourceBundleID, ok := replicaIdentifier(value, 0)
	if !ok {
		return nil, nil, errors.New("Fork Bundle Registered Bundle ID is invalid")
	}
	destinationBundleID, ok := bundleMappings[sourceBundleID]
	if !ok {
		return nil, nil, errors.New("Fork Bundle Registered Descriptor mapping is unavailable")
	}
	sourceDescriptorID, ok := replicaIdentifier(value, 1)
	if !ok {
		return nil, nil, errors.New("Fork Bundle Registered Descriptor ID is invalid")
	}
	destinationDescriptorID, ok := objectMappings[sourceDescriptorID]
	if !ok {
		return nil, nil, errors.New("Fork Bundle Registered Descriptor mapping is unavailable")
	}
	sourceCollectionID, ok := replicaIdentifier(value, 2)
	if !ok {
		return nil, nil, errors.New("Fork Bundle Registered Collection ID is invalid")
	}
	destinationCollectionID, ok := collectionMappings[sourceCollectionID]
	if !ok {
		textID, err := randomID()
		if err != nil {
			return nil, nil, err
		}
		destinationCollectionID, err = decodeHexIdentifier(textID)
		if err != nil {
			return nil, nil, err
		}
		collectionMappings[sourceCollectionID] = destinationCollectionID
	}
	mappedDependencies := make([]canonical.Dependency, 0, len(dependencies))
	for _, dependency := range dependencies {
		if dependency.Type != 3 && dependency.Type != 5 {
			return nil, nil, fmt.Errorf("Fork Bundle Registered dependency type %d is not supported", dependency.Type)
		}
		mapped, ok := objectMappings[dependency.ID]
		if !ok {
			return nil, nil, fmt.Errorf("Fork Bundle Registered dependency %s is unavailable", hexIdentifier(dependency.ID))
		}
		mappedDependencies = append(mappedDependencies, canonical.Dependency{Type: dependency.Type, ID: mapped})
	}
	return canonical.Map{0: destinationBundleID[:], 1: destinationDescriptorID[:], 2: destinationCollectionID[:]}, mappedDependencies, nil
}

func reauthorForkArtifactObjects(
	source *Replica,
	destination *Replica,
	creation PreparedCanonicalVaultCreation,
	state *canonicalReplicaState,
	sourceState *canonicalReplicaState,
	sourceVaultID canonical.Identifier,
	sourceEpochID canonical.Identifier,
	sourceEpochKey []byte,
	objectMappings map[canonical.Identifier]canonical.Identifier,
	artifacts Dependencies,
) error {
	if len(sourceState.ObjectStorageItemIDs) == 0 {
		if len(sourceState.ArtifactStorageItemIDs) != 0 {
			return errors.New("Fork Artifact Object mapping is unavailable")
		}
		return nil
	}
	if state.ObjectStorageItemIDs == nil {
		state.ObjectStorageItemIDs = map[string]string{}
	}
	if state.ArtifactStorageItemIDs == nil {
		state.ArtifactStorageItemIDs = map[string]string{}
	}
	stored := make([]string, 0, len(sourceState.ObjectStorageItemIDs)*2)
	cleanup := func() {
		for _, storageItemID := range stored {
			_ = artifacts.Artifacts.Delete(storageItemID)
		}
	}
	for _, sourceObjectIDText := range sortedStringKeys(sourceState.ObjectStorageItemIDs) {
		sourceObjectID, err := decodeHexIdentifier(sourceObjectIDText)
		if err != nil {
			cleanup()
			return errors.New("Fork source Object identity is invalid")
		}
		sourceObject, ok := source.Object(sourceObjectID)
		if !ok {
			cleanup()
			return fmt.Errorf("Fork source Object %s is unavailable", sourceObjectIDText)
		}
		if sourceObject.ObjectType != 2 {
			continue
		}
		sourceObjectStorageID := sourceState.ObjectStorageItemIDs[sourceObjectIDText]
		sourceObjectEnvelopeBytes, _, err := readForkOpaque(artifacts, sourceObjectStorageID)
		if err != nil {
			cleanup()
			return err
		}
		openedObject, err := awsmcrypto.OpenCompactItem(sourceVaultID, sourceEpochID, sourceEpochKey, sourceObjectEnvelopeBytes)
		if err != nil || openedObject.PayloadType != 2 || !bytes.Equal(openedObject.PayloadBytes, sourceObject.Bytes) {
			cleanup()
			return fmt.Errorf("Fork source Object %s is not authenticated", sourceObjectIDText)
		}
		destinationObjectBytes, err := rebuildForkArtifactObject(sourceObject, creation.IDs.VaultID, creation.RequiredFeatureSetID)
		if err != nil {
			cleanup()
			return fmt.Errorf("rebuild Fork Artifact Object %s: %w", sourceObjectIDText, err)
		}
		destinationObjectID, err := canonical.VaultObjectID(creation.IDs.VaultID, 2, destinationObjectBytes)
		if err != nil {
			cleanup()
			return fmt.Errorf("derive Fork Artifact Object identity: %w", err)
		}
		if destinationObjectID == sourceObjectID {
			cleanup()
			return errors.New("Fork Artifact Object identity was not fresh")
		}
		destinationObjectEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: creation.IDs.VaultID, KeyEpochID: creation.KeyEpochID, KeyEpochKey: creation.KeyEpochKey,
			PayloadType: 2, PayloadBytes: destinationObjectBytes,
		})
		if err != nil {
			cleanup()
			return fmt.Errorf("protect Fork Artifact Object %s: %w", sourceObjectIDText, err)
		}
		destinationObjectEnvelope, err := storage.DecodeOpaqueEnvelope(destinationObjectEnvelopeBytes)
		if err != nil {
			cleanup()
			return fmt.Errorf("decode Fork Artifact Object envelope: %w", err)
		}
		if err := storeOpaqueCreationItem(artifacts.Artifacts, destinationObjectEnvelope.StorageItemID, destinationObjectEnvelopeBytes); err != nil {
			cleanup()
			return fmt.Errorf("store Fork Artifact Object: %w", err)
		}
		stored = append(stored, hexIdentifier(destinationObjectEnvelope.StorageItemID))
		if err := destination.AdmitObject(destinationObjectID, destinationObjectBytes); err != nil {
			cleanup()
			return fmt.Errorf("admit Fork Artifact Object: %w", err)
		}
		state.ObjectStorageItemIDs[hexIdentifier(destinationObjectID)] = hexIdentifier(destinationObjectEnvelope.StorageItemID)
		objectMappings[sourceObjectID] = destinationObjectID

		sourceArtifactStorageID, ok := sourceState.ArtifactStorageItemIDs[sourceObjectIDText]
		if !ok {
			cleanup()
			return fmt.Errorf("Fork source Artifact wrapper %s is unavailable", sourceObjectIDText)
		}
		sourceArtifactEnvelopeBytes, sourceArtifactEnvelope, err := readForkOpaque(artifacts, sourceArtifactStorageID)
		if err != nil {
			cleanup()
			return err
		}
		contract, err := decodeArtifactPayloadContract(sourceObject)
		if err != nil {
			cleanup()
			return fmt.Errorf("Fork source Artifact Object %s contract is invalid: %w", sourceObjectIDText, err)
		}
		openedArtifact, err := awsmcrypto.OpenArtifactStream(awsmcrypto.ArtifactStreamOpenInput{
			VaultID: sourceVaultID, KeyEpochID: sourceEpochID, KeyEpochKey: sourceEpochKey,
			ArtifactID: sourceObjectID, PlaintextLength: contract.PlaintextLength,
			PlaintextDigest: contract.PlaintextDigest, EnvelopeBytes: sourceArtifactEnvelopeBytes,
		})
		if err != nil {
			cleanup()
			return fmt.Errorf("Fork source Artifact wrapper %s is not authenticated: %w", sourceObjectIDText, err)
		}
		destinationArtifactEnvelopeBytes, err := awsmcrypto.SealArtifactStream(awsmcrypto.ArtifactStreamInput{
			VaultID: creation.IDs.VaultID, KeyEpochID: creation.KeyEpochID, KeyEpochKey: creation.KeyEpochKey,
			ArtifactID: destinationObjectID, Plaintext: openedArtifact.Plaintext, PlaintextDigest: contract.PlaintextDigest,
		})
		if err != nil {
			cleanup()
			return fmt.Errorf("protect Fork Artifact wrapper: %w", err)
		}
		destinationArtifactEnvelope, err := storage.DecodeOpaqueEnvelope(destinationArtifactEnvelopeBytes)
		if err != nil || sourceArtifactEnvelope.StorageClass != storage.StreamableStorageClass {
			cleanup()
			return errors.New("Fork Artifact wrapper envelope is invalid")
		}
		if err := storeOpaqueCreationItem(artifacts.Artifacts, destinationArtifactEnvelope.StorageItemID, destinationArtifactEnvelopeBytes); err != nil {
			cleanup()
			return fmt.Errorf("store Fork Artifact wrapper: %w", err)
		}
		stored = append(stored, hexIdentifier(destinationArtifactEnvelope.StorageItemID))
		state.ArtifactStorageItemIDs[hexIdentifier(destinationObjectID)] = hexIdentifier(destinationArtifactEnvelope.StorageItemID)
	}
	for sourceArtifactIDText := range sourceState.ArtifactStorageItemIDs {
		if _, ok := sourceState.ObjectStorageItemIDs[sourceArtifactIDText]; !ok {
			cleanup()
			return fmt.Errorf("Fork source Artifact Object %s is unavailable", sourceArtifactIDText)
		}
	}
	return nil
}

func reauthorForkBundleObjects(
	source *Replica,
	destination *Replica,
	creation PreparedCanonicalVaultCreation,
	state *canonicalReplicaState,
	sourceState *canonicalReplicaState,
	sourceVaultID canonical.Identifier,
	sourceEpochID canonical.Identifier,
	sourceEpochKey []byte,
	objectMappings map[canonical.Identifier]canonical.Identifier,
	bundleMappings map[canonical.Identifier]canonical.Identifier,
	artifacts Dependencies,
) error {
	for _, sourceObjectIDText := range sortedStringKeys(sourceState.ObjectStorageItemIDs) {
		sourceObjectID, err := decodeHexIdentifier(sourceObjectIDText)
		if err != nil {
			return errors.New("Fork source Object identity is invalid")
		}
		sourceObject, ok := source.Object(sourceObjectID)
		if !ok {
			return fmt.Errorf("Fork source Object %s is unavailable", sourceObjectIDText)
		}
		if sourceObject.ObjectType == 2 {
			continue
		}
		if sourceObject.ObjectType != 1 {
			return fmt.Errorf("Fork Object type %d re-authoring is not implemented by this Runtime", sourceObject.ObjectType)
		}
		sourceObjectEnvelopeBytes, _, err := readForkOpaque(artifacts, sourceState.ObjectStorageItemIDs[sourceObjectIDText])
		if err != nil {
			return err
		}
		openedObject, err := awsmcrypto.OpenCompactItem(sourceVaultID, sourceEpochID, sourceEpochKey, sourceObjectEnvelopeBytes)
		if err != nil || openedObject.PayloadType != 2 || !bytes.Equal(openedObject.PayloadBytes, sourceObject.Bytes) {
			return fmt.Errorf("Fork source Object %s is not authenticated", sourceObjectIDText)
		}
		destinationObjectBytes, err := rebuildForkBundleDescriptor(sourceObject, creation.IDs.VaultID, creation.RequiredFeatureSetID, objectMappings, bundleMappings)
		if err != nil {
			return fmt.Errorf("rebuild Fork Bundle Descriptor %s: %w", sourceObjectIDText, err)
		}
		destinationObjectID, err := canonical.VaultObjectID(creation.IDs.VaultID, 1, destinationObjectBytes)
		if err != nil {
			return fmt.Errorf("derive Fork Bundle Descriptor identity: %w", err)
		}
		if destinationObjectID == sourceObjectID {
			return errors.New("Fork Bundle Descriptor identity was not fresh")
		}
		destinationEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: creation.IDs.VaultID, KeyEpochID: creation.KeyEpochID, KeyEpochKey: creation.KeyEpochKey,
			PayloadType: 2, PayloadBytes: destinationObjectBytes,
		})
		if err != nil {
			return fmt.Errorf("protect Fork Bundle Descriptor %s: %w", sourceObjectIDText, err)
		}
		destinationEnvelope, err := storage.DecodeOpaqueEnvelope(destinationEnvelopeBytes)
		if err != nil {
			return fmt.Errorf("decode Fork Bundle Descriptor envelope: %w", err)
		}
		if err := storeOpaqueCreationItem(artifacts.Artifacts, destinationEnvelope.StorageItemID, destinationEnvelopeBytes); err != nil {
			return fmt.Errorf("store Fork Bundle Descriptor: %w", err)
		}
		state.ObjectStorageItemIDs[hexIdentifier(destinationObjectID)] = hexIdentifier(destinationEnvelope.StorageItemID)
		objectMappings[sourceObjectID] = destinationObjectID
		if err := destination.AdmitObject(destinationObjectID, destinationObjectBytes); err != nil {
			return fmt.Errorf("admit Fork Bundle Descriptor: %w", err)
		}
	}
	return nil
}

func rebuildForkBundleDescriptor(source ReplicaObject, destinationVaultID, requiredFeatureSetID canonical.Identifier, objectMappings map[canonical.Identifier]canonical.Identifier, bundleMappings map[canonical.Identifier]canonical.Identifier) ([]byte, error) {
	body, ok := replicaMapValue(source.Body)
	if !ok || !replicaMapHasKeys(body, 12) {
		return nil, errors.New("Bundle Descriptor body is invalid")
	}
	sourceBundleID, ok := replicaIdentifier(body, 1)
	if !ok {
		return nil, errors.New("Bundle Descriptor Bundle ID is invalid")
	}
	destinationBundleID, exists := bundleMappings[sourceBundleID]
	if !exists {
		textID, err := randomID()
		if err != nil {
			return nil, err
		}
		destinationBundleID, err = decodeHexIdentifier(textID)
		if err != nil {
			return nil, err
		}
		bundleMappings[sourceBundleID] = destinationBundleID
	}
	references, ok := replicaMapArray(body, 9)
	if !ok || len(references) == 0 {
		return nil, errors.New("Bundle Descriptor Artifact references are invalid")
	}
	mappedReferences := make([]canonical.Value, 0, len(references))
	for index, reference := range references {
		if !replicaMapHasKeys(reference, 2) {
			return nil, fmt.Errorf("Bundle Descriptor Artifact reference %d is invalid", index)
		}
		sourceObjectID, ok := replicaIdentifier(reference, 0)
		if !ok {
			return nil, fmt.Errorf("Bundle Descriptor Artifact reference %d identity is invalid", index)
		}
		destinationObjectID, ok := objectMappings[sourceObjectID]
		if !ok {
			return nil, fmt.Errorf("Bundle Descriptor Artifact reference %d is unavailable", index)
		}
		role, ok := replicaMapEntry(reference, 1)
		if !ok {
			return nil, fmt.Errorf("Bundle Descriptor Artifact reference %d role is invalid", index)
		}
		mappedReferences = append(mappedReferences, canonical.Map{0: destinationObjectID[:], 1: role})
	}
	rootValue, err := canonical.DecodeValue(source.Bytes)
	if err != nil {
		return nil, err
	}
	root, ok := replicaMapValue(rootValue)
	if !ok || !replicaMapHasKeys(root, 6) {
		return nil, errors.New("source Bundle Descriptor envelope is invalid")
	}
	rootExtensions, ok := replicaMapEntry(root, 5)
	if !ok {
		return nil, errors.New("source Bundle Descriptor extensions are unavailable")
	}
	newBody := canonical.Map{
		0: replicaMapEntryMust(body, 0), 1: destinationBundleID[:], 2: replicaMapEntryMust(body, 2), 3: replicaMapEntryMust(body, 3),
		4: replicaMapEntryMust(body, 4), 5: replicaMapEntryMust(body, 5), 6: replicaMapEntryMust(body, 6), 7: replicaMapEntryMust(body, 7),
		8: replicaMapEntryMust(body, 8), 9: mappedReferences, 10: replicaMapEntryMust(body, 10), 11: replicaMapEntryMust(body, 11),
	}
	encoded, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: destinationVaultID[:], 2: uint64(1), 3: requiredFeatureSetID[:], 4: newBody, 5: rootExtensions,
	})
	return encoded, err
}

func rebuildForkArtifactObject(source ReplicaObject, destinationVaultID, requiredFeatureSetID canonical.Identifier) ([]byte, error) {
	value, err := canonical.DecodeValue(source.Bytes)
	if err != nil {
		return nil, err
	}
	root, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(root, 6) {
		return nil, errors.New("source Object envelope is invalid")
	}
	extensions, ok := replicaMapEntry(root, 5)
	if !ok {
		return nil, errors.New("source Object extensions are unavailable")
	}
	return canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: destinationVaultID[:], 2: source.ObjectType, 3: requiredFeatureSetID[:], 4: source.Body, 5: extensions,
	})
}

func readForkOpaque(artifacts Dependencies, storageItemID string) ([]byte, storage.OpaqueEnvelope, error) {
	if !validDigest(storageItemID) || artifacts.Artifacts == nil {
		return nil, storage.OpaqueEnvelope{}, errors.New("Fork Storage Item identity is invalid")
	}
	reader, err := artifacts.Artifacts.Open(storageItemID)
	if err != nil {
		return nil, storage.OpaqueEnvelope{}, fmt.Errorf("Fork Storage Item %s is unavailable", storageItemID)
	}
	encoded, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if readErr != nil {
		return nil, storage.OpaqueEnvelope{}, fmt.Errorf("Fork Storage Item %s is unavailable", storageItemID)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil || hexIdentifier(envelope.StorageItemID) != storageItemID {
		return nil, storage.OpaqueEnvelope{}, fmt.Errorf("Fork Storage Item %s is invalid", storageItemID)
	}
	return encoded, envelope, nil
}

func cloneEventExtensions(values map[string][]byte) map[string][]byte {
	result := make(map[string][]byte, len(values))
	for key, value := range values {
		result[key] = append([]byte(nil), value...)
	}
	return result
}
