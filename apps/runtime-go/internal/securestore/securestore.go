// Package securestore defines the platform secret boundary used by the Go
// Runtime. Concrete desktop adapters must use the operating system's secure
// credential facility; this package provides no plaintext fallback.
package securestore

import "errors"

var ErrUnavailable = errors.New("operating-system secure storage is unavailable")

type Store interface {
	Get(service, account string) ([]byte, error)
	Put(service, account string, secret []byte) error
	Delete(service, account string) error
}
