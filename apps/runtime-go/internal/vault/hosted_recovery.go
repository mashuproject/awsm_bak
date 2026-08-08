package vault

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/completeexport"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

const hostedRecoveryMaxCompactOuterBytes = 16*1024*1024 + 4_108

type hostedRecoveryCompact struct {
	item  hostedInventoryItem
	bytes []byte
	epoch canonical.Identifier
}

type hostedRecoveryInventory struct {
	items   map[[32]byte]hostedInventoryItem
	compact map[[32]byte]hostedRecoveryCompact
}

type hostedRecoveryCandidate struct {
	replica       hostedReplicaSummary
	storageItemID [32]byte
	vaultID       canonical.Identifier
	epochID       canonical.Identifier
	epochKey      []byte
	recoveryID    canonical.Identifier
	revision      uint64
	envelopeBytes []byte
}

type hostedRecoveryObject struct {
	item  hostedRecoveryCompact
	id    canonical.Identifier
	bytes []byte
}

type hostedRecoveryFeature struct {
	item  hostedRecoveryCompact
	id    canonical.Identifier
	bytes []byte
}

type hostedRecoveryPrepared struct {
	value  preparedCompleteImport
	digest [32]byte
}

func (r *Runtime) recoverHostedMember(ctx context.Context, endpoint, username, password, phrase string) (any, error) {
	if err := validateEndpoint(endpoint); err != nil {
		return nil, err
	}
	if len(username) < 1 || len(username) > 256 || len(password) < 1 || len(password) > 1_024 {
		return nil, commandError("REMOTE_CREDENTIAL_INVALID", "Hosted Replica credentials are invalid.")
	}
	if _, err := awsmcrypto.DecodeRecoveryPhrase(phrase); err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase is invalid.")
	}
	session, err := signInHostedReplica(ctx, endpoint, username, password, r.deps.HTTPClient)
	if err != nil || session.Username != username {
		return nil, commandError("REMOTE_AUTHENTICATION_FAILED", "Hosted Replica sign-in failed.")
	}
	host, err := newHostedReplicaHTTP(endpoint, session.AccessToken, r.deps.HTTPClient)
	if err != nil {
		return nil, commandError("REMOTE_ENDPOINT_INVALID", "Hosted Replica endpoint is invalid.")
	}
	entropy, err := awsmcrypto.DecodeRecoveryPhrase(phrase)
	if err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase is invalid.")
	}
	recoveryKeys, err := awsmcrypto.DeriveRecoveryCredential(entropy)
	zeroBytes(entropy)
	if err != nil {
		return nil, commandError("RECOVERY_PHRASE_INVALID", "The Recovery Phrase could not derive its credential.")
	}
	defer wipeCredentialKeys(&recoveryKeys)
	replicas, err := host.listReplicas(ctx)
	if err != nil {
		return nil, commandError("REMOTE_LIST_FAILED", "The Hosted Replica list could not be read.")
	}
	sort.Slice(replicas, func(left, right int) bool { return replicas[left].ReplicaHandle < replicas[right].ReplicaHandle })
	prepared := make([]hostedRecoveryPrepared, 0)
	for _, replica := range replicas {
		if !hasHostedReplicaSyncCapabilities(replica.Capabilities) {
			continue
		}
		inventory, inventoryErr := readHostedRecoveryInventory(ctx, host, replica)
		if inventoryErr != nil {
			continue
		}
		candidate, candidateErr := findHostedRecoveryCandidate(inventory, replica, recoveryKeys)
		if candidateErr != nil {
			continue
		}
		candidateClosure, closureErr := prepareHostedRecoveryClosure(inventory, candidate, recoveryKeys)
		zeroBytes(candidate.epochKey)
		if closureErr != nil {
			continue
		}
		prepared = append(prepared, candidateClosure)
	}
	if len(prepared) == 0 {
		return nil, commandError("HOSTED_RECOVERY_NOT_FOUND", "No phrase-authenticated Vault closure was found on this Hosted Replica Account.")
	}
	selected := prepared[0]
	for _, candidate := range prepared[1:] {
		if candidate.digest != selected.digest {
			return nil, commandError("HOSTED_RECOVERY_CONFLICT", "The Hosted Replica Account contains divergent phrase-authenticated Vault closures.")
		}
	}
	return r.activateHostedRecovery(ctx, phrase, selected.value)
}

