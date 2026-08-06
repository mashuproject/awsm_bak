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
	if len(registered.Dependencies) != 1 {
		t.Fatalf("Fork Bundle Registered dependencies = %#v", registered.Dependencies)
	}
	for _, dependency := range registered.Dependencies {
		if dependency.Type != 4 {
			t.Fatalf("Fork Bundle Registered dependency type = %d", dependency.Type)
		}
		if dependency.ID == artifactID {
			t.Fatal("Fork Bundle Registered Event reused the source Artifact identity")
		}
	}
}

func TestForkReauthorsCaptureLifecycleEvents(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Capture lifecycle Fork source")
	artifactID := admitCompleteExportArtifact(t, runtime, dependencies, sourceID)
	bundleID, sourceCollectionID := admitForkBundleRegisteredEvent(t, runtime, dependencies, sourceID, artifactID)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 4, canonical.Map{0: canonicalSetValues([]canonical.Value{bundleID[:]})}, nil)

	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm capture lifecycle Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	forkReplica := runtime.replicas[forkID]
	var registered, deleted *canonical.Event
	for index := range forkReplica.Events() {
		event := forkReplica.Events()[index]
		if event.Family != canonical.ContentFamily {
			continue
		}
		if event.Type == 3 {
			candidate := event
			registered = &candidate
		}
		if event.Type == 4 {
			candidate := event
			deleted = &candidate
		}
	}
	if registered == nil || deleted == nil {
		t.Fatalf("Fork capture lifecycle Events = %#v, want re-authored registration and deletion", forkReplica.Events())
	}
	registeredBody, ok := replicaMapValue(registered.Body)
	if !ok {
		t.Fatalf("Fork Bundle Registered body = %#v", registered.Body)
	}
	forkBundleID, ok := replicaIdentifier(registeredBody, 0)
	if !ok || forkBundleID == bundleID {
		t.Fatalf("Fork Bundle ID = %x, want fresh mapping from %x", forkBundleID, bundleID)
	}
	forkCollectionID, ok := replicaIdentifier(registeredBody, 2)
	if !ok || forkCollectionID == sourceCollectionID {
		t.Fatalf("Fork Collection ID = %x, want fresh mapping from %x", forkCollectionID, sourceCollectionID)
	}
	deletedBody, ok := replicaMapValue(deleted.Body)
	if !ok {
		t.Fatalf("Fork Captures Deleted body = %#v", deleted.Body)
	}
	deletedBundles, err := parseCanonicalIdentifierSet(replicaMapEntryMust(deletedBody, 0), "Fork capture lifecycle Bundle IDs", true)
	if err != nil || len(deletedBundles) != 1 || deletedBundles[0] != forkBundleID {
		t.Fatalf("Fork Captures Deleted Bundle IDs = %#v, err=%v", deletedBundles, err)
	}
	projection, err := ProjectLibrary(forkReplica)
	if err != nil {
		t.Fatalf("project Fork Library: %v", err)
	}
	if len(projection) != 1 || projection[0].BundleID != hexIdentifier(forkBundleID) || projection[0].Lifecycle != "Deleted" {
		t.Fatalf("Fork capture lifecycle projection = %#v", projection)
	}
}

func TestForkReauthorsCollectionTitleEvent(t *testing.T) {
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
	var found *canonical.Event
	for _, event := range runtime.replicas[forkID].Events() {
		if event.Family == canonical.ContentFamily && event.Type == 7 {
			candidate := event
			found = &candidate
			break
		}
	}
	if found == nil {
		t.Fatal("Fork omitted Collection Title Event")
	}
	body, ok := replicaMapValue(found.Body)
	if !ok {
		t.Fatalf("Fork Collection Title body = %#v", found.Body)
	}
	mappedCollectionID, ok := replicaIdentifier(body, 0)
	if !ok || mappedCollectionID == sourceCollectionID {
		t.Fatalf("Fork Collection ID mapping = %x, want fresh", mappedCollectionID)
	}
	title, ok := replicaMapText(body, 1)
	if !ok || title != "Saved pages" {
		t.Fatalf("Fork Collection Title = %q, want Saved pages", title)
	}
}

