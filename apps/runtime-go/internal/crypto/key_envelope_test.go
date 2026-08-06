package awsmcrypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestKeyEnvelopeRoundTripsAndBindsTargetContext(t *testing.T) {
	var vaultID, epochID, credentialID [32]byte
	for index := range vaultID {
		vaultID[index] = byte(index + 1)
		credentialID[index] = byte(0xa0 + index)
	}
	epochKey := bytes.Repeat([]byte{0x42}, 32)
	var err error
	epochID, err = KeyEpochID(vaultID, epochKey)
	if err != nil {
		t.Fatal(err)
	}
	recipientPrivate := bytes.Repeat([]byte{0x31}, 32)
	recipientPublic, err := X25519PublicKey(recipientPrivate)
	if err != nil {
		t.Fatal(err)
	}
	revision := uint64(0)
	envelope, err := SealKeyEnvelope(KeyEnvelopeInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		TargetKind: RecoveryCredentialTarget, TargetCredentialID: credentialID,
		TargetRevision: &revision, RecipientWrappingPublicKey: recipientPublic,
		Padding: bytes.Repeat([]byte{0xaa}, 32), EphemeralSeed: bytes.Repeat([]byte{0x41}, 32),
	})
	if err != nil {
		t.Fatalf("SealKeyEnvelope: %v", err)
	}
	opened, err := OpenKeyEnvelope(RecoveryCredentialTarget, recipientPrivate, envelope.Envelope.Bytes)
	if err != nil {
		t.Fatalf("OpenKeyEnvelope: %v", err)
	}
	if opened.TargetKind != RecoveryCredentialTarget || opened.TargetRevision == nil ||
		*opened.TargetRevision != 0 || opened.TargetCredentialID != credentialID ||
		opened.KeyEpochID != epochID || !bytes.Equal(opened.KeyEpochKey, epochKey) {
		t.Fatalf("opened Key Envelope = %#v", opened)
	}
	if envelope.ID != opened.ID || envelope.ID == ([32]byte{}) {
		t.Fatal("Key Envelope identity did not survive opening")
	}
	if got := hex.EncodeToString(envelope.ProtectionParameters[:32]); got != "fd2c4dd1c8a6b88fe1fc59ce441398f5ea83a9296e210997ac63bed970b86028" {
		t.Fatalf("Key Envelope encapsulated key = %s", got)
	}
}

func TestKeyEnvelopeRejectsTargetAndEpochMismatches(t *testing.T) {
	var vaultID [32]byte
	epochKey := bytes.Repeat([]byte{0x52}, 32)
	epochID, err := KeyEpochID(vaultID, epochKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SealKeyEnvelope(KeyEnvelopeInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		TargetKind: ClientCredentialTarget, TargetCredentialID: [32]byte{1},
		TargetRevision:             func() *uint64 { value := uint64(0); return &value }(),
		RecipientWrappingPublicKey: bytes.Repeat([]byte{0x31}, 32),
	}); err == nil {
		t.Fatal("SealKeyEnvelope accepted a Client Credential revision")
	}
	if _, err := SealKeyEnvelope(KeyEnvelopeInput{
		VaultID: vaultID, KeyEpochID: [32]byte{1}, KeyEpochKey: epochKey,
		TargetKind: ClientCredentialTarget, TargetCredentialID: [32]byte{1},
		RecipientWrappingPublicKey: bytes.Repeat([]byte{0x31}, 32),
	}); err == nil {
		t.Fatal("SealKeyEnvelope accepted a mismatched Key Epoch ID")
	}
}
