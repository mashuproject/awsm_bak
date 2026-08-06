package awsmcrypto

import (
	cryptorand "crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

const (
	RecoveryCredentialTarget uint64 = 1
	ClientCredentialTarget   uint64 = 2
)

type KeyEnvelopeInput struct {
	VaultID                    [32]byte
	KeyEpochID                 [32]byte
	KeyEpochKey                []byte
	TargetKind                 uint64
	TargetCredentialID         [32]byte
	TargetRevision             *uint64
	RecipientWrappingPublicKey []byte
	Padding                    []byte
	EphemeralSeed              []byte
}

type KeyEnvelope struct {
	VaultID              [32]byte
	KeyEpochID           [32]byte
	KeyEpochKey          []byte
	TargetKind           uint64
	TargetCredentialID   [32]byte
	TargetRevision       *uint64
	ProtectionParameters []byte
	Bytes                []byte
	ID                   [32]byte
	Envelope             storage.OpaqueEnvelope
}

func SealKeyEnvelope(input KeyEnvelopeInput) (KeyEnvelope, error) {
	if err := validateKeyEnvelopeTarget(input.TargetKind, input.TargetRevision); err != nil {
		return KeyEnvelope{}, err
	}
	if input.TargetCredentialID == ([32]byte{}) {
		return KeyEnvelope{}, errors.New("Key Envelope target Credential ID must not be zero")
	}
	if len(input.KeyEpochKey) != 32 {
		return KeyEnvelope{}, errors.New("Key Envelope Key Epoch Key must contain exactly 32 bytes")
	}
	expectedEpoch, err := KeyEpochID(input.VaultID, input.KeyEpochKey)
	if err != nil {
		return KeyEnvelope{}, err
	}
	if expectedEpoch != input.KeyEpochID {
		return KeyEnvelope{}, errors.New("Key Envelope Key Epoch ID does not match its key and Vault")
	}
	plaintext, err := encodeKeyEnvelopePlaintext(input)
	if err != nil {
		return KeyEnvelope{}, err
	}
	padding := append([]byte(nil), input.Padding...)
	if len(padding) == 0 {
		padding = make([]byte, 32)
		if _, err := io.ReadFull(cryptorand.Reader, padding); err != nil {
			return KeyEnvelope{}, fmt.Errorf("generate Key Envelope padding: %w", err)
		}
	}
	if len(padding) != 32 {
		return KeyEnvelope{}, errors.New("Key Envelope padding must contain exactly 32 bytes")
	}
	info, err := keyEnvelopeInfo(input.TargetKind, padding)
	if err != nil {
		return KeyEnvelope{}, err
	}
	enc, ciphertext, err := HPKESeal(input.RecipientWrappingPublicKey, info, plaintext, nil, input.EphemeralSeed)
	if err != nil {
		return KeyEnvelope{}, err
	}
	protection := append(append([]byte(nil), enc...), padding...)
	outer, err := storage.EncodeOpaqueEnvelope(storage.OpaqueEnvelopeInput{
		StorageClass:         storage.CompactStorageClass,
		ProtectionParameters: protection,
		Payload:              ciphertext,
	})
	if err != nil {
		return KeyEnvelope{}, err
	}
	decoded, err := storage.DecodeOpaqueEnvelope(outer)
	if err != nil {
		return KeyEnvelope{}, err
	}
	return KeyEnvelope{
		VaultID: input.VaultID, KeyEpochID: input.KeyEpochID,
		KeyEpochKey: append([]byte(nil), input.KeyEpochKey...), TargetKind: input.TargetKind,
		TargetCredentialID: input.TargetCredentialID, TargetRevision: cloneRevision(input.TargetRevision),
		ProtectionParameters: protection, Bytes: append([]byte(nil), plaintext...),
		ID: sha256.Sum256(mustKeyEnvelopeTranscript(plaintext)), Envelope: decoded,
	}, nil
}

func OpenKeyEnvelope(targetKind uint64, recipientWrappingPrivateKey, envelopeBytes []byte) (KeyEnvelope, error) {
	if targetKind != RecoveryCredentialTarget && targetKind != ClientCredentialTarget {
		return KeyEnvelope{}, errors.New("Key Envelope target kind is unknown")
	}
	envelope, err := storage.DecodeOpaqueEnvelope(envelopeBytes)
	if err != nil {
		return KeyEnvelope{}, err
	}
	if envelope.StorageClass != storage.CompactStorageClass || len(envelope.ProtectionParameters) != 64 {
		return KeyEnvelope{}, errors.New("Key Envelope outer representation is invalid")
	}
	padding := envelope.ProtectionParameters[32:]
	info, err := keyEnvelopeInfo(targetKind, padding)
	if err != nil {
		return KeyEnvelope{}, err
	}
	plaintext, err := HPKEOpen(recipientWrappingPrivateKey, envelope.ProtectionParameters[:32], info, envelope.Payload, nil)
	if err != nil {
		return KeyEnvelope{}, err
	}
	input, err := decodeKeyEnvelopePlaintext(plaintext)
	if err != nil {
		return KeyEnvelope{}, err
	}
	if input.TargetKind != targetKind {
		return KeyEnvelope{}, errors.New("opened Key Envelope target kind does not match the attempted context")
	}
	return KeyEnvelope{
		VaultID: input.VaultID, KeyEpochID: input.KeyEpochID,
		KeyEpochKey: append([]byte(nil), input.KeyEpochKey...), TargetKind: input.TargetKind,
		TargetCredentialID: input.TargetCredentialID, TargetRevision: cloneRevision(input.TargetRevision),
		ProtectionParameters: append([]byte(nil), envelope.ProtectionParameters...), Bytes: append([]byte(nil), plaintext...),
		ID: sha256.Sum256(mustKeyEnvelopeTranscript(plaintext)), Envelope: envelope,
	}, nil
}

func encodeKeyEnvelopePlaintext(input KeyEnvelopeInput) ([]byte, error) {
	var revision canonical.Value
	if input.TargetRevision != nil {
		revision = *input.TargetRevision
	}
	return canonical.EncodeValue(canonical.Map{
		0: uint64(1),
		1: append([]byte(nil), input.VaultID[:]...),
		2: append([]byte(nil), input.KeyEpochID[:]...),
		3: append([]byte(nil), input.KeyEpochKey...),
		4: input.TargetKind,
		5: append([]byte(nil), input.TargetCredentialID[:]...),
		6: revision,
	})
}

func decodeKeyEnvelopePlaintext(encoded []byte) (KeyEnvelopeInput, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return KeyEnvelopeInput{}, err
	}
	if !compactIsMap(value) || len(compactMapKeys(value)) != 7 {
		return KeyEnvelopeInput{}, errors.New("Key Envelope plaintext contains missing or unknown fields")
	}
	var input KeyEnvelopeInput
	if input.VaultID, err = keyEnvelopeIdentifier(value, 1, "Vault ID"); err != nil {
		return KeyEnvelopeInput{}, err
	}
	if input.KeyEpochID, err = keyEnvelopeIdentifier(value, 2, "Key Epoch ID"); err != nil {
		return KeyEnvelopeInput{}, err
	}
	if input.KeyEpochKey, err = keyEnvelopeBytes(value, 3, "Key Epoch Key", 32); err != nil {
		return KeyEnvelopeInput{}, err
	}
	if input.TargetKind, err = keyEnvelopeNumber(value, 4, "target kind"); err != nil {
		return KeyEnvelopeInput{}, err
	}
	if input.TargetCredentialID, err = keyEnvelopeIdentifier(value, 5, "target Credential ID"); err != nil {
		return KeyEnvelopeInput{}, err
	}
	revisionValue, ok := compactMapValue(value, 6)
	if !ok {
		return KeyEnvelopeInput{}, errors.New("Key Envelope target revision is missing")
	}
	if revisionValue != nil {
		revision, ok := revisionValue.(uint64)
		if !ok {
			return KeyEnvelopeInput{}, errors.New("Key Envelope target revision is invalid")
		}
		input.TargetRevision = &revision
	}
	if err := validateKeyEnvelopeTarget(input.TargetKind, input.TargetRevision); err != nil {
		return KeyEnvelopeInput{}, err
	}
	expectedEpoch, err := KeyEpochID(input.VaultID, input.KeyEpochKey)
	if err != nil || expectedEpoch != input.KeyEpochID {
		return KeyEnvelopeInput{}, errors.New("Key Envelope Key Epoch binding is invalid")
	}
	return input, nil
}

