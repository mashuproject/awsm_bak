// Package completeexport implements the portable encrypted Complete Export
// container. It deliberately has no Vault projection policy: callers supply
// the canonical entry stream and validate its Manifest separately.
package completeexport

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/text/unicode/norm"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

const (
	Format              uint64 = 1
	MemoryKiB                  = 65_536
	Iterations                 = 3
	Parallelism                = 1
	FramePlaintextLimit        = 1_048_576
	FrameTagLength             = chacha20poly1305.Overhead
	framePrefixLength          = 9
)

var Magic = [8]byte{0x41, 0x57, 0x53, 0x4d, 0x45, 0x58, 0x01, 0x00}

type Prefix struct {
	Format              uint64
	Salt                [16]byte
	MemoryKiB           uint64
	Iterations          uint64
	Parallelism         uint64
	Nonce               [24]byte
	FramePlaintextLimit uint64
	Bytes               []byte
	PrefixBytes         []byte
}

type Frame struct {
	Index     uint32
	Final     bool
	Plaintext []byte
}

type OpenedStream struct {
	Prefix     Prefix
	Plaintext  []byte
	FrameCount uint32
}

func EncodePrefix(salt [16]byte, nonce [24]byte) ([]byte, error) {
	header, err := canonical.EncodeValue(canonical.Map{
		0: Format, 1: append([]byte(nil), salt[:]...), 2: uint64(MemoryKiB),
		3: uint64(Iterations), 4: uint64(Parallelism), 5: append([]byte(nil), nonce[:]...),
		6: uint64(FramePlaintextLimit),
	})
	if err != nil {
		return nil, fmt.Errorf("encode Complete Export prefix: %w", err)
	}
	result := make([]byte, len(Magic)+4+len(header))
	copy(result, Magic[:])
	binary.BigEndian.PutUint32(result[len(Magic):], uint32(len(header)))
	copy(result[len(Magic)+4:], header)
	return result, nil
}

func DecodePrefix(prefixBytes []byte) (Prefix, error) {
	if len(prefixBytes) < len(Magic)+4+1 {
		return Prefix{}, errors.New("Complete Export prefix is truncated")
	}
	if !bytes.Equal(prefixBytes[:len(Magic)], Magic[:]) {
		return Prefix{}, errors.New("Complete Export magic is invalid")
	}
	headerLength := binary.BigEndian.Uint32(prefixBytes[len(Magic) : len(Magic)+4])
	if uint64(len(prefixBytes)) != uint64(len(Magic)+4)+uint64(headerLength) {
		return Prefix{}, errors.New("Complete Export decoder requires one exact prefix")
	}
	headerBytes := append([]byte(nil), prefixBytes[len(Magic)+4:]...)
	value, err := canonical.DecodeValue(headerBytes)
	if err != nil {
		return Prefix{}, fmt.Errorf("decode Complete Export header: %w", err)
	}
	fields, ok := numericMap(value)
	if !ok || len(fields) != 7 {
		return Prefix{}, errors.New("Complete Export header must contain the exact fields")
	}
	for index := uint64(0); index < 7; index++ {
		if _, ok := fields[index]; !ok {
			return Prefix{}, errors.New("Complete Export header omits a field")
		}
	}
	format, ok := uintValue(fields[0])
	if !ok || format != Format {
		return Prefix{}, errors.New("Complete Export format is unsupported")
	}
	saltBytes, ok := bytesValue(fields[1], 16)
	if !ok {
		return Prefix{}, errors.New("Complete Export salt is invalid")
	}
	memory, ok := uintValue(fields[2])
	if !ok || memory != MemoryKiB {
		return Prefix{}, errors.New("Complete Export Argon2 memory is unsupported")
	}
	iterations, ok := uintValue(fields[3])
	if !ok || iterations != Iterations {
		return Prefix{}, errors.New("Complete Export Argon2 iterations are unsupported")
	}
	parallelism, ok := uintValue(fields[4])
	if !ok || parallelism != Parallelism {
		return Prefix{}, errors.New("Complete Export Argon2 parallelism is unsupported")
	}
	nonceBytes, ok := bytesValue(fields[5], 24)
	if !ok {
		return Prefix{}, errors.New("Complete Export nonce is invalid")
	}
	limit, ok := uintValue(fields[6])
	if !ok || limit != FramePlaintextLimit {
		return Prefix{}, errors.New("Complete Export frame plaintext limit is unsupported")
	}
	canonicalHeader, err := canonical.EncodeValue(canonical.Map{
		0: Format, 1: saltBytes, 2: uint64(MemoryKiB), 3: uint64(Iterations),
		4: uint64(Parallelism), 5: nonceBytes, 6: uint64(FramePlaintextLimit),
	})
	if err != nil || !bytes.Equal(canonicalHeader, headerBytes) {
		return Prefix{}, errors.New("Complete Export header is not canonical")
	}
	var salt [16]byte
	copy(salt[:], saltBytes)
	var nonce [24]byte
	copy(nonce[:], nonceBytes)
	return Prefix{
		Format: Format, Salt: salt, MemoryKiB: MemoryKiB, Iterations: Iterations,
		Parallelism: Parallelism, Nonce: nonce, FramePlaintextLimit: FramePlaintextLimit,
		Bytes: headerBytes, PrefixBytes: append([]byte(nil), prefixBytes...),
	}, nil
}

