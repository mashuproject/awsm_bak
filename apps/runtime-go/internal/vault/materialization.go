package vault

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/securestore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
	"golang.org/x/crypto/chacha20poly1305"
)

const (
	localMaterializationSecretService = "awsm.runtime.local"
	localMaterializationSecretAccount = "materialization-key"
	libraryMaterializationStatePrefix = "awsm.runtime.library."
)

var materializationKeyMu sync.Mutex

type encryptedLocalMaterialization struct {
	Format     uint64 `json:"format"`
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}

type persistedLibraryMaterialization struct {
	Context    string            `json:"context"`
	Projection LibraryProjection `json:"projection"`
}

func materializationKey(secrets securestore.Store) ([]byte, error) {
	materializationKeyMu.Lock()
	defer materializationKeyMu.Unlock()
	if secrets == nil {
		return nil, securestore.ErrUnavailable
	}
	key, err := secrets.Get(localMaterializationSecretService, localMaterializationSecretAccount)
	if err == nil {
		if len(key) != chacha20poly1305.KeySize {
			return nil, errors.New("installation materialization key has an invalid length")
		}
		return key, nil
	}
	if !errors.Is(err, securestore.ErrUnavailable) {
		return nil, err
	}
	key = make([]byte, chacha20poly1305.KeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate installation materialization key: %w", err)
	}
	if err := secrets.Put(localMaterializationSecretService, localMaterializationSecretAccount, key); err != nil {
		return nil, err
	}
	return key, nil
}

func materializationAAD(domain, vaultID, contextID string) []byte {
	value, err := canonical.Transcript(domain, []byte(vaultID), []byte(contextID))
	if err != nil {
		panic(err)
	}
	return value
}

func sealLocalMaterialization(secrets securestore.Store, domain, vaultID, contextID string, plaintext []byte) ([]byte, error) {
	key, err := materializationKey(secrets)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("create materialization cipher: %w", err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate materialization nonce: %w", err)
	}
	sealed := aead.Seal(nil, nonce, plaintext, materializationAAD(domain, vaultID, contextID))
	return json.Marshal(encryptedLocalMaterialization{Format: 1, Nonce: nonce, Ciphertext: sealed})
}

func openLocalMaterialization(secrets securestore.Store, domain, vaultID, contextID string, encoded []byte) ([]byte, error) {
	key, err := materializationKey(secrets)
	if err != nil {
		return nil, err
	}
	var wrapped encryptedLocalMaterialization
	if err := json.Unmarshal(encoded, &wrapped); err != nil {
		return nil, errors.New("materialization wrapper is invalid")
	}
	if wrapped.Format != 1 {
		return nil, errors.New("materialization wrapper format is unsupported")
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("create materialization cipher: %w", err)
	}
	if len(wrapped.Nonce) != aead.NonceSize() {
		return nil, errors.New("materialization wrapper nonce is invalid")
	}
	plaintext, err := aead.Open(nil, wrapped.Nonce, wrapped.Ciphertext, materializationAAD(domain, vaultID, contextID))
	if err != nil {
		return nil, errors.New("materialization wrapper authentication failed")
	}
	return plaintext, nil
}

func materializationContext(vaultID, generationID string, frontier []canonical.Identifier) (string, error) {
	value, err := json.Marshal(struct {
		VaultID      string   `json:"vaultId"`
		GenerationID string   `json:"generationId"`
		Frontier     []string `json:"frontier"`
	}{
		VaultID: vaultID, GenerationID: generationID, Frontier: identifiersHex(frontier),
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(value)
	return hexBytes(digest[:]), nil
}

func (r *Runtime) libraryMaterializationContextLocked(id string) (string, error) {
	vault, ok := r.vaults[id]
	if !ok || r.replicas[id] == nil || vault.Canonical == nil {
		return "", commandError("VAULT_NOT_FOUND", "The selected Vault was not found.")
	}
	return materializationContext(id, vault.GenerationID, r.replicas[id].State().CausalFrontier)
}

func (r *Runtime) loadLibraryMaterialization(ctx context.Context, id, contextID string) (LibraryProjection, bool) {
	encoded, err := r.store.Get(ctx, libraryMaterializationStatePrefix+id)
	if err != nil {
		if errors.Is(err, store.ErrStateNotFound) {
			return LibraryProjection{}, false
		}
		return LibraryProjection{}, false
	}
	plaintext, err := openLocalMaterialization(r.deps.Secrets, "awsm:library-materialization:v1", id, contextID, encoded)
	if err != nil {
		return LibraryProjection{}, false
	}
	var cached persistedLibraryMaterialization
	if err := json.Unmarshal(plaintext, &cached); err != nil || cached.Context != contextID {
		return LibraryProjection{}, false
	}
	return refreshLibraryAvailability(cached.Projection, r.replicas[id]), true
}

func refreshLibraryAvailability(projection LibraryProjection, replica *Replica) LibraryProjection {
	for index := range projection.Captures {
		artifactID, err := decodeHexIdentifier(projection.Captures[index].ArtifactID)
		if err != nil {
			projection.Captures[index].AvailableLocally = false
			continue
		}
		object, ok := replica.Object(artifactID)
		projection.Captures[index].AvailableLocally = ok && object.ObjectType == 2
	}
	return projection
}

func (r *Runtime) saveLibraryMaterialization(ctx context.Context, id, contextID string, projection LibraryProjection) {
	plaintext, err := json.Marshal(persistedLibraryMaterialization{Context: contextID, Projection: projection})
	if err != nil {
		return
	}
	encoded, err := sealLocalMaterialization(r.deps.Secrets, "awsm:library-materialization:v1", id, contextID, plaintext)
	if err != nil {
		return
	}
	_ = r.store.Put(ctx, libraryMaterializationStatePrefix+id, encoded)
}
