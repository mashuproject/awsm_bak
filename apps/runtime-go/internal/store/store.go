// Package store contains AWSM-owned storage interfaces and their PocketBase
// collection adapter. PocketBase types do not cross this package boundary.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const RuntimeStateCollection = "awsm_runtime_state"

var ErrStateNotFound = stateNotFoundError{}

type stateNotFoundError struct{}

func (stateNotFoundError) Error() string       { return "state not found" }
func (stateNotFoundError) StateNotFound() bool { return true }

// StateStore is the minimal persistence contract used by local Runtime
// services. Keys are AWSM namespace keys, not PocketBase record identifiers.
type StateStore interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
	Delete(context.Context, string) error
}

type MemoryState struct {
	mu     sync.RWMutex
	values map[string][]byte
}

func NewMemoryState() *MemoryState {
	return &MemoryState{values: make(map[string][]byte)}
}

func (s *MemoryState) Put(_ context.Context, key string, value []byte) error {
	if key == "" {
		return errors.New("state key is required")
	}
	s.mu.Lock()
	s.values[key] = append([]byte(nil), value...)
	s.mu.Unlock()
	return nil
}

func (s *MemoryState) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.RLock()
	value, ok := s.values[key]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrStateNotFound
	}
	return append([]byte(nil), value...), nil
}

func (s *MemoryState) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.values[key]; !ok {
		return ErrStateNotFound
	}
	delete(s.values, key)
	return nil
}

// PocketBaseState persists opaque AWSM-owned JSON values in one internal
// Collection. Domain services use StateStore and never depend on PocketBase
// Record or Collection types.
type PocketBaseState struct {
	app core.App
	mu  sync.Mutex
}

func NewPocketBaseState(app core.App) (*PocketBaseState, error) {
	if app == nil {
		return nil, errors.New("PocketBase app is required")
	}
	if err := ensureRuntimeCollection(app); err != nil {
		return nil, err
	}
	return &PocketBaseState{app: app}, nil
}

func NewPocketBaseApp(dataDir string) (*pocketbase.PocketBase, error) {
	if dataDir == "" {
		return nil, errors.New("PocketBase data directory is required")
	}
	app := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir:  dataDir,
		HideStartBanner: true,
	})
	if err := app.Bootstrap(); err != nil {
		return nil, fmt.Errorf("bootstrap PocketBase: %w", err)
	}
	if err := ensureRuntimeCollection(app); err != nil {
		_ = app.ResetBootstrapState()
		return nil, err
	}
	return app, nil
}

func (s *PocketBaseState) Put(ctx context.Context, key string, value []byte) error {
	if key == "" {
		return errors.New("state key is required")
	}
	if len(value) == 0 {
		return errors.New("state value is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.app.RunInTransaction(func(txApp core.App) error {
		collection, err := txApp.FindCollectionByNameOrId(RuntimeStateCollection)
		if err != nil {
			return fmt.Errorf("find runtime state collection: %w", err)
		}
		record, err := txApp.FindFirstRecordByData(collection, "state_key", key)
		if err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("find runtime state %q: %w", key, err)
			}
			record = core.NewRecord(collection)
			record.Set("state_key", key)
		}
		record.Set("payload", string(value))
		return txApp.SaveWithContext(ctx, record)
	})
}

func (s *PocketBaseState) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	collection, err := s.app.FindCollectionByNameOrId(RuntimeStateCollection)
	if err != nil {
		return nil, fmt.Errorf("find runtime state collection: %w", err)
	}
	record, err := s.app.FindFirstRecordByData(collection, "state_key", key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrStateNotFound
		}
		return nil, fmt.Errorf("find runtime state %q: %w", key, err)
	}
	raw := record.GetRaw("payload")
	switch value := raw.(type) {
	case types.JSONRaw:
		return append([]byte(nil), value...), nil
	case []byte:
		return append([]byte(nil), value...), nil
	case string:
		return []byte(value), nil
	default:
		return nil, fmt.Errorf("runtime state payload has unsupported type %T", raw)
	}
}

func (s *PocketBaseState) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.app.RunInTransaction(func(txApp core.App) error {
		collection, err := txApp.FindCollectionByNameOrId(RuntimeStateCollection)
		if err != nil {
			return fmt.Errorf("find runtime state collection: %w", err)
		}
		record, err := txApp.FindFirstRecordByData(collection, "state_key", key)
		if err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("find runtime state %q: %w", key, err)
			}
			return ErrStateNotFound
		}
		return txApp.Delete(record)
	})
}

func ensureRuntimeCollection(app core.App) error {
	if _, err := app.FindCollectionByNameOrId(RuntimeStateCollection); err == nil {
		return nil
	}
	collection := core.NewBaseCollection(RuntimeStateCollection)
	collection.Fields.Add(
		&core.TextField{Name: "state_key", Required: true, Max: 500},
		&core.JSONField{Name: "payload", Required: true, MaxSize: 4 << 20},
	)
	collection.AddIndex("idx_awsm_runtime_state_key", true, "state_key", "")
	if err := app.Save(collection); err != nil {
		return fmt.Errorf("create AWSM runtime state collection: %w", err)
	}
	return nil
}
