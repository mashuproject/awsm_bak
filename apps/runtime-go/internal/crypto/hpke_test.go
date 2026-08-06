package awsmcrypto

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestHPKEBaseRoundTripWithDeterministicEphemeral(t *testing.T) {
	recipientPrivate := bytes.Repeat([]byte{0x31}, 32)
	recipientPublic, err := X25519PublicKey(recipientPrivate)
	if err != nil {
		t.Fatalf("X25519PublicKey: %v", err)
	}
	enc, ciphertext, err := HPKESeal(recipientPublic, []byte("info"), []byte("secret payload"), []byte("aad"), bytes.Repeat([]byte{0x41}, 32))
	if err != nil {
		t.Fatalf("HPKESeal: %v", err)
	}
	if len(enc) != 32 || len(ciphertext) != len("secret payload")+16 {
		t.Fatalf("HPKE output sizes = %d, %d", len(enc), len(ciphertext))
	}
	if got := hex.EncodeToString(enc); got != "fd2c4dd1c8a6b88fe1fc59ce441398f5ea83a9296e210997ac63bed970b86028" {
		t.Fatalf("HPKE encapsulated key = %s", got)
	}
	if got := hex.EncodeToString(ciphertext); got != "17d81952117c24d3e736b050164daef9d5bf3f95ed3474af2d758eeca330" {
		t.Fatalf("HPKE ciphertext = %s", got)
	}
	opened, err := HPKEOpen(recipientPrivate, enc, []byte("info"), ciphertext, []byte("aad"))
	if err != nil {
		t.Fatalf("HPKEOpen: %v", err)
	}
	if string(opened) != "secret payload" {
		t.Fatalf("HPKE plaintext = %q", opened)
	}
	if _, err := HPKEOpen(recipientPrivate, enc, []byte("wrong"), ciphertext, []byte("aad")); err == nil {
		t.Fatal("HPKEOpen accepted the wrong info transcript")
	}
}

func TestHPKEUsesTheRFCSuiteBinding(t *testing.T) {
	privateKey := bytes.Repeat([]byte{0x32}, 32)
	publicKey, err := X25519PublicKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	enc, ciphertext, err := HPKESeal(publicKey, nil, nil, nil, bytes.Repeat([]byte{0x33}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(enc); got == "" {
		t.Fatal("HPKE encapsulated key is empty")
	}
	if _, err := HPKEOpen(bytes.Repeat([]byte{0x34}, 32), enc, nil, ciphertext, nil); err == nil {
		t.Fatal("HPKEOpen accepted an unrelated private key")
	}
}
