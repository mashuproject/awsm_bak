package vault

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/completeexport"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

type preparedCompleteExportEntry struct {
	inventory completeexport.OpaqueItem
	entry     completeexport.Entry
}

type artifactPayloadContract struct {
	PlaintextLength uint64
	PlaintextDigest [32]byte
}

type completeImportArtifact struct {
	item  completeexport.OpaqueItem
	bytes []byte
}

// ExportComplete produces the portable browser-compatible Complete Export for
// the authenticated local Replica. It only reads the source Vault and never
// includes the local Client Credential private key or Host-local state.
func (r *Runtime) ExportComplete(vaultID, passphrase string) ([]byte, error) {
	var salt [16]byte
	var nonce [24]byte
	if _, err := io.ReadFull(cryptorand.Reader, salt[:]); err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "A secure Complete Export salt could not be generated.")
	}
	if _, err := io.ReadFull(cryptorand.Reader, nonce[:]); err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "A secure Complete Export nonce could not be generated.")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.exportCompleteLocked(vaultID, passphrase, salt, nonce)
}

func (r *Runtime) exportCompleteExpected(vaultID, passphrase string) ([]byte, error) {
	var salt [16]byte
	var nonce [24]byte
	if _, err := io.ReadFull(cryptorand.Reader, salt[:]); err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "A secure Complete Export salt could not be generated.")
	}
	if _, err := io.ReadFull(cryptorand.Reader, nonce[:]); err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "A secure Complete Export nonce could not be generated.")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if err := r.requireExpectedLocked(&vaultID); err != nil {
		return nil, err
	}
	return r.exportCompleteLocked(vaultID, passphrase, salt, nonce)
}

// ImportComplete validates and installs a Complete Export as a readable local
// Replica. It deliberately does not import Account sessions, Recovery Phrase
// material, or a Client Credential private key; authoring is established later
// through ordinary Recovery or invitation enrollment.
func (r *Runtime) ImportComplete(ctx context.Context, passphrase string, encoded []byte) (ClientState, error) {
	opened, err := completeexport.OpenStream(passphrase, encoded)
	if err != nil {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "The Complete Export could not be opened.")
	}
	entries, err := parseCompleteExportEntries(opened.Plaintext)
	if err != nil {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "The Complete Export entry stream is invalid.")
	}
	if len(entries) < 3 {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "The Complete Export is incomplete.")
	}
	manifest, err := completeexport.DecodeManifest(entries[0].Bytes)
	if err != nil {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "The Complete Export Manifest is invalid.")
	}
	keyInventory, err := completeexport.DecodeKeyInventory(entries[len(entries)-1].Bytes)
	if err != nil {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "The Complete Export Key Inventory is invalid.")
	}
	if keyInventory.VaultID != manifest.VaultID || keyInventory.GenerationID != manifest.GenerationID {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "The Complete Export contexts do not match.")
	}
	prepared, err := prepareCompleteImport(manifest, keyInventory, entries)
	if err != nil {
		return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", err.Error())
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return ClientState{}, commandError("COMPLETE_IMPORT_UNAVAILABLE", "This Client cannot import a Vault without secure local storage.")
	}
	if _, exists := r.vaults[prepared.value.VaultID]; exists {
		return ClientState{}, commandError("VAULT_IDENTITY_COLLISION", "The destination already contains this Vault.")
	}
	before := r.snapshotLocked()
	storedItems := make([]string, 0, len(prepared.items))
	cleanup := func() {
		for _, storageItemID := range storedItems {
			_ = r.deps.Artifacts.Delete(storageItemID)
		}
		for _, secret := range prepared.secrets {
			_ = r.deps.Secrets.Delete(trustedSecretService, epochSecretAccount(prepared.value.VaultID, secret.epochID))
		}
	}
	for _, item := range prepared.items {
		storageIdentifier, decodeErr := decodeHexIdentifier(item.storageItemID)
		if decodeErr != nil {
			cleanup()
			return ClientState{}, commandError("COMPLETE_IMPORT_INVALID", "A Complete Export Storage Item identity is invalid.")
		}
		if err := storeOpaqueCreationItem(r.deps.Artifacts, storageIdentifier, item.bytes); err != nil {
			cleanup()
			return ClientState{}, commandError("COMPLETE_IMPORT_STORAGE_FAILED", "A Complete Export item could not be stored locally.")
		}
		storedItems = append(storedItems, item.storageItemID)
	}
	for _, secret := range prepared.secrets {
		if err := r.deps.Secrets.Put(trustedSecretService, epochSecretAccount(prepared.value.VaultID, secret.epochID), secret.encoded); err != nil {
			r.restoreLocked(before)
			cleanup()
			return ClientState{}, commandError("TRUSTED_SECRET_UNAVAILABLE", "An imported Key Epoch could not be protected locally.")
		}
	}
	r.vaults[prepared.value.VaultID] = &prepared.value
	r.replicas[prepared.value.VaultID] = prepared.replica
	r.selected = prepared.value.VaultID
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		cleanup()
		return ClientState{}, err
	}
	r.signal()
	return r.stateLocked(), nil
}

type completeImportItem struct {
	storageItemID string
	bytes         []byte
}

type completeImportSecret struct {
	epochID string
	encoded []byte
}

type preparedCompleteImport struct {
	value   persistedVault
	replica *Replica
	items   []completeImportItem
	secrets []completeImportSecret
}

