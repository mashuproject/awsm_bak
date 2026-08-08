package vault

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"math/rand"
	"sort"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
)

func TestReplicaContentReplayConvergesAcrossDeterministicRandomizedInsertionOrders(t *testing.T) {
	prepared := deterministicCreation(t)
	collectionIDs := [][32]byte{filledCreationID(201), filledCreationID(202), filledCreationID(203)}
	children := make([]canonical.Event, 0, len(collectionIDs))
	parents := []canonical.Identifier{prepared.Genesis.RecordID}
	for index, collectionID := range collectionIDs {
		if index == 2 {
			parents = []canonical.Identifier{children[0].RecordID, children[1].RecordID}
		}
		event, err := canonical.SignEvent(canonical.EventInput{
			VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
			ParentRecordIDs: append([]canonical.Identifier(nil), parents...), AuthorityParentIDs: append([]canonical.Identifier(nil), parents...),
			RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 7,
			SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: int64(300 + index),
			Body: canonical.Map{0: collectionID[:], 1: "Collection"},
		}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
		if err != nil {
			t.Fatalf("sign Collection event %d: %v", index, err)
		}
		children = append(children, event)
	}

	baseline := func() *Replica {
		replica, err := NewReplica(prepared.Baseline)
		if err != nil {
			t.Fatalf("NewReplica: %v", err)
		}
		if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
			t.Fatalf("Admit Genesis: %v", err)
		}
		return replica
	}
	first := baseline()
	for _, event := range children {
		if err := first.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
			t.Fatalf("Admit ordered event: %v", err)
		}
	}
	wantProjection, err := ProjectLibraryProjection(first)
	if err != nil {
		t.Fatalf("Project ordered Replica: %v", err)
	}
	wantJSON, err := json.Marshal(wantProjection)
	if err != nil {
		t.Fatalf("marshal ordered projection: %v", err)
	}

	random := rand.New(rand.NewSource(42))
	for attempt := 0; attempt < 24; attempt++ {
		siblings := random.Perm(2)
		order := []int{siblings[0], siblings[1], 2}
		candidate := baseline()
		for _, index := range order {
			if err := candidate.AdmitEvent(children[index], ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
				t.Fatalf("attempt %d admit event %d: %v", attempt, index, err)
			}
		}
		gotProjection, err := ProjectLibraryProjection(candidate)
		if err != nil {
			t.Fatalf("attempt %d project Replica: %v", attempt, err)
		}
		gotJSON, err := json.Marshal(gotProjection)
		if err != nil {
			t.Fatalf("attempt %d marshal projection: %v", attempt, err)
		}
		if !bytes.Equal(gotJSON, wantJSON) {
			t.Fatalf("attempt %d projection changed with insertion order %v", attempt, order)
		}
		if got, want := candidate.State().CausalFrontier, first.State().CausalFrontier; !sameIdentifierSlice(got, want) {
			t.Fatalf("attempt %d causal frontier = %#v, want %#v", attempt, got, want)
		}
	}
}

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

func TestReplicaExposesDerivedAuthorityState(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	state, err := replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState: %v", err)
	}
	if state.Lifecycle != "Open" || len(state.ActiveMemberIDs) != 1 || state.ActiveMemberIDs[0] != prepared.IDs.FirstMemberID ||
		len(state.AdministratorIDs) != 1 || state.AdministratorIDs[0] != prepared.IDs.FirstMemberID ||
		len(state.ActiveClientCredentialIDs) != 1 || state.ActiveClientCredentialIDs[0] != prepared.IDs.ClientCredentialID ||
		len(state.EffectiveRecoveryCredentialIDs) != 1 || state.EffectiveRecoveryCredentialIDs[0] != prepared.IDs.RecoveryCredentialID ||
		len(state.CurrentKeyEpochIDs) != 1 || state.CurrentKeyEpochIDs[0] != prepared.KeyEpochID {
		t.Fatalf("derived Authority State = %#v", state)
	}
}

