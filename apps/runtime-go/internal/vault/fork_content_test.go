package vault

import (
	"context"
	"crypto/ed25519"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestForkCopiesCurrentVaultLabelIntoStateOnlyBaseline(t *testing.T) {
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
	if len(forkEvents) != 1 {
		t.Fatalf("Fork Event count = %d, want state-only Genesis", len(forkEvents))
	}
	if forkEvents[0].RecordID == sourceEvents[1].RecordID {
		t.Fatal("Fork reused the source content Record identity")
	}
	content, err := baselineContentCheckpoint(runtime.replicas[forkID].baseline)
	if err != nil {
		t.Fatalf("read Fork content checkpoint: %v", err)
	}
	label, ok := replicaMapEntry(content, 1)
	if !ok {
		t.Fatal("Fork Baseline omitted Vault label checkpoint")
	}
	value, ok := replicaMapNullableText(label, 0)
	if !ok || value == nil {
		t.Fatalf("Fork Baseline label = %#v, want Forked label", value)
	}
	if *value != "Forked label" {
		t.Fatalf("Fork Baseline label = %q, want Forked label", *value)
	}
}

func TestForkCopiesArtifactObjectAndWrapperIntoStateOnlyReplica(t *testing.T) {
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

func TestForkCopiesCaptureStateIntoBaselineWithoutContentEvents(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Capture Fork source")
	artifactID := admitCompleteExportArtifact(t, runtime, dependencies, sourceID)
	bundleID, sourceCollectionID := admitForkBundleRegisteredEvent(t, runtime, dependencies, sourceID, artifactID)
	deleteID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 4, canonical.Map{0: canonicalSetValues([]canonical.Value{bundleID[:]})}, nil)
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
		t.Fatalf("confirm Capture Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	forkReplica := runtime.replicas[forkID]
	if events := forkReplica.Events(); len(events) != 1 {
		t.Fatalf("Fork Events = %#v, want only fresh Genesis", events)
	}
	projection, err := ProjectLibraryProjection(forkReplica)
	if err != nil {
		t.Fatalf("project Fork Library: %v", err)
	}
	if len(projection.Captures) != 1 {
		t.Fatalf("Fork captures = %#v, want one checkpointed capture", projection.Captures)
	}
	capture := projection.Captures[0]
	if capture.BundleID == hexIdentifier(bundleID) || capture.CollectionID == hexIdentifier(sourceCollectionID) || capture.ArtifactID == hexIdentifier(artifactID) || capture.Lifecycle != "Deleted" {
		t.Fatalf("Fork capture projection = %#v", capture)
	}
	if capture.BundleID == hexIdentifier(deleteID) {
		t.Fatal("Fork reused the source deletion Event identity as the Bundle identity")
	}
	if _, err := runtime.ExportComplete(forkID, setup["recoveryPhrase"]); err != nil {
		t.Fatalf("export state-only Fork closure: %v", err)
	}
}

func TestForkCopiesCollectionStateIntoBaselineWithoutContentEvents(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Collection Fork source")
	sourceCollectionID := filledCreationID(253)
	admitForkCollectionTitleEvent(t, runtime, dependencies, sourceID, sourceCollectionID, "Saved pages")

	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm Collection Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	forkReplica := runtime.replicas[forkID]
	if events := forkReplica.Events(); len(events) != 1 {
		t.Fatalf("Fork Events = %#v, want only fresh Genesis", events)
	}
	projection, err := ProjectLibraryProjection(forkReplica)
	if err != nil {
		t.Fatalf("project Fork Library: %v", err)
	}
	if len(projection.Collections) != 1 {
		t.Fatalf("Fork collections = %#v, want one checkpointed Collection", projection.Collections)
	}
	collection := projection.Collections[0]
	if collection.CollectionID == hexIdentifier(sourceCollectionID) || collection.ExplicitTitle == nil || *collection.ExplicitTitle != "Saved pages" || collection.Title != "Saved pages" {
		t.Fatalf("Fork collection projection = %#v", collection)
	}
}

func TestForkCopiesNoteStateAndObjectIntoBaselineWithoutContentEvents(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Note Fork source")
	sourceNoteID, sourceObjectID, _, _ := admitForkNoteEvents(t, runtime, dependencies, sourceID)
	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm Note Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	forkReplica := runtime.replicas[forkID]
	if events := forkReplica.Events(); len(events) != 1 {
		t.Fatalf("Fork Events = %#v, want only fresh Genesis", events)
	}
	projection, err := ProjectLibraryProjection(forkReplica)
	if err != nil {
		t.Fatalf("project Fork Library: %v", err)
	}
	if len(projection.Notes) != 1 {
		t.Fatalf("Fork notes = %#v, want one checkpointed Note", projection.Notes)
	}
	note := projection.Notes[0]
	if note.NoteID == hexIdentifier(sourceNoteID) || note.State != "Active" || len(note.Versions) != 1 {
		t.Fatalf("Fork note projection = %#v", note)
	}
	for objectIDText := range runtime.vaults[forkID].Canonical.ObjectStorageItemIDs {
		if objectIDText == hexIdentifier(sourceObjectID) {
			t.Fatal("Fork reused the source Note Content Object identity")
		}
	}
}

func TestForkPersistsFeatureManifestEnvelope(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	feature := canonical.FeatureManifestInput{
		FeatureKey: "awsm.fork.feature", Revision: 1, Parameters: []byte{7},
		RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{
		RecoveryPhrase:   "abandon amount liar amount expire adjust cage candy arch gather drum buyer",
		FeatureManifests: []canonical.FeatureManifestInput{feature},
	})
	if err != nil {
		t.Fatalf("prepare source creation: %v", err)
	}
	sourceID := installPreparedCreationForTest(t, runtime, dependencies, prepared)
	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm Feature Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	featureID := hexIdentifier(prepared.FeatureManifests[0].ID)
	storageID := runtime.vaults[forkID].Canonical.FeatureManifestStorageItemIDs[featureID]
	if storageID == "" {
		t.Fatalf("Fork Feature Manifest storage mapping = %#v", runtime.vaults[forkID].Canonical.FeatureManifestStorageItemIDs)
	}
	if _, err := dependencies.Artifacts.Open(storageID); err != nil {
		t.Fatalf("Fork Feature Manifest envelope unavailable: %v", err)
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

func admitForkCollectionTitleEvent(t *testing.T, runtime *Runtime, dependencies Dependencies, vaultID string, collectionID canonical.Identifier, title string) {
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
		Family: canonical.ContentFamily, Type: 7, SignerCredentialID: credentialID, AssertedAt: 43, Body: canonical.Map{0: collectionID[:], 1: title},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign source Collection Title Event: %v", err)
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
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes})
	if err != nil {
		t.Fatalf("seal source Collection Title Event: %v", err)
	}
	if err := runtime.AdmitOpaqueEvent(context.Background(), vaultID, encoded); err != nil {
		t.Fatalf("admit source Collection Title Event: %v", err)
	}
}

func admitForkNoteEvents(t *testing.T, runtime *Runtime, dependencies Dependencies, vaultID string) (canonical.Identifier, canonical.Identifier, canonical.Identifier, canonical.Identifier) {
	t.Helper()
	value := runtime.vaults[vaultID]
	vaultIdentifier := mustIdentifier(t, vaultID)
	featureSetID := mustIdentifier(t, value.Canonical.RequiredFeatureSetID)
	epochID := mustIdentifier(t, value.Canonical.KeyEpochID)
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatalf("read source Key Epoch: %v", err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatalf("decode source Key Epoch: %v", err)
	}
	noteID := filledCreationID(251)
	collectionID := filledCreationID(252)
	contentBody := canonical.Map{0: uint64(1), 1: "A note", 2: "First body", 3: "awsm.note.commonmark"}
	contentBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultIdentifier[:], 2: uint64(3), 3: featureSetID[:], 4: contentBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatalf("encode Note Content Object: %v", err)
	}
	contentObjectID, err := canonical.VaultObjectID(vaultIdentifier, 3, contentBytes)
	if err != nil {
		t.Fatalf("derive Note Content Object ID: %v", err)
	}
	contentEnvelope, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 2, PayloadBytes: contentBytes,
	})
	if err != nil {
		t.Fatalf("seal Note Content Object: %v", err)
	}
	if err := runtime.AdmitOpaqueObject(context.Background(), vaultID, contentEnvelope); err != nil {
		t.Fatalf("admit Note Content Object: %v", err)
	}
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("read source Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, mustIdentifier(t, value.Canonical.MemberID), mustIdentifier(t, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("decode source Client Credential: %v", err)
	}
	credentialID := mustIdentifier(t, value.Canonical.ClientCredentialID)
	signAndAdmit := func(eventType uint64, body canonical.Value, dependenciesList []canonical.Dependency) canonical.Identifier {
		event, signErr := canonical.SignEvent(canonical.EventInput{
			VaultID: vaultIdentifier, GenerationID: mustIdentifier(t, value.GenerationID),
			ParentRecordIDs: runtime.replicas[vaultID].State().CausalFrontier, AuthorityParentIDs: runtime.replicas[vaultID].State().AuthorityFrontier,
			Dependencies: dependenciesList, RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: eventType,
			SignerCredentialID: credentialID, AssertedAt: 99 + int64(eventType), Body: body,
		}, ed25519.PrivateKey(clientSecret.signingSecretKey))
		if signErr != nil {
			t.Fatalf("sign Note Event %d: %v", eventType, signErr)
		}
		eventEnvelope, sealErr := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes,
		})
		if sealErr != nil {
			t.Fatalf("seal Note Event %d: %v", eventType, sealErr)
		}
		if admitErr := runtime.AdmitOpaqueEvent(context.Background(), vaultID, eventEnvelope); admitErr != nil {
			t.Fatalf("admit Note Event %d: %v", eventType, admitErr)
		}
		return event.RecordID
	}
	createdID := signAndAdmit(27, canonical.Map{0: noteID[:], 1: canonical.Map{0: uint64(1), 1: collectionID[:]}, 2: contentObjectID[:]}, []canonical.Dependency{{Type: 6, ID: contentObjectID}})
	revisedBody := canonical.Map{0: noteID[:], 1: []canonical.Value{createdID[:]}, 2: contentObjectID[:]}
	revisedID := signAndAdmit(28, revisedBody, []canonical.Dependency{{Type: 6, ID: contentObjectID}})
	return noteID, contentObjectID, createdID, revisedID
}

