//go:build e2e

package vault

import (
	"context"
	"crypto/ed25519"
	"errors"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
)

// SeedCollectionForE2E installs one authenticated Bundle Registered closure for
// the fixture's browser-to-desktop Content journey. It is compiled only into
// the test fixture and never into the product Runtime or Wails binary.
func (r *Runtime) SeedCollectionForE2E(ctx context.Context, vaultID string) (string, error) {
	r.mu.Lock()
	value, ok := r.vaults[vaultID]
	if !ok || value == nil || value.Canonical == nil {
		r.mu.Unlock()
		return "", errors.New("fixture Vault is unavailable")
	}
	requiredFeatureSetText := value.Canonical.RequiredFeatureSetID
	keyEpochText := value.Canonical.KeyEpochID
	memberText := value.Canonical.MemberID
	credentialText := value.Canonical.ClientCredentialID
	generationText := value.GenerationID
	frontier := append([]canonical.Identifier(nil), r.replicas[vaultID].State().CausalFrontier...)
	authorityFrontier := append([]canonical.Identifier(nil), r.replicas[vaultID].State().AuthorityFrontier...)
	r.mu.Unlock()

	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		return "", err
	}
	featureSetID, err := decodeHexIdentifier(requiredFeatureSetText)
	if err != nil {
		return "", err
	}
	bundleID := e2eFixtureIdentifier(0xa1)
	collectionID := e2eFixtureIdentifier(0xa2)
	artifactID := e2eFixtureIdentifier(0xa3)
	descriptorBody := canonical.Map{
		0: uint64(1), 1: bundleID[:], 2: int64(1234), 3: "https://example.test/seeded",
		4: "https://example.test/seeded", 5: "awsm.capture.web-page-snapshot",
		6: "awsm.adapter.browser-web-page", 7: uint64(1), 8: "Seeded Collection",
		9:  []canonical.Value{canonical.Map{0: artifactID[:], 1: "awsm.artifact.primary"}},
		10: []canonical.Value{}, 11: canonical.Map{0: uint64(1), 1: []byte{0xa1, 0x00, 0x01}},
	}
	descriptorBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultIdentifier[:], 2: uint64(1), 3: featureSetID[:],
		4: descriptorBody, 5: map[string][]byte{},
	})
	if err != nil {
		return "", err
	}
	descriptorID, err := canonical.VaultObjectID(vaultIdentifier, 1, descriptorBytes)
	if err != nil {
		return "", err
	}
	epochID, err := decodeHexIdentifier(keyEpochText)
	if err != nil {
		return "", err
	}
	epochBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(vaultID, keyEpochText))
	if err != nil {
		return "", err
	}
	epochSecret, err := decodeEpochSecret(epochBytes, vaultIdentifier, epochID)
	if err != nil {
		return "", err
	}
	defer zeroBytes(epochSecret.key)
	descriptorEnvelope, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key,
		PayloadType: 2, PayloadBytes: descriptorBytes,
	})
	if err != nil {
		return "", err
	}
	if err := r.AdmitOpaqueObject(ctx, vaultID, descriptorEnvelope); err != nil {
		return "", err
	}
	memberID, err := decodeHexIdentifier(memberText)
	if err != nil {
		return "", err
	}
	credentialID, err := decodeHexIdentifier(credentialText)
	if err != nil {
		return "", err
	}
	generationID, err := decodeHexIdentifier(generationText)
	if err != nil {
		return "", err
	}
	clientBytes, err := r.deps.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, credentialText))
	if err != nil {
		return "", err
	}
	clientSecret, err := decodeClientSecret(clientBytes, vaultIdentifier, memberID, credentialID)
	if err != nil {
		return "", err
	}
	defer zeroBytes(clientSecret.signingSecretKey)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: vaultIdentifier, GenerationID: generationID,
		ParentRecordIDs:      frontier,
		AuthorityParentIDs:   authorityFrontier,
		Dependencies:         []canonical.Dependency{{Type: 4, ID: descriptorID}},
		RequiredFeatureSetID: featureSetID, Extensions: map[string][]byte{},
		Family: canonical.ContentFamily, Type: 3, SignerCredentialID: credentialID,
		AssertedAt: 1234, Body: canonical.Map{0: bundleID[:], 1: descriptorID[:], 2: collectionID[:]},
	}, ed25519.PrivateKey(clientSecret.signingSecretKey))
	if err != nil {
		return "", err
	}
	eventEnvelope, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key,
		PayloadType: 1, PayloadBytes: event.Bytes,
	})
	if err != nil {
		return "", err
	}
	if err := r.AdmitOpaqueEvent(ctx, vaultID, eventEnvelope); err != nil {
		return "", err
	}
	return hexIdentifier(collectionID), nil
}

func e2eFixtureIdentifier(value byte) canonical.Identifier {
	var result canonical.Identifier
	for index := range result {
		result[index] = value
	}
	return result
}