func TestReplicaRejectsKeyDeliveryForUnknownKeyEpoch(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	envelopeID := filledCreationID(220)
	unknownEpochID := filledCreationID(221)
	slot := canonical.Map{0: unknownEpochID[:], 1: uint64(1), 2: prepared.IDs.RecoveryCredentialID[:], 3: uint64(0), 4: envelopeID[:]}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: []canonical.Dependency{{Type: 7, ID: envelopeID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 13, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 203, Body: canonical.Map{0: []canonical.Value{slot}},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Key Delivery: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted Key Delivery for an unknown Key Epoch")
	}
}

func TestReplicaRejectsDuplicateKeyDeliveryForExistingTargetEpoch(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	envelopeID := filledCreationID(222)
	slot := canonical.Map{0: prepared.KeyEpochID[:], 1: uint64(1), 2: prepared.IDs.RecoveryCredentialID[:], 3: uint64(0), 4: envelopeID[:]}
	first, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: []canonical.Dependency{{Type: 7, ID: envelopeID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 13, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 212, Body: canonical.Map{0: []canonical.Value{slot}},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign first Key Delivery: %v", err)
	}
	if err := replica.AdmitEvent(first, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit first Key Delivery: %v", err)
	}
	second, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{first.RecordID}, AuthorityParentIDs: []canonical.Identifier{first.RecordID},
		Dependencies: []canonical.Dependency{{Type: 7, ID: envelopeID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 13, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 213, Body: canonical.Map{0: []canonical.Value{slot}},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign duplicate Key Delivery: %v", err)
	}
	if err := replica.AdmitEvent(second, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted duplicate Key Delivery for an existing target and Key Epoch")
	}
}

func TestReplicaRejectsFeatureActivationWithMismatchedPreviousSet(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	manifestBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{
		FeatureKey: "awsm.test.feature", Revision: 1, Parameters: []byte{1}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	})
	if err != nil {
		t.Fatalf("encode Feature Manifest: %v", err)
	}
	manifest, err := canonical.DecodeFeatureManifest(manifestBytes)
	if err != nil {
		t.Fatalf("decode Feature Manifest: %v", err)
	}
	wrongPrevious := filledCreationID(230)
	resulting := filledCreationID(231)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: []canonical.Dependency{{Type: 8, ID: manifest.ID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 14, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 214, Body: canonical.Map{0: wrongPrevious[:], 1: []canonical.Value{manifestBytes}, 2: resulting[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Feature Activation: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted Feature Activation with a mismatched previous Required Feature Set")
	}
}

func TestReplicaAdvancesFeatureSetAfterAuthenticatedActivation(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	manifestBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{
		FeatureKey: "awsm.test.feature", Revision: 1, Parameters: []byte{1}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	})
	if err != nil {
		t.Fatalf("encode Feature Manifest: %v", err)
	}
	manifest, err := canonical.DecodeFeatureManifest(manifestBytes)
	if err != nil {
		t.Fatalf("decode Feature Manifest: %v", err)
	}
	resulting, err := canonical.RequiredFeatureSetID([]canonical.FeatureManifestInput{manifest.FeatureManifestInput})
	if err != nil {
		t.Fatalf("derive resulting Feature Set: %v", err)
	}
	activation, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: []canonical.Dependency{{Type: 8, ID: manifest.ID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 14, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 215, Body: canonical.Map{0: prepared.RequiredFeatureSetID[:], 1: []canonical.Value{manifestBytes}, 2: resulting[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Feature Activation: %v", err)
	}
	if err := replica.AdmitEvent(activation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Feature Activation: %v", err)
	}
	child, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{activation.RecordID}, AuthorityParentIDs: []canonical.Identifier{activation.RecordID},
		RequiredFeatureSetID: resulting, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 21,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 216, Body: canonical.Map{0: canonicalSetValues([]canonical.Value{prepared.Genesis.RecordID[:]})},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign post-activation Event: %v", err)
	}
	if err := replica.AdmitEvent(child, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit post-activation Event: %v", err)
	}
	wrongChild, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{activation.RecordID}, AuthorityParentIDs: []canonical.Identifier{activation.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 22,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 217, Body: canonical.Map{0: prepared.Genesis.RecordID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign stale-feature Event: %v", err)
	}
	if err := replica.AdmitEvent(wrongChild, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted an Event with a stale Required Feature Set")
	}
}

func TestReplicaAdmitsObjectBoundToAuthenticatedFeatureSet(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{
		FeatureKey: "awsm.object.feature", Revision: 1, Parameters: []byte{2}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := canonical.DecodeFeatureManifest(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	resulting, err := canonical.RequiredFeatureSetID([]canonical.FeatureManifestInput{manifest.FeatureManifestInput})
	if err != nil {
		t.Fatal(err)
	}
	activation, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: []canonical.Dependency{{Type: 8, ID: manifest.ID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 14, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: 218, Body: canonical.Map{0: prepared.RequiredFeatureSetID[:], 1: []canonical.Value{manifestBytes}, 2: resulting[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(activation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	objectBytes := validTestArtifactObjectBytes(t, prepared.IDs.VaultID, resulting, "post activation object")
	objectID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 2, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitObject(objectID, objectBytes); err != nil {
		t.Fatalf("AdmitObject rejected an authenticated Feature Set: %v", err)
	}
}

func TestReplicaSurfacesConcurrentRecoveryReplacementConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	firstID := filledCreationID(232)
	secondID := filledCreationID(233)
	first := signRecoveryReplacementFixture(t, prepared, firstID, bytes.Repeat([]byte{0x81}, 16), 1, 218)
	second := signRecoveryReplacementFixture(t, prepared, secondID, bytes.Repeat([]byte{0x82}, 16), 1, 219)
	if err := replica.AdmitEvent(first, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit first Recovery Replacement: %v", err)
	}
	if err := replica.AdmitEvent(second, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit concurrent Recovery Replacement: %v", err)
	}
	state, err := replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState: %v", err)
	}
	if len(state.RecoveryConflicts) != 1 || state.RecoveryConflicts[0].MemberID != prepared.IDs.FirstMemberID {
		t.Fatalf("AuthorityState RecoveryConflicts = %#v", state.RecoveryConflicts)
	}
	if len(state.RecoveryConflicts[0].Candidates) != 2 {
		t.Fatalf("Recovery conflict candidates = %#v", state.RecoveryConflicts[0].Candidates)
	}
	resolutionID := filledCreationID(234)
	resolutionParents := []canonical.Identifier{first.RecordID, second.RecordID}
	sort.Slice(resolutionParents, func(left, right int) bool {
		return bytes.Compare(resolutionParents[left][:], resolutionParents[right][:]) < 0
	})
	resolution := signRecoveryReplacementFixtureWithParents(t, prepared, resolutionParents, []canonical.Identifier{firstID, secondID}, resolutionID, bytes.Repeat([]byte{0x83}, 16), 2, 220)
	if err := replica.AdmitEvent(resolution, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Recovery Conflict resolution: %v", err)
	}
	state, err = replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState after Recovery Conflict resolution: %v", err)
	}
	if len(state.RecoveryConflicts) != 0 || len(state.EffectiveRecoveryCredentialIDs) != 1 || state.EffectiveRecoveryCredentialIDs[0] != resolutionID {
		t.Fatalf("AuthorityState after Recovery Conflict resolution = %#v", state)
	}
}

func TestReplicaSurfacesAndResolvesConcurrentKeyEpochConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	firstKey := bytes.Repeat([]byte{0xa1}, 32)
	secondKey := bytes.Repeat([]byte{0xa2}, 32)
	first := signKeyEpochTransitionFixture(t, prepared, []canonical.Identifier{prepared.Genesis.RecordID}, []canonical.Identifier{prepared.KeyEpochID}, firstKey, 1, 221)
	second := signKeyEpochTransitionFixture(t, prepared, []canonical.Identifier{prepared.Genesis.RecordID}, []canonical.Identifier{prepared.KeyEpochID}, secondKey, 1, 222)
	if err := replica.AdmitEvent(first, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit first Key Epoch Transition: %v", err)
	}
	if err := replica.AdmitEvent(second, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit concurrent Key Epoch Transition: %v", err)
	}
	state, err := replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState: %v", err)
	}
	if len(state.KeyEpochConflicts) != 1 || len(state.KeyEpochConflicts[0].Candidates) != 2 {
		t.Fatalf("AuthorityState KeyEpochConflicts = %#v", state.KeyEpochConflicts)
	}
	firstTransition, err := parseKeyEpochTransition(first)
	if err != nil {
		t.Fatal(err)
	}
	secondTransition, err := parseKeyEpochTransition(second)
	if err != nil {
		t.Fatal(err)
	}
	resolutionKey := bytes.Repeat([]byte{0xa3}, 32)
	parents := []canonical.Identifier{first.RecordID, second.RecordID}
	sort.Slice(parents, func(left, right int) bool { return bytes.Compare(parents[left][:], parents[right][:]) < 0 })
	resolution := signKeyEpochTransitionFixture(t, prepared, parents, []canonical.Identifier{firstTransition.newEpochID, secondTransition.newEpochID}, resolutionKey, 2, 223)
	if err := replica.AdmitEvent(resolution, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Key Epoch Conflict resolution: %v", err)
	}
	state, err = replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState after Key Epoch Conflict resolution: %v", err)
	}
	resolvedTransition, err := parseKeyEpochTransition(resolution)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.KeyEpochConflicts) != 0 || len(state.CurrentKeyEpochIDs) != 1 || state.CurrentKeyEpochIDs[0] != resolvedTransition.newEpochID {
		t.Fatalf("AuthorityState after Key Epoch Conflict resolution = %#v", state)
	}
}

func TestReplicaSurfacesAndResolvesAdministratorConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	capabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}
	creation, acceptance, _ := signInvitationAcceptanceFixture(t, prepared, capabilities, capabilities)
	if err := replica.AdmitEvent(creation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Creation: %v", err)
	}
	if err := replica.AdmitEvent(acceptance, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Acceptance: %v", err)
	}
	accepted, err := parseInvitationAcceptance(acceptance)
	if err != nil {
		t.Fatal(err)
	}
	grantOne := signAdministratorRoleFixture(t, prepared, acceptance.RecordID, accepted.memberID, 3, nil, 224)
	grantTwo := signAdministratorRoleFixture(t, prepared, acceptance.RecordID, accepted.memberID, 3, nil, 225)
	if err := replica.AdmitEvent(grantOne, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit first Administrator Grant: %v", err)
	}
	if err := replica.AdmitEvent(grantTwo, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit concurrent Administrator Grant: %v", err)
	}
	end := signAdministratorRoleFixture(t, prepared, grantOne.RecordID, accepted.memberID, 4, nil, 226)
	if err := replica.AdmitEvent(end, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Administrator End branch: %v", err)
	}
	state, err := replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState: %v", err)
	}
	if len(state.AdministratorConflicts) != 1 || state.AdministratorConflicts[0].MemberID != accepted.memberID || len(state.AdministratorConflicts[0].Candidates) != 2 {
		t.Fatalf("AuthorityState AdministratorConflicts = %#v", state.AdministratorConflicts)
	}
	parents := []canonical.Identifier{end.RecordID, grantTwo.RecordID}
	sort.Slice(parents, func(left, right int) bool { return bytes.Compare(parents[left][:], parents[right][:]) < 0 })
	resolution := signAdministratorRoleFixtureWithParents(t, prepared, parents, accepted.memberID, 4, []canonical.Identifier{end.RecordID, grantTwo.RecordID}, 227)
	if err := replica.AdmitEvent(resolution, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Administrator Conflict resolution: %v", err)
	}
	state, err = replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState after Administrator Conflict resolution: %v", err)
	}
	if len(state.AdministratorConflicts) != 0 {
		t.Fatalf("Administrator conflict remained after resolution: %#v", state.AdministratorConflicts)
	}
}

func TestReplicaSurfacesConcurrentFeatureSetConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	leftBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{FeatureKey: "awsm.conflict", Revision: 1, Parameters: []byte{1}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	rightBytes, err := canonical.EncodeFeatureManifest(canonical.FeatureManifestInput{FeatureKey: "awsm.conflict", Revision: 2, Parameters: []byte{2}, RequiredManifestIDs: []canonical.Identifier{}, IncompatibleKeys: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	left, err := canonical.DecodeFeatureManifest(leftBytes)
	if err != nil {
		t.Fatal(err)
	}
	right, err := canonical.DecodeFeatureManifest(rightBytes)
	if err != nil {
		t.Fatal(err)
	}
	leftSet, err := canonical.RequiredFeatureSetID([]canonical.FeatureManifestInput{left.FeatureManifestInput})
	if err != nil {
		t.Fatal(err)
	}
	rightSet, err := canonical.RequiredFeatureSetID([]canonical.FeatureManifestInput{right.FeatureManifestInput})
	if err != nil {
		t.Fatal(err)
	}
	signActivation := func(manifest []byte, manifestID, resulting [32]byte, assertedAt int64) canonical.Event {
		event, signErr := canonical.SignEvent(canonical.EventInput{
			VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
			ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
			Dependencies: []canonical.Dependency{{Type: 8, ID: manifestID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
			Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 14, SignerCredentialID: prepared.IDs.ClientCredentialID,
			AssertedAt: assertedAt, Body: canonical.Map{0: prepared.RequiredFeatureSetID[:], 1: []canonical.Value{manifest}, 2: resulting[:]},
		}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
		if signErr != nil {
			t.Fatalf("sign Feature Activation: %v", signErr)
		}
		return event
	}
	leftEvent := signActivation(leftBytes, left.ID, leftSet, 228)
	rightEvent := signActivation(rightBytes, right.ID, rightSet, 229)
	if err := replica.AdmitEvent(leftEvent, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit left Feature Activation: %v", err)
	}
	if err := replica.AdmitEvent(rightEvent, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit right Feature Activation: %v", err)
	}
	state, err := replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState: %v", err)
	}
	if state.FeatureSetConflict == nil || len(state.FeatureSetConflict.CandidateRecordIDs) != 2 || len(state.FeatureSetConflict.ManifestIDs) != 2 {
		t.Fatalf("AuthorityState FeatureSetConflict = %#v", state.FeatureSetConflict)
	}
}

func TestReplicaRejectsInvitationWithMismatchedCapabilityIssuer(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	invitationID := filledCreationID(230)
	otherMemberID := filledCreationID(231)
	capability := canonical.Map{0: "awsm.vault", 1: otherMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{}}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 5,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 204,
		Body: canonical.Map{0: invitationID[:], 1: []canonical.Value{capability}, 2: bytes.Repeat([]byte{0x31}, 32), 3: bytes.Repeat([]byte{0x32}, 32), 4: bytes.Repeat([]byte{0x33}, 32), 5: bytes.Repeat([]byte{0x34}, 32)},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Invitation Creation: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted an Invitation whose capability issuer differs from the signer")
	}
}

func TestReplicaRejectsMalformedInvitationAcceptance(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 6,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 205, Body: canonical.Map{},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign malformed Invitation Acceptance: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted a malformed Invitation Acceptance")
	}
}

func TestReplicaRejectsInvitationAcceptanceForUnknownInvitation(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	invitationID := filledCreationID(240)
	memberID := filledCreationID(241)
	clientID := filledCreationID(242)
	recoveryID := filledCreationID(243)
	clientEnvelopeID := filledCreationID(244)
	recoveryEnvelopeID := filledCreationID(245)
	joinRequestID := filledCreationID(247)
	proposalID := filledCreationID(248)
	acceptanceReceiptID := filledCreationID(249)
	clientSeed := bytes.Repeat([]byte{0x61}, ed25519.SeedSize)
	recoverySeed := bytes.Repeat([]byte{0x62}, ed25519.SeedSize)
	clientKey := ed25519.NewKeyFromSeed(clientSeed)
	recoveryKey := ed25519.NewKeyFromSeed(recoverySeed)
	capability := canonical.Map{0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{}}
	clientCertificate := canonical.Map{0: clientID[:], 1: memberID[:], 2: []byte(clientKey.Public().(ed25519.PublicKey)), 3: bytes.Repeat([]byte{0x63}, 32)}
	recoveryDescriptor := canonical.Map{0: recoveryID[:], 1: memberID[:], 2: uint64(0), 3: []byte(recoveryKey.Public().(ed25519.PublicKey)), 4: bytes.Repeat([]byte{0x64}, 32)}
	recoverySlot := canonical.Map{0: prepared.KeyEpochID[:], 1: uint64(1), 2: recoveryID[:], 3: uint64(0), 4: recoveryEnvelopeID[:]}
	clientSlot := canonical.Map{0: prepared.KeyEpochID[:], 1: uint64(2), 2: clientID[:], 3: nil, 4: clientEnvelopeID[:]}
	join := canonical.Map{0: invitationID[:], 1: canonicalSetValues([]canonical.Value{capability}), 2: memberID[:], 3: clientCertificate, 4: recoveryDescriptor,
		5: bytes.Repeat([]byte{0x65}, ed25519.SignatureSize), 6: bytes.Repeat([]byte{0x66}, ed25519.SignatureSize), 7: bytes.Repeat([]byte{0x67}, ed25519.SignatureSize)}
	proposal := canonical.Map{0: invitationID[:], 1: joinRequestID[:], 2: canonicalSetValues([]canonical.Value{prepared.Genesis.RecordID[:]}), 3: memberID[:], 4: clientCertificate, 5: recoveryDescriptor,
		6: canonicalSetValues([]canonical.Value{capability}), 7: canonicalSetValues([]canonical.Value{recoverySlot, clientSlot})}
	receipt := canonical.Map{0: invitationID[:], 1: uint64(1), 2: joinRequestID[:], 3: proposalID[:], 4: acceptanceReceiptID[:], 5: bytes.Repeat([]byte{0x68}, ed25519.SignatureSize)}
	dependencies := []canonical.Dependency{{Type: 7, ID: recoveryEnvelopeID}, {Type: 7, ID: clientEnvelopeID}}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		Dependencies: dependencies, RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 6,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 206, Body: canonical.Map{0: join, 1: proposal, 2: receipt},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Invitation Acceptance: %v", err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted Invitation Acceptance for an unknown Invitation")
	}
}

func TestReplicaRejectsInvitationAcceptanceWithMismatchedCapabilities(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	invitationCapabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}
	acceptedCapabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{1},
	}}
	creation, acceptance, clientPublicKey := signInvitationAcceptanceFixture(t, prepared, invitationCapabilities, acceptedCapabilities)
	if err := replica.AdmitEvent(creation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Creation: %v", err)
	}
	if err := replica.AdmitEvent(acceptance, clientPublicKey); err == nil {
		t.Fatal("Replica accepted Invitation Acceptance with capabilities different from its Creation")
	}
}