func parseCompleteExportEntries(plaintext []byte) ([]completeexport.Entry, error) {
	entries := make([]completeexport.Entry, 0)
	offset := 0
	for offset < len(plaintext) {
		if len(plaintext)-offset < 4 {
			return nil, errors.New("Complete Export entry length is truncated")
		}
		headerLength := int(binary.BigEndian.Uint32(plaintext[offset : offset+4]))
		offset += 4
		if headerLength < 1 || len(plaintext)-offset < headerLength {
			return nil, errors.New("Complete Export entry header is truncated")
		}
		header, err := completeexport.DecodeEntryHeader(plaintext[offset : offset+headerLength])
		if err != nil {
			return nil, err
		}
		offset += headerLength
		if header.ByteLength > uint64(len(plaintext)-offset) {
			return nil, errors.New("Complete Export entry body is truncated")
		}
		bodyLength := int(header.ByteLength)
		body := append([]byte(nil), plaintext[offset:offset+bodyLength]...)
		offset += bodyLength
		entries = append(entries, completeexport.Entry{Header: header, Bytes: body})
	}
	if len(entries) == 0 {
		return nil, errors.New("Complete Export contains no entries")
	}
	if _, err := completeexport.SequenceEntries(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func decodeArtifactPayloadContract(object ReplicaObject) (artifactPayloadContract, error) {
	if object.ObjectType != 2 {
		return artifactPayloadContract{}, errors.New("Artifact Object type is invalid")
	}
	body, ok := replicaMapValue(object.Body)
	if !ok || !replicaMapHasKeys(body, 8) {
		return artifactPayloadContract{}, errors.New("Artifact Object body is invalid")
	}
	plaintextLength, ok := replicaMapNumber(body, 4)
	if !ok {
		return artifactPayloadContract{}, errors.New("Artifact plaintext length is invalid")
	}
	digestBytes, ok := replicaMapBytes(body, 5, 32)
	if !ok {
		return artifactPayloadContract{}, errors.New("Artifact plaintext digest is invalid")
	}
	contract, ok := replicaMapValue(replicaMapEntryMust(body, 6))
	if !ok || !replicaMapHasKeys(contract, 5) {
		return artifactPayloadContract{}, errors.New("Artifact wrapper contract is invalid")
	}
	format, formatOK := replicaMapNumber(contract, 0)
	frameLimit, frameLimitOK := replicaMapNumber(contract, 1)
	frameTagLength, frameTagLengthOK := replicaMapNumber(contract, 2)
	contractLength, lengthOK := replicaMapNumber(contract, 3)
	contractDigest, digestOK := replicaMapBytes(contract, 4, 32)
	if !formatOK || format != 1 || !frameLimitOK || frameLimit != storage.FramePlaintextLimit || !frameTagLengthOK || frameTagLength != storage.FrameTagLength || !lengthOK || contractLength != plaintextLength || !digestOK || !bytes.Equal(contractDigest, digestBytes) {
		return artifactPayloadContract{}, errors.New("Artifact wrapper contract does not match its Object")
	}
	var digest [32]byte
	copy(digest[:], digestBytes)
	return artifactPayloadContract{PlaintextLength: plaintextLength, PlaintextDigest: digest}, nil
}

func prepareCompleteImport(manifest completeexport.Manifest, inventory completeexport.KeyInventory, entries []completeexport.Entry) (preparedCompleteImport, error) {
	itemsByStorage := make(map[string]completeexport.OpaqueItem, len(manifest.OpaqueItemInventory))
	for _, item := range manifest.OpaqueItemInventory {
		storageID := hexIdentifier(item.StorageItemID)
		if _, exists := itemsByStorage[storageID]; exists {
			return preparedCompleteImport{}, errors.New("Complete Export Manifest repeats a Storage Item")
		}
		itemsByStorage[storageID] = item
	}
	keyBytesByID := make(map[string][]byte, len(inventory.Entries))
	for _, entry := range inventory.Entries {
		keyBytesByID[hexIdentifier(entry.KeyEpochID)] = append([]byte(nil), entry.KeyEpochKey...)
	}
	if len(keyBytesByID) == 0 {
		return preparedCompleteImport{}, errors.New("Complete Export Key Inventory is empty")
	}
	opaqueEntries := entries[1 : len(entries)-1]
	if len(opaqueEntries) != len(manifest.OpaqueItemInventory) {
		return preparedCompleteImport{}, errors.New("Complete Export Manifest inventory does not match its entries")
	}
	items := make([]completeImportItem, 0, len(opaqueEntries))
	recordValues := make([]canonical.Record, 0)
	objectValues := make([]struct {
		id    canonical.Identifier
		bytes []byte
	}, 0)
	featureValues := make([]struct {
		id    canonical.Identifier
		bytes []byte
	}, 0)
	artifactValues := make([]completeImportArtifact, 0)
	referencedEpochIDs := make(map[string]struct{})
	for _, entry := range opaqueEntries {
		envelope, err := storage.DecodeOpaqueEnvelope(entry.Bytes)
		if err != nil || envelope.StorageItemID != entry.Header.EntryID {
			return preparedCompleteImport{}, errors.New("Complete Export opaque Storage Item identity is invalid")
		}
		storageID := hexIdentifier(envelope.StorageItemID)
		item, ok := itemsByStorage[storageID]
		if !ok || item.ByteLength != uint64(len(entry.Bytes)) || item.ByteDigest != entry.Header.ByteDigest || item.KeyEpochID == (canonical.Identifier{}) {
			return preparedCompleteImport{}, errors.New("Complete Export opaque inventory disagrees with its entry")
		}
		if _, ok := keyBytesByID[hexIdentifier(item.KeyEpochID)]; !ok {
			return preparedCompleteImport{}, errors.New("Complete Export omits a referenced Key Epoch Key")
		}
		referencedEpochIDs[hexIdentifier(item.KeyEpochID)] = struct{}{}
		items = append(items, completeImportItem{storageItemID: storageID, bytes: append([]byte(nil), entry.Bytes...)})
		if item.Namespace == 2 {
			continue
		}
		if item.Namespace == 5 {
			artifactValues = append(artifactValues, completeImportArtifact{item: item, bytes: append([]byte(nil), entry.Bytes...)})
			continue
		}
		key := keyBytesByID[hexIdentifier(item.KeyEpochID)]
		opened, err := awsmcrypto.OpenCompactItem(manifest.VaultID, item.KeyEpochID, key, entry.Bytes)
		if err != nil {
			return preparedCompleteImport{}, fmt.Errorf("Complete Export compact item %s is not authenticated", storageID)
		}
		switch item.Namespace {
		case 1:
			if opened.PayloadType != 1 {
				return preparedCompleteImport{}, errors.New("Complete Export Record payload type is invalid")
			}
			record, decodeErr := canonical.DecodeRecord(opened.PayloadBytes)
			if decodeErr != nil || record.RecordID != item.LogicalID {
				return preparedCompleteImport{}, errors.New("Complete Export Record identity is invalid")
			}
			recordValues = append(recordValues, record)
		case 3:
			if opened.PayloadType != 2 {
				return preparedCompleteImport{}, errors.New("Complete Export Object payload type is invalid")
			}
			objectValues = append(objectValues, struct {
				id    canonical.Identifier
				bytes []byte
			}{id: item.LogicalID, bytes: append([]byte(nil), opened.PayloadBytes...)})
		case 4:
			if opened.PayloadType != 3 {
				return preparedCompleteImport{}, errors.New("Complete Export Feature Manifest payload type is invalid")
			}
			manifestID, manifestErr := canonical.FeatureManifestID(opened.PayloadBytes)
			if manifestErr != nil || manifestID != item.LogicalID {
				return preparedCompleteImport{}, errors.New("Complete Export Feature Manifest identity is invalid")
			}
			featureValues = append(featureValues, struct {
				id    canonical.Identifier
				bytes []byte
			}{id: item.LogicalID, bytes: append([]byte(nil), opened.PayloadBytes...)})
		default:
			return preparedCompleteImport{}, errors.New("Complete Export namespace is unsupported")
		}
	}
	if len(keyBytesByID) != len(referencedEpochIDs) {
		return preparedCompleteImport{}, errors.New("Complete Export Key Inventory contains an unreferenced Key Epoch Key")
	}
	for epochID := range referencedEpochIDs {
		if _, ok := keyBytesByID[epochID]; !ok {
			return preparedCompleteImport{}, errors.New("Complete Export omits a referenced Key Epoch Key")
		}
	}
	baselineRootID := findTypedRoot(manifest.TypedLogicalRoots, 2)
	allRecordValues := append([]canonical.Record(nil), recordValues...)
	baseline, genesis, replica, adoptionEvent, predecessorGenerationID, err := reconstructCompleteImportReplica(manifest, baselineRootID, allRecordValues)
	if err != nil {
		return preparedCompleteImport{}, err
	}
	genesisCredentialID, _, err := genesisCredential(*genesis)
	if err != nil {
		return preparedCompleteImport{}, err
	}
	epochKeys := make(map[canonical.Identifier][]byte, len(keyBytesByID))
	for epochIDText, keyBytes := range keyBytesByID {
		epochID, decodeErr := decodeHexIdentifier(epochIDText)
		if decodeErr != nil {
			return preparedCompleteImport{}, errors.New("Complete Export Key Epoch identity is invalid")
		}
		epochKeys[epochID] = append([]byte(nil), keyBytes...)
	}
	epochReplay, err := replayReplicaAuthorityState(replica, nil, epochKeys)
	if err != nil {
		return preparedCompleteImport{}, fmt.Errorf("Complete Export Key Epoch Authority history is invalid: %w", err)
	}
	for _, object := range objectValues {
		if err := replica.AdmitObject(object.id, object.bytes); err != nil {
			return preparedCompleteImport{}, fmt.Errorf("admit Complete Export Object: %w", err)
		}
	}
	for _, feature := range featureValues {
		if err := replica.AdmitFeatureManifest(feature.id, feature.bytes); err != nil {
			return preparedCompleteImport{}, fmt.Errorf("admit Complete Export Feature Manifest: %w", err)
		}
	}
	featureIDs := make(map[canonical.Identifier]struct{}, len(featureValues))
	for _, feature := range featureValues {
		featureIDs[feature.id] = struct{}{}
	}
	if err := validateImportedFeatureManifestDependencies(*baseline, allRecordValues, featureIDs); err != nil {
		return preparedCompleteImport{}, err
	}
	featureInputs := make([]canonical.FeatureManifestInput, 0, len(featureValues))
	for _, feature := range featureValues {
		manifest, ok := replica.FeatureManifest(feature.id)
		if !ok {
			return preparedCompleteImport{}, errors.New("Complete Export Feature Manifest is unavailable after admission")
		}
		featureInputs = append(featureInputs, manifest.FeatureManifestInput)
	}
	featureSetID, err := canonical.RequiredFeatureSetID(featureInputs)
	if err != nil || featureSetID != manifest.RequiredFeatureSetID {
		return preparedCompleteImport{}, errors.New("Complete Export Feature Manifest closure does not match its Required Feature Set")
	}
	for _, artifact := range artifactValues {
		object, ok := replica.Object(artifact.item.LogicalID)
		if !ok {
			return preparedCompleteImport{}, errors.New("Complete Export Artifact Object is unavailable")
		}
		contract, err := decodeArtifactPayloadContract(object)
		if err != nil {
			return preparedCompleteImport{}, fmt.Errorf("Complete Export Artifact Object contract is invalid: %w", err)
		}
		key := keyBytesByID[hexIdentifier(artifact.item.KeyEpochID)]
		if _, err := awsmcrypto.OpenArtifactStream(awsmcrypto.ArtifactStreamOpenInput{
			VaultID: manifest.VaultID, KeyEpochID: artifact.item.KeyEpochID, KeyEpochKey: key,
			ArtifactID: artifact.item.LogicalID, PlaintextLength: contract.PlaintextLength,
			PlaintextDigest: contract.PlaintextDigest, EnvelopeBytes: artifact.bytes,
		}); err != nil {
			return preparedCompleteImport{}, fmt.Errorf("Complete Export Artifact wrapper is not authenticated: %w", err)
		}
	}
	state := replica.State()
	if !identifierSlicesEqual(state.CausalFrontier, manifest.Frontier) || !identifierSlicesEqual(state.AuthorityFrontier, manifest.ContinuityProofRoots) {
		return preparedCompleteImport{}, errors.New("Complete Export authenticated frontiers do not match its Manifest")
	}
	memberID, recoveryCredentialID, clientCredentialID, epochID, envelopeIDs, err := importedAuthorityIdentity(*baseline, *genesis)
	if err != nil {
		return preparedCompleteImport{}, err
	}
	if len(epochReplay.heads) == 1 {
		for headID := range epochReplay.heads {
			if slots := epochReplay.headSlots[headID]; len(slots) > 0 {
				currentEnvelopeIDs := make(map[uint64]canonical.Identifier, 2)
				for _, slot := range slots {
					if _, exists := currentEnvelopeIDs[slot.targetKind]; exists {
						return preparedCompleteImport{}, errors.New("Complete Export current Key Epoch repeats a target kind")
					}
					currentEnvelopeIDs[slot.targetKind] = slot.envelopeID
					if slot.targetKind == awsmcrypto.RecoveryCredentialTarget {
						recoveryCredentialID = slot.targetID
					} else if slot.targetKind == awsmcrypto.ClientCredentialTarget {
						clientCredentialID = slot.targetID
					}
				}
				if len(currentEnvelopeIDs) != 2 {
					return preparedCompleteImport{}, errors.New("Complete Export current Key Epoch omits a required target")
				}
				epochID = headID
				envelopeIDs = currentEnvelopeIDs
			}
		}
	}
	if _, ok := keyBytesByID[hexIdentifier(epochID)]; !ok || clientCredentialID != genesisCredentialID {
		return preparedCompleteImport{}, errors.New("Complete Export Genesis authority does not match its Key Inventory")
	}
	clientEnvelopeStorageID, recoveryEnvelopeStorageID, err := envelopeStorageIDs(envelopeIDs, manifest.OpaqueItemInventory)
	if err != nil {
		return preparedCompleteImport{}, err
	}
	recordMappings := make(map[string]string)
	objectMappings := make(map[string]string)
	featureMappings := make(map[string]string)
	artifactMappings := make(map[string]string)
	keyEnvelopeMappings := make(map[string]string)
	storageItemKeyEpochIDs := make(map[string]string, len(manifest.OpaqueItemInventory))
	for _, item := range manifest.OpaqueItemInventory {
		storageID := hexIdentifier(item.StorageItemID)
		storageItemKeyEpochIDs[storageID] = hexIdentifier(item.KeyEpochID)
		switch item.Namespace {
		case 1:
			recordMappings[hexIdentifier(item.LogicalID)] = storageID
		case 2:
			keyEnvelopeMappings[hexIdentifier(item.LogicalID)] = storageID
		case 3:
			objectMappings[hexIdentifier(item.LogicalID)] = storageID
		case 4:
			featureMappings[hexIdentifier(item.LogicalID)] = storageID
		case 5:
			artifactMappings[hexIdentifier(item.LogicalID)] = storageID
		}
	}
	adoptionIDText := ""
	predecessorGenerationIDText := ""
	if adoptionEvent != nil {
		adoptionIDText = hexIdentifier(adoptionEvent.RecordID)
		predecessorGenerationIDText = hexIdentifier(predecessorGenerationID)
	}
	canonicalState := &canonicalReplicaState{
		VaultID:                       hexIdentifier(manifest.VaultID),
		GenerationID:                  hexIdentifier(manifest.GenerationID),
		BaselineID:                    hexIdentifier(baseline.RecordID),
		GenesisID:                     hexIdentifier(genesis.RecordID),
		KeyEpochID:                    hexIdentifier(epochID),
		RequiredFeatureSetID:          hexIdentifier(manifest.RequiredFeatureSetID),
		BaselineRequiredFeatureSetID:  hexIdentifier(baseline.RequiredFeatureSetID),
		MemberID:                      hexIdentifier(memberID),
		RecoveryCredentialID:          hexIdentifier(recoveryCredentialID),
		ClientCredentialID:            hexIdentifier(clientCredentialID),
		BaselineStorageItemID:         recordMappings[hexIdentifier(baseline.RecordID)],
		GenesisStorageItemID:          recordMappings[hexIdentifier(genesis.RecordID)],
		PredecessorGenerationID:       predecessorGenerationIDText,
		AdoptionEventID:               adoptionIDText,
		RecoveryEnvelopeID:            hexIdentifier(envelopeIDs[1]),
		RecoveryEnvelopeStorageID:     recoveryEnvelopeStorageID,
		ClientEnvelopeID:              hexIdentifier(envelopeIDs[2]),
		ClientEnvelopeStorageID:       clientEnvelopeStorageID,
		AuthoringAvailable:            false,
		CausalFrontier:                identifiersToHex(state.CausalFrontier),
		AuthorityFrontier:             identifiersToHex(state.AuthorityFrontier),
		ContinuityRecordIDs:           identifiersToHex(state.ContinuityRecordIDs),
		RecordStorageItemIDs:          recordMappings,
		ObjectStorageItemIDs:          objectMappings,
		FeatureManifestStorageItemIDs: featureMappings,
		ArtifactStorageItemIDs:        artifactMappings,
		KeyEnvelopeStorageItemIDs:     keyEnvelopeMappings,
		StorageItemKeyEpochIDs:        storageItemKeyEpochIDs,
	}
	importedSecrets := make([]completeImportSecret, 0, len(inventory.Entries))
	for _, entry := range inventory.Entries {
		importedSecrets = append(importedSecrets, completeImportSecret{
			epochID: hexIdentifier(entry.KeyEpochID),
			encoded: mustEncodeImportedEpochSecret(manifest.VaultID, entry.KeyEpochID, keyBytesByID[hexIdentifier(entry.KeyEpochID)]),
		})
	}
	return preparedCompleteImport{
		value:   persistedVault{VaultID: hexIdentifier(manifest.VaultID), Label: nil, Lifecycle: "Open", RecoveryHash: "", GenerationID: hexIdentifier(manifest.GenerationID), Remotes: []remoteState{}, RecoveryRevision: 0, Canonical: canonicalState},
		replica: replica,
		items:   items,
		secrets: importedSecrets,
	}, nil
}

func findTypedRoot(roots []canonical.Dependency, kind uint64) canonical.Identifier {
	for _, root := range roots {
		if root.Type == kind {
			return root.ID
		}
	}
	return canonical.Identifier{}
}

type completeVacuumBoundary struct {
	event                   canonical.Event
	baseline                canonical.Baseline
	predecessorGenerationID canonical.Identifier
}

func reconstructCompleteImportReplica(manifest completeexport.Manifest, activeBaselineID canonical.Identifier, records []canonical.Record) (*canonical.Baseline, *canonical.Event, *Replica, *canonical.Event, canonical.Identifier, error) {
	baselinesByID := make(map[canonical.Identifier]canonical.Baseline)
	baselinesByGeneration := make(map[canonical.Identifier]canonical.Baseline)
	events := make([]canonical.Event, 0)
	var genesis *canonical.Event
	for _, record := range records {
		if record.Baseline != nil {
			baseline := *record.Baseline
			if _, exists := baselinesByID[baseline.RecordID]; exists {
				return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export repeats a Baseline")
			}
			if _, exists := baselinesByGeneration[baseline.GenerationID]; exists {
				return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export repeats a Baseline Generation")
			}
			baselinesByID[baseline.RecordID] = baseline
			baselinesByGeneration[baseline.GenerationID] = baseline
		}
		if record.Event == nil {
			continue
		}
		event := *record.Event
		events = append(events, event)
		if event.Family == canonical.AuthorityFamily && event.Type == canonical.GenesisEvent {
			if genesis != nil {
				return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export contains multiple Genesis Events")
			}
			genesis = &event
		}
	}
	activeBaseline, ok := baselinesByID[activeBaselineID]
	if !ok || activeBaseline.VaultID != manifest.VaultID || activeBaseline.GenerationID != manifest.GenerationID {
		return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export active Baseline is missing or has invalid context")
	}
	if genesis == nil || genesis.VaultID != manifest.VaultID {
		return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export Genesis is missing or has invalid context")
	}
	initialBaselineID := canonical.Identifier{}
	for _, dependency := range genesis.Dependencies {
		if dependency.Type == 2 {
			initialBaselineID = dependency.ID
			break
		}
	}
	if initialBaselineID == (canonical.Identifier{}) {
		return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export Genesis Baseline dependency is missing")
	}
	initialBaseline, ok := baselinesByID[initialBaselineID]
	if !ok || initialBaseline.GenerationID != genesis.GenerationID {
		return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export Initial Baseline is invalid")
	}
	boundariesReverse := make([]completeVacuumBoundary, 0)
	currentBaseline := activeBaseline
	for currentBaseline.RecordID != initialBaseline.RecordID {
		var boundary *completeVacuumBoundary
		for _, event := range events {
			if event.Family != canonical.LifecycleFamily || event.Type != 1 || !hasDependency(event.Dependencies, 2, currentBaseline.RecordID) {
				continue
			}
			parsed, err := parseCompleteVacuumBoundary(event, currentBaseline)
			if err != nil {
				return nil, nil, nil, nil, canonical.Identifier{}, err
			}
			if boundary != nil {
				return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export contains competing Vacuum boundaries for one successor")
			}
			boundary = &parsed
		}
		if boundary == nil {
			return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export is missing a Vacuum boundary")
		}
		predecessor, ok := baselinesByGeneration[boundary.predecessorGenerationID]
		if !ok {
			return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export Vacuum predecessor Baseline is missing")
		}
		boundariesReverse = append(boundariesReverse, *boundary)
		currentBaseline = predecessor
	}
	boundaries := make([]completeVacuumBoundary, len(boundariesReverse))
	for index := range boundariesReverse {
		boundaries[len(boundariesReverse)-index-1] = boundariesReverse[index]
	}
	_, genesisSigningKey, err := genesisCredential(*genesis)
	if err != nil {
		return nil, nil, nil, nil, canonical.Identifier{}, err
	}
	replica, err := NewReplica(initialBaseline)
	if err != nil {
		return nil, nil, nil, nil, canonical.Identifier{}, err
	}
	if err := replica.AdmitEvent(*genesis, genesisSigningKey); err != nil {
		return nil, nil, nil, nil, canonical.Identifier{}, fmt.Errorf("admit Complete Export Genesis: %w", err)
	}
	selectedVacuumIDs := make(map[canonical.Identifier]struct{}, len(boundaries))
	for _, boundary := range boundaries {
		selectedVacuumIDs[boundary.event.RecordID] = struct{}{}
	}
	var latestAdoption *canonical.Event
	var predecessorGenerationID canonical.Identifier
	for _, boundary := range boundaries {
		if replica.generationID != boundary.event.GenerationID {
			return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export Vacuum chain has a Generation discontinuity")
		}
		ordinary := make([]canonical.Event, 0)
		for _, event := range events {
			if event.RecordID == genesis.RecordID || event.GenerationID != replica.generationID {
				continue
			}
			if event.Family == canonical.LifecycleFamily && event.Type == 1 {
				if event.RecordID != boundary.event.RecordID {
					return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export contains an unselected Vacuum boundary")
				}
				continue
			}
			ordinary = append(ordinary, event)
		}
		if err := admitCompleteImportEvents(replica, ordinary, "Complete Export Generation Record"); err != nil {
			return nil, nil, nil, nil, canonical.Identifier{}, err
		}
		predecessorGenerationID = replica.generationID
		next, err := replica.AdoptVacuum(boundary.baseline, boundary.event)
		if err != nil {
			return nil, nil, nil, nil, canonical.Identifier{}, fmt.Errorf("adopt Complete Export Vacuum: %w", err)
		}
		replica = next
		adoption := boundary.event
		latestAdoption = &adoption
	}
	ordinary := make([]canonical.Event, 0)
	for _, event := range events {
		if event.RecordID == genesis.RecordID || event.GenerationID != replica.generationID {
			continue
		}
		if event.Family == canonical.LifecycleFamily && event.Type == 1 {
			if _, selected := selectedVacuumIDs[event.RecordID]; !selected {
				return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export contains an unselected Vacuum boundary")
			}
			continue
		}
		ordinary = append(ordinary, event)
	}
	if err := admitCompleteImportEvents(replica, ordinary, "Complete Export active Generation Record"); err != nil {
		return nil, nil, nil, nil, canonical.Identifier{}, err
	}
	for _, event := range events {
		if _, admitted := replica.records[event.RecordID]; !admitted {
			return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export contains an unselected Record branch")
		}
	}
	for baselineID := range baselinesByID {
		if _, admitted := replica.records[baselineID]; !admitted {
			return nil, nil, nil, nil, canonical.Identifier{}, errors.New("Complete Export contains an unselected Baseline")
		}
	}
	return &activeBaseline, genesis, replica, latestAdoption, predecessorGenerationID, nil
}

func parseCompleteVacuumBoundary(event canonical.Event, successor canonical.Baseline) (completeVacuumBoundary, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 7) {
		return completeVacuumBoundary{}, errors.New("Complete Export Vacuum Event body is invalid")
	}
	predecessorBytes, predecessorOK := replicaMapBytes(body, 0, 32)
	successorGenerationBytes, successorGenerationOK := replicaMapBytes(body, 2, 32)
	successorBaselineBytes, successorBaselineOK := replicaMapBytes(body, 3, 32)
	if !predecessorOK || !successorGenerationOK || !successorBaselineOK {
		return completeVacuumBoundary{}, errors.New("Complete Export Vacuum Event identity fields are invalid")
	}
	predecessorGenerationID := bytesIdentifier(predecessorBytes)
	if bytesIdentifier(successorGenerationBytes) != successor.GenerationID || bytesIdentifier(successorBaselineBytes) != successor.RecordID || event.VaultID != successor.VaultID {
		return completeVacuumBoundary{}, errors.New("Complete Export Vacuum Event does not bind its successor Baseline")
	}
	return completeVacuumBoundary{event: event, baseline: successor, predecessorGenerationID: predecessorGenerationID}, nil
}

func admitCompleteImportEvents(replica *Replica, events []canonical.Event, label string) error {
	pending := append([]canonical.Event(nil), events...)
	for len(pending) > 0 {
		sort.Slice(pending, func(left, right int) bool {
			return bytes.Compare(pending[left].RecordID[:], pending[right].RecordID[:]) < 0
		})
		progress := false
		for index := 0; index < len(pending); index++ {
			event := pending[index]
			if !replicaParentsAdmitted(replica, event) {
				continue
			}
			if err := replica.AdmitKnownEvent(event); err != nil {
				return fmt.Errorf("admit %s: %w", label, err)
			}
			pending = append(pending[:index], pending[index+1:]...)
			index--
			progress = true
		}
		if !progress {
			return fmt.Errorf("%s DAG cannot reach its parents", label)
		}
	}
	return nil
}

func validateImportedFeatureManifestDependencies(baseline canonical.Baseline, records []canonical.Record, featureIDs map[canonical.Identifier]struct{}) error {
	baselineIDs := make(map[canonical.Identifier]struct{})
	for _, dependency := range baseline.Dependencies {
		if dependency.Type != 8 {
			continue
		}
		if _, exists := featureIDs[dependency.ID]; !exists {
			return errors.New("Complete Export Baseline references an unavailable Feature Manifest")
		}
		baselineIDs[dependency.ID] = struct{}{}
	}
	if len(baselineIDs) != len(featureIDs) {
		return errors.New("Complete Export Baseline Feature Manifest dependencies are incomplete")
	}
	for featureID := range featureIDs {
		if _, ok := baselineIDs[featureID]; !ok {
			return errors.New("Complete Export Feature Manifest is not reachable from the Baseline")
		}
	}
	for _, record := range records {
		var dependencies []canonical.Dependency
		if record.Event != nil {
			dependencies = record.Event.Dependencies
		} else if record.Baseline != nil {
			dependencies = record.Baseline.Dependencies
		}
		for _, dependency := range dependencies {
			if dependency.Type != 8 {
				continue
			}
			if _, ok := featureIDs[dependency.ID]; !ok {
				return errors.New("Complete Export Record references an unavailable Feature Manifest")
			}
		}
	}
	return nil
}

func importedAuthorityIdentity(baseline canonical.Baseline, genesis canonical.Event) (canonical.Identifier, canonical.Identifier, canonical.Identifier, canonical.Identifier, map[uint64]canonical.Identifier, error) {
	body, ok := replicaMapValue(genesis.Body)
	if !ok || !replicaMapHasKeys(body, 7) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Genesis authority body is invalid")
	}
	memberBytes, memberOK := replicaMapBytes(body, 1, 32)
	recoveryCredential, recoveryCredentialOK := replicaMapEntry(body, 3)
	recoveryBytes, recoveryOK := replicaMapBytes(recoveryCredential, 0, 32)
	epochBytes, epochOK := replicaMapBytes(body, 4, 32)
	credentialID, _, err := genesisCredential(genesis)
	if err != nil || !memberOK || !recoveryCredentialOK || !recoveryOK || !epochOK {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Genesis authority identities are invalid")
	}
	memberID := bytesIdentifier(memberBytes)
	recoveryID := bytesIdentifier(recoveryBytes)
	epochID := bytesIdentifier(epochBytes)
	authority, ok := replicaMapEntry(baseline.Body, 3)
	if !ok || !replicaMapHasKeys(authority, 10) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Baseline authority checkpoint is invalid")
	}
	slots, ok := replicaMapEntry(authority, 7)
	values, valuesOK := slots.([]canonical.Value)
	if !ok || !valuesOK || len(values) == 0 {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Baseline Key Envelope slots are invalid")
	}
	envelopes := make(map[uint64]canonical.Identifier, 2)
	for _, value := range values {
		slot, slotOK := replicaMapValue(value)
		if !slotOK || !replicaMapHasKeys(slot, 5) {
			return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Baseline Key Envelope slot is invalid")
		}
		targetKind, kindOK := replicaMapNumber(slot, 1)
		targetID, targetOK := replicaMapBytes(slot, 2, 32)
		envelopeID, envelopeOK := replicaMapBytes(slot, 4, 32)
		if !kindOK || !targetOK || !envelopeOK || (targetKind != awsmcrypto.RecoveryCredentialTarget && targetKind != awsmcrypto.ClientCredentialTarget) {
			return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Baseline Key Envelope slot is invalid")
		}
		if targetKind == awsmcrypto.RecoveryCredentialTarget && !bytes.Equal(targetID, recoveryID[:]) {
			return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Recovery Key Envelope slot is invalid")
		}
		if targetKind == awsmcrypto.ClientCredentialTarget && !bytes.Equal(targetID, credentialID[:]) {
			return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export Client Key Envelope slot is invalid")
		}
		if _, exists := envelopes[targetKind]; exists {
			return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export repeats a Key Envelope slot")
		}
		envelopes[targetKind] = bytesIdentifier(envelopeID)
	}
	if _, ok := envelopes[awsmcrypto.RecoveryCredentialTarget]; !ok {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export omits the Recovery Key Envelope slot")
	}
	if _, ok := envelopes[awsmcrypto.ClientCredentialTarget]; !ok {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, nil, errors.New("Complete Export omits the Client Key Envelope slot")
	}
	return memberID, recoveryID, credentialID, epochID, envelopes, nil
}

