package vault

import (
	"bytes"
	"context"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestSearchIndexesAuthenticatedLibraryProjection(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Search")
	bundleID, collectionID := admitForkBundleRegisteredEvent(t, runtime, dependencies, vaultID, filledCreationID(201))

	result, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "Search", "expectedVaultId": vaultID, "query": "Example", "scope": "Active",
		"hosts": []string{}, "collectionIds": []string{}, "tagIds": []string{},
	}))
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	results, ok := result.([]SearchResult)
	if !ok || len(results) == 0 || results[0].Kind != "Capture" {
		t.Fatalf("Search results = %#v", result)
	}
	if results[0].ID != hexIdentifier(bundleID) || results[0].PassageID == "" {
		t.Fatalf("Search result identity = %#v", results[0])
	}
	searchMaterialization, err := state.Get(ctx, searchMaterializationStatePrefix+vaultID)
	if err != nil {
		t.Fatalf("read Search materialization: %v", err)
	}
	if bytes.Contains(searchMaterialization, []byte(`"documents"`)) || bytes.Contains(searchMaterialization, []byte("Example")) {
		t.Fatalf("Search materialization is plaintext: %s", searchMaterialization)
	}
	filtered, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "Search", "expectedVaultId": vaultID, "query": "\"example test\"", "scope": "Active",
		"hosts": []string{"EXAMPLE.TEST"}, "collectionIds": []string{hexIdentifier(collectionID)}, "tagIds": []string{},
		"capturedFrom": int64(1234), "capturedBefore": int64(1235),
	}))
	if err != nil {
		t.Fatalf("filtered Search: %v", err)
	}
	if filteredResults, ok := filtered.([]SearchResult); !ok || len(filteredResults) != 1 {
		t.Fatalf("filtered Search results = %#v", filtered)
	}
	if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "DeleteCaptures", "expectedVaultId": vaultID, "bundleIds": []string{hexIdentifier(bundleID)},
	})); err != nil {
		t.Fatalf("DeleteCaptures: %v", err)
	}
	activeAfterDelete, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "Search", "expectedVaultId": vaultID, "query": "Example", "scope": "Active",
		"hosts": []string{}, "collectionIds": []string{}, "tagIds": []string{},
	}))
	if err != nil {
		t.Fatalf("active Search after delete: %v", err)
	}
	if len(activeAfterDelete.([]SearchResult)) != 0 {
		t.Fatalf("active Search after delete = %#v", activeAfterDelete)
	}
	deletedAfterDelete, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "Search", "expectedVaultId": vaultID, "query": "Example", "scope": "Deleted",
		"hosts": []string{}, "collectionIds": []string{}, "tagIds": []string{},
	}))
	if err != nil {
		t.Fatalf("deleted Search after delete: %v", err)
	}
	if len(deletedAfterDelete.([]SearchResult)) != 1 {
		t.Fatalf("deleted Search after delete = %#v", deletedAfterDelete)
	}
	coverageValue, err := runtime.Handle(ctx, mustJSON(map[string]any{
		"type": "SearchCoverage", "expectedVaultId": vaultID,
	}))
	if err != nil {
		t.Fatalf("SearchCoverage: %v", err)
	}
	coverage, ok := coverageValue.(SearchCoverage)
	if !ok || coverage.EligibleCaptures != 1 || coverage.IndexedCaptures != 1 {
		t.Fatalf("Search coverage = %#v", coverageValue)
	}
	for _, command := range []string{"ListCollections", "ListFolders", "ListTags", "ListTagAssignments", "ListNotes", "ListLibraryConflicts"} {
		if _, err := runtime.Handle(ctx, mustJSON(map[string]any{
			"type": command, "expectedVaultId": vaultID,
		})); err != nil {
			t.Fatalf("%s: %v", command, err)
		}
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	restartedResult, err := restarted.Handle(ctx, mustJSON(map[string]any{
		"type": "Search", "expectedVaultId": vaultID, "query": "Example", "scope": "Deleted",
		"hosts": []string{}, "collectionIds": []string{}, "tagIds": []string{},
	}))
	if err != nil {
		t.Fatalf("Search after restart: %v", err)
	}
	if len(restartedResult.([]SearchResult)) != 1 {
		t.Fatalf("Search after restart = %#v", restartedResult)
	}
}