func TestReplicaAdmitsAuthenticatedInvitationAcceptanceAndActivatesClient(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	capabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}
	creation, acceptance, _ := signInvitationAcceptanceFixture(t, prepared, capabilities, capabilities)
	if err := replica.AdmitEvent(creation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Creation: %v", err)
	}
	state, err := replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState after Invitation Creation: %v", err)
	}
	invitationID, err := parseInvitationCreationID(creation)
	if err != nil {
		t.Fatalf("parse Invitation ID: %v", err)
	}
	if len(state.ActiveInvitationIDs) != 1 || state.ActiveInvitationIDs[0] != invitationID {
		t.Fatalf("AuthorityState active Invitations = %#v, want the created Invitation", state.ActiveInvitationIDs)
	}
	if err := replica.AdmitEvent(acceptance, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Acceptance: %v", err)
	}
	state, err = replica.AuthorityState()
	if err != nil {
		t.Fatalf("AuthorityState: %v", err)
	}
	accepted, err := parseInvitationAcceptance(acceptance)
	if err != nil {
		t.Fatalf("parse accepted Invitation: %v", err)
	}
	if len(state.ActiveMemberIDs) != 2 || len(state.ActiveClientCredentialIDs) != 2 || len(state.EffectiveRecoveryCredentialIDs) != 2 {
		t.Fatalf("AuthorityState after Invitation Acceptance = %#v", state)
	}
	assignmentID := filledCreationID(239)
	tagID := filledCreationID(240)
	targetCollectionID := filledCreationID(241)
	child, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{acceptance.RecordID}, AuthorityParentIDs: []canonical.Identifier{acceptance.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 20,
		SignerCredentialID: accepted.clientCredentialID, AssertedAt: 209,
		Body: canonical.Map{0: assignmentID[:], 1: tagID[:], 2: canonical.Map{0: uint64(1), 1: targetCollectionID[:]}},
	}, ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x74}, ed25519.SeedSize)))
	if err != nil {
		t.Fatalf("sign post-acceptance Content Event: %v", err)
	}
	if err := replica.AdmitKnownEvent(child); err != nil {
		t.Fatalf("AdmitKnownEvent from accepted Client Credential: %v", err)
	}
}

