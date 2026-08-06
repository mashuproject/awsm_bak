package awsmcrypto

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

func TestArtifactStreamRoundTripsAuthenticatedFrames(t *testing.T) {
	var vaultID [32]byte
	var artifactID [32]byte
	for index := range vaultID {
		vaultID[index] = byte(index + 1)
		artifactID[index] = byte(0xa0 + index)
	}
	epochKey := bytes.Repeat([]byte{0x42}, 32)
	epochID, err := KeyEpochID(vaultID, epochKey)
	if err != nil {
		t.Fatalf("KeyEpochID: %v", err)
	}
	plaintext := bytes.Repeat([]byte{0x7f}, int(ArtifactFramePlaintextLimit)+17)
	digest := ArtifactPayloadDigest(plaintext)
	protection := bytes.Repeat([]byte{0x11}, 64)
	encoded, err := SealArtifactStream(ArtifactStreamInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		ArtifactID: artifactID, Plaintext: plaintext, PlaintextDigest: digest,
		ProtectionParameters: protection,
	})
	if err != nil {
		t.Fatalf("SealArtifactStream: %v", err)
	}
	opened, err := OpenArtifactStream(ArtifactStreamOpenInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		ArtifactID: artifactID, PlaintextLength: uint64(len(plaintext)), PlaintextDigest: digest,
		EnvelopeBytes: encoded,
	})
	if err != nil {
		t.Fatalf("OpenArtifactStream: %v", err)
	}
	if !bytes.Equal(opened.Plaintext, plaintext) || opened.FrameCount != 2 {
		t.Fatalf("opened Artifact = %d bytes/%d frames, want %d/2", len(opened.Plaintext), opened.FrameCount, len(plaintext))
	}
}

func TestArtifactStreamRejectsWrongContract(t *testing.T) {
	var vaultID [32]byte
	var artifactID [32]byte
	epochKey := bytes.Repeat([]byte{0x13}, 32)
	epochID, err := KeyEpochID(vaultID, epochKey)
	if err != nil {
		t.Fatalf("KeyEpochID: %v", err)
	}
	plaintext := []byte("artifact")
	digest := ArtifactPayloadDigest(plaintext)
	encoded, err := SealArtifactStream(ArtifactStreamInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		ArtifactID: artifactID, Plaintext: plaintext, PlaintextDigest: digest,
		ProtectionParameters: bytes.Repeat([]byte{0x22}, 64),
	})
	if err != nil {
		t.Fatalf("SealArtifactStream: %v", err)
	}
	wrongDigest := digest
	wrongDigest[0] ^= 1
	if _, err := OpenArtifactStream(ArtifactStreamOpenInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		ArtifactID: artifactID, PlaintextLength: uint64(len(plaintext)), PlaintextDigest: wrongDigest,
		EnvelopeBytes: encoded,
	}); err == nil {
		t.Fatal("OpenArtifactStream accepted a wrong Artifact payload contract")
	}
}

func TestArtifactStreamMatchesBrowserCiphertextVector(t *testing.T) {
	var vaultID [32]byte
	var artifactID [32]byte
	for index := range vaultID {
		vaultID[index] = 1
		artifactID[index] = 3
	}
	epochKey := bytes.Repeat([]byte{2}, 32)
	epochID, err := KeyEpochID(vaultID, epochKey)
	if err != nil {
		t.Fatalf("KeyEpochID: %v", err)
	}
	plaintext := make([]byte, int(ArtifactFramePlaintextLimit)*2+17)
	for index := range plaintext {
		plaintext[index] = byte(index % 251)
	}
	digest := ArtifactPayloadDigest(plaintext)
	encoded, err := SealArtifactStream(ArtifactStreamInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		ArtifactID: artifactID, Plaintext: plaintext, PlaintextDigest: digest,
		ProtectionParameters: bytes.Repeat([]byte{4}, 64),
	})
	if err != nil {
		t.Fatalf("SealArtifactStream: %v", err)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		t.Fatalf("DecodeOpaqueEnvelope: %v", err)
	}
	if got := hex.EncodeToString(envelope.CiphertextDigest[:]); got != "9625cf00f16ac04f6d0b2dbb437b9b24bd707038cfbefbd4992a22d05fa78d1b" {
		t.Fatalf("browser Artifact ciphertext digest = %s", got)
	}
}