func DeriveKey(passphrase string, prefix Prefix) ([]byte, error) {
	validated, err := DecodePrefix(prefix.PrefixBytes)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(validated.Bytes, prefix.Bytes) {
		return nil, errors.New("Complete Export prefix bytes are inconsistent")
	}
	normalized := norm.NFC.String(passphrase)
	if !utf8.ValidString(normalized) || len([]byte(normalized)) > 1024 {
		return nil, errors.New("Complete Export passphrase exceeds the portable bound")
	}
	return argon2.IDKey([]byte(normalized), validated.Salt[:], Iterations, MemoryKiB, Parallelism, 32), nil
}

func SealFrame(key, headerBytes []byte, baseNonce [24]byte, index uint32, final bool, plaintext []byte) ([]byte, error) {
	if err := validateFrameInputs(key, headerBytes); err != nil {
		return nil, err
	}
	if len(plaintext) > FramePlaintextLimit {
		return nil, errors.New("Complete Export frame exceeds the plaintext limit")
	}
	if !final && len(plaintext) != FramePlaintextLimit {
		return nil, errors.New("a non-final Complete Export frame must be full")
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("create Complete Export frame cipher: %w", err)
	}
	ciphertextLength := len(plaintext) + FrameTagLength
	aad := frameAAD(headerBytes, baseNonce, index, final, len(plaintext), ciphertextLength)
	ciphertext := aead.Seal(nil, frameNonce(baseNonce, index), plaintext, aad)
	result := make([]byte, framePrefixLength+len(ciphertext))
	binary.BigEndian.PutUint32(result[0:4], index)
	if final {
		result[4] = 1
	}
	binary.BigEndian.PutUint32(result[5:9], uint32(len(ciphertext)))
	copy(result[9:], ciphertext)
	return result, nil
}

func OpenFrame(key, headerBytes []byte, baseNonce [24]byte, frameBytes []byte, expectedIndex uint32) (Frame, error) {
	if err := validateFrameInputs(key, headerBytes); err != nil {
		return Frame{}, err
	}
	if len(frameBytes) < framePrefixLength+FrameTagLength {
		return Frame{}, errors.New("Complete Export frame is truncated")
	}
	index := binary.BigEndian.Uint32(frameBytes[:4])
	if index != expectedIndex {
		return Frame{}, errors.New("Complete Export frame index is invalid")
	}
	flags := frameBytes[4]
	if flags&0xfe != 0 {
		return Frame{}, errors.New("Complete Export frame flag is invalid")
	}
	final := flags&1 == 1
	ciphertextLength := binary.BigEndian.Uint32(frameBytes[5:9])
	if uint64(len(frameBytes)) != uint64(framePrefixLength)+uint64(ciphertextLength) {
		return Frame{}, errors.New("Complete Export frame length is invalid")
	}
	if ciphertextLength < FrameTagLength {
		return Frame{}, errors.New("Complete Export frame ciphertext length is invalid")
	}
	plaintextLength := int(ciphertextLength) - FrameTagLength
	if plaintextLength > FramePlaintextLimit || (!final && plaintextLength != FramePlaintextLimit) {
		return Frame{}, errors.New("Complete Export frame ciphertext length is invalid")
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return Frame{}, fmt.Errorf("create Complete Export frame cipher: %w", err)
	}
	aad := frameAAD(headerBytes, baseNonce, index, final, plaintextLength, int(ciphertextLength))
	plaintext, err := aead.Open(nil, frameNonce(baseNonce, index), frameBytes[framePrefixLength:], aad)
	if err != nil {
		return Frame{}, errors.New("Complete Export frame authentication failed")
	}
	return Frame{Index: index, Final: final, Plaintext: plaintext}, nil
}

func SealStream(passphrase string, salt [16]byte, nonce [24]byte, plaintext []byte) ([]byte, error) {
	prefixBytes, err := EncodePrefix(salt, nonce)
	if err != nil {
		return nil, err
	}
	prefix, err := DecodePrefix(prefixBytes)
	if err != nil {
		return nil, err
	}
	key, err := DeriveKey(passphrase, prefix)
	if err != nil {
		return nil, err
	}
	result := append([]byte(nil), prefixBytes...)
	if len(plaintext) == 0 {
		frame, frameErr := SealFrame(key, prefix.Bytes, nonce, 0, true, nil)
		if frameErr != nil {
			return nil, frameErr
		}
		return append(result, frame...), nil
	}
	for offset, index := 0, uint32(0); offset < len(plaintext); index++ {
		take := len(plaintext) - offset
		if take > FramePlaintextLimit {
			take = FramePlaintextLimit
		}
		final := offset+take == len(plaintext)
		frame, frameErr := SealFrame(key, prefix.Bytes, nonce, index, final, plaintext[offset:offset+take])
		if frameErr != nil {
			return nil, frameErr
		}
		result = append(result, frame...)
		offset += take
	}
	return result, nil
}