func envelopeStorageIDs(envelopes map[uint64]canonical.Identifier, inventory []completeexport.OpaqueItem) (string, string, error) {
	var clientStorage, recoveryStorage string
	for _, item := range inventory {
		if item.Namespace != 2 {
			continue
		}
		switch item.LogicalID {
		case envelopes[awsmcrypto.ClientCredentialTarget]:
			clientStorage = hexIdentifier(item.StorageItemID)
		case envelopes[awsmcrypto.RecoveryCredentialTarget]:
			recoveryStorage = hexIdentifier(item.StorageItemID)
		}
	}
	if clientStorage == "" || recoveryStorage == "" {
		return "", "", errors.New("Complete Export Key Envelope entries are incomplete")
	}
	return clientStorage, recoveryStorage, nil
}

func mustEncodeImportedEpochSecret(vaultID, epochID canonical.Identifier, key []byte) []byte {
	encoded, err := canonical.EncodeValue(canonical.Map{0: uint64(1), 1: vaultID[:], 2: epochID[:], 3: uint64(0), 4: key})
	if err != nil {
		panic(err)
	}
	return encoded
}

func identifierSlicesEqual(left, right []canonical.Identifier) bool {
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

func (r *Runtime) exportCompleteLocked(vaultID, passphrase string, salt [16]byte, nonce [24]byte) ([]byte, error) {
	value, err := r.vaultLockedRead(vaultID)
	if err != nil {
		return nil, err
	}
	if value.Canonical == nil || r.replicas[vaultID] == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The authenticated Vault closure is unavailable for export.")
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The Vault identity is invalid.")
	}
	replica := r.replicas[vaultID]
	if err := validateCompleteExportDependencies(replica, value.Canonical); err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", err.Error())
	}
	entries, err := r.prepareCompleteExportEntries(value.Canonical, replica, vaultIdentifier)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", err.Error())
	}
	sort.Slice(entries, func(left, right int) bool {
		return bytes.Compare(entries[left].inventory.StorageItemID[:], entries[right].inventory.StorageItemID[:]) < 0
	})
	frontier := identifiersFromHex(value.Canonical.CausalFrontier)
	continuity := identifiersFromHex(value.Canonical.AuthorityFrontier)
	typedRoots := make([]canonical.Dependency, 0, len(frontier)+1)
	for _, id := range frontier {
		typedRoots = append(typedRoots, canonical.Dependency{Type: 1, ID: id})
	}
	baselineID, err := decodeHexIdentifier(value.Canonical.BaselineID)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The Baseline identity is invalid.")
	}
	typedRoots = append(typedRoots, canonical.Dependency{Type: 2, ID: baselineID})
	generationID, err := decodeHexIdentifier(value.GenerationID)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The Generation identity is invalid.")
	}
	featureSetID, err := decodeHexIdentifier(value.Canonical.RequiredFeatureSetID)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The Required Feature Set identity is invalid.")
	}
	manifest, err := completeexport.NewManifest(completeexport.ManifestInput{
		VaultID:              vaultIdentifier,
		GenerationID:         generationID,
		Frontier:             frontier,
		RequiredFeatureSetID: featureSetID,
		TypedLogicalRoots:    typedRoots,
		OpaqueItemInventory:  completeExportInventories(entries),
		ContinuityProofRoots: continuity,
	})
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export Manifest could not be prepared: %v", err))
	}
	manifestBytes, err := completeexport.EncodeManifest(manifest)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export Manifest could not be encoded: %v", err))
	}
	manifestEntry, err := completeexport.PrepareEntry(completeexport.ManifestEntryKind, manifestBytes)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export Manifest entry could not be prepared: %v", err))
	}
	keyEntries := make(map[string]completeexport.KeyEpochEntry)
	for _, prepared := range entries {
		epochID := prepared.inventory.KeyEpochID
		epochIDText := hexIdentifier(epochID)
		if _, ok := keyEntries[epochIDText]; ok {
			continue
		}
		encoded, secretErr := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, epochIDText))
		if secretErr != nil {
			return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The required Key Epoch is unavailable.")
		}
		secret, decodeErr := decodeEpochSecret(encoded, vaultIdentifier, epochID)
		if decodeErr != nil {
			return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The required Key Epoch is invalid.")
		}
		keyEntries[epochIDText] = completeexport.KeyEpochEntry{KeyEpochID: epochID, KeyEpochKey: append([]byte(nil), secret.key...)}
		zeroBytes(secret.key)
	}
	orderedKeyEntries := make([]completeexport.KeyEpochEntry, 0, len(keyEntries))
	for _, entry := range keyEntries {
		orderedKeyEntries = append(orderedKeyEntries, entry)
	}
	sort.Slice(orderedKeyEntries, func(left, right int) bool {
		return bytes.Compare(orderedKeyEntries[left].KeyEpochID[:], orderedKeyEntries[right].KeyEpochID[:]) < 0
	})
	keyInventory, err := completeexport.NewKeyInventory(completeexport.KeyInventoryInput{
		VaultID: vaultIdentifier, GenerationID: generationID, Entries: orderedKeyEntries,
	})
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export Key Inventory could not be prepared: %v", err))
	}
	keyInventoryBytes, err := completeexport.EncodeKeyInventory(keyInventory)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export Key Inventory could not be encoded: %v", err))
	}
	keyInventoryEntry, err := completeexport.PrepareEntry(completeexport.KeyInventoryEntryKind, keyInventoryBytes)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export Key Inventory entry could not be prepared: %v", err))
	}
	orderedEntries := make([]completeexport.Entry, 0, len(entries)+2)
	orderedEntries = append(orderedEntries, manifestEntry)
	for _, prepared := range entries {
		orderedEntries = append(orderedEntries, prepared.entry)
	}
	orderedEntries = append(orderedEntries, keyInventoryEntry)
	plaintext, err := completeexport.SequenceEntries(orderedEntries)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export entry stream could not be assembled: %v", err))
	}
	encrypted, err := completeexport.SealStream(passphrase, salt, nonce, plaintext)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", fmt.Sprintf("The Complete Export could not be sealed: %v", err))
	}
	return encrypted, nil
}

