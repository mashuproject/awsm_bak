package vault

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// reauthorForkContentEvents re-authors the source's supported content closure
// against the destination Genesis. It deliberately does not copy Authority or
// Lifecycle history; every retained content identity and Object is rebuilt for
// the destination Vault.
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
		noteMappings := make(map[canonical.Identifier]canonical.Identifier)
		if err := reauthorForkArtifactObjects(source, destination, creation, state, sourceState, sourceVaultID, sourceEpochID, sourceEpochKey, objectMappings, artifacts); err != nil {
			return err
		}
		if err := reauthorForkNoteObjects(source, destination, creation, state, sourceState, sourceVaultID, sourceEpochID, sourceEpochKey, objectMappings, artifacts); err != nil {
			return err
		}
		if err := reauthorForkBundleObjects(source, destination, creation, state, sourceState, sourceVaultID, sourceEpochID, sourceEpochKey, objectMappings, bundleMappings, artifacts); err != nil {
			return err
		}
		return reauthorForkContentEventsWithMappings(source, destination, creation, state, objectMappings, bundleMappings, noteMappings, artifacts)
	}
	return reauthorForkContentEventsWithMappings(source, destination, creation, state, nil, nil, nil, artifacts)
}

func reauthorForkContentEventsWithMappings(
	source *Replica,
	destination *Replica,
	creation PreparedCanonicalVaultCreation,
	state *canonicalReplicaState,
	objectMappings map[canonical.Identifier]canonical.Identifier,
	bundleMappings map[canonical.Identifier]canonical.Identifier,
	noteMappings map[canonical.Identifier]canonical.Identifier,
	artifacts Dependencies,
) error {
	content := make([]canonical.Event, 0)
	for _, event := range source.Events() {
		if event.Family == canonical.ContentFamily {
			// Credential labels are shared presentation state, but the Fork
			// specification deliberately does not copy source credential labels.
			if event.Type == 2 {
				continue
			}
			if event.Type != 1 && event.Type != 3 && (event.Type < 4 || event.Type > 31) {
				return fmt.Errorf("Fork Content Event type %d re-authoring is not implemented by this Runtime", event.Type)
			}
			if event.Type == 1 && len(event.Dependencies) != 0 {
				return fmt.Errorf("Fork Content Event type %d re-authoring is not implemented by this Runtime", event.Type)
			}
			if event.Type >= 27 && event.Type <= 31 && (objectMappings == nil || noteMappings == nil) {
				return errors.New("Fork Note dependencies are unavailable")
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
	translated[source.baselineID] = creation.Genesis.RecordID
	translated[source.genesisID] = creation.Genesis.RecordID
	collectionMappings := make(map[canonical.Identifier]canonical.Identifier)
	folderMappings := make(map[canonical.Identifier]canonical.Identifier)
	tagMappings := make(map[canonical.Identifier]canonical.Identifier)
	tagAssignmentMappings := make(map[canonical.Identifier]canonical.Identifier)
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
				// Source credential labels are intentionally not retained in a
				// state-only Fork. Their ancestry is therefore replaced by the
				// fresh Genesis just like omitted Authority/Lifecycle history.
				if record, ok := source.Record(parent); ok && record.Event != nil &&
					record.Event.Family == canonical.ContentFamily && record.Event.Type == 2 {
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
			if sourceEvent.Type == 4 || sourceEvent.Type == 5 || sourceEvent.Type == 6 {
				mappedBody, mappedDependencies, err := reauthorForkCaptureEvent(sourceEvent, translated, bundleMappings, collectionMappings)
				if err != nil {
					cleanup()
					return err
				}
				body = mappedBody
				dependencies = mappedDependencies
			}
			if sourceEvent.Type >= 7 && sourceEvent.Type <= 26 {
				mappedBody, mappedDependencies, err := reauthorForkOrganizationEvent(sourceEvent, translated, bundleMappings, collectionMappings, folderMappings, tagMappings, tagAssignmentMappings)
				if err != nil {
					cleanup()
					return err
				}
				body = mappedBody
				dependencies = mappedDependencies
			}
			if sourceEvent.Type >= 27 && sourceEvent.Type <= 31 {
				if objectMappings == nil || bundleMappings == nil || noteMappings == nil {
					return errors.New("Fork Note dependencies are unavailable")
				}
				mappedBody, mappedDependencies, err := reauthorForkNoteEvent(sourceEvent, translated, objectMappings, bundleMappings, noteMappings, collectionMappings)
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
			bindStorageItemKeyEpoch(state, storageItemID, creation.KeyEpochID)
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

func reauthorForkCaptureEvent(
	event canonical.Event,
	translated map[canonical.Identifier]canonical.Identifier,
	bundleMappings map[canonical.Identifier]canonical.Identifier,
	collectionMappings map[canonical.Identifier]canonical.Identifier,
) (canonical.Value, []canonical.Dependency, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok {
		return nil, nil, fmt.Errorf("Fork capture Content Event type %d body is invalid", event.Type)
	}
	mapBundle := func(source canonical.Identifier) (canonical.Identifier, error) {
		mapped, exists := bundleMappings[source]
		if !exists {
			return canonical.Identifier{}, fmt.Errorf("Fork capture Event type %d Bundle %s is unavailable", event.Type, hexIdentifier(source))
		}
		return mapped, nil
	}
	freshCollection := func(source canonical.Identifier) (canonical.Identifier, error) {
		if mapped, exists := collectionMappings[source]; exists {
			return mapped, nil
		}
		textID, err := randomID()
		if err != nil {
			return canonical.Identifier{}, err
		}
		mapped, err := decodeHexIdentifier(textID)
		if err != nil {
			return canonical.Identifier{}, err
		}
		if mapped == source {
			return canonical.Identifier{}, errors.New("Fork Collection identity was not fresh")
		}
		collectionMappings[source] = mapped
		return mapped, nil
	}
	mapBundleSet := func(value canonical.Value) ([]canonical.Value, error) {
		values, err := parseCanonicalIdentifierSet(value, "Fork capture Bundle IDs", true)
		if err != nil {
			return nil, err
		}
		mapped := make([]canonical.Identifier, 0, len(values))
		for _, source := range values {
			destination, mapErr := mapBundle(source)
			if mapErr != nil {
				return nil, mapErr
			}
			mapped = append(mapped, destination)
		}
		return identifiersToValues(sortUniqueIdentifiers(mapped)), nil
	}
	noDependencies := func() ([]canonical.Dependency, error) {
		if len(event.Dependencies) != 0 {
			return nil, fmt.Errorf("Fork capture Content Event type %d has unexpected dependencies", event.Type)
		}
		return nil, nil
	}
	switch event.Type {
	case 4, 5:
		if !replicaMapHasKeys(body, 1) {
			return nil, nil, fmt.Errorf("Fork capture Content Event type %d body is invalid", event.Type)
		}
		bundles, err := mapBundleSet(replicaMapEntryMust(body, 0))
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: bundles}, dependencies, depErr
	case 6:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Captures Moved body is invalid")
		}
		entries, ok := replicaMapArrayValue(replicaMapEntryMust(body, 0))
		if !ok || len(entries) == 0 {
			return nil, nil, errors.New("Fork Captures Moved entries are invalid")
		}
		mappedEntries := make([]canonical.Value, 0, len(entries))
		for index, entry := range entries {
			if !replicaMapHasKeys(entry, 3) {
				return nil, nil, fmt.Errorf("Fork Captures Moved entry %d is invalid", index)
			}
			bundle, ok := replicaIdentifier(entry, 0)
			if !ok {
				return nil, nil, fmt.Errorf("Fork Captures Moved entry %d Bundle ID is invalid", index)
			}
			from, ok := replicaIdentifier(entry, 1)
			if !ok {
				return nil, nil, fmt.Errorf("Fork Captures Moved entry %d source Collection ID is invalid", index)
			}
			to, ok := replicaIdentifier(entry, 2)
			if !ok {
				return nil, nil, fmt.Errorf("Fork Captures Moved entry %d destination Collection ID is invalid", index)
			}
			mappedBundle, err := mapBundle(bundle)
			if err != nil {
				return nil, nil, err
			}
			mappedFrom, err := freshCollection(from)
			if err != nil {
				return nil, nil, err
			}
			mappedTo, err := freshCollection(to)
			if err != nil {
				return nil, nil, err
			}
			mappedEntries = append(mappedEntries, canonical.Map{0: mappedBundle[:], 1: mappedFrom[:], 2: mappedTo[:]})
		}
		sort.Slice(mappedEntries, func(left, right int) bool {
			leftID, _ := replicaIdentifier(mappedEntries[left], 0)
			rightID, _ := replicaIdentifier(mappedEntries[right], 0)
			return bytes.Compare(leftID[:], rightID[:]) < 0
		})
		var mappedCause canonical.Value
		cause := replicaMapEntryMust(body, 1)
		if cause != nil {
			sourceCause, ok := replicaIdentifierValue(cause)
			if !ok {
				return nil, nil, errors.New("Fork Captures Moved revert Cause ID is invalid")
			}
			mapped, exists := translated[sourceCause]
			if !exists {
				return nil, nil, fmt.Errorf("Fork Captures Moved revert Cause %s is unavailable", hexIdentifier(sourceCause))
			}
			mappedCause = mapped[:]
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedEntries, 1: mappedCause}, dependencies, depErr
	default:
		return nil, nil, fmt.Errorf("Fork capture Content Event type %d is not supported", event.Type)
	}
}

func reauthorForkOrganizationEvent(
	event canonical.Event,
	translated map[canonical.Identifier]canonical.Identifier,
	bundleMappings map[canonical.Identifier]canonical.Identifier,
	collectionMappings map[canonical.Identifier]canonical.Identifier,
	folderMappings map[canonical.Identifier]canonical.Identifier,
	tagMappings map[canonical.Identifier]canonical.Identifier,
	tagAssignmentMappings map[canonical.Identifier]canonical.Identifier,
) (canonical.Value, []canonical.Dependency, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok {
		return nil, nil, fmt.Errorf("Fork organization Content Event type %d body is invalid", event.Type)
	}
	fresh := func(source canonical.Identifier, field string) (canonical.Identifier, error) {
		textID, err := randomID()
		if err != nil {
			return canonical.Identifier{}, err
		}
		mapped, err := decodeHexIdentifier(textID)
		if err != nil {
			return canonical.Identifier{}, err
		}
		if mapped == source {
			return canonical.Identifier{}, fmt.Errorf("Fork %s identity was not fresh", field)
		}
		return mapped, nil
	}
	mapID := func(source canonical.Identifier, mappings map[canonical.Identifier]canonical.Identifier, field string) (canonical.Identifier, error) {
		if mapped, exists := mappings[source]; exists {
			return mapped, nil
		}
		mapped, err := fresh(source, field)
		if err != nil {
			return canonical.Identifier{}, err
		}
		mappings[source] = mapped
		return mapped, nil
	}
	mapCollection := func(source canonical.Identifier) (canonical.Identifier, error) {
		return mapID(source, collectionMappings, "Collection")
	}
	mapFolder := func(source canonical.Identifier) (canonical.Identifier, error) {
		return mapID(source, folderMappings, "Folder")
	}
	mapTag := func(source canonical.Identifier) (canonical.Identifier, error) {
		return mapID(source, tagMappings, "Tag")
	}
	mapAssignment := func(source canonical.Identifier) (canonical.Identifier, error) {
		return mapID(source, tagAssignmentMappings, "Tag Assignment")
	}
	mapBundle := func(source canonical.Identifier) (canonical.Identifier, error) {
		return mapID(source, bundleMappings, "Bundle")
	}
	mapCause := func(source canonical.Identifier) (canonical.Identifier, error) {
		mapped, exists := translated[source]
		if !exists {
			return canonical.Identifier{}, fmt.Errorf("Fork Content Event type %d Cause %s is unavailable", event.Type, hexIdentifier(source))
		}
		return mapped, nil
	}
	mapCauseSet := func(value canonical.Value, field string) ([]canonical.Value, error) {
		values, err := parseCanonicalIdentifierSet(value, field, true)
		if err != nil {
			return nil, err
		}
		mapped := make([]canonical.Identifier, 0, len(values))
		for _, source := range values {
			destination, mapErr := mapCause(source)
			if mapErr != nil {
				return nil, mapErr
			}
			mapped = append(mapped, destination)
		}
		return identifiersToValues(sortUniqueIdentifiers(mapped)), nil
	}
	mapIDSet := func(value canonical.Value, field string, mapper func(canonical.Identifier) (canonical.Identifier, error)) ([]canonical.Value, error) {
		values, err := parseCanonicalIdentifierSet(value, field, true)
		if err != nil {
			return nil, err
		}
		mapped := make([]canonical.Identifier, 0, len(values))
		for _, source := range values {
			destination, mapErr := mapper(source)
			if mapErr != nil {
				return nil, mapErr
			}
			mapped = append(mapped, destination)
		}
		return identifiersToValues(sortUniqueIdentifiers(mapped)), nil
	}
	mapNullable := func(value canonical.Value, field string, mapper func(canonical.Identifier) (canonical.Identifier, error)) (canonical.Value, error) {
		if value == nil {
			return nil, nil
		}
		source, ok := replicaIdentifierValue(value)
		if !ok {
			return nil, fmt.Errorf("Fork %s is invalid", field)
		}
		destination, err := mapper(source)
		if err != nil {
			return nil, err
		}
		return destination[:], nil
	}
	mapTarget := func(value canonical.Value) (canonical.Value, error) {
		if !replicaMapHasKeys(value, 2) {
			return nil, errors.New("Fork organization target is invalid")
		}
		kind, ok := replicaUnsignedNumber(replicaMapEntryMust(value, 0))
		if !ok || (kind != 1 && kind != 2) {
			return nil, errors.New("Fork organization target kind is invalid")
		}
		source, ok := replicaIdentifierValue(replicaMapEntryMust(value, 1))
		if !ok {
			return nil, errors.New("Fork organization target ID is invalid")
		}
		var destination canonical.Identifier
		var err error
		if kind == 1 {
			destination, err = mapCollection(source)
		} else {
			destination, err = mapBundle(source)
		}
		if err != nil {
			return nil, err
		}
		return canonical.Map{0: kind, 1: destination[:]}, nil
	}
	mapRedirects := func(value canonical.Value, field string, mapper func(canonical.Identifier) (canonical.Identifier, error)) (canonical.Value, error) {
		entries, ok := replicaMapArrayValue(value)
		if !ok {
			return nil, fmt.Errorf("Fork %s redirects are invalid", field)
		}
		mapped := make([]canonical.Value, 0, len(entries))
		for index, entry := range entries {
			if !replicaMapHasKeys(entry, 2) {
				return nil, fmt.Errorf("Fork %s redirect %d is invalid", field, index)
			}
			source, sourceOK := replicaIdentifier(entry, 0)
			destination, destinationOK := replicaIdentifier(entry, 1)
			if !sourceOK || !destinationOK {
				return nil, fmt.Errorf("Fork %s redirect %d IDs are invalid", field, index)
			}
			mappedSource, err := mapper(source)
			if err != nil {
				return nil, err
			}
			mappedDestination, err := mapper(destination)
			if err != nil {
				return nil, err
			}
			mapped = append(mapped, canonical.Map{0: mappedSource[:], 1: mappedDestination[:]})
		}
		sort.Slice(mapped, func(left, right int) bool {
			leftBytes, _ := canonical.EncodeValue(mapped[left])
			rightBytes, _ := canonical.EncodeValue(mapped[right])
			return bytes.Compare(leftBytes, rightBytes) < 0
		})
		return mapped, nil
	}
	noDependencies := func() ([]canonical.Dependency, error) {
		if len(event.Dependencies) != 0 {
			return nil, fmt.Errorf("Fork organization Content Event type %d has unexpected dependencies", event.Type)
		}
		return nil, nil
	}
	switch event.Type {
	case 7:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Collection Title body is invalid")
		}
		source, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, errors.New("Fork Collection Title Collection ID is invalid")
		}
		destination, err := mapCollection(source)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: destination[:], 1: replicaMapEntryMust(body, 1)}, dependencies, depErr
	case 8:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Collections Merged body is invalid")
		}
		sources, err := mapIDSet(replicaMapEntryMust(body, 0), "Source Collection IDs", mapCollection)
		if err != nil {
			return nil, nil, err
		}
		destinationSource, ok := replicaIdentifier(body, 1)
		if !ok {
			return nil, nil, errors.New("Fork destination Collection ID is invalid")
		}
		destination, err := mapCollection(destinationSource)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: sources, 1: destination[:]}, dependencies, depErr
	case 9, 25:
		if !replicaMapHasKeys(body, 1) {
			return nil, nil, fmt.Errorf("Fork Content Event type %d body is invalid", event.Type)
		}
		cause, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, fmt.Errorf("Fork Content Event type %d Cause ID is invalid", event.Type)
		}
		mapped, err := mapCause(cause)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mapped[:]}, dependencies, depErr
	case 10, 26:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, fmt.Errorf("Fork Content Event type %d body is invalid", event.Type)
		}
		causes, err := mapCauseSet(replicaMapEntryMust(body, 0), "Conflict Cause IDs")
		if err != nil {
			return nil, nil, err
		}
		mapper := mapCollection
		if event.Type == 26 {
			mapper = mapTag
		}
		redirects, err := mapRedirects(replicaMapEntryMust(body, 1), "Conflict", mapper)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: causes, 1: redirects}, dependencies, depErr
	case 11:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Collection Folder Placement body is invalid")
		}
		collection, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, errors.New("Fork Collection Folder Placement Collection ID is invalid")
		}
		mappedCollection, err := mapCollection(collection)
		if err != nil {
			return nil, nil, err
		}
		mappedFolder, err := mapNullable(replicaMapEntryMust(body, 1), "Folder ID", mapFolder)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedCollection[:], 1: mappedFolder}, dependencies, depErr
	case 12:
		if !replicaMapHasKeys(body, 3) {
			return nil, nil, errors.New("Fork Folder Created body is invalid")
		}
		folder, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, errors.New("Fork Folder Created Folder ID is invalid")
		}
		mappedFolder, err := mapFolder(folder)
		if err != nil {
			return nil, nil, err
		}
		parent, err := mapNullable(replicaMapEntryMust(body, 2), "Parent Folder ID", mapFolder)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedFolder[:], 1: replicaMapEntryMust(body, 1), 2: parent}, dependencies, depErr
	case 13:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Folder Renamed body is invalid")
		}
		folder, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, errors.New("Fork Folder Renamed Folder ID is invalid")
		}
		mappedFolder, err := mapFolder(folder)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedFolder[:], 1: replicaMapEntryMust(body, 1)}, dependencies, depErr
	case 14:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Folder Parent Placement body is invalid")
		}
		folder, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, errors.New("Fork Folder Parent Placement Folder ID is invalid")
		}
		mappedFolder, err := mapFolder(folder)
		if err != nil {
			return nil, nil, err
		}
		parent, err := mapNullable(replicaMapEntryMust(body, 1), "Parent Folder ID", mapFolder)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedFolder[:], 1: parent}, dependencies, depErr
	case 15, 16:
		if !replicaMapHasKeys(body, 1) {
			return nil, nil, fmt.Errorf("Fork Folder Event type %d body is invalid", event.Type)
		}
		folder, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, fmt.Errorf("Fork Folder Event type %d Folder ID is invalid", event.Type)
		}
		mappedFolder, err := mapFolder(folder)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedFolder[:]}, dependencies, depErr
	case 17:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Folder Conflict Resolution body is invalid")
		}
		causes, err := mapCauseSet(replicaMapEntryMust(body, 0), "Conflicting Folder Cause IDs")
		if err != nil {
			return nil, nil, err
		}
		placements, ok := replicaMapArrayValue(replicaMapEntryMust(body, 1))
		if !ok {
			return nil, nil, errors.New("Fork Folder placements are invalid")
		}
		mapped := make([]canonical.Value, 0, len(placements))
		for _, entry := range placements {
			if !replicaMapHasKeys(entry, 2) {
				return nil, nil, errors.New("Fork Folder placement is invalid")
			}
			folder, ok := replicaIdentifier(entry, 0)
			if !ok {
				return nil, nil, errors.New("Fork Folder placement Folder ID is invalid")
			}
			mappedFolder, err := mapFolder(folder)
			if err != nil {
				return nil, nil, err
			}
			parent, err := mapNullable(replicaMapEntryMust(entry, 1), "Parent Folder ID", mapFolder)
			if err != nil {
				return nil, nil, err
			}
			mapped = append(mapped, canonical.Map{0: mappedFolder[:], 1: parent})
		}
		sort.Slice(mapped, func(left, right int) bool {
			leftID, _ := replicaIdentifier(mapped[left], 0)
			rightID, _ := replicaIdentifier(mapped[right], 0)
			return bytes.Compare(leftID[:], rightID[:]) < 0
		})
		dependencies, depErr := noDependencies()
		return canonical.Map{0: causes, 1: mapped}, dependencies, depErr
	case 18, 19:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, fmt.Errorf("Fork Tag Event type %d body is invalid", event.Type)
		}
		tag, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, fmt.Errorf("Fork Tag Event type %d Tag ID is invalid", event.Type)
		}
		mappedTag, err := mapTag(tag)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedTag[:], 1: replicaMapEntryMust(body, 1)}, dependencies, depErr
	case 20:
		if !replicaMapHasKeys(body, 3) {
			return nil, nil, errors.New("Fork Tag Assigned body is invalid")
		}
		assignment, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, errors.New("Fork Tag Assignment ID is invalid")
		}
		mappedAssignment, err := mapAssignment(assignment)
		if err != nil {
			return nil, nil, err
		}
		tag, ok := replicaIdentifier(body, 1)
		if !ok {
			return nil, nil, errors.New("Fork Tag ID is invalid")
		}
		mappedTag, err := mapTag(tag)
		if err != nil {
			return nil, nil, err
		}
		target, err := mapTarget(replicaMapEntryMust(body, 2))
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedAssignment[:], 1: mappedTag[:], 2: target}, dependencies, depErr
	case 21:
		if !replicaMapHasKeys(body, 1) {
			return nil, nil, errors.New("Fork Tag Removed body is invalid")
		}
		causes, err := mapCauseSet(replicaMapEntryMust(body, 0), "Tag Assignment Cause IDs")
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: causes}, dependencies, depErr
	case 22, 23:
		if !replicaMapHasKeys(body, 1) {
			return nil, nil, fmt.Errorf("Fork Tag Event type %d body is invalid", event.Type)
		}
		tag, ok := replicaIdentifier(body, 0)
		if !ok {
			return nil, nil, fmt.Errorf("Fork Tag Event type %d Tag ID is invalid", event.Type)
		}
		mappedTag, err := mapTag(tag)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: mappedTag[:]}, dependencies, depErr
	case 24:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, errors.New("Fork Tags Merged body is invalid")
		}
		sources, err := mapIDSet(replicaMapEntryMust(body, 0), "Source Tag IDs", mapTag)
		if err != nil {
			return nil, nil, err
		}
		destinationSource, ok := replicaIdentifier(body, 1)
		if !ok {
			return nil, nil, errors.New("Fork destination Tag ID is invalid")
		}
		destination, err := mapTag(destinationSource)
		if err != nil {
			return nil, nil, err
		}
		dependencies, depErr := noDependencies()
		return canonical.Map{0: sources, 1: destination[:]}, dependencies, depErr
	default:
		return nil, nil, fmt.Errorf("Fork organization Content Event type %d is not supported", event.Type)
	}
}

