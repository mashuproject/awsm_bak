package canonical

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

var ErrObjectTypeOverflow = errors.New("Vault Object type exceeds uint32")

// VaultObjectID is the cross-runtime content address for one canonical Vault
// Object. The object type is framed as uint32 exactly as in the browser
// Runtime; the object bytes remain opaque to Host transports.
func VaultObjectID(vaultID Identifier, objectType uint64, encoded []byte) (Identifier, error) {
	if objectType > uint64(^uint32(0)) {
		return Identifier{}, ErrObjectTypeOverflow
	}
	objectTypeBytes := make([]byte, 4)
	binary.BigEndian.PutUint32(objectTypeBytes, uint32(objectType))
	framed, err := Transcript("awsm:vault-object-id:v1", vaultID[:], objectTypeBytes, encoded)
	if err != nil {
		return Identifier{}, err
	}
	return sha256.Sum256(framed), nil
}