func (r *Runtime) completeExportEpochForStorageItem(vaultID string, state *canonicalReplicaState, storageItemID string) (canonical.Identifier, []byte, error) {
	epochIDText, ok := state.StorageItemKeyEpochIDs[storageItemID]
	if !ok || !validDigest(epochIDText) {
		return canonical.Identifier{}, nil, fmt.Errorf("Complete Export Storage Item %s has no valid Key Epoch binding", storageItemID)
	}
	epochID, err := decodeHexIdentifier(epochIDText)
	if err != nil {
		return canonical.Identifier{}, nil, err
	}
	encoded, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, epochIDText))
	if err != nil {
		return canonical.Identifier{}, nil, fmt.Errorf("Complete Export Key Epoch %s is unavailable", epochIDText)
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		return canonical.Identifier{}, nil, err
	}
	secret, err := decodeEpochSecret(encoded, vaultIdentifier, epochID)
	if err != nil {
		return canonical.Identifier{}, nil, fmt.Errorf("Complete Export Key Epoch %s is invalid", epochIDText)
	}
	return epochID, secret.key, nil
}

func (r *Runtime) prepareCompleteExportEntries(state *canonicalReplicaState, replica *Replica, vaultID canonical.Identifier) ([]preparedCompleteExportEntry, error) {
	entries := make([]preparedCompleteExportEntry, 0, len(state.RecordStorageItemIDs)+len(state.ObjectStorageItemIDs)+len(state.FeatureManifestStorageItemIDs)+len(state.ArtifactStorageItemIDs)+2)
	for _, recordIDText := range sortedStringKeys(state.RecordStorageItemIDs) {
		recordID, err := decodeHexIdentifier(recordIDText)
		if err != nil {
			return nil, errors.New("Complete Export Record identity is invalid")
		}
		record, ok := replica.Record(recordID)
		if !ok || len(record.Bytes) == 0 {
			return nil, fmt.Errorf("Complete Export Record %s is unavailable", recordIDText)
		}
		storageItemID := state.RecordStorageItemIDs[recordIDText]
		epochID, epochKey, err := r.completeExportEpochForStorageItem(hexIdentifier(vaultID), state, storageItemID)
		if err != nil {
			return nil, err
		}
		prepared, err := r.prepareCompactCompleteExportEntry(1, recordID, storageItemID, 1, record.Bytes, vaultID, epochID, epochKey)
		zeroBytes(epochKey)
		if err != nil {
			return nil, err
		}
		entries = append(entries, prepared)
	}
	for _, objectIDText := range sortedStringKeys(state.ObjectStorageItemIDs) {
		objectID, err := decodeHexIdentifier(objectIDText)
		if err != nil {
			return nil, errors.New("Complete Export Object identity is invalid")
		}
		object, ok := replica.Object(objectID)
		if !ok || len(object.Bytes) == 0 {
			return nil, fmt.Errorf("Complete Export Object %s is unavailable", objectIDText)
		}
		storageItemID := state.ObjectStorageItemIDs[objectIDText]
		epochID, epochKey, err := r.completeExportEpochForStorageItem(hexIdentifier(vaultID), state, storageItemID)
		if err != nil {
			return nil, err
		}
		prepared, err := r.prepareCompactCompleteExportEntry(3, objectID, storageItemID, 2, object.Bytes, vaultID, epochID, epochKey)
		zeroBytes(epochKey)
		if err != nil {
			return nil, err
		}
		entries = append(entries, prepared)
	}
	for _, manifestIDText := range sortedStringKeys(state.FeatureManifestStorageItemIDs) {
		manifestID, err := decodeHexIdentifier(manifestIDText)
		if err != nil {
			return nil, errors.New("Complete Export Feature Manifest identity is invalid")
		}
		manifest, ok := replica.FeatureManifest(manifestID)
		if !ok || len(manifest.Bytes) == 0 {
			return nil, fmt.Errorf("Complete Export Feature Manifest %s is unavailable", manifestIDText)
		}
		storageItemID := state.FeatureManifestStorageItemIDs[manifestIDText]
		epochID, epochKey, err := r.completeExportEpochForStorageItem(hexIdentifier(vaultID), state, storageItemID)
		if err != nil {
			return nil, err
		}
		prepared, err := r.prepareCompactCompleteExportEntry(4, manifestID, storageItemID, 3, manifest.Bytes, vaultID, epochID, epochKey)
		zeroBytes(epochKey)
		if err != nil {
			return nil, err
		}
		entries = append(entries, prepared)
	}
	for _, artifactIDText := range sortedStringKeys(state.ArtifactStorageItemIDs) {
		artifactID, err := decodeHexIdentifier(artifactIDText)
		if err != nil {
			return nil, errors.New("Complete Export Artifact identity is invalid")
		}
		object, ok := replica.Object(artifactID)
		if !ok {
			return nil, fmt.Errorf("Complete Export Artifact Object %s is unavailable", artifactIDText)
		}
		contract, err := decodeArtifactPayloadContract(object)
		if err != nil {
			return nil, fmt.Errorf("Complete Export Artifact Object %s is invalid: %w", artifactIDText, err)
		}
		storageItemID := state.ArtifactStorageItemIDs[artifactIDText]
		epochID, epochKey, err := r.completeExportEpochForStorageItem(hexIdentifier(vaultID), state, storageItemID)
		if err != nil {
			return nil, err
		}
		prepared, err := r.prepareArtifactCompleteExportEntry(vaultID, artifactID, storageItemID, epochID, epochKey, contract)
		zeroBytes(epochKey)
		if err != nil {
			return nil, err
		}
		entries = append(entries, prepared)
	}
	for _, logicalIDText := range sortedStringKeys(state.KeyEnvelopeStorageItemIDs) {
		logicalID, err := decodeHexIdentifier(logicalIDText)
		if err != nil {
			return nil, errors.New("Complete Export Key Envelope identity is invalid")
		}
		storageItemID := state.KeyEnvelopeStorageItemIDs[logicalIDText]
		epochID, _, err := r.completeExportEpochForStorageItem(hexIdentifier(vaultID), state, storageItemID)
		if err != nil {
			return nil, err
		}
		prepared, err := r.prepareOpaqueCompleteExportEntry(2, logicalID, storageItemID, epochID)
		if err != nil {
			return nil, err
		}
		entries = append(entries, prepared)
	}
	return entries, nil
}

