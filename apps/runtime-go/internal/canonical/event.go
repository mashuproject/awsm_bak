package canonical

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
)

type Identifier = [32]byte

type EventFamily uint64

const (
	AuthorityFamily EventFamily = 1
	ContentFamily   EventFamily = 2
	LifecycleFamily EventFamily = 3
)

const (
	GenesisEvent uint64 = 1
)

type Dependency struct {
	Type uint64
	ID   Identifier
}

type EventInput struct {
	VaultID              Identifier
	GenerationID         Identifier
	ParentRecordIDs      []Identifier
	AuthorityParentIDs   []Identifier
	Dependencies         []Dependency
	RequiredFeatureSetID Identifier
	Extensions           map[string][]byte
	Family               EventFamily
	Type                 uint64
	SignerCredentialID   Identifier
	AssertedAt           int64
	Body                 Value
}

type Event struct {
	EventInput
	Signature []byte
	Bytes     []byte
	RecordID  Identifier
}

func EncodeUnsignedEvent(input EventInput) ([]byte, error) {
	if err := validateEventInput(input); err != nil {
		return nil, err
	}
	value := eventMap(input, nil)
	return EncodeValue(value)
}

func SignEvent(input EventInput, privateKey ed25519.PrivateKey) (Event, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return Event{}, errors.New("Ed25519 private key must contain 64 bytes")
	}
	unsigned, err := EncodeUnsignedEvent(input)
	if err != nil {
		return Event{}, err
	}
	message, err := Transcript("awsm:vault-event-signature:v1", unsigned)
	if err != nil {
		return Event{}, err
	}
	signature := ed25519.Sign(privateKey, message)
	encoded, err := EncodeValue(eventMap(input, signature))
	if err != nil {
		return Event{}, err
	}
	return Event{
		EventInput: input,
		Signature:  append([]byte(nil), signature...),
		Bytes:      append([]byte(nil), encoded...),
		RecordID:   digest("awsm:vault-record-id:v1", encoded),
	}, nil
}

func VerifyEventSignature(event Event, publicKey ed25519.PublicKey) bool {
	if len(publicKey) != ed25519.PublicKeySize || len(event.Signature) != ed25519.SignatureSize {
		return false
	}
	unsigned, err := EncodeUnsignedEvent(event.EventInput)
	if err != nil {
		return false
	}
	message, err := Transcript("awsm:vault-event-signature:v1", unsigned)
	return err == nil && ed25519.Verify(publicKey, message, event.Signature)
}

func DecodeEvent(encoded []byte) (Event, error) {
	value, err := DecodeValue(encoded)
	if err != nil {
		return Event{}, err
	}
	if !isMap(value) {
		return Event{}, errors.New("Vault Event must be a map")
	}
	for key := uint64(0); key <= 14; key++ {
		if _, ok := mapLookup(value, key); !ok {
			return Event{}, fmt.Errorf("Vault Event is missing field %d", key)
		}
	}
	if len(mapKeys(value)) != 15 {
		return Event{}, errors.New("Vault Event contains unknown fields")
	}
	input, err := decodeEventInput(value)
	if err != nil {
		return Event{}, err
	}
	signatureValue, _ := mapLookup(value, 14)
	signature, ok := signatureValue.([]byte)
	if !ok || len(signature) != ed25519.SignatureSize {
		return Event{}, errors.New("Vault Event signature must contain 64 bytes")
	}
	result := Event{
		EventInput: input,
		Signature:  append([]byte(nil), signature...),
		Bytes:      append([]byte(nil), encoded...),
		RecordID:   digest("awsm:vault-record-id:v1", encoded),
	}
	return result, nil
}

func eventMap(input EventInput, signature []byte) Map {
	parents := make([]Value, len(input.ParentRecordIDs))
	for index, id := range input.ParentRecordIDs {
		parents[index] = append([]byte(nil), id[:]...)
	}
	authorityParents := make([]Value, len(input.AuthorityParentIDs))
	for index, id := range input.AuthorityParentIDs {
		authorityParents[index] = append([]byte(nil), id[:]...)
	}
	dependencies := make([]Value, len(input.Dependencies))
	for index, dependency := range input.Dependencies {
		dependencies[index] = Map{0: dependency.Type, 1: append([]byte(nil), dependency.ID[:]...)}
	}
	value := Map{
		0:  uint64(1),
		1:  append([]byte(nil), input.VaultID[:]...),
		2:  append([]byte(nil), input.GenerationID[:]...),
		3:  parents,
		4:  authorityParents,
		5:  dependencies,
		6:  uint64(1),
		7:  append([]byte(nil), input.RequiredFeatureSetID[:]...),
		8:  input.Extensions,
		9:  uint64(input.Family),
		10: input.Type,
		11: append([]byte(nil), input.SignerCredentialID[:]...),
		12: input.AssertedAt,
		13: input.Body,
	}
	if signature != nil {
		value[14] = append([]byte(nil), signature...)
	}
	return value
}