func signAndAdmitForkNoteEvent(t *testing.T, runtime *Runtime, dependencies Dependencies, vaultID string, eventType uint64, body canonical.Value, dependenciesList []canonical.Dependency, parentsOverride ...[]canonical.Identifier) canonical.Identifier {
	t.Helper()
	value := runtime.vaults[vaultID]
	vaultIdentifier := mustIdentifier(t, vaultID)
	featureSetID := mustIdentifier(t, value.Canonical.RequiredFeatureSetID)
	epochID := mustIdentifier(t, value.Canonical.KeyEpochID)
	epochBytes, err := dependencies.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, value.Canonical.KeyEpochID))
	if err != nil {
		t.Fatalf("read source Key Epoch: %v", err)
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		t.Fatalf("decode source Key Epoch: %v", err)
	}
	credentialID := mustIdentifier(t, value.Canonical.ClientCredentialID)
	clientBytes, err := dependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, value.Canonical.ClientCredentialID))
	if err != nil {
		t.Fatalf("read source Client Credential: %v", err)
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, mustIdentifier(t, value.Canonical.MemberID), credentialID)
	if err != nil {
		t.Fatalf("decode source Client Credential: %v", err)
	}
	parents := runtime.replicas[vaultID].State().CausalFrontier
	if len(parentsOverride) > 0 && parentsOverride[0] != nil {
		parents = append([]canonical.Identifier(nil), parentsOverride[0]...)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultIdentifier, GenerationID: mustIdentifier(t, value.GenerationID), ParentRecordIDs: parents,
		AuthorityParentIDs: runtime.replicas[vaultID].State().AuthorityFrontier, Dependencies: dependenciesList,
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily,
		Type: eventType, SignerCredentialID: credentialID, AssertedAt: 200 + int64(eventType) + int64(len(runtime.replicas[vaultID].Events())), Body: body,
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		t.Fatalf("sign Note Event %d: %v", eventType, err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key, PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		t.Fatalf("seal Note Event %d: %v", eventType, err)
	}
	if err := runtime.AdmitOpaqueEvent(context.Background(), vaultID, encoded); err != nil {
		t.Fatalf("admit Note Event %d: %v", eventType, err)
	}
	return event.RecordID
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
		9: []canonical.Value{canonical.Map{0: artifactID[:], 1: "awsm.artifact.primary"}}, 10: []canonical.Value{}, 11: canonical.Map{0: uint64(1), 1: []byte{0xa1, 0x00, 0x01}},
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
		Dependencies: []canonical.Dependency{{Type: 4, ID: descriptorID}}, RequiredFeatureSetID: featureSetID,
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
