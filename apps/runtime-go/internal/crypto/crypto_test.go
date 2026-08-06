package awsmcrypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestRecoveryPhraseMatchesBIP39Vector(t *testing.T) {
	entropy, err := hex.DecodeString("000102030405060708090a0b0c0d0e0f")
	if err != nil {
		t.Fatal(err)
	}
	want := "abandon amount liar amount expire adjust cage candy arch gather drum buyer"
	phrase, err := EncodeRecoveryPhrase(entropy)
	if err != nil {
		t.Fatalf("EncodeRecoveryPhrase: %v", err)
	}
	if phrase != want {
		t.Fatalf("Recovery Phrase = %q, want %q", phrase, want)
	}
	decoded, err := DecodeRecoveryPhrase("  " + phrase + "  ")
	if err != nil {
		t.Fatalf("DecodeRecoveryPhrase: %v", err)
	}
	if !bytes.Equal(decoded, entropy) {
		t.Fatalf("decoded entropy = %x, want %x", decoded, entropy)
	}
}

func TestKeyEpochIDMatchesBrowserVector(t *testing.T) {
	var vaultID [32]byte
	for index := range vaultID {
		vaultID[index] = 1
	}
	key := bytes.Repeat([]byte{2}, 32)
	id, err := KeyEpochID(vaultID, key)
	if err != nil {
		t.Fatalf("KeyEpochID: %v", err)
	}
	want := "a15170f58c3006fed403e67173e76668462671109a847ac064e259db6a558f3e"
	if got := hex.EncodeToString(id[:]); got != want {
		t.Fatalf("Key Epoch ID = %s, want %s", got, want)
	}
}

func TestRecoveryCredentialDerivationIsDeterministic(t *testing.T) {
	entropy := bytes.Repeat([]byte{7}, 16)
	first, err := DeriveRecoveryCredential(entropy)
	if err != nil {
		t.Fatalf("first derivation: %v", err)
	}
	second, err := DeriveRecoveryCredential(entropy)
	if err != nil {
		t.Fatalf("second derivation: %v", err)
	}
	if !bytes.Equal(first.SigningSeed, second.SigningSeed) ||
		!bytes.Equal(first.SigningPublicKey, second.SigningPublicKey) ||
		!bytes.Equal(first.WrappingPrivateKey, second.WrappingPrivateKey) ||
		!bytes.Equal(first.WrappingPublicKey, second.WrappingPublicKey) {
		t.Fatal("Recovery Credential derivation is not deterministic")
	}
	if len(first.SigningSeed) != 32 || len(first.SigningPublicKey) != 32 ||
		len(first.SigningSecretKey) != 64 || len(first.WrappingPrivateKey) != 32 ||
		len(first.WrappingPublicKey) != 32 {
		t.Fatalf("unexpected Recovery Credential key sizes: %#v", first)
	}
}
