package main

import (
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/vault"
)

func TestDesktopBindingExposesManagementMetadataWithoutTokens(t *testing.T) {
	app, err := application.New(application.Config{DataDir: t.TempDir(), ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("new application: %v", err)
	}
	binding := &desktopBinding{app: app}
	if binding.RuntimeAddress() != "127.0.0.1:0" {
		t.Fatalf("runtime address = %q", binding.RuntimeAddress())
	}
	if pending := binding.PendingPairings(); pending == nil {
		t.Fatal("pending pairings must be a non-nil collection")
	}
	if grants := binding.ListGrants(); grants == nil {
		t.Fatal("grant summaries must be a non-nil collection")
	}
	if transfers := binding.PendingTransfers(); transfers == nil {
		t.Fatal("transfer summaries must be a non-nil collection")
	}
}

func TestDesktopBindingUsesTheVaultCommandContract(t *testing.T) {
	app, err := application.New(application.Config{DataDir: t.TempDir(), ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("new application: %v", err)
	}
	binding := &desktopBinding{app: app}
	value, err := binding.VaultCommand(map[string]any{"type": "GetState"})
	if err != nil {
		t.Fatalf("get Vault state: %v", err)
	}
	state, ok := value.(vault.ClientState)
	if !ok {
		t.Fatalf("Vault state type = %T, want vault.ClientState", value)
	}
	if state.Vaults == nil {
		t.Fatal("Vault state must expose a non-nil Vault collection")
	}
}