func TestForkReauthorsOrganizationEvents(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Organization Fork source")
	collectionA := filledCreationID(254)
	collectionB := filledCreationID(255)
	folderID := filledCreationID(180)
	tagA := filledCreationID(181)
	tagB := filledCreationID(182)
	assignmentID := filledCreationID(183)
	collectionTitleID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 7, canonical.Map{0: collectionA[:], 1: "Saved"}, nil)
	mergeID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 8, canonical.Map{0: canonicalSetValues([]canonical.Value{collectionA[:]}), 1: collectionB[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 9, canonical.Map{0: mergeID[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 10, canonical.Map{0: canonicalSetValues([]canonical.Value{mergeID[:]}), 1: []canonical.Value{canonical.Map{0: collectionA[:], 1: collectionB[:]}}}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 11, canonical.Map{0: collectionA[:], 1: nil}, nil)
	folderCreatedID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 12, canonical.Map{0: folderID[:], 1: "Archive", 2: nil}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 13, canonical.Map{0: folderID[:], 1: "Saved pages"}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 14, canonical.Map{0: folderID[:], 1: nil}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 15, canonical.Map{0: folderID[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 16, canonical.Map{0: folderID[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 17, canonical.Map{0: canonicalSetValues([]canonical.Value{folderCreatedID[:]}), 1: []canonical.Value{canonical.Map{0: folderID[:], 1: nil}}}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 18, canonical.Map{0: tagA[:], 1: "Reading"}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 19, canonical.Map{0: tagA[:], 1: "Read"}, nil)
	assignmentEventID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 20, canonical.Map{0: assignmentID[:], 1: tagA[:], 2: canonical.Map{0: uint64(1), 1: collectionB[:]}}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 21, canonical.Map{0: canonicalSetValues([]canonical.Value{assignmentEventID[:]})}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 22, canonical.Map{0: tagA[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 23, canonical.Map{0: tagA[:]}, nil)
	tagMergeID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 24, canonical.Map{0: canonicalSetValues([]canonical.Value{tagA[:]}), 1: tagB[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 25, canonical.Map{0: tagMergeID[:]}, nil)
	signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 26, canonical.Map{0: canonicalSetValues([]canonical.Value{tagMergeID[:]}), 1: []canonical.Value{canonical.Map{0: tagA[:], 1: tagB[:]}}}, nil)
	_ = collectionTitleID
	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm Organization Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	counts := map[uint64]int{}
	for _, event := range runtime.replicas[forkID].Events() {
		if event.Family == canonical.ContentFamily {
			counts[event.Type]++
		}
	}
	for eventType := uint64(7); eventType <= 26; eventType++ {
		if counts[eventType] != 1 {
			t.Fatalf("Fork organization Content Event type %d count = %d, want 1", eventType, counts[eventType])
		}
	}
}

func TestForkReauthorsNoteObjectAndEvents(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Note Fork source")
	noteID, contentObjectID, createdID, revisedID := admitForkNoteEvents(t, runtime, dependencies, sourceID)
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
		t.Fatalf("confirm Note Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	forkValue := runtime.vaults[forkID]
	if len(forkValue.Canonical.ObjectStorageItemIDs) != 1 {
		t.Fatalf("Fork Note Object mappings = %#v", forkValue.Canonical.ObjectStorageItemIDs)
	}
	for objectIDText := range forkValue.Canonical.ObjectStorageItemIDs {
		if objectIDText == hexIdentifier(contentObjectID) {
			t.Fatal("Fork reused the source Note Content Object identity")
		}
		object, ok := runtime.replicas[forkID].Object(mustIdentifier(t, objectIDText))
		if !ok || object.ObjectType != 3 {
			t.Fatalf("Fork Note Content Object = %#v, present = %v", object, ok)
		}
	}
	var noteEvents []canonical.Event
	for _, event := range runtime.replicas[forkID].Events() {
		if event.Family == canonical.ContentFamily && (event.Type == 27 || event.Type == 28) {
			noteEvents = append(noteEvents, event)
		}
	}
	if len(noteEvents) != 2 {
		t.Fatalf("Fork Note Event count = %d, want 2", len(noteEvents))
	}
	for _, event := range noteEvents {
		if event.RecordID == createdID || event.RecordID == revisedID {
			t.Fatal("Fork reused a source Note Event identity")
		}
		body, ok := replicaMapValue(event.Body)
		if !ok {
			t.Fatalf("Fork Note Event body = %#v", event.Body)
		}
		mappedNoteID, ok := replicaIdentifier(body, 0)
		if !ok || mappedNoteID == noteID {
			t.Fatalf("Fork Note ID mapping = %x, want fresh", mappedNoteID)
		}
	}
}

func TestForkReauthorsNoteLifecycleAndConflictResolutionEvents(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	sourceID, _ := createVaultWithPhraseForTest(t, runtime, "Note lifecycle Fork source")
	noteID, contentObjectID, createdID, revisedID := admitForkNoteEvents(t, runtime, dependencies, sourceID)
	deletedID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 29, canonical.Map{0: noteID[:], 1: []canonical.Value{revisedID[:]}}, nil, nil)
	restoredID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 30, canonical.Map{0: noteID[:], 1: []canonical.Value{deletedID[:]}}, nil, nil)
	branchParents := []canonical.Identifier{restoredID}
	branchA := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 28, canonical.Map{0: noteID[:], 1: []canonical.Value{restoredID[:]}, 2: contentObjectID[:]}, []canonical.Dependency{{Type: 6, ID: contentObjectID}}, branchParents)
	branchB := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 28, canonical.Map{0: noteID[:], 1: []canonical.Value{restoredID[:]}, 2: contentObjectID[:]}, []canonical.Dependency{{Type: 6, ID: contentObjectID}}, branchParents)
	resolutionParents := runtime.replicas[sourceID].State().CausalFrontier
	resolutionID := signAndAdmitForkNoteEvent(t, runtime, dependencies, sourceID, 31, canonical.Map{
		0: noteID[:], 1: canonicalSetValues([]canonical.Value{branchA[:], branchB[:]}), 2: contentObjectID[:], 3: []canonical.Value{},
	}, []canonical.Dependency{{Type: 6, ID: contentObjectID}}, resolutionParents)

	started, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "BeginVaultFork", "expectedVaultId": sourceID}))
	if err != nil {
		t.Fatalf("begin Fork: %v", err)
	}
	setup := started.(map[string]string)
	confirmed, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ConfirmVaultFork", "setupId": setup["setupId"], "recoveryPhrase": setup["recoveryPhrase"],
	}))
	if err != nil {
		t.Fatalf("confirm lifecycle Fork: %v", err)
	}
	forkID := confirmed.(map[string]string)["vaultId"]
	counts := map[uint64]int{}
	for _, event := range runtime.replicas[forkID].Events() {
		if event.Family == canonical.ContentFamily {
			counts[event.Type]++
			if event.RecordID == createdID || event.RecordID == revisedID || event.RecordID == deletedID || event.RecordID == restoredID || event.RecordID == branchA || event.RecordID == branchB || event.RecordID == resolutionID {
				t.Fatalf("Fork reused source Note Event %x", event.RecordID)
			}
		}
	}
	for eventType, want := range map[uint64]int{27: 1, 28: 3, 29: 1, 30: 1, 31: 1} {
		if counts[eventType] != want {
			t.Fatalf("Fork Note Event type %d count = %d, want %d", eventType, counts[eventType], want)
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
