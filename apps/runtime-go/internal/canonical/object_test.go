package canonical

import "testing"

func TestVaultObjectIDUsesCanonicalTypeFraming(t *testing.T) {
	vaultID := Identifier{}
	vaultID[0] = 1
	first, err := VaultObjectID(vaultID, 1, []byte{0xa1, 0x00, 0x01})
	if err != nil {
		t.Fatalf("VaultObjectID: %v", err)
	}
	second, err := VaultObjectID(vaultID, 2, []byte{0xa1, 0x00, 0x01})
	if err != nil {
		t.Fatalf("VaultObjectID: %v", err)
	}
	if first == second {
		t.Fatal("Vault Object type was not included in the content address")
	}
}
