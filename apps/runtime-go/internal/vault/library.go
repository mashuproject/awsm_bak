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

// LibraryCollection is the deterministic Collection projection used by the
// Client Library. Collection identity is its stable ID; title and tail are
// derived from authenticated Content Events and active captures.
type LibraryCollection struct {
	CollectionID       string  `json:"collectionId"`
	ExplicitTitle      *string `json:"explicitTitle"`
	Title              string  `json:"title"`
	TailBundleID       *string `json:"tailBundleId"`
	ActiveCaptureCount int     `json:"activeCaptureCount"`
	RedirectedTo       *string `json:"redirectedTo"`
	FolderID           *string `json:"folderId"`
}

// LibraryProjection is a rebuildable user-facing view. It is derived solely
// from the authenticated Replica and is never an authority source.
type LibraryProjection struct {
	Captures    []LibraryItem       `json:"captures"`
	Collections []LibraryCollection `json:"collections"`
}

type libraryCapture struct {
	item           LibraryItem
	registrationID canonical.Identifier
	lifecycleID    canonical.Identifier
	collectionID   canonical.Identifier
}

// ProjectLibrary reduces Bundle Registered, Capture lifecycle, and placement
// Events over the authenticated Replica DAG. Missing descriptor Objects are a
// hard projection error: displaying a partial capture would claim metadata
// that the Runtime has not verified.
func ProjectLibrary(replica *Replica) ([]LibraryItem, error) {
	projection, err := ProjectLibraryProjection(replica)
	if err != nil {
		return nil, err
	}
	return projection.Captures, nil
}