func TestReplicaAdmitsAuthenticatedInvitationCancellationAndConsumesInvitation(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	capabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}
	creation, _, _ := signInvitationAcceptanceFixture(t, prepared, capabilities, capabilities)
	if err := replica.AdmitEvent(creation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Creation: %v", err)
	}
	cancellation := signInvitationCancellationFixture(t, prepared, creation)
	if err := replica.AdmitEvent(cancellation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Cancellation: %v", err)
	}
	state, err := replayAuthenticatedKeyEpochs(replica.Events(), prepared.Genesis, nil)
	if err != nil {
		t.Fatalf("replay Invitation Cancellation: %v", err)
	}
	if len(state.invitations) != 0 || len(state.invitationTerminals) != 1 {
		t.Fatalf("Authority state after Invitation Cancellation = active %#v terminals %#v", state.invitations, state.invitationTerminals)
	}
}

func TestReplicaRejectsInvitationCancellationForUnknownInvitation(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	unknownCreation, _, _ := signInvitationAcceptanceFixture(t, prepared, []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}, []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}})
	cancellation := signInvitationCancellationFixture(t, prepared, unknownCreation)
	if err := replica.AdmitEvent(cancellation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted Invitation Cancellation for an unknown Invitation")
	}
}

func TestReplicaSurfacesConcurrentInvitationAcceptanceAndCancellationConflict(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	capabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}
	creation, acceptance, _ := signInvitationAcceptanceFixture(t, prepared, capabilities, capabilities)
	if err := replica.AdmitEvent(creation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Creation: %v", err)
	}
	if err := replica.AdmitEvent(acceptance, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Acceptance: %v", err)
	}
	cancellation := signInvitationCancellationFixture(t, prepared, creation)
	if err := replica.AdmitEvent(cancellation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit concurrent Invitation Cancellation: %v", err)
	}
	state, err := replayAuthenticatedKeyEpochs(replica.Events(), prepared.Genesis, nil)
	if err != nil {
		t.Fatalf("replay concurrent Invitation terminal facts: %v", err)
	}
	if _, conflict := state.invitationConflicts[filledCreationID(250)]; !conflict {
		t.Fatalf("Authority state did not surface Invitation conflict: %#v", state.invitationConflicts)
	}
	if len(state.activeMembers) != 1 || len(state.clientTargets) != 1 || len(state.recoveryTargets) != 1 {
		t.Fatalf("conflicted Invitation activated authority: members %#v clients %#v recovery %#v", state.activeMembers, state.clientTargets, state.recoveryTargets)
	}
}

