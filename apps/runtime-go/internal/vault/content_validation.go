package vault

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

// validateContentEvent validates the first capture/content event boundary
// shared by every Runtime surface. Later organization and Note reducers build
// on this same exact-body and exact-dependency contract.
func validateContentEvent(event canonical.Event) error {
	if event.Family != canonical.ContentFamily || event.Type < 1 || event.Type > 31 {
		return nil
	}
	switch event.Type {
	case 1:
		if !replicaMapHasKeys(event.Body, 1) {
			return errors.New("Vault Label body is invalid")
		}
		if err := validateContentLabel(replicaMapEntryMust(event.Body, 0), "Vault label"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 2:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Client Credential Label body is invalid")
		}
		if _, ok := replicaIdentifierValue(replicaMapEntryMust(event.Body, 0)); !ok {
			return errors.New("Client Credential Label Client Credential ID is invalid")
		}
		if err := validateContentLabel(replicaMapEntryMust(event.Body, 1), "Client Credential label"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 3:
		if !replicaMapHasKeys(event.Body, 3) {
			return errors.New("Bundle Registered body is invalid")
		}
		if _, ok := replicaIdentifierValue(replicaMapEntryMust(event.Body, 0)); !ok {
			return errors.New("Bundle Registered Bundle ID is invalid")
		}
		descriptorID, ok := replicaIdentifierValue(replicaMapEntryMust(event.Body, 1))
		if !ok {
			return errors.New("Bundle Registered Descriptor Object ID is invalid")
		}
		if _, ok := replicaIdentifierValue(replicaMapEntryMust(event.Body, 2)); !ok {
			return errors.New("Bundle Registered Collection ID is invalid")
		}
		return requireContentDependencies(event, []canonical.Dependency{{Type: 4, ID: descriptorID}})
	case 4, 5:
		if !replicaMapHasKeys(event.Body, 1) {
			return fmt.Errorf("Content Event %d body is invalid", event.Type)
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Bundle IDs", true); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 6:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Captures Moved body is invalid")
		}
		if err := validateCaptureMoves(replicaMapEntryMust(event.Body, 0)); err != nil {
			return err
		}
		cause := replicaMapEntryMust(event.Body, 1)
		if cause != nil {
			if _, ok := replicaIdentifierValue(cause); !ok {
				return errors.New("Reverted move Cause ID is invalid")
			}
		}
		return requireContentDependencies(event, nil)
	case 7:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Collection Title body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Collection Title Collection ID is invalid")
		}
		if err := validateContentLabel(replicaMapEntryMust(event.Body, 1), "Collection title"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 8:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Collections Merged body is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Source Collection IDs", true); err != nil {
			return err
		}
		if _, ok := replicaIdentifier(event.Body, 1); !ok {
			return errors.New("Destination Collection ID is invalid")
		}
		return requireContentDependencies(event, nil)
	case 9:
		if !replicaMapHasKeys(event.Body, 1) {
			return errors.New("Collection Merge Reverted body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Collection redirect Cause ID is invalid")
		}
		return requireContentDependencies(event, nil)
	case 10:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Collection Merge Conflict Resolution body is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Conflicting Collection Cause IDs", true); err != nil {
			return err
		}
		if err := validateContentRedirects(replicaMapEntryMust(event.Body, 1), "Collection"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 11:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Collection Folder Placement body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Collection Folder Placement Collection ID is invalid")
		}
		if err := validateNullableIdentifier(event.Body, 1, "Folder ID"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 12:
		if !replicaMapHasKeys(event.Body, 3) {
			return errors.New("Folder Created body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Folder Created Folder ID is invalid")
		}
		if err := validateContentRequiredText(replicaMapEntryMust(event.Body, 1), "Folder name"); err != nil {
			return err
		}
		if err := validateNullableIdentifier(event.Body, 2, "Parent Folder ID"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 13:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Folder Renamed body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Folder Renamed Folder ID is invalid")
		}
		if err := validateContentRequiredText(replicaMapEntryMust(event.Body, 1), "Folder name"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 14:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Folder Parent Placement body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Folder Parent Placement Folder ID is invalid")
		}
		if err := validateNullableIdentifier(event.Body, 1, "Parent Folder ID"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 15, 16:
		if !replicaMapHasKeys(event.Body, 1) {
			return fmt.Errorf("Content Event %d body is invalid", event.Type)
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return fmt.Errorf("Content Event %d Folder ID is invalid", event.Type)
		}
		return requireContentDependencies(event, nil)
	case 17:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Folder Conflict Resolution body is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Conflicting Folder Cause IDs", true); err != nil {
			return err
		}
		if err := validateContentIDKeyedArray(replicaMapEntryMust(event.Body, 1), "Folder placements", "Folder", func(entry canonical.Value) error {
			if !replicaMapHasKeys(entry, 2) {
				return errors.New("Folder placement is invalid")
			}
			if _, ok := replicaIdentifier(entry, 0); !ok {
				return errors.New("Folder placement Folder ID is invalid")
			}
			return validateNullableIdentifier(entry, 1, "Parent Folder ID")
		}); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 18, 19:
		if !replicaMapHasKeys(event.Body, 2) {
			return fmt.Errorf("Content Event %d body is invalid", event.Type)
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return fmt.Errorf("Content Event %d Tag ID is invalid", event.Type)
		}
		if err := validateContentRequiredText(replicaMapEntryMust(event.Body, 1), "Tag name"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 20:
		if !replicaMapHasKeys(event.Body, 3) {
			return errors.New("Tag Assigned body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Tag Assignment ID is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 1); !ok {
			return errors.New("Tag ID is invalid")
		}
		if err := validateContentTarget(replicaMapEntryMust(event.Body, 2), "Tag assignment target"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 21:
		if !replicaMapHasKeys(event.Body, 1) {
			return errors.New("Tag Removed body is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Tag Assignment Cause IDs", true); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 22, 23:
		if !replicaMapHasKeys(event.Body, 1) {
			return fmt.Errorf("Content Event %d body is invalid", event.Type)
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return fmt.Errorf("Content Event %d Tag ID is invalid", event.Type)
		}
		return requireContentDependencies(event, nil)
	case 24:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Tags Merged body is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Source Tag IDs", true); err != nil {
			return err
		}
		if _, ok := replicaIdentifier(event.Body, 1); !ok {
			return errors.New("Destination Tag ID is invalid")
		}
		return requireContentDependencies(event, nil)
	case 25:
		if !replicaMapHasKeys(event.Body, 1) {
			return errors.New("Tag Merge Reverted body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Tag redirect Cause ID is invalid")
		}
		return requireContentDependencies(event, nil)
	case 26:
		if !replicaMapHasKeys(event.Body, 2) {
			return errors.New("Tag Merge Conflict Resolution body is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Conflicting Tag Cause IDs", true); err != nil {
			return err
		}
		if err := validateContentRedirects(replicaMapEntryMust(event.Body, 1), "Tag"); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 27:
		if !replicaMapHasKeys(event.Body, 3) {
			return errors.New("Note Created body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Note Created Note ID is invalid")
		}
		if err := validateContentTarget(replicaMapEntryMust(event.Body, 1), "Note target"); err != nil {
			return err
		}
		contentID, ok := replicaIdentifier(event.Body, 2)
		if !ok {
			return errors.New("Note Created Content Object ID is invalid")
		}
		return requireContentDependencies(event, []canonical.Dependency{{Type: 6, ID: contentID}})
	case 28:
		if !replicaMapHasKeys(event.Body, 3) {
			return errors.New("Note Revised body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Note Revised Note ID is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 1), "Superseded Note revision Cause IDs", true); err != nil {
			return err
		}
		contentID, ok := replicaIdentifier(event.Body, 2)
		if !ok {
			return errors.New("Note Revised Content Object ID is invalid")
		}
		return requireContentDependencies(event, []canonical.Dependency{{Type: 6, ID: contentID}})
	case 29, 30:
		if !replicaMapHasKeys(event.Body, 2) {
			return fmt.Errorf("Content Event %d body is invalid", event.Type)
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return fmt.Errorf("Content Event %d Note ID is invalid", event.Type)
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 1), "Observed Note head Cause IDs", true); err != nil {
			return err
		}
		return requireContentDependencies(event, nil)
	case 31:
		if !replicaMapHasKeys(event.Body, 4) {
			return errors.New("Note Conflict Resolution body is invalid")
		}
		if _, ok := replicaIdentifier(event.Body, 0); !ok {
			return errors.New("Note Conflict Resolution Note ID is invalid")
		}
		if _, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 1), "Conflicting Note head Cause IDs", true); err != nil {
			return err
		}
		expected := make([]canonical.Dependency, 0)
		if retained := replicaMapEntryMust(event.Body, 2); retained != nil {
			contentID, ok := replicaIdentifierValue(retained)
			if !ok {
				return errors.New("Retained Note Content Object ID is invalid")
			}
			expected = append(expected, canonical.Dependency{Type: 6, ID: contentID})
		}
		if err := validateContentIDKeyedArray(replicaMapEntryMust(event.Body, 3), "Split Notes", "Note", func(entry canonical.Value) error {
			if !replicaMapHasKeys(entry, 2) {
				return errors.New("Split Note is invalid")
			}
			if _, ok := replicaIdentifier(entry, 0); !ok {
				return errors.New("Split Note ID is invalid")
			}
			contentID, ok := replicaIdentifier(entry, 1)
			if !ok {
				return errors.New("Split Note Content Object ID is invalid")
			}
			expected = append(expected, canonical.Dependency{Type: 6, ID: contentID})
			return nil
		}); err != nil {
			return err
		}
		return requireContentDependencies(event, expected)
	default:
		return nil
	}
}

func validateContentLabel(value canonical.Value, field string) error {
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("%s is invalid", field)
	}
	if !validObjectText(text, false, true) {
		return fmt.Errorf("%s must be valid NFC text", field)
	}
	if len([]byte(text)) > 1024 {
		return fmt.Errorf("%s exceeds 1024 UTF-8 bytes", field)
	}
	return nil
}