func readHostedRecoveryInventory(ctx context.Context, host *hostedReplicaHTTP, replica hostedReplicaSummary) (hostedRecoveryInventory, error) {
	result := hostedRecoveryInventory{
		items:   make(map[[32]byte]hostedInventoryItem),
		compact: make(map[[32]byte]hostedRecoveryCompact),
	}
	var cursor *int64
	var position *[32]byte
	seenPositions := make(map[[32]byte]struct{})
	for {
		page, err := host.inventory(ctx, replica.ReplicaHandle, cursor, position, 128)
		if err != nil {
			return hostedRecoveryInventory{}, err
		}
		if cursor == nil {
			value := page.SnapshotCursor
			cursor = &value
		} else if *cursor != page.SnapshotCursor {
			return hostedRecoveryInventory{}, errors.New("Hosted Recovery inventory changed its observed snapshot")
		}
		for _, item := range page.Items {
			if _, exists := result.items[item.StorageItemID]; exists {
				return hostedRecoveryInventory{}, errors.New("Hosted Recovery inventory repeats a Storage Item")
			}
			result.items[item.StorageItemID] = item
			if item.StorageClass != storage.CompactStorageClass {
				continue
			}
			if item.ByteLength < 1 || item.ByteLength > hostedRecoveryMaxCompactOuterBytes {
				return hostedRecoveryInventory{}, errors.New("Hosted Recovery Compact item exceeds its accepted bound")
			}
			encoded, err := host.item(ctx, replica.ReplicaHandle, item.StorageItemID, item.ByteLength)
			if err != nil {
				return hostedRecoveryInventory{}, err
			}
			envelope, err := storage.DecodeOpaqueEnvelope(encoded)
			if err != nil || envelope.StorageItemID != item.StorageItemID || envelope.CiphertextDigest != item.CipherDigest || int64(len(encoded)) != item.ByteLength {
				return hostedRecoveryInventory{}, errors.New("Hosted Recovery opaque bytes disagree with Host inventory metadata")
			}
			result.compact[item.StorageItemID] = hostedRecoveryCompact{item: item, bytes: encoded}
		}
		if page.NextPosition == nil {
			return result, nil
		}
		next := *page.NextPosition
		if _, exists := seenPositions[next]; exists {
			return hostedRecoveryInventory{}, errors.New("Hosted Recovery inventory repeats a page position")
		}
		seenPositions[next] = struct{}{}
		position = &next
	}
}

func findHostedRecoveryCandidate(inventory hostedRecoveryInventory, replica hostedReplicaSummary, recoveryKeys awsmcrypto.CredentialKeys) (hostedRecoveryCandidate, error) {
	var found *hostedRecoveryCandidate
	for storageID, compact := range inventory.compact {
		opened, err := awsmcrypto.OpenKeyEnvelope(awsmcrypto.RecoveryCredentialTarget, recoveryKeys.WrappingPrivateKey, compact.bytes)
		if err != nil {
			continue
		}
		if opened.TargetRevision == nil {
			zeroBytes(opened.KeyEpochKey)
			continue
		}
		candidate := hostedRecoveryCandidate{
			replica: replica, storageItemID: storageID, vaultID: opened.VaultID, epochID: opened.KeyEpochID,
			epochKey: append([]byte(nil), opened.KeyEpochKey...), recoveryID: opened.TargetCredentialID,
			revision: *opened.TargetRevision, envelopeBytes: append([]byte(nil), compact.bytes...),
		}
		zeroBytes(opened.KeyEpochKey)
		if found == nil {
			found = &candidate
			continue
		}
		if found.vaultID != candidate.vaultID || found.recoveryID != candidate.recoveryID || found.revision != candidate.revision {
			zeroBytes(candidate.epochKey)
			zeroBytes(found.epochKey)
			return hostedRecoveryCandidate{}, errors.New("Hosted Replica contains multiple Recovery credentials")
		}
		zeroBytes(candidate.epochKey)
	}
	if found == nil {
		return hostedRecoveryCandidate{}, errors.New("Hosted Replica has no phrase-openable Recovery Envelope")
	}
	return *found, nil
}