func TestReplicaResolvesConcurrentInvitationConflictByCancellingAll(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Genesis: %v", err)
	}
	capabilities := []canonical.Value{canonical.Map{
		0: "awsm.vault", 1: prepared.IDs.FirstMemberID[:], 2: prepared.IDs.VaultID[:], 3: "awsm.vault.join", 4: []byte{},
	}}
	creation, acceptance, _ := signInvitationAcceptanceFixture(t, prepared, capabilities, capabilities)
	if err := replica.AdmitEvent(creation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Creation: %v", err)
	}
	if err := replica.AdmitEvent(acceptance, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Acceptance: %v", err)
	}
	cancellation := signInvitationCancellationFixture(t, prepared, creation)
	if err := replica.AdmitEvent(cancellation, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit concurrent Invitation Cancellation: %v", err)
	}
	accepted, err := parseInvitationAcceptance(acceptance)
	if err != nil {
		t.Fatalf("parse Invitation Acceptance: %v", err)
	}
	cancelled, err := parseInvitationCancellation(cancellation)
	if err != nil {
		t.Fatalf("parse Invitation Cancellation: %v", err)
	}
	recordIDs := canonicalSetValues([]canonical.Value{acceptance.RecordID[:], cancellation.RecordID[:]})
	receiptIDs := canonicalSetValues([]canonical.Value{accepted.receiptID[:], cancelled.receiptID[:]})
	invitationID := filledCreationID(250)
	parents := []canonical.Identifier{acceptance.RecordID, cancellation.RecordID}
	sort.Slice(parents, func(left, right int) bool { return bytes.Compare(parents[left][:], parents[right][:]) < 0 })
	resolution, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: parents, AuthorityParentIDs: parents,
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 8,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 211,
		Body: canonical.Map{0: invitationID[:], 1: receiptIDs, 2: recordIDs, 3: uint64(2), 4: nil},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Invitation Conflict Resolution: %v", err)
	}
	if err := replica.AdmitEvent(resolution, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Invitation Conflict Resolution: %v", err)
	}
	state, err := replayAuthenticatedKeyEpochs(replica.Events(), prepared.Genesis, nil)
	if err != nil {
		t.Fatalf("replay Invitation Conflict Resolution: %v", err)
	}
	if _, conflict := state.invitationConflicts[filledCreationID(250)]; conflict || len(state.activeMembers) != 1 {
		t.Fatalf("Invitation Conflict Resolution did not cancel all candidates: conflicts %#v members %#v", state.invitationConflicts, state.activeMembers)
	}
}

