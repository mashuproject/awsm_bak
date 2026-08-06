package completeexport

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
)

const (
	ManifestFormat       uint64 = 1
	KeyInventoryFormat   uint64 = 1
	firstOpaqueNamespace        = 1
	lastOpaqueNamespace         = 5
)

type OpaqueItem struct {
	Namespace     uint64
	LogicalID     [32]byte
	StorageItemID [32]byte
	KeyEpochID    [32]byte
	ByteLength    uint64
	ByteDigest    [32]byte
}

type ManifestInput struct {
	VaultID              [32]byte
	GenerationID         [32]byte
	Frontier             []canonical.Identifier
	RequiredFeatureSetID [32]byte
	TypedLogicalRoots    []canonical.Dependency
	OpaqueItemInventory  []OpaqueItem
	ContinuityProofRoots []canonical.Identifier
}

type Manifest struct {
	ManifestInput
	Format      uint64
	StateDigest [32]byte
}

type KeyEpochEntry struct {
	KeyEpochID  [32]byte
	KeyEpochKey []byte
}

type KeyInventoryInput struct {
	VaultID      [32]byte
	GenerationID [32]byte
	Entries      []KeyEpochEntry
}

type KeyInventory struct {
	KeyInventoryInput
	Format uint64
}

func NewManifest(input ManifestInput) (Manifest, error) {
	if err := validateManifestInput(input); err != nil {
		return Manifest{}, err
	}
	digest, err := manifestStateDigest(input)
	if err != nil {
		return Manifest{}, err
	}
	return Manifest{ManifestInput: cloneManifestInput(input), Format: ManifestFormat, StateDigest: digest}, nil
}

func EncodeManifest(manifest Manifest) ([]byte, error) {
	if manifest.Format != ManifestFormat {
		return nil, errors.New("Complete Export Manifest format is unsupported")
	}
	if err := validateManifestInput(manifest.ManifestInput); err != nil {
		return nil, err
	}
	digest, err := manifestStateDigest(manifest.ManifestInput)
	if err != nil {
		return nil, err
	}
	if digest != manifest.StateDigest {
		return nil, errors.New("Complete Export state digest does not match the Manifest")
	}
	state, err := manifestStateValue(manifest.ManifestInput)
	if err != nil {
		return nil, err
	}
	state[7] = append([]byte(nil), manifest.StateDigest[:]...)
	return canonical.EncodeValue(state)
}

func DecodeManifest(encoded []byte) (Manifest, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return Manifest{}, err
	}
	fields, ok := numericMap(value)
	if !ok || len(fields) != 9 {
		return Manifest{}, errors.New("Complete Export Manifest must contain the exact fields")
	}
	for index := uint64(0); index <= 8; index++ {
		if _, ok := fields[index]; !ok {
			return Manifest{}, errors.New("Complete Export Manifest omits a field")
		}
	}
	format, ok := uintValue(fields[0])
	if !ok || format != ManifestFormat {
		return Manifest{}, errors.New("Complete Export Manifest format is unsupported")
	}
	vaultID, ok := bytes32(fields[1])
	if !ok || zeroID(vaultID) {
		return Manifest{}, errors.New("Complete Export Manifest Vault ID is invalid")
	}
	generationID, ok := bytes32(fields[2])
	if !ok || zeroID(generationID) {
		return Manifest{}, errors.New("Complete Export Manifest Generation ID is invalid")
	}
	frontier, err := decodeIdentifierSet(fields[3], true)
	if err != nil {
		return Manifest{}, err
	}
	featureSetID, ok := bytes32(fields[4])
	if !ok {
		return Manifest{}, errors.New("Complete Export Manifest Required Feature Set ID is invalid")
	}
	dependencies, err := decodeDependencies(fields[5])
	if err != nil {
		return Manifest{}, err
	}
	opaque, err := decodeOpaqueInventory(fields[6])
	if err != nil {
		return Manifest{}, err
	}
	digest, ok := bytes32(fields[7])
	if !ok {
		return Manifest{}, errors.New("Complete Export Manifest state digest is invalid")
	}
	continuity, err := decodeIdentifierSet(fields[8], true)
	if err != nil {
		return Manifest{}, err
	}
	manifest, err := NewManifest(ManifestInput{
		VaultID: vaultID, GenerationID: generationID, Frontier: frontier,
		RequiredFeatureSetID: featureSetID, TypedLogicalRoots: dependencies,
		OpaqueItemInventory: opaque, ContinuityProofRoots: continuity,
	})
	if err != nil {
		return Manifest{}, err
	}
	if manifest.StateDigest != digest {
		return Manifest{}, errors.New("Complete Export state digest does not match the Manifest")
	}
	manifest.StateDigest = digest
	canonicalBytes, err := EncodeManifest(manifest)
	if err != nil || !bytes.Equal(canonicalBytes, encoded) {
		return Manifest{}, errors.New("Complete Export Manifest is not canonical")
	}
	return manifest, nil
}

