// Package httpapi is the transport adapter for the local AWSM Runtime API.
// It intentionally does not expose PocketBase's generic record routes.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/grants"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/transfer"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/vault"
)

const (
	RuntimePrefix = "/api/awsm/runtime/"
	HostPrefix    = "/api/awsm/host/"
)

type Server struct {
	mux       *http.ServeMux
	grants    *grants.Manager
	vault     *vault.Runtime
	transfers *transfer.Manager
}

func NewServer() *Server {
	runtime, err := vault.New(context.Background(), store.NewMemoryState(), vault.Dependencies{})
	if err != nil {
		panic(err)
	}
	server := &Server{
		mux:    http.NewServeMux(),
		grants: grants.NewManager(),
		vault:  runtime,
	}
	server.routes()
	return server
}

func NewServerWithManager(manager *grants.Manager) *Server {
	runtime, err := vault.New(context.Background(), store.NewMemoryState(), vault.Dependencies{})
	if err != nil {
		panic(err)
	}
	return NewServerWithManagerAndVault(manager, runtime)
}

func NewServerWithManagerAndVault(manager *grants.Manager, runtime *vault.Runtime) *Server {
	return NewServerWithManagerAndVaultAndTransfers(manager, runtime, nil)
}

func NewServerWithManagerAndVaultAndTransfers(manager *grants.Manager, runtime *vault.Runtime, transfers *transfer.Manager) *Server {
	if manager == nil {
		panic("Runtime API grant manager is required")
	}
	if runtime == nil {
		panic("Runtime Vault service is required")
	}
	server := &Server{
		mux:       http.NewServeMux(),
		grants:    manager,
		vault:     runtime,
		transfers: transfers,
	}
	server.routes()
	return server
}

func (s *Server) Handler() http.Handler {
	return s.withCORS(s.mux)
}

func (s *Server) GrantManager() *grants.Manager {
	return s.grants
}

// ApprovePairing is called by the trusted desktop UI after the user approves
// a pending extension request. It is intentionally not a public unauthenticated
// HTTP operation.
func (s *Server) ApprovePairing(pairingID string) error {
	return s.grants.Approve(pairingID)
}

func (s *Server) PendingPairings() []grants.PendingPairing {
	return s.grants.Pending()
}

func (s *Server) RevokeGrant(grantID string) error {
	return s.grants.Revoke(grantID)
}

func (s *Server) routes() {
	s.mux.HandleFunc("/api/awsm/runtime/health", s.handleHealth)
	s.mux.HandleFunc("/api/awsm/runtime/command", s.handleCommand)
	s.mux.HandleFunc("/api/awsm/runtime/transfers", s.handleTransfers)
	s.mux.HandleFunc("/api/awsm/runtime/transfers/", s.handleTransfer)
	s.mux.HandleFunc("/api/awsm/runtime/pairings", s.handleBeginPairing)
	s.mux.HandleFunc("/api/awsm/runtime/pairings/", s.handlePairingAction)
	s.mux.HandleFunc("/api/awsm/runtime/grants/", s.handleGrant)
	s.mux.HandleFunc("/api/awsm/host/", s.handleHost)
	// Registering a catch-all is deliberate: PocketBase's generic collection
	// routes are never mounted on this transport adapter.
	s.mux.HandleFunc("/", func(response http.ResponseWriter, request *http.Request) {
		http.NotFound(response, request)
	})
}