func signInvitationAcceptanceFixture(t *testing.T, prepared PreparedCanonicalVaultCreation, invitationCapabilities, acceptedCapabilities []canonical.Value) (canonical.Event, canonical.Event, ed25519.PublicKey) {
	t.Helper()
	invitationID := filledCreationID(250)
	memberID := filledCreationID(251)
	clientID := filledCreationID(252)
	recoveryID := filledCreationID(253)
	clientEnvelopeID := filledCreationID(254)
	recoveryEnvelopeID := filledCreationID(255)
	redemptionKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x71}, ed25519.SeedSize))
	cancellationKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x72}, ed25519.SeedSize))
	receiptKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x73}, ed25519.SeedSize))
	clientKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x74}, ed25519.SeedSize))
	recoveryKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x75}, ed25519.SeedSize))
	clientCertificate := canonical.Map{
		0: clientID[:], 1: memberID[:], 2: []byte(clientKey.Public().(ed25519.PublicKey)), 3: bytes.Repeat([]byte{0x76}, 32),
	}
	recoveryDescriptor := canonical.Map{
		0: recoveryID[:], 1: memberID[:], 2: uint64(0), 3: []byte(recoveryKey.Public().(ed25519.PublicKey)), 4: bytes.Repeat([]byte{0x77}, 32),
	}
	creation, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 5,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 207,
		Body: canonical.Map{0: invitationID[:], 1: canonicalSetValues(invitationCapabilities), 2: []byte(redemptionKey.Public().(ed25519.PublicKey)), 3: []byte(cancellationKey.Public().(ed25519.PublicKey)), 4: bytes.Repeat([]byte{0x78}, 32), 5: []byte(receiptKey.Public().(ed25519.PublicKey))},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Invitation Creation: %v", err)
	}
	joinPrefix := canonical.Map{0: invitationID[:], 1: canonicalSetValues(acceptedCapabilities), 2: memberID[:], 3: clientCertificate, 4: recoveryDescriptor}
	joinPrefixBytes, err := canonical.EncodeValue(joinPrefix)
	if err != nil {
		t.Fatalf("encode Invitation Join Request prefix: %v", err)
	}
	joinTranscript, err := canonical.Transcript("awsm:invitation-join-request:v1", joinPrefixBytes)
	if err != nil {
		t.Fatalf("Invitation Join Request transcript: %v", err)
	}
	join := canonical.Map{
		0: invitationID[:], 1: canonicalSetValues(acceptedCapabilities), 2: memberID[:], 3: clientCertificate, 4: recoveryDescriptor,
		5: ed25519.Sign(clientKey, joinTranscript), 6: ed25519.Sign(recoveryKey, joinTranscript), 7: ed25519.Sign(redemptionKey, joinTranscript),
	}
	joinBytes, err := canonical.EncodeValue(join)
	if err != nil {
		t.Fatalf("encode Invitation Join Request: %v", err)
	}
	joinIDTranscript, err := canonical.Transcript("awsm:invitation-join-request-id:v1", joinBytes)
	if err != nil {
		t.Fatalf("Invitation Join Request ID transcript: %v", err)
	}
	joinRequestID := sha256.Sum256(joinIDTranscript)
	recoverySlot := canonical.Map{0: prepared.KeyEpochID[:], 1: uint64(1), 2: recoveryID[:], 3: uint64(0), 4: recoveryEnvelopeID[:]}
	clientSlot := canonical.Map{0: prepared.KeyEpochID[:], 1: uint64(2), 2: clientID[:], 3: nil, 4: clientEnvelopeID[:]}
	proposal := canonical.Map{
		0: invitationID[:], 1: joinRequestID[:], 2: canonicalSetValues([]canonical.Value{creation.RecordID[:]}), 3: memberID[:],
		4: clientCertificate, 5: recoveryDescriptor, 6: canonicalSetValues(acceptedCapabilities), 7: canonicalSetValues([]canonical.Value{recoverySlot, clientSlot}),
	}
	proposalBytes, err := canonical.EncodeValue(proposal)
	if err != nil {
		t.Fatalf("encode Invitation Acceptance Proposal: %v", err)
	}
	proposalIDTranscript, err := canonical.Transcript("awsm:invitation-acceptance-proposal-id:v1", proposalBytes)
	if err != nil {
		t.Fatalf("Invitation Acceptance Proposal ID transcript: %v", err)
	}
	proposalID := sha256.Sum256(proposalIDTranscript)
	receiptID := filledCreationID(246)
	receipt := canonical.Map{0: invitationID[:], 1: uint64(1), 2: joinRequestID[:], 3: proposalID[:], 4: receiptID[:], 5: nil}
	receiptPrefix := canonical.Map{0: receipt[0], 1: receipt[1], 2: receipt[2], 3: receipt[3], 4: receipt[4]}
	receiptPrefixBytes, err := canonical.EncodeValue(receiptPrefix)
	if err != nil {
		t.Fatalf("encode Invitation receipt prefix: %v", err)
	}
	receiptTranscript, err := canonical.Transcript("awsm:invitation-receipt:v1", receiptPrefixBytes)
	if err != nil {
		t.Fatalf("Invitation receipt transcript: %v", err)
	}
	receipt[5] = ed25519.Sign(receiptKey, receiptTranscript)
	dependencies := []canonical.Dependency{{Type: 7, ID: recoveryEnvelopeID}, {Type: 7, ID: clientEnvelopeID}}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	acceptance, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{creation.RecordID}, AuthorityParentIDs: []canonical.Identifier{creation.RecordID}, Dependencies: dependencies,
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 6,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 208, Body: canonical.Map{0: join, 1: proposal, 2: receipt},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Invitation Acceptance: %v", err)
	}
	return creation, acceptance, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)
}

func signInvitationCancellationFixture(t *testing.T, prepared PreparedCanonicalVaultCreation, creation canonical.Event) canonical.Event {
	t.Helper()
	invitationID, err := parseInvitationCreationID(creation)
	if err != nil {
		t.Fatalf("parse Invitation ID: %v", err)
	}
	challenge := bytes.Repeat([]byte{0x79}, 32)
	cancellationKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x72}, ed25519.SeedSize))
	receiptKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x73}, ed25519.SeedSize))
	cancellationTranscript, err := canonical.Transcript("awsm:invitation-cancel-request:v1", invitationID[:], challenge)
	if err != nil {
		t.Fatalf("Invitation Cancellation transcript: %v", err)
	}
	request := canonical.Map{0: invitationID[:], 1: challenge, 2: ed25519.Sign(cancellationKey, cancellationTranscript)}
	requestBytes, err := canonical.EncodeValue(request)
	if err != nil {
		t.Fatalf("encode Invitation Cancellation Request: %v", err)
	}
	requestIDTranscript, err := canonical.Transcript("awsm:invitation-cancel-request-id:v1", requestBytes)
	if err != nil {
		t.Fatalf("Invitation Cancellation Request ID transcript: %v", err)
	}
	requestID := sha256.Sum256(requestIDTranscript)
	receiptID := filledCreationID(247)
	receipt := canonical.Map{0: invitationID[:], 1: uint64(2), 2: requestID[:], 3: nil, 4: receiptID[:], 5: nil}
	receiptPrefix := canonical.Map{0: receipt[0], 1: receipt[1], 2: receipt[2], 3: receipt[3], 4: receipt[4]}
	receiptPrefixBytes, err := canonical.EncodeValue(receiptPrefix)
	if err != nil {
		t.Fatalf("encode Invitation Cancellation receipt prefix: %v", err)
	}
	receiptTranscript, err := canonical.Transcript("awsm:invitation-receipt:v1", receiptPrefixBytes)
	if err != nil {
		t.Fatalf("Invitation Cancellation receipt transcript: %v", err)
	}
	receipt[5] = ed25519.Sign(receiptKey, receiptTranscript)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{creation.RecordID}, AuthorityParentIDs: []canonical.Identifier{creation.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 7,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 210, Body: canonical.Map{0: request, 1: receipt},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Invitation Cancellation: %v", err)
	}
	return event
}

func signRecoveryReplacementFixture(t *testing.T, prepared PreparedCanonicalVaultCreation, recoveryID [32]byte, entropy []byte, revision uint64, assertedAt int64) canonical.Event {
	return signRecoveryReplacementFixtureWithParents(t, prepared, []canonical.Identifier{prepared.Genesis.RecordID}, []canonical.Identifier{prepared.IDs.RecoveryCredentialID}, recoveryID, entropy, revision, assertedAt)
}

