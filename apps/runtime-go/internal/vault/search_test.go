package vault

import (
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
