package securestore

import "testing"

func TestMemorySecureStoreCopiesAndDeletesSecrets(t *testing.T) {
	store := NewMemory()
	secret := []byte("wrapped-key")
	if err := store.Put("awsm", "installation", secret); err != nil {
		t.Fatalf("put secret: %v", err)
	}
	secret[0] = 'X'
	got, err := store.Get("awsm", "installation")
	if err != nil {
		t.Fatalf("get secret: %v", err)
	}
	if string(got) != "wrapped-key" {
		t.Fatalf("secret was not copied on write: %q", got)
	}
	if err := store.Delete("awsm", "installation"); err != nil {
		t.Fatalf("delete secret: %v", err)
	}
	if _, err := store.Get("awsm", "installation"); err == nil {
		t.Fatal("deleted secret must not be readable")
	}
}
