package canonical

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func baselineIdentifier(start byte) Identifier {
	var value Identifier
	for index := range value {
		value[index] = start + byte(index)
	}
	return value
}

func TestVaultBaselineRoundTripsCanonicalRecordShape(t *testing.T) {
	memberID := baselineIdentifier(10)
	clientCredentialID := baselineIdentifier(11)
	recoveryCredentialID := baselineIdentifier(12)
	keyEpochID := baselineIdentifier(13)
	clientEnvelopeID := baselineIdentifier(14)
	recoveryEnvelopeID := baselineIdentifier(15)
	clientCertificate := Map{
		0: clientCredentialID[:],
		1: memberID[:],
		2: bytes.Repeat([]byte{16}, 32),
		3: bytes.Repeat([]byte{17}, 32),
	}
	recoveryCredential := Map{
		0: recoveryCredentialID[:],
		1: memberID[:],
		2: uint64(0),
		3: bytes.Repeat([]byte{18}, 32),
		4: bytes.Repeat([]byte{19}, 32),
	}
	recoverySlot := Map{
		0: keyEpochID[:], 1: uint64(1), 2: recoveryCredentialID[:], 3: uint64(0), 4: recoveryEnvelopeID[:],
	}
	clientSlot := Map{
		0: keyEpochID[:], 1: uint64(2), 2: clientCredentialID[:], 3: nil, 4: clientEnvelopeID[:],
	}
	contentCheckpoint := Map{
		0: uint64(1), 1: Map{0: nil, 1: []Value{}}, 2: []Value{}, 3: []Value{}, 4: []Value{},
		5: []Value{}, 6: []Value{}, 7: []Value{}, 8: []Value{}, 9: []Value{},
	}
	authorityCheckpoint := Map{
		0: uint64(1), 1: []Value{memberID[:]}, 2: []Value{memberID[:]},
		3: []Value{clientCertificate}, 4: []Value{recoveryCredential}, 5: []Value{},
		6: []Value{Map{0: keyEpochID[:], 1: uint64(0), 2: true}},
		7: []Value{recoverySlot, clientSlot}, 8: []Value{}, 9: []Value{},
	}
	input := BaselineInput{
		VaultID:              baselineIdentifier(1),
		GenerationID:         baselineIdentifier(2),
		Dependencies:         []Dependency{{Type: 7, ID: clientEnvelopeID}, {Type: 7, ID: recoveryEnvelopeID}},
		RequiredFeatureSetID: baselineIdentifier(20),
		Extensions:           map[string][]byte{},
		Body:                 Map{0: uint64(1), 1: uint64(1), 2: contentCheckpoint, 3: authorityCheckpoint, 4: Map{0: uint64(1)}, 5: nil},
	}

	baseline, err := EncodeBaseline(input)
	if err != nil {
		t.Fatalf("EncodeBaseline: %v", err)
	}
	decoded, err := DecodeBaseline(baseline.Bytes)
	if err != nil {
		t.Fatalf("DecodeBaseline: %v", err)
	}
	if !bytes.Equal(decoded.Bytes, baseline.Bytes) || decoded.RecordID != baseline.RecordID {
		t.Fatal("Baseline decode changed its canonical bytes or identity")
	}
	if decoded.VaultID != input.VaultID || decoded.GenerationID != input.GenerationID {
		t.Fatal("Baseline decode changed its identity fields")
	}
	record, err := DecodeRecord(baseline.Bytes)
	if err != nil {
		t.Fatalf("DecodeRecord: %v", err)
	}
	if record.Kind != BaselineKind || record.Baseline == nil || record.Event != nil {
		t.Fatalf("decoded record = %#v, want a Baseline record", record)
	}
	wantID := sha256.Sum256(mustTranscript("awsm:vault-record-id:v1", baseline.Bytes))
	if record.RecordID != wantID {
		t.Fatalf("Baseline Record ID = %x, want %x", record.RecordID, wantID)
	}
}

func TestVaultBaselineRejectsParentsAndUnknownFields(t *testing.T) {
	input := BaselineInput{
		VaultID:              baselineIdentifier(1),
		GenerationID:         baselineIdentifier(2),
		RequiredFeatureSetID: baselineIdentifier(3),
		Extensions:           map[string][]byte{},
		Body:                 Map{0: uint64(1)},
	}
	baseline, err := EncodeBaseline(input)
	if err != nil {
		t.Fatalf("EncodeBaseline: %v", err)
	}
	value, err := DecodeValue(baseline.Bytes)
	if err != nil {
		t.Fatalf("DecodeValue: %v", err)
	}
	value.(map[any]any)[uint64(3)] = []Value{bytes.Repeat([]byte{1}, 32)}
	mutated, err := EncodeValue(value)
	if err != nil {
		t.Fatalf("EncodeValue mutated Baseline: %v", err)
	}
	if _, err := DecodeBaseline(mutated); err == nil {
		t.Fatal("DecodeBaseline accepted causal parents")
	}
	value.(map[any]any)[uint64(3)] = []Value{}
	value.(map[any]any)[uint64(10)] = uint64(1)
	mutated, err = EncodeValue(value)
	if err != nil {
		t.Fatalf("EncodeValue unknown field: %v", err)
	}
	if _, err := DecodeBaseline(mutated); err == nil {
		t.Fatal("DecodeBaseline accepted unknown fields")
	}
}

func mustTranscript(label string, parts ...[]byte) []byte {
	value, err := Transcript(label, parts...)
	if err != nil {
		panic(err)
	}
	return value
}

func TestRecordIDsUseTheCanonicalDigestDomain(t *testing.T) {
	bytesValue, err := hex.DecodeString("a10001")
	if err != nil {
		t.Fatal(err)
	}
	want := "30ee641f3b5a45aceee20fdb4dd40f3835270f32280b5f09ba2ce5766f6fd39a"
	got := digest("awsm:vault-record-id:v1", bytesValue)
	if hex.EncodeToString(got[:]) != want {
		t.Fatalf("record ID = %x, want %s", got, want)
	}
}
