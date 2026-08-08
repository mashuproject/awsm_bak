package vault

import (
	"reflect"
	"testing"
)

func TestClientLibraryConflictSummariesUseCanonicalWireShape(t *testing.T) {
	values := []LibraryConflict{
		{Kind: "CaptureIdentity", SubjectIDs: []string{"a"}, CandidateRecordIDs: []string{"b", "c"}},
		{Kind: "CollectionMerge", Reason: "Cycle", SubjectIDs: []string{"d"}, CandidateRecordIDs: []string{"e"}},
		{Kind: "TagMerge", Reason: "MultipleDestinations", SubjectIDs: []string{"f"}, CandidateRecordIDs: []string{"g"}},
		{Kind: "Folder", Reason: "Cycle", SubjectIDs: []string{"h"}, CandidateRecordIDs: []string{"i"}},
		{Kind: "Note", Reason: "MultipleHeads", SubjectIDs: []string{"j"}, CandidateRecordIDs: []string{"k"}},
	}

	got, err := clientLibraryConflictSummaries(values)
	if err != nil {
		t.Fatalf("clientLibraryConflictSummaries: %v", err)
	}
	want := []ClientLibraryConflictSummary{
		{Kind: "CaptureIdentity", BundleID: "a", RegistrationRecordIDs: []string{"b", "c"}},
		{Kind: "CollectionMerge", Reason: "Cycle", SubjectCollectionIDs: []string{"d"}, CandidateRecordIDs: []string{"e"}},
		{Kind: "TagMerge", Reason: "MultipleDestinations", SubjectTagIDs: []string{"f"}, CandidateRecordIDs: []string{"g"}},
		{Kind: "Folder", Reason: "Cycle", SubjectFolderIDs: []string{"h"}, CandidateRecordIDs: []string{"i"}},
		{Kind: "Note", NoteID: "j", CandidateRecordIDs: []string{"k"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("summaries = %#v, want %#v", got, want)
	}
}