func (s *Server) handleTransfers(response http.ResponseWriter, request *http.Request) {
	if _, err := s.authorize(request, grants.ScopeRuntimeVault); err != nil {
		writeError(response, http.StatusUnauthorized, "runtime Vault grant required")
		return
	}
	if s.transfers == nil {
		writeError(response, http.StatusNotFound, "transfer service unavailable")
		return
	}
	switch request.Method {
	case http.MethodGet:
		writeJSON(response, http.StatusOK, s.transfers.Pending())
	case http.MethodPost:
		var input struct {
			VaultID string `json:"vaultId"`
		}
		if err := decodeJSON(request.Body, &input); err != nil {
			writeError(response, http.StatusBadRequest, "invalid transfer request")
			return
		}
		value, err := s.transfers.Begin(request.Context(), input.VaultID)
		if err != nil {
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(response, http.StatusCreated, value)
	default:
		response.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleTransfer(response http.ResponseWriter, request *http.Request) {
	if _, err := s.authorize(request, grants.ScopeRuntimeVault); err != nil {
		writeError(response, http.StatusUnauthorized, "runtime Vault grant required")
		return
	}
	if s.transfers == nil {
		writeError(response, http.StatusNotFound, "transfer service unavailable")
		return
	}
	transferID := strings.TrimPrefix(request.URL.Path, "/api/awsm/runtime/transfers/")
	if transferID == "" || strings.Contains(transferID, "/") {
		writeError(response, http.StatusNotFound, "transfer not found")
		return
	}
	switch request.Method {
	case http.MethodPut:
		secret := strings.TrimSpace(request.Header.Get("Awsm-Transfer-Secret"))
		if secret == "" {
			writeError(response, http.StatusBadRequest, "transfer secret is required")
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, 256<<20)
		value, err := s.transfers.Stage(request.Context(), transferID, secret, request.Body)
		if err != nil {
			writeError(response, http.StatusConflict, err.Error())
			return
		}
		writeJSON(response, http.StatusCreated, value)
	case http.MethodDelete:
		if err := s.transfers.Remove(request.Context(), transferID); err != nil {
			writeError(response, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(response, http.StatusOK, map[string]bool{"removed": true})
	default:
		response.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleCommand(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, err := s.authorize(request, grants.ScopeRuntimeVault); err != nil {
		writeError(response, http.StatusUnauthorized, "runtime Vault grant required")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 4<<20)
	body, err := io.ReadAll(request.Body)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid Runtime Command")
		return
	}
	var raw json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		writeError(response, http.StatusBadRequest, "invalid Runtime Command")
		return
	}
	value, err := s.vault.Handle(request.Context(), raw)
	if err != nil {
		if command, ok := err.(*vault.CommandError); ok {
			writeApplicationFailure(response, http.StatusOK, command)
			return
		}
		writeApplicationFailure(response, http.StatusInternalServerError, &vault.CommandError{
			ID:      "RUNTIME_FAILURE",
			Message: "The Runtime could not complete that Command.",
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "value": value})
}

func (s *Server) handleHealth(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleBeginPairing(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		ClientName string    `json:"clientName"`
		Scopes     *[]string `json:"scopes"`
	}
	if err := decodeJSON(request.Body, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid pairing request")
		return
	}
	var pairing grants.Pairing
	var err error
	if input.Scopes == nil {
		pairing, err = s.grants.Begin(input.ClientName)
	} else {
		pairing, err = s.grants.BeginWithScopes(input.ClientName, *input.Scopes)
	}
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(response, http.StatusCreated, pairing)
}

func (s *Server) handlePairingAction(response http.ResponseWriter, request *http.Request) {
	path := strings.TrimPrefix(request.URL.Path, "/api/awsm/runtime/pairings/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) != 2 || parts[1] != "redeem" {
		writeError(response, http.StatusNotFound, "route not found")
		return
	}
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Code   string    `json:"code"`
		Scopes *[]string `json:"scopes"`
	}
	if err := decodeJSON(request.Body, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid redemption request")
		return
	}
	var grant grants.Grant
	var err error
	if input.Scopes == nil {
		grant, err = s.grants.Redeem(parts[0], input.Code)
	} else {
		grant, err = s.grants.RedeemWithScopes(parts[0], input.Code, *input.Scopes)
	}
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, grants.ErrPairingNotApproved) {
			status = http.StatusConflict
		}
		writeError(response, status, "pairing could not be redeemed")
		return
	}
	writeJSON(response, http.StatusCreated, grant)
}

func (s *Server) handleGrant(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || !strings.HasSuffix(request.URL.Path, "/me") {
		writeError(response, http.StatusNotFound, "route not found")
		return
	}
	grant, err := s.authorize(request, grants.ScopeRuntimeVault)
	if err != nil {
		writeError(response, http.StatusUnauthorized, "runtime grant required")
		return
	}
	writeJSON(response, http.StatusOK, grant)
}

func (s *Server) handleHost(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	// Host Accounts and Replica Access Grants are intentionally not accepted as
	// Runtime API bearer tokens. The opaque Host adapter will attach its own
	// authenticator when the optional Host surface is enabled.
	writeError(response, http.StatusUnauthorized, "replica host grant required")
}

func (s *Server) authorize(request *http.Request, scope string) (grants.Grant, error) {
	value := strings.TrimSpace(request.Header.Get("Authorization"))
	if !strings.HasPrefix(value, "Bearer ") {
		return grants.Grant{}, grants.ErrGrantNotFound
	}
	return s.grants.Authorize(strings.TrimSpace(strings.TrimPrefix(value, "Bearer ")), scope)
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if origin == "" || allowedOrigin(origin) {
			if origin != "" {
				response.Header().Set("Access-Control-Allow-Origin", origin)
				response.Header().Add("Vary", "Origin")
			}
			response.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Awsm-Transfer-Secret")
			response.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if request.Method == http.MethodOptions {
			if origin == "" || allowedOrigin(origin) {
				response.WriteHeader(http.StatusNoContent)
				return
			}
			response.WriteHeader(http.StatusForbidden)
			return
		}
		next.ServeHTTP(response, request)
	})
}

func allowedOrigin(origin string) bool {
	return strings.HasPrefix(origin, "chrome-extension://") ||
		strings.HasPrefix(origin, "moz-extension://") ||
		origin == "wails://wails.localhost" ||
		origin == "http://wails.localhost"
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}

func writeApplicationFailure(response http.ResponseWriter, status int, failure *vault.CommandError) {
	writeJSON(response, status, map[string]any{
		"ok":    false,
		"error": map[string]string{"id": failure.ID, "message": failure.Message},
	})
}

func decodeJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