func validateKeyEnvelopeTarget(kind uint64, revision *uint64) error {
	if kind != RecoveryCredentialTarget && kind != ClientCredentialTarget {
		return errors.New("Key Envelope target kind is unknown")
	}
	if (kind == RecoveryCredentialTarget) != (revision != nil) {
		return errors.New("Key Envelope revision must exist only for a Recovery Credential")
	}
	return nil
}

func keyEnvelopeInfo(kind uint64, padding []byte) ([]byte, error) {
	label := "awsm:client-key-envelope-hpke:v1"
	if kind == RecoveryCredentialTarget {
		label = "awsm:recovery-key-envelope-hpke:v1"
	}
	return canonical.Transcript(label, padding)
}

func keyEnvelopeIdentifier(value canonical.Value, key uint64, field string) ([32]byte, error) {
	bytesValue, err := keyEnvelopeBytes(value, key, field, 32)
	if err != nil {
		return [32]byte{}, err
	}
	var result [32]byte
	copy(result[:], bytesValue)
	if result == ([32]byte{}) {
		return [32]byte{}, fmt.Errorf("%s must not be zero", field)
	}
	return result, nil
}

func keyEnvelopeBytes(value canonical.Value, key uint64, field string, length int) ([]byte, error) {
	bytesValue, ok := compactMapBytes(value, key)
	if !ok || len(bytesValue) != length {
		return nil, fmt.Errorf("%s must contain exactly %d bytes", field, length)
	}
	return append([]byte(nil), bytesValue...), nil
}

func keyEnvelopeNumber(value canonical.Value, key uint64, field string) (uint64, error) {
	numeric, ok := compactMapNumber(value, key)
	if !ok {
		return 0, fmt.Errorf("%s must be an unsigned integer", field)
	}
	return numeric, nil
}

func cloneRevision(value *uint64) *uint64 {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func mustKeyEnvelopeTranscript(plaintext []byte) []byte {
	value, err := canonical.Transcript("awsm:key-envelope-id:v1", plaintext)
	if err != nil {
		panic(err)
	}
	return value
}
