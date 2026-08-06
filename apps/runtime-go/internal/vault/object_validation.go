package vault

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
	"golang.org/x/text/unicode/norm"
)

var canonicalMediaTypePattern = regexp.MustCompile(`^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9!#$&^_.+*-]+=[a-z0-9!#$&^_.+*-]+)*$`)

func validateReplicaObjectBody(objectType uint64, body canonical.Value) error {
	switch objectType {
	case 1:
		return validateBundleDescriptorBody(body)
	case 2:
		return validateArtifactObjectBody(body)
	case 3:
		return validateNoteContentObjectBody(body)
	default:
		return errors.New("Vault Object type is invalid")
	}
}

func validateBundleDescriptorBody(value canonical.Value) error {
	if !replicaMapHasKeys(value, 12) {
		return errors.New("Bundle Descriptor body is invalid")
	}
	if number, ok := replicaMapNumber(value, 0); !ok || number != 1 {
		return errors.New("Bundle Descriptor format is invalid")
	}
	if _, ok := replicaIdentifier(value, 1); !ok {
		return errors.New("Bundle Descriptor Bundle ID is invalid")
	}
	if _, ok := replicaMapSignedNumber(value, 2); !ok {
		return errors.New("Bundle Descriptor asserted timestamp is invalid")
	}
	if err := validateCanonicalURL(replicaMapEntryMust(value, 3), "Bundle Descriptor original URL"); err != nil {
		return err
	}
	if err := validateCanonicalURL(replicaMapEntryMust(value, 4), "Bundle Descriptor final URL"); err != nil {
		return err
	}
	profile, ok := replicaMapEntryMust(value, 5).(string)
	if !ok || !validateScopedKey(profile) {
		return errors.New("Bundle Descriptor capture profile is invalid")
	}
	adapter, ok := replicaMapEntryMust(value, 6).(string)
	if !ok || !validateScopedKey(adapter) {
		return errors.New("Bundle Descriptor capture adapter is invalid")
	}
	if _, ok := replicaUnsignedNumber(replicaMapEntryMust(value, 7)); !ok {
		return errors.New("Bundle Descriptor adapter revision is invalid")
	}
	if err := validateObjectNullableText(replicaMapEntryMust(value, 8), "Bundle Descriptor title", 1024, false); err != nil {
		return err
	}
	references, ok := replicaMapArray(value, 9)
	if !ok || len(references) == 0 {
		return errors.New("Bundle Descriptor Artifact references are invalid")
	}
	roles := make(map[string]struct{}, len(references))
	if err := validateCanonicalArrayOrder(references, "Bundle Descriptor Artifact references"); err != nil {
		return err
	}
	for index, reference := range references {
		if !replicaMapHasKeys(reference, 2) {
			return fmt.Errorf("Bundle Descriptor Artifact reference %d is invalid", index)
		}
		if _, ok := replicaIdentifier(reference, 0); !ok {
			return fmt.Errorf("Bundle Descriptor Artifact reference %d ID is invalid", index)
		}
		role, rolePresent := replicaMapEntry(reference, 1)
		roleText, roleOK := role.(string)
		if !rolePresent || !roleOK || !validateScopedKey(roleText) {
			return fmt.Errorf("Bundle Descriptor Artifact reference %d role is invalid", index)
		}
		if _, exists := roles[roleText]; exists {
			return errors.New("Bundle Descriptor repeats an Artifact role")
		}
		roles[roleText] = struct{}{}
		if profile == "awsm.capture.web-page-snapshot" && !baseArtifactRoles[roleText] {
			return errors.New("Base web Capture contains an unknown Artifact role")
		}
	}
	if profile == "awsm.capture.web-page-snapshot" {
		if _, ok := roles["awsm.artifact.primary"]; !ok {
			return errors.New("Base web Capture is missing its primary Artifact")
		}
	}
	warnings, ok := replicaMapArray(value, 10)
	if !ok {
		return errors.New("Bundle Descriptor Capture warnings are invalid")
	}
	if err := validateCanonicalArrayOrder(warnings, "Bundle Descriptor Capture warnings"); err != nil {
		return err
	}
	for index, warning := range warnings {
		if !replicaMapHasKeys(warning, 2) {
			return fmt.Errorf("Bundle Descriptor Capture warning %d is invalid", index)
		}
		key, keyPresent := replicaMapEntry(warning, 0)
		keyText, keyOK := key.(string)
		if !keyPresent || !keyOK || !validateScopedKey(keyText) {
			return fmt.Errorf("Bundle Descriptor Capture warning %d key is invalid", index)
		}
		detail, detailPresent := replicaMapEntry(warning, 1)
		if !detailPresent {
			return fmt.Errorf("Bundle Descriptor Capture warning %d detail is invalid", index)
		}
		if _, ok := detail.([]byte); !ok {
			return fmt.Errorf("Bundle Descriptor Capture warning %d detail is invalid", index)
		}
	}
	provenance, ok := replicaMapValue(replicaMapEntryMust(value, 11))
	if !ok {
		return errors.New("Bundle Descriptor provenance is invalid")
	}
	kind, ok := replicaUnsignedNumber(replicaMapEntryMust(provenance, 0))
	if !ok {
		return errors.New("Bundle Descriptor provenance kind is invalid")
	}
	switch kind {
	case 1:
		if !replicaMapHasKeys(provenance, 2) {
			return errors.New("Direct Capture provenance is invalid")
		}
		profileBytes, ok := replicaMapEntry(provenance, 1)
		if !ok {
			return errors.New("Direct Capture provenance bytes are invalid")
		}
		profileBytesBytes, ok := profileBytes.([]byte)
		if !ok {
			return errors.New("Direct Capture provenance bytes are invalid")
		}
		if profile == "awsm.capture.web-page-snapshot" {
			if adapter != "awsm.adapter.browser-web-page" {
				return errors.New("Base web Capture adapter identity is invalid")
			}
			if revision, _ := replicaUnsignedNumber(replicaMapEntryMust(value, 7)); revision != 1 {
				return errors.New("Base web Capture adapter revision is invalid")
			}
			if err := validateFormatOnlyBytes(profileBytesBytes, "Page Snapshot provenance"); err != nil {
				return err
			}
		}
	case 2:
		if !replicaMapHasKeys(provenance, 7) {
			return errors.New("Re-authored provenance is invalid")
		}
		for _, field := range []uint64{1, 2, 3, 4, 5} {
			if _, ok := replicaMapBytes(provenance, field, 32); !ok {
				return errors.New("Re-authored provenance identifier is invalid")
			}
		}
		profileBytes, ok := replicaMapEntry(provenance, 6)
		if !ok {
			return errors.New("Re-authored provenance bytes are invalid")
		}
		profileBytesBytes, ok := profileBytes.([]byte)
		if !ok {
			return errors.New("Re-authored provenance bytes are invalid")
		}
		if profile == "awsm.capture.web-page-snapshot" {
			if err := validateFormatOnlyBytes(profileBytesBytes, "Page Snapshot provenance"); err != nil {
				return err
			}
		}
	default:
		return errors.New("Unknown Bundle provenance kind")
	}
	return nil
}