func reauthorForkNoteEvent(
	event canonical.Event,
	translated map[canonical.Identifier]canonical.Identifier,
	objectMappings map[canonical.Identifier]canonical.Identifier,
	bundleMappings map[canonical.Identifier]canonical.Identifier,
	noteMappings map[canonical.Identifier]canonical.Identifier,
	collectionMappings map[canonical.Identifier]canonical.Identifier,
) (canonical.Value, []canonical.Dependency, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok {
		return nil, nil, fmt.Errorf("Fork Note Event type %d body is invalid", event.Type)
	}
	fresh := func() (canonical.Identifier, error) {
		textID, err := randomID()
		if err != nil {
			return canonical.Identifier{}, err
		}
		return decodeHexIdentifier(textID)
	}
	mapNote := func(source canonical.Identifier) (canonical.Identifier, error) {
		if mapped, exists := noteMappings[source]; exists {
			return mapped, nil
		}
		mapped, err := fresh()
		if err != nil {
			return canonical.Identifier{}, err
		}
		if mapped == source {
			return canonical.Identifier{}, errors.New("Fork Note identity was not fresh")
		}
		noteMappings[source] = mapped
		return mapped, nil
	}
	mapCollection := func(source canonical.Identifier) (canonical.Identifier, error) {
		if mapped, exists := collectionMappings[source]; exists {
			return mapped, nil
		}
		mapped, err := fresh()
		if err != nil {
			return canonical.Identifier{}, err
		}
		collectionMappings[source] = mapped
		return mapped, nil
	}
	mapBundle := func(source canonical.Identifier) (canonical.Identifier, error) {
		if mapped, exists := bundleMappings[source]; exists {
			return mapped, nil
		}
		mapped, err := fresh()
		if err != nil {
			return canonical.Identifier{}, err
		}
		bundleMappings[source] = mapped
		return mapped, nil
	}
	mapCause := func(source canonical.Identifier) (canonical.Identifier, error) {
		mapped, exists := translated[source]
		if !exists {
			return canonical.Identifier{}, fmt.Errorf("Fork Note Cause %s is unavailable", hexIdentifier(source))
		}
		return mapped, nil
	}
	mapCauseSet := func(value canonical.Value, field string) ([]canonical.Value, error) {
		values, ok := replicaMapArrayValue(value)
		if !ok || len(values) == 0 {
			return nil, fmt.Errorf("%s is invalid", field)
		}
		mapped := make([]canonical.Value, len(values))
		for index, value := range values {
			source, ok := replicaIdentifierValue(value)
			if !ok {
				return nil, fmt.Errorf("%s contains an invalid Cause ID", field)
			}
			destination, err := mapCause(source)
			if err != nil {
				return nil, err
			}
			mapped[index] = destination[:]
		}
		sort.Slice(mapped, func(left, right int) bool {
			leftID, _ := replicaIdentifierValue(mapped[left])
			rightID, _ := replicaIdentifierValue(mapped[right])
			return bytes.Compare(leftID[:], rightID[:]) < 0
		})
		return mapped, nil
	}
	mapObjectDependencies := func(dependencies []canonical.Dependency) ([]canonical.Dependency, error) {
		mapped := make([]canonical.Dependency, len(dependencies))
		for index, dependency := range dependencies {
			if dependency.Type != 6 {
				return nil, fmt.Errorf("Fork Note dependency type %d is not supported", dependency.Type)
			}
			destination, ok := objectMappings[dependency.ID]
			if !ok {
				return nil, fmt.Errorf("Fork Note Content Object %s is unavailable", hexIdentifier(dependency.ID))
			}
			mapped[index] = canonical.Dependency{Type: dependency.Type, ID: destination}
		}
		sort.Slice(mapped, func(left, right int) bool { return bytes.Compare(mapped[left].ID[:], mapped[right].ID[:]) < 0 })
		return mapped, nil
	}
	mapTarget := func(value canonical.Value) (canonical.Value, error) {
		target, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(target, 2) {
			return nil, errors.New("Fork Note target is invalid")
		}
		kind, ok := replicaMapNumber(target, 0)
		if !ok || (kind != 1 && kind != 2) {
			return nil, errors.New("Fork Note target kind is invalid")
		}
		source, ok := replicaIdentifier(target, 1)
		if !ok {
			return nil, errors.New("Fork Note target identity is invalid")
		}
		var destination canonical.Identifier
		var err error
		if kind == 1 {
			destination, err = mapCollection(source)
		} else {
			destination, err = mapBundle(source)
		}
		if err != nil {
			return nil, err
		}
		return canonical.Map{0: kind, 1: destination[:]}, nil
	}
	noteID, ok := replicaIdentifier(body, 0)
	if !ok {
		return nil, nil, fmt.Errorf("Fork Note Event type %d Note ID is invalid", event.Type)
	}
	destinationNoteID, err := mapNote(noteID)
	if err != nil {
		return nil, nil, err
	}
	switch event.Type {
	case 27:
		if !replicaMapHasKeys(body, 3) {
			return nil, nil, errors.New("Fork Note Created body is invalid")
		}
		target, err := mapTarget(replicaMapEntryMust(body, 1))
		if err != nil {
			return nil, nil, err
		}
		contentObjectID, ok := replicaIdentifier(body, 2)
		if !ok {
			return nil, nil, errors.New("Fork Note Created Content Object ID is invalid")
		}
		destinationObjectID, ok := objectMappings[contentObjectID]
		if !ok {
			return nil, nil, errors.New("Fork Note Created Content Object mapping is unavailable")
		}
		if len(event.Dependencies) != 1 || event.Dependencies[0].Type != 6 || event.Dependencies[0].ID != contentObjectID {
			return nil, nil, errors.New("Fork Note Created dependencies do not match its Content Object")
		}
		dependencies, err := mapObjectDependencies(event.Dependencies)
		if err != nil {
			return nil, nil, err
		}
		return canonical.Map{0: destinationNoteID[:], 1: target, 2: destinationObjectID[:]}, dependencies, nil
	case 28:
		if !replicaMapHasKeys(body, 3) {
			return nil, nil, errors.New("Fork Note Revised body is invalid")
		}
		heads, err := mapCauseSet(replicaMapEntryMust(body, 1), "Fork Note Revised Cause IDs")
		if err != nil {
			return nil, nil, err
		}
		contentObjectID, ok := replicaIdentifier(body, 2)
		if !ok {
			return nil, nil, errors.New("Fork Note Revised Content Object ID is invalid")
		}
		destinationObjectID, ok := objectMappings[contentObjectID]
		if !ok {
			return nil, nil, errors.New("Fork Note Revised Content Object mapping is unavailable")
		}
		if len(event.Dependencies) != 1 || event.Dependencies[0].Type != 6 || event.Dependencies[0].ID != contentObjectID {
			return nil, nil, errors.New("Fork Note Revised dependencies do not match its Content Object")
		}
		dependencies, err := mapObjectDependencies(event.Dependencies)
		if err != nil {
			return nil, nil, err
		}
		return canonical.Map{0: destinationNoteID[:], 1: heads, 2: destinationObjectID[:]}, dependencies, nil
	case 29, 30:
		if !replicaMapHasKeys(body, 2) {
			return nil, nil, fmt.Errorf("Fork Note Event type %d body is invalid", event.Type)
		}
		heads, err := mapCauseSet(replicaMapEntryMust(body, 1), "Fork Note Cause IDs")
		if err != nil {
			return nil, nil, err
		}
		if len(event.Dependencies) != 0 {
			return nil, nil, fmt.Errorf("Fork Note Event type %d must not have dependencies", event.Type)
		}
		return canonical.Map{0: destinationNoteID[:], 1: heads}, nil, nil
	case 31:
		if !replicaMapHasKeys(body, 4) {
			return nil, nil, errors.New("Fork Note Conflict Resolution body is invalid")
		}
		heads, err := mapCauseSet(replicaMapEntryMust(body, 1), "Fork Note Conflict Cause IDs")
		if err != nil {
			return nil, nil, err
		}
		var retained canonical.Value
		if raw := replicaMapEntryMust(body, 2); raw != nil {
			contentObjectID, ok := replicaIdentifierValue(raw)
			if !ok {
				return nil, nil, errors.New("Fork Note retained Content Object ID is invalid")
			}
			destinationObjectID, ok := objectMappings[contentObjectID]
			if !ok {
				return nil, nil, errors.New("Fork Note retained Content Object mapping is unavailable")
			}
			retained = destinationObjectID[:]
		}
		splits, ok := replicaMapArray(body, 3)
		if !ok {
			return nil, nil, errors.New("Fork Note split Notes are invalid")
		}
		mappedSplits := make([]canonical.Value, len(splits))
		for index, value := range splits {
			split, ok := replicaMapValue(value)
			if !ok || !replicaMapHasKeys(split, 2) {
				return nil, nil, fmt.Errorf("Fork Note split Note %d is invalid", index)
			}
			sourceSplitID, ok := replicaIdentifier(split, 0)
			if !ok {
				return nil, nil, fmt.Errorf("Fork Note split Note %d ID is invalid", index)
			}
			destinationSplitID, err := mapNote(sourceSplitID)
			if err != nil {
				return nil, nil, err
			}
			contentObjectID, ok := replicaIdentifier(split, 1)
			if !ok {
				return nil, nil, fmt.Errorf("Fork Note split Note %d Content Object ID is invalid", index)
			}
			destinationObjectID, ok := objectMappings[contentObjectID]
			if !ok {
				return nil, nil, fmt.Errorf("Fork Note split Note %d Content Object mapping is unavailable", index)
			}
			mappedSplits[index] = canonical.Map{0: destinationSplitID[:], 1: destinationObjectID[:]}
		}
		sort.Slice(mappedSplits, func(left, right int) bool {
			leftID, _ := replicaIdentifier(mappedSplits[left], 0)
			rightID, _ := replicaIdentifier(mappedSplits[right], 0)
			return bytes.Compare(leftID[:], rightID[:]) < 0
		})
		expectedObjectIDs := make(map[canonical.Identifier]struct{})
		if raw := replicaMapEntryMust(body, 2); raw != nil {
			retainedID, _ := replicaIdentifierValue(raw)
			expectedObjectIDs[retainedID] = struct{}{}
		}
		for _, value := range splits {
			split, _ := replicaMapValue(value)
			contentID, _ := replicaIdentifier(split, 1)
			expectedObjectIDs[contentID] = struct{}{}
		}
		if len(event.Dependencies) != len(expectedObjectIDs) {
			return nil, nil, errors.New("Fork Note Conflict Resolution dependencies do not match its Content Objects")
		}
		for _, dependency := range event.Dependencies {
			if dependency.Type != 6 {
				return nil, nil, fmt.Errorf("Fork Note dependency type %d is not supported", dependency.Type)
			}
			if _, expected := expectedObjectIDs[dependency.ID]; !expected {
				return nil, nil, errors.New("Fork Note Conflict Resolution has an unexpected Content Object dependency")
			}
		}
		dependencies, err := mapObjectDependencies(event.Dependencies)
		if err != nil {
			return nil, nil, err
		}
		return canonical.Map{0: destinationNoteID[:], 1: heads, 2: retained, 3: mappedSplits}, dependencies, nil
	default:
		return nil, nil, fmt.Errorf("Fork Content Event type %d is not a Note Event", event.Type)
	}
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
	if len(dependencies) != 1 || dependencies[0].Type != 4 || dependencies[0].ID != sourceDescriptorID {
		return nil, nil, errors.New("Fork Bundle Registered dependencies are not the canonical Descriptor dependency")
	}
	mappedDependencies := []canonical.Dependency{{Type: 4, ID: destinationDescriptorID}}
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
		destinationObjectStorageID := hexIdentifier(destinationObjectEnvelope.StorageItemID)
		state.ObjectStorageItemIDs[hexIdentifier(destinationObjectID)] = destinationObjectStorageID
		bindStorageItemKeyEpoch(state, destinationObjectStorageID, creation.KeyEpochID)
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
		destinationArtifactStorageID := hexIdentifier(destinationArtifactEnvelope.StorageItemID)
		state.ArtifactStorageItemIDs[hexIdentifier(destinationObjectID)] = destinationArtifactStorageID
		bindStorageItemKeyEpoch(state, destinationArtifactStorageID, creation.KeyEpochID)
	}
	for sourceArtifactIDText := range sourceState.ArtifactStorageItemIDs {
		if _, ok := sourceState.ObjectStorageItemIDs[sourceArtifactIDText]; !ok {
			cleanup()
			return fmt.Errorf("Fork source Artifact Object %s is unavailable", sourceArtifactIDText)
		}
	}
	return nil
}