func validateContentRequiredText(value canonical.Value, field string) error {
	if err := validateContentLabel(value, field); err != nil {
		return err
	}
	if text, ok := value.(string); !ok || text == "" {
		return fmt.Errorf("%s must not be empty", field)
	}
	return nil
}

func validateNullableIdentifier(value canonical.Value, key uint64, field string) error {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return fmt.Errorf("%s is missing", field)
	}
	if entry == nil {
		return nil
	}
	if _, ok := replicaIdentifierValue(entry); !ok {
		return fmt.Errorf("%s is invalid", field)
	}
	return nil
}

func validateContentTarget(value canonical.Value, field string) error {
	if !replicaMapHasKeys(value, 2) {
		return fmt.Errorf("%s is invalid", field)
	}
	kind, ok := replicaUnsignedNumber(replicaMapEntryMust(value, 0))
	if !ok || (kind != 1 && kind != 2) {
		return fmt.Errorf("%s kind is invalid", field)
	}
	if _, ok := replicaIdentifierValue(replicaMapEntryMust(value, 1)); !ok {
		return fmt.Errorf("%s ID is invalid", field)
	}
	return nil
}

func validateContentRedirects(value canonical.Value, kind string) error {
	entries, ok := replicaMapArrayValue(value)
	if !ok {
		return fmt.Errorf("%s redirects are invalid", kind)
	}
	if err := validateCanonicalArrayOrder(entries, kind+" redirects"); err != nil {
		return err
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 2) {
			return fmt.Errorf("%s redirect %d is invalid", kind, index)
		}
		if _, ok := replicaIdentifier(entry, 0); !ok {
			return fmt.Errorf("%s redirect %d source ID is invalid", kind, index)
		}
		if _, ok := replicaIdentifier(entry, 1); !ok {
			return fmt.Errorf("%s redirect %d destination ID is invalid", kind, index)
		}
	}
	return nil
}

