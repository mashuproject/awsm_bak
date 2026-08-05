package transfer

import (
	"bytes"
	"context"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/artifactstore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestOneUseTransferStagesAndVerifiesEncryptedPayload(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	artifacts, err := artifactstore.New(t.TempDir())
	if err != nil {
		t.Fatalf("create artifact store: %v", err)
	}
	manager, err := NewManager(ctx, state, artifacts)
	if err != nil {
		t.Fatalf("create transfer manager: %v", err)
	}
	transfer, err := manager.Begin(ctx, "vault-id")
	if err != nil {
		t.Fatalf("begin transfer: %v", err)
	}
	payload := []byte("already encrypted complete export")
	envelope, err := Seal(transfer.Secret, payload)
	if err != nil {
		t.Fatalf("seal transfer: %v", err)
	}
	summary, err := manager.Stage(ctx, transfer.TransferID, transfer.Secret, bytes.NewReader(envelope))
	if err != nil {
		t.Fatalf("stage transfer: %v", err)
	}
	if summary.VaultID != "vault-id" || summary.ByteLength != len(payload) {
		t.Fatalf("transfer summary = %#v", summary)
	}
	if _, err := manager.Stage(ctx, transfer.TransferID, transfer.Secret, bytes.NewReader(envelope)); err == nil {
		t.Fatal("staging a transfer twice unexpectedly succeeded")
	}

	restarted, err := NewManager(ctx, state, artifacts)
	if err != nil {
		t.Fatalf("restart transfer manager: %v", err)
	}
	opened, _, err := restarted.OpenStaged(transfer.TransferID)
	if err != nil {
		t.Fatalf("open staged transfer: %v", err)
	}
	if !bytes.Equal(opened, payload) {
		t.Fatalf("opened payload = %q, want %q", opened, payload)
	}
	if err := restarted.Remove(ctx, transfer.TransferID); err != nil {
		t.Fatalf("remove transfer: %v", err)
	}
	if _, _, err := restarted.OpenStaged(transfer.TransferID); err == nil {
		t.Fatal("removed transfer remained available")
	}
}

func TestTransferRejectsWrongSecretAndTamperedEnvelope(t *testing.T) {
	ctx := context.Background()
	artifacts, err := artifactstore.New(t.TempDir())
	if err != nil {
		t.Fatalf("create artifact store: %v", err)
	}
	manager, err := NewManager(ctx, store.NewMemoryState(), artifacts)
	if err != nil {
		t.Fatalf("create transfer manager: %v", err)
	}
	transfer, err := manager.Begin(ctx, "vault-id")
	if err != nil {
		t.Fatalf("begin transfer: %v", err)
	}
	envelope, err := Seal(transfer.Secret, []byte("payload"))
	if err != nil {
		t.Fatalf("seal transfer: %v", err)
	}
	if _, err := manager.Stage(ctx, transfer.TransferID, transfer.Secret+"x", bytes.NewReader(envelope)); err == nil {
		t.Fatal("wrong transfer secret unexpectedly succeeded")
	}
	envelope[len(envelope)-1] ^= 1
	if _, err := manager.Stage(ctx, transfer.TransferID, transfer.Secret, bytes.NewReader(envelope)); err == nil {
		t.Fatal("tampered transfer unexpectedly succeeded")
	}
}