func OpenStream(passphrase string, encoded []byte) (OpenedStream, error) {
	if len(encoded) < len(Magic)+4+1 {
		return OpenedStream{}, errors.New("Complete Export stream is truncated")
	}
	headerLength := binary.BigEndian.Uint32(encoded[len(Magic) : len(Magic)+4])
	prefixLength := uint64(len(Magic)+4) + uint64(headerLength)
	if prefixLength > uint64(len(encoded)) {
		return OpenedStream{}, errors.New("Complete Export stream is truncated")
	}
	prefix, err := DecodePrefix(encoded[:prefixLength])
	if err != nil {
		return OpenedStream{}, err
	}
	key, err := DeriveKey(passphrase, prefix)
	if err != nil {
		return OpenedStream{}, err
	}
	var plaintext []byte
	offset := int(prefixLength)
	var expected uint32
	for {
		if offset == len(encoded) {
			return OpenedStream{}, errors.New("Complete Export stream has no final frame")
		}
		if len(encoded)-offset < framePrefixLength+FrameTagLength {
			return OpenedStream{}, errors.New("Complete Export stream is truncated")
		}
		ciphertextLength := binary.BigEndian.Uint32(encoded[offset+5 : offset+9])
		frameLength := uint64(framePrefixLength) + uint64(ciphertextLength)
		if frameLength > uint64(len(encoded)-offset) {
			return OpenedStream{}, errors.New("Complete Export stream is truncated")
		}
		frame, frameErr := OpenFrame(key, prefix.Bytes, prefix.Nonce, encoded[offset:offset+int(frameLength)], expected)
		if frameErr != nil {
			return OpenedStream{}, frameErr
		}
		plaintext = append(plaintext, frame.Plaintext...)
		offset += int(frameLength)
		expected++
		if frame.Final {
			if offset != len(encoded) {
				return OpenedStream{}, errors.New("Complete Export stream has trailing bytes")
			}
			return OpenedStream{Prefix: prefix, Plaintext: plaintext, FrameCount: expected}, nil
		}
	}
}

func validateFrameInputs(key, headerBytes []byte) error {
	if len(key) != chacha20poly1305.KeySize {
		return errors.New("Complete Export key must contain 32 bytes")
	}
	if len(headerBytes) == 0 {
		return errors.New("Complete Export header is empty")
	}
	return nil
}

func frameNonce(baseNonce [24]byte, index uint32) []byte {
	result := make([]byte, 24)
	copy(result, baseNonce[:16])
	binary.BigEndian.PutUint64(result[16:], uint64(index))
	return result
}

func frameAAD(headerBytes []byte, baseNonce [24]byte, index uint32, final bool, plaintextLength, ciphertextLength int) []byte {
	_ = baseNonce // The nonce is authenticated through the derived AEAD nonce.
	finalByte := byte(0)
	if final {
		finalByte = 1
	}
	parts := [][]byte{headerBytes, uint32Bytes(index), []byte{finalByte}, uint32Bytes(uint32(plaintextLength)), uint32Bytes(uint32(ciphertextLength))}
	transcript, err := canonical.Transcript("awsm:complete-export-frame:v1", parts...)
	if err != nil {
		panic(err)
	}
	return transcript
}

func uint32Bytes(value uint32) []byte {
	result := make([]byte, 4)
	binary.BigEndian.PutUint32(result, value)
	return result
}

func numericMap(value canonical.Value) (canonical.Map, bool) {
	if typed, ok := value.(canonical.Map); ok {
		return typed, true
	}
	if typed, ok := value.(map[any]any); ok {
		result := make(canonical.Map, len(typed))
		for key, entry := range typed {
			numeric, ok := key.(uint64)
			if !ok {
				return nil, false
			}
			result[numeric] = entry
		}
		return result, true
	}
	return nil, false
}

func uintValue(value any) (uint64, bool) {
	numeric, ok := value.(uint64)
	return numeric, ok
}

func bytesValue(value any, length int) ([]byte, bool) {
	valueBytes, ok := value.([]byte)
	return valueBytes, ok && len(valueBytes) == length
}

// entryIdentityDigest is shared by the semantic export implementation when it
// prepares entry IDs. It is kept here so the container and semantic layers use
// the same framing as the browser Runtime.
func EntryIdentityDigest(kind uint8, byteLength uint64, body []byte) [32]byte {
	label := "awsm:complete-export-key-inventory-entry-id:v1"
	if kind == 1 {
		label = "awsm:complete-export-manifest-entry-id:v1"
	}
	if kind == 2 {
		framing := append([]byte("awsm:storage-item-id:v1\x00"), uint32Bytes(1)...)
		length := make([]byte, 8)
		binary.BigEndian.PutUint64(length, byteLength)
		framing = append(framing, length...)
		framing = append(framing, body...)
		return sha256.Sum256(framing)
	}
	framing := append([]byte(label+"\x00"), uint32Bytes(1)...)
	length := make([]byte, 8)
	binary.BigEndian.PutUint64(length, byteLength)
	framing = append(framing, length...)
	framing = append(framing, body...)
	return sha256.Sum256(framing)
}