// ProjectLibraryProjection reduces the authenticated capture and Collection
// Content Events into the current Library view. This first semantic slice
// covers Collection titles and capture-derived tails; redirect and folder
// reducers extend the same projection without changing its source of truth.
func ProjectLibraryProjection(replica *Replica) (LibraryProjection, error) {
	if replica == nil {
		return LibraryProjection{}, errors.New("Replica is required")
	}
	captures := make(map[string]*libraryCapture)
	collectionTitles := make(map[canonical.Identifier]collectionTitleFact)
	collectionRedirects := make(map[canonical.Identifier]collectionRedirectFact)
	inactiveRedirects := make(map[canonical.Identifier]struct{})
	for _, event := range replica.Events() {
		if event.Family != canonical.ContentFamily {
			continue
		}
		switch event.Type {
		case 3:
			capture, err := registeredCapture(replica, event)
			if err != nil {
				return LibraryProjection{}, err
			}
			bundleKey := capture.item.BundleID
			if existing, ok := captures[bundleKey]; ok {
				if existing.item.ArtifactID != capture.item.ArtifactID || existing.item.CollectionID != capture.item.CollectionID {
					return LibraryProjection{}, fmt.Errorf("Capture identity conflict for Bundle %s", bundleKey)
				}
				continue
			}
			captures[bundleKey] = capture
		case 4, 5:
			ids, err := bundleIDSet(event.Body)
			if err != nil {
				return LibraryProjection{}, err
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
				return LibraryProjection{}, err
			}
			for _, move := range moves {
				capture := captures[hexIdentifier(move.bundleID)]
				if capture == nil || !newerEvent(replica, capture.collectionID, event.RecordID) {
					continue
				}
				capture.collectionID = event.RecordID
				capture.item.CollectionID = hexIdentifier(move.destinationID)
			}
		case 7:
			collectionID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Collection Title Collection ID is invalid")
			}
			title, ok := replicaMapNullableText(event.Body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Collection Title title is invalid")
			}
			if previous, exists := collectionTitles[collectionID]; !exists || newerEvent(replica, previous.causeID, event.RecordID) {
				collectionTitles[collectionID] = collectionTitleFact{causeID: event.RecordID, title: title}
			}
		case 8:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, errors.New("Collections Merged body is invalid")
			}
			sources, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 0), "Source Collection IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			destination, ok := replicaIdentifier(body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Collections Merged destination Collection ID is invalid")
			}
			edges := make([]collectionRedirectEdge, 0, len(sources))
			for _, source := range sources {
				edges = append(edges, collectionRedirectEdge{sourceID: source, destinationID: destination, causeID: event.RecordID})
			}
			collectionRedirects[event.RecordID] = collectionRedirectFact{causeID: event.RecordID, edges: edges}
		case 9:
			cause, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Collection Merge Reverted cause ID is invalid")
			}
			fact, exists := collectionRedirects[cause]
			if !exists || !replica.IsAncestor(fact.causeID, event.RecordID) {
				return LibraryProjection{}, errors.New("Collection Merge Reverted cause is not an observed redirect")
			}
			inactiveRedirects[cause] = struct{}{}
		}
	}
	activeRedirects := make([]collectionRedirectEdge, 0)
	for cause, fact := range collectionRedirects {
		if _, inactive := inactiveRedirects[cause]; inactive {
			continue
		}
		activeRedirects = append(activeRedirects, fact.edges...)
	}
	redirected := make(map[canonical.Identifier]canonical.Identifier)
	redirectIDs := make(map[canonical.Identifier]struct{})
	for _, edge := range activeRedirects {
		redirectIDs[edge.sourceID] = struct{}{}
		redirectIDs[edge.destinationID] = struct{}{}
	}
	for collectionID := range redirectIDs {
		resolved, err := resolveCollectionRedirect(collectionID, activeRedirects)
		if err != nil {
			return LibraryProjection{}, err
		}
		if resolved != collectionID {
			redirected[collectionID] = resolved
		}
	}
	for _, capture := range captures {
		collectionID, err := decodeHexIdentifier(capture.item.CollectionID)
		if err != nil {
			return LibraryProjection{}, fmt.Errorf("decode Capture Collection ID: %w", err)
		}
		if effective, ok := redirected[collectionID]; ok {
			capture.item.CollectionID = hexIdentifier(effective)
		}
	}
	items := make([]LibraryItem, 0, len(captures))
	for _, capture := range captures {
		items = append(items, capture.item)
	}
	sort.Slice(items, func(left, right int) bool { return items[left].BundleID < items[right].BundleID })
	collectionIDs := make(map[canonical.Identifier]struct{})
	for _, capture := range captures {
		collectionID, err := decodeHexIdentifier(capture.item.CollectionID)
		if err != nil {
			return LibraryProjection{}, fmt.Errorf("decode Capture Collection ID: %w", err)
		}
		collectionIDs[collectionID] = struct{}{}
	}
	for collectionID := range collectionTitles {
		collectionIDs[collectionID] = struct{}{}
	}
	for collectionID := range redirectIDs {
		collectionIDs[collectionID] = struct{}{}
	}
	collections := make([]LibraryCollection, 0, len(collectionIDs))
	for collectionID := range collectionIDs {
		active := make([]*libraryCapture, 0)
		for _, capture := range captures {
			if capture.item.Lifecycle != "Active" || capture.item.CollectionID != hexIdentifier(collectionID) {
				continue
			}
			active = append(active, capture)
		}
		var tail *libraryCapture
		for _, candidate := range active {
			if tail == nil || newerEvent(replica, tail.registrationID, candidate.registrationID) ||
				(!replica.IsAncestor(candidate.registrationID, tail.registrationID) && !replica.IsAncestor(tail.registrationID, candidate.registrationID) && bytes.Compare(candidate.registrationID[:], tail.registrationID[:]) > 0) {
				tail = candidate
			}
		}
		explicitTitle := collectionTitles[collectionID].title
		collection := LibraryCollection{CollectionID: hexIdentifier(collectionID), ExplicitTitle: explicitTitle, Title: "Empty Collection", ActiveCaptureCount: len(active)}
		if effective, ok := redirected[collectionID]; ok {
			collection.RedirectedTo = pointerString(hexIdentifier(effective))
		}
		if tail != nil {
			collection.TailBundleID = pointerString(tail.item.BundleID)
			if tail.item.Title != nil && *tail.item.Title != "" {
				collection.Title = *tail.item.Title
			} else if tail.item.FinalURL != "" {
				collection.Title = tail.item.FinalURL
			}
		}
		if explicitTitle != nil {
			collection.Title = *explicitTitle
		}
		collections = append(collections, collection)
	}
	sort.Slice(collections, func(left, right int) bool { return collections[left].CollectionID < collections[right].CollectionID })
	return LibraryProjection{Captures: items, Collections: collections}, nil
}

type collectionTitleFact struct {
	causeID canonical.Identifier
	title   *string
}

type collectionRedirectFact struct {
	causeID canonical.Identifier
	edges   []collectionRedirectEdge
}

type collectionRedirectEdge struct {
	sourceID      canonical.Identifier
	destinationID canonical.Identifier
	causeID       canonical.Identifier
}

func resolveCollectionRedirect(collectionID canonical.Identifier, edges []collectionRedirectEdge) (canonical.Identifier, error) {
	bySource := make(map[canonical.Identifier]canonical.Identifier)
	for _, edge := range edges {
		if previous, exists := bySource[edge.sourceID]; exists && previous != edge.destinationID {
			return canonical.Identifier{}, fmt.Errorf("Collection Merge Conflict has multiple destinations for %s", hexIdentifier(edge.sourceID))
		}
		bySource[edge.sourceID] = edge.destinationID
	}
	current := collectionID
	visited := make(map[canonical.Identifier]struct{})
	for {
		destination, exists := bySource[current]
		if !exists {
			return current, nil
		}
		if _, seen := visited[current]; seen {
			return canonical.Identifier{}, fmt.Errorf("Collection Merge Conflict contains a redirect cycle at %s", hexIdentifier(current))
		}
		visited[current] = struct{}{}
		current = destination
	}
}

func pointerString(value string) *string { return &value }

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
	return &libraryCapture{item: item, registrationID: event.RecordID, lifecycleID: event.RecordID, collectionID: event.RecordID}, nil
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
