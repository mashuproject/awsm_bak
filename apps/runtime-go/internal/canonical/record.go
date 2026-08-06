package canonical

import (
	"errors"
	"fmt"
)

const (
	VaultRecordFormat uint64 = 1
	EventKind         uint64 = 1
	BaselineKind      uint64 = 2
)

// BaselineInput is the immutable, unsigned checkpoint representation. A
// Baseline is authenticated by its content address and has no Event signer or
// causal/Authority parents.
type BaselineInput struct {
	VaultID              Identifier
	GenerationID         Identifier
	Dependencies         []Dependency
	RequiredFeatureSetID Identifier
	Extensions           map[string][]byte
	Body                 Value
}

type Baseline struct {
	BaselineInput
	Bytes    []byte
	RecordID Identifier
}

// Record is the decoded union of the two portable Vault Record kinds.
type Record struct {
	Kind     uint64
	Event    *Event
	Baseline *Baseline
	Bytes    []byte
	RecordID Identifier
}

func EncodeBaseline(input BaselineInput) (Baseline, error) {
	if err := validateBaselineInput(input); err != nil {
		return Baseline{}, err
	}
	value := Map{
		0: VaultRecordFormat,
		1: append([]byte(nil), input.VaultID[:]...),
		2: append([]byte(nil), input.GenerationID[:]...),
		3: []Value{},
		4: []Value{},
		5: encodeDependencies(input.Dependencies),
		6: BaselineKind,
		7: append([]byte(nil), input.RequiredFeatureSetID[:]...),
		8: input.Extensions,
		9: input.Body,
	}
	encoded, err := EncodeValue(value)
	if err != nil {
		return Baseline{}, err
	}
	return decodeBaseline(encoded)
}

func DecodeBaseline(encoded []byte) (Baseline, error) {
	return decodeBaseline(encoded)
}

func DecodeRecord(encoded []byte) (Record, error) {
	value, err := DecodeValue(encoded)
	if err != nil {
		return Record{}, err
	}
	kind, ok := numericValue(value, 6)
	if !ok {
		return Record{}, errors.New("Vault Record kind is missing or invalid")
	}
	switch kind {
	case EventKind:
		event, err := DecodeEvent(encoded)
		if err != nil {
			return Record{}, err
		}
		return Record{
			Kind:     EventKind,
			Event:    &event,
			Bytes:    append([]byte(nil), encoded...),
			RecordID: event.RecordID,
		}, nil
	case BaselineKind:
		baseline, err := DecodeBaseline(encoded)
		if err != nil {
			return Record{}, err
		}
		return Record{
			Kind:     BaselineKind,
			Baseline: &baseline,
			Bytes:    append([]byte(nil), encoded...),
			RecordID: baseline.RecordID,
		}, nil
	default:
		return Record{}, fmt.Errorf("unknown Vault Record kind %d", kind)
	}
}

func decodeBaseline(encoded []byte) (Baseline, error) {
	value, err := DecodeValue(encoded)
	if err != nil {
		return Baseline{}, err
	}
	if !isMap(value) {
		return Baseline{}, errors.New("Vault Baseline must be a map")
	}
	for key := uint64(0); key <= 9; key++ {
		if _, ok := mapLookup(value, key); !ok {
			return Baseline{}, fmt.Errorf("Vault Baseline is missing field %d", key)
		}
	}
	if len(mapKeys(value)) != 10 {
		return Baseline{}, errors.New("Vault Baseline contains unknown fields")
	}
	format, ok := numericValue(value, 0)
	if !ok || format != VaultRecordFormat {
		return Baseline{}, errors.New("unknown Vault Record format")
	}
	kind, ok := numericValue(value, 6)
	if !ok || kind != BaselineKind {
		return Baseline{}, errors.New("Vault Record is not a Baseline")
	}
	parents, err := decodeIdentifierSet(value, 3, "causal parents")
	if err != nil {
		return Baseline{}, err
	}
	if len(parents) != 0 {
		return Baseline{}, errors.New("a Vault Baseline cannot have causal parents")
	}
	authorityParents, err := decodeIdentifierSet(value, 4, "Authority Parents")
	if err != nil {
		return Baseline{}, err
	}
	if len(authorityParents) != 0 {
		return Baseline{}, errors.New("a Vault Baseline cannot have Authority Parents")
	}
	input := BaselineInput{}
	if input.VaultID, err = decodeIdentifier(value, 1, "Vault ID"); err != nil {
		return Baseline{}, err
	}
	if input.GenerationID, err = decodeIdentifier(value, 2, "Generation ID"); err != nil {
		return Baseline{}, err
	}
	if input.Dependencies, err = decodeDependencies(value, 5); err != nil {
		return Baseline{}, err
	}
	if input.RequiredFeatureSetID, err = decodeIdentifier(value, 7, "Required Feature Set ID"); err != nil {
		return Baseline{}, err
	}
	if input.Extensions, err = decodeExtensions(value, 8); err != nil {
		return Baseline{}, err
	}
	if input.Body, ok = mapLookup(value, 9); !ok {
		return Baseline{}, errors.New("Baseline body is missing")
	}
	if err := validateBaselineInput(input); err != nil {
		return Baseline{}, err
	}
	return Baseline{
		BaselineInput: input,
		Bytes:         append([]byte(nil), encoded...),
		RecordID:      digest("awsm:vault-record-id:v1", encoded),
	}, nil
}

func validateBaselineInput(input BaselineInput) error {
	if input.VaultID == (Identifier{}) || input.GenerationID == (Identifier{}) {
		return errors.New("Baseline Vault and Generation IDs must not be zero")
	}
	if input.RequiredFeatureSetID == (Identifier{}) {
		return errors.New("Baseline Required Feature Set ID must not be zero")
	}
	if err := validateDependencies(input.Dependencies); err != nil {
		return err
	}
	if input.Extensions == nil {
		input.Extensions = map[string][]byte{}
	}
	if err := validateValue(input.Extensions, "advisory extensions"); err != nil {
		return err
	}
	return validateValue(input.Body, "Baseline body")
}

func encodeDependencies(values []Dependency) []Value {
	result := make([]Value, len(values))
	for index, dependency := range values {
		result[index] = Map{0: dependency.Type, 1: append([]byte(nil), dependency.ID[:]...)}
	}
	return result
}
