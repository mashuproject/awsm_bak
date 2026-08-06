package awsmcrypto

import (
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

type CompactItemInput struct {
	VaultID              [32]byte
	KeyEpochID           [32]byte
	KeyEpochKey          []byte
	PayloadType          uint64
	PayloadBytes         []byte
	ProtectionParameters []byte
}

type OpenedCompactItem struct {
	KeyEpochID   [32]byte
	PayloadType  uint64
	PayloadBytes []byte
	Envelope     storage.OpaqueEnvelope
}

func EpochPRK(vaultID, epochID [32]byte, epochKey []byte) ([]byte, error) {
	if len(epochKey) != 32 {
		return nil, errors.New("Key Epoch Key must contain exactly 32 bytes")
	}
	expected, err := KeyEpochID(vaultID, epochKey)
	if err != nil {
		return nil, err
	}
	if expected != epochID {
		return nil, errors.New("Key Epoch ID does not match its Vault and Key Epoch Key")
	}
	saltTranscript, err := canonical.Transcript("awsm:key-epoch-extract:v1", vaultID[:], epochID[:])
	if err != nil {
		return nil, err
	}
	salt := sha256.Sum256(saltTranscript)
	return hkdfExtract(epochKey, salt[:]), nil
}

func CompactItemKey(input CompactItemInput) ([]byte, error) {
	if len(input.ProtectionParameters) != 64 {
		return nil, errors.New("Compact protection parameters must contain exactly 64 bytes")
	}
	prk, err := EpochPRK(input.VaultID, input.KeyEpochID, input.KeyEpochKey)
	if err != nil {
		return nil, err
	}
	info, err := canonical.Transcript(
		"awsm:compact-item-key:v1",
		input.VaultID[:],
		input.KeyEpochID[:],
		[]byte{byte(storage.CompactStorageClass)},
		input.ProtectionParameters,
	)
	if err != nil {
		return nil, err
	}
	return hkdfExpand(prk, info, 32)
}

func SealCompactItem(input CompactItemInput) ([]byte, error) {
	if input.PayloadType < 1 || input.PayloadType > 4 {
		return nil, errors.New("unknown Compact payload type")
	}
	if len(input.KeyEpochKey) != 32 {
		return nil, errors.New("Key Epoch Key must contain exactly 32 bytes")
	}
	protection := append([]byte(nil), input.ProtectionParameters...)
	if len(protection) == 0 {
		protection = make([]byte, 64)
		if _, err := io.ReadFull(cryptorand.Reader, protection); err != nil {
			return nil, fmt.Errorf("generate Compact protection parameters: %w", err)
		}
	}
	if len(protection) != 64 {
		return nil, errors.New("Compact protection parameters must contain exactly 64 bytes")
	}
	plaintext, err := canonical.EncodeValue(canonical.Map{
		0: append([]byte(nil), input.KeyEpochID[:]...),
		1: input.PayloadType,
		2: append([]byte(nil), input.PayloadBytes...),
	})
	if err != nil {
		return nil, fmt.Errorf("encode Compact plaintext: %w", err)
	}
	key, err := CompactItemKey(CompactItemInput{
		VaultID: input.VaultID, KeyEpochID: input.KeyEpochID, KeyEpochKey: input.KeyEpochKey,
		ProtectionParameters: protection,
	})
	if err != nil {
		return nil, err
	}
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("create Compact cipher: %w", err)
	}
	ciphertextLength := len(plaintext) + cipher.Overhead()
	aad, err := compactAAD(input.VaultID, input.KeyEpochID, protection, len(plaintext), ciphertextLength)
	if err != nil {
		return nil, err
	}
	ciphertext := cipher.Seal(nil, protection[:24], plaintext, aad)
	return storage.EncodeOpaqueEnvelope(storage.OpaqueEnvelopeInput{
		StorageClass:         storage.CompactStorageClass,
		ProtectionParameters: protection,
		Payload:              ciphertext,
	})
}

