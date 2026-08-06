package awsmcrypto

import (
	"bytes"
	"testing"
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
