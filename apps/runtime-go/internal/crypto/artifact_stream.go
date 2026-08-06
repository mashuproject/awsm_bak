package awsmcrypto

import (
	"bytes"
	"crypto/cipher"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

const (
	ArtifactFramePlaintextLimit = int(storage.FramePlaintextLimit)
	ArtifactFrameTagLength      = chacha20poly1305.Overhead
)

type ArtifactStreamInput struct {
	VaultID              [32]byte
	KeyEpochID           [32]byte
	KeyEpochKey          []byte
	ArtifactID           [32]byte
	Plaintext            []byte
	PlaintextDigest      [32]byte
	ProtectionParameters []byte
}

type ArtifactStreamOpenInput struct {
	VaultID         [32]byte
	KeyEpochID      [32]byte
	KeyEpochKey     []byte
	ArtifactID      [32]byte
	PlaintextLength uint64
	PlaintextDigest [32]byte
	EnvelopeBytes   []byte
}

type OpenedArtifactStream struct {
	Plaintext     []byte
	FrameCount    uint32
	Envelope      storage.OpaqueEnvelope
	ByteDigest    [32]byte
	PlaintextHash [32]byte
}

func ArtifactPayloadDigest(plaintext []byte) [32]byte {
	transcript, err := canonical.Transcript("awsm:artifact-payload:v1", plaintext)
	if err != nil {
		panic(err)
	}
	return sha256.Sum256(transcript)
}

func SealArtifactStream(input ArtifactStreamInput) ([]byte, error) {
	if len(input.KeyEpochKey) != 32 {
		return nil, errors.New("Artifact Key Epoch Key must contain exactly 32 bytes")
	}
	if input.PlaintextDigest != ArtifactPayloadDigest(input.Plaintext) {
		return nil, errors.New("Artifact plaintext digest does not match its contract")
	}
	protection := append([]byte(nil), input.ProtectionParameters...)
	if len(protection) == 0 {
		protection = make([]byte, 64)
		if _, err := cryptorand.Read(protection); err != nil {
			return nil, fmt.Errorf("generate Artifact protection parameters: %w", err)
		}
	}
	if len(protection) != 64 {
		return nil, errors.New("Artifact protection parameters must contain exactly 64 bytes")
	}
	key, err := artifactWrapperKey(input.VaultID, input.KeyEpochID, input.KeyEpochKey, input.ArtifactID, protection)
	if err != nil {
		return nil, err
	}
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	frames := bytes.NewBuffer(nil)
	if len(input.Plaintext) == 0 {
		if err := sealArtifactFrame(frames, cipher, input, protection, 0, true, nil); err != nil {
			return nil, err
		}
	} else {
		var index uint32
		for offset := 0; offset < len(input.Plaintext); index++ {
			remaining := len(input.Plaintext) - offset
			frameLength := remaining
			if frameLength > ArtifactFramePlaintextLimit {
				frameLength = ArtifactFramePlaintextLimit
			}
			final := remaining <= ArtifactFramePlaintextLimit
			if err := sealArtifactFrame(frames, cipher, input, protection, index, final, input.Plaintext[offset:offset+frameLength]); err != nil {
				return nil, err
			}
			offset += frameLength
		}
	}
	return storage.EncodeOpaqueEnvelope(storage.OpaqueEnvelopeInput{
		StorageClass: storage.StreamableStorageClass, ProtectionParameters: protection, Payload: frames.Bytes(),
	})
}

func sealArtifactFrame(
	output *bytes.Buffer,
	cipher cipher.AEAD,
	input ArtifactStreamInput,
	protection []byte,
	index uint32,
	final bool,
	plaintext []byte,
) error {
	ciphertextLength := len(plaintext) + ArtifactFrameTagLength
	aad, err := artifactFrameAAD(input.VaultID, input.KeyEpochID, input.ArtifactID, protection, uint64(len(input.Plaintext)), index, final, len(plaintext), ciphertextLength)
	if err != nil {
		return err
	}
	nonce := artifactFrameNonce(protection, index)
	ciphertext := cipher.Seal(nil, nonce, plaintext, aad)
	var prefix [9]byte
	binary.BigEndian.PutUint32(prefix[:4], index)
	if final {
		prefix[4] = 1
	}
	binary.BigEndian.PutUint32(prefix[5:], uint32(len(ciphertext)))
	_, _ = output.Write(prefix[:])
	_, _ = output.Write(ciphertext)
	return nil
}

func OpenArtifactStream(input ArtifactStreamOpenInput) (OpenedArtifactStream, error) {
	if len(input.KeyEpochKey) != 32 {
		return OpenedArtifactStream{}, errors.New("Artifact Key Epoch Key must contain exactly 32 bytes")
	}
	if input.PlaintextLength > uint64(^uint(0)>>1) {
		return OpenedArtifactStream{}, errors.New("Artifact plaintext length exceeds local bounds")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(input.EnvelopeBytes)
	if err != nil {
		return OpenedArtifactStream{}, err
	}
	if envelope.StorageClass != storage.StreamableStorageClass {
		return OpenedArtifactStream{}, errors.New("Artifact wrapper is not Streamable")
	}
	key, err := artifactWrapperKey(input.VaultID, input.KeyEpochID, input.KeyEpochKey, input.ArtifactID, envelope.ProtectionParameters)
	if err != nil {
		return OpenedArtifactStream{}, err
	}
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return OpenedArtifactStream{}, err
	}
	plaintext := make([]byte, 0, int(input.PlaintextLength))
	plaintextHasher := artifactPayloadHasher(input.PlaintextLength)
	var expectedIndex uint32
	var offset int
	sawFinal := false
	for offset < len(envelope.Payload) {
		if sawFinal || len(envelope.Payload)-offset < 9 {
			return OpenedArtifactStream{}, errors.New("Artifact frame prefix is invalid")
		}
		frame := envelope.Payload[offset : offset+9]
		index := binary.BigEndian.Uint32(frame[:4])
		flags := frame[4]
		ciphertextLength := int(binary.BigEndian.Uint32(frame[5:9]))
		if index != expectedIndex || flags&0xfe != 0 || ciphertextLength < ArtifactFrameTagLength || ciphertextLength > ArtifactFramePlaintextLimit+ArtifactFrameTagLength {
			return OpenedArtifactStream{}, errors.New("Artifact frame metadata is invalid")
		}
		final := flags&1 == 1
		if !final && ciphertextLength != ArtifactFramePlaintextLimit+ArtifactFrameTagLength {
			return OpenedArtifactStream{}, errors.New("Artifact non-final frame length is invalid")
		}
		if len(envelope.Payload)-offset-9 < ciphertextLength {
			return OpenedArtifactStream{}, errors.New("Artifact frame is truncated")
		}
		ciphertext := envelope.Payload[offset+9 : offset+9+ciphertextLength]
		aad, err := artifactFrameAAD(input.VaultID, input.KeyEpochID, input.ArtifactID, envelope.ProtectionParameters, input.PlaintextLength, index, final, ciphertextLength-ArtifactFrameTagLength, ciphertextLength)
		if err != nil {
			return OpenedArtifactStream{}, err
		}
		decrypted, err := cipher.Open(nil, artifactFrameNonce(envelope.ProtectionParameters, index), ciphertext, aad)
		if err != nil {
			return OpenedArtifactStream{}, errors.New("Artifact frame authentication failed")
		}
		if uint64(len(plaintext)+len(decrypted)) > input.PlaintextLength {
			return OpenedArtifactStream{}, errors.New("Artifact frames exceed their plaintext contract")
		}
		_, _ = plaintextHasher.Write(decrypted)
		plaintext = append(plaintext, decrypted...)
		expectedIndex++
		offset += 9 + ciphertextLength
		sawFinal = final
	}
	if !sawFinal || expectedIndex == 0 {
		return OpenedArtifactStream{}, errors.New("Artifact stream is missing its final frame")
	}
	if uint64(len(plaintext)) != input.PlaintextLength {
		return OpenedArtifactStream{}, errors.New("Artifact plaintext length does not match its contract")
	}
	plaintextHash := hashSum(plaintextHasher)
	if plaintextHash != input.PlaintextDigest {
		return OpenedArtifactStream{}, errors.New("Artifact plaintext digest does not match its contract")
	}
	return OpenedArtifactStream{Plaintext: plaintext, FrameCount: expectedIndex, Envelope: envelope, ByteDigest: sha256.Sum256(input.EnvelopeBytes), PlaintextHash: plaintextHash}, nil
}

func artifactWrapperKey(vaultID, epochID [32]byte, epochKey []byte, artifactID [32]byte, protection []byte) ([]byte, error) {
	if len(protection) != 64 {
		return nil, errors.New("Artifact protection parameters must contain exactly 64 bytes")
	}
	prk, err := EpochPRK(vaultID, epochID, epochKey)
	if err != nil {
		return nil, err
	}
	info, err := canonical.Transcript("awsm:artifact-wrapper-key:v1", vaultID[:], epochID[:], artifactID[:], []byte{2}, protection)
	if err != nil {
		return nil, err
	}
	return hkdfExpand(prk, info, 32)
}

func artifactFrameAAD(vaultID, epochID, artifactID [32]byte, protection []byte, totalLength uint64, index uint32, final bool, plaintextLength, ciphertextLength int) ([]byte, error) {
	finalValue := byte(0)
	if final {
		finalValue = 1
	}
	return canonical.Transcript("awsm:artifact-frame-aad:v1", vaultID[:], epochID[:], artifactID[:], protection, uint64Bytes(totalLength), uint32Bytes(index), []byte{finalValue}, uint32Bytes(uint32(plaintextLength)), uint32Bytes(uint32(ciphertextLength)))
}

func artifactFrameNonce(protection []byte, index uint32) []byte {
	nonce := make([]byte, 24)
	copy(nonce, protection[:16])
	binary.BigEndian.PutUint64(nonce[16:], uint64(index))
	return nonce
}

func artifactPayloadHasher(length uint64) hash.Hash {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("awsm:artifact-payload:v1\x00"))
	_, _ = hasher.Write(uint32Bytes(1))
	_, _ = hasher.Write(uint64Bytes(length))
	return hasher
}

func hashSum(hasher hash.Hash) [32]byte {
	var result [32]byte
	copy(result[:], hasher.Sum(nil))
	return result
}

func uint32Bytes(value uint32) []byte {
	result := make([]byte, 4)
	binary.BigEndian.PutUint32(result, value)
	return result
}