func NewKeyInventory(input KeyInventoryInput) (KeyInventory, error) {
	if err := validateKeyInventoryInput(input); err != nil {
		return KeyInventory{}, err
	}
	return KeyInventory{KeyInventoryInput: cloneKeyInventoryInput(input), Format: KeyInventoryFormat}, nil
}

func EncodeKeyInventory(inventory KeyInventory) ([]byte, error) {
	if inventory.Format != KeyInventoryFormat {
		return nil, errors.New("Complete Export Key Inventory format is unsupported")
	}
	if err := validateKeyInventoryInput(inventory.KeyInventoryInput); err != nil {
		return nil, err
	}
	entries := make([]canonical.Value, 0, len(inventory.Entries))
	for _, entry := range inventory.Entries {
		entries = append(entries, canonical.Map{0: append([]byte(nil), entry.KeyEpochID[:]...), 1: append([]byte(nil), entry.KeyEpochKey...)})
	}
	set, err := canonicalSet(entries)
	if err != nil {
		return nil, err
	}
	return canonical.EncodeValue(canonical.Map{0: KeyInventoryFormat, 1: append([]byte(nil), inventory.VaultID[:]...), 2: append([]byte(nil), inventory.GenerationID[:]...), 3: set})
}

func DecodeKeyInventory(encoded []byte) (KeyInventory, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return KeyInventory{}, err
	}
	fields, ok := numericMap(value)
	if !ok || len(fields) != 4 {
		return KeyInventory{}, errors.New("Complete Export Key Inventory must contain the exact fields")
	}
	for index := uint64(0); index < 4; index++ {
		if _, ok := fields[index]; !ok {
			return KeyInventory{}, errors.New("Complete Export Key Inventory omits a field")
		}
	}
	format, ok := uintValue(fields[0])
	if !ok || format != KeyInventoryFormat {
		return KeyInventory{}, errors.New("Complete Export Key Inventory format is unsupported")
	}
	vaultID, ok := bytes32(fields[1])
	if !ok || zeroID(vaultID) {
		return KeyInventory{}, errors.New("Complete Export Key Inventory Vault ID is invalid")
	}
	generationID, ok := bytes32(fields[2])
	if !ok || zeroID(generationID) {
		return KeyInventory{}, errors.New("Complete Export Key Inventory Generation ID is invalid")
	}
	values, ok := fields[3].([]canonical.Value)
	if !ok || len(values) == 0 {
		return KeyInventory{}, errors.New("Complete Export Key Inventory entries must not be empty")
	}
	if !isCanonicalSet(values) {
		return KeyInventory{}, errors.New("Complete Export Key Inventory entries must be sorted unique")
	}
	entries := make([]KeyEpochEntry, 0, len(values))
	for index, raw := range values {
		entry, ok := numericMap(raw)
		if !ok || len(entry) != 2 {
			return KeyInventory{}, fmt.Errorf("Complete Export Key Epoch entry %d is invalid", index)
		}
		id, ok := bytes32(entry[0])
		key, keyOK := bytesValue(entry[1], 32)
		if !ok || !keyOK {
			return KeyInventory{}, fmt.Errorf("Complete Export Key Epoch entry %d is invalid", index)
		}
		derived, deriveErr := awsmcrypto.KeyEpochID(vaultID, key)
		if deriveErr != nil || derived != id {
			return KeyInventory{}, errors.New("Export Key Epoch ID does not match its Key Epoch Key")
		}
		entries = append(entries, KeyEpochEntry{KeyEpochID: id, KeyEpochKey: key})
	}
	inventory, err := NewKeyInventory(KeyInventoryInput{VaultID: vaultID, GenerationID: generationID, Entries: entries})
	if err != nil {
		return KeyInventory{}, err
	}
	canonicalBytes, err := EncodeKeyInventory(inventory)
	if err != nil || !bytes.Equal(canonicalBytes, encoded) {
		return KeyInventory{}, errors.New("Complete Export Key Inventory is not canonical")
	}
	return inventory, nil
}