var baseArtifactRoles = map[string]bool{
	"awsm.artifact.primary":            true,
	"awsm.artifact.screenshot-full":    true,
	"awsm.artifact.thumbnail":          true,
	"awsm.artifact.text-extracted":     true,
	"awsm.artifact.content-structured": true,
}

func validateArtifactObjectBody(value canonical.Value) error {
	if !replicaMapHasKeys(value, 8) {
		return errors.New("Artifact Object body is invalid")
	}
	if number, ok := replicaMapNumber(value, 0); !ok || number != 1 {
		return errors.New("Artifact Object format is invalid")
	}
	kind, ok := replicaMapEntryMust(value, 1).(string)
	if !ok || !validateScopedKey(kind) {
		return errors.New("Artifact kind is invalid")
	}
	mediaType, ok := replicaMapEntryMust(value, 2).(string)
	if !ok || !canonicalMediaTypePattern.MatchString(mediaType) {
		return errors.New("Artifact media type is invalid")
	}
	representation, ok := replicaMapEntryMust(value, 3).(string)
	if !ok || !validateScopedKey(representation) {
		return errors.New("Artifact representation is invalid")
	}
	plaintextLength, ok := replicaUnsignedNumber(replicaMapEntryMust(value, 4))
	if !ok {
		return errors.New("Artifact plaintext length is invalid")
	}
	digest, ok := replicaMapBytes(value, 5, 32)
	if !ok {
		return errors.New("Artifact plaintext digest is invalid")
	}
	contract, ok := replicaMapValue(replicaMapEntryMust(value, 6))
	if !ok || !replicaMapHasKeys(contract, 5) {
		return errors.New("Artifact wrapper contract is invalid")
	}
	format, formatOK := replicaMapNumber(contract, 0)
	frameLimit, frameLimitOK := replicaMapNumber(contract, 1)
	frameTagLength, frameTagLengthOK := replicaMapNumber(contract, 2)
	contractLength, lengthOK := replicaMapNumber(contract, 3)
	contractDigest, digestOK := replicaMapBytes(contract, 4, 32)
	if !formatOK || format != 1 || !frameLimitOK || frameLimit != storage.FramePlaintextLimit || !frameTagLengthOK || frameTagLength != storage.FrameTagLength || !lengthOK || contractLength != plaintextLength || !digestOK || !bytes.Equal(contractDigest, digest) {
		return errors.New("Artifact wrapper contract does not match its Object")
	}
	metadata, ok := replicaMapEntryMust(value, 7).([]byte)
	if !ok {
		return errors.New("Artifact intrinsic metadata is invalid")
	}
	switch representation {
	case "awsm.representation.web-page-zip":
		if kind != "awsm.artifact.capture" || mediaType != "application/vnd.awsm.web-page+zip" {
			return errors.New("Page Snapshot Artifact kind or media type is invalid")
		}
		return validateFormatOnlyBytes(metadata, "Page Snapshot intrinsic metadata")
	case "awsm.representation.webp.full", "awsm.representation.webp.thumbnail":
		if kind != "awsm.artifact.image" || mediaType != "image/webp" {
			return errors.New("WebP Artifact kind or media type is invalid")
		}
		metadataValue, err := canonical.DecodeValue(metadata)
		if err != nil || !replicaMapHasKeys(metadataValue, 3) {
			return errors.New("WebP intrinsic metadata is invalid")
		}
		format, formatOK := replicaMapNumber(metadataValue, 0)
		width, widthOK := replicaUnsignedNumber(replicaMapEntryMust(metadataValue, 1))
		height, heightOK := replicaUnsignedNumber(replicaMapEntryMust(metadataValue, 2))
		if !formatOK || format != 1 || !widthOK || !heightOK || width == 0 || height == 0 {
			return errors.New("WebP intrinsic metadata is invalid")
		}
		if representation == "awsm.representation.webp.thumbnail" && (width != 640 || height != 360) {
			return errors.New("Base thumbnail dimensions are invalid")
		}
	case "awsm.representation.text.utf-8":
		if kind != "awsm.artifact.text" || mediaType != "text/plain;charset=utf-8" {
			return errors.New("Extracted text Artifact kind or media type is invalid")
		}
		return validateFormatOnlyBytes(metadata, "Extracted text intrinsic metadata")
	case "awsm.representation.structured.cbor-seq":
		if kind != "awsm.artifact.structured" || mediaType != "application/cbor-seq" {
			return errors.New("Structured Artifact kind or media type is invalid")
		}
		return validateFormatOnlyBytes(metadata, "Structured Content intrinsic metadata")
	default:
		return errors.New("Unknown base Artifact representation key")
	}
	return nil
}

