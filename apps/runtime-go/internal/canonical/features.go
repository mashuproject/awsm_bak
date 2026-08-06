package canonical

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
)

// FeatureManifestInput is the semantic content of one immutable Feature
// Manifest. The manifest bytes are authenticated independently from the Event
// DAG and are referenced by typed dependency 8.
type FeatureManifestInput struct {
	FeatureKey          string
	Revision            uint64
	Parameters          []byte
	RequiredManifestIDs []Identifier
	IncompatibleKeys    []string
}

// FeatureManifest is a decoded, content-addressed Feature Manifest.
type FeatureManifest struct {
	FeatureManifestInput
	Bytes []byte
	ID    Identifier
}

// EncodeFeatureManifest encodes one browser-compatible canonical Feature
// Manifest. Set-valued fields are normalized into their canonical order.
func EncodeFeatureManifest(input FeatureManifestInput) ([]byte, error) {
	normalized, err := normalizeFeatureManifestInput(input)
	if err != nil {
		return nil, err
	}
	required := make([]Value, len(normalized.RequiredManifestIDs))
	for index, id := range normalized.RequiredManifestIDs {
		required[index] = append([]byte(nil), id[:]...)
	}
	incompatible := make([]Value, len(normalized.IncompatibleKeys))
	for index, key := range normalized.IncompatibleKeys {
		incompatible[index] = key
	}
	return EncodeValue(Map{
		0: normalized.FeatureKey,
		1: normalized.Revision,
		2: append([]byte(nil), normalized.Parameters...),
		3: required,
		4: incompatible,
	})
}

// DecodeFeatureManifest verifies exact canonical bytes, semantic set rules,
// and the content address of one Feature Manifest.
func DecodeFeatureManifest(encoded []byte) (FeatureManifest, error) {
	value, err := DecodeValue(encoded)
	if err != nil {
		return FeatureManifest{}, err
	}
	if !isMap(value) || len(mapKeys(value)) != 5 {
		return FeatureManifest{}, errors.New("Feature Manifest must contain the exact fields")
	}
	for key := uint64(0); key <= 4; key++ {
		if _, ok := mapLookup(value, key); !ok {
			return FeatureManifest{}, fmt.Errorf("Feature Manifest is missing field %d", key)
		}
	}
	featureKeyValue, _ := mapLookup(value, 0)
	featureKey, ok := featureKeyValue.(string)
	if !ok {
		return FeatureManifest{}, errors.New("Feature Manifest key must be text")
	}
	revision, ok := numericValue(value, 1)
	if !ok {
		return FeatureManifest{}, errors.New("Feature Manifest revision must be an unsigned integer")
	}
	parametersValue, _ := mapLookup(value, 2)
	parameters, ok := parametersValue.([]byte)
	if !ok {
		return FeatureManifest{}, errors.New("Feature Manifest parameters must be bytes")
	}
	requiredValue, _ := mapLookup(value, 3)
	requiredValues, ok := requiredValue.([]Value)
	if !ok {
		return FeatureManifest{}, errors.New("Required Feature Manifest IDs must be an array")
	}
	requiredIDs := make([]Identifier, len(requiredValues))
	for index, item := range requiredValues {
		idBytes, ok := item.([]byte)
		if !ok || len(idBytes) != 32 {
			return FeatureManifest{}, fmt.Errorf("Required Feature Manifest ID %d is invalid", index)
		}
		copy(requiredIDs[index][:], idBytes)
	}
	incompatibleValue, _ := mapLookup(value, 4)
	incompatibleValues, ok := incompatibleValue.([]Value)
	if !ok {
		return FeatureManifest{}, errors.New("Incompatible feature keys must be an array")
	}
	incompatibleKeys := make([]string, len(incompatibleValues))
	for index, item := range incompatibleValues {
		key, ok := item.(string)
		if !ok {
			return FeatureManifest{}, fmt.Errorf("Incompatible feature key %d is invalid", index)
		}
		incompatibleKeys[index] = key
	}
	input := FeatureManifestInput{
		FeatureKey:          featureKey,
		Revision:            revision,
		Parameters:          append([]byte(nil), parameters...),
		RequiredManifestIDs: requiredIDs,
		IncompatibleKeys:    incompatibleKeys,
	}
	if err := validateFeatureManifestInput(input); err != nil {
		return FeatureManifest{}, err
	}
	canonicalBytes, err := EncodeFeatureManifest(input)
	if err != nil {
		return FeatureManifest{}, err
	}
	if !bytes.Equal(canonicalBytes, encoded) {
		return FeatureManifest{}, errors.New("Feature Manifest is not canonical")
	}
	return FeatureManifest{
		FeatureManifestInput: input,
		Bytes:                append([]byte(nil), encoded...),
		ID:                   featureManifestDigest(encoded),
	}, nil
}

