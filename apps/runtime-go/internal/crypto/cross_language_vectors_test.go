package awsmcrypto

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type crossLanguageVectors struct {
	Recovery struct {
		Entropy            string `json:"entropy"`
		Phrase             string `json:"phrase"`
		SigningSeed        string `json:"signingSeed"`
		SigningPublicKey   string `json:"signingPublicKey"`
		WrappingPrivateKey string `json:"wrappingPrivateKey"`
		WrappingPublicKey  string `json:"wrappingPublicKey"`
	} `json:"recovery"`
	KeyEpoch struct {
		VaultID    string `json:"vaultId"`
		Key        string `json:"key"`
		ID         string `json:"id"`
		EpochPRK   string `json:"epochPrk"`
		Protection string `json:"protection"`
		CompactKey string `json:"compactKey"`
		ArtifactID string `json:"artifactId"`
		WrapperKey string `json:"wrapperKey"`
		FirstNonce string `json:"firstNonce"`
		LastNonce  string `json:"lastNonce"`
	} `json:"keyEpoch"`
}

func readCrossLanguageVectors(t *testing.T) crossLanguageVectors {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Join(filepath.Dir(filename), "../../../test-vectors/canonical-v1.json")
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared canonical vectors: %v", err)
	}
	var vectors crossLanguageVectors
	if err := json.Unmarshal(encoded, &vectors); err != nil {
		t.Fatalf("decode shared canonical vectors: %v", err)
	}
	return vectors
}

func vectorBytes(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("decode vector bytes %q: %v", value, err)
	}
	return decoded
}

func vectorArray32(t *testing.T, value string) [32]byte {
	t.Helper()
	decoded := vectorBytes(t, value)
	if len(decoded) != 32 {
		t.Fatalf("vector is %d bytes, want 32", len(decoded))
	}
	var result [32]byte
	copy(result[:], decoded)
	return result
}

func TestSharedBrowserCanonicalCryptoVectors(t *testing.T) {
	vectors := readCrossLanguageVectors(t)
	entropy := vectorBytes(t, vectors.Recovery.Entropy)
	phrase, err := EncodeRecoveryPhrase(entropy)
	if err != nil {
		t.Fatalf("EncodeRecoveryPhrase: %v", err)
	}
	if phrase != vectors.Recovery.Phrase {
		t.Fatalf("Recovery Phrase = %q, want %q", phrase, vectors.Recovery.Phrase)
	}
	keys, err := DeriveRecoveryCredential(entropy)
	if err != nil {
		t.Fatalf("DeriveRecoveryCredential: %v", err)
	}
	for name, values := range map[string][]string{
		"signing seed":         []string{hex.EncodeToString(keys.SigningSeed), vectors.Recovery.SigningSeed},
		"signing public key":   []string{hex.EncodeToString(keys.SigningPublicKey), vectors.Recovery.SigningPublicKey},
		"wrapping private key": []string{hex.EncodeToString(keys.WrappingPrivateKey), vectors.Recovery.WrappingPrivateKey},
		"wrapping public key":  []string{hex.EncodeToString(keys.WrappingPublicKey), vectors.Recovery.WrappingPublicKey},
	} {
		if values[0] != values[1] {
			t.Fatalf("%s = %s, want %s", name, values[0], values[1])
		}
	}

	vaultID := vectorArray32(t, vectors.KeyEpoch.VaultID)
	epochKey := vectorBytes(t, vectors.KeyEpoch.Key)
	epochID, err := KeyEpochID(vaultID, epochKey)
	if err != nil {
		t.Fatalf("KeyEpochID: %v", err)
	}
	if got := hex.EncodeToString(epochID[:]); got != vectors.KeyEpoch.ID {
		t.Fatalf("Key Epoch ID = %s, want %s", got, vectors.KeyEpoch.ID)
	}
	epochPRK, err := EpochPRK(vaultID, epochID, epochKey)
	if err != nil {
		t.Fatalf("EpochPRK: %v", err)
	}
	if got := hex.EncodeToString(epochPRK); got != vectors.KeyEpoch.EpochPRK {
		t.Fatalf("Epoch PRK = %s, want %s", got, vectors.KeyEpoch.EpochPRK)
	}
	protection := vectorBytes(t, vectors.KeyEpoch.Protection)
	compactKey, err := CompactItemKey(CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey, ProtectionParameters: protection,
	})
	if err != nil {
		t.Fatalf("CompactItemKey: %v", err)
	}
	if got := hex.EncodeToString(compactKey); got != vectors.KeyEpoch.CompactKey {
		t.Fatalf("Compact Item Key = %s, want %s", got, vectors.KeyEpoch.CompactKey)
	}
	artifactID := vectorArray32(t, vectors.KeyEpoch.ArtifactID)
	wrapperKey, err := artifactWrapperKey(vaultID, epochID, epochKey, artifactID, protection)
	if err != nil {
		t.Fatalf("artifactWrapperKey: %v", err)
	}
	if got := hex.EncodeToString(wrapperKey); got != vectors.KeyEpoch.WrapperKey {
		t.Fatalf("Artifact Wrapper Key = %s, want %s", got, vectors.KeyEpoch.WrapperKey)
	}
	if got := hex.EncodeToString(artifactFrameNonce(protection, 0)); got != vectors.KeyEpoch.FirstNonce {
		t.Fatalf("first Artifact frame nonce = %s, want %s", got, vectors.KeyEpoch.FirstNonce)
	}
	if got := hex.EncodeToString(artifactFrameNonce(protection, ^uint32(0))); got != vectors.KeyEpoch.LastNonce {
		t.Fatalf("last Artifact frame nonce = %s, want %s", got, vectors.KeyEpoch.LastNonce)
	}
}