func prepareHostedRecoveryClosure(inventory hostedRecoveryInventory, candidate hostedRecoveryCandidate, recoveryKeys awsmcrypto.CredentialKeys) (hostedRecoveryPrepared, error) {
	candidateItem, ok := inventory.compact[candidate.storageItemID]
	if !ok || !bytes.Equal(candidateItem.bytes, candidate.envelopeBytes) {
		return hostedRecoveryPrepared{}, errors.New("Hosted Recovery candidate Envelope changed")
	}
	epochKeys := make(map[canonical.Identifier][]byte)
	keyEnvelopeEpochs := make(map[canonical.Identifier]canonical.Identifier)
	keyEnvelopeItems := make(map[canonical.Identifier]hostedRecoveryCompact)
	for storageID, compact := range inventory.compact {
		opened, err := awsmcrypto.OpenKeyEnvelope(awsmcrypto.RecoveryCredentialTarget, recoveryKeys.WrappingPrivateKey, compact.bytes)
		if err != nil || opened.TargetRevision == nil || opened.VaultID != candidate.vaultID || opened.TargetCredentialID != candidate.recoveryID || *opened.TargetRevision != candidate.revision {
			if err == nil {
				zeroBytes(opened.KeyEpochKey)
			}
			continue
		}
		if existing, exists := epochKeys[opened.KeyEpochID]; exists && !bytes.Equal(existing, opened.KeyEpochKey) {
			zeroBytes(opened.KeyEpochKey)
			return hostedRecoveryPrepared{}, errors.New("Hosted Recovery contains conflicting Key Epoch keys")
		}
		epochKeys[opened.KeyEpochID] = append([]byte(nil), opened.KeyEpochKey...)
		keyEnvelopeEpochs[opened.ID] = opened.KeyEpochID
		keyEnvelopeItems[opened.ID] = hostedRecoveryCompact{item: compact.item, bytes: append([]byte(nil), compact.bytes...), epoch: opened.KeyEpochID}
		zeroBytes(opened.KeyEpochKey)
		_ = storageID
	}
	if candidateKey, ok := epochKeys[candidate.epochID]; !ok || !bytes.Equal(candidateKey, candidate.epochKey) {
		return hostedRecoveryPrepared{}, errors.New("Hosted Recovery candidate Epoch key is not authenticated")
	}

	records := make(map[canonical.Identifier]canonical.Record)
	recordItems := make(map[canonical.Identifier]hostedRecoveryCompact)
	objects := make(map[canonical.Identifier]hostedRecoveryObject)
	features := make(map[canonical.Identifier]hostedRecoveryFeature)
	classify := func(compact hostedRecoveryCompact) error {
		for epochID, epochKey := range epochKeys {
			opened, err := awsmcrypto.OpenCompactItem(candidate.vaultID, epochID, epochKey, compact.bytes)
			if err != nil {
				continue
			}
			compact.epoch = epochID
			switch opened.PayloadType {
			case 1:
				record, err := canonical.DecodeRecord(opened.PayloadBytes)
				if err != nil || record.RecordID == (canonical.Identifier{}) || !hostedRecoveryLocatorMatches(candidate.replicasSalt(), hostedNamespaceRecord, record.RecordID, compact.item.Locator) {
					continue
				}
				if _, exists := records[record.RecordID]; exists {
					return errors.New("Hosted Recovery contains multiple opaque representations for one Record")
				}
				records[record.RecordID] = record
				recordItems[record.RecordID] = hostedRecoveryCompact{item: compact.item, bytes: append([]byte(nil), compact.bytes...), epoch: epochID}
				return nil
			case 2:
				objectID, err := hostedRecoveryObjectID(candidate.vaultID, opened.PayloadBytes)
				if err != nil || !hostedRecoveryLocatorMatches(candidate.replicasSalt(), hostedNamespaceObject, objectID, compact.item.Locator) {
					continue
				}
				if _, exists := objects[objectID]; exists {
					return errors.New("Hosted Recovery contains multiple opaque representations for one Object")
				}
				objects[objectID] = hostedRecoveryObject{item: compact, id: objectID, bytes: append([]byte(nil), opened.PayloadBytes...)}
				return nil
			case 3:
				featureID, err := canonical.FeatureManifestID(opened.PayloadBytes)
				if err != nil || !hostedRecoveryLocatorMatches(candidate.replicasSalt(), hostedNamespaceFeatureSet, featureID, compact.item.Locator) {
					continue
				}
				if _, exists := features[featureID]; exists {
					return errors.New("Hosted Recovery contains multiple opaque representations for one Feature Manifest")
				}
				features[featureID] = hostedRecoveryFeature{item: hostedRecoveryCompact{item: compact.item, bytes: append([]byte(nil), compact.bytes...), epoch: epochID}, id: featureID, bytes: append([]byte(nil), opened.PayloadBytes...)}
				return nil
			default:
				return nil
			}
		}
		return nil
	}
	for storageID, compact := range inventory.compact {
		knownKeyEnvelope := false
		for _, keyItem := range keyEnvelopeItems {
			if keyItem.item.StorageItemID == storageID {
				knownKeyEnvelope = true
				break
			}
		}
		if knownKeyEnvelope {
			continue
		}
		if err := classify(compact); err != nil {
			return hostedRecoveryPrepared{}, err
		}
	}
	if len(records) == 0 {
		return hostedRecoveryPrepared{}, errors.New("Hosted Recovery contains no authenticated Records")
	}
	baseline, err := selectHostedRecoveryBaseline(records)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	causalRoots, authorityRoots, err := hostedRecoveryRoots(records, baseline)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	preliminaryItems := make([]completeexport.OpaqueItem, 0, len(records))
	for id, record := range records {
		compact, ok := recordItems[id]
		if !ok {
			return hostedRecoveryPrepared{}, fmt.Errorf("Hosted Recovery Record %s has no physical representation", hexIdentifier(id))
		}
		_ = record
		preliminaryItems = append(preliminaryItems, completeexport.OpaqueItem{Namespace: 1, LogicalID: id, StorageItemID: compact.item.StorageItemID, KeyEpochID: compact.epoch, ByteLength: uint64(len(compact.bytes)), ByteDigest: sha256.Sum256(compact.bytes)})
	}
	preliminary, err := completeexport.NewManifest(completeexport.ManifestInput{
		VaultID: candidate.vaultID, GenerationID: baseline.GenerationID, Frontier: causalRoots,
		RequiredFeatureSetID: baseline.RequiredFeatureSetID,
		TypedLogicalRoots:    hostedRecoveryTypedRoots(causalRoots, baseline.RecordID),
		OpaqueItemInventory:  preliminaryItems, ContinuityProofRoots: authorityRoots,
	})
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	recordValues := make([]canonical.Record, 0, len(records))
	for _, record := range records {
		recordValues = append(recordValues, record)
	}
	_, _, replica, _, _, err := reconstructCompleteImportReplica(preliminary, baseline.RecordID, recordValues)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	for id, feature := range features {
		if err := replica.AdmitFeatureManifest(id, feature.bytes); err != nil {
			return hostedRecoveryPrepared{}, err
		}
	}
	for id, object := range objects {
		if err := replica.AdmitObject(id, object.bytes); err != nil {
			return hostedRecoveryPrepared{}, err
		}
	}
	authority, err := replayReplicaAuthorityState(replica, nil, nil)
	if err != nil || authority.featureSetConflict {
		return hostedRecoveryPrepared{}, errors.New("Hosted Recovery Authority State is invalid or conflicted")
	}
	for epochID := range authority.epochs {
		if _, ok := epochKeys[epochID]; !ok {
			return hostedRecoveryPrepared{}, errors.New("Hosted Recovery is missing an authenticated Key Epoch")
		}
	}
	state := replica.State()
	items := make([]completeexport.OpaqueItem, 0)
	entries := make([]completeexport.Entry, 0)
	add := func(namespace uint64, logicalID canonical.Identifier, compact hostedRecoveryCompact, epochID canonical.Identifier) error {
		if compact.item.StorageClass != storage.CompactStorageClass || len(compact.bytes) == 0 {
			return errors.New("Hosted Recovery reachable item is not Compact")
		}
		item := completeexport.OpaqueItem{Namespace: namespace, LogicalID: logicalID, StorageItemID: compact.item.StorageItemID, KeyEpochID: epochID, ByteLength: uint64(len(compact.bytes)), ByteDigest: sha256.Sum256(compact.bytes)}
		items = append(items, item)
		entry, err := completeexport.PrepareEntry(completeexport.OpaqueEntryKind, compact.bytes)
		if err != nil {
			return err
		}
		entries = append(entries, entry)
		return nil
	}
	for id, record := range records {
		compact, ok := recordItems[id]
		if !ok {
			return hostedRecoveryPrepared{}, fmt.Errorf("Hosted Recovery Record %s has no physical representation", hexIdentifier(id))
		}
		if err := add(1, id, compact, compact.epoch); err != nil {
			return hostedRecoveryPrepared{}, err
		}
		_ = record
	}
	for id, object := range objects {
		if err := add(3, id, object.item, object.item.epoch); err != nil {
			return hostedRecoveryPrepared{}, err
		}
	}
	for id, feature := range features {
		if err := add(4, id, feature.item, feature.item.epoch); err != nil {
			return hostedRecoveryPrepared{}, err
		}
	}
	for epochID, slots := range authority.epochSlots {
		for _, slot := range slots {
			keyEnvelopeEpochs[slot.envelopeID] = epochID
		}
	}
	for envelopeID, epochID := range keyEnvelopeEpochs {
		locator, err := deriveHostedReplicaLocator(candidate.replica.LocatorSalt, hostedNamespaceKeyEnvelope, envelopeID)
		if err != nil {
			return hostedRecoveryPrepared{}, err
		}
		matches := make([]hostedRecoveryCompact, 0, 1)
		for _, compact := range inventory.compact {
			if compact.item.Locator == locator {
				matches = append(matches, compact)
			}
		}
		if len(matches) != 1 {
			return hostedRecoveryPrepared{}, fmt.Errorf("Hosted Recovery Key Envelope %s is unavailable or ambiguous", hexIdentifier(envelopeID))
		}
		if err := add(2, envelopeID, matches[0], epochID); err != nil {
			return hostedRecoveryPrepared{}, err
		}
	}
	manifest, err := completeexport.NewManifest(completeexport.ManifestInput{
		VaultID: candidate.vaultID, GenerationID: state.GenerationID, Frontier: state.CausalFrontier,
		RequiredFeatureSetID: authority.featureSetID,
		TypedLogicalRoots:    hostedRecoveryTypedRoots(state.CausalFrontier, state.BaselineID),
		OpaqueItemInventory:  items, ContinuityProofRoots: state.AuthorityFrontier,
	})
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	manifestBytes, err := completeexport.EncodeManifest(manifest)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	manifestEntry, err := completeexport.PrepareEntry(completeexport.ManifestEntryKind, manifestBytes)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	keyEntries := make([]completeexport.KeyEpochEntry, 0, len(epochKeys))
	for epochID, key := range epochKeys {
		keyEntries = append(keyEntries, completeexport.KeyEpochEntry{KeyEpochID: epochID, KeyEpochKey: append([]byte(nil), key...)})
	}
	sort.Slice(keyEntries, func(left, right int) bool {
		return bytes.Compare(keyEntries[left].KeyEpochID[:], keyEntries[right].KeyEpochID[:]) < 0
	})
	keyInventory, err := completeexport.NewKeyInventory(completeexport.KeyInventoryInput{VaultID: candidate.vaultID, GenerationID: state.GenerationID, Entries: keyEntries})
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	keyInventoryBytes, err := completeexport.EncodeKeyInventory(keyInventory)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	keyInventoryEntry, err := completeexport.PrepareEntry(completeexport.KeyInventoryEntryKind, keyInventoryBytes)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	ordered := append([]completeexport.Entry{manifestEntry}, entries...)
	ordered = append(ordered, keyInventoryEntry)
	sort.Slice(ordered[1:len(ordered)-1], func(left, right int) bool {
		return bytes.Compare(ordered[left+1].Header.EntryID[:], ordered[right+1].Header.EntryID[:]) < 0
	})
	prepared, err := prepareCompleteImport(manifest, keyInventory, ordered)
	if err != nil {
		return hostedRecoveryPrepared{}, err
	}
	return hostedRecoveryPrepared{value: prepared, digest: manifest.StateDigest}, nil
}