func validateManifestInput(input ManifestInput) error {
	if zeroID(input.VaultID) || zeroID(input.GenerationID) {
		return errors.New("Complete Export Manifest Vault and Generation IDs must not be zero")
	}
	if len(input.Frontier) == 0 || len(input.TypedLogicalRoots) == 0 || len(input.ContinuityProofRoots) == 0 {
		return errors.New("Complete Export Manifest roots must not be empty")
	}
	if len(input.OpaqueItemInventory) == 0 {
		return errors.New("Complete Export opaque inventory must not be empty")
	}
	if err := validateIdentifierSet(input.Frontier); err != nil {
		return err
	}
	if err := validateIdentifierSet(input.ContinuityProofRoots); err != nil {
		return err
	}
	for _, dependency := range input.TypedLogicalRoots {
		if dependency.Type < 1 || dependency.Type > 8 {
			return errors.New("Complete Export dependency type is unknown")
		}
	}
	for _, item := range input.OpaqueItemInventory {
		if item.Namespace < firstOpaqueNamespace || item.Namespace > lastOpaqueNamespace || item.ByteLength == 0 || len(item.ByteDigest) != 32 {
			return errors.New("Complete Export opaque inventory item is invalid")
		}
	}
	seenLogical := make(map[string]struct{}, len(input.OpaqueItemInventory))
	seenStorage := make(map[[32]byte]struct{}, len(input.OpaqueItemInventory))
	for _, item := range input.OpaqueItemInventory {
		logical := fmt.Sprintf("%d:%x", item.Namespace, item.LogicalID)
		if _, exists := seenLogical[logical]; exists {
			return errors.New("Complete Export opaque inventory contains a duplicate logical identity")
		}
		seenLogical[logical] = struct{}{}
		if _, exists := seenStorage[item.StorageItemID]; exists {
			return errors.New("Complete Export opaque inventory contains a duplicate Storage Item ID")
		}
		seenStorage[item.StorageItemID] = struct{}{}
	}
	return nil
}

func validateKeyInventoryInput(input KeyInventoryInput) error {
	if zeroID(input.VaultID) || zeroID(input.GenerationID) || len(input.Entries) == 0 {
		return errors.New("Complete Export Key Inventory is incomplete")
	}
	seen := make(map[[32]byte]struct{}, len(input.Entries))
	for _, entry := range input.Entries {
		if len(entry.KeyEpochKey) != 32 {
			return errors.New("Export Key Epoch Key must contain exactly 32 bytes")
		}
		derived, err := awsmcrypto.KeyEpochID(input.VaultID, entry.KeyEpochKey)
		if err != nil || derived != entry.KeyEpochID {
			return errors.New("Export Key Epoch ID does not match its Key Epoch Key")
		}
		if _, exists := seen[entry.KeyEpochID]; exists {
			return errors.New("Complete Export Key Inventory contains a duplicate Key Epoch ID")
		}
		seen[entry.KeyEpochID] = struct{}{}
	}
	return nil
}

func manifestStateDigest(input ManifestInput) ([32]byte, error) {
	state, err := manifestStateValue(input)
	if err != nil {
		return [32]byte{}, err
	}
	encoded, err := canonical.EncodeValue(state)
	if err != nil {
		return [32]byte{}, err
	}
	transcript, err := canonical.Transcript("awsm:complete-export-state-digest:v1", encoded)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(transcript), nil
}