// FeatureManifestID validates and derives the content address for complete
// canonical Feature Manifest bytes.
func FeatureManifestID(encoded []byte) (Identifier, error) {
	if _, err := DecodeFeatureManifest(encoded); err != nil {
		return Identifier{}, err
	}
	return featureManifestDigest(encoded), nil
}

// EncodeRequiredFeatureSet encodes the complete sorted Feature Manifest
// closure represented by input.
func EncodeRequiredFeatureSet(inputs []FeatureManifestInput) ([]byte, error) {
	entries, err := validatedFeatureSet(inputs)
	if err != nil {
		return nil, err
	}
	values := make([]Value, len(entries))
	for index, entry := range entries {
		values[index] = append([]byte(nil), entry.Bytes...)
	}
	return EncodeValue(values)
}

// DecodeRequiredFeatureSet verifies a complete canonical Feature Manifest
// closure and returns its decoded content-addressed entries.
func DecodeRequiredFeatureSet(encoded []byte) ([]FeatureManifest, error) {
	value, err := DecodeValue(encoded)
	if err != nil {
		return nil, err
	}
	values, ok := value.([]Value)
	if !ok {
		return nil, errors.New("Required Feature Set must be an array")
	}
	entries := make([]FeatureManifest, len(values))
	for index, item := range values {
		manifestBytes, ok := item.([]byte)
		if !ok {
			return nil, fmt.Errorf("Required Feature Set entry %d must contain complete Manifest bytes", index)
		}
		manifest, err := DecodeFeatureManifest(manifestBytes)
		if err != nil {
			return nil, fmt.Errorf("decode Required Feature Set entry %d: %w", index, err)
		}
		entries[index] = manifest
	}
	if err := validateFeatureSetEntries(entries); err != nil {
		return nil, err
	}
	canonicalBytes, err := EncodeRequiredFeatureSet(featureInputs(entries))
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(canonicalBytes, encoded) {
		return nil, errors.New("Required Feature Set is not sorted by Feature Manifest ID")
	}
	return entries, nil
}

// RequiredFeatureSetID derives the browser-compatible identity of a complete
// Feature Manifest closure.
func RequiredFeatureSetID(inputs []FeatureManifestInput) (Identifier, error) {
	entries, err := validatedFeatureSet(inputs)
	if err != nil {
		return Identifier{}, err
	}
	ids := make([]byte, 0, len(entries)*32)
	for _, entry := range entries {
		ids = append(ids, entry.ID[:]...)
	}
	transcript, err := Transcript("awsm:required-feature-set-id:v1", ids)
	if err != nil {
		return Identifier{}, err
	}
	return sha256.Sum256(transcript), nil
}

// RequiredFeatureSetIDFromBytes validates and derives the identity from a
// complete encoded Feature Manifest set.
func RequiredFeatureSetIDFromBytes(encoded []byte) (Identifier, error) {
	entries, err := DecodeRequiredFeatureSet(encoded)
	if err != nil {
		return Identifier{}, err
	}
	return RequiredFeatureSetID(featureInputs(entries))
}

// EmptyRequiredFeatureSetID is the identity of the empty Required Feature Set.
func EmptyRequiredFeatureSetID() Identifier {
	value, err := RequiredFeatureSetID(nil)
	if err != nil {
		panic(err)
	}
	return value
}

type featureManifestEntry struct {
	FeatureManifest
	input FeatureManifestInput
}

func normalizeFeatureManifestInput(input FeatureManifestInput) (FeatureManifestInput, error) {
	if err := validateFeatureManifestInput(input); err != nil {
		return FeatureManifestInput{}, err
	}
	normalized := FeatureManifestInput{
		FeatureKey:          input.FeatureKey,
		Revision:            input.Revision,
		Parameters:          append([]byte(nil), input.Parameters...),
		RequiredManifestIDs: append([]Identifier(nil), input.RequiredManifestIDs...),
		IncompatibleKeys:    append([]string(nil), input.IncompatibleKeys...),
	}
	sort.Slice(normalized.RequiredManifestIDs, func(left, right int) bool {
		return bytes.Compare(normalized.RequiredManifestIDs[left][:], normalized.RequiredManifestIDs[right][:]) < 0
	})
	sort.SliceStable(normalized.IncompatibleKeys, func(left, right int) bool {
		leftBytes, _ := EncodeValue(normalized.IncompatibleKeys[left])
		rightBytes, _ := EncodeValue(normalized.IncompatibleKeys[right])
		return bytes.Compare(leftBytes, rightBytes) < 0
	})
	return normalized, nil
}

