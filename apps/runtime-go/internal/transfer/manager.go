// Package transfer implements the local, one-use handoff boundary used by a
// Client move ceremony. It does not interpret Vault events. The payload is an
// already-encrypted Complete Export or other Runtime-owned transfer package.
package transfer

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"

	"github.com/google/uuid"
	"golang.org/x/crypto/chacha20poly1305"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/artifactstore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

const (
	persistedStateKey = "awsm.runtime.transfers"
	artifactSuffix    = ".transfer"
)

var magic = []byte("AWSMTR1")

type StateStore interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
	Delete(context.Context, string) error
}

type Transfer struct {
	TransferID string `json:"transferId"`
	VaultID    string `json:"vaultId"`
	Secret     string `json:"secret"`
}

type Summary struct {
	TransferID string `json:"transferId"`
	VaultID    string `json:"vaultId"`
	ByteLength int    `json:"byteLength"`
	Digest     string `json:"digest"`
}

type pending struct {
	TransferID string `json:"transferId"`
	VaultID    string `json:"vaultId"`
	SecretHash string `json:"secretHash"`
	Staged     bool   `json:"staged"`
	ByteLength int    `json:"byteLength"`
	Digest     string `json:"digest"`
}

type Manager struct {
	mu        sync.RWMutex
	state     StateStore
	artifacts *artifactstore.Store
	pending   map[string]pending
}

func NewManager(ctx context.Context, state StateStore, artifacts *artifactstore.Store) (*Manager, error) {
	if state == nil || artifacts == nil {
		return nil, errors.New("transfer state and artifact store are required")
	}
	manager := &Manager{state: state, artifacts: artifacts, pending: make(map[string]pending)}
	serialized, err := state.Get(ctx, persistedStateKey)
	if errors.Is(err, store.ErrStateNotFound) {
		return manager, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load transfer state: %w", err)
	}
	var values []pending
	if err := json.Unmarshal(serialized, &values); err != nil {
		return nil, fmt.Errorf("decode transfer state: %w", err)
	}
	for _, value := range values {
		if value.TransferID == "" || value.SecretHash == "" {
			return nil, errors.New("transfer state contains an invalid pending operation")
		}
		if !value.Staged {
			// An unsubmitted one-use secret is intentionally not recoverable after
			// a restart. Dropping it is safe; the source can begin a fresh move.
			continue
		}
		manager.pending[value.TransferID] = value
	}
	return manager, nil
}

func (m *Manager) Begin(ctx context.Context, vaultID string) (Transfer, error) {
	if vaultID == "" {
		return Transfer{}, errors.New("Vault identifier is required")
	}
	secretBytes := make([]byte, chacha20poly1305.KeySize)
	if _, err := rand.Read(secretBytes); err != nil {
		return Transfer{}, fmt.Errorf("generate transfer secret: %w", err)
	}
	transfer := Transfer{TransferID: uuid.NewString(), VaultID: vaultID, Secret: base64.RawURLEncoding.EncodeToString(secretBytes)}
	value := pending{TransferID: transfer.TransferID, VaultID: vaultID, SecretHash: digest(secretBytes)}
	m.mu.Lock()
	m.pending[transfer.TransferID] = value
	if err := m.persistLocked(ctx); err != nil {
		delete(m.pending, transfer.TransferID)
		m.mu.Unlock()
		return Transfer{}, err
	}
	m.mu.Unlock()
	return transfer, nil
}

// Seal creates the outer transfer envelope. The caller should place a
// Complete Export package (and any sealed local credential envelope) inside.
func Seal(secret string, plaintext []byte) ([]byte, error) {
	key, err := decodeSecret(secret)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, cipher.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate transfer nonce: %w", err)
	}
	sealed := cipher.Seal(nil, nonce, plaintext, magic)
	result := make([]byte, 0, len(magic)+len(nonce)+len(sealed))
	result = append(result, magic...)
	result = append(result, nonce...)
	result = append(result, sealed...)
	return result, nil
}