func manifestStateValue(input ManifestInput) (canonical.Map, error) {
	frontier := identifiersValue(input.Frontier)
	continuity := identifiersValue(input.ContinuityProofRoots)
	dependencies := make([]canonical.Value, 0, len(input.TypedLogicalRoots))
	for _, dependency := range input.TypedLogicalRoots {
		dependencies = append(dependencies, canonical.Map{0: dependency.Type, 1: append([]byte(nil), dependency.ID[:]...)})
	}
	dependencySet, err := canonicalSet(dependencies)
	if err != nil {
		return nil, err
	}
	opaque := make([]canonical.Value, 0, len(input.OpaqueItemInventory))
	for _, item := range input.OpaqueItemInventory {
		opaque = append(opaque, canonical.Map{0: item.Namespace, 1: append([]byte(nil), item.LogicalID[:]...), 2: append([]byte(nil), item.StorageItemID[:]...), 3: append([]byte(nil), item.KeyEpochID[:]...), 4: item.ByteLength, 5: append([]byte(nil), item.ByteDigest[:]...)})
	}
	opaqueSet, err := canonicalSet(opaque)
	if err != nil {
		return nil, err
	}
	return canonical.Map{0: ManifestFormat, 1: append([]byte(nil), input.VaultID[:]...), 2: append([]byte(nil), input.GenerationID[:]...), 3: frontier, 4: append([]byte(nil), input.RequiredFeatureSetID[:]...), 5: dependencySet, 6: opaqueSet, 8: continuity}, nil
}

func decodeOpaqueInventory(value canonical.Value) ([]OpaqueItem, error) {
	values, ok := value.([]canonical.Value)
	if !ok || len(values) == 0 || !isCanonicalSet(values) {
		return nil, errors.New("Complete Export opaque inventory must be a sorted unique set")
	}
	items := make([]OpaqueItem, 0, len(values))
	for index, raw := range values {
		fields, ok := numericMap(raw)
		if !ok || len(fields) != 6 {
			return nil, fmt.Errorf("Complete Export opaque inventory item %d is invalid", index)
		}
		for key := uint64(0); key < 6; key++ {
			if _, ok := fields[key]; !ok {
				return nil, fmt.Errorf("Complete Export opaque inventory item %d omits a field", index)
			}
		}
		namespace, ok := uintValue(fields[0])
		logicalID, logicalOK := bytes32(fields[1])
		storageID, storageOK := bytes32(fields[2])
		epochID, epochOK := bytes32(fields[3])
		length, lengthOK := uintValue(fields[4])
		digest, digestOK := bytes32(fields[5])
		if !ok || !logicalOK || !storageOK || !epochOK || !lengthOK || !digestOK || namespace < firstOpaqueNamespace || namespace > lastOpaqueNamespace || length == 0 {
			return nil, fmt.Errorf("Complete Export opaque inventory item %d is invalid", index)
		}
		items = append(items, OpaqueItem{Namespace: namespace, LogicalID: logicalID, StorageItemID: storageID, KeyEpochID: epochID, ByteLength: length, ByteDigest: digest})
	}
	if err := validateManifestInput(ManifestInput{VaultID: [32]byte{1}, GenerationID: [32]byte{1}, Frontier: []canonical.Identifier{{1}}, RequiredFeatureSetID: [32]byte{1}, TypedLogicalRoots: []canonical.Dependency{{Type: 1, ID: [32]byte{1}}}, OpaqueItemInventory: items, ContinuityProofRoots: []canonical.Identifier{{1}}}); err != nil {
		return nil, err
	}
	return items, nil
}

func decodeDependencies(value canonical.Value) ([]canonical.Dependency, error) {
	values, ok := value.([]canonical.Value)
	if !ok || len(values) == 0 || !isCanonicalSet(values) {
		return nil, errors.New("Complete Export logical roots must be a sorted unique set")
	}
	result := make([]canonical.Dependency, 0, len(values))
	for index, raw := range values {
		fields, ok := numericMap(raw)
		if !ok || len(fields) != 2 {
			return nil, fmt.Errorf("Complete Export dependency %d is invalid", index)
		}
		typeCode, typeOK := uintValue(fields[0])
		id, idOK := bytes32(fields[1])
		if !typeOK || !idOK || typeCode < 1 || typeCode > 8 {
			return nil, fmt.Errorf("Complete Export dependency %d is invalid", index)
		}
		result = append(result, canonical.Dependency{Type: typeCode, ID: id})
	}
	return result, nil
}

