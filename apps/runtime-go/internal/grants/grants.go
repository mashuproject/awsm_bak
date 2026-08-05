// Package grants implements the local Runtime API pairing boundary.
//
// These grants authorize one API Client to use selected Runtime operations in
// one Client Installation. They are deliberately not Vault membership,
// Client Credentials, Accounts, or Replica Access Grants.
package grants

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
)

var (
	ErrPairingNotFound    = errors.New("pairing not found")
	ErrPairingNotApproved = errors.New("pairing is not approved")
	ErrPairingRedeemed    = errors.New("pairing has already been redeemed")
	ErrInvalidPairingCode = errors.New("invalid pairing code")
	ErrGrantNotFound      = errors.New("grant not found")
	ErrGrantRevoked       = errors.New("grant is revoked")
	ErrScopeDenied        = errors.New("grant scope denied")
)

const (
	// ScopeRuntimeVault authorizes the current Vault command surface. It is
	// intentionally one capability: the Runtime still applies Vault authority
	// and expected-context checks to every command.
	ScopeRuntimeVault = "runtime.vault"
)

const persistedStateKey = "awsm.runtime.grants"

// StateStore is the narrow persistence contract needed by local grants. The
// PocketBase adapter satisfies it, but grants never depend on PocketBase types.
type StateStore interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
}

var defaultScopes = []string{
	ScopeRuntimeVault,
}

// Pairing is the user-visible portion of an extension pairing request. Code is
// returned only when the request is created; the manager stores only its hash.
type Pairing struct {
	ID         string   `json:"pairingId"`
	ClientName string   `json:"clientName"`
	Scopes     []string `json:"scopes"`
	Code       string   `json:"code"`
}

// PendingPairing is safe for the trusted desktop UI to display while it asks
// the user to approve a request. It never includes the pairing code.
type PendingPairing struct {
	ID         string   `json:"pairingId"`
	ClientName string   `json:"clientName"`
	Scopes     []string `json:"scopes"`
}

// Grant is an opaque local API grant. Token is returned once from redemption
// and is retained only as a hash by the manager.
type Grant struct {
	ID         string   `json:"grantId"`
	ClientName string   `json:"clientName"`
	Scopes     []string `json:"scopes"`
	Token      string   `json:"token,omitempty"`
	Revoked    bool     `json:"revoked"`
}

// GrantSummary is safe for trusted management surfaces. It deliberately has
// no bearer token field.
type GrantSummary struct {
	ID         string   `json:"grantId"`
	ClientName string   `json:"clientName"`
	Scopes     []string `json:"scopes"`
	Revoked    bool     `json:"revoked"`
}

type pairingState struct {
	Pairing
	codeHash [32]byte
	approved bool
	redeemed bool
}

type grantState struct {
	Grant
	tokenHash [32]byte
}

// Manager owns local pairing and grant lifecycle. Persistence is intentionally
// behind this boundary; a later store adapter can snapshot these state values
// without exposing them to the HTTP or Vault layers.
type Manager struct {
	mu       sync.RWMutex
	pairings map[string]pairingState
	grants   map[string]grantState
	state    StateStore
}

func NewManager() *Manager {
	return &Manager{
		pairings: make(map[string]pairingState),
		grants:   make(map[string]grantState),
	}
}

func NewManagerWithState(state StateStore) (*Manager, error) {
	if state == nil {
		return nil, errors.New("grant state store is required")
	}
	manager := &Manager{
		pairings: make(map[string]pairingState),
		grants:   make(map[string]grantState),
		state:    state,
	}
	serialized, err := state.Get(context.Background(), persistedStateKey)
	if isStateNotFound(err) {
		return manager, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load local grant state: %w", err)
	}
	var snapshot persistedSnapshot
	if err := json.Unmarshal(serialized, &snapshot); err != nil {
		return nil, fmt.Errorf("decode local grant state: %w", err)
	}
	manager.pairings = snapshot.pairingStates()
	manager.grants = snapshot.grantStates()
	if manager.pairings == nil {
		manager.pairings = make(map[string]pairingState)
	}
	if manager.grants == nil {
		manager.grants = make(map[string]grantState)
	}
	return manager, nil
}

func (m *Manager) Begin(clientName string) (Pairing, error) {
	return m.BeginWithScopes(clientName, defaultScopes)
}

