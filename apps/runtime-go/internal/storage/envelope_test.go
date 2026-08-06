package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

func TestCompactOpaqueEnvelopeRoundTripsAndAddressesExactBytes(t *testing.T) {
	protection := bytes.Repeat([]byte{0x11}, 64)
	payload := bytes.Repeat([]byte{0x22}, 32)
	encoded, err := EncodeOpaqueEnvelope(OpaqueEnvelopeInput{
		StorageClass:         CompactStorageClass,
		ProtectionParameters: protection,
		Payload:              payload,
	})
	if err != nil {
		t.Fatalf("EncodeOpaqueEnvelope: %v", err)
	}
	decoded, err := DecodeOpaqueEnvelope(encoded)
	if err != nil {
		t.Fatalf("DecodeOpaqueEnvelope: %v", err)
	}
	if decoded.StorageClass != CompactStorageClass || !bytes.Equal(decoded.Payload, payload) ||
		!bytes.Equal(decoded.ProtectionParameters, protection) {
		t.Fatalf("decoded envelope = %#v", decoded)
	}
	transcript, err := canonical.Transcript("awsm:storage-item-id:v1", encoded)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(transcript)
	if decoded.StorageItemID != want {
		t.Fatalf("Storage Item ID = %x, want %x", decoded.StorageItemID, want)
	}
	if decoded.CiphertextLength != uint64(len(payload)) || decoded.FramePlaintextLimit != 0 {
		t.Fatalf("decoded lengths = %#v", decoded)
	}
}

func TestOpaqueEnvelopeRejectsDigestAndFramingMutation(t *testing.T) {
	encoded, err := EncodeOpaqueEnvelope(OpaqueEnvelopeInput{
		StorageClass:         CompactStorageClass,
		ProtectionParameters: bytes.Repeat([]byte{0x33}, 64),
		Payload:              bytes.Repeat([]byte{0x44}, 16),
	})
	if err != nil {
		t.Fatalf("EncodeOpaqueEnvelope: %v", err)
	}
	mutated := append([]byte(nil), encoded...)
	mutated[len(mutated)-1] ^= 1
	if _, err := DecodeOpaqueEnvelope(mutated); err == nil {
		t.Fatal("DecodeOpaqueEnvelope accepted a payload digest mutation")
	}
	mutated = append([]byte(nil), encoded...)
	binary.BigEndian.PutUint32(mutated[8:12], 0)
	if _, err := DecodeOpaqueEnvelope(mutated); err == nil {
		t.Fatal("DecodeOpaqueEnvelope accepted an invalid header length")
	}
	if _, err := DecodeOpaqueEnvelope(append(encoded, 0)); err == nil {
		t.Fatal("DecodeOpaqueEnvelope accepted trailing bytes")
	}
}

func TestOpaqueEnvelopeUsesExpectedMagicAndHeaderShape(t *testing.T) {
	encoded, err := EncodeOpaqueEnvelope(OpaqueEnvelopeInput{
		StorageClass:         CompactStorageClass,
		ProtectionParameters: bytes.Repeat([]byte{0x55}, 64),
		Payload:              bytes.Repeat([]byte{0x66}, 16),
	})
	if err != nil {
		t.Fatalf("EncodeOpaqueEnvelope: %v", err)
	}
	if got := hex.EncodeToString(encoded[:8]); got != "4157534d53450100" {
		t.Fatalf("opaque envelope magic = %s", got)
	}
	headerLength := binary.BigEndian.Uint32(encoded[8:12])
	if headerLength == 0 || headerLength > 4096 || int(12+headerLength) >= len(encoded) {
		t.Fatalf("invalid encoded header length %d", headerLength)
	}
}
