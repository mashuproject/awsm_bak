package awsmcrypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestCompactItemRoundTripsAndBindsEpochAndContext(t *testing.T) {
	var vaultID, epochID [32]byte
	for index := range vaultID {
		vaultID[index] = byte(index + 1)
	}
	key := bytes.Repeat([]byte{0x42}, 32)
	derived, err := KeyEpochID(vaultID, key)
	if err != nil {
		t.Fatal(err)
	}
	epochID = derived
	protection := bytes.Repeat([]byte{0x17}, 64)
	compactKey, err := CompactItemKey(CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: key, ProtectionParameters: protection,
	})
	if err != nil {
		t.Fatalf("CompactItemKey: %v", err)
	}
	if got := hex.EncodeToString(compactKey); got != "bec480023cd95339acaa52227b9e7ab579abc5c69479b0699caa5a0b3fa54d29" {
		t.Fatalf("Compact Item Key = %s", got)
	}
	payload := []byte("authenticated compact record")
	envelope, err := SealCompactItem(CompactItemInput{
		VaultID:              vaultID,
		KeyEpochID:           epochID,
		KeyEpochKey:          key,
		PayloadType:          1,
		PayloadBytes:         payload,
		ProtectionParameters: protection,
	})
	if err != nil {
		t.Fatalf("SealCompactItem: %v", err)
	}
	opened, err := OpenCompactItem(vaultID, epochID, key, envelope)
	if err != nil {
		t.Fatalf("OpenCompactItem: %v", err)
	}
	if opened.PayloadType != 1 || !bytes.Equal(opened.PayloadBytes, payload) {
		t.Fatalf("opened compact item = %#v", opened)
	}
	if _, err := OpenCompactItem(vaultID, epochID, bytes.Repeat([]byte{0x43}, 32), envelope); err == nil {
		t.Fatal("OpenCompactItem accepted the wrong Key Epoch Key")
	}
	mutated := append([]byte(nil), envelope...)
	mutated[len(mutated)-1] ^= 1
	if _, err := OpenCompactItem(vaultID, epochID, key, mutated); err == nil {
		t.Fatal("OpenCompactItem accepted a modified ciphertext")
	}
}

func TestCompactItemRejectsInvalidPayloadTypesAndEpochBindings(t *testing.T) {
	var vaultID [32]byte
	key := bytes.Repeat([]byte{0x51}, 32)
	epochID, err := KeyEpochID(vaultID, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SealCompactItem(CompactItemInput{
		VaultID:      vaultID,
		KeyEpochID:   epochID,
		KeyEpochKey:  key,
		PayloadType:  0,
		PayloadBytes: []byte("invalid"),
	}); err == nil {
		t.Fatal("SealCompactItem accepted an unknown payload type")
	}
	wrongEpoch := [32]byte{1}
	if _, err := SealCompactItem(CompactItemInput{
		VaultID:      vaultID,
		KeyEpochID:   wrongEpoch,
		KeyEpochKey:  key,
		PayloadType:  1,
		PayloadBytes: []byte("invalid"),
	}); err == nil {
		t.Fatal("SealCompactItem accepted a mismatched Key Epoch ID")
	}
}
