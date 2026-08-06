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

type LibraryFolder struct {
	FolderID                string  `json:"folderId"`
	Name                    string  `json:"name"`
	ParentFolderID          *string `json:"parentFolderId"`
	EffectiveParentFolderID *string `json:"effectiveParentFolderId"`
	Lifecycle               string  `json:"lifecycle"`
}

type LibraryTag struct {
	TagID        string  `json:"tagId"`
	Name         string  `json:"name"`
	Lifecycle    string  `json:"lifecycle"`
	RedirectedTo *string `json:"redirectedTo"`
}

type LibraryTagAssignment struct {
	AssignmentID string `json:"assignmentId"`
	TagID        string `json:"tagId"`
	TargetKind   uint64 `json:"targetKind"`
	TargetID     string `json:"targetId"`
	Active       bool   `json:"active"`
}

// LibraryProjection is a rebuildable user-facing view. It is derived solely
// from the authenticated Replica and is never an authority source.
type LibraryProjection struct {
	Captures       []LibraryItem          `json:"captures"`
	Collections    []LibraryCollection    `json:"collections"`
	Folders        []LibraryFolder        `json:"folders"`
	Tags           []LibraryTag           `json:"tags"`
	TagAssignments []LibraryTagAssignment `json:"tagAssignments"`
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
	folders := make(map[canonical.Identifier]*libraryFolderState)
	collectionFolders := make(map[canonical.Identifier]libraryCollectionFolderFact)
	tags := make(map[canonical.Identifier]*libraryTagState)
	assignments := make(map[canonical.Identifier]libraryTagAssignmentState)
	removedAssignmentCauses := make(map[canonical.Identifier]struct{})
	orderedEvents, err := orderedContentEvents(replica)
	if err != nil {
		return LibraryProjection{}, err
	}
	for _, event := range orderedEvents {
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
		case 11:
			collectionID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Collection Folder Placement Collection ID is invalid")
			}
			folderID, err := nullableIdentifier(replicaMapEntryMust(event.Body, 1), "Collection Folder Placement Folder ID")
			if err != nil {
				return LibraryProjection{}, err
			}
			if previous, exists := collectionFolders[collectionID]; !exists || newerEvent(replica, previous.causeID, event.RecordID) {
				collectionFolders[collectionID] = libraryCollectionFolderFact{causeID: event.RecordID, folderID: folderID}
			}
		case 12:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 3) {
				return LibraryProjection{}, errors.New("Folder Created body is invalid")
			}
			folderID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Folder Created Folder ID is invalid")
			}
			name, ok := replicaMapText(body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Folder Created name is invalid")
			}
			parent, err := nullableIdentifier(replicaMapEntryMust(body, 2), "Folder Created parent Folder ID")
			if err != nil {
				return LibraryProjection{}, err
			}
			if parent != nil && *parent == folderID {
				return LibraryProjection{}, errors.New("Folder cannot be its own parent")
			}
			if existing, exists := folders[folderID]; exists {
				if existing.name != name || !sameNullableIdentifier(existing.parent, parent) {
					return LibraryProjection{}, fmt.Errorf("Folder identity conflict for %s", hexIdentifier(folderID))
				}
				continue
			}
			folders[folderID] = &libraryFolderState{id: folderID, name: name, nameCause: event.RecordID, parent: parent, parentCause: event.RecordID, lifecycle: "Active", lifecycleCause: event.RecordID}
		case 13:
			folderID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Folder Renamed Folder ID is invalid")
			}
			folder, exists := folders[folderID]
			if !exists {
				return LibraryProjection{}, errors.New("Folder Renamed target is unknown")
			}
			name, ok := replicaMapText(event.Body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Folder Renamed name is invalid")
			}
			if newerEvent(replica, folder.nameCause, event.RecordID) {
				folder.name, folder.nameCause = name, event.RecordID
			}
		case 14:
			folderID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Folder Parent Placement Folder ID is invalid")
			}
			folder, exists := folders[folderID]
			if !exists {
				return LibraryProjection{}, errors.New("Folder Parent Placement target is unknown")
			}
			parent, err := nullableIdentifier(replicaMapEntryMust(event.Body, 1), "Folder Parent Placement parent Folder ID")
			if err != nil {
				return LibraryProjection{}, err
			}
			if parent != nil && *parent == folderID {
				return LibraryProjection{}, errors.New("Folder cannot be its own parent")
			}
			if newerEvent(replica, folder.parentCause, event.RecordID) {
				folder.parent, folder.parentCause = parent, event.RecordID
			}
		case 15, 16:
			folderID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, fmt.Errorf("Folder lifecycle type %d Folder ID is invalid", event.Type)
			}
			folder, exists := folders[folderID]
			if !exists {
				return LibraryProjection{}, errors.New("Folder lifecycle target is unknown")
			}
			if newerEvent(replica, folder.lifecycleCause, event.RecordID) {
				folder.lifecycleCause = event.RecordID
				if event.Type == 15 {
					folder.lifecycle = "Deleted"
				} else {
					folder.lifecycle = "Active"
				}
			}
		case 18:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, errors.New("Tag Created body is invalid")
			}
			tagID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Tag Created Tag ID is invalid")
			}
			name, ok := replicaMapText(body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Tag Created name is invalid")
			}
			if existing, exists := tags[tagID]; exists {
				if existing.name != name {
					return LibraryProjection{}, fmt.Errorf("Tag identity conflict for %s", hexIdentifier(tagID))
				}
				continue
			}
			tags[tagID] = &libraryTagState{id: tagID, name: name, nameCause: event.RecordID, lifecycle: "Active", lifecycleCause: event.RecordID}
		case 19:
			tagID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Tag Renamed Tag ID is invalid")
			}
			tag, exists := tags[tagID]
			if !exists {
				return LibraryProjection{}, errors.New("Tag Renamed target is unknown")
			}
			name, ok := replicaMapText(event.Body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Tag Renamed name is invalid")
			}
			if newerEvent(replica, tag.nameCause, event.RecordID) {
				tag.name, tag.nameCause = name, event.RecordID
			}
		case 20:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 3) {
				return LibraryProjection{}, errors.New("Tag Assigned body is invalid")
			}
			assignmentID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Tag Assigned Assignment ID is invalid")
			}
			tagID, ok := replicaIdentifier(body, 1)
			if !ok || tags[tagID] == nil {
				return LibraryProjection{}, errors.New("Tag Assigned Tag is unknown")
			}
			targetKind, targetID, err := decodeLibraryTagTarget(replicaMapEntryMust(body, 2))
			if err != nil {
				return LibraryProjection{}, err
			}
			if existing, exists := assignments[assignmentID]; exists {
				if existing.tagID != tagID || existing.targetKind != targetKind || existing.targetID != targetID {
					return LibraryProjection{}, fmt.Errorf("Tag Assignment identity conflict for %s", hexIdentifier(assignmentID))
				}
				continue
			}
			assignments[assignmentID] = libraryTagAssignmentState{assignmentID: assignmentID, causeID: event.RecordID, tagID: tagID, targetKind: targetKind, targetID: targetID}
		case 21:
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(event.Body, 0), "Tag Assignment Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			for _, cause := range causes {
				found := false
				for _, assignment := range assignments {
					if assignment.causeID == cause {
						found = true
						removedAssignmentCauses[cause] = struct{}{}
						break
					}
				}
				if !found {
					return LibraryProjection{}, errors.New("Tag removal names an unknown assignment")
				}
			}
		case 22, 23:
			tagID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, fmt.Errorf("Tag lifecycle type %d Tag ID is invalid", event.Type)
			}
			tag, exists := tags[tagID]
			if !exists {
				return LibraryProjection{}, errors.New("Tag lifecycle target is unknown")
			}
			if newerEvent(replica, tag.lifecycleCause, event.RecordID) {
				tag.lifecycleCause = event.RecordID
				if event.Type == 22 {
					tag.lifecycle = "Deleted"
				} else {
					tag.lifecycle = "Active"
				}
			}
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
	for collectionID := range collectionFolders {
		collectionIDs[collectionID] = struct{}{}
	}
	folderProjection := make([]LibraryFolder, 0, len(folders))
	for folderID, folder := range folders {
		projected := LibraryFolder{FolderID: hexIdentifier(folderID), Name: folder.name, Lifecycle: folder.lifecycle}
		if folder.parent != nil {
			projected.ParentFolderID = pointerString(hexIdentifier(*folder.parent))
		}
		if effective := nearestActiveFolder(folderID, folders); effective != nil {
			projected.EffectiveParentFolderID = pointerString(hexIdentifier(*effective))
		}
		folderProjection = append(folderProjection, projected)
	}
	sort.Slice(folderProjection, func(left, right int) bool { return folderProjection[left].FolderID < folderProjection[right].FolderID })
	tagProjection := make([]LibraryTag, 0, len(tags))
	for tagID, tag := range tags {
		projected := LibraryTag{TagID: hexIdentifier(tagID), Name: tag.name, Lifecycle: tag.lifecycle}
		tagProjection = append(tagProjection, projected)
	}
	sort.Slice(tagProjection, func(left, right int) bool { return tagProjection[left].TagID < tagProjection[right].TagID })
	assignmentProjection := make([]LibraryTagAssignment, 0, len(assignments))
	for assignmentID, assignment := range assignments {
		if _, removed := removedAssignmentCauses[assignment.causeID]; removed {
			continue
		}
		tag := tags[assignment.tagID]
		assignmentProjection = append(assignmentProjection, LibraryTagAssignment{
			AssignmentID: hexIdentifier(assignmentID), TagID: hexIdentifier(assignment.tagID), TargetKind: assignment.targetKind,
			TargetID: hexIdentifier(assignment.targetID), Active: tag != nil && tag.lifecycle == "Active",
		})
	}
	sort.Slice(assignmentProjection, func(left, right int) bool {
		return assignmentProjection[left].AssignmentID < assignmentProjection[right].AssignmentID
	})
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
		if fact, ok := collectionFolders[collectionID]; ok && fact.folderID != nil {
			if effectiveFolder := nearestActiveFolder(*fact.folderID, folders); effectiveFolder != nil {
				collection.FolderID = pointerString(hexIdentifier(*effectiveFolder))
			}
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
	return LibraryProjection{Captures: items, Collections: collections, Folders: folderProjection, Tags: tagProjection, TagAssignments: assignmentProjection}, nil
}