func (r *Runtime) prepareCompactCompleteExportEntry(namespace uint64, logicalID canonical.Identifier, storageItemID string, payloadType uint64, expectedPayload []byte, vaultID, epochID canonical.Identifier, epochKey []byte) (preparedCompleteExportEntry, error) {
	encoded, envelope, err := r.readCompleteExportOpaque(storageItemID)
	if err != nil {
		return preparedCompleteExportEntry{}, err
	}
	opened, err := awsmcrypto.OpenCompactItem(vaultID, epochID, epochKey, encoded)
	if err != nil || opened.PayloadType != payloadType || !bytes.Equal(opened.PayloadBytes, expectedPayload) {
		return preparedCompleteExportEntry{}, fmt.Errorf("Complete Export Storage Item %s does not authenticate the expected payload", storageItemID)
	}
	entry, err := completeexport.PrepareEntry(completeexport.OpaqueEntryKind, encoded)
	if err != nil {
		return preparedCompleteExportEntry{}, err
	}
	return preparedCompleteExportEntry{inventory: completeexport.OpaqueItem{Namespace: namespace, LogicalID: logicalID, StorageItemID: envelope.StorageItemID, KeyEpochID: epochID, ByteLength: uint64(len(encoded)), ByteDigest: sha256.Sum256(encoded)}, entry: entry}, nil
}

