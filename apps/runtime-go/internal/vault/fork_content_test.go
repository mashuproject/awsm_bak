package vault

import (
	"context"
	"crypto/ed25519"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestForkReauthorsContentLabelEventOnFreshGenesis(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID := createVaultForTest(t, runtime, "Fork source")
	admitForkLabelEvent(t, runtime, dependencies, sourceID, "Forked label")
	sourceEvents := runtime.replicas[sourceID].Events()
	if len(sourceEvents) != 2 {
		t.Fatalf("source Event count = %d, want 2", len(sourceEvents))
	}
	started, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "BeginVaultFork", "expectedVaultId": sourceID,
	}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm non-empty Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	if forkID == sourceID {
		t.Fatal("Fork reused the source Vault identity")
	}
	forkEvents := runtime.replicas[forkID].Events()
	if len(forkEvents) != 2 {
		t.Fatalf("Fork Event count = %d, want fresh Genesis plus re-authored label", len(forkEvents))
	}
	for _, event := range forkEvents {
		if event.RecordID == sourceEvents[1].RecordID {
			t.Fatal("Fork reused the source content Record identity")
		}
	}
	var labelFound bool
	for _, event := range forkEvents {
		if event.Family == canonical.ContentFamily && event.Type == 1 {
			labelFound = true
			if event.VaultID != mustIdentifier(t, forkID) || event.GenerationID != mustIdentifier(t, runtime.vaults[forkID].GenerationID) {
				t.Fatalf("Fork label Event context = %#v", event)
			}
		}
	}
	if !labelFound {
		t.Fatal("Fork omitted the source content label Event")
	}
}

func admitForkLabelEvent(t *testing.T, runtime *Runtime, dependencies Dependencies, vaultID, label string) {
	t.Helper()
	value := runtime.vaults[vaultID]
	vaultIdentifier := mustIdentifier(t, vaultID)
	generationID := mustIdentifier(t, value.GenerationID)
	memberID := mustIdentifier(t, value.Canonical.MemberID)
	credentialID := mustIdentifier(t, value.Canonical.ClientCredentialID)
	featureSetID := mustIdentifier(t, value.Canonical.RequiredFeatureSetID)
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("read source Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, memberID, credentialID)
	if err != nil {
		t.Fatalf("decode source Client Credential: %v", err)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultIdentifier, GenerationID: generationID,
		ParentRecordIDs: runtime.replicas[vaultID].State().CausalFrontier, AuthorityParentIDs: runtime.replicas[vaultID].State().AuthorityFrontier,
		Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{},
		Family: canonical.ContentFamily, Type: 1, SignerCredentialID: credentialID, AssertedAt: 42, Body: canonical.Map{0: label},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign source label Event: %v", err)
	}
	epochID := mustIdentifier(t, value.Canonical.KeyEpochID)
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatalf("read source Key Epoch: %v", err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatalf("decode source Key Epoch: %v", err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		t.Fatalf("seal source label Event: %v", err)
	}
	if err := runtime.AdmitOpaqueEvent(context.Background(), vaultID, encoded); err != nil {
		t.Fatalf("admit source label Event: %v", err)
	}
}