func validateFeatureManifestInput(input FeatureManifestInput) error {
	if err := validateScopedKey(input.FeatureKey); err != nil {
		return fmt.Errorf("Feature Manifest key is invalid: %w", err)
	}
	if input.Revision > 1<<53-1 {
		return errors.New("Feature Manifest revision must be a browser-safe integer")
	}
	seenIDs := make(map[Identifier]struct{}, len(input.RequiredManifestIDs))
	for _, id := range input.RequiredManifestIDs {
		if _, exists := seenIDs[id]; exists {
			return errors.New("Required Feature Manifest IDs contain a duplicate")
		}
		seenIDs[id] = struct{}{}
	}
	seenKeys := make(map[string]struct{}, len(input.IncompatibleKeys))
	for _, key := range input.IncompatibleKeys {
		if err := validateScopedKey(key); err != nil {
			return fmt.Errorf("incompatible feature key is invalid: %w", err)
		}
		if _, exists := seenKeys[key]; exists {
			return errors.New("incompatible feature keys contain a duplicate")
		}
		seenKeys[key] = struct{}{}
	}
	return nil
}

func validatedFeatureSet(inputs []FeatureManifestInput) ([]featureManifestEntry, error) {
	entries := make([]featureManifestEntry, 0, len(inputs))
	keys := make(map[string]struct{}, len(inputs))
	ids := make(map[Identifier]struct{}, len(inputs))
	for _, input := range inputs {
		encoded, err := EncodeFeatureManifest(input)
		if err != nil {
			return nil, err
		}
		manifest, err := DecodeFeatureManifest(encoded)
		if err != nil {
			return nil, err
		}
		if _, exists := keys[manifest.FeatureKey]; exists {
			return nil, errors.New("Required Feature Set repeats a feature key")
		}
		if _, exists := ids[manifest.ID]; exists {
			return nil, errors.New("Required Feature Set repeats a Manifest")
		}
		keys[manifest.FeatureKey] = struct{}{}
		ids[manifest.ID] = struct{}{}
		entries = append(entries, featureManifestEntry{FeatureManifest: manifest, input: manifest.FeatureManifestInput})
	}
	if err := validateFeatureSetEntryReferences(entries, ids, keys); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(left, right int) bool {
		return bytes.Compare(entries[left].ID[:], entries[right].ID[:]) < 0
	})
	return entries, nil
}

func validateFeatureSetEntries(entries []FeatureManifest) error {
	inputs := make([]FeatureManifestInput, len(entries))
	for index, entry := range entries {
		inputs[index] = entry.FeatureManifestInput
	}
	validated, err := validatedFeatureSet(inputs)
	if err != nil {
		return err
	}
	if len(validated) != len(entries) {
		return errors.New("Required Feature Set entries are invalid")
	}
	for index, entry := range entries {
		if entry.ID != validated[index].ID {
			return errors.New("Required Feature Set entries are not sorted by Manifest ID")
		}
	}
	return nil
}

func validateFeatureSetEntryReferences(entries []featureManifestEntry, ids map[Identifier]struct{}, keys map[string]struct{}) error {
	for index, entry := range entries {
		for _, requiredID := range entry.RequiredManifestIDs {
			if _, ok := ids[requiredID]; !ok {
				return fmt.Errorf("Required Feature Manifest %d has an unsatisfied requirement", index)
			}
		}
		for _, incompatibleKey := range entry.IncompatibleKeys {
			if _, ok := keys[incompatibleKey]; ok {
				return fmt.Errorf("Required Feature Manifest %d conflicts with %s", index, incompatibleKey)
			}
		}
	}
	return nil
}

func featureInputs(entries []FeatureManifest) []FeatureManifestInput {
	inputs := make([]FeatureManifestInput, len(entries))
	for index, entry := range entries {
		inputs[index] = entry.FeatureManifestInput
	}
	return inputs
}

func featureManifestDigest(encoded []byte) Identifier {
	transcript, err := Transcript("awsm:feature-manifest-id:v1", encoded)
	if err != nil {
		panic(err)
	}
	return sha256.Sum256(transcript)
}
