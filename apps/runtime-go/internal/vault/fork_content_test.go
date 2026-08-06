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

func TestForkReauthorsArtifactObjectAndWrapper(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Artifact Fork source")
	sourceArtifactID := admitCompleteExportArtifact(t, runtime, dependencies, sourceID)
	sourceStorageID := runtime.vaults[sourceID].Canonical.ArtifactStorageItemIDs[hexIdentifier(sourceArtifactID)]
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
		t.Fatalf("confirm Artifact Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	forkValue := runtime.vaults[forkID]
	if len(forkValue.Canonical.ObjectStorageItemIDs) != 1 || len(forkValue.Canonical.ArtifactStorageItemIDs) != 1 {
		t.Fatalf("Fork Object/Artifact mappings = %#v/%#v", forkValue.Canonical.ObjectStorageItemIDs, forkValue.Canonical.ArtifactStorageItemIDs)
	}
	forkObjectIDText := ""
	for objectID := range forkValue.Canonical.ObjectStorageItemIDs {
		forkObjectIDText = objectID
	}
	if forkObjectIDText == hexIdentifier(sourceArtifactID) {
		t.Fatal("Fork reused the source Artifact Object identity")
	}
	forkObjectID := mustIdentifier(t, forkObjectIDText)
	if _, ok := runtime.replicas[forkID].Object(forkObjectID); !ok {
		t.Fatalf("Fork Replica omitted Artifact Object %s", forkObjectIDText)
	}
	forkStorageID := forkValue.Canonical.ArtifactStorageItemIDs[forkObjectIDText]
	if forkStorageID == "" || forkStorageID == sourceStorageID {
		t.Fatalf("Fork Artifact Storage mapping = %q, source = %q", forkStorageID, sourceStorageID)
	}
	if _, err := dependencies.Artifacts.Open(forkStorageID); err != nil {
		t.Fatalf("Fork Artifact wrapper unavailable: %v", err)
	}
}

func TestForkReauthorsBundleDescriptorAndRegisteredEvent(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Bundle Fork source")
	artifactID := admitCompleteExportArtifact(t, runtime, dependencies, sourceID)
	bundleID, collectionID := admitForkBundleRegisteredEvent(t, runtime, dependencies, sourceID, artifactID)
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
		t.Fatalf("confirm Bundle Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	items, err := ProjectLibrary(runtime.replicas[forkID])
	if err != nil {
		t.Fatalf("project Fork Library: %v", err)
	}
	if len(items) != 1 || items[0].BundleID == hexIdentifier(bundleID) || items[0].CollectionID == hexIdentifier(collectionID) || items[0].ArtifactID == hexIdentifier(artifactID) {
		t.Fatalf("Fork Library items = %#v", items)
	}
	if _, err := runtime.ExportComplete(forkID, setup["recoveryPhrase"]); err != nil {
		t.Fatalf("export re-authored Bundle closure: %v", err)
	}
	forkEvents := runtime.replicas[forkID].Events()
	var registered *canonical.Event
	for index := range forkEvents {
		if forkEvents[index].Family == canonical.ContentFamily && forkEvents[index].Type == 3 {
			registered = &forkEvents[index]
			break
		}
	}
	if registered == nil {
		t.Fatal("Fork omitted Bundle Registered Event")
	}
	if len(registered.Dependencies) != 2 {
		t.Fatalf("Fork Bundle Registered dependencies = %#v", registered.Dependencies)
	}
	for _, dependency := range registered.Dependencies {
		if dependency.ID == artifactID {
			t.Fatal("Fork Bundle Registered Event reused a source dependency identity")
		}
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

func admitForkBundleRegisteredEvent(t *testing.T, runtime *Runtime, dependencies Dependencies, vaultID string, artifactID canonical.Identifier) (canonical.Identifier, canonical.Identifier) {
	t.Helper()
	value := runtime.vaults[vaultID]
	vaultIdentifier := mustIdentifier(t, vaultID)
	featureSetID := mustIdentifier(t, value.Canonical.RequiredFeatureSetID)
	bundleID := filledCreationID(241)
	collectionID := filledCreationID(242)
	descriptorBody := canonical.Map{
		0: uint64(1), 1: bundleID[:], 2: int64(1234), 3: "https://example.test/a", 4: "https://example.test/b",
		5: "awsm.capture.web-page-snapshot", 6: "awsm.adapter.browser-web-page", 7: uint64(1), 8: "Example",
		9: []canonical.Value{canonical.Map{0: artifactID[:], 1: "awsm.artifact.primary"}}, 10: []canonical.Value{}, 11: canonical.Map{0: uint64(1), 1: []byte{1}},
	}
	descriptorBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultIdentifier[:], 2: uint64(1), 3: featureSetID[:], 4: descriptorBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatalf("encode Bundle Descriptor: %v", err)
	}
	descriptorID, err := canonical.VaultObjectID(vaultIdentifier, 1, descriptorBytes)
	if err != nil {
		t.Fatalf("derive Bundle Descriptor ID: %v", err)
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
	descriptorEnvelope, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: descriptorBytes,
	})
	if err != nil {
		t.Fatalf("seal Bundle Descriptor: %v", err)
	}
	if err := runtime.AdmitOpaqueObject(context.Background(), vaultID, descriptorEnvelope); err != nil {
		t.Fatalf("admit Bundle Descriptor: %v", err)
	}
	memberID := mustIdentifier(t, value.Canonical.MemberID)
	credentialID := mustIdentifier(t, value.Canonical.ClientCredentialID)
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("read source Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, memberID, credentialID)
	if err != nil {
		t.Fatalf("decode source Client Credential: %v", err)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultIdentifier, GenerationID: mustIdentifier(t, value.GenerationID),
		ParentRecordIDs: runtime.replicas[vaultID].State().CausalFrontier, AuthorityParentIDs: runtime.replicas[vaultID].State().AuthorityFrontier,
		Dependencies: []canonical.Dependency{{Type: 3, ID: descriptorID}, {Type: 5, ID: artifactID}}, RequiredFeatureSetID: featureSetID,
		Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 3, SignerCredentialID: credentialID, AssertedAt: 1234,
		Body: canonical.Map{0: bundleID[:], 1: descriptorID[:], 2: collectionID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign Bundle Registered Event: %v", err)
	}
	eventEnvelope, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		t.Fatalf("seal Bundle Registered Event: %v", err)
	}
	if err := runtime.AdmitOpaqueEvent(context.Background(), vaultID, eventEnvelope); err != nil {
		t.Fatalf("admit Bundle Registered Event: %v", err)
	}
	return bundleID, collectionID
}
