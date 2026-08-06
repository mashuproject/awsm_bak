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

func TestReplicaRejectsEventWithUnknownSignerCredential(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	event := signReplicaChildWithCredential(t, prepared, prepared.Genesis.RecordID, 7, filledCreationID(201))
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted an Event from an unknown Credential")
	}
}

func TestReplicaRejectsEventsDescendedFromExplicitClosure(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	closure, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.LifecycleFamily, Type: 2,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 200, Body: canonical.Map{},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Closure: %v", err)
	}
	if err := replica.AdmitEvent(closure, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Closure: %v", err)
	}
	descendant := signReplicaChild(t, prepared, closure.RecordID, 7)
	if err := replica.AdmitEvent(descendant, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted an Event descended from explicit Closure")
	}
}

func TestReplicaAdministratorEndDerivesClosure(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	adminEnd, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 4,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 201,
		Body: canonical.Map{0: prepared.IDs.FirstMemberID[:], 1: []canonical.Value{}},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Administrator End: %v", err)
	}
	if err := replica.AdmitEvent(adminEnd, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Administrator End: %v", err)
	}
	state, err := replayAuthenticatedKeyEpochs(replica.Events(), prepared.Genesis, nil)
	if err != nil {
		t.Fatalf("replay Administrator End: %v", err)
	}
	if !state.closed || len(state.administrators) != 0 {
		t.Fatalf("Authority state after final Administrator End = closed %t, administrators %#v", state.closed, state.administrators)
	}
}

func TestReplicaAdmitsContentAddressedObject(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	objectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(1), 3: prepared.RequiredFeatureSetID[:],
		4: canonical.Map{}, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	objectID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 1, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitObject(objectID, objectBytes); err != nil {
		t.Fatalf("AdmitObject: %v", err)
	}
	stored, ok := replica.Object(objectID)
	if !ok || !bytes.Equal(stored.Bytes, objectBytes) {
		t.Fatalf("stored Object = %#v, want exact bytes", stored)
	}
	if err := replica.AdmitObject(objectID, append([]byte(nil), objectBytes...)); err != nil {
		t.Fatalf("duplicate Object admission: %v", err)
	}
}

func TestReplicaAdmitsContentAddressedFeatureManifest(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{
		FeatureKey: "awsm.desktop.feature", Revision: 1, Parameters: []byte{1, 2},
		RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestID, err := canonical.FeatureManifestID(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitFeatureManifest(manifestID, manifestBytes); err != nil {
		t.Fatalf("AdmitFeatureManifest: %v", err)
	}
	stored, ok := replica.FeatureManifest(manifestID)
	if !ok || !bytes.Equal(stored.Bytes, manifestBytes) || stored.ID != manifestID {
		t.Fatalf("stored Feature Manifest = %#v", stored)
	}
	if err := replica.AdmitFeatureManifest(manifestID, append([]byte(nil), manifestBytes...)); err != nil {
		t.Fatalf("duplicate Feature Manifest admission: %v", err)
	}
	wrongID := filledCreationID(222)
	if err := replica.AdmitFeatureManifest(wrongID, manifestBytes); err == nil {
		t.Fatal("Feature Manifest admitted under the wrong content address")
	}
}

func TestProjectLibraryReducesBundleRegistrationAndDescriptor(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	bundleID := filledCreationID(210)
	collectionID := filledCreationID(211)
	artifactObjectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(2), 3: prepared.RequiredFeatureSetID[:], 4: canonical.Map{}, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	artifactObjectID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 2, artifactObjectBytes)
	if err != nil {
		t.Fatal(err)
	}
	descriptorBody := canonical.Map{
		0: uint64(1), 1: bundleID[:], 2: int64(1234), 3: "https://example.test/a", 4: "https://example.test/b",
		5: "awsm.capture.web-page-snapshot", 6: "awsm.adapter.browser-web-page", 7: uint64(1), 8: "Example",
		9: []canonical.Value{canonical.Map{0: artifactObjectID[:], 1: "awsm.artifact.primary"}}, 10: []canonical.Value{}, 11: canonical.Map{0: uint64(1), 1: []byte{1}},
	}
	descriptorBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(1), 3: prepared.RequiredFeatureSetID[:], 4: descriptorBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	descriptorID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 1, descriptorBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitObject(artifactObjectID, artifactObjectBytes); err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitObject(descriptorID, descriptorBytes); err != nil {
		t.Fatal(err)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 3,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 1234, Body: canonical.Map{0: bundleID[:], 1: descriptorID[:], 2: collectionID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	items, err := ProjectLibrary(replica)
	if err != nil {
		t.Fatalf("ProjectLibrary: %v", err)
	}
	if len(items) != 1 || items[0].BundleID != hexIdentifier(bundleID) || items[0].CollectionID != hexIdentifier(collectionID) || items[0].ArtifactID != hexIdentifier(artifactObjectID) || !items[0].AvailableLocally || items[0].Title == nil || *items[0].Title != "Example" {
		t.Fatalf("Library items = %#v", items)
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
	return signReplicaChildWithCredential(t, prepared, parent, eventType, prepared.IDs.ClientCredentialID)
}

func signReplicaChildWithCredential(t *testing.T, prepared PreparedCanonicalVaultCreation, parent canonical.Identifier, eventType uint64, credential canonical.Identifier) canonical.Event {
	t.Helper()
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{parent}, AuthorityParentIDs: []canonical.Identifier{parent},
		Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: eventType,
		SignerCredentialID: credential, AssertedAt: 124 + int64(eventType),
		Body: canonical.Map{0: uint64(eventType)},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign child: %v", err)
	}
	return event
}