func decodeEventInput(value Value) (EventInput, error) {
	input := EventInput{}
	var err error
	if input.VaultID, err = decodeIdentifier(value, 1, "Vault ID"); err != nil {
		return EventInput{}, err
	}
	if input.GenerationID, err = decodeIdentifier(value, 2, "Generation ID"); err != nil {
		return EventInput{}, err
	}
	if input.ParentRecordIDs, err = decodeIdentifierSet(value, 3, "causal parents"); err != nil {
		return EventInput{}, err
	}
	if input.AuthorityParentIDs, err = decodeIdentifierSet(value, 4, "Authority Parents"); err != nil {
		return EventInput{}, err
	}
	if input.Dependencies, err = decodeDependencies(value, 5); err != nil {
		return EventInput{}, err
	}
	if input.RequiredFeatureSetID, err = decodeIdentifier(value, 7, "Required Feature Set ID"); err != nil {
		return EventInput{}, err
	}
	if input.Extensions, err = decodeExtensions(value, 8); err != nil {
		return EventInput{}, err
	}
	family, ok := numericValue(value, 9)
	if !ok {
		return EventInput{}, errors.New("Event family must be an unsigned integer")
	}
	input.Family = EventFamily(family)
	if input.Type, ok = numericValue(value, 10); !ok {
		return EventInput{}, errors.New("Event type must be an unsigned integer")
	}
	if input.SignerCredentialID, err = decodeIdentifier(value, 11, "signer Credential ID"); err != nil {
		return EventInput{}, err
	}
	assertedAt, ok := signedValue(value, 12)
	if !ok {
		return EventInput{}, errors.New("assertedAt must be a signed integer")
	}
	input.AssertedAt = assertedAt
	if input.Body, ok = mapLookup(value, 13); !ok {
		return EventInput{}, errors.New("Event body is missing")
	}
	if err := validateEventInput(input); err != nil {
		return EventInput{}, err
	}
	return input, nil
}

func validateEventInput(input EventInput) error {
	if input.Family < AuthorityFamily || input.Family > LifecycleFamily {
		return errors.New("unknown Event family")
	}
	maximum := map[EventFamily]uint64{AuthorityFamily: 14, ContentFamily: 31, LifecycleFamily: 2}[input.Family]
	if input.Type < 1 || input.Type > maximum {
		return errors.New("unknown Event type")
	}
	genesis := input.Family == AuthorityFamily && input.Type == GenesisEvent
	if genesis && (len(input.ParentRecordIDs) != 0 || len(input.AuthorityParentIDs) != 0) {
		return errors.New("Genesis must have empty causal and Authority Parent frontiers")
	}
	if !genesis && (len(input.ParentRecordIDs) == 0 || len(input.AuthorityParentIDs) == 0) {
		return errors.New("non-Genesis Event requires both parent frontiers")
	}
	if err := validateIdentifierSet(input.ParentRecordIDs, "causal parents"); err != nil {
		return err
	}
	if err := validateIdentifierSet(input.AuthorityParentIDs, "Authority Parents"); err != nil {
		return err
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
	if err := validateValue(input.Body, "Event body"); err != nil {
		return err
	}
	return nil
}

func validateIdentifierSet(values []Identifier, field string) error {
	seen := make(map[Identifier]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			return fmt.Errorf("%s contains a duplicate", field)
		}
		seen[value] = struct{}{}
	}
	for index := 1; index < len(values); index++ {
		if bytes.Compare(values[index-1][:], values[index][:]) >= 0 {
			return fmt.Errorf("%s must be a canonical set", field)
		}
	}
	return nil
}