func (r *Runtime) prepareOpaqueCompleteExportEntry(namespace uint64, logicalID canonical.Identifier, storageItemID string, epochID canonical.Identifier) (preparedCompleteExportEntry, error) {
	encoded, envelope, err := r.readCompleteExportOpaque(storageItemID)
	if err != nil {
		return preparedCompleteExportEntry{}, err
	}
	entry, err := completeexport.PrepareEntry(completeexport.OpaqueEntryKind, encoded)
	if err != nil {
		return preparedCompleteExportEntry{}, err
	}
	return preparedCompleteExportEntry{inventory: completeexport.OpaqueItem{Namespace: namespace, LogicalID: logicalID, StorageItemID: envelope.StorageItemID, KeyEpochID: epochID, ByteLength: uint64(len(encoded)), ByteDigest: sha256.Sum256(encoded)}, entry: entry}, nil
}

func (r *Runtime) prepareArtifactCompleteExportEntry(vaultID canonical.Identifier, artifactID canonical.Identifier, storageItemID string, epochID canonical.Identifier, epochKey []byte, contract artifactPayloadContract) (preparedCompleteExportEntry, error) {
	encoded, envelope, err := r.readCompleteExportOpaque(storageItemID)
	if err != nil {
		return preparedCompleteExportEntry{}, err
	}
	if envelope.StorageClass != storage.StreamableStorageClass {
		return preparedCompleteExportEntry{}, fmt.Errorf("Complete Export Artifact Storage Item %s is not Streamable", storageItemID)
	}
	if _, err := awsmcrypto.OpenArtifactStream(awsmcrypto.ArtifactStreamOpenInput{
		VaultID:         vaultID,
		KeyEpochID:      epochID,
		KeyEpochKey:     epochKey,
		ArtifactID:      artifactID,
		PlaintextLength: contract.PlaintextLength,
		PlaintextDigest: contract.PlaintextDigest,
		EnvelopeBytes:   encoded,
	}); err != nil {
		return preparedCompleteExportEntry{}, fmt.Errorf("Complete Export Artifact Storage Item %s is not authenticated: %w", storageItemID, err)
	}
	entry, err := completeexport.PrepareEntry(completeexport.OpaqueEntryKind, encoded)
	if err != nil {
		return preparedCompleteExportEntry{}, err
	}
	return preparedCompleteExportEntry{inventory: completeexport.OpaqueItem{Namespace: 5, LogicalID: artifactID, StorageItemID: envelope.StorageItemID, KeyEpochID: epochID, ByteLength: uint64(len(encoded)), ByteDigest: sha256.Sum256(encoded)}, entry: entry}, nil
}