func validateNoteContentObjectBody(value canonical.Value) error {
	if !replicaMapHasKeys(value, 4) {
		return errors.New("Note Content body is invalid")
	}
	if number, ok := replicaMapNumber(value, 0); !ok || number != 1 {
		return errors.New("Note Content format is invalid")
	}
	if err := validateObjectNullableText(replicaMapEntryMust(value, 1), "Note title", 1024, false); err != nil {
		return err
	}
	body, ok := replicaMapEntryMust(value, 2).(string)
	if !ok || !validObjectText(body, true, true) || strings.Contains(body, "\r") || strings.Contains(body, "data:") || strings.Contains(body, "<") {
		return errors.New("Note body is invalid")
	}
	dialect, ok := replicaMapEntryMust(value, 3).(string)
	if !ok || dialect != "awsm.note.commonmark" {
		return errors.New("Note body dialect is invalid")
	}
	return nil
}

func validateCanonicalURL(value canonical.Value, field string) error {
	text, ok := value.(string)
	if !ok || !validObjectText(text, false, false) {
		return fmt.Errorf("%s must be an absolute URL", field)
	}
	parsed, err := url.Parse(text)
	if err != nil || !parsed.IsAbs() || parsed.Fragment != "" || parsed.String() != text {
		return fmt.Errorf("%s must be in canonical URL form", field)
	}
	return nil
}

