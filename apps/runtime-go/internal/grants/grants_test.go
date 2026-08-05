package grants

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestPairingApprovesOnceAndIssuesRevocableGrant(t *testing.T) {
	manager := NewManager()
	pairing, err := manager.Begin("browser-extension")
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}

	if pairing.ID == "" || pairing.Code == "" {
		t.Fatal("pairing must expose an id and one-time code")
	}

	if _, err := manager.Redeem(pairing.ID, pairing.Code); err == nil {
		t.Fatal("unapproved pairing must not redeem")
	}

	if err := manager.Approve(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := manager.Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}
	if grant.Token == "" || grant.ID == "" {
		t.Fatal("redeemed grant must contain opaque identifiers")
	}

	if _, err := manager.Redeem(pairing.ID, pairing.Code); err == nil {
		t.Fatal("pairing code must be single-use")
	}

	if err := manager.Revoke(grant.ID); err != nil {
		t.Fatalf("revoke grant: %v", err)
	}
	if _, err := manager.Authorize(grant.Token, ScopeRuntimeVault); err == nil {
		t.Fatal("revoked grant must not authorize requests")
	}
}

func TestGrantStateSurvivesRuntimeRestart(t *testing.T) {
	state := store.NewMemoryState()
	first, err := NewManagerWithState(state)
	if err != nil {
		t.Fatalf("create first manager: %v", err)
	}
	pairing, err := first.Begin("browser-extension")
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := first.Approve(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := first.Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}

	second, err := NewManagerWithState(state)
	if err != nil {
		t.Fatalf("create restarted manager: %v", err)
	}
	if _, err := second.Authorize(grant.Token, ScopeRuntimeVault); err != nil {
		t.Fatalf("persisted grant did not survive restart: %v", err)
	}
}

func TestGrantCannotExceedItsScope(t *testing.T) {
	manager := NewManager()
	pairing, err := manager.BeginWithScopes("browser-extension", []string{ScopeRuntimeVault})
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := manager.Approve(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := manager.RedeemWithScopes(pairing.ID, pairing.Code, []string{ScopeRuntimeVault})
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}
	if _, err := manager.Authorize(grant.Token, "runtime.unsupported"); err == nil {
		t.Fatal("grant must reject an undeclared scope")
	}
}

func TestPairingApprovalBindsRequestedScopes(t *testing.T) {
	manager := NewManager()
	pairing, err := manager.BeginWithScopes("browser-extension", []string{ScopeRuntimeVault})
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if len(pairing.Scopes) != 1 || pairing.Scopes[0] != ScopeRuntimeVault {
		t.Fatalf("pairing scopes = %#v, want runtime.vault", pairing.Scopes)
	}
	if err := manager.Approve(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	if _, err := manager.RedeemWithScopes(pairing.ID, pairing.Code, []string{"runtime.unsupported"}); err == nil {
		t.Fatal("redeeming with an unsupported scope unexpectedly succeeded")
	}
	grant, err := manager.Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}
	if len(grant.Scopes) != 1 || grant.Scopes[0] != ScopeRuntimeVault {
		t.Fatalf("grant scopes = %#v, want runtime.vault", grant.Scopes)
	}
}

func TestPairingRejectsUnsupportedRuntimeScope(t *testing.T) {
	manager := NewManager()
	if _, err := manager.BeginWithScopes("browser-extension", []string{"runtime.unsupported"}); err == nil {
		t.Fatal("unsupported Runtime scope unexpectedly accepted")
	}
}

func TestPersistedGrantStateDoesNotContainPairingCodesOrTokens(t *testing.T) {
	state := store.NewMemoryState()
	manager, err := NewManagerWithState(state)
	if err != nil {
		t.Fatalf("create manager: %v", err)
	}
	pairing, err := manager.Begin("browser-extension")
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := manager.Approve(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := manager.Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}

	serialized, err := state.Get(context.Background(), persistedStateKey)
	if err != nil {
		t.Fatalf("read persisted state: %v", err)
	}
	if bytes.Contains(serialized, []byte(pairing.Code)) {
		t.Fatal("persisted grant state contains the pairing code")
	}
	if bytes.Contains(serialized, []byte(grant.Token)) {
		t.Fatal("persisted grant state contains the grant token")
	}
}

func TestListReturnsTokenFreeGrantSummaries(t *testing.T) {
	manager := NewManager()
	pairing, err := manager.BeginWithScopes("browser-extension", []string{ScopeRuntimeVault})
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := manager.Approve(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := manager.Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}

	summaries := manager.List()
	if len(summaries) != 1 {
		t.Fatalf("grant summary count = %d, want 1", len(summaries))
	}
	if summaries[0].ID != grant.ID || summaries[0].ClientName != "browser-extension" {
		t.Fatalf("grant summary = %#v, want grant %s", summaries[0], grant.ID)
	}
	serialized, err := json.Marshal(summaries[0])
	if err != nil {
		t.Fatalf("marshal grant summary: %v", err)
	}
	if bytes.Contains(serialized, []byte("token")) {
		t.Fatal("grant summary must not expose a bearer token field")
	}
}
