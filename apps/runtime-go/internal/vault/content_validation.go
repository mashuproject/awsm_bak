package vault

import (
	"bytes"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"golang.org/x/text/unicode/norm"
)

// validateContentEvent validates the first capture/content event boundary
// shared by every Runtime surface. Later organization and Note reducers build
// on this same exact-body and exact-dependency contract.
func validateContentEvent(event canonical.Event) error {
	if event.Family != canonical.ContentFamily || event.Type < 1 || event.Type > 6 {
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
	if !utf8.ValidString(text) || norm.NFC.String(text) != text {
		return fmt.Errorf("%s must be valid NFC text", field)
	}
	if len([]byte(text)) > 1024 {
		return fmt.Errorf("%s exceeds 1024 UTF-8 bytes", field)
	}
	return nil
}

func requireContentDependencies(event canonical.Event, expected []canonical.Dependency) error {
	if len(event.Dependencies) != len(expected) {
		return fmt.Errorf("Content Event %d dependencies are not exact", event.Type)
	}
	for index, dependency := range expected {
		actual := event.Dependencies[index]
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