func (c hostedRecoveryCandidate) replicasSalt() [32]byte { return c.replica.LocatorSalt }

func hostedRecoveryLocatorMatches(salt [32]byte, namespace byte, logicalID canonical.Identifier, actual [32]byte) bool {
	expected, err := deriveHostedReplicaLocator(salt, namespace, logicalID)
	return err == nil && expected == actual
}

func hostedRecoveryObjectID(vaultID canonical.Identifier, encoded []byte) (canonical.Identifier, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return canonical.Identifier{}, err
	}
	objectType, ok := replicaMapNumber(value, 2)
	if !ok {
		return canonical.Identifier{}, errors.New("Hosted Recovery Object type is invalid")
	}
	return canonical.VaultObjectID(vaultID, objectType, encoded)
}

func selectHostedRecoveryBaseline(records map[canonical.Identifier]canonical.Record) (canonical.Baseline, error) {
	baselines := make([]canonical.Baseline, 0)
	predecessorGenerations := make(map[canonical.Identifier]struct{})
	for _, record := range records {
		if record.Baseline != nil {
			baselines = append(baselines, *record.Baseline)
		}
		if record.Event != nil && record.Event.Family == canonical.LifecycleFamily && record.Event.Type == 1 {
			predecessorGenerations[record.Event.GenerationID] = struct{}{}
		}
	}
	current := make([]canonical.Baseline, 0, 1)
	for _, baseline := range baselines {
		if _, predecessor := predecessorGenerations[baseline.GenerationID]; !predecessor {
			current = append(current, baseline)
		}
	}
	if len(current) != 1 {
		return canonical.Baseline{}, errors.New("Hosted Recovery requires exactly one current Baseline")
	}
	return current[0], nil
}