func decodeIdentifierSet(value canonical.Value, nonempty bool) ([]canonical.Identifier, error) {
	values, ok := value.([]canonical.Value)
	if !ok || (nonempty && len(values) == 0) || !isCanonicalSet(values) {
		return nil, errors.New("Complete Export identifier set is not canonical")
	}
	result := make([]canonical.Identifier, 0, len(values))
	for _, raw := range values {
		id, ok := bytes32(raw)
		if !ok {
			return nil, errors.New("Complete Export identifier set contains an invalid ID")
		}
		result = append(result, id)
	}
	return result, nil
}

func identifiersValue(ids []canonical.Identifier) []canonical.Value {
	values := make([]canonical.Value, 0, len(ids))
	for _, id := range ids {
		values = append(values, append([]byte(nil), id[:]...))
	}
	set, err := canonicalSet(values)
	if err != nil {
		panic(err)
	}
	return set
}

func canonicalSet(values []canonical.Value) ([]canonical.Value, error) {
	type entry struct {
		encoded []byte
		value   canonical.Value
	}
	entries := make([]entry, 0, len(values))
	for _, value := range values {
		encoded, err := canonical.EncodeValue(value)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry{encoded: encoded, value: value})
	}
	sort.Slice(entries, func(left, right int) bool { return bytes.Compare(entries[left].encoded, entries[right].encoded) < 0 })
	for index := 1; index < len(entries); index++ {
		if bytes.Equal(entries[index-1].encoded, entries[index].encoded) {
			return nil, errors.New("Complete Export canonical set contains a duplicate")
		}
	}
	result := make([]canonical.Value, len(entries))
	for index, entry := range entries {
		result[index] = entry.value
	}
	return result, nil
}

func isCanonicalSet(values []canonical.Value) bool {
	normalized, err := canonicalSet(values)
	if err != nil || len(normalized) != len(values) {
		return false
	}
	left, leftErr := canonical.EncodeValue(values)
	right, rightErr := canonical.EncodeValue(normalized)
	return leftErr == nil && rightErr == nil && bytes.Equal(left, right)
}

func validateIdentifierSet(ids []canonical.Identifier) error {
	values := identifiersValue(ids)
	if len(values) != len(ids) {
		return errors.New("Complete Export identifier set contains a duplicate")
	}
	for index := 1; index < len(ids); index++ {
		if bytes.Compare(ids[index-1][:], ids[index][:]) >= 0 {
			return errors.New("Complete Export identifier set must be sorted unique")
		}
	}
	return nil
}

func cloneManifestInput(input ManifestInput) ManifestInput {
	clone := input
	clone.Frontier = append([]canonical.Identifier(nil), input.Frontier...)
	clone.TypedLogicalRoots = append([]canonical.Dependency(nil), input.TypedLogicalRoots...)
	clone.ContinuityProofRoots = append([]canonical.Identifier(nil), input.ContinuityProofRoots...)
	clone.OpaqueItemInventory = append([]OpaqueItem(nil), input.OpaqueItemInventory...)
	return clone
}

func cloneKeyInventoryInput(input KeyInventoryInput) KeyInventoryInput {
	clone := input
	clone.Entries = make([]KeyEpochEntry, len(input.Entries))
	for index, entry := range input.Entries {
		clone.Entries[index] = KeyEpochEntry{KeyEpochID: entry.KeyEpochID, KeyEpochKey: append([]byte(nil), entry.KeyEpochKey...)}
	}
	return clone
}

func bytes32(value any) ([32]byte, bool) {
	valueBytes, ok := bytesValue(value, 32)
	var result [32]byte
	if !ok {
		return result, false
	}
	copy(result[:], valueBytes)
	return result, true
}

func zeroID(id [32]byte) bool {
	return id == [32]byte{}
}
