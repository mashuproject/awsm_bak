package vault

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

// LibraryItem is the stable Client-facing capture projection. Heavy wrappers
// are deliberately represented by their logical Artifact ID and an honest
// local-availability bit; the projection never treats a descriptor as proof
// that the Artifact bytes are present.
type LibraryItem struct {
	BundleID         string  `json:"bundleId"`
	CollectionID     string  `json:"collectionId"`
	ArtifactID       string  `json:"artifactId"`
	CapturedAt       int64   `json:"capturedAt"`
	OriginalURL      string  `json:"originalUrl"`
	FinalURL         string  `json:"finalUrl"`
	Title            *string `json:"title"`
	AvailableLocally bool    `json:"availableLocally"`
	Lifecycle        string  `json:"lifecycle"`
}

type libraryCapture struct {
	item         LibraryItem
	lifecycleID  canonical.Identifier
	collectionID canonical.Identifier
}

// ProjectLibrary reduces Bundle Registered, Capture lifecycle, and placement
// Events over the authenticated Replica DAG. Missing descriptor Objects are a
// hard projection error: displaying a partial capture would claim metadata
// that the Runtime has not verified.
func ProjectLibrary(replica *Replica) ([]LibraryItem, error) {
	if replica == nil {
		return nil, errors.New("Replica is required")
	}
	captures := make(map[string]*libraryCapture)
	for _, event := range replica.Events() {
		if event.Family != canonical.ContentFamily {
			continue
		}
		switch event.Type {
		case 3:
			capture, err := registeredCapture(replica, event)
			if err != nil {
				return nil, err
			}
			key := hexIdentifier(capture.collectionID)
			_ = key
			bundleKey := capture.item.BundleID
			if existing, ok := captures[bundleKey]; ok {
				if existing.item.ArtifactID != capture.item.ArtifactID || existing.item.CollectionID != capture.item.CollectionID {
					return nil, fmt.Errorf("Capture identity conflict for Bundle %s", bundleKey)
				}
				continue
			}
			captures[bundleKey] = capture
		case 4, 5:
			ids, err := bundleIDSet(event.Body)
			if err != nil {
				return nil, err
			}
			for _, bundleID := range ids {
				capture := captures[hexIdentifier(bundleID)]
				if capture == nil || !newerEvent(replica, capture.lifecycleID, event.RecordID) {
					continue
				}
				capture.lifecycleID = event.RecordID
				if event.Type == 4 {
					capture.item.Lifecycle = "Deleted"
				} else {
					capture.item.Lifecycle = "Active"
				}
			}
		case 6:
			moves, err := captureMoves(event.Body)
			if err != nil {
				return nil, err
			}
			for _, move := range moves {
				capture := captures[hexIdentifier(move.bundleID)]
				if capture == nil || !newerEvent(replica, capture.collectionID, event.RecordID) {
					continue
				}
				capture.collectionID = event.RecordID
				capture.item.CollectionID = hexIdentifier(move.destinationID)
			}
		}
	}
	items := make([]LibraryItem, 0, len(captures))
	for _, capture := range captures {
		items = append(items, capture.item)
	}
	sort.Slice(items, func(left, right int) bool { return items[left].BundleID < items[right].BundleID })
	return items, nil
}

func registeredCapture(replica *Replica, event canonical.Event) (*libraryCapture, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 3) {
		return nil, errors.New("Bundle Registered body is invalid")
	}
	bundleID, ok := replicaIdentifier(body, 0)
	if !ok {
		return nil, errors.New("Bundle Registered Bundle ID is invalid")
	}
	descriptorID, ok := replicaIdentifier(body, 1)
	if !ok {
		return nil, errors.New("Bundle Registered Descriptor Object ID is invalid")
	}
	collectionID, ok := replicaIdentifier(body, 2)
	if !ok {
		return nil, errors.New("Bundle Registered Collection ID is invalid")
	}
	descriptor, ok := replica.Object(descriptorID)
	if !ok || descriptor.ObjectType != 1 {
		return nil, errors.New("Bundle Descriptor Object is unavailable")
	}
	metadata, err := parseBundleDescriptorMetadata(descriptor.Body)
	if err != nil {
		return nil, err
	}
	primary, ok := replica.Object(metadata.primaryObjectID)
	item := LibraryItem{
		BundleID:         hexIdentifier(bundleID),
		CollectionID:     hexIdentifier(collectionID),
		ArtifactID:       hexIdentifier(metadata.primaryObjectID),
		CapturedAt:       metadata.capturedAt,
		OriginalURL:      metadata.originalURL,
		FinalURL:         metadata.finalURL,
		Title:            metadata.title,
		AvailableLocally: ok && primary.ObjectType == 2,
		Lifecycle:        "Active",
	}
	return &libraryCapture{item: item, lifecycleID: event.RecordID, collectionID: event.RecordID}, nil
}

type descriptorMetadata struct {
	bundleID        canonical.Identifier
	capturedAt      int64
	originalURL     string
	finalURL        string
	title           *string
	primaryObjectID canonical.Identifier
}