func (r *Runtime) readCompleteExportOpaque(storageItemID string) ([]byte, storage.OpaqueEnvelope, error) {
	if !validDigest(storageItemID) {
		return nil, storage.OpaqueEnvelope{}, errors.New("Complete Export Storage Item identity is invalid")
	}
	reader, err := r.deps.Artifacts.Open(storageItemID)
	if err != nil {
		return nil, storage.OpaqueEnvelope{}, fmt.Errorf("Complete Export Storage Item %s is unavailable", storageItemID)
	}
	encoded, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if readErr != nil {
		return nil, storage.OpaqueEnvelope{}, fmt.Errorf("Complete Export Storage Item %s is unavailable", storageItemID)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil || hexIdentifier(envelope.StorageItemID) != storageItemID {
		return nil, storage.OpaqueEnvelope{}, fmt.Errorf("Complete Export Storage Item %s is invalid", storageItemID)
	}
	return encoded, envelope, nil
}

func completeExportInventories(entries []preparedCompleteExportEntry) []completeexport.OpaqueItem {
	result := make([]completeexport.OpaqueItem, len(entries))
	for index, entry := range entries {
		result[index] = entry.inventory
	}
	return result
}

func validateCompleteExportDependencies(replica *Replica, state *canonicalReplicaState) error {
	if replica == nil || state == nil {
		return errors.New("Complete Export authenticated Replica is unavailable")
	}
	if err := validateReplicaKeyEpochHistory(replica, state); err != nil {
		return fmt.Errorf("Complete Export Key Epoch Authority history is invalid: %w", err)
	}
	for _, storageItemID := range canonicalStorageItemIDs(state) {
		epochID, ok := state.StorageItemKeyEpochIDs[storageItemID]
		if !ok || !validDigest(epochID) {
			return fmt.Errorf("Complete Export Storage Item %s has no valid Key Epoch binding", storageItemID)
		}
	}
	featureInputs := make([]canonical.FeatureManifestInput, 0, len(state.FeatureManifestStorageItemIDs))
	for featureIDText, storageItemID := range state.FeatureManifestStorageItemIDs {
		featureID, err := decodeHexIdentifier(featureIDText)
		if err != nil || storageItemID == "" {
			return errors.New("Complete Export Feature Manifest storage mapping is invalid")
		}
		manifest, ok := replica.FeatureManifest(featureID)
		if !ok || manifest.ID != featureID || len(manifest.Bytes) == 0 {
			return fmt.Errorf("Complete Export Feature Manifest %s is unavailable", featureIDText)
		}
		featureInputs = append(featureInputs, manifest.FeatureManifestInput)
	}
	featureSetID, err := canonical.RequiredFeatureSetID(featureInputs)
	if err != nil {
		return fmt.Errorf("Complete Export Required Feature Set is invalid: %w", err)
	}
	declaredFeatureSetID, err := decodeHexIdentifier(state.RequiredFeatureSetID)
	if err != nil || featureSetID != declaredFeatureSetID {
		return errors.New("Complete Export Feature Manifest closure does not match its Required Feature Set")
	}
	for artifactIDText := range state.ArtifactStorageItemIDs {
		artifactID, err := decodeHexIdentifier(artifactIDText)
		if err != nil {
			return errors.New("Complete Export Artifact identity is invalid")
		}
		object, ok := replica.Object(artifactID)
		if !ok {
			return fmt.Errorf("Complete Export Artifact Object %s is unavailable", artifactIDText)
		}
		if _, err := decodeArtifactPayloadContract(object); err != nil {
			return fmt.Errorf("Complete Export Artifact Object %s is invalid: %w", artifactIDText, err)
		}
	}
	allowedEnvelopes := map[canonical.Identifier]struct{}{}
	for envelopeID := range state.KeyEnvelopeStorageItemIDs {
		id, err := decodeHexIdentifier(envelopeID)
		if err != nil {
			return errors.New("Complete Export Key Envelope identity is invalid")
		}
		allowedEnvelopes[id] = struct{}{}
	}
	for _, record := range replica.records {
		var dependencies []canonical.Dependency
		if record.Event != nil {
			dependencies = record.Event.Dependencies
		} else if record.Baseline != nil {
			dependencies = record.Baseline.Dependencies
		}
		for _, dependency := range dependencies {
			switch dependency.Type {
			case 1, 2:
				if _, ok := replica.Record(dependency.ID); !ok {
					return fmt.Errorf("Complete Export dependency Record %s is unavailable", hexIdentifier(dependency.ID))
				}
			case 3, 4, 5, 6:
				if _, ok := replica.Object(dependency.ID); !ok {
					return fmt.Errorf("Complete Export dependency Object %s is unavailable", hexIdentifier(dependency.ID))
				}
			case 7:
				if _, ok := allowedEnvelopes[dependency.ID]; !ok {
					return fmt.Errorf("Complete Export dependency Key Envelope %s is unavailable", hexIdentifier(dependency.ID))
				}
			case 8:
				if _, ok := replica.FeatureManifest(dependency.ID); !ok {
					return fmt.Errorf("Complete Export Feature Manifest %s is unavailable", hexIdentifier(dependency.ID))
				}
				if _, ok := state.FeatureManifestStorageItemIDs[hexIdentifier(dependency.ID)]; !ok {
					return fmt.Errorf("Complete Export Feature Manifest %s has no Storage Item mapping", hexIdentifier(dependency.ID))
				}
			default:
				return fmt.Errorf("Complete Export dependency type %d is unsupported", dependency.Type)
			}
		}
	}
	return nil
}

func identifiersFromHex(values []string) []canonical.Identifier {
	result := make([]canonical.Identifier, 0, len(values))
	for _, value := range values {
		identifier, err := decodeHexIdentifier(value)
		if err != nil {
			return nil
		}
		result = append(result, identifier)
	}
	return result
}
