package canonical

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/fxamacker/cbor/v2"
	"golang.org/x/text/unicode/norm"
)

// Map is the convenient representation for the numeric-keyed canonical maps
// used by the current Vault codecs. Decoding also accepts the generic map form
// emitted by fxamacker/cbor for maps that contain text keys.
type Map map[uint64]any

type Value = any

var canonicalEncoder = func() cbor.EncMode {
	options := cbor.CanonicalEncOptions()
	options.TagsMd = cbor.TagsForbidden
	options.NilContainers = cbor.NilContainerAsEmpty
	mode, err := options.EncMode()
	if err != nil {
		panic(err)
	}
	return mode
}()

var canonicalDecoder = func() cbor.DecMode {
	options := cbor.DecOptions{
		DupMapKey:        cbor.DupMapKeyEnforcedAPF,
		IndefLength:      cbor.IndefLengthForbidden,
		TagsMd:           cbor.TagsForbidden,
		IntDec:           cbor.IntDecConvertNone,
		MaxArrayElements: 1_000_000,
		MaxMapPairs:      1_000_000,
		MaxNestedLevels:  128,
	}
	mode, err := options.DecMode()
	if err != nil {
		panic(err)
	}
	return mode
}()

// EncodeValue validates and encodes one restricted canonical CBOR value.
func EncodeValue(value Value) ([]byte, error) {
	if err := validateValue(value, "value"); err != nil {
		return nil, err
	}
	encoded, err := canonicalEncoder.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode canonical value: %w", err)
	}
	return encoded, nil
}

// DecodeValue parses exactly one restricted canonical CBOR value and rejects
// equivalent non-canonical bytes.
func DecodeValue(encoded []byte) (Value, error) {
	var value Value
	rest, err := canonicalDecoder.UnmarshalFirst(encoded, &value)
	if err != nil {
		return nil, fmt.Errorf("decode canonical value: %w", err)
	}
	if len(rest) != 0 {
		return nil, errors.New("decode canonical value: trailing bytes")
	}
	if err := validateValue(value, "value"); err != nil {
		return nil, err
	}
	reencoded, err := EncodeValue(value)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(encoded, reencoded) {
		return nil, errors.New("decode canonical value: non-canonical CBOR")
	}
	return value, nil
}

func validateValue(value Value, path string) error {
	switch typed := value.(type) {
	case nil, bool:
		return nil
	case uint64, int64:
		return nil
	case uint, uint32, uint16, uint8, int, int32, int16, int8:
		return fmt.Errorf("%s uses a non-canonical Go integer type", path)
	case string:
		if !utf8.ValidString(typed) || norm.NFC.String(typed) != typed {
			return fmt.Errorf("%s text must be valid UTF-8 Unicode NFC", path)
		}
		return nil
	case []byte:
		return nil
	case []Value:
		for index, entry := range typed {
			if err := validateValue(entry, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
		return nil
	case Map:
		for key, entry := range typed {
			if err := validateValue(entry, fmt.Sprintf("%s[%d]", path, key)); err != nil {
				return err
			}
		}
		return nil
	case map[any]any:
		for key, entry := range typed {
			if err := validateMapKey(key, path); err != nil {
				return err
			}
			if err := validateValue(entry, fmt.Sprintf("%s[%v]", path, key)); err != nil {
				return err
			}
		}
		return nil
	case map[string][]byte:
		for key, entry := range typed {
			if err := validateScopedKey(key); err != nil {
				return fmt.Errorf("%s key %q: %w", path, key, err)
			}
			if err := validateValue(entry, fmt.Sprintf("%s[%s]", path, key)); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("%s contains prohibited canonical type %T", path, value)
	}
}

func validateMapKey(key any, path string) error {
	switch typed := key.(type) {
	case uint64:
		return nil
	case int64:
		if typed < 0 {
			return fmt.Errorf("%s has a negative numeric map key", path)
		}
		return nil
	case string:
		return validateScopedKey(typed)
	default:
		return fmt.Errorf("%s has an unsupported map key type %T", path, key)
	}
}

func validateScopedKey(value string) error {
	if len(value) == 0 || len(value) > 128 || !strings.Contains(value, ".") {
		return errors.New("canonical scoped key is invalid")
	}
	for index, character := range []byte(value) {
		if character > 0x7f || (index == 0 && (character < 'a' || character > 'z')) {
			return errors.New("canonical scoped key is invalid")
		}
		if !(character >= 'a' && character <= 'z') &&
			!(character >= '0' && character <= '9') &&
			character != '.' && character != '_' && character != '-' {
			return errors.New("canonical scoped key is invalid")
		}
	}
	for _, separator := range []string{"..", "._", ".-", "_.", "_-", "-.", "-_", "__", "--"} {
		if strings.Contains(value, separator) {
			return errors.New("canonical scoped key is invalid")
		}
	}
	last := value[len(value)-1]
	if !((last >= 'a' && last <= 'z') || (last >= '0' && last <= '9')) {
		return errors.New("canonical scoped key is invalid")
	}
	return nil
}

func canonicalSet(values []Value) ([]Value, error) {
	type entry struct {
		encoded []byte
		value   Value
	}
	entries := make([]entry, 0, len(values))
	for _, value := range values {
		encoded, err := EncodeValue(value)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry{encoded: encoded, value: value})
	}
	sort.Slice(entries, func(left, right int) bool {
		return bytes.Compare(entries[left].encoded, entries[right].encoded) < 0
	})
	for index := 1; index < len(entries); index++ {
		if bytes.Equal(entries[index-1].encoded, entries[index].encoded) {
			return nil, errors.New("canonical set contains a duplicate")
		}
	}
	result := make([]Value, len(entries))
	for index, entry := range entries {
		result[index] = entry.value
	}
	return result, nil
}

func mapLookup(value Value, key uint64) (Value, bool) {
	switch typed := value.(type) {
	case Map:
		entry, ok := typed[key]
		return entry, ok
	case map[any]any:
		entry, ok := typed[key]
		return entry, ok
	default:
		return nil, false
	}
}

func mapKeys(value Value) []uint64 {
	switch typed := value.(type) {
	case Map:
		keys := make([]uint64, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		return keys
	case map[any]any:
		keys := make([]uint64, 0, len(typed))
		for key := range typed {
			if numeric, ok := key.(uint64); ok {
				keys = append(keys, numeric)
			}
		}
		return keys
	default:
		return nil
	}
}

func isMap(value Value) bool {
	return reflect.TypeOf(value) == reflect.TypeOf(Map{}) || reflect.TypeOf(value) == reflect.TypeOf(map[any]any{})
}