func TestSearchMaterializationRebuildsAfterTamperOnRestart(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	dependencies := memoryDependencies(t)
	runtime, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID, _ := createVaultWithPhraseForTest(t, runtime, "Tampered Search materialization")
	bundleID, _ := admitForkBundleRegisteredEvent(t, runtime, dependencies, vaultID, filledCreationID(204))
	input := map[string]any{
		"type": "Search", "expectedVaultId": vaultID, "query": "Example", "scope": "Active",
		"hosts": []string{}, "collectionIds": []string{}, "tagIds": []string{},
	}
	result, err := runtime.Handle(ctx, mustJSON(input))
	if err != nil {
		t.Fatalf("seed Search: %v", err)
	}
	if results, ok := result.([]SearchResult); !ok || !searchResultsContainID(results, hexIdentifier(bundleID)) {
		t.Fatalf("seed Search results = %#v", result)
	}
	key := searchMaterializationStatePrefix + vaultID
	encoded, err := state.Get(ctx, key)
	if err != nil {
		t.Fatalf("read Search materialization: %v", err)
	}
	tampered := append([]byte(nil), encoded...)
	tampered[len(tampered)-1] ^= 1
	if err := state.Put(ctx, key, tampered); err != nil {
		t.Fatalf("tamper Search materialization: %v", err)
	}
	restarted, err := New(ctx, state, dependencies)
	if err != nil {
		t.Fatalf("restart Runtime: %v", err)
	}
	result, err = restarted.Handle(ctx, mustJSON(input))
	if err != nil {
		t.Fatalf("rebuild Search after restart: %v", err)
	}
	if results, ok := result.([]SearchResult); !ok || !searchResultsContainID(results, hexIdentifier(bundleID)) {
		t.Fatalf("rebuilt Search results = %#v", result)
	}
	replacement, err := state.Get(ctx, key)
	if err != nil {
		t.Fatalf("read rebuilt Search materialization: %v", err)
	}
	if bytes.Equal(replacement, tampered) {
		t.Fatal("tampered Search materialization was not replaced")
	}
}

func searchResultsContainID(results []SearchResult, id string) bool {
	for _, result := range results {
		if result.ID == id {
			return true
		}
	}
	return false
}

func TestSearchReferenceParsingAndEscapedSnippet(t *testing.T) {
	parsed, err := parseSearchQuery(`"unmatched Example`)
	if err != nil || len(parsed.terms) != 2 || len(parsed.phrases) != 0 {
		t.Fatalf("unmatched quote parse = %#v, %v", parsed, err)
	}
	fields, err := makeSearchFields("Capture", hexIdentifier(filledCreationID(203)), []searchFieldDraft{{kind: "Title", text: `<tag> Example`}})
	if err != nil {
		t.Fatalf("make Search fields: %v", err)
	}
	results := querySearchDocuments([]searchDocument{{
		kind: "Capture", id: hexIdentifier(filledCreationID(203)), status: "Active", title: "<tag> Example",
		fields: fields,
	}}, mustSearchQuery(t, "Example"), searchQuery{scope: "Active"})
	if len(results) != 1 || results[0].Snippet != "&lt;tag&gt; Example" {
		t.Fatalf("escaped Search snippet = %#v", results)
	}
}

func mustSearchQuery(t *testing.T, value string) parsedSearchQuery {
	t.Helper()
	parsed, err := parseSearchQuery(value)
	if err != nil {
		t.Fatalf("parse Search query: %v", err)
	}
	return parsed
}