func hostedRecoveryRoots(records map[canonical.Identifier]canonical.Record, baseline canonical.Baseline) ([]canonical.Identifier, []canonical.Identifier, error) {
	events := make([]canonical.Event, 0)
	for _, record := range records {
		if record.Event != nil && record.Event.GenerationID == baseline.GenerationID {
			events = append(events, *record.Event)
		}
	}
	frontier := hostedRecoveryEventFrontier(events, false)
	authorityEvents := make([]canonical.Event, 0)
	for _, event := range events {
		if event.Family != canonical.ContentFamily {
			authorityEvents = append(authorityEvents, event)
		}
	}
	if len(events) == 0 {
		frontier = []canonical.Identifier{baseline.RecordID}
	}
	authority := hostedRecoveryEventFrontier(authorityEvents, true)
	if len(authority) == 0 {
		for _, record := range records {
			if record.Event != nil && record.Event.Family == canonical.LifecycleFamily && record.Event.Type == 1 && hasDependency(record.Event.Dependencies, 2, baseline.RecordID) {
				authority = []canonical.Identifier{record.Event.RecordID}
				break
			}
		}
	}
	if len(frontier) == 0 || len(authority) == 0 {
		return nil, nil, errors.New("Hosted Recovery cannot derive authenticated Frontiers")
	}
	return frontier, authority, nil
}

