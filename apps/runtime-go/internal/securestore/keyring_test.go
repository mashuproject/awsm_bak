package securestore

import (
	"errors"
	"testing"
)

type fakeKeyring struct {
	values map[string]string
}

func (f *fakeKeyring) Get(service, account string) (string, error) {
	value, ok := f.values[service+"\x00"+account]
	if !ok {
		return "", errors.New("missing")
	}
	return value, nil
}

func (f *fakeKeyring) Set(service, account, value string) error {
	if f.values == nil {
		f.values = map[string]string{}
	}
	f.values[service+"\x00"+account] = value
	return nil
}

func (f *fakeKeyring) Delete(service, account string) error {
	delete(f.values, service+"\x00"+account)
	return nil
}

func TestKeyringStoreRoundTripsBinarySecretsWithoutAPlaintextFallback(t *testing.T) {
	backend := &fakeKeyring{}
	store := NewKeyringStoreWithBackend("dev.awsm.test", backend)
	secret := []byte{0, 1, 2, 0xff}
	if err := store.Put("client-secret", "vault-1", secret); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := store.Get("client-secret", "vault-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != string(secret) {
		t.Fatalf("secret = %x, want %x", got, secret)
	}
	if err := store.Delete("client-secret", "vault-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get("client-secret", "vault-1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing Get error = %v, want ErrUnavailable", err)
	}
}

func TestKeyringStoreRejectsInvalidSecretScope(t *testing.T) {
	store := NewKeyringStoreWithBackend("dev.awsm.test", &fakeKeyring{})
	if err := store.Put("", "account", []byte{1}); err == nil {
		t.Fatal("Put accepted an empty service")
	}
	if err := store.Put("service", "", []byte{1}); err == nil {
		t.Fatal("Put accepted an empty account")
	}
	if err := store.Put("service", "account", nil); err == nil {
		t.Fatal("Put accepted an empty secret")
	}
}
