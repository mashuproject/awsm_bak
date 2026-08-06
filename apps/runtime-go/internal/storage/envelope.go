// Package storage contains Host-visible opaque storage codecs. It does not
// interpret the protected payload or assign semantic meaning to its fields.
package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

var opaqueEnvelopeMagic = [8]byte{0x41, 0x57, 0x53, 0x4d, 0x53, 0x45, 0x01, 0x00}

const (
	StorageEnvelopeFormat  uint64 = 1
	CompactStorageClass    uint64 = 1
	StreamableStorageClass uint64 = 2
	FramePlaintextLimit    uint64 = 1_048_576
	FrameTagLength         uint64 = 16
	CompactCeiling         uint64 = 16 * 1024 * 1024
)

type OpaqueEnvelopeInput struct {
	StorageClass         uint64
	ProtectionParameters []byte
	Payload              []byte
}

type OpaqueEnvelope struct {
	StorageClass         uint64
	ProtectionParameters []byte
	CiphertextLength     uint64
	CiphertextDigest     [32]byte
	FramePlaintextLimit  uint64
	HeaderBytes          []byte
	Payload              []byte
	Bytes                []byte
	StorageItemID        [32]byte
}

func EncodeOpaqueEnvelope(input OpaqueEnvelopeInput) ([]byte, error) {
	if err := validateEnvelopeInput(input); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(input.Payload)
	frameLimit := uint64(0)
	if input.StorageClass == StreamableStorageClass {
		frameLimit = FramePlaintextLimit
	}
	header, err := canonical.EncodeValue(canonical.Map{
		0: StorageEnvelopeFormat,
		1: input.StorageClass,
		2: append([]byte(nil), input.ProtectionParameters...),
		3: uint64(len(input.Payload)),
		4: append([]byte(nil), digest[:]...),
		5: frameLimit,
	})
	if err != nil {
		return nil, fmt.Errorf("encode opaque envelope header: %w", err)
	}
	if len(header) == 0 || len(header) > 4096 {
		return nil, errors.New("opaque envelope header length is outside bounds")
	}
	result := make([]byte, 12+len(header)+len(input.Payload))
	copy(result[:8], opaqueEnvelopeMagic[:])
	binary.BigEndian.PutUint32(result[8:12], uint32(len(header)))
	copy(result[12:], header)
	copy(result[12+len(header):], input.Payload)
	if _, err := DecodeOpaqueEnvelope(result); err != nil {
		return nil, fmt.Errorf("validate encoded opaque envelope: %w", err)
	}
	return result, nil
}

func DecodeOpaqueEnvelope(encoded []byte) (OpaqueEnvelope, error) {
	if len(encoded) < len(opaqueEnvelopeMagic)+4 {
		return OpaqueEnvelope{}, errors.New("opaque envelope is truncated")
	}
	if !bytes.Equal(encoded[:8], opaqueEnvelopeMagic[:]) {
		return OpaqueEnvelope{}, errors.New("opaque envelope magic is invalid")
	}
	headerLength := binary.BigEndian.Uint32(encoded[8:12])
	if headerLength == 0 || headerLength > 4096 {
		return OpaqueEnvelope{}, errors.New("opaque envelope header length is outside bounds")
	}
	if uint64(12)+uint64(headerLength) > uint64(len(encoded)) {
		return OpaqueEnvelope{}, errors.New("opaque envelope header is truncated")
	}
	headerBytes := encoded[12 : 12+headerLength]
	value, err := canonical.DecodeValue(headerBytes)
	if err != nil {
		return OpaqueEnvelope{}, fmt.Errorf("decode opaque envelope header: %w", err)
	}
	if !isMap(value) {
		return OpaqueEnvelope{}, errors.New("opaque envelope header must be a map")
	}
	for key := uint64(0); key <= 5; key++ {
		if _, ok := envelopeMapLookup(value, key); !ok {
			return OpaqueEnvelope{}, fmt.Errorf("opaque envelope header is missing field %d", key)
		}
	}
	if len(envelopeMapKeys(value)) != 6 {
		return OpaqueEnvelope{}, errors.New("opaque envelope header contains unknown fields")
	}
	format, ok := envelopeNumeric(value, 0)
	if !ok || format != StorageEnvelopeFormat {
		return OpaqueEnvelope{}, errors.New("opaque envelope format is unknown")
	}
	storageClass, ok := envelopeNumeric(value, 1)
	if !ok {
		return OpaqueEnvelope{}, errors.New("opaque envelope storage class is invalid")
	}
	protection, ok := envelopeBytes(value, 2)
	if !ok || len(protection) != 64 {
		return OpaqueEnvelope{}, errors.New("opaque envelope protection parameters must contain 64 bytes")
	}
	ciphertextLength, ok := envelopeNumeric(value, 3)
	if !ok || ciphertextLength != uint64(len(encoded))-12-uint64(headerLength) {
		return OpaqueEnvelope{}, errors.New("opaque envelope ciphertext length is invalid")
	}
	digestBytes, ok := envelopeBytes(value, 4)
	if !ok || len(digestBytes) != 32 {
		return OpaqueEnvelope{}, errors.New("opaque envelope ciphertext digest is invalid")
	}
	frameLimit, ok := envelopeNumeric(value, 5)
	if !ok {
		return OpaqueEnvelope{}, errors.New("opaque envelope frame limit is invalid")
	}
	payload := encoded[12+headerLength:]
	observedDigest := sha256.Sum256(payload)
	if !bytes.Equal(digestBytes, observedDigest[:]) {
		return OpaqueEnvelope{}, errors.New("opaque envelope ciphertext digest does not match payload")
	}
	if err := validateClassPayload(storageClass, frameLimit, payload); err != nil {
		return OpaqueEnvelope{}, err
	}
	var digestValue [32]byte
	copy(digestValue[:], digestBytes)
	transcript, err := canonical.Transcript("awsm:storage-item-id:v1", encoded)
	if err != nil {
		return OpaqueEnvelope{}, err
	}
	return OpaqueEnvelope{
		StorageClass:         storageClass,
		ProtectionParameters: append([]byte(nil), protection...),
		CiphertextLength:     ciphertextLength,
		CiphertextDigest:     digestValue,
		FramePlaintextLimit:  frameLimit,
		HeaderBytes:          append([]byte(nil), headerBytes...),
		Payload:              append([]byte(nil), payload...),
		Bytes:                append([]byte(nil), encoded...),
		StorageItemID:        sha256.Sum256(transcript),
	}, nil
}

