package artifactstore

import (
	"bytes"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestStoreStreamsOpaqueBytesAndRejectsPathTraversal(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("create artifact store: %v", err)
	}
	want := bytes.Repeat([]byte("ciphertext"), 2048)
	if err := store.Put("artifact-1", bytes.NewReader(want)); err != nil {
		t.Fatalf("put artifact: %v", err)
	}
	reader, err := store.Open("artifact-1")
	if err != nil {
		t.Fatalf("open artifact: %v", err)
	}
	got, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("artifact bytes changed during storage")
	}
	if _, err := store.Open("../outside"); err != ErrInvalidArtifactID {
		t.Fatalf("path traversal error = %v, want %v", err, ErrInvalidArtifactID)
	}
}

func TestStoreListsOpaqueBytes(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put("artifact-a", strings.NewReader("one")); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("artifact-b", strings.NewReader("two")); err != nil {
		t.Fatal(err)
	}
	ids, err := store.ListIDs()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"artifact-a", "artifact-b"}) {
		t.Fatalf("ListIDs = %#v", ids)
	}
}