func parseBundleDescriptorMetadata(body canonical.Value) (descriptorMetadata, error) {
	if !replicaMapHasKeys(body, 12) {
		return descriptorMetadata{}, errors.New("Bundle Descriptor body is invalid")
	}
	bundleID, ok := replicaIdentifier(body, 1)
	if !ok {
		return descriptorMetadata{}, errors.New("Bundle Descriptor Bundle ID is invalid")
	}
	capturedAt, ok := replicaMapSignedNumber(body, 2)
	if !ok {
		return descriptorMetadata{}, errors.New("Bundle Descriptor captured timestamp is invalid")
	}
	originalURL, ok := replicaMapText(body, 3)
	if !ok || originalURL == "" {
		return descriptorMetadata{}, errors.New("Bundle Descriptor original URL is invalid")
	}
	finalURL, ok := replicaMapText(body, 4)
	if !ok || finalURL == "" {
		return descriptorMetadata{}, errors.New("Bundle Descriptor final URL is invalid")
	}
	title, ok := replicaMapNullableText(body, 8)
	if !ok {
		return descriptorMetadata{}, errors.New("Bundle Descriptor title is invalid")
	}
	entries, ok := replicaMapArray(body, 9)
	if !ok || len(entries) == 0 {
		return descriptorMetadata{}, errors.New("Bundle Descriptor Artifact references are invalid")
	}
	var primary canonical.Identifier
	for _, entry := range entries {
		if !replicaMapHasKeys(entry, 2) {
			return descriptorMetadata{}, errors.New("Bundle Descriptor Artifact reference is invalid")
		}
		objectID, ok := replicaIdentifier(entry, 0)
		role, roleOK := replicaMapText(entry, 1)
		if !ok || !roleOK {
			return descriptorMetadata{}, errors.New("Bundle Descriptor Artifact reference fields are invalid")
		}
		if role == "awsm.artifact.primary" {
			if primary != (canonical.Identifier{}) {
				return descriptorMetadata{}, errors.New("Bundle Descriptor repeats its primary Artifact")
			}
			primary = objectID
		}
	}
	if primary == (canonical.Identifier{}) {
		return descriptorMetadata{}, errors.New("Bundle Descriptor has no primary Artifact")
	}
	return descriptorMetadata{bundleID: bundleID, capturedAt: capturedAt, originalURL: originalURL, finalURL: finalURL, title: title, primaryObjectID: primary}, nil
}

func bundleIDSet(body canonical.Value) ([]canonical.Identifier, error) {
	value, ok := replicaMapEntry(body, 0)
	if !ok {
		return nil, errors.New("Capture lifecycle body is invalid")
	}
	entries, ok := replicaMapArrayValue(value)
	if !ok || len(entries) == 0 {
		return nil, errors.New("Capture lifecycle Bundle IDs are invalid")
	}
	result := make([]canonical.Identifier, 0, len(entries))
	for _, entry := range entries {
		id, ok := replicaIdentifierValue(entry)
		if !ok {
			return nil, errors.New("Capture lifecycle Bundle ID is invalid")
		}
		result = append(result, id)
	}
	return result, nil
}

type captureMove struct {
	bundleID      canonical.Identifier
	destinationID canonical.Identifier
}

func captureMoves(body canonical.Value) ([]captureMove, error) {
	value, ok := replicaMapEntry(body, 0)
	if !ok {
		return nil, errors.New("Capture move body is invalid")
	}
	entries, ok := replicaMapArrayValue(value)
	if !ok || len(entries) == 0 {
		return nil, errors.New("Capture move entries are invalid")
	}
	result := make([]captureMove, 0, len(entries))
	for _, entry := range entries {
		if !replicaMapHasKeys(entry, 3) {
			return nil, errors.New("Capture move entry is invalid")
		}
		bundleID, ok := replicaIdentifier(entry, 0)
		destinationID, destinationOK := replicaIdentifier(entry, 2)
		if !ok || !destinationOK {
			return nil, errors.New("Capture move IDs are invalid")
		}
		result = append(result, captureMove{bundleID: bundleID, destinationID: destinationID})
	}
	return result, nil
}

func newerEvent(replica *Replica, previous, candidate canonical.Identifier) bool {
	if previous == (canonical.Identifier{}) {
		return true
	}
	if replica.IsAncestor(previous, candidate) {
		return true
	}
	if replica.IsAncestor(candidate, previous) {
		return false
	}
	return bytes.Compare(candidate[:], previous[:]) > 0
}

func replicaIdentifier(value canonical.Value, key uint64) (canonical.Identifier, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return canonical.Identifier{}, false
	}
	return replicaIdentifierValue(entry)
}

func replicaIdentifierValue(value canonical.Value) (canonical.Identifier, bool) {
	bytesValue, ok := value.([]byte)
	if !ok || len(bytesValue) != 32 {
		return canonical.Identifier{}, false
	}
	var identifier canonical.Identifier
	copy(identifier[:], bytesValue)
	return identifier, true
}

func replicaMapText(value canonical.Value, key uint64) (string, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return "", false
	}
	text, ok := entry.(string)
	return text, ok
}

func replicaMapNullableText(value canonical.Value, key uint64) (*string, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return nil, false
	}
	if entry == nil {
		return nil, true
	}
	text, ok := entry.(string)
	if !ok {
		return nil, false
	}
	return &text, true
}

func replicaMapSignedNumber(value canonical.Value, key uint64) (int64, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return 0, false
	}
	signed, ok := entry.(int64)
	if ok {
		return signed, true
	}
	unsigned, ok := entry.(uint64)
	return int64(unsigned), ok && unsigned <= uint64(^uint64(0)>>1)
}

func replicaMapArray(value canonical.Value, key uint64) ([]canonical.Value, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return nil, false
	}
	return replicaMapArrayValue(entry)
}

func replicaMapArrayValue(value canonical.Value) ([]canonical.Value, bool) {
	entries, ok := value.([]canonical.Value)
	return entries, ok
}