func orderedContentEvents(replica *Replica) ([]canonical.Event, error) {
	if replica == nil {
		return nil, errors.New("Replica is required")
	}
	content := make(map[canonical.Identifier]canonical.Event)
	for _, event := range replica.Events() {
		if event.Family == canonical.ContentFamily {
			content[event.RecordID] = event
		}
	}
	remaining := make([]canonical.Event, 0, len(content))
	for _, event := range content {
		remaining = append(remaining, event)
	}
	ordered := make([]canonical.Event, 0, len(remaining))
	processed := make(map[canonical.Identifier]struct{}, len(remaining))
	for len(remaining) > 0 {
		sort.Slice(remaining, func(left, right int) bool {
			return bytes.Compare(remaining[left].RecordID[:], remaining[right].RecordID[:]) < 0
		})
		progress := false
		for index := 0; index < len(remaining); index++ {
			event := remaining[index]
			ready := true
			for _, parentID := range event.ParentRecordIDs {
				parent, exists := replica.Record(parentID)
				if !exists {
					return nil, fmt.Errorf("Content Event %s names an unknown parent", hexIdentifier(event.RecordID))
				}
				if parent.Event != nil && parent.Event.Family == canonical.ContentFamily {
					if _, done := processed[parentID]; !done {
						ready = false
						break
					}
				}
			}
			if !ready {
				continue
			}
			ordered = append(ordered, event)
			processed[event.RecordID] = struct{}{}
			remaining = append(remaining[:index], remaining[index+1:]...)
			index--
			progress = true
		}
		if !progress {
			return nil, errors.New("Content Event graph cannot be ordered")
		}
	}
	return ordered, nil
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

type libraryFolderState struct {
	id             canonical.Identifier
	name           string
	nameCause      canonical.Identifier
	parent         *canonical.Identifier
	parentCause    canonical.Identifier
	lifecycle      string
	lifecycleCause canonical.Identifier
}

type libraryCollectionFolderFact struct {
	causeID  canonical.Identifier
	folderID *canonical.Identifier
}

type libraryTagState struct {
	id             canonical.Identifier
	name           string
	nameCause      canonical.Identifier
	lifecycle      string
	lifecycleCause canonical.Identifier
}

type libraryTagAssignmentState struct {
	assignmentID canonical.Identifier
	causeID      canonical.Identifier
	tagID        canonical.Identifier
	targetKind   uint64
	targetID     canonical.Identifier
}

func decodeLibraryTagTarget(value canonical.Value) (uint64, canonical.Identifier, error) {
	body, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(body, 2) {
		return 0, canonical.Identifier{}, errors.New("Tag target is invalid")
	}
	kind, ok := replicaUnsignedNumber(replicaMapEntryMust(body, 0))
	if !ok || (kind != 1 && kind != 2) {
		return 0, canonical.Identifier{}, errors.New("Tag target kind is invalid")
	}
	target, ok := replicaIdentifier(body, 1)
	if !ok {
		return 0, canonical.Identifier{}, errors.New("Tag target ID is invalid")
	}
	return kind, target, nil
}

func nullableIdentifier(value canonical.Value, field string) (*canonical.Identifier, error) {
	if value == nil {
		return nil, nil
	}
	identifier, ok := replicaIdentifierValue(value)
	if !ok {
		return nil, fmt.Errorf("%s is invalid", field)
	}
	return &identifier, nil
}

func sameNullableIdentifier(left, right *canonical.Identifier) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func nearestActiveFolder(folderID canonical.Identifier, folders map[canonical.Identifier]*libraryFolderState) *canonical.Identifier {
	current := folderID
	visited := make(map[canonical.Identifier]struct{})
	for {
		folder, ok := folders[current]
		if !ok || folder.parent == nil {
			return nil
		}
		if _, seen := visited[current]; seen {
			return nil
		}
		visited[current] = struct{}{}
		parentID := *folder.parent
		parent, ok := folders[parentID]
		if !ok {
			return nil
		}
		if parent.lifecycle == "Active" {
			return &parentID
		}
		current = parentID
	}
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