func validateObjectNullableText(value canonical.Value, field string, maxBytes int, allowLineFeed bool) error {
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok || !validObjectText(text, allowLineFeed, false) {
		return fmt.Errorf("%s is invalid", field)
	}
	if len([]byte(text)) > maxBytes {
		return fmt.Errorf("%s exceeds its UTF-8 byte limit", field)
	}
	return nil
}

func validObjectText(value string, allowLineFeed, allowEmpty bool) bool {
	if !utf8.ValidString(value) || norm.NFC.String(value) != value || (!allowEmpty && value == "") {
		return false
	}
	for _, character := range value {
		if (character < 0x20 || character == 0x7f) && !(allowLineFeed && character == '\n') {
			return false
		}
	}
	return true
}

func validateScopedKey(value string) bool {
	if len(value) == 0 || len(value) > 128 || !strings.Contains(value, ".") {
		return false
	}
	for index, character := range []byte(value) {
		if character > 0x7f || (index == 0 && (character < 'a' || character > 'z')) {
			return false
		}
		if !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-') {
			return false
		}
	}
	for _, separator := range []string{"..", "._", ".-", "_.", "_-", "-.", "-_", "__", "--"} {
		if strings.Contains(value, separator) {
			return false
		}
	}
	last := value[len(value)-1]
	return (last >= 'a' && last <= 'z') || (last >= '0' && last <= '9')
}

func replicaUnsignedNumber(value canonical.Value) (uint64, bool) {
	if number, ok := value.(uint64); ok {
		return number, true
	}
	if number, ok := value.(int64); ok && number >= 0 {
		return uint64(number), true
	}
	return 0, false
}

func validateFormatOnlyBytes(encoded []byte, field string) error {
	value, err := canonical.DecodeValue(encoded)
	if err != nil || !replicaMapHasKeys(value, 1) {
		return fmt.Errorf("%s is invalid", field)
	}
	if number, ok := replicaMapNumber(value, 0); !ok || number != 1 {
		return fmt.Errorf("%s format is invalid", field)
	}
	return nil
}

func validateCanonicalArrayOrder(values []canonical.Value, field string) error {
	var previous []byte
	for _, value := range values {
		encoded, err := canonical.EncodeValue(value)
		if err != nil {
			return fmt.Errorf("%s contains a non-canonical value", field)
		}
		if previous != nil && bytes.Compare(previous, encoded) >= 0 {
			return fmt.Errorf("%s must be a sorted duplicate-free canonical set", field)
		}
		previous = encoded
	}
	return nil
}