func validateDependencies(values []Dependency) error {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value.Type < 1 || value.Type > 8 {
			return errors.New("dependency type is unknown")
		}
		key := fmt.Sprintf("%d:%x", value.Type, value.ID)
		if _, exists := seen[key]; exists {
			return errors.New("dependencies contain a duplicate")
		}
		seen[key] = struct{}{}
	}
	for index := 1; index < len(values); index++ {
		left := values[index-1]
		right := values[index]
		if left.Type > right.Type || (left.Type == right.Type && bytes.Compare(left.ID[:], right.ID[:]) >= 0) {
			return errors.New("dependencies must be a canonical set")
		}
	}
	return nil
}

func decodeIdentifier(value Value, field uint64, name string) (Identifier, error) {
	entry, ok := mapLookup(value, field)
	if !ok {
		return Identifier{}, fmt.Errorf("%s is missing", name)
	}
	bytesValue, ok := entry.([]byte)
	if !ok || len(bytesValue) != 32 {
		return Identifier{}, fmt.Errorf("%s must contain 32 bytes", name)
	}
	var result Identifier
	copy(result[:], bytesValue)
	return result, nil
}

func decodeIdentifierSet(value Value, field uint64, name string) ([]Identifier, error) {
	entry, ok := mapLookup(value, field)
	if !ok {
		return nil, fmt.Errorf("%s is missing", name)
	}
	values, ok := entry.([]Value)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", name)
	}
	result := make([]Identifier, len(values))
	for index, item := range values {
		bytesValue, ok := item.([]byte)
		if !ok || len(bytesValue) != 32 {
			return nil, fmt.Errorf("%s contains an invalid ID", name)
		}
		copy(result[index][:], bytesValue)
	}
	if err := validateIdentifierSet(result, name); err != nil {
		return nil, err
	}
	return result, nil
}

func decodeDependencies(value Value, field uint64) ([]Dependency, error) {
	entry, ok := mapLookup(value, field)
	if !ok {
		return nil, errors.New("dependencies are missing")
	}
	values, ok := entry.([]Value)
	if !ok {
		return nil, errors.New("dependencies must be an array")
	}
	result := make([]Dependency, len(values))
	for index, item := range values {
		dependencyMap, ok := item.(Map)
		if !ok {
			if generic, genericOK := item.(map[any]any); genericOK {
				dependencyMap = Map{}
				for key, value := range generic {
					numeric, numericOK := key.(uint64)
					if !numericOK {
						return nil, errors.New("dependency has an invalid key")
					}
					dependencyMap[numeric] = value
				}
			} else {
				return nil, errors.New("dependency must be a map")
			}
		}
		dependencyType, typeOK := dependencyMap[0].(uint64)
		idBytes, idOK := dependencyMap[1].([]byte)
		if len(dependencyMap) != 2 || !typeOK || !idOK || len(idBytes) != 32 {
			return nil, errors.New("dependency has invalid fields")
		}
		copy(result[index].ID[:], idBytes)
		result[index].Type = dependencyType
	}
	if err := validateDependencies(result); err != nil {
		return nil, err
	}
	return result, nil
}

func decodeExtensions(value Value, field uint64) (map[string][]byte, error) {
	entry, ok := mapLookup(value, field)
	if !ok {
		return nil, errors.New("advisory extensions are missing")
	}
	result := map[string][]byte{}
	switch typed := entry.(type) {
	case map[string][]byte:
		for key, value := range typed {
			result[key] = append([]byte(nil), value...)
		}
	case map[any]any:
		for key, value := range typed {
			text, textOK := key.(string)
			bytesValue, bytesOK := value.([]byte)
			if !textOK || !bytesOK {
				return nil, errors.New("advisory extension has invalid fields")
			}
			result[text] = append([]byte(nil), bytesValue...)
		}
	default:
		return nil, errors.New("advisory extensions must be a map")
	}
	if err := validateValue(result, "advisory extensions"); err != nil {
		return nil, err
	}
	return result, nil
}

func numericValue(value Value, field uint64) (uint64, bool) {
	entry, ok := mapLookup(value, field)
	if !ok {
		return 0, false
	}
	numeric, ok := entry.(uint64)
	return numeric, ok
}

func signedValue(value Value, field uint64) (int64, bool) {
	entry, ok := mapLookup(value, field)
	if !ok {
		return 0, false
	}
	switch typed := entry.(type) {
	case int64:
		return typed, true
	case uint64:
		if typed <= uint64(^uint64(0)>>1) {
			return int64(typed), true
		}
	}
	return 0, false
}

func digest(label string, parts ...[]byte) Identifier {
	transcript, err := Transcript(label, parts...)
	if err != nil {
		panic(err)
	}
	return sha256.Sum256(transcript)
}
