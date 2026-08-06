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
	currentEpochIDs := make(map[string]struct{})
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
		currentEpochIDs[hexIdentifier(item.KeyEpochID)] = struct{}{}
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
	if len(currentEpochIDs) != 1 {
		return preparedCompleteImport{}, errors.New("Complete Export with multiple Key Epochs is not implemented by this Runtime")
	}
	if len(keyBytesByID) != len(currentEpochIDs) {
		return preparedCompleteImport{}, errors.New("Complete Export Key Inventory contains an unreferenced Key Epoch Key")
	}
	var baseline *canonical.Baseline
	var genesis *canonical.Event
	for index := range recordValues {
		record := recordValues[index]
		if record.Kind == canonical.BaselineKind {
			if baseline != nil {
				return preparedCompleteImport{}, errors.New("Complete Export contains multiple Baselines")
			}
			copyValue := *record.Baseline
			baseline = &copyValue
		} else if record.Event != nil && record.Event.Family == canonical.AuthorityFamily && record.Event.Type == canonical.GenesisEvent {
			if genesis != nil {
				return preparedCompleteImport{}, errors.New("Complete Export contains multiple Genesis Events")
			}
			copyValue := *record.Event
			genesis = &copyValue
		}
	}
	if baseline == nil || genesis == nil || baseline.RecordID != findTypedRoot(manifest.TypedLogicalRoots, 2) {
		return preparedCompleteImport{}, errors.New("Complete Export Baseline or Genesis is missing")
	}
	if baseline.VaultID != manifest.VaultID || baseline.GenerationID != manifest.GenerationID || genesis.VaultID != manifest.VaultID || genesis.GenerationID != manifest.GenerationID {
		return preparedCompleteImport{}, errors.New("Complete Export Record context is invalid")
	}
	genesisCredentialID, genesisSigningKey, err := genesisCredential(*genesis)
	if err != nil {
		return preparedCompleteImport{}, err
	}
	replica, err := NewReplica(*baseline)
	if err != nil {
		return preparedCompleteImport{}, err
	}
	if err := replica.AdmitEvent(*genesis, genesisSigningKey); err != nil {
		return preparedCompleteImport{}, fmt.Errorf("admit Complete Export Genesis: %w", err)
	}
	allRecordValues := append([]canonical.Record(nil), recordValues...)
	for len(recordValues) > 0 {
		progress := false
		for index := 0; index < len(recordValues); index++ {
			record := recordValues[index]
			if record.Event == nil || record.Event.RecordID == genesis.RecordID {
				recordValues = append(recordValues[:index], recordValues[index+1:]...)
				index--
				progress = true
				continue
			}
			if !replicaParentsAdmitted(replica, *record.Event) {
				continue
			}
			if err := replica.AdmitKnownEvent(*record.Event); err != nil {
				return preparedCompleteImport{}, fmt.Errorf("admit Complete Export Record: %w", err)
			}
			recordValues = append(recordValues[:index], recordValues[index+1:]...)
			index--
			progress = true
		}
		if !progress {
			return preparedCompleteImport{}, errors.New("Complete Export Record DAG cannot reach its parents")
		}
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
	if epochID != onlyEpochID(currentEpochIDs) || clientCredentialID != genesisCredentialID {
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
	for _, item := range manifest.OpaqueItemInventory {
		storageID := hexIdentifier(item.StorageItemID)
		switch item.Namespace {
		case 1:
			recordMappings[hexIdentifier(item.LogicalID)] = storageID
		case 3:
			objectMappings[hexIdentifier(item.LogicalID)] = storageID
		case 4:
			featureMappings[hexIdentifier(item.LogicalID)] = storageID
		case 5:
			artifactMappings[hexIdentifier(item.LogicalID)] = storageID
		}
	}
	canonicalState := &canonicalReplicaState{
		VaultID:                       hexIdentifier(manifest.VaultID),
		GenerationID:                  hexIdentifier(manifest.GenerationID),
		BaselineID:                    hexIdentifier(baseline.RecordID),
		GenesisID:                     hexIdentifier(genesis.RecordID),
		KeyEpochID:                    hexIdentifier(epochID),
		RequiredFeatureSetID:          hexIdentifier(manifest.RequiredFeatureSetID),
		MemberID:                      hexIdentifier(memberID),
		RecoveryCredentialID:          hexIdentifier(recoveryCredentialID),
		ClientCredentialID:            hexIdentifier(clientCredentialID),
		BaselineStorageItemID:         recordMappings[hexIdentifier(baseline.RecordID)],
		GenesisStorageItemID:          recordMappings[hexIdentifier(genesis.RecordID)],
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
	}
	return preparedCompleteImport{
		value:   persistedVault{VaultID: hexIdentifier(manifest.VaultID), Label: nil, Lifecycle: "Open", RecoveryHash: "", GenerationID: hexIdentifier(manifest.GenerationID), Remotes: []remoteState{}, RecoveryRevision: 0, Canonical: canonicalState},
		replica: replica,
		items:   items,
		secrets: []completeImportSecret{{epochID: hexIdentifier(epochID), encoded: mustEncodeImportedEpochSecret(manifest.VaultID, epochID, keyBytesByID[hexIdentifier(epochID)])}},
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

func onlyEpochID(ids map[string]struct{}) canonical.Identifier {
	for id := range ids {
		decoded, err := decodeHexIdentifier(id)
		if err == nil {
			return decoded
		}
	}
	return canonical.Identifier{}
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
	epochIdentifier, err := decodeHexIdentifier(value.Canonical.KeyEpochID)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The Key Epoch identity is invalid.")
	}
	epochBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The required Key Epoch is unavailable.")
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochIdentifier)
	if err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", "The required Key Epoch is invalid.")
	}
	defer zeroBytes(epochSecret.key)

	replica := r.replicas[vaultID]
	if err := validateCompleteExportDependencies(replica, value.Canonical); err != nil {
		return nil, commandError("COMPLETE_EXPORT_UNAVAILABLE", err.Error())
	}
	entries, err := r.prepareCompleteExportEntries(value.Canonical, replica, vaultIdentifier, epochIdentifier, epochSecret.key)
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
	keyInventory, err := completeexport.NewKeyInventory(completeexport.KeyInventoryInput{
		VaultID: vaultIdentifier, GenerationID: generationID,
		Entries: []completeexport.KeyEpochEntry{{KeyEpochID: epochIdentifier, KeyEpochKey: append([]byte(nil), epochSecret.key...)}},
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

func (r *Runtime) prepareCompleteExportEntries(state *canonicalReplicaState, replica *Replica, vaultID, epochID canonical.Identifier, epochKey []byte) ([]preparedCompleteExportEntry, error) {
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
		prepared, err := r.prepareCompactCompleteExportEntry(1, recordID, storageItemID, 1, record.Bytes, vaultID, epochID, epochKey)
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
		prepared, err := r.prepareCompactCompleteExportEntry(3, objectID, state.ObjectStorageItemIDs[objectIDText], 2, object.Bytes, vaultID, epochID, epochKey)
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
		prepared, err := r.prepareCompactCompleteExportEntry(4, manifestID, state.FeatureManifestStorageItemIDs[manifestIDText], 3, manifest.Bytes, vaultID, epochID, epochKey)
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
		prepared, err := r.prepareArtifactCompleteExportEntry(vaultID, artifactID, state.ArtifactStorageItemIDs[artifactIDText], epochID, epochKey, contract)
		if err != nil {
			return nil, err
		}
		entries = append(entries, prepared)
	}
	keyEnvelopePairs := [][2]string{{state.RecoveryEnvelopeID, state.RecoveryEnvelopeStorageID}, {state.ClientEnvelopeID, state.ClientEnvelopeStorageID}}
	seenEnvelopes := make(map[string]struct{}, len(keyEnvelopePairs))
	for _, pair := range keyEnvelopePairs {
		if _, seen := seenEnvelopes[pair[0]]; seen {
			continue
		}
		seenEnvelopes[pair[0]] = struct{}{}
		logicalID, err := decodeHexIdentifier(pair[0])
		if err != nil {
			return nil, errors.New("Complete Export Key Envelope identity is invalid")
		}
		prepared, err := r.prepareOpaqueCompleteExportEntry(2, logicalID, pair[1], epochID)
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
	for _, value := range []string{state.RecoveryEnvelopeID, state.ClientEnvelopeID} {
		id, err := decodeHexIdentifier(value)
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
