package securestore

import (
	"errors"
	"sync"
)

// Memory is a test-only Store. Keeping it in a _test.go file prevents a
// plaintext implementation from being linked into the Runtime binary.
type Memory struct {
	mu     sync.RWMutex
	values map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{values: make(map[string][]byte)}
}

func (s *Memory) Get(service, account string) ([]byte, error) {
	s.mu.RLock()
	value, ok := s.values[key(service, account)]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrUnavailable
	}
	return append([]byte(nil), value...), nil
}

func (s *Memory) Put(service, account string, secret []byte) error {
	if service == "" || account == "" || len(secret) == 0 {
		return errors.New("secure-store service, account, and secret are required")
	}
	s.mu.Lock()
	s.values[key(service, account)] = append([]byte(nil), secret...)
	s.mu.Unlock()
	return nil
}

func (s *Memory) Delete(service, account string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	name := key(service, account)
	if _, ok := s.values[name]; !ok {
		return ErrUnavailable
	}
	delete(s.values, name)
	return nil
}

func key(service, account string) string { return service + "\x00" + account }
