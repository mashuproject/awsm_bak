package securestore

import (
	"encoding/base64"
	"errors"

	keyring "github.com/zalando/go-keyring"
)

type keyringBackend interface {
	Get(service, account string) (string, error)
	Set(service, account, secret string) error
	Delete(service, account string) error
}

type keyringStore struct {
	service string
	backend keyringBackend
}

// NewKeyringStore binds Trusted Secrets to the operating system's credential
// facility. It has no file, memory, or environment fallback.
func NewKeyringStore(service string) (Store, error) {
	if service == "" {
		return nil, errors.New("secure-store service is required")
	}
	return NewKeyringStoreWithBackend(service, osKeyringBackend{}), nil
}

func NewKeyringStoreWithBackend(service string, backend keyringBackend) Store {
	return &keyringStore{service: service, backend: backend}
}

func (s *keyringStore) Get(service, account string) ([]byte, error) {
	if err := validateScope(service, account); err != nil {
		return nil, err
	}
	encoded, err := s.backend.Get(s.service+":"+service, account)
	if err != nil {
		return nil, ErrUnavailable
	}
	secret, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(secret) == 0 {
		return nil, ErrUnavailable
	}
	return secret, nil
}

func (s *keyringStore) Put(service, account string, secret []byte) error {
	if err := validateScope(service, account); err != nil {
		return err
	}
	if len(secret) == 0 {
		return errors.New("secure-store secret is required")
	}
	if err := s.backend.Set(s.service+":"+service, account, base64.RawStdEncoding.EncodeToString(secret)); err != nil {
		return ErrUnavailable
	}
	return nil
}

func (s *keyringStore) Delete(service, account string) error {
	if err := validateScope(service, account); err != nil {
		return err
	}
	if err := s.backend.Delete(s.service+":"+service, account); err != nil {
		return ErrUnavailable
	}
	return nil
}

func validateScope(service, account string) error {
	if service == "" || account == "" {
		return errors.New("secure-store service and account are required")
	}
	return nil
}

type osKeyringBackend struct{}

func (osKeyringBackend) Get(service, account string) (string, error) {
	return keyring.Get(service, account)
}

func (osKeyringBackend) Set(service, account, secret string) error {
	return keyring.Set(service, account, secret)
}

func (osKeyringBackend) Delete(service, account string) error {
	return keyring.Delete(service, account)
}
