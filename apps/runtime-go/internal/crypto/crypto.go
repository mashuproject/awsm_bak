// Package awsmcrypto contains the portable cryptographic derivations owned by
// the Client Runtime. It never persists plaintext keys or Recovery Phrases.
package awsmcrypto

import (
	"crypto/ecdh"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/text/unicode/norm"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

type CredentialKeys struct {
	SigningSeed        []byte
	SigningPublicKey   []byte
	SigningSecretKey   []byte
	WrappingPrivateKey []byte
	WrappingPublicKey  []byte
}

func EncodeRecoveryPhrase(entropy []byte) (string, error) {
	if len(entropy) != 16 {
		return "", errors.New("Recovery entropy must contain exactly 16 bytes")
	}
	phrase, err := bip39.NewMnemonic(entropy)
	if err != nil {
		return "", fmt.Errorf("encode Recovery Phrase: %w", err)
	}
	return phrase, nil
}

func DecodeRecoveryPhrase(value string) ([]byte, error) {
	normalized := norm.NFKD.String(strings.Join(strings.Fields(norm.NFKD.String(value)), " "))
	if !bip39.IsMnemonicValid(normalized) {
		return nil, errors.New("invalid 12-word English Recovery Phrase")
	}
	entropy, err := bip39.MnemonicToByteArray(normalized, true)
	if err != nil {
		return nil, fmt.Errorf("decode Recovery Phrase: %w", err)
	}
	if len(entropy) != 16 {
		return nil, errors.New("Recovery Phrase must encode exactly 16 bytes")
	}
	return append([]byte(nil), entropy...), nil
}

func KeyEpochID(vaultID [32]byte, key []byte) ([32]byte, error) {
	if len(key) != 32 {
		return [32]byte{}, errors.New("Key Epoch Key must contain exactly 32 bytes")
	}
	prefix := []byte("awsm:key-epoch:v1\x00")
	input := make([]byte, 0, len(prefix)+len(vaultID)+len(key))
	input = append(input, prefix...)
	input = append(input, vaultID[:]...)
	input = append(input, key...)
	return sha256.Sum256(input), nil
}

func DeriveRecoveryCredential(entropy []byte) (CredentialKeys, error) {
	if len(entropy) != 16 {
		return CredentialKeys{}, errors.New("Recovery entropy must contain exactly 16 bytes")
	}
	rootSalt := sha256.Sum256([]byte("awsm:recovery-root:v1"))
	prk := hkdf.Extract(sha256.New, entropy, rootSalt[:])
	signingSeed, err := expand(prk, "awsm:recovery-signing-key:v1")
	if err != nil {
		return CredentialKeys{}, err
	}
	wrappingPrivateKey, err := expand(prk, "awsm:recovery-wrapping-key:v1")
	if err != nil {
		return CredentialKeys{}, err
	}
	return credentialFromSeeds(signingSeed, wrappingPrivateKey)
}

func CreateClientCredentialKeys(signingSeed, wrappingPrivateKey []byte) (CredentialKeys, error) {
	if len(signingSeed) == 0 {
		signingSeed = make([]byte, ed25519.SeedSize)
		if _, err := io.ReadFull(cryptorand.Reader, signingSeed); err != nil {
			return CredentialKeys{}, fmt.Errorf("generate Client signing seed: %w", err)
		}
	}
	if len(wrappingPrivateKey) == 0 {
		wrappingPrivateKey = make([]byte, 32)
		if _, err := io.ReadFull(cryptorand.Reader, wrappingPrivateKey); err != nil {
			return CredentialKeys{}, fmt.Errorf("generate Client wrapping key: %w", err)
		}
	}
	return credentialFromSeeds(signingSeed, wrappingPrivateKey)
}

func credentialFromSeeds(signingSeed, wrappingPrivateKey []byte) (CredentialKeys, error) {
	if len(signingSeed) != ed25519.SeedSize {
		return CredentialKeys{}, errors.New("Client signing seed must contain exactly 32 bytes")
	}
	if len(wrappingPrivateKey) != 32 {
		return CredentialKeys{}, errors.New("Client wrapping private key must contain exactly 32 bytes")
	}
	signingSecretKey := ed25519.NewKeyFromSeed(signingSeed)
	signingPublicKey := signingSecretKey.Public().(ed25519.PublicKey)
	wrapping, err := ecdh.X25519().NewPrivateKey(wrappingPrivateKey)
	if err != nil {
		return CredentialKeys{}, fmt.Errorf("derive Client wrapping public key: %w", err)
	}
	return CredentialKeys{
		SigningSeed:        append([]byte(nil), signingSeed...),
		SigningPublicKey:   append([]byte(nil), signingPublicKey...),
		SigningSecretKey:   append([]byte(nil), signingSecretKey...),
		WrappingPrivateKey: append([]byte(nil), wrapping.Bytes()...),
		WrappingPublicKey:  append([]byte(nil), wrapping.PublicKey().Bytes()...),
	}, nil
}

func expand(prk []byte, label string) ([]byte, error) {
	info, err := canonical.Transcript(label, nil)
	if err != nil {
		return nil, err
	}
	result := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.Expand(sha256.New, prk, info), result); err != nil {
		return nil, fmt.Errorf("derive %s: %w", label, err)
	}
	return result, nil
}
