package vault

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

func TestReplicaAdmitsAuthenticatedCreationAndTracksFrontiers(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatalf("NewReplica: %v", err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	state := replica.State()
	if state.VaultID != prepared.IDs.VaultID || state.GenerationID != prepared.IDs.GenerationID ||
		len(state.CausalFrontier) != 1 || state.CausalFrontier[0] != prepared.Genesis.RecordID ||
		len(state.AuthorityFrontier) != 1 || state.AuthorityFrontier[0] != prepared.Genesis.RecordID {
		t.Fatalf("Replica State = %#v", state)
	}
	if _, ok := replica.Record(prepared.Genesis.RecordID); !ok {
		t.Fatal("Replica did not retain admitted Genesis")
	}

	first := signReplicaChild(t, prepared, prepared.Genesis.RecordID, 7)
	second := signReplicaChild(t, prepared, prepared.Genesis.RecordID, 8)
	if err := replica.AdmitEvent(first, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit first child: %v", err)
	}
	if err := replica.AdmitEvent(second, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit second child: %v", err)
	}
	state = replica.State()
	if len(state.CausalFrontier) != 2 || len(state.AuthorityFrontier) != 2 {
		t.Fatalf("concurrent frontiers = %#v", state)
	}
	if !replica.IsAncestor(prepared.Genesis.RecordID, first.RecordID) ||
		!replica.IsAncestor(prepared.Genesis.RecordID, second.RecordID) {
		t.Fatal("Replica lost Genesis ancestry")
	}
}

func TestReplicaRejectsUnauthenticatedOrUnknownEvents(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, bytes.Repeat([]byte{0x42}, ed25519.PublicKeySize)); err == nil {
		t.Fatal("Replica accepted a Genesis with the wrong signer key")
	}
	unknown := signReplicaChild(t, prepared, filledCreationID(200), 9)
	if err := replica.AdmitEvent(unknown, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted an Event with an unknown parent")
	}
}

func deterministicCreation(t *testing.T) PreparedCanonicalVaultCreation {
	t.Helper()
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
	return prepared
}

func signReplicaChild(t *testing.T, prepared PreparedCanonicalVaultCreation, parent canonical.Identifier, eventType uint64) canonical.Event {
	t.Helper()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{parent}, AuthorityParentIDs: []canonical.Identifier{parent},
		Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: eventType,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 124 + int64(eventType),
		Body: canonical.Map{0: uint64(eventType)},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign child: %v", err)
	}
	return event
}