func signRecoveryReplacementFixtureWithParents(t *testing.T, prepared PreparedCanonicalVaultCreation, parents []canonical.Identifier, replacedIDs []canonical.Identifier, recoveryID [32]byte, entropy []byte, revision uint64, assertedAt int64) canonical.Event {
	t.Helper()
	keys, err := awsmcrypto.DeriveRecoveryCredential(entropy)
	if err != nil {
		t.Fatalf("derive replacement Recovery Credential: %v", err)
	}
	envelope, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
		VaultID: prepared.IDs.VaultID, KeyEpochID: prepared.KeyEpochID, KeyEpochKey: prepared.KeyEpochKey,
		TargetKind: awsmcrypto.RecoveryCredentialTarget, TargetCredentialID: recoveryID, TargetRevision: &revision,
		RecipientWrappingPublicKey: keys.WrappingPublicKey, Padding: bytes.Repeat([]byte{0x91}, 32), EphemeralSeed: bytes.Repeat([]byte{0x92}, 32),
	})
	if err != nil {
		t.Fatalf("seal replacement Recovery Envelope: %v", err)
	}
	descriptor := canonical.Map{0: recoveryID[:], 1: prepared.IDs.FirstMemberID[:], 2: revision, 3: keys.SigningPublicKey, 4: keys.WrappingPublicKey}
	slot := canonical.Map{0: prepared.KeyEpochID[:], 1: uint64(1), 2: recoveryID[:], 3: revision, 4: envelope.ID[:]}
	slots := canonicalSetValues([]canonical.Value{slot})
	descriptorBytes, err := canonical.EncodeValue(descriptor)
	if err != nil {
		t.Fatalf("encode replacement descriptor: %v", err)
	}
	slotsBytes, err := canonical.EncodeValue(slots)
	if err != nil {
		t.Fatalf("encode replacement slots: %v", err)
	}
	parentValues := make([]canonical.Value, 0, len(parents))
	for _, parent := range parents {
		parentValues = append(parentValues, parent[:])
	}
	canonicalParents := canonicalSetValues(parentValues)
	transcript, err := canonical.Transcript("awsm:recovery-replacement-possession:v1", prepared.IDs.VaultID[:], prepared.IDs.FirstMemberID[:], mustCanonical(canonicalParents), descriptorBytes, slotsBytes)
	if err != nil {
		t.Fatalf("replacement possession transcript: %v", err)
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: parents, AuthorityParentIDs: parents,
		Dependencies: []canonical.Dependency{{Type: 7, ID: envelope.ID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 11, SignerCredentialID: prepared.IDs.ClientCredentialID,
		AssertedAt: assertedAt, Body: canonical.Map{0: prepared.IDs.FirstMemberID[:], 1: canonicalSetValues(identifiersToValues(replacedIDs)), 2: descriptor, 3: slots, 4: ed25519.Sign(keys.SigningSecretKey, transcript)},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Recovery Replacement: %v", err)
	}
	return event
}

func signKeyEpochTransitionFixture(t *testing.T, prepared PreparedCanonicalVaultCreation, parents []canonical.Identifier, parentEpochIDs []canonical.Identifier, key []byte, displayNumber uint64, assertedAt int64) canonical.Event {
	t.Helper()
	epochID, err := awsmcrypto.KeyEpochID(prepared.IDs.VaultID, key)
	if err != nil {
		t.Fatalf("derive Key Epoch ID: %v", err)
	}
	recoveryRevision := uint64(0)
	recoveryEnvelope, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
		VaultID: prepared.IDs.VaultID, KeyEpochID: epochID, KeyEpochKey: key, TargetKind: awsmcrypto.RecoveryCredentialTarget,
		TargetCredentialID: prepared.IDs.RecoveryCredentialID, TargetRevision: &recoveryRevision, RecipientWrappingPublicKey: prepared.RecoveryKeys.WrappingPublicKey,
		Padding: bytes.Repeat([]byte{0xa4}, 32), EphemeralSeed: bytes.Repeat([]byte{0xa5}, 32),
	})
	if err != nil {
		t.Fatalf("seal Recovery Key Envelope: %v", err)
	}
	clientEnvelope, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
		VaultID: prepared.IDs.VaultID, KeyEpochID: epochID, KeyEpochKey: key, TargetKind: awsmcrypto.ClientCredentialTarget,
		TargetCredentialID: prepared.IDs.ClientCredentialID, RecipientWrappingPublicKey: prepared.ClientKeys.WrappingPublicKey,
		Padding: bytes.Repeat([]byte{0xa6}, 32), EphemeralSeed: bytes.Repeat([]byte{0xa7}, 32),
	})
	if err != nil {
		t.Fatalf("seal Client Key Envelope: %v", err)
	}
	recoverySlot := canonical.Map{0: epochID[:], 1: uint64(1), 2: prepared.IDs.RecoveryCredentialID[:], 3: uint64(0), 4: recoveryEnvelope.ID[:]}
	clientSlot := canonical.Map{0: epochID[:], 1: uint64(2), 2: prepared.IDs.ClientCredentialID[:], 3: nil, 4: clientEnvelope.ID[:]}
	slots := canonicalSetValues([]canonical.Value{recoverySlot, clientSlot})
	parentValues := make([]canonical.Value, 0, len(parentEpochIDs))
	for _, parentID := range parentEpochIDs {
		parentValues = append(parentValues, parentID[:])
	}
	parentEpochSet := canonicalSetValues(parentValues)
	dependencies := []canonical.Dependency{{Type: 7, ID: recoveryEnvelope.ID}, {Type: 7, ID: clientEnvelope.ID}}
	sort.Slice(dependencies, func(left, right int) bool {
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	returnEvent, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID, ParentRecordIDs: parents, AuthorityParentIDs: parents,
		Dependencies: dependencies, RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: 12,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: assertedAt,
		Body: canonical.Map{0: parentEpochSet, 1: epochID[:], 2: displayNumber, 3: slots},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Key Epoch Transition: %v", err)
	}
	return returnEvent
}

func signAdministratorRoleFixture(t *testing.T, prepared PreparedCanonicalVaultCreation, parent canonical.Identifier, target canonical.Identifier, eventType uint64, resolved []canonical.Identifier, assertedAt int64) canonical.Event {
	t.Helper()
	return signAdministratorRoleFixtureWithParents(t, prepared, []canonical.Identifier{parent}, target, eventType, resolved, assertedAt)
}

func signAdministratorRoleFixtureWithParents(t *testing.T, prepared PreparedCanonicalVaultCreation, parents []canonical.Identifier, target canonical.Identifier, eventType uint64, resolved []canonical.Identifier, assertedAt int64) canonical.Event {
	t.Helper()
	resolvedValues := identifiersToValues(resolved)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID, ParentRecordIDs: parents, AuthorityParentIDs: parents,
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.AuthorityFamily, Type: eventType,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: assertedAt,
		Body: canonical.Map{0: target[:], 1: canonicalSetValues(resolvedValues)},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("sign Administrator role Event: %v", err)
	}
	return event
}

func TestReplicaAdmitsContentAddressedObject(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	contentBody := canonical.Map{0: uint64(1), 1: "Example", 2: "Body", 3: "awsm.note.commonmark"}
	objectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(3), 3: prepared.RequiredFeatureSetID[:],
		4: contentBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	objectID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 3, objectBytes)
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