func validateEnvelopeInput(input OpaqueEnvelopeInput) error {
	if input.StorageClass != CompactStorageClass && input.StorageClass != StreamableStorageClass {
		return errors.New("opaque envelope storage class is unknown")
	}
	if len(input.ProtectionParameters) != 64 {
		return errors.New("opaque envelope protection parameters must contain 64 bytes")
	}
	return validateClassPayload(input.StorageClass, func() uint64 {
		if input.StorageClass == StreamableStorageClass {
			return FramePlaintextLimit
		}
		return 0
	}(), input.Payload)
}

func validateClassPayload(storageClass, frameLimit uint64, payload []byte) error {
	switch storageClass {
	case CompactStorageClass:
		if frameLimit != 0 {
			return errors.New("compact envelope frame limit must be zero")
		}
		if uint64(len(payload)) < FrameTagLength || uint64(len(payload)) > CompactCeiling {
			return errors.New("compact envelope payload length is outside bounds")
		}
	case StreamableStorageClass:
		if frameLimit != FramePlaintextLimit {
			return errors.New("streamable envelope frame limit is invalid")
		}
		if err := validateStreamPayload(payload); err != nil {
			return err
		}
	default:
		return errors.New("opaque envelope storage class is unknown")
	}
	return nil
}

func validateStreamPayload(payload []byte) error {
	if len(payload) == 0 {
		return errors.New("streamable envelope requires a final frame")
	}
	offset := 0
	var expectedIndex uint32
	sawFinal := false
	for offset < len(payload) {
		if len(payload)-offset < 9 || sawFinal {
			return errors.New("streamable envelope frame prefix is invalid")
		}
		index := binary.BigEndian.Uint32(payload[offset : offset+4])
		flags := payload[offset+4]
		ciphertextLength := binary.BigEndian.Uint32(payload[offset+5 : offset+9])
		if index != expectedIndex || flags&0xfe != 0 {
			return errors.New("streamable envelope frame index or flags are invalid")
		}
		final := flags&1 == 1
		minimum := uint32(FrameTagLength)
		if !final {
			minimum = uint32(FramePlaintextLimit + FrameTagLength)
		}
		maximum := uint32(FramePlaintextLimit + FrameTagLength)
		if ciphertextLength < minimum || ciphertextLength > maximum {
			return errors.New("streamable envelope frame length is invalid")
		}
		offset += 9
		if len(payload)-offset < int(ciphertextLength) {
			return errors.New("streamable envelope frame is truncated")
		}
		offset += int(ciphertextLength)
		expectedIndex++
		sawFinal = final
	}
	if !sawFinal {
		return errors.New("streamable envelope requires one final frame")
	}
	return nil
}

func isMap(value canonical.Value) bool {
	switch value.(type) {
	case canonical.Map, map[any]any:
		return true
	default:
		return false
	}
}

func envelopeMapLookup(value canonical.Value, key uint64) (canonical.Value, bool) {
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

func envelopeMapKeys(value canonical.Value) []uint64 {
	keys := []uint64{}
	switch typed := value.(type) {
	case canonical.Map:
		for key := range typed {
			keys = append(keys, key)
		}
	case map[any]any:
		for key := range typed {
			numeric, ok := key.(uint64)
			if ok {
				keys = append(keys, numeric)
			}
		}
	}
	return keys
}

func envelopeNumeric(value canonical.Value, key uint64) (uint64, bool) {
	entry, ok := envelopeMapLookup(value, key)
	if !ok {
		return 0, false
	}
	numeric, ok := entry.(uint64)
	return numeric, ok
}

func envelopeBytes(value canonical.Value, key uint64) ([]byte, bool) {
	entry, ok := envelopeMapLookup(value, key)
	if !ok {
		return nil, false
	}
	bytesValue, ok := entry.([]byte)
	return bytesValue, ok
}
