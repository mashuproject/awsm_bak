// Package application composes the trusted Runtime, local persistence, and
// transport adapters for desktop and headless launch modes.
package application

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/artifactstore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/grants"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/httpapi"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/securestore"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/transfer"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/vault"
	"github.com/pocketbase/pocketbase"
)

const DefaultListenAddress = "127.0.0.1:37373"

type Config struct {
	DataDir       string
	ListenAddress string
	ReadyFile     string
}

func (c Config) normalized() (Config, error) {
	if c.DataDir == "" {
		return Config{}, errors.New("data directory is required")
	}
	if c.ListenAddress == "" {
		c.ListenAddress = DefaultListenAddress
	}
	return c, nil
}

type Application struct {
	config       Config
	base         *pocketbase.PocketBase
	state        *store.PocketBaseState
	artifacts    *artifactstore.Store
	grants       *grants.Manager
	vault        *vault.Runtime
	transfers    *transfer.Manager
	api          *httpapi.Server
	server       *http.Server
	listener     net.Listener
	mu           sync.Mutex
	done         chan struct{}
	serveErr     chan error
	doneOnce     sync.Once
	shutdownOnce sync.Once
}

func New(config Config) (*Application, error) {
	config, err := config.normalized()
	if err != nil {
		return nil, err
	}
	base, err := store.NewPocketBaseApp(config.DataDir)
	if err != nil {
		return nil, err
	}
	state, err := store.NewPocketBaseState(base)
	if err != nil {
		_ = base.ResetBootstrapState()
		return nil, err
	}
	artifacts, err := artifactstore.New(filepath.Join(config.DataDir, "artifacts"))
	if err != nil {
		_ = base.ResetBootstrapState()
		return nil, err
	}
	grantManager, err := grants.NewManagerWithState(state)
	if err != nil {
		_ = base.ResetBootstrapState()
		return nil, err
	}
	secrets, err := securestore.NewKeyringStore("dev.awsm.runtime")
	if err != nil {
		_ = base.ResetBootstrapState()
		return nil, err
	}
	vaultRuntime, err := vault.New(context.Background(), state, vault.Dependencies{Artifacts: artifacts, Secrets: secrets})
	if err != nil {
		_ = base.ResetBootstrapState()
		return nil, err
	}
	transferManager, err := transfer.NewManager(context.Background(), state, artifacts)
	if err != nil {
		_ = base.ResetBootstrapState()
		return nil, err
	}
	return &Application{
		config:    config,
		base:      base,
		state:     state,
		artifacts: artifacts,
		grants:    grantManager,
		vault:     vaultRuntime,
		transfers: transferManager,
		api:       httpapi.NewServerWithManagerAndVaultAndTransfers(grantManager, vaultRuntime, transferManager),
		done:      make(chan struct{}),
		serveErr:  make(chan error, 1),
	}, nil
}

func (a *Application) Start() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.listener != nil {
		return errors.New("application is already running")
	}
	listener, err := net.Listen("tcp", a.config.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", a.config.ListenAddress, err)
	}
	a.listener = listener
	if a.config.ReadyFile != "" {
		if err := writeReadyFile(a.config.ReadyFile, listener.Addr().String()); err != nil {
			_ = listener.Close()
			a.listener = nil
			return fmt.Errorf("write runtime ready file: %w", err)
		}
	}
	a.server = &http.Server{
		Handler:           a.api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	server := a.server
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Keep the process fail-closed and let the supervisor decide how to log
			// the serving error; request data never enters this channel.
			a.serveErr <- err
		}
		a.doneOnce.Do(func() { close(a.done) })
	}()
	return nil
}

func (a *Application) Wait() error {
	a.mu.Lock()
	server := a.server
	a.mu.Unlock()
	if server == nil {
		return errors.New("application is not running")
	}
	select {
	case err := <-a.serveErr:
		return fmt.Errorf("runtime HTTP server stopped: %w", err)
	case <-a.done:
		select {
		case err := <-a.serveErr:
			return fmt.Errorf("runtime HTTP server stopped: %w", err)
		default:
			return nil
		}
	}
}

func (a *Application) Shutdown(ctx context.Context) error {
	var result error
	a.shutdownOnce.Do(func() {
		a.mu.Lock()
		server := a.server
		a.server = nil
		a.listener = nil
		a.mu.Unlock()
		if server != nil {
			result = server.Shutdown(ctx)
		}
		if a.config.ReadyFile != "" {
			if err := os.Remove(a.config.ReadyFile); err != nil && !errors.Is(err, os.ErrNotExist) && result == nil {
				result = fmt.Errorf("remove runtime ready file: %w", err)
			}
		}
		baseErr := a.base.ResetBootstrapState()
		if result == nil {
			result = baseErr
		}
		a.doneOnce.Do(func() { close(a.done) })
	})
	return result
}

func (a *Application) Address() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.listener != nil {
		return a.listener.Addr().String()
	}
	return a.config.ListenAddress
}

func (a *Application) Handler() http.Handler {
	return a.api.Handler()
}

func (a *Application) ArtifactStore() *artifactstore.Store {
	return a.artifacts
}

func (a *Application) PendingPairings() []grants.PendingPairing {
	return a.grants.Pending()
}

func (a *Application) ApprovePairing(pairingID string) error {
	return a.api.ApprovePairing(pairingID)
}

func (a *Application) RevokeGrant(grantID string) error {
	return a.api.RevokeGrant(grantID)
}

func (a *Application) GrantSummaries() []grants.GrantSummary {
	return a.grants.List()
}

func (a *Application) VaultRuntime() *vault.Runtime {
	return a.vault
}

func (a *Application) PendingTransfers() []transfer.Summary {
	return a.transfers.Pending()
}

func (a *Application) AcceptTransfer(transferID string) error {
	payload, summary, err := a.transfers.OpenStaged(transferID)
	if err != nil {
		return err
	}
	packageVaultID, err := vault.TransferPackageVaultID(payload)
	if err != nil {
		return err
	}
	if packageVaultID != summary.VaultID {
		return errors.New("staged transfer Vault identity does not match its authorized transfer")
	}
	if _, err := a.vault.ImportTransfer(context.Background(), payload); err != nil {
		return err
	}
	return a.transfers.Remove(context.Background(), transferID)
}

func (a *Application) RejectTransfer(transferID string) error {
	return a.transfers.Remove(context.Background(), transferID)
}

func writeReadyFile(path, address string) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".awsm-runtime-ready-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := fmt.Fprintf(temporary, "{\"address\":%q}\n", address); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
