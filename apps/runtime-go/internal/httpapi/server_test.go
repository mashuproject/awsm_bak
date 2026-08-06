package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/artifactstore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/grants"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/transfer"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/vault"
)

func TestRuntimeAPIExposesOnlyAWSMRoutes(t *testing.T) {
	server := NewServer()

	runtimeRequest := httptest.NewRequest(http.MethodGet, "/api/awsm/runtime/health", nil)
	runtimeResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(runtimeResponse, runtimeRequest)
	if runtimeResponse.Code != http.StatusOK {
		t.Fatalf("runtime health status = %d, want %d", runtimeResponse.Code, http.StatusOK)
	}

	pocketBaseRequest := httptest.NewRequest(http.MethodGet, "/api/collections/items/records", nil)
	pocketBaseResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(pocketBaseResponse, pocketBaseRequest)
	if pocketBaseResponse.Code != http.StatusNotFound {
		t.Fatalf("generic PocketBase route status = %d, want %d", pocketBaseResponse.Code, http.StatusNotFound)
	}
}

func TestReplicaHostRouteRemainsOpaqueBoundary(t *testing.T) {
	server := NewServer()
	request := httptest.NewRequest(http.MethodGet, "/api/awsm/host/replicas", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated host route status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestRuntimeGrantCannotAuthorizeReplicaHostRoute(t *testing.T) {
	server := NewServer()
	pairing, err := server.GrantManager().Begin("extension")
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := server.ApprovePairing(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := server.GrantManager().Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/awsm/host/replicas", nil)
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("Runtime grant host status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestCORSRejectsLookalikeWailsOrigin(t *testing.T) {
	server := NewServer()
	request := httptest.NewRequest(http.MethodOptions, "/api/awsm/runtime/health", nil)
	request.Header.Set("Origin", "http://wails.localhost.attacker.test")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("lookalike Wails origin status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestCORSPermitsAuthenticatedTransferStaging(t *testing.T) {
	server := NewServer()
	request := httptest.NewRequest(http.MethodOptions, "/api/awsm/runtime/transfers/transfer-1", nil)
	request.Header.Set("Origin", "chrome-extension://extension-id")
	request.Header.Set("Access-Control-Request-Method", http.MethodPut)
	request.Header.Set("Access-Control-Request-Headers", "authorization, content-type, awsm-transfer-secret")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("transfer preflight status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if got := response.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, http.MethodPut) {
		t.Fatalf("allowed methods = %q, want PUT", got)
	}
	if got := strings.ToLower(response.Header().Get("Access-Control-Allow-Headers")); !strings.Contains(got, "awsm-transfer-secret") {
		t.Fatalf("allowed headers = %q, want transfer secret", got)
	}
}

func TestPairingFlowUsesOneTimeApprovalAndRevocation(t *testing.T) {
	server := NewServer()
	beginBody := bytes.NewBufferString(`{"clientName":"extension"}`)
	beginRequest := httptest.NewRequest(http.MethodPost, "/api/awsm/runtime/pairings", beginBody)
	beginRequest.Header.Set("Content-Type", "application/json")
	beginResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(beginResponse, beginRequest)
	if beginResponse.Code != http.StatusCreated {
		t.Fatalf("begin pairing status = %d, want %d", beginResponse.Code, http.StatusCreated)
	}
	var pairing struct {
		ID   string `json:"pairingId"`
		Code string `json:"code"`
	}
	if err := json.NewDecoder(beginResponse.Body).Decode(&pairing); err != nil {
		t.Fatalf("decode pairing: %v", err)
	}
	if err := server.ApprovePairing(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}

	redeemBody := bytes.NewBufferString(`{"code":"` + pairing.Code + `"}`)
	redeemRequest := httptest.NewRequest(http.MethodPost, "/api/awsm/runtime/pairings/"+pairing.ID+"/redeem", redeemBody)
	redeemRequest.Header.Set("Content-Type", "application/json")
	redeemResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(redeemResponse, redeemRequest)
	if redeemResponse.Code != http.StatusCreated {
		t.Fatalf("redeem pairing status = %d, want %d", redeemResponse.Code, http.StatusCreated)
	}
	var grant struct {
		ID    string `json:"grantId"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(redeemResponse.Body).Decode(&grant); err != nil {
		t.Fatalf("decode grant: %v", err)
	}

	meRequest := httptest.NewRequest(http.MethodGet, "/api/awsm/runtime/grants/me", nil)
	meRequest.Header.Set("Authorization", "Bearer "+grant.Token)
	meResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(meResponse, meRequest)
	if meResponse.Code != http.StatusOK {
		t.Fatalf("grant lookup status = %d, want %d", meResponse.Code, http.StatusOK)
	}
	if body, err := io.ReadAll(meResponse.Body); err != nil || !bytes.Contains(body, []byte(grant.ID)) {
		t.Fatalf("grant lookup body does not identify the grant: %q (%v)", body, err)
	}

	if err := server.RevokeGrant(grant.ID); err != nil {
		t.Fatalf("revoke grant: %v", err)
	}
	meAfterRevokeRequest := httptest.NewRequest(http.MethodGet, "/api/awsm/runtime/grants/me", nil)
	meAfterRevokeRequest.Header.Set("Authorization", "Bearer "+grant.Token)
	meAfterRevokeResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(meAfterRevokeResponse, meAfterRevokeRequest)
	if meAfterRevokeResponse.Code != http.StatusUnauthorized {
		t.Fatalf("revoked grant lookup status = %d, want %d", meAfterRevokeResponse.Code, http.StatusUnauthorized)
	}
}

func TestPairingRequestRejectsExplicitEmptyScopes(t *testing.T) {
	server := NewServer()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/awsm/runtime/pairings",
		bytes.NewBufferString(`{"clientName":"extension","scopes":[]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("empty scope pairing status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func TestPairingRequestRejectsUnknownAndTrailingJSON(t *testing.T) {
	for _, body := range []string{
		`{"clientName":"extension","extra":true}`,
		`{"clientName":"extension"}{"clientName":"second"}`,
	} {
		server := NewServer()
		request := httptest.NewRequest(http.MethodPost, "/api/awsm/runtime/pairings", bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("pairing body %q status = %d, want 400", body, response.Code)
		}
	}
}

func TestAuthenticatedVaultCommandUsesTheCanonicalEnvelope(t *testing.T) {
	server := NewServer()
	pairing, err := server.GrantManager().Begin("extension")
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := server.ApprovePairing(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := server.GrantManager().Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/awsm/runtime/command",
		bytes.NewBufferString(`{"type":"GetState"}`),
	)
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("Vault command status = %d, want %d", response.Code, http.StatusOK)
	}
	var envelope struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode Vault command: %v", err)
	}
	if !envelope.OK || len(envelope.Value) == 0 {
		t.Fatalf("Vault command envelope = %#v, want successful value", envelope)
	}

	unauthorized := httptest.NewRequest(
		http.MethodPost,
		"/api/awsm/runtime/command",
		bytes.NewBufferString(`{"type":"GetState"}`),
	)
	unauthorized.Header.Set("Content-Type", "application/json")
	unauthorizedResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized Vault command status = %d, want %d", unauthorizedResponse.Code, http.StatusUnauthorized)
	}
}

func TestTransferEndpointStagesOneUseEnvelopeForDesktopApproval(t *testing.T) {
	ctx := context.Background()
	state := store.NewMemoryState()
	artifacts, err := artifactstore.New(t.TempDir())
	if err != nil {
		t.Fatalf("create artifacts: %v", err)
	}
	vaultRuntime, err := vault.New(ctx, state, vault.Dependencies{})
	if err != nil {
		t.Fatalf("create Vault Runtime: %v", err)
	}
	transfers, err := transfer.NewManager(ctx, state, artifacts)
	if err != nil {
		t.Fatalf("create transfer manager: %v", err)
	}
	server := NewServerWithManagerAndVaultAndTransfers(grants.NewManager(), vaultRuntime, transfers)
	pairing, err := server.GrantManager().Begin("extension")
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}
	if err := server.ApprovePairing(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	grant, err := server.GrantManager().Redeem(pairing.ID, pairing.Code)
	if err != nil {
		t.Fatalf("redeem pairing: %v", err)
	}
	transferRequest, err := transfers.Begin(ctx, "vault-id")
	if err != nil {
		t.Fatalf("begin transfer: %v", err)
	}
	envelope, err := transfer.Seal(transferRequest.Secret, []byte("package"))
	if err != nil {
		t.Fatalf("seal transfer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/awsm/runtime/transfers/"+transferRequest.TransferID, bytes.NewReader(envelope))
	request.Header.Set("Authorization", "Bearer "+grant.Token)
	request.Header.Set("Awsm-Transfer-Secret", transferRequest.Secret)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("stage transfer status = %d, want %d", response.Code, http.StatusCreated)
	}
	listRequest := httptest.NewRequest(http.MethodGet, "/api/awsm/runtime/transfers", nil)
	listRequest.Header.Set("Authorization", "Bearer "+grant.Token)
	listResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK || !bytes.Contains(listResponse.Body.Bytes(), []byte(transferRequest.TransferID)) {
		t.Fatalf("pending transfer response = %d %q", listResponse.Code, listResponse.Body.Bytes())
	}
}