func TestReplicaRejectsUnsafeNoteContentObject(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	contentBody := canonical.Map{0: uint64(1), 1: "Unsafe", 2: "<script>alert(1)</script>", 3: "awsm.note.commonmark"}
	objectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(3), 3: prepared.RequiredFeatureSetID[:],
		4: contentBody, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	objectID, err := canonical.VaultObjectID(prepared.IDs.VaultID, 3, objectBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitObject(objectID, objectBytes); err == nil {
		t.Fatal("Replica accepted Note Content Object containing HTML")
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
	artifactDigest := awsmcrypto.ArtifactPayloadDigest([]byte("library artifact"))
	artifactObjectBytes, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: prepared.IDs.VaultID[:], 2: uint64(2), 3: prepared.RequiredFeatureSetID[:], 4: canonical.Map{
			0: uint64(1), 1: "awsm.artifact.capture", 2: "application/vnd.awsm.web-page+zip", 3: "awsm.representation.web-page-zip",
			4: uint64(16), 5: artifactDigest[:],
			6: canonical.Map{0: uint64(1), 1: uint64(1_048_576), 2: uint64(16), 3: uint64(16), 4: artifactDigest[:]},
			7: []byte{0xa1, 0x00, 0x01},
		}, 5: map[string][]byte{},
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
		9: []canonical.Value{canonical.Map{0: artifactObjectID[:], 1: "awsm.artifact.primary"}}, 10: []canonical.Value{}, 11: canonical.Map{0: uint64(1), 1: []byte{0xa1, 0x00, 0x01}},
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
		Dependencies: []canonical.Dependency{{Type: 4, ID: descriptorID}}, RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 3,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 1234, Body: canonical.Map{0: bundleID[:], 1: descriptorID[:], 2: collectionID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	titleEvent, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{event.RecordID}, AuthorityParentIDs: []canonical.Identifier{event.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 7,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 1235, Body: canonical.Map{0: collectionID[:], 1: "Reading list"},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign Collection Title: %v", err)
	}
	if err := replica.AdmitEvent(titleEvent, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatalf("Admit Collection Title: %v", err)
	}
	items, err := ProjectLibrary(replica)
	if err != nil {
		t.Fatalf("ProjectLibrary: %v", err)
	}
	if len(items) != 1 || items[0].BundleID != hexIdentifier(bundleID) || items[0].CollectionID != hexIdentifier(collectionID) || items[0].ArtifactID != hexIdentifier(artifactObjectID) || !items[0].AvailableLocally || items[0].Title == nil || *items[0].Title != "Example" {
		t.Fatalf("Library items = %#v", items)
	}
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		t.Fatalf("ProjectLibraryProjection: %v", err)
	}
	if len(projection.Collections) != 1 {
		t.Fatalf("Collections = %#v, want one collection", projection.Collections)
	}
	collection := projection.Collections[0]
	if collection.CollectionID != hexIdentifier(collectionID) || collection.Title != "Reading list" || collection.TailBundleID == nil || *collection.TailBundleID != hexIdentifier(bundleID) || collection.ActiveCaptureCount != 1 {
		t.Fatalf("Collection projection = %#v", collection)
	}
}

func TestReplicaRejectsBundleRegistrationWithoutDescriptorDependency(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	bundleID := filledCreationID(235)
	descriptorID := filledCreationID(236)
	collectionID := filledCreationID(237)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 3,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 1235,
		Body: canonical.Map{0: bundleID[:], 1: descriptorID[:], 2: collectionID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted Bundle Registered without its descriptor dependency")
	}
}

func TestReplicaRejectsCollectionTitleWithIncompleteBody(t *testing.T) {
	prepared := deterministicCreation(t)
	replica, err := NewReplica(prepared.Baseline)
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err != nil {
		t.Fatal(err)
	}
	collectionID := filledCreationID(238)
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{prepared.Genesis.RecordID}, AuthorityParentIDs: []canonical.Identifier{prepared.Genesis.RecordID},
		RequiredFeatureSetID: prepared.RequiredFeatureSetID, Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: 7,
		SignerCredentialID: prepared.IDs.ClientCredentialID, AssertedAt: 1236, Body: canonical.Map{0: collectionID[:]},
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := replica.AdmitEvent(event, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)); err == nil {
		t.Fatal("Replica accepted Collection Title with an incomplete body")
	}
}

func validTestArtifactObjectBytes(t *testing.T, vaultID, featureSetID canonical.Identifier, label string) []byte {
	t.Helper()
	payload := []byte(label)
	digest := awsmcrypto.ArtifactPayloadDigest(payload)
	encoded, err := canonical.EncodeValue(canonical.Map{
		0: uint64(1), 1: vaultID[:], 2: uint64(2), 3: featureSetID[:],
		4: canonical.Map{
			0: uint64(1), 1: "awsm.artifact.capture", 2: "application/vnd.awsm.web-page+zip", 3: "awsm.representation.web-page-zip",
			4: uint64(len(payload)), 5: digest[:],
			6: canonical.Map{0: uint64(1), 1: uint64(1_048_576), 2: uint64(16), 3: uint64(len(payload)), 4: digest[:]},
			7: []byte{0xa1, 0x00, 0x01},
		}, 5: map[string][]byte{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
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
	body := canonical.Map{0: uint64(eventType)}
	switch eventType {
	case 7:
		collectionID := filledCreationID(byte(100 + eventType))
		body = canonical.Map{0: collectionID[:], 1: "Collection"}
	case 8:
		sourceID := filledCreationID(byte(100 + eventType))
		destinationID := filledCreationID(byte(110 + eventType))
		body = canonical.Map{0: canonicalSetValues([]canonical.Value{sourceID[:]}), 1: destinationID[:]}
	case 9:
		body = canonical.Map{0: parent[:]}
	}
	event, err := canonical.SignEvent(canonical.EventInput{
		VaultID: prepared.IDs.VaultID, GenerationID: prepared.IDs.GenerationID,
		ParentRecordIDs: []canonical.Identifier{parent}, AuthorityParentIDs: []canonical.Identifier{parent},
		Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: prepared.RequiredFeatureSetID,
		Extensions: map[string][]byte{}, Family: canonical.ContentFamily, Type: eventType,
		SignerCredentialID: credential, AssertedAt: 124 + int64(eventType),
		Body: body,
	}, ed25519.PrivateKey(prepared.ClientKeys.SigningSecretKey))
	if err != nil {
		t.Fatalf("Sign child: %v", err)
	}
	return event
}
