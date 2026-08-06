package awsmcrypto

import (
	"crypto/ecdh"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

var (
	hpkeSuiteID = []byte{'H', 'P', 'K', 'E', 0x00, 0x20, 0x00, 0x01, 0x00, 0x03}
	kemSuiteID  = []byte{'K', 'E', 'M', 0x00, 0x20}
)

func X25519PublicKey(privateKey []byte) ([]byte, error) {
	if len(privateKey) != 32 {
		return nil, errors.New("X25519 private key must contain exactly 32 bytes")
	}
	key, err := ecdh.X25519().NewPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("parse X25519 private key: %w", err)
	}
	return append([]byte(nil), key.PublicKey().Bytes()...), nil
}

func HPKESeal(recipientPublicKey, info, plaintext, aad, ephemeralSeed []byte) ([]byte, []byte, error) {
	if len(recipientPublicKey) != 32 {
		return nil, nil, errors.New("HPKE recipient public key must contain exactly 32 bytes")
	}
	recipient, err := ecdh.X25519().NewPublicKey(recipientPublicKey)
	if err != nil {
		return nil, nil, fmt.Errorf("parse HPKE recipient public key: %w", err)
	}
	if len(ephemeralSeed) == 0 {
		ephemeralSeed = make([]byte, 32)
		if _, err := io.ReadFull(cryptorand.Reader, ephemeralSeed); err != nil {
			return nil, nil, fmt.Errorf("generate HPKE ephemeral seed: %w", err)
		}
	}
	if len(ephemeralSeed) != 32 {
		return nil, nil, errors.New("HPKE ephemeral seed must contain exactly 32 bytes")
	}
	ephemeral, err := deriveHPKEKeyPair(ephemeralSeed)
	if err != nil {
		return nil, nil, err
	}
	dh, err := ephemeral.ECDH(recipient)
	if err != nil {
		return nil, nil, fmt.Errorf("HPKE encapsulation failed: %w", err)
	}
	enc := ephemeral.PublicKey().Bytes()
	shared, err := hpkeSharedSecret(dh, enc, recipientPublicKey)
	if err != nil {
		return nil, nil, err
	}
	key, nonce, err := hpkeKeySchedule(shared, info)
	if err != nil {
		return nil, nil, err
	}
	cipher, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, nil, fmt.Errorf("create HPKE cipher: %w", err)
	}
	return enc, cipher.Seal(nil, nonce, plaintext, aad), nil
}

func HPKEOpen(recipientPrivateKey, enc, info, ciphertext, aad []byte) ([]byte, error) {
	if len(recipientPrivateKey) != 32 || len(enc) != 32 {
		return nil, errors.New("HPKE private key and encapsulated key must contain exactly 32 bytes")
	}
	recipient, err := ecdh.X25519().NewPrivateKey(recipientPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("parse HPKE recipient private key: %w", err)
	}
	ephemeral, err := ecdh.X25519().NewPublicKey(enc)
	if err != nil {
		return nil, fmt.Errorf("parse HPKE encapsulated key: %w", err)
	}
	dh, err := recipient.ECDH(ephemeral)
	if err != nil {
		return nil, fmt.Errorf("HPKE decapsulation failed: %w", err)
	}
	recipientPublicKey := recipient.PublicKey().Bytes()
	shared, err := hpkeSharedSecret(dh, enc, recipientPublicKey)
	if err != nil {
		return nil, err
	}
	key, nonce, err := hpkeKeySchedule(shared, info)
	if err != nil {
		return nil, err
	}
	cipher, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, fmt.Errorf("create HPKE cipher: %w", err)
	}
	opened, err := cipher.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.New("HPKE authentication failed")
	}
	return opened, nil
}

func deriveHPKEKeyPair(seed []byte) (*ecdh.PrivateKey, error) {
	prk, err := hpkeLabeledExtract(kemSuiteID, nil, "dkp_prk", seed)
	if err != nil {
		return nil, err
	}
	rawPrivate, err := hpkeLabeledExpand(kemSuiteID, prk, "sk", nil, 32)
	if err != nil {
		return nil, err
	}
	key, err := ecdh.X25519().NewPrivateKey(rawPrivate)
	if err != nil {
		return nil, fmt.Errorf("derive HPKE ephemeral key: %w", err)
	}
	return key, nil
}

func hpkeSharedSecret(dh, enc, recipientPublicKey []byte) ([]byte, error) {
	if len(dh) != 32 || len(enc) != 32 || len(recipientPublicKey) != 32 {
		return nil, errors.New("HPKE KEM context has invalid length")
	}
	eaePRK, err := hpkeLabeledExtract(kemSuiteID, nil, "eae_prk", dh)
	if err != nil {
		return nil, err
	}
	kemContext := append(append([]byte(nil), enc...), recipientPublicKey...)
	return hpkeLabeledExpand(kemSuiteID, eaePRK, "shared_secret", kemContext, 32)
}

func hpkeKeySchedule(sharedSecret, info []byte) ([]byte, []byte, error) {
	pskIDHash, err := hpkeLabeledExtract(hpkeSuiteID, nil, "psk_id_hash", nil)
	if err != nil {
		return nil, nil, err
	}
	infoHash, err := hpkeLabeledExtract(hpkeSuiteID, nil, "info_hash", info)
	if err != nil {
		return nil, nil, err
	}
	context := make([]byte, 1+len(pskIDHash)+len(infoHash))
	context[0] = 0
	copy(context[1:], pskIDHash)
	copy(context[1+len(pskIDHash):], infoHash)
	secret, err := hpkeLabeledExtract(hpkeSuiteID, sharedSecret, "secret", nil)
	if err != nil {
		return nil, nil, err
	}
	key, err := hpkeLabeledExpand(hpkeSuiteID, secret, "key", context, 32)
	if err != nil {
		return nil, nil, err
	}
	nonce, err := hpkeLabeledExpand(hpkeSuiteID, secret, "base_nonce", context, 12)
	if err != nil {
		return nil, nil, err
	}
	return key, nonce, nil
}

func hpkeLabeledExtract(suiteID, salt []byte, label string, ikm []byte) ([]byte, error) {
	if len(suiteID) == 0 {
		return nil, errors.New("HPKE suite ID is required")
	}
	input := make([]byte, 0, 7+len(suiteID)+len(label)+len(ikm))
	input = append(input, []byte("HPKE-v1")...)
	input = append(input, suiteID...)
	input = append(input, []byte(label)...)
	input = append(input, ikm...)
	return hkdf.Extract(sha256.New, input, salt), nil
}

func hpkeLabeledExpand(suiteID, prk []byte, label string, info []byte, length int) ([]byte, error) {
	if len(suiteID) == 0 || len(prk) != 32 || length < 0 || length > 0xffff {
		return nil, errors.New("HPKE labeled expansion input is invalid")
	}
	labeledInfo := make([]byte, 0, 2+7+len(suiteID)+len(label)+len(info))
	var lengthBytes [2]byte
	binary.BigEndian.PutUint16(lengthBytes[:], uint16(length))
	labeledInfo = append(labeledInfo, lengthBytes[:]...)
	labeledInfo = append(labeledInfo, []byte("HPKE-v1")...)
	labeledInfo = append(labeledInfo, suiteID...)
	labeledInfo = append(labeledInfo, []byte(label)...)
	labeledInfo = append(labeledInfo, info...)
	result := make([]byte, length)
	if _, err := io.ReadFull(hkdf.Expand(sha256.New, prk, labeledInfo), result); err != nil {
		return nil, err
	}
	return result, nil
}