func OpenCompactItem(vaultID, epochID [32]byte, epochKey, envelopeBytes []byte) (OpenedCompactItem, error) {
	envelope, err := storage.DecodeOpaqueEnvelope(envelopeBytes)
	if err != nil {
		return OpenedCompactItem{}, err
	}
	if envelope.StorageClass != storage.CompactStorageClass {
		return OpenedCompactItem{}, errors.New("item is not Compact")
	}
	key, err := CompactItemKey(CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		ProtectionParameters: envelope.ProtectionParameters,
	})
	if err != nil {
		return OpenedCompactItem{}, err
	}
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return OpenedCompactItem{}, err
	}
	plaintextLength := len(envelope.Payload) - cipher.Overhead()
	if plaintextLength < 0 {
		return OpenedCompactItem{}, errors.New("Compact ciphertext is too short")
	}
	aad, err := compactAAD(vaultID, epochID, envelope.ProtectionParameters, plaintextLength, len(envelope.Payload))
	if err != nil {
		return OpenedCompactItem{}, err
	}
	plaintext, err := cipher.Open(nil, envelope.ProtectionParameters[:24], envelope.Payload, aad)
	if err != nil {
		return OpenedCompactItem{}, errors.New("Compact authentication failed")
	}
	value, err := canonical.DecodeValue(plaintext)
	if err != nil {
		return OpenedCompactItem{}, fmt.Errorf("decode Compact plaintext: %w", err)
	}
	if !compactIsMap(value) || len(compactMapKeys(value)) != 3 {
		return OpenedCompactItem{}, errors.New("Compact plaintext contains missing or unknown fields")
	}
	epochBytes, ok := compactMapBytes(value, 0)
	if !ok || len(epochBytes) != 32 || !bytesEqual(epochBytes, epochID[:]) {
		return OpenedCompactItem{}, errors.New("Compact plaintext Key Epoch ID is invalid")
	}
	payloadType, ok := compactMapNumber(value, 1)
	if !ok || payloadType < 1 || payloadType > 4 {
		return OpenedCompactItem{}, errors.New("Compact plaintext payload type is invalid")
	}
	payload, ok := compactMapBytes(value, 2)
	if !ok {
		return OpenedCompactItem{}, errors.New("Compact plaintext payload must be bytes")
	}
	return OpenedCompactItem{
		KeyEpochID:   epochID,
		PayloadType:  payloadType,
		PayloadBytes: append([]byte(nil), payload...),
		Envelope:     envelope,
	}, nil
}

func compactAAD(vaultID, epochID [32]byte, protection []byte, plaintextLength, ciphertextLength int) ([]byte, error) {
	return canonical.Transcript(
		"awsm:compact-item-aad:v1",
		vaultID[:], epochID[:], []byte{byte(storage.CompactStorageClass)}, protection,
		uint64Bytes(uint64(plaintextLength)), uint64Bytes(uint64(ciphertextLength)),
	)
}

func uint64Bytes(value uint64) []byte {
	result := make([]byte, 8)
	binary.BigEndian.PutUint64(result, value)
	return result
}

func hkdfExtract(secret, salt []byte) []byte {
	return hkdf.Extract(sha256.New, secret, salt)
}

func hkdfExpand(prk, info []byte, length int) ([]byte, error) {
	result := make([]byte, length)
	if _, err := io.ReadFull(hkdf.Expand(sha256.New, prk, info), result); err != nil {
		return nil, err
	}
	return result, nil
}

func compactIsMap(value canonical.Value) bool {
	switch value.(type) {
	case canonical.Map, map[any]any:
		return true
	default:
		return false
	}
}

func compactMapKeys(value canonical.Value) []uint64 {
	keys := []uint64{}
	switch typed := value.(type) {
	case canonical.Map:
		for key := range typed {
			keys = append(keys, key)
		}
	case map[any]any:
		for key := range typed {
			if numeric, ok := key.(uint64); ok {
				keys = append(keys, numeric)
			}
		}
	}
	return keys
}

func compactMapBytes(value canonical.Value, key uint64) ([]byte, bool) {
	entry, ok := compactMapValue(value, key)
	if !ok {
		return nil, false
	}
	bytesValue, ok := entry.([]byte)
	return bytesValue, ok
}

func compactMapNumber(value canonical.Value, key uint64) (uint64, bool) {
	entry, ok := compactMapValue(value, key)
	if !ok {
		return 0, false
	}
	numeric, ok := entry.(uint64)
	return numeric, ok
}

func compactMapValue(value canonical.Value, key uint64) (canonical.Value, bool) {
	switch typed := value.(type) {
	case canonical.Map:
		entry, ok := typed[key]
		return entry, ok
	case map[any]any:
		entry, ok := typed[key]
		return entry, ok
	default:
		return nil, false
	}
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
