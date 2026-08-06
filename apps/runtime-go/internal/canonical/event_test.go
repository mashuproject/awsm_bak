package canonical

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"testing"
)

func TestTranscriptUsesLengthDelimitedFraming(t *testing.T) {
	got, err := Transcript("awsm:test:v1", []byte{0x01, 0x02}, []byte{0xaa})
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	want, err := hex.DecodeString("6177736d3a746573743a76310000000002000000000000000201020000000000000001aa")
	if err != nil {
		t.Fatalf("decode expected vector: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("Transcript = %x, want %x", got, want)
	}
}

func TestVaultEventVectorMatchesBrowserCanonicalImplementation(t *testing.T) {
	bytesFor := func(start byte) [32]byte {
		var value [32]byte
		for index := range value {
			value[index] = start + byte(index)
		}
		return value
	}
	input := EventInput{
		VaultID:              bytesFor(1),
		GenerationID:         bytesFor(33),
		RequiredFeatureSetID: bytesFor(65),
		SignerCredentialID:   bytesFor(97),
		Family:               AuthorityFamily,
		Type:                 GenesisEvent,
		AssertedAt:           123,
		Body:                 Map{0: uint64(1)},
	}
	seed := bytesFor(1)
	privateKey := ed25519.NewKeyFromSeed(seed[:])

	event, err := SignEvent(input, privateKey)
	if err != nil {
		t.Fatalf("SignEvent: %v", err)
	}
	wantBytes, err := hex.DecodeString("af00010158200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f200258202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f4003800480058006010758204142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f6008a009010a010b58206162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f800c187b0da100010e584015d1fe310513c3b69fabf8bf75506dc780a4fcacba380e5ed646da13dea7810a984105a9bcb9d733f6ebb49ca451fbb3278d7fe5b03329be346e5d20532c6f0a")
	if err != nil {
		t.Fatalf("decode event vector: %v", err)
	}
	if !bytes.Equal(event.Bytes, wantBytes) {
		t.Fatalf("event bytes = %x, want %x", event.Bytes, wantBytes)
	}
	wantRecordID, err := hex.DecodeString("a94e30640eb96bd8368094f2ccdd41f6a295bf4f6b7bc98b0328cb288ff361e3")
	if err != nil {
		t.Fatalf("decode record ID vector: %v", err)
	}
	if !bytes.Equal(event.RecordID[:], wantRecordID) {
		t.Fatalf("record ID = %x, want %x", event.RecordID, wantRecordID)
	}
	if !VerifyEventSignature(event, privateKey.Public().(ed25519.PublicKey)) {
		t.Fatal("VerifyEventSignature rejected the canonical event")
	}
	mutated := append([]byte(nil), event.Bytes...)
	mutated[len(mutated)-1] ^= 0x01
	decoded, err := DecodeEvent(mutated)
	if err != nil {
		t.Fatalf("DecodeEvent rejected a structurally valid tampered event: %v", err)
	}
	if VerifyEventSignature(decoded, privateKey.Public().(ed25519.PublicKey)) {
		t.Fatal("VerifyEventSignature accepted a tampered signature")
	}
}
