package store

import (
	"context"
	"testing"
)

func TestPocketBaseStateRoundTripUsesAWSMCollectionAdapter(t *testing.T) {
	app, err := NewPocketBaseApp(t.TempDir())
	if err != nil {
		t.Fatalf("create PocketBase app: %v", err)
	}
	defer app.ResetBootstrapState()

	state, err := NewPocketBaseState(app)
	if err != nil {
		t.Fatalf("create state adapter: %v", err)
	}

	want := []byte(`{"kind":"runtime-grant","revoked":false}`)
	if err := state.Put(context.Background(), "grant/example", want); err != nil {
		t.Fatalf("put state: %v", err)
	}
	got, err := state.Get(context.Background(), "grant/example")
	if err != nil {
		t.Fatalf("get state: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("state = %s, want %s", got, want)
	}

	if err := state.Delete(context.Background(), "grant/example"); err != nil {
		t.Fatalf("delete state: %v", err)
	}
	if _, err := state.Get(context.Background(), "grant/example"); err == nil {
		t.Fatal("deleted state must not be readable")
	}
}
