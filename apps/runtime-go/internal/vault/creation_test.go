package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
)

func TestPrepareCanonicalVaultCreationBuildsAuthenticatedGenesis(t *testing.T) {
	ids := CreationIDs{
		VaultID:              filledCreationID(1),
		GenerationID:         filledCreationID(33),
		FirstMemberID:        filledCreationID(65),
		ClientCredentialID:   filledCreationID(97),
		RecoveryCredentialID: filledCreationID(129),
		LabelCauseID:         filledCreationID(161),
	}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{
		Label:                    stringPointer("Example"),
		AssertedAt:               123,
		RecoveryPhrase:           "abandon amount liar amount expire adjust cage candy arch gather drum buyer",
		IDs:                      &ids,
		ClientSigningSeed:        bytes.Repeat([]byte{8}, 32),
		ClientWrappingPrivateKey: bytes.Repeat([]byte{9}, 32),
		KeyEpochKey:              bytes.Repeat([]byte{10}, 32),
		EnvelopePadding:          bytes.Repeat([]byte{11}, 32),
		EnvelopeEphemeralSeed:    bytes.Repeat([]byte{12}, 32),
	})
	if err != nil {
		t.Fatalf("PrepareCanonicalVaultCreation: %v", err)
	}
	if prepared.Genesis.Family != 1 || prepared.Genesis.Type != 1 ||
		len(prepared.Genesis.ParentRecordIDs) != 0 || len(prepared.Genesis.AuthorityParentIDs) != 0 {
		t.Fatalf("Genesis = %#v", prepared.Genesis)
	}
	if !VerifyPreparedCreation(prepared) {
		t.Fatal("prepared Genesis failed local signature and binding verification")
	}
	if prepared.Baseline.RecordID == prepared.Genesis.RecordID || prepared.Baseline.RecordID == ([32]byte{}) {
		t.Fatal("prepared records have invalid identities")
	}
	if len(prepared.BaselineEnvelope.Bytes) == 0 || len(prepared.GenesisEnvelope.Bytes) == 0 {
		t.Fatal("prepared canonical records do not have opaque storage envelopes")
	}
	baselineItem, err := awsmcrypto.OpenCompactItem(prepared.IDs.VaultID, prepared.KeyEpochID, prepared.KeyEpochKey, prepared.BaselineEnvelope.Bytes)
	if err != nil || baselineItem.PayloadType != 1 || !bytes.Equal(baselineItem.PayloadBytes, prepared.Baseline.Bytes) {
		t.Fatalf("opened Baseline envelope = %#v, %v", baselineItem, err)
	}
	genesisItem, err := awsmcrypto.OpenCompactItem(prepared.IDs.VaultID, prepared.KeyEpochID, prepared.KeyEpochKey, prepared.GenesisEnvelope.Bytes)
	if err != nil || genesisItem.PayloadType != 1 || !bytes.Equal(genesisItem.PayloadBytes, prepared.Genesis.Bytes) {
		t.Fatalf("opened Genesis envelope = %#v, %v", genesisItem, err)
	}
	baselineDigest := sha256.Sum256(prepared.Baseline.Bytes)
	if got := hex.EncodeToString(baselineDigest[:]); got != "18d204a59b7d73bfc99e33a9d4b99daa176e964abb4aedd649ec5bb39fb0eb7f" {
		t.Fatalf("Initial Baseline browser parity digest = %s", got)
	}
	genesisDigest := sha256.Sum256(prepared.Genesis.Bytes)
	if got := hex.EncodeToString(genesisDigest[:]); got != "dc9c51a5e42ef5842708e1273d885bca4324a3024ce4da11c245824ef7e7f45d" {
		t.Fatalf("Genesis browser parity digest = %s", got)
	}
	if got := hex.EncodeToString(prepared.RequiredFeatureSetID[:]); got != "ed3dd98a4e6cc13d9d14ca4d62eb6b33e11ed471172346ab5d38ac91f57d7ada" {
		t.Fatalf("empty Required Feature Set ID = %s", got)
	}
}

func TestPrepareCanonicalVaultCreationProtectsInitialFeatureManifestClosure(t *testing.T) {
	feature := canonical.FeatureManifestInput{
		FeatureKey: "awsm.initial.feature", Revision: 1, Parameters: []byte{1, 2},
		RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	}
	prepared, err := PrepareCanonicalVaultCreation(CreationInput{
		RecoveryPhrase:   "abandon amount liar amount expire adjust cage candy arch gather drum buyer",
		FeatureManifests: []canonical.FeatureManifestInput{feature},
	})
	if err != nil {
		t.Fatalf("PrepareCanonicalVaultCreation: %v", err)
	}
	wantSetID, err := canonical.RequiredFeatureSetID([]canonical.FeatureManifestInput{feature})
	if err != nil {
		t.Fatalf("RequiredFeatureSetID: %v", err)
	}
	if prepared.RequiredFeatureSetID != wantSetID || len(prepared.FeatureManifests) != 1 {
		t.Fatalf("prepared Feature Manifest closure = %#v, want set %x", prepared.FeatureManifests, wantSetID)
	}
	manifest := prepared.FeatureManifests[0]
	foundDependency := false
	for _, dependency := range prepared.Baseline.Dependencies {
		if dependency.Type == 8 && dependency.ID == manifest.ID {
			foundDependency = true
		}
	}
	if !foundDependency {
		t.Fatalf("Baseline dependencies omitted Feature Manifest %x", manifest.ID)
	}
	opened, err := awsmcrypto.OpenCompactItem(prepared.IDs.VaultID, prepared.KeyEpochID, prepared.KeyEpochKey, manifest.Envelope.Bytes)
	if err != nil || opened.PayloadType != 3 || !bytes.Equal(opened.PayloadBytes, manifest.Bytes) {
		t.Fatalf("opened Feature Manifest envelope = %#v, %v", opened, err)
	}
}

func TestPrepareCanonicalVaultCreationRejectsInvalidPhraseAndInputs(t *testing.T) {
	if _, err := PrepareCanonicalVaultCreation(CreationInput{
		RecoveryPhrase: "not a Recovery Phrase",
	}); err == nil {
		t.Fatal("PrepareCanonicalVaultCreation accepted an invalid Recovery Phrase")
	}
	if _, err := PrepareCanonicalVaultCreation(CreationInput{
		RecoveryPhrase: "abandon amount liar amount expire adjust cage candy arch gather drum buyer",
		KeyEpochKey:    []byte{1},
	}); err == nil {
		t.Fatal("PrepareCanonicalVaultCreation accepted a short Key Epoch Key")
	}
}

func filledCreationID(start byte) [32]byte {
	var id [32]byte
	for index := range id {
		id[index] = start + byte(index)
	}
	return id
}

func stringPointer(value string) *string { return &value }