func hostedRecoveryEventFrontier(events []canonical.Event, authority bool) []canonical.Identifier {
	if len(events) == 0 {
		return nil
	}
	parents := make(map[canonical.Identifier]struct{})
	for _, event := range events {
		values := event.ParentRecordIDs
		if authority {
			values = event.AuthorityParentIDs
		}
		for _, parent := range values {
			parents[parent] = struct{}{}
		}
	}
	frontier := make([]canonical.Identifier, 0)
	for _, event := range events {
		if _, parent := parents[event.RecordID]; !parent {
			frontier = append(frontier, event.RecordID)
		}
	}
	sort.Slice(frontier, func(left, right int) bool { return bytes.Compare(frontier[left][:], frontier[right][:]) < 0 })
	return frontier
}

func hostedRecoveryTypedRoots(frontier []canonical.Identifier, baseline canonical.Identifier) []canonical.Dependency {
	roots := make([]canonical.Dependency, 0, len(frontier)+1)
	for _, id := range frontier {
		roots = append(roots, canonical.Dependency{Type: 1, ID: id})
	}
	return append(roots, canonical.Dependency{Type: 2, ID: baseline})
}

func (r *Runtime) activateHostedRecovery(ctx context.Context, phrase string, prepared preparedCompleteImport) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.vaults[prepared.value.VaultID]; exists {
		return nil, commandError("VAULT_IDENTITY_COLLISION", "The recovered Vault already exists on this Client.")
	}
	if r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("COMPLETE_IMPORT_UNAVAILABLE", "This Client cannot recover a Vault without secure local storage.")
	}
	before := r.snapshotLocked()
	storedItems := make([]string, 0, len(prepared.items))
	cleanup := func() {
		for _, storageItemID := range storedItems {
			if decoded, err := decodeHexIdentifier(storageItemID); err == nil {
				deleteOpaqueCreationItem(r.deps.Artifacts, decoded)
			}
		}
		for _, secret := range prepared.secrets {
			_ = r.deps.Secrets.Delete(trustedSecretService, epochSecretAccount(prepared.value.VaultID, secret.epochID))
		}
	}
	for _, item := range prepared.items {
		storageID, err := decodeHexIdentifier(item.storageItemID)
		if err != nil || storeOpaqueCreationItem(r.deps.Artifacts, storageID, item.bytes) != nil {
			cleanup()
			return nil, commandError("COMPLETE_IMPORT_STORAGE_FAILED", "A Hosted Recovery item could not be stored locally.")
		}
		storedItems = append(storedItems, item.storageItemID)
	}
	for _, secret := range prepared.secrets {
		if err := r.deps.Secrets.Put(trustedSecretService, epochSecretAccount(prepared.value.VaultID, secret.epochID), secret.encoded); err != nil {
			r.restoreLocked(before)
			cleanup()
			return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "A recovered Key Epoch could not be protected locally.")
		}
	}
	r.vaults[prepared.value.VaultID] = &prepared.value
	r.replicas[prepared.value.VaultID] = prepared.replica
	r.selected = prepared.value.VaultID
	result, err := r.recoverMemberLocked(ctx, prepared.value.VaultID, phrase)
	if err != nil {
		r.restoreLocked(before)
		cleanup()
		return nil, err
	}
	return result, nil
}