func validateContentIDKeyedArray(value canonical.Value, field, kind string, validate func(canonical.Value) error) error {
	entries, ok := replicaMapArrayValue(value)
	if !ok {
		return fmt.Errorf("%s are invalid", field)
	}
	var previous canonical.Identifier
	for index, entry := range entries {
		if err := validate(entry); err != nil {
			return fmt.Errorf("%s entry %d: %w", field, index, err)
		}
		id, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("%s entry %d %s ID is invalid", field, index, kind)
		}
		if index > 0 && bytes.Compare(previous[:], id[:]) >= 0 {
			return fmt.Errorf("%s must be sorted by unique %s ID", field, kind)
		}
		previous = id
	}
	return nil
}

func requireContentDependencies(event canonical.Event, expected []canonical.Dependency) error {
	if len(event.Dependencies) != len(expected) {
		return fmt.Errorf("Content Event %d dependencies are not exact", event.Type)
	}
	actual := append([]canonical.Dependency(nil), event.Dependencies...)
	required := append([]canonical.Dependency(nil), expected...)
	compare := func(left, right canonical.Dependency) int {
		if left.Type < right.Type {
			return -1
		}
		if left.Type > right.Type {
			return 1
		}
		return bytes.Compare(left.ID[:], right.ID[:])
	}
	sort.Slice(actual, func(left, right int) bool { return compare(actual[left], actual[right]) < 0 })
	sort.Slice(required, func(left, right int) bool { return compare(required[left], required[right]) < 0 })
	for index, dependency := range required {
		actualDependency := actual[index]
		if index > 0 && compare(required[index-1], dependency) == 0 {
			return fmt.Errorf("Content Event %d dependencies are not exact", event.Type)
		}
		actual := actualDependency
		if actual.Type != dependency.Type || !bytes.Equal(actual.ID[:], dependency.ID[:]) {
			return fmt.Errorf("Content Event %d dependencies are not exact", event.Type)
		}
	}
	return nil
}

func validateCaptureMoves(value canonical.Value) error {
	entries, ok := replicaMapArrayValue(value)
	if !ok || len(entries) == 0 {
		return errors.New("Capture moves must not be empty")
	}
	var previous canonical.Identifier
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 3) {
			return fmt.Errorf("Capture move %d is invalid", index)
		}
		bundleID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Capture move %d Bundle ID is invalid", index)
		}
		if _, ok := replicaIdentifier(entry, 1); !ok {
			return fmt.Errorf("Capture move %d Source Collection ID is invalid", index)
		}
		if _, ok := replicaIdentifier(entry, 2); !ok {
			return fmt.Errorf("Capture move %d Destination Collection ID is invalid", index)
		}
		if index > 0 && bytes.Compare(previous[:], bundleID[:]) >= 0 {
			return errors.New("Capture moves must be sorted by unique Bundle ID")
		}
		previous = bundleID
	}
	return nil
}