func (m *Manager) Stage(ctx context.Context, transferID, secret string, envelope io.Reader) (Summary, error) {
	key, err := decodeSecret(secret)
	if err != nil {
		return Summary{}, err
	}
	defer clear(key)
	envelopeBytes, err := io.ReadAll(envelope)
	if err != nil {
		return Summary{}, fmt.Errorf("read transfer envelope: %w", err)
	}
	plaintext, err := open(key, envelopeBytes)
	if err != nil {
		return Summary{}, errors.New("transfer envelope failed authentication")
	}
	digestValue := sha256.Sum256(plaintext)
	summary := Summary{TransferID: transferID, ByteLength: len(plaintext), Digest: hex.EncodeToString(digestValue[:])}
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.pending[transferID]
	if !ok {
		return Summary{}, errors.New("transfer operation not found")
	}
	if value.Staged {
		return Summary{}, errors.New("transfer operation has already been staged")
	}
	if digest(key) != value.SecretHash {
		return Summary{}, errors.New("transfer secret is invalid")
	}
	if err := m.artifacts.Put(artifactID(transferID), bytesReader(plaintext)); err != nil {
		return Summary{}, err
	}
	value.Staged = true
	value.ByteLength = summary.ByteLength
	value.Digest = summary.Digest
	m.pending[transferID] = value
	if err := m.persistLocked(ctx); err != nil {
		_ = m.artifacts.Delete(artifactID(transferID))
		value.Staged = false
		m.pending[transferID] = value
		return Summary{}, err
	}
	return Summary{TransferID: transferID, VaultID: value.VaultID, ByteLength: summary.ByteLength, Digest: summary.Digest}, nil
}

func (m *Manager) Pending() []Summary {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Summary, 0, len(m.pending))
	for _, value := range m.pending {
		if !value.Staged {
			continue
		}
		result = append(result, Summary{TransferID: value.TransferID, VaultID: value.VaultID, ByteLength: value.ByteLength, Digest: value.Digest})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].TransferID < result[right].TransferID })
	return result
}

func (m *Manager) OpenStaged(transferID string) ([]byte, Summary, error) {
	m.mu.RLock()
	value, ok := m.pending[transferID]
	m.mu.RUnlock()
	if !ok || !value.Staged {
		return nil, Summary{}, errors.New("staged transfer not found")
	}
	file, err := m.artifacts.Open(artifactID(transferID))
	if err != nil {
		return nil, Summary{}, err
	}
	defer file.Close()
	bytes, err := io.ReadAll(file)
	if err != nil {
		return nil, Summary{}, err
	}
	digestValue := sha256.Sum256(bytes)
	if hex.EncodeToString(digestValue[:]) != value.Digest || len(bytes) != value.ByteLength {
		return nil, Summary{}, errors.New("staged transfer integrity check failed")
	}
	return bytes, Summary{TransferID: value.TransferID, VaultID: value.VaultID, ByteLength: value.ByteLength, Digest: value.Digest}, nil
}

func (m *Manager) Remove(ctx context.Context, transferID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.pending[transferID]; !ok {
		return errors.New("transfer operation not found")
	}
	if err := m.artifacts.Delete(artifactID(transferID)); err != nil && !os.IsNotExist(err) {
		// os.ErrNotExist is intentionally handled by the store caller only; a
		// missing staged file is still a failed cleanup, not a successful move.
		return err
	}
	delete(m.pending, transferID)
	return m.persistLocked(ctx)
}

func (m *Manager) persistLocked(ctx context.Context) error {
	values := make([]pending, 0, len(m.pending))
	for _, value := range m.pending {
		values = append(values, value)
	}
	bytes, err := json.Marshal(values)
	if err != nil {
		return err
	}
	return m.state.Put(ctx, persistedStateKey, bytes)
}

func decodeSecret(value string) ([]byte, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(bytes) != chacha20poly1305.KeySize {
		return nil, errors.New("transfer secret is invalid")
	}
	return bytes, nil
}

func digest(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }

func clear(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func open(key, envelope []byte) ([]byte, error) {
	if len(envelope) < len(magic) {
		return nil, errors.New("transfer envelope is truncated")
	}
	for index, value := range magic {
		if envelope[index] != value {
			return nil, errors.New("transfer envelope has an invalid magic")
		}
	}
	cipher, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	start := len(magic)
	end := start + cipher.NonceSize()
	if len(envelope) <= end {
		return nil, errors.New("transfer envelope is truncated")
	}
	return cipher.Open(nil, envelope[start:end], envelope[end:], magic)
}

func artifactID(transferID string) string { return transferID + artifactSuffix }

type byteReader struct {
	bytes  []byte
	offset int
}

func (r *byteReader) Read(destination []byte) (int, error) {
	if r.offset == len(r.bytes) {
		return 0, io.EOF
	}
	count := copy(destination, r.bytes[r.offset:])
	r.offset += count
	return count, nil
}

func bytesReader(bytes []byte) io.Reader { return &byteReader{bytes: bytes} }
