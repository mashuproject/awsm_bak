package vault

import (
	"crypto/sha256"
	"errors"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

// Hosted Replica namespaces are deliberately stable and public only as
// coarse storage classes. The logical identifiers and the per-Replica salt
// remain hidden from the Host by this derived locator.
const (
	hostedNamespaceRecord      byte = 1
	hostedNamespaceKeyEnvelope byte = 2
	hostedNamespaceObject      byte = 3
	hostedNamespaceFeatureSet  byte = 4
	hostedNamespaceArtifact    byte = 5
)

func deriveHostedReplicaLocator(locatorSalt [32]byte, namespace byte, logicalID [32]byte) ([32]byte, error) {
	if namespace < hostedNamespaceRecord || namespace > hostedNamespaceArtifact {
		return [32]byte{}, errors.New("Hosted Replica logical namespace is unknown")
	}
	transcript, err := canonical.Transcript("awsm:hosted-replica-item-locator:v1", locatorSalt[:], []byte{namespace}, logicalID[:])
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(transcript), nil
}
