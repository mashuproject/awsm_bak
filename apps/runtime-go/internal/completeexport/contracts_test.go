package completeexport

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
)

func TestCompleteExportManifestAndKeyInventoryRoundTrip(t *testing.T) {
	var vaultID, generationID, baselineID, frontierID, storageID, epochID [32]byte
	for index := range vaultID {
		vaultID[index] = 1
		generationID[index] = 2
		baselineID[index] = 3
		frontierID[index] = 4
		storageID[index] = 9
		epochID[index] = 5
	}
	featureSetBytes, err := hex.DecodeString("ed3dd98a4e6cc13d9d14ca4d62eb6b33e11ed471172346ab5d38ac91f57d7ada")
	if err != nil {
		t.Fatal(err)
	}
	var featureSetID [32]byte
	copy(featureSetID[:], featureSetBytes)
	manifestInput := ManifestInput{
		VaultID: vaultID, GenerationID: generationID,
		Frontier: []canonical.Identifier{frontierID}, RequiredFeatureSetID: featureSetID,
		TypedLogicalRoots:    []canonical.Dependency{{Type: 2, ID: baselineID}, {Type: 1, ID: frontierID}},
		OpaqueItemInventory:  []OpaqueItem{{Namespace: 1, LogicalID: frontierID, StorageItemID: storageID, KeyEpochID: epochID, ByteLength: 1, ByteDigest: [32]byte{6}}},
		ContinuityProofRoots: []canonical.Identifier{frontierID},
	}
	manifest, err := NewManifest(manifestInput)
	if err != nil {
		t.Fatalf("new manifest: %v", err)
	}
	encoded, err := EncodeManifest(manifest)
	if err != nil {
		t.Fatalf("encode manifest: %v", err)
	}
	decoded, err := DecodeManifest(encoded)
	if err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	reencoded, err := EncodeManifest(decoded)
	if err != nil || !bytes.Equal(encoded, reencoded) {
		t.Fatalf("manifest was not canonical")
	}
	key := bytes.Repeat([]byte{9}, 32)
	derivedID, err := awsmcrypto.KeyEpochID(vaultID, key)
	if err != nil {
		t.Fatalf("derive epoch ID: %v", err)
	}
	inventory, err := NewKeyInventory(KeyInventoryInput{VaultID: vaultID, GenerationID: generationID, Entries: []KeyEpochEntry{{KeyEpochID: derivedID, KeyEpochKey: key}}})
	if err != nil {
		t.Fatalf("new key inventory: %v", err)
	}
	inventoryBytes, err := EncodeKeyInventory(inventory)
	if err != nil {
		t.Fatalf("encode key inventory: %v", err)
	}
	decodedInventory, err := DecodeKeyInventory(inventoryBytes)
	if err != nil {
		t.Fatalf("decode key inventory: %v", err)
	}
	if _, err := EncodeKeyInventory(decodedInventory); err != nil {
		t.Fatalf("re-encode key inventory: %v", err)
	}
}

func TestCompleteExportManifestRejectsDuplicateOpaqueIdentity(t *testing.T) {
	var id [32]byte
	input := ManifestInput{
		VaultID: [32]byte{1}, GenerationID: [32]byte{2}, Frontier: []canonical.Identifier{{3}}, RequiredFeatureSetID: [32]byte{4},
		TypedLogicalRoots: []canonical.Dependency{{Type: 1, ID: [32]byte{3}}}, ContinuityProofRoots: []canonical.Identifier{{3}},
		OpaqueItemInventory: []OpaqueItem{{Namespace: 1, LogicalID: id, StorageItemID: [32]byte{5}, KeyEpochID: [32]byte{6}, ByteLength: 1, ByteDigest: [32]byte{7}}, {Namespace: 1, LogicalID: id, StorageItemID: [32]byte{8}, KeyEpochID: [32]byte{6}, ByteLength: 1, ByteDigest: [32]byte{7}}},
	}
	if _, err := NewManifest(input); err == nil {
		t.Fatal("duplicate opaque identity was accepted")
	}
}
