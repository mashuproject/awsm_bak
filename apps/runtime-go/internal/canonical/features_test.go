package canonical

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestFeatureManifestRoundTripsWithBrowserCompatibleIdentity(t *testing.T) {
	first := FeatureManifestInput{
		FeatureKey:          "awsm.alpha",
		Revision:            0,
		Parameters:          []byte{},
		RequiredManifestIDs: []Identifier{},
		IncompatibleKeys:    []string{},
	}
	firstBytes, err := EncodeFeatureManifest(first)
	if err != nil {
		t.Fatalf("encode first Feature Manifest: %v", err)
	}
	firstValue, err := DecodeFeatureManifest(firstBytes)
	if err != nil {
		t.Fatalf("decode first Feature Manifest: %v", err)
	}
	if firstValue.FeatureKey != first.FeatureKey || firstValue.Revision != first.Revision || !bytes.Equal(firstValue.Parameters, first.Parameters) {
		t.Fatalf("decoded first Feature Manifest = %#v", firstValue)
	}
	if got := hex.EncodeToString(firstValue.ID[:]); got != "310667b3d036cf1dd1d28832a04f570b3834764654c66f8f600385cd591edc69" {
		t.Fatalf("first Feature Manifest ID = %s", got)
	}
	second := FeatureManifestInput{
		FeatureKey:          "awsm.beta",
		Revision:            2,
		Parameters:          []byte{7},
		RequiredManifestIDs: []Identifier{firstValue.ID},
		IncompatibleKeys:    []string{"awsm.gamma"},
	}
	secondBytes, err := EncodeFeatureManifest(second)
	if err != nil {
		t.Fatalf("encode second Feature Manifest: %v", err)
	}
	secondValue, err := DecodeFeatureManifest(secondBytes)
	if err != nil {
		t.Fatalf("decode second Feature Manifest: %v", err)
	}
	if len(secondValue.RequiredManifestIDs) != 1 || secondValue.RequiredManifestIDs[0] != firstValue.ID {
		t.Fatalf("decoded second Feature Manifest requirements = %#v", secondValue.RequiredManifestIDs)
	}
	setID, err := RequiredFeatureSetID([]FeatureManifestInput{second, first})
	if err != nil {
		t.Fatalf("derive Required Feature Set ID: %v", err)
	}
	setBytes, err := EncodeRequiredFeatureSet([]FeatureManifestInput{second, first})
	if err != nil {
		t.Fatalf("encode Required Feature Set: %v", err)
	}
	decodedSet, err := DecodeRequiredFeatureSet(setBytes)
	if err != nil {
		t.Fatalf("decode Required Feature Set: %v", err)
	}
	if len(decodedSet) != 2 || decodedSet[0].ID == (Identifier{}) || decodedSet[1].ID == (Identifier{}) {
		t.Fatalf("decoded Required Feature Set = %#v", decodedSet)
	}
	decodedSetID, err := RequiredFeatureSetIDFromBytes(setBytes)
	if err != nil {
		t.Fatalf("derive Required Feature Set ID from bytes: %v", err)
	}
	if decodedSetID != setID {
		t.Fatalf("Required Feature Set ID from bytes = %x, want %x", decodedSetID, setID)
	}
	if empty := EmptyRequiredFeatureSetID(); hex.EncodeToString(empty[:]) != "ed3dd98a4e6cc13d9d14ca4d62eb6b33e11ed471172346ab5d38ac91f57d7ada" {
		t.Fatalf("empty Required Feature Set ID = %x", empty)
	}
}

func TestFeatureManifestValidationRejectsUnsatisfiedAndConflictingSets(t *testing.T) {
	base := FeatureManifestInput{FeatureKey: "awsm.base", RequiredManifestIDs: []Identifier{}, IncompatibleKeys: []string{}}
	baseBytes, err := EncodeFeatureManifest(base)
	if err != nil {
		t.Fatalf("encode base Feature Manifest: %v", err)
	}
	baseID, err := FeatureManifestID(baseBytes)
	if err != nil {
		t.Fatalf("derive base Feature Manifest ID: %v", err)
	}
	if _, err := RequiredFeatureSetID([]FeatureManifestInput{{FeatureKey: "awsm.dependent", RequiredManifestIDs: []Identifier{{9}}, IncompatibleKeys: []string{}}}); err == nil {
		t.Fatal("unsatisfied Feature Manifest requirement was accepted")
	}
	if _, err := RequiredFeatureSetID([]FeatureManifestInput{base, {FeatureKey: "awsm.other", RequiredManifestIDs: []Identifier{baseID}, IncompatibleKeys: []string{"awsm.base"}}}); err == nil {
		t.Fatal("incompatible Feature Manifest set was accepted")
	}
	if _, err := EncodeFeatureManifest(FeatureManifestInput{FeatureKey: "invalid", RequiredManifestIDs: []Identifier{}, IncompatibleKeys: []string{}}); err == nil {
		t.Fatal("unscoped Feature Manifest key was accepted")
	}
}

func TestFeatureManifestDecodeRejectsNonCanonicalBytes(t *testing.T) {
	nonCanonical, err := EncodeValue(Map{
		0: "awsm.feature",
		1: uint64(0),
		2: []byte{},
		3: []Value{},
		4: []Value{"awsm.z", "awsm.a"},
	})
	if err != nil {
		t.Fatalf("encode non-canonical Feature Manifest: %v", err)
	}
	if _, err := DecodeFeatureManifest(nonCanonical); err == nil {
		t.Fatal("non-canonical Feature Manifest was accepted")
	}
}
