package vault

import (
	"context"
	"crypto/sha256"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestReauthorizeCaptureFromPredecessorIsDeterministicAndRestarts(t *testing.T) {
	ctx := context.Background()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, store.NewMemoryState(), dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Re-authoring")
	artifactID := admitCompleteExportArtifact(t, runtime, dependencies, vaultID)
	sourceBundleID, _ := admitForkBundleRegisteredEvent(t, runtime, dependencies, vaultID, artifactID)
	var sourceEvent canonical.Event
	for _, event := range runtime.replicas[vaultID].Events() {
		if event.Family == canonical.ContentFamily && event.Type == 3 {
			sourceEvent = event
			break
		}
	}
	if sourceEvent.RecordID == (canonical.Identifier{}) {
		t.Fatal("source Bundle Registered Event was not admitted")
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{"type": "VacuumVault", "expectedVaultId": vaultID})); err != nil {
		t.Fatalf("VacuumVault: %v", err)
	}

	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ReauthorizeCapture", "expectedVaultId": vaultID, "sourceRecordId": hexIdentifier(sourceEvent.RecordID),
	}))
	if err != nil {
		t.Fatalf("ReauthorizeCapture: %v", err)
	}
	first, ok := result.(map[string]string)
	if !ok || first["eventRecordId"] == "" || first["descriptorObjectId"] == "" {
		t.Fatalf("ReauthorizeCapture result = %#v", result)
	}
	vaultIdentifier := mustIdentifier(t, vaultID)
	transcript, err := canonical.Transcript("awsm:recovered-bundle:v1", vaultIdentifier[:], sourceEvent.RecordID[:])
	if err != nil {
		t.Fatalf("recovered Bundle transcript: %v", err)
	}
	expectedBundleID := sha256.Sum256(transcript)
	if first["bundleId"] != hexIdentifier(expectedBundleID) || first["sourceRecordId"] != hexIdentifier(sourceEvent.RecordID) {
		t.Fatalf("ReauthorizeCapture result = %#v, want deterministic Bundle %s", first, hexIdentifier(expectedBundleID))
	}
	if first["bundleId"] == hexIdentifier(sourceBundleID) {
		t.Fatal("ReauthorizeCapture reused the source Bundle identity")
	}
	recoveredDescriptor, ok := runtime.replicas[vaultID].Object(mustIdentifier(t, first["descriptorObjectId"]))
	if !ok {
		t.Fatal("re-authored Descriptor was not admitted")
	}
	descriptorBody, ok := reauthorCanonicalMap(recoveredDescriptor.Body)
	if !ok {
		t.Fatal("re-authored Descriptor body is not canonical")
	}
	provenance, ok := replicaMapValue(replicaMapEntryMust(descriptorBody, 11))
	provenanceKind, provenanceOK := replicaMapNumber(provenance, 0)
	if !ok || !provenanceOK || provenanceKind != 2 {
		t.Fatalf("re-authored provenance = %#v", provenance)
	}
	recoveredEventRecord, ok := runtime.replicas[vaultID].Record(mustIdentifier(t, first["eventRecordId"]))
	if !ok || recoveredEventRecord.Event == nil || recoveredEventRecord.Event.GenerationID != runtime.replicas[vaultID].generationID {
		t.Fatalf("re-authored Event record = %#v", recoveredEventRecord)
	}
	if len(recoveredEventRecord.Event.Dependencies) != 1 || recoveredEventRecord.Event.Dependencies[0].Type != 4 || recoveredEventRecord.Event.Dependencies[0].ID != mustIdentifier(t, first["descriptorObjectId"]) {
		t.Fatalf("re-authored Event dependencies = %#v", recoveredEventRecord.Event.Dependencies)
	}

	retry, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "ReauthorizeCapture", "expectedVaultId": vaultID, "sourceRecordId": hexIdentifier(sourceEvent.RecordID),
	}))
	if err != nil {
		t.Fatalf("idempotent ReauthorizeCapture: %v", err)
	}
	second := retry.(map[string]string)
	if second["eventRecordId"] != first["eventRecordId"] || second["descriptorObjectId"] != first["descriptorObjectId"] || second["bundleId"] != first["bundleId"] {
		t.Fatalf("idempotent result = %#v, first = %#v", second, first)
	}

	restarted, err := New(ctx, runtime.store, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	restartedResult, err := restarted.Handle(ctx, mustJSON(map[string]any{
		"type": "ReauthorizeCapture", "expectedVaultId": vaultID, "sourceRecordId": hexIdentifier(sourceEvent.RecordID),
	}))
	if err != nil {
		t.Fatalf("restarted idempotent ReauthorizeCapture: %v", err)
	}
	if restartedResult.(map[string]string)["eventRecordId"] != first["eventRecordId"] {
		t.Fatalf("restarted result = %#v, first = %#v", restartedResult, first)
	}

	_ = sourceBundleID
}