func (m *Manager) BeginWithScopes(clientName string, scopes []string) (Pairing, error) {
	clientName = strings.TrimSpace(clientName)
	if clientName == "" {
		return Pairing{}, errors.New("client name is required")
	}
	normalizedScopes, err := normalizeScopes(scopes)
	if err != nil {
		return Pairing{}, err
	}

	code, err := randomToken(24)
	if err != nil {
		return Pairing{}, fmt.Errorf("generate pairing code: %w", err)
	}
	id := uuid.NewString()
	pairing := Pairing{ID: id, ClientName: clientName, Scopes: normalizedScopes, Code: code}
	m.mu.Lock()
	stored := pairingState{
		Pairing:  Pairing{ID: pairing.ID, ClientName: pairing.ClientName, Scopes: append([]string(nil), pairing.Scopes...)},
		codeHash: sha256.Sum256([]byte(code)),
	}
	m.pairings[id] = stored
	if err := m.persistLocked(); err != nil {
		delete(m.pairings, id)
		m.mu.Unlock()
		return Pairing{}, err
	}
	m.mu.Unlock()
	return pairing, nil
}

func (m *Manager) Pending() []PendingPairing {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]PendingPairing, 0)
	for _, state := range m.pairings {
		if !state.approved && !state.redeemed {
			result = append(result, PendingPairing{ID: state.ID, ClientName: state.ClientName, Scopes: append([]string(nil), state.Scopes...)})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (m *Manager) List() []GrantSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]GrantSummary, 0, len(m.grants))
	for _, state := range m.grants {
		result = append(result, GrantSummary{
			ID:         state.ID,
			ClientName: state.ClientName,
			Scopes:     append([]string(nil), state.Scopes...),
			Revoked:    state.Revoked,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (m *Manager) Approve(pairingID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.pairings[pairingID]
	if !ok {
		return ErrPairingNotFound
	}
	if state.redeemed {
		return ErrPairingRedeemed
	}
	state.approved = true
	m.pairings[pairingID] = state
	if err := m.persistLocked(); err != nil {
		state.approved = false
		m.pairings[pairingID] = state
		return err
	}
	return nil
}

func (m *Manager) Redeem(pairingID, code string) (Grant, error) {
	m.mu.RLock()
	state, ok := m.pairings[pairingID]
	m.mu.RUnlock()
	if !ok {
		return Grant{}, ErrPairingNotFound
	}
	return m.redeemWithScopes(pairingID, code, state.Scopes)
}

func (m *Manager) RedeemWithScopes(pairingID, code string, scopes []string) (Grant, error) {
	return m.redeemWithScopes(pairingID, code, scopes)
}

func (m *Manager) redeemWithScopes(pairingID, code string, scopes []string) (Grant, error) {
	if strings.TrimSpace(code) == "" {
		return Grant{}, ErrInvalidPairingCode
	}
	normalizedScopes, err := normalizeScopes(scopes)
	if err != nil {
		return Grant{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.pairings[pairingID]
	if !ok {
		return Grant{}, ErrPairingNotFound
	}
	if !state.approved {
		return Grant{}, ErrPairingNotApproved
	}
	if state.redeemed {
		return Grant{}, ErrPairingRedeemed
	}
	if sha256.Sum256([]byte(code)) != state.codeHash {
		return Grant{}, ErrInvalidPairingCode
	}
	if !scopesWithin(scopes, state.Scopes) {
		return Grant{}, ErrScopeDenied
	}

	token, err := randomToken(32)
	if err != nil {
		return Grant{}, fmt.Errorf("generate grant token: %w", err)
	}
	grant := Grant{
		ID:         uuid.NewString(),
		ClientName: state.ClientName,
		Scopes:     normalizedScopes,
		Token:      token,
	}
	m.grants[grant.ID] = grantState{
		Grant: Grant{
			ID:         grant.ID,
			ClientName: grant.ClientName,
			Scopes:     append([]string(nil), grant.Scopes...),
		},
		tokenHash: sha256.Sum256([]byte(token)),
	}
	state.redeemed = true
	state.Code = ""
	m.pairings[pairingID] = state
	if err := m.persistLocked(); err != nil {
		delete(m.grants, grant.ID)
		state.redeemed = false
		m.pairings[pairingID] = state
		return Grant{}, err
	}
	return grant, nil
}

func (m *Manager) Revoke(grantID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.grants[grantID]
	if !ok {
		return ErrGrantNotFound
	}
	state.Revoked = true
	state.Token = ""
	m.grants[grantID] = state
	if err := m.persistLocked(); err != nil {
		state.Revoked = false
		m.grants[grantID] = state
		return err
	}
	return nil
}

func (m *Manager) Authorize(token, scope string) (Grant, error) {
	if strings.TrimSpace(token) == "" {
		return Grant{}, ErrGrantNotFound
	}
	tokenHash := sha256.Sum256([]byte(token))
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, state := range m.grants {
		if state.tokenHash != tokenHash {
			continue
		}
		if state.Revoked {
			return Grant{}, ErrGrantRevoked
		}
		if !contains(state.Scopes, scope) {
			return Grant{}, ErrScopeDenied
		}
		grant := state.Grant
		grant.Token = ""
		grant.Scopes = append([]string(nil), state.Scopes...)
		return grant, nil
	}
	return Grant{}, ErrGrantNotFound
}

func normalizeScopes(scopes []string) ([]string, error) {
	if len(scopes) == 0 {
		return nil, errors.New("at least one scope is required")
	}
	set := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		scope = strings.TrimSpace(scope)
		if scope == "" {
			return nil, errors.New("scope cannot be empty")
		}
		if scope != ScopeRuntimeVault {
			return nil, fmt.Errorf("unsupported local Runtime scope %q", scope)
		}
		set[scope] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for scope := range set {
		result = append(result, scope)
	}
	sort.Strings(result)
	return result, nil
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func randomToken(size int) (string, error) {
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

type persistedSnapshot struct {
	Pairings map[string]persistedPairing `json:"pairings"`
	Grants   map[string]persistedGrant   `json:"grants"`
}

func (m *Manager) persistLocked() error {
	if m.state == nil {
		return nil
	}
	snapshot, err := json.Marshal(newPersistedSnapshot(m.pairings, m.grants))
	if err != nil {
		return fmt.Errorf("encode local grant state: %w", err)
	}
	if err := m.state.Put(context.Background(), persistedStateKey, snapshot); err != nil {
		return fmt.Errorf("persist local grant state: %w", err)
	}
	return nil
}

type persistedPairing struct {
	ID         string   `json:"id"`
	ClientName string   `json:"clientName"`
	Scopes     []string `json:"scopes"`
	CodeHash   []byte   `json:"codeHash"`
	Approved   bool     `json:"approved"`
	Redeemed   bool     `json:"redeemed"`
}

type persistedGrant struct {
	ID         string   `json:"id"`
	ClientName string   `json:"clientName"`
	Scopes     []string `json:"scopes"`
	Revoked    bool     `json:"revoked"`
	TokenHash  []byte   `json:"tokenHash"`
}

func newPersistedSnapshot(pairings map[string]pairingState, grants map[string]grantState) persistedSnapshot {
	snapshot := persistedSnapshot{
		Pairings: make(map[string]persistedPairing, len(pairings)),
		Grants:   make(map[string]persistedGrant, len(grants)),
	}
	for key, state := range pairings {
		snapshot.Pairings[key] = persistedPairing{
			ID:         state.ID,
			ClientName: state.ClientName,
			Scopes:     append([]string(nil), state.Scopes...),
			CodeHash:   state.codeHash[:],
			Approved:   state.approved,
			Redeemed:   state.redeemed,
		}
	}
	for key, state := range grants {
		snapshot.Grants[key] = persistedGrant{
			ID:         state.ID,
			ClientName: state.ClientName,
			Scopes:     append([]string(nil), state.Scopes...),
			Revoked:    state.Revoked,
			TokenHash:  state.tokenHash[:],
		}
	}
	return snapshot
}

func (s persistedSnapshot) pairingStates() map[string]pairingState {
	result := make(map[string]pairingState, len(s.Pairings))
	for key, state := range s.Pairings {
		var codeHash [32]byte
		copy(codeHash[:], state.CodeHash)
		result[key] = pairingState{
			Pairing:  Pairing{ID: state.ID, ClientName: state.ClientName, Scopes: append([]string(nil), state.Scopes...)},
			codeHash: codeHash,
			approved: state.Approved,
			redeemed: state.Redeemed,
		}
	}
	return result
}

func scopesWithin(requested, allowed []string) bool {
	normalized, err := normalizeScopes(requested)
	if err != nil {
		return false
	}
	for _, scope := range normalized {
		if !contains(allowed, scope) {
			return false
		}
	}
	return true
}

func (s persistedSnapshot) grantStates() map[string]grantState {
	result := make(map[string]grantState, len(s.Grants))
	for key, state := range s.Grants {
		var tokenHash [32]byte
		copy(tokenHash[:], state.TokenHash)
		result[key] = grantState{
			Grant: Grant{
				ID:         state.ID,
				ClientName: state.ClientName,
				Scopes:     append([]string(nil), state.Scopes...),
				Revoked:    state.Revoked,
			},
			tokenHash: tokenHash,
		}
	}
	return result
}

type stateNotFound interface {
	StateNotFound() bool
}

func isStateNotFound(err error) bool {
	var notFound stateNotFound
	return errors.As(err, &notFound) && notFound.StateNotFound()
}