func reauthorForkNoteObjects(
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
	if state.ObjectStorageItemIDs == nil {
		state.ObjectStorageItemIDs = map[string]string{}
	}
	stored := make([]string, 0)
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
		if sourceObject.ObjectType != 3 {
			continue
		}
		if err := validateForkNoteContentBody(sourceObject.Body); err != nil {
			cleanup()
			return fmt.Errorf("Fork source Note Content Object %s is invalid: %w", sourceObjectIDText, err)
		}
		sourceObjectEnvelopeBytes, _, err := readForkOpaque(artifacts, sourceState.ObjectStorageItemIDs[sourceObjectIDText])
		if err != nil {
			cleanup()
			return err
		}
		openedObject, err := awsmcrypto.OpenCompactItem(sourceVaultID, sourceEpochID, sourceEpochKey, sourceObjectEnvelopeBytes)
		if err != nil || openedObject.PayloadType != 2 || !bytes.Equal(openedObject.PayloadBytes, sourceObject.Bytes) {
			cleanup()
			return fmt.Errorf("Fork source Note Content Object %s is not authenticated", sourceObjectIDText)
		}
		destinationObjectBytes, err := rebuildForkNoteObject(sourceObject, creation.IDs.VaultID, creation.RequiredFeatureSetID)
		if err != nil {
			cleanup()
			return fmt.Errorf("rebuild Fork Note Content Object %s: %w", sourceObjectIDText, err)
		}
		destinationObjectID, err := canonical.VaultObjectID(creation.IDs.VaultID, 3, destinationObjectBytes)
		if err != nil {
			cleanup()
			return fmt.Errorf("derive Fork Note Content Object identity: %w", err)
		}
		if destinationObjectID == sourceObjectID {
			cleanup()
			return errors.New("Fork Note Content Object identity was not fresh")
		}
		destinationEnvelopeBytes, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: creation.IDs.VaultID, KeyEpochID: creation.KeyEpochID, KeyEpochKey: creation.KeyEpochKey,
			PayloadType: 2, PayloadBytes: destinationObjectBytes,
		})
		if err != nil {
			cleanup()
			return fmt.Errorf("protect Fork Note Content Object %s: %w", sourceObjectIDText, err)
		}
		destinationEnvelope, err := storage.DecodeOpaqueEnvelope(destinationEnvelopeBytes)
		if err != nil {
			cleanup()
			return fmt.Errorf("decode Fork Note Content Object envelope: %w", err)
		}
		if err := storeOpaqueCreationItem(artifacts.Artifacts, destinationEnvelope.StorageItemID, destinationEnvelopeBytes); err != nil {
			cleanup()
			return fmt.Errorf("store Fork Note Content Object: %w", err)
		}
		stored = append(stored, hexIdentifier(destinationEnvelope.StorageItemID))
		if err := destination.AdmitObject(destinationObjectID, destinationObjectBytes); err != nil {
			cleanup()
			return fmt.Errorf("admit Fork Note Content Object: %w", err)
		}
		destinationStorageID := hexIdentifier(destinationEnvelope.StorageItemID)
		state.ObjectStorageItemIDs[hexIdentifier(destinationObjectID)] = destinationStorageID
		bindStorageItemKeyEpoch(state, destinationStorageID, creation.KeyEpochID)
		objectMappings[sourceObjectID] = destinationObjectID
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
		if sourceObject.ObjectType == 2 || sourceObject.ObjectType == 3 {
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
		destinationStorageID := hexIdentifier(destinationEnvelope.StorageItemID)
		state.ObjectStorageItemIDs[hexIdentifier(destinationObjectID)] = destinationStorageID
		bindStorageItemKeyEpoch(state, destinationStorageID, creation.KeyEpochID)
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

func rebuildForkNoteObject(source ReplicaObject, destinationVaultID, requiredFeatureSetID canonical.Identifier) ([]byte, error) {
	if source.ObjectType != 3 {
		return nil, errors.New("source Object is not a Note Content Object")
	}
	if err := validateForkNoteContentBody(source.Body); err != nil {
		return nil, err
	}
	value, err := canonical.DecodeValue(source.Bytes)
	if err != nil {
		return nil, err
	}
	root, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(root, 6) {
		return nil, errors.New("source Note Content Object envelope is invalid")
	}
	extensions, ok := replicaMapEntry(root, 5)
	if !ok {
		return nil, errors.New("source Note Content Object extensions are unavailable")
	}
	return canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: destinationVaultID[:], 2: uint64(3), 3: requiredFeatureSetID[:], 4: replicaMapEntryMust(root, 4), 5: extensions,
	})
}

func validateForkNoteContentBody(value canonical.Value) error {
	body, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(body, 4) {
		return errors.New("Note Content body is invalid")
	}
	format, ok := replicaMapNumber(body, 0)
	if !ok || format != 1 {
		return errors.New("Note Content format is invalid")
	}
	if title := replicaMapEntryMust(body, 1); title != nil {
		text, ok := title.(string)
		if !ok || !utf8.ValidString(text) || len([]byte(text)) > 1024 {
			return errors.New("Note title is invalid")
		}
	}
	noteBody, ok := replicaMapEntryMust(body, 2).(string)
	if !ok || !utf8.ValidString(noteBody) || strings.Contains(noteBody, "\r") || strings.Contains(noteBody, "data:") || strings.Contains(noteBody, "<") {
		return errors.New("Note body is invalid")
	}
	dialect, ok := replicaMapEntryMust(body, 3).(string)
	if !ok || dialect != "awsm.note.commonmark" {
		return errors.New("Note body dialect is invalid")
	}
	return nil
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
