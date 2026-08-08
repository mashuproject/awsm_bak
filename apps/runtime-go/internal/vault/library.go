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

type LibraryNoteVersion struct {
	HeadCauseID     string  `json:"headCauseId"`
	ContentObjectID *string `json:"contentObjectId"`
	Title           *string `json:"title"`
	Body            *string `json:"body"`
	BodyDialect     *string `json:"bodyDialect"`
	AssertedAt      int64   `json:"assertedAt"`
}

type LibraryNote struct {
	NoteID     string               `json:"noteId"`
	TargetKind uint64               `json:"targetKind"`
	TargetID   string               `json:"targetId"`
	State      string               `json:"state"`
	Versions   []LibraryNoteVersion `json:"versions"`
}

type LibraryConflict struct {
	Kind               string   `json:"kind"`
	Reason             string   `json:"reason"`
	SubjectIDs         []string `json:"subjectIds"`
	CandidateRecordIDs []string `json:"candidateRecordIds"`
}

// LibraryProjection is a rebuildable user-facing view. It is derived solely
// from the authenticated Replica and is never an authority source.
type LibraryProjection struct {
	Captures       []LibraryItem          `json:"captures"`
	Collections    []LibraryCollection    `json:"collections"`
	Folders        []LibraryFolder        `json:"folders"`
	Tags           []LibraryTag           `json:"tags"`
	TagAssignments []LibraryTagAssignment `json:"tagAssignments"`
	Notes          []LibraryNote          `json:"notes"`
	Conflicts      []LibraryConflict      `json:"conflicts"`
	captureState   []libraryCaptureCheckpoint
	noteState      []libraryNoteCheckpoint
	conflictState  []libraryConflictCheckpoint
}

type libraryCapture struct {
	item                    LibraryItem
	registrationID          canonical.Identifier
	lifecycleID             canonical.Identifier
	collectionID            canonical.Identifier
	assignedCollectionID    canonical.Identifier
	descriptorID            canonical.Identifier
	assignmentCauses        []canonical.Identifier
	lifecycleCauses         []canonical.Identifier
	registrationAttribution canonical.Value
}

type libraryCaptureCheckpoint struct {
	bundleID                string
	descriptorID            canonical.Identifier
	collectionID            canonical.Identifier
	assignmentCauses        []canonical.Identifier
	lifecycleCode           uint64
	lifecycleCauses         []canonical.Identifier
	registrationCause       canonical.Identifier
	registrationAttribution canonical.Value
}

type credentialLabelFact struct {
	credentialID canonical.Identifier
	causeID      canonical.Identifier
	value        *string
}

type libraryNoteCheckpoint struct {
	noteID     canonical.Identifier
	targetKind uint64
	targetID   canonical.Identifier
	stateCode  uint64
	versions   []libraryNoteVersionCheckpoint
}

type libraryNoteVersionCheckpoint struct {
	causeID     canonical.Identifier
	contentID   *canonical.Identifier
	restoreID   *canonical.Identifier
	attribution canonical.Value
}

type libraryConflictCheckpoint struct {
	kind       uint64
	subjects   []canonical.Identifier
	candidates []libraryConflictCandidate
}

type libraryConflictCandidate struct {
	headCauseID canonical.Identifier
	redirects   []collectionRedirectEdge
	noteID      canonical.Identifier
	contentID   *canonical.Identifier
	placements  []libraryFolderPlacement
}

type libraryFolderPlacement struct {
	folderID canonical.Identifier
	parentID *canonical.Identifier
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
	baselineFolderConflicts := make([]libraryConflictCheckpoint, 0)
	inactiveFolderConflictCauses := make(map[canonical.Identifier]struct{})
	collectionFolders := make(map[canonical.Identifier]libraryCollectionFolderFact)
	tags := make(map[canonical.Identifier]*libraryTagState)
	tagRedirects := make(map[canonical.Identifier]collectionRedirectFact)
	inactiveTagRedirects := make(map[canonical.Identifier]struct{})
	assignments := make(map[canonical.Identifier]libraryTagAssignmentState)
	removedAssignmentCauses := make(map[canonical.Identifier]struct{})
	notes := make(map[canonical.Identifier]*libraryNoteState)
	if err := seedBaselineCaptures(replica, captures); err != nil {
		return LibraryProjection{}, err
	}
	if err := seedBaselineCollections(replica, collectionTitles, collectionFolders, collectionRedirects); err != nil {
		return LibraryProjection{}, err
	}
	if err := seedBaselineFolders(replica, folders); err != nil {
		return LibraryProjection{}, err
	}
	seededFolderConflicts, folderErr := seedBaselineFolderConflicts(replica, folders)
	if folderErr != nil {
		return LibraryProjection{}, folderErr
	}
	baselineFolderConflicts = seededFolderConflicts
	if err := seedBaselineTags(replica, tags, tagRedirects); err != nil {
		return LibraryProjection{}, err
	}
	if err := seedBaselineTagAssignments(replica, tags, assignments); err != nil {
		return LibraryProjection{}, err
	}
	if err := seedBaselineNotes(replica, notes); err != nil {
		return LibraryProjection{}, err
	}
	if err := seedBaselineRedirectConflicts(replica, collectionRedirects, tagRedirects, notes); err != nil {
		return LibraryProjection{}, err
	}
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
				capture.lifecycleCauses = []canonical.Identifier{event.RecordID}
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
				capture.assignedCollectionID = move.destinationID
				capture.assignmentCauses = []canonical.Identifier{event.RecordID}
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
		case 10:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, errors.New("Collection Merge Conflict Resolution body is invalid")
			}
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 0), "Conflicting Collection Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			for _, cause := range causes {
				if _, exists := collectionRedirects[cause]; !exists {
					return LibraryProjection{}, errors.New("Collection Merge Conflict Resolution names an unknown cause")
				}
				inactiveRedirects[cause] = struct{}{}
			}
			edges, err := parseLibraryRedirectEdges(replicaMapEntryMust(body, 1), event.RecordID, "Collection")
			if err != nil {
				return LibraryProjection{}, err
			}
			collectionRedirects[event.RecordID] = collectionRedirectFact{causeID: event.RecordID, edges: edges}
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
		case 17:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, errors.New("Folder Conflict Resolution body is invalid")
			}
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 0), "Conflicting Folder Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			placements, ok := replicaMapArrayValue(replicaMapEntryMust(body, 1))
			if !ok {
				return LibraryProjection{}, errors.New("Folder Conflict Resolution placements are invalid")
			}
			for _, cause := range causes {
				known := false
				for _, folder := range folders {
					if folder.parentCause == cause {
						known = true
						break
					}
				}
				if !known {
					for _, conflict := range baselineFolderConflicts {
						for _, candidate := range conflict.candidates {
							if candidate.headCauseID == cause {
								known = true
								break
							}
						}
						if known {
							break
						}
					}
				}
				if !known {
					return LibraryProjection{}, errors.New("Folder Conflict Resolution names an unknown cause")
				}
				inactiveFolderConflictCauses[cause] = struct{}{}
			}
			for index, placement := range placements {
				placementBody, ok := replicaMapValue(placement)
				if !ok || !replicaMapHasKeys(placementBody, 2) {
					return LibraryProjection{}, fmt.Errorf("Folder Conflict Resolution placement %d is invalid", index)
				}
				folderID, ok := replicaIdentifier(placementBody, 0)
				if !ok {
					return LibraryProjection{}, fmt.Errorf("Folder Conflict Resolution placement %d Folder ID is invalid", index)
				}
				folder := folders[folderID]
				if folder == nil {
					return LibraryProjection{}, errors.New("Folder Conflict Resolution target is unknown")
				}
				parent, err := nullableIdentifier(replicaMapEntryMust(placementBody, 1), "Folder Conflict Resolution parent Folder ID")
				if err != nil {
					return LibraryProjection{}, err
				}
				if parent != nil && *parent == folderID {
					return LibraryProjection{}, errors.New("Folder Conflict Resolution creates a self-parent")
				}
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
		case 24:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, errors.New("Tags Merged body is invalid")
			}
			sources, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 0), "Source Tag IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			destination, ok := replicaIdentifier(body, 1)
			if !ok {
				return LibraryProjection{}, errors.New("Tags Merged destination Tag ID is invalid")
			}
			edges := make([]collectionRedirectEdge, 0, len(sources))
			for _, source := range sources {
				edges = append(edges, collectionRedirectEdge{sourceID: source, destinationID: destination, causeID: event.RecordID})
			}
			tagRedirects[event.RecordID] = collectionRedirectFact{causeID: event.RecordID, edges: edges}
		case 25:
			cause, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Tag Merge Reverted cause ID is invalid")
			}
			fact, exists := tagRedirects[cause]
			if !exists || !replica.IsAncestor(fact.causeID, event.RecordID) {
				return LibraryProjection{}, errors.New("Tag Merge Reverted cause is not an observed redirect")
			}
			inactiveTagRedirects[cause] = struct{}{}
		case 26:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, errors.New("Tag Merge Conflict Resolution body is invalid")
			}
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 0), "Conflicting Tag Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			for _, cause := range causes {
				if _, exists := tagRedirects[cause]; !exists {
					return LibraryProjection{}, errors.New("Tag Merge Conflict Resolution names an unknown cause")
				}
				inactiveTagRedirects[cause] = struct{}{}
			}
			edges, err := parseLibraryRedirectEdges(replicaMapEntryMust(body, 1), event.RecordID, "Tag")
			if err != nil {
				return LibraryProjection{}, err
			}
			tagRedirects[event.RecordID] = collectionRedirectFact{causeID: event.RecordID, edges: edges}
		case 27:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 3) {
				return LibraryProjection{}, errors.New("Note Created body is invalid")
			}
			noteID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Note Created Note ID is invalid")
			}
			targetKind, targetID, err := decodeLibraryNoteTarget(replicaMapEntryMust(body, 1))
			if err != nil {
				return LibraryProjection{}, err
			}
			contentID, ok := replicaIdentifier(body, 2)
			if !ok {
				return LibraryProjection{}, errors.New("Note Created Content Object ID is invalid")
			}
			if _, exists := notes[noteID]; exists {
				return LibraryProjection{}, fmt.Errorf("Note identity conflict for %s", hexIdentifier(noteID))
			}
			version, err := projectNoteVersion(replica, event, event.RecordID, &contentID)
			if err != nil {
				return LibraryProjection{}, err
			}
			notes[noteID] = &libraryNoteState{noteID: noteID, targetKind: targetKind, targetID: targetID, versions: map[canonical.Identifier]libraryNoteVersionState{event.RecordID: version}}
		case 28:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 3) {
				return LibraryProjection{}, errors.New("Note Revised body is invalid")
			}
			noteID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Note Revised Note ID is invalid")
			}
			note := notes[noteID]
			if note == nil {
				return LibraryProjection{}, errors.New("Note Revised target is unknown")
			}
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 1), "Superseded Note revision Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			for _, cause := range causes {
				if _, exists := note.versions[cause]; !exists {
					return LibraryProjection{}, errors.New("Note Revised names an unknown revision")
				}
			}
			contentID, ok := replicaIdentifier(body, 2)
			if !ok {
				return LibraryProjection{}, errors.New("Note Revised Content Object ID is invalid")
			}
			version, err := projectNoteVersion(replica, event, event.RecordID, &contentID)
			if err != nil {
				return LibraryProjection{}, err
			}
			note.versions[event.RecordID] = version
		case 29, 30:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 2) {
				return LibraryProjection{}, fmt.Errorf("Note lifecycle type %d body is invalid", event.Type)
			}
			noteID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, fmt.Errorf("Note lifecycle type %d Note ID is invalid", event.Type)
			}
			note := notes[noteID]
			if note == nil {
				return LibraryProjection{}, errors.New("Note lifecycle target is unknown")
			}
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 1), "Observed Note head Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			var contentID *canonical.Identifier
			var restoreID *canonical.Identifier
			for _, cause := range causes {
				if prior, exists := note.versions[cause]; exists {
					var candidateID *canonical.Identifier
					if prior.contentID != nil {
						candidateID = prior.contentID
					} else if prior.restoreID != nil {
						candidateID = prior.restoreID
					}
					if candidateID == nil {
						continue
					}
					candidate := *candidateID
					if event.Type == 30 {
						contentID = &candidate
					} else if restoreID == nil {
						restoreID = &candidate
					}
					if contentID != nil {
						break
					}
				}
			}
			if event.Type == 30 && contentID == nil {
				return LibraryProjection{}, errors.New("Note Restored has no retained content")
			}
			version, err := projectNoteVersion(replica, event, event.RecordID, contentID)
			if err != nil {
				return LibraryProjection{}, err
			}
			version.restoreID = restoreID
			note.versions[event.RecordID] = version
		case 31:
			body, ok := replicaMapValue(event.Body)
			if !ok || !replicaMapHasKeys(body, 4) {
				return LibraryProjection{}, errors.New("Note Conflict Resolution body is invalid")
			}
			noteID, ok := replicaIdentifier(body, 0)
			if !ok {
				return LibraryProjection{}, errors.New("Note Conflict Resolution Note ID is invalid")
			}
			note := notes[noteID]
			if note == nil {
				return LibraryProjection{}, errors.New("Note Conflict Resolution target is unknown")
			}
			causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 1), "Conflicting Note head Cause IDs", true)
			if err != nil {
				return LibraryProjection{}, err
			}
			current := currentNoteHeadCauses(replica, note)
			if !sameNoteIdentifierSet(current, causes) {
				return LibraryProjection{}, errors.New("Note Conflict Resolution does not name the exact current heads")
			}
			var retained *canonical.Identifier
			if value := replicaMapEntryMust(body, 2); value != nil {
				contentID, ok := replicaIdentifierValue(value)
				if !ok {
					return LibraryProjection{}, errors.New("Retained Note Content Object ID is invalid")
				}
				retained = &contentID
			}
			version, err := projectNoteVersion(replica, event, event.RecordID, retained)
			if err != nil {
				return LibraryProjection{}, err
			}
			note.versions = map[canonical.Identifier]libraryNoteVersionState{event.RecordID: version}
			splits, ok := replicaMapArrayValue(replicaMapEntryMust(body, 3))
			if !ok {
				return LibraryProjection{}, errors.New("Split Notes are invalid")
			}
			for index, splitValue := range splits {
				splitBody, ok := replicaMapValue(splitValue)
				if !ok || !replicaMapHasKeys(splitBody, 2) {
					return LibraryProjection{}, fmt.Errorf("Split Note %d is invalid", index)
				}
				splitID, ok := replicaIdentifier(splitBody, 0)
				if !ok {
					return LibraryProjection{}, fmt.Errorf("Split Note %d ID is invalid", index)
				}
				if _, exists := notes[splitID]; exists {
					return LibraryProjection{}, fmt.Errorf("Split Note %s already exists", hexIdentifier(splitID))
				}
				splitContentID, ok := replicaIdentifier(splitBody, 1)
				if !ok {
					return LibraryProjection{}, fmt.Errorf("Split Note %d Content Object ID is invalid", index)
				}
				splitVersion, err := projectNoteVersion(replica, event, event.RecordID, &splitContentID)
				if err != nil {
					return LibraryProjection{}, err
				}
				notes[splitID] = &libraryNoteState{noteID: splitID, targetKind: note.targetKind, targetID: note.targetID, versions: map[canonical.Identifier]libraryNoteVersionState{event.RecordID: splitVersion}}
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
	redirectIDs := make(map[canonical.Identifier]struct{})
	for _, edge := range activeRedirects {
		redirectIDs[edge.sourceID] = struct{}{}
		redirectIDs[edge.destinationID] = struct{}{}
	}
	redirected, conflicts := reduceCollectionRedirects(activeRedirects, redirectIDs)
	tagActiveRedirects := make([]collectionRedirectEdge, 0)
	for cause, fact := range tagRedirects {
		if _, inactive := inactiveTagRedirects[cause]; inactive {
			continue
		}
		tagActiveRedirects = append(tagActiveRedirects, fact.edges...)
	}
	tagRedirectIDs := make(map[canonical.Identifier]struct{})
	for _, edge := range tagActiveRedirects {
		tagRedirectIDs[edge.sourceID] = struct{}{}
		tagRedirectIDs[edge.destinationID] = struct{}{}
	}
	tagRedirected, tagConflicts := reduceTagRedirects(tagActiveRedirects, tagRedirectIDs)
	conflicts = append(conflicts, tagConflicts...)
	folderConflicted, folderConflicts := detectFolderConflicts(folders)
	conflicts = append(conflicts, folderConflicts...)
	activeBaselineFolderConflicts := make([]libraryConflictCheckpoint, 0, len(baselineFolderConflicts))
	for _, conflict := range baselineFolderConflicts {
		active := false
		for _, candidate := range conflict.candidates {
			if _, inactive := inactiveFolderConflictCauses[candidate.headCauseID]; !inactive {
				active = true
				break
			}
		}
		if !active {
			continue
		}
		activeBaselineFolderConflicts = append(activeBaselineFolderConflicts, conflict)
		causeIDs := make([]string, 0, len(conflict.candidates))
		for _, candidate := range conflict.candidates {
			causeIDs = append(causeIDs, hexIdentifier(candidate.headCauseID))
		}
		subjectIDs := make([]string, 0, len(conflict.subjects))
		for _, subject := range conflict.subjects {
			subjectIDs = append(subjectIDs, hexIdentifier(subject))
		}
		sort.Strings(causeIDs)
		sort.Strings(subjectIDs)
		conflicts = append(conflicts, LibraryConflict{Kind: "Folder", Reason: "Cycle", SubjectIDs: subjectIDs, CandidateRecordIDs: causeIDs})
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
		if _, conflicted := folderConflicted[folderID]; conflicted {
			folderProjection = append(folderProjection, projected)
			continue
		}
		if folder.parent != nil {
			projected.ParentFolderID = pointerString(hexIdentifier(*folder.parent))
		}
		if effective := nearestActiveFolder(folderID, folders, folderConflicted); effective != nil {
			projected.EffectiveParentFolderID = pointerString(hexIdentifier(*effective))
		}
		folderProjection = append(folderProjection, projected)
	}
	sort.Slice(folderProjection, func(left, right int) bool { return folderProjection[left].FolderID < folderProjection[right].FolderID })
	tagProjection := make([]LibraryTag, 0, len(tags))
	for tagID, tag := range tags {
		projected := LibraryTag{TagID: hexIdentifier(tagID), Name: tag.name, Lifecycle: tag.lifecycle}
		if effective, ok := tagRedirected[tagID]; ok {
			projected.RedirectedTo = pointerString(hexIdentifier(effective))
		}
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
	noteProjection := make([]LibraryNote, 0, len(notes))
	noteState := make([]libraryNoteCheckpoint, 0, len(notes))
	for noteID, note := range notes {
		headVersions := make([]libraryNoteVersionState, 0, len(note.versions))
		for cause, version := range note.versions {
			superseded := false
			for otherCause := range note.versions {
				if cause != otherCause && replica.IsAncestor(cause, otherCause) {
					superseded = true
					break
				}
			}
			if !superseded {
				headVersions = append(headVersions, version)
			}
		}
		sort.Slice(headVersions, func(left, right int) bool {
			return bytes.Compare(headVersions[left].causeID[:], headVersions[right].causeID[:]) < 0
		})
		state := "Active"
		allDeleted := len(headVersions) > 0
		for _, version := range headVersions {
			if version.contentID != nil {
				allDeleted = false
				break
			}
		}
		if allDeleted {
			state = "Deleted"
		} else if len(headVersions) > 1 {
			state = "Conflict"
		}
		if state == "Conflict" {
			causes := make([]string, 0, len(headVersions))
			for _, version := range headVersions {
				causes = append(causes, hexIdentifier(version.causeID))
			}
			sort.Strings(causes)
			conflicts = append(conflicts, LibraryConflict{Kind: "Note", Reason: "MultipleHeads", SubjectIDs: []string{hexIdentifier(noteID)}, CandidateRecordIDs: causes})
		}
		versions := make([]LibraryNoteVersion, 0, len(headVersions))
		for _, version := range headVersions {
			projected := LibraryNoteVersion{HeadCauseID: hexIdentifier(version.causeID), Title: version.title, Body: version.body, BodyDialect: version.dialect, AssertedAt: version.assertedAt}
			if version.contentID != nil {
				projected.ContentObjectID = pointerString(hexIdentifier(*version.contentID))
			}
			versions = append(versions, projected)
		}
		noteProjection = append(noteProjection, LibraryNote{NoteID: hexIdentifier(noteID), TargetKind: note.targetKind, TargetID: hexIdentifier(note.targetID), State: state, Versions: versions})
		stateCode := uint64(1)
		if allDeleted {
			stateCode = 2
		} else if len(headVersions) > 1 {
			stateCode = 3
		}
		checkpointVersions := make([]libraryNoteVersionCheckpoint, 0, len(headVersions))
		for _, version := range headVersions {
			if version.attribution == nil {
				return LibraryProjection{}, errors.New("Note checkpoint attribution is incomplete")
			}
			checkpointVersions = append(checkpointVersions, libraryNoteVersionCheckpoint{
				causeID: version.causeID, contentID: cloneIdentifierPointer(version.contentID), restoreID: cloneIdentifierPointer(version.restoreID), attribution: version.attribution,
			})
		}
		sort.Slice(checkpointVersions, func(left, right int) bool {
			return bytes.Compare(checkpointVersions[left].causeID[:], checkpointVersions[right].causeID[:]) < 0
		})
		noteState = append(noteState, libraryNoteCheckpoint{noteID: noteID, targetKind: note.targetKind, targetID: note.targetID, stateCode: stateCode, versions: checkpointVersions})
	}
	sort.Slice(noteProjection, func(left, right int) bool { return noteProjection[left].NoteID < noteProjection[right].NoteID })
	sort.Slice(noteState, func(left, right int) bool {
		return bytes.Compare(noteState[left].noteID[:], noteState[right].noteID[:]) < 0
	})
	conflictState, err := projectConflictCheckpointState(replica, conflicts, collectionRedirects, tagRedirects)
	if err != nil {
		return LibraryProjection{}, err
	}
	conflictState = append(conflictState, activeBaselineFolderConflicts...)
	for _, note := range noteState {
		if note.stateCode != 3 {
			continue
		}
		candidates := make([]libraryConflictCandidate, 0, len(note.versions))
		for _, version := range note.versions {
			candidates = append(candidates, libraryConflictCandidate{headCauseID: version.causeID, noteID: note.noteID, contentID: cloneIdentifierPointer(version.contentID)})
		}
		conflictState = append(conflictState, libraryConflictCheckpoint{kind: 4, subjects: []canonical.Identifier{note.noteID}, candidates: candidates})
	}
	sort.Slice(conflictState, func(left, right int) bool {
		if conflictState[left].kind != conflictState[right].kind {
			return conflictState[left].kind < conflictState[right].kind
		}
		return bytes.Compare(conflictState[left].subjects[0][:], conflictState[right].subjects[0][:]) < 0
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
			if effectiveFolder := effectiveCollectionFolder(*fact.folderID, folders, folderConflicted); effectiveFolder != nil {
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
	sort.Slice(conflicts, func(left, right int) bool {
		if conflicts[left].Kind != conflicts[right].Kind {
			return conflicts[left].Kind < conflicts[right].Kind
		}
		if conflicts[left].Reason != conflicts[right].Reason {
			return conflicts[left].Reason < conflicts[right].Reason
		}
		return firstString(conflicts[left].SubjectIDs) < firstString(conflicts[right].SubjectIDs)
	})
	captureState := make([]libraryCaptureCheckpoint, 0, len(captures))
	for _, capture := range captures {
		if capture.registrationAttribution == nil || capture.descriptorID == (canonical.Identifier{}) || capture.assignedCollectionID == (canonical.Identifier{}) || len(capture.assignmentCauses) == 0 || len(capture.lifecycleCauses) == 0 {
			return LibraryProjection{}, errors.New("Capture checkpoint state is incomplete")
		}
		lifecycleCode, ok := vacuumLifecycleCode(capture.item.Lifecycle)
		if !ok {
			return LibraryProjection{}, errors.New("Capture checkpoint lifecycle is invalid")
		}
		captureState = append(captureState, libraryCaptureCheckpoint{
			bundleID: capture.item.BundleID, descriptorID: capture.descriptorID, collectionID: capture.assignedCollectionID,
			assignmentCauses: append([]canonical.Identifier(nil), capture.assignmentCauses...), lifecycleCode: lifecycleCode,
			lifecycleCauses: append([]canonical.Identifier(nil), capture.lifecycleCauses...), registrationCause: capture.registrationID,
			registrationAttribution: capture.registrationAttribution,
		})
	}
	sort.Slice(captureState, func(left, right int) bool { return captureState[left].bundleID < captureState[right].bundleID })
	return LibraryProjection{Captures: items, Collections: collections, Folders: folderProjection, Tags: tagProjection, TagAssignments: assignmentProjection, Notes: noteProjection, Conflicts: conflicts, captureState: captureState, noteState: noteState, conflictState: conflictState}, nil
}

func orderedContentEvents(replica *Replica) ([]canonical.Event, error) {
	if replica == nil {
		return nil, errors.New("Replica is required")
	}
	content := make(map[canonical.Identifier]canonical.Event)
	for _, event := range replica.Events() {
		if event.Family == canonical.ContentFamily && event.GenerationID == replica.generationID {
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

func baselineContentCheckpoint(baseline canonical.Baseline) (canonical.Value, error) {
	body, ok := replicaMapValue(baseline.Body)
	if !ok || !replicaMapHasKeys(body, 6) {
		return nil, errors.New("Baseline body is invalid")
	}
	content, ok := replicaMapEntry(body, 2)
	if !ok || !replicaMapHasKeys(content, 10) {
		return nil, errors.New("Baseline content checkpoint is invalid")
	}
	format, ok := replicaMapNumber(content, 0)
	if !ok || format != 1 {
		return nil, errors.New("Baseline content checkpoint format is invalid")
	}
	return content, nil
}

func appendBaselineCauseSet(value canonical.Value, key uint64, field string, causes *[]canonical.Identifier) error {
	entry, ok := replicaMapEntry(value, key)
	if !ok || entry == nil {
		return nil
	}
	ids, err := parseCanonicalIdentifierSet(entry, field, false)
	if err != nil {
		return err
	}
	*causes = append(*causes, ids...)
	return nil
}

func appendBaselineCauseID(value canonical.Value, key uint64, field string, causes *[]canonical.Identifier) error {
	entry, ok := replicaMapEntry(value, key)
	if !ok || entry == nil {
		return nil
	}
	id, ok := replicaIdentifierValue(entry)
	if !ok {
		return fmt.Errorf("%s is invalid", field)
	}
	*causes = append(*causes, id)
	return nil
}

func baselineContentCauseIDs(baseline canonical.Baseline) ([]canonical.Identifier, error) {
	content, err := baselineContentCheckpoint(baseline)
	if err != nil {
		return nil, err
	}
	causes := make([]canonical.Identifier, 0)
	if label, ok := replicaMapEntry(content, 1); ok && label != nil {
		if err := appendBaselineCauseSet(label, 1, "Baseline Vault label causes", &causes); err != nil {
			return nil, err
		}
	}
	arrays := []struct {
		key   uint64
		field string
	}{
		{2, "Baseline Credential label causes"},
		{3, "Baseline Capture assignment causes"},
		{4, "Baseline Collection title causes"},
		{5, "Baseline Folder causes"},
		{6, "Baseline Tag causes"},
		{7, "Baseline Tag assignment causes"},
		{8, "Baseline Note causes"},
		{9, "Baseline Conflict causes"},
	}
	for _, array := range arrays {
		entries, ok := replicaMapArray(content, array.key)
		if !ok {
			return nil, fmt.Errorf("%s array is invalid", array.field)
		}
		for index, entry := range entries {
			if !replicaMapValueIsMap(entry) {
				return nil, fmt.Errorf("%s entry %d is invalid", array.field, index)
			}
			switch array.key {
			case 2:
				if err := appendBaselineCauseSet(entry, 2, array.field, &causes); err != nil {
					return nil, err
				}
			case 3:
				if err := appendBaselineCauseSet(entry, 3, array.field, &causes); err != nil {
					return nil, err
				}
				if err := appendBaselineCauseSet(entry, 5, array.field, &causes); err != nil {
					return nil, err
				}
				if err := appendBaselineCauseID(entry, 6, array.field, &causes); err != nil {
					return nil, err
				}
			case 4:
				if err := appendBaselineCauseSet(entry, 2, array.field, &causes); err != nil {
					return nil, err
				}
				if err := appendBaselineCauseSet(entry, 4, array.field, &causes); err != nil {
					return nil, err
				}
				for _, key := range []uint64{5, 6, 7} {
					optional, exists := replicaMapEntry(entry, key)
					if !exists || optional == nil {
						continue
					}
					if err := appendBaselineCauseID(optional, 1, array.field, &causes); err != nil {
						return nil, err
					}
				}
			case 5:
				if err := appendBaselineCauseSet(entry, 2, array.field, &causes); err != nil {
					return nil, err
				}
				if err := appendBaselineCauseSet(entry, 4, array.field, &causes); err != nil {
					return nil, err
				}
				if err := appendBaselineCauseSet(entry, 6, array.field, &causes); err != nil {
					return nil, err
				}
			case 6:
				if err := appendBaselineCauseSet(entry, 2, array.field, &causes); err != nil {
					return nil, err
				}
				for _, key := range []uint64{3, 5} {
					optional, exists := replicaMapEntry(entry, key)
					if !exists || optional == nil {
						continue
					}
					if err := appendBaselineCauseID(optional, 1, array.field, &causes); err != nil {
						return nil, err
					}
				}
			case 7:
				if err := appendBaselineCauseID(entry, 1, array.field, &causes); err != nil {
					return nil, err
				}
			case 8:
				versions, ok := replicaMapArray(entry, 3)
				if !ok {
					return nil, fmt.Errorf("%s versions are invalid", array.field)
				}
				for _, version := range versions {
					if err := appendBaselineCauseID(version, 0, array.field, &causes); err != nil {
						return nil, err
					}
				}
			case 9:
				candidates, ok := replicaMapArray(entry, 2)
				if !ok {
					return nil, fmt.Errorf("%s candidates are invalid", array.field)
				}
				for _, candidate := range candidates {
					if err := appendBaselineCauseID(candidate, 0, array.field, &causes); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	return sortUniqueIdentifiers(causes), nil
}

func replicaMapValueIsMap(value canonical.Value) bool {
	_, ok := replicaMapValue(value)
	return ok
}

func seedBaselineCollections(replica *Replica, collectionTitles map[canonical.Identifier]collectionTitleFact, collectionFolders map[canonical.Identifier]libraryCollectionFolderFact, redirects map[canonical.Identifier]collectionRedirectFact) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 4)
	if !ok {
		return errors.New("Baseline Collection checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 8) {
			return fmt.Errorf("Baseline Collection entry %d is invalid", index)
		}
		collectionID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Baseline Collection entry %d ID is invalid", index)
		}
		title, ok := replicaMapNullableText(entry, 1)
		if !ok {
			return fmt.Errorf("Baseline Collection entry %d title is invalid", index)
		}
		causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 2), "Baseline Collection title causes", false)
		if err != nil {
			return err
		}
		if title != nil && len(causes) == 0 {
			return fmt.Errorf("Baseline Collection entry %d title has no cause", index)
		}
		if _, exists := collectionTitles[collectionID]; exists {
			return fmt.Errorf("Baseline Collection %s is repeated", hexIdentifier(collectionID))
		}
		causeID := canonical.Identifier{}
		if len(causes) > 0 {
			causeID = causes[0]
		}
		collectionTitles[collectionID] = collectionTitleFact{causeID: causeID, title: title}
		folderID, err := nullableIdentifier(replicaMapEntryMust(entry, 3), "Baseline Collection folder ID")
		if err != nil {
			return err
		}
		folderCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 4), "Baseline Collection folder causes", false)
		if err != nil {
			return err
		}
		if folderID != nil && len(folderCauses) == 0 {
			return fmt.Errorf("Baseline Collection entry %d folder has no cause", index)
		}
		folderCauseID := canonical.Identifier{}
		if len(folderCauses) > 0 {
			folderCauseID = folderCauses[0]
		}
		collectionFolders[collectionID] = libraryCollectionFolderFact{causeID: folderCauseID, folderID: folderID}
		redirectValue := replicaMapEntryMust(entry, 5)
		if redirectValue == nil {
			continue
		}
		redirect, ok := replicaMapValue(redirectValue)
		if !ok || !replicaMapHasKeys(redirect, 2) {
			return fmt.Errorf("Baseline Collection entry %d redirect is invalid", index)
		}
		destination, ok := replicaIdentifier(redirect, 0)
		if !ok || destination == collectionID {
			return fmt.Errorf("Baseline Collection entry %d redirect destination is invalid", index)
		}
		cause, ok := replicaIdentifier(redirect, 1)
		if !ok {
			return fmt.Errorf("Baseline Collection entry %d redirect cause is invalid", index)
		}
		fact := redirects[cause]
		fact.causeID = cause
		fact.edges = append(fact.edges, collectionRedirectEdge{sourceID: collectionID, destinationID: destination, causeID: cause})
		redirects[cause] = fact
	}
	return nil
}

func seedBaselineCaptures(replica *Replica, captures map[string]*libraryCapture) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 3)
	if !ok {
		return errors.New("Baseline Capture checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 8) {
			return fmt.Errorf("Baseline Capture entry %d is invalid", index)
		}
		bundleID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Baseline Capture entry %d Bundle ID is invalid", index)
		}
		descriptorID, ok := replicaIdentifier(entry, 1)
		if !ok {
			return fmt.Errorf("Baseline Capture entry %d Descriptor ID is invalid", index)
		}
		collectionID, ok := replicaIdentifier(entry, 2)
		if !ok {
			return fmt.Errorf("Baseline Capture entry %d Collection ID is invalid", index)
		}
		assignmentCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 3), "Baseline Capture assignment causes", false)
		if err != nil {
			return err
		}
		if len(assignmentCauses) == 0 {
			return fmt.Errorf("Baseline Capture entry %d assignment has no cause", index)
		}
		lifecycleCode, ok := replicaUnsignedNumber(replicaMapEntryMust(entry, 4))
		if !ok || (lifecycleCode != 1 && lifecycleCode != 2) {
			return fmt.Errorf("Baseline Capture entry %d lifecycle is invalid", index)
		}
		lifecycleCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 5), "Baseline Capture lifecycle causes", false)
		if err != nil {
			return err
		}
		if len(lifecycleCauses) == 0 {
			return fmt.Errorf("Baseline Capture entry %d lifecycle has no cause", index)
		}
		registrationCause, ok := replicaIdentifier(entry, 6)
		if !ok {
			return fmt.Errorf("Baseline Capture entry %d registration cause is invalid", index)
		}
		attribution, err := validateBaselineAttribution(replicaMapEntryMust(entry, 7), fmt.Sprintf("Baseline Capture entry %d attribution", index))
		if err != nil {
			return err
		}
		synthetic := canonical.Event{EventInput: canonical.EventInput{Body: canonical.Map{0: bundleID[:], 1: descriptorID[:], 2: collectionID[:]}}, RecordID: registrationCause}
		capture, err := registeredCapture(replica, synthetic)
		if err != nil {
			return fmt.Errorf("Baseline Capture entry %d: %w", index, err)
		}
		capture.item.Lifecycle = baselineLifecycleName(lifecycleCode)
		capture.lifecycleID = lifecycleCauses[0]
		capture.collectionID = assignmentCauses[0]
		capture.assignedCollectionID = collectionID
		capture.descriptorID = descriptorID
		capture.assignmentCauses = append([]canonical.Identifier(nil), assignmentCauses...)
		capture.lifecycleCauses = append([]canonical.Identifier(nil), lifecycleCauses...)
		capture.registrationAttribution = attribution
		bundleKey := capture.item.BundleID
		if _, exists := captures[bundleKey]; exists {
			return fmt.Errorf("Baseline Capture %s is repeated", bundleKey)
		}
		captures[bundleKey] = capture
	}
	return nil
}

func validateBaselineAttribution(value canonical.Value, field string) (canonical.Value, error) {
	attribution, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(attribution, 4) {
		return nil, fmt.Errorf("%s is invalid", field)
	}
	for _, key := range []uint64{0, 1, 2} {
		if _, valid := replicaIdentifier(attribution, key); !valid {
			return nil, fmt.Errorf("%s identity is invalid", field)
		}
	}
	if _, valid := replicaMapSignedNumber(attribution, 3); !valid {
		return nil, fmt.Errorf("%s timestamp is invalid", field)
	}
	return attribution, nil
}

func seedBaselineFolders(replica *Replica, folders map[canonical.Identifier]*libraryFolderState) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 5)
	if !ok {
		return errors.New("Baseline Folder checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 7) {
			return fmt.Errorf("Baseline Folder entry %d is invalid", index)
		}
		folderID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Baseline Folder entry %d ID is invalid", index)
		}
		name, ok := replicaMapText(entry, 1)
		if !ok {
			return fmt.Errorf("Baseline Folder entry %d name is invalid", index)
		}
		nameCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 2), "Baseline Folder name causes", false)
		if err != nil {
			return err
		}
		if len(nameCauses) == 0 {
			return fmt.Errorf("Baseline Folder entry %d name has no cause", index)
		}
		parent, err := nullableIdentifier(replicaMapEntryMust(entry, 3), "Baseline Folder parent ID")
		if err != nil {
			return err
		}
		parentCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 4), "Baseline Folder parent causes", false)
		if err != nil {
			return err
		}
		if parent != nil && len(parentCauses) == 0 {
			return fmt.Errorf("Baseline Folder entry %d parent has no cause", index)
		}
		lifecycleCode, ok := replicaUnsignedNumber(replicaMapEntryMust(entry, 5))
		if !ok || (lifecycleCode != 1 && lifecycleCode != 2) {
			return fmt.Errorf("Baseline Folder entry %d lifecycle is invalid", index)
		}
		lifecycleCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 6), "Baseline Folder lifecycle causes", false)
		if err != nil {
			return err
		}
		if len(lifecycleCauses) == 0 {
			return fmt.Errorf("Baseline Folder entry %d lifecycle has no cause", index)
		}
		if parent != nil && *parent == folderID {
			return errors.New("Baseline Folder cannot be its own parent")
		}
		if _, exists := folders[folderID]; exists {
			return fmt.Errorf("Baseline Folder %s is repeated", hexIdentifier(folderID))
		}
		folders[folderID] = &libraryFolderState{
			id: folderID, name: name, nameCause: nameCauses[0], parent: parent,
			parentCause: firstBaselineCause(parentCauses), lifecycle: baselineLifecycleName(lifecycleCode),
			lifecycleCause: lifecycleCauses[0],
		}
	}
	return nil
}

func seedBaselineTags(replica *Replica, tags map[canonical.Identifier]*libraryTagState, redirects map[canonical.Identifier]collectionRedirectFact) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 6)
	if !ok {
		return errors.New("Baseline Tag checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 6) {
			return fmt.Errorf("Baseline Tag entry %d is invalid", index)
		}
		tagID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Baseline Tag entry %d ID is invalid", index)
		}
		name, ok := replicaMapText(entry, 1)
		if !ok {
			return fmt.Errorf("Baseline Tag entry %d name is invalid", index)
		}
		nameCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 2), "Baseline Tag name causes", false)
		if err != nil {
			return err
		}
		if len(nameCauses) == 0 {
			return fmt.Errorf("Baseline Tag entry %d name has no cause", index)
		}
		lifecycleCode, ok := replicaUnsignedNumber(replicaMapEntryMust(entry, 4))
		if !ok || (lifecycleCode != 1 && lifecycleCode != 2) {
			return fmt.Errorf("Baseline Tag entry %d lifecycle is invalid", index)
		}
		lifecycleCauses, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 5), "Baseline Tag lifecycle causes", false)
		if err != nil {
			return err
		}
		if len(lifecycleCauses) == 0 {
			return fmt.Errorf("Baseline Tag entry %d lifecycle has no cause", index)
		}
		if _, exists := tags[tagID]; exists {
			return fmt.Errorf("Baseline Tag %s is repeated", hexIdentifier(tagID))
		}
		tags[tagID] = &libraryTagState{id: tagID, name: name, nameCause: nameCauses[0], lifecycle: baselineLifecycleName(lifecycleCode), lifecycleCause: lifecycleCauses[0]}
		redirectValue := replicaMapEntryMust(entry, 3)
		if redirectValue == nil {
			continue
		}
		redirect, ok := replicaMapValue(redirectValue)
		if !ok || !replicaMapHasKeys(redirect, 2) {
			return fmt.Errorf("Baseline Tag entry %d redirect is invalid", index)
		}
		destination, ok := replicaIdentifier(redirect, 0)
		if !ok || destination == tagID {
			return fmt.Errorf("Baseline Tag entry %d redirect destination is invalid", index)
		}
		cause, ok := replicaIdentifier(redirect, 1)
		if !ok {
			return fmt.Errorf("Baseline Tag entry %d redirect cause is invalid", index)
		}
		redirects[cause] = collectionRedirectFact{causeID: cause, edges: []collectionRedirectEdge{{sourceID: tagID, destinationID: destination, causeID: cause}}}
	}
	return nil
}

func seedBaselineTagAssignments(replica *Replica, tags map[canonical.Identifier]*libraryTagState, assignments map[canonical.Identifier]libraryTagAssignmentState) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 7)
	if !ok {
		return errors.New("Baseline Tag Assignment checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 4) {
			return fmt.Errorf("Baseline Tag Assignment entry %d is invalid", index)
		}
		assignmentID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Baseline Tag Assignment entry %d ID is invalid", index)
		}
		causeID, ok := replicaIdentifier(entry, 1)
		if !ok {
			return fmt.Errorf("Baseline Tag Assignment entry %d cause is invalid", index)
		}
		tagID, ok := replicaIdentifier(entry, 2)
		if !ok || tags[tagID] == nil {
			return fmt.Errorf("Baseline Tag Assignment entry %d tag is unknown", index)
		}
		targetKind, targetID, err := decodeLibraryTagTarget(replicaMapEntryMust(entry, 3))
		if err != nil {
			return err
		}
		if _, exists := assignments[assignmentID]; exists {
			return fmt.Errorf("Baseline Tag Assignment %s is repeated", hexIdentifier(assignmentID))
		}
		assignments[assignmentID] = libraryTagAssignmentState{assignmentID: assignmentID, causeID: causeID, tagID: tagID, targetKind: targetKind, targetID: targetID}
	}
	return nil
}

func firstBaselineCause(causes []canonical.Identifier) canonical.Identifier {
	if len(causes) == 0 {
		return canonical.Identifier{}
	}
	return causes[0]
}

func baselineLifecycleName(code uint64) string {
	if code == 2 {
		return "Deleted"
	}
	return "Active"
}

func freshBaselineCauseID() (canonical.Identifier, error) {
	textID, err := randomID()
	if err != nil {
		return canonical.Identifier{}, err
	}
	return decodeHexIdentifier(textID)
}

func buildVacuumContentCheckpoint(replica *Replica, projection LibraryProjection) (canonical.Value, error) {
	if replica == nil {
		return nil, errors.New("Replica is required")
	}
	if len(projection.Conflicts) != len(projection.conflictState) {
		return nil, errors.New("Vacuum content checkpoint cannot yet represent active conflict kind")
	}
	if len(projection.Captures) != len(projection.captureState) {
		return nil, errors.New("Vacuum Capture checkpoint state is incomplete")
	}
	if len(projection.Notes) != len(projection.noteState) {
		return nil, errors.New("Vacuum Note checkpoint state is incomplete")
	}
	for _, collection := range projection.Collections {
		if collection.RedirectedTo != nil {
			if *collection.RedirectedTo == collection.CollectionID {
				return nil, errors.New("Vacuum Collection checkpoint redirect is self-referential")
			}
		}
	}
	for _, tag := range projection.Tags {
		if tag.RedirectedTo != nil && *tag.RedirectedTo == tag.TagID {
			return nil, errors.New("Vacuum Tag checkpoint redirect is self-referential")
		}
	}
	oldContent, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return nil, err
	}
	if _, ok := replicaMapEntry(oldContent, 1); !ok {
		return nil, errors.New("Baseline Vault label checkpoint is missing")
	}
	labelCheckpoint, labelErr := buildVacuumVaultLabelCheckpoint(replica, oldContent)
	if labelErr != nil {
		return nil, labelErr
	}
	credentialLabelEntries, labelErr := buildVacuumCredentialLabelEntries(replica, oldContent)
	if labelErr != nil {
		return nil, labelErr
	}
	captureEntries := make([]canonical.Value, 0, len(projection.captureState))
	tails := make(map[canonical.Identifier]libraryCaptureCheckpoint)
	causeRemap := make(map[canonical.Identifier]canonical.Identifier)
	remapCause := func(source canonical.Identifier) (canonical.Identifier, error) {
		if mapped, exists := causeRemap[source]; exists {
			return mapped, nil
		}
		mapped, err := freshBaselineCauseID()
		if err != nil {
			return canonical.Identifier{}, err
		}
		causeRemap[source] = mapped
		return mapped, nil
	}
	for _, capture := range projection.captureState {
		bundleID, decodeErr := decodeHexIdentifier(capture.bundleID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Capture checkpoint identity is invalid: %w", decodeErr)
		}
		if (capture.lifecycleCode != 1 && capture.lifecycleCode != 2) || capture.registrationCause == (canonical.Identifier{}) || capture.registrationAttribution == nil {
			return nil, errors.New("Capture checkpoint state is invalid")
		}
		assignmentCauses := make([]canonical.Value, 0, len(capture.assignmentCauses))
		for _, sourceCause := range capture.assignmentCauses {
			mappedCause, mapErr := remapCause(sourceCause)
			if mapErr != nil {
				return nil, mapErr
			}
			assignmentCauses = append(assignmentCauses, mappedCause[:])
		}
		lifecycleCauses := make([]canonical.Value, 0, len(capture.lifecycleCauses))
		for _, sourceCause := range capture.lifecycleCauses {
			mappedCause, mapErr := remapCause(sourceCause)
			if mapErr != nil {
				return nil, mapErr
			}
			lifecycleCauses = append(lifecycleCauses, mappedCause[:])
		}
		registrationCause, mapErr := remapCause(capture.registrationCause)
		if mapErr != nil {
			return nil, mapErr
		}
		descriptorID := capture.descriptorID
		collectionID := capture.collectionID
		captureEntries = append(captureEntries, canonical.Map{
			0: bundleID[:], 1: descriptorID[:], 2: collectionID[:], 3: canonicalSetValues(assignmentCauses),
			4: capture.lifecycleCode, 5: canonicalSetValues(lifecycleCauses), 6: registrationCause[:], 7: capture.registrationAttribution,
		})
		previous, exists := tails[collectionID]
		if !exists || newerEvent(replica, previous.registrationCause, capture.registrationCause) {
			tails[collectionID] = capture
		}
	}
	sort.Slice(captureEntries, func(left, right int) bool {
		leftID, _ := replicaIdentifier(captureEntries[left], 0)
		rightID, _ := replicaIdentifier(captureEntries[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	collectionEntries := make([]canonical.Value, 0, len(projection.Collections))
	for _, collection := range projection.Collections {
		var title canonical.Value
		causes := []canonical.Value{}
		if collection.ExplicitTitle != nil {
			causeID, causeErr := freshBaselineCauseID()
			if causeErr != nil {
				return nil, causeErr
			}
			title = *collection.ExplicitTitle
			causes = canonicalSetValues([]canonical.Value{causeID[:]})
		}
		collectionID, decodeErr := decodeHexIdentifier(collection.CollectionID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Collection checkpoint identity is invalid: %w", decodeErr)
		}
		var folderID canonical.Value
		folderCauses := []canonical.Value{}
		if collection.FolderID != nil {
			decodedFolderID, folderErr := decodeHexIdentifier(*collection.FolderID)
			if folderErr != nil {
				return nil, fmt.Errorf("Collection checkpoint folder identity is invalid: %w", folderErr)
			}
			folderID = decodedFolderID[:]
			causeSet, causeErr := freshBaselineCauseSet()
			if causeErr != nil {
				return nil, causeErr
			}
			folderCauses = causeSet
		}
		var activeRedirect canonical.Value
		if collection.RedirectedTo != nil {
			destinationID, redirectErr := decodeHexIdentifier(*collection.RedirectedTo)
			if redirectErr != nil {
				return nil, fmt.Errorf("Collection checkpoint redirect identity is invalid: %w", redirectErr)
			}
			causeID, causeErr := freshBaselineCauseID()
			if causeErr != nil {
				return nil, causeErr
			}
			activeRedirect = canonical.Map{0: destinationID[:], 1: causeID[:]}
		}
		var intrinsicTail canonical.Value
		if tail, exists := tails[collectionID]; exists {
			bundleID, bundleErr := decodeHexIdentifier(tail.bundleID)
			if bundleErr != nil {
				return nil, fmt.Errorf("Collection checkpoint tail identity is invalid: %w", bundleErr)
			}
			registrationCause, causeErr := remapCause(tail.registrationCause)
			if causeErr != nil {
				return nil, causeErr
			}
			intrinsicTail = canonical.Map{0: bundleID[:], 1: registrationCause[:]}
		}
		collectionEntries = append(collectionEntries, canonical.Map{
			0: collectionID[:], 1: title, 2: causes, 3: folderID, 4: folderCauses, 5: activeRedirect, 6: intrinsicTail, 7: intrinsicTail,
		})
	}
	sort.Slice(collectionEntries, func(left, right int) bool {
		leftID, _ := replicaIdentifier(collectionEntries[left], 0)
		rightID, _ := replicaIdentifier(collectionEntries[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	folderEntries := make([]canonical.Value, 0, len(projection.Folders))
	for _, folder := range projection.Folders {
		folderID, decodeErr := decodeHexIdentifier(folder.FolderID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Folder checkpoint identity is invalid: %w", decodeErr)
		}
		nameCauseSet, causeErr := freshBaselineCauseSet()
		if causeErr != nil {
			return nil, causeErr
		}
		var parentID canonical.Value
		parentCauseSet := []canonical.Value{}
		if folder.ParentFolderID != nil {
			decodedParentID, parentErr := decodeHexIdentifier(*folder.ParentFolderID)
			if parentErr != nil {
				return nil, fmt.Errorf("Folder checkpoint parent identity is invalid: %w", parentErr)
			}
			parentID = decodedParentID[:]
			parentCauseSet, causeErr = freshBaselineCauseSet()
			if causeErr != nil {
				return nil, causeErr
			}
		}
		lifecycleCode, lifecycleOK := vacuumLifecycleCode(folder.Lifecycle)
		if !lifecycleOK {
			return nil, fmt.Errorf("Folder checkpoint lifecycle %q is invalid", folder.Lifecycle)
		}
		lifecycleCauseSet, causeErr := freshBaselineCauseSet()
		if causeErr != nil {
			return nil, causeErr
		}
		folderEntries = append(folderEntries, canonical.Map{
			0: folderID[:], 1: folder.Name, 2: nameCauseSet, 3: parentID, 4: parentCauseSet,
			5: lifecycleCode, 6: lifecycleCauseSet,
		})
	}
	sort.Slice(folderEntries, func(left, right int) bool {
		leftID, _ := replicaIdentifier(folderEntries[left], 0)
		rightID, _ := replicaIdentifier(folderEntries[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	tagEntries := make([]canonical.Value, 0, len(projection.Tags))
	for _, tag := range projection.Tags {
		tagID, decodeErr := decodeHexIdentifier(tag.TagID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Tag checkpoint identity is invalid: %w", decodeErr)
		}
		nameCauseSet, causeErr := freshBaselineCauseSet()
		if causeErr != nil {
			return nil, causeErr
		}
		lifecycleCode, lifecycleOK := vacuumLifecycleCode(tag.Lifecycle)
		if !lifecycleOK {
			return nil, fmt.Errorf("Tag checkpoint lifecycle %q is invalid", tag.Lifecycle)
		}
		lifecycleCauseSet, causeErr := freshBaselineCauseSet()
		if causeErr != nil {
			return nil, causeErr
		}
		var activeRedirect canonical.Value
		if tag.RedirectedTo != nil {
			destinationID, redirectErr := decodeHexIdentifier(*tag.RedirectedTo)
			if redirectErr != nil {
				return nil, fmt.Errorf("Tag checkpoint redirect identity is invalid: %w", redirectErr)
			}
			causeID, causeErr := freshBaselineCauseID()
			if causeErr != nil {
				return nil, causeErr
			}
			activeRedirect = canonical.Map{0: destinationID[:], 1: causeID[:]}
		}
		tagEntries = append(tagEntries, canonical.Map{0: tagID[:], 1: tag.Name, 2: nameCauseSet, 3: activeRedirect, 4: lifecycleCode, 5: lifecycleCauseSet})
	}
	sort.Slice(tagEntries, func(left, right int) bool {
		leftID, _ := replicaIdentifier(tagEntries[left], 0)
		rightID, _ := replicaIdentifier(tagEntries[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	assignmentEntries := make([]canonical.Value, 0, len(projection.TagAssignments))
	for _, assignment := range projection.TagAssignments {
		assignmentID, decodeErr := decodeHexIdentifier(assignment.AssignmentID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Tag Assignment checkpoint identity is invalid: %w", decodeErr)
		}
		tagID, decodeErr := decodeHexIdentifier(assignment.TagID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Tag Assignment checkpoint Tag identity is invalid: %w", decodeErr)
		}
		targetID, decodeErr := decodeHexIdentifier(assignment.TargetID)
		if decodeErr != nil {
			return nil, fmt.Errorf("Tag Assignment checkpoint target identity is invalid: %w", decodeErr)
		}
		if assignment.TargetKind != 1 && assignment.TargetKind != 2 {
			return nil, errors.New("Tag Assignment checkpoint target kind is invalid")
		}
		causeID, causeErr := freshBaselineCauseID()
		if causeErr != nil {
			return nil, causeErr
		}
		assignmentEntries = append(assignmentEntries, canonical.Map{0: assignmentID[:], 1: causeID[:], 2: tagID[:], 3: canonical.Map{0: assignment.TargetKind, 1: targetID[:]}})
	}
	sort.Slice(assignmentEntries, func(left, right int) bool {
		leftID, _ := replicaIdentifier(assignmentEntries[left], 0)
		rightID, _ := replicaIdentifier(assignmentEntries[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	noteEntries := make([]canonical.Value, 0, len(projection.noteState))
	for _, note := range projection.noteState {
		if note.stateCode < 1 || note.stateCode > 3 || len(note.versions) == 0 {
			return nil, errors.New("Note checkpoint state is invalid")
		}
		if note.stateCode == 1 && len(note.versions) != 1 {
			return nil, errors.New("Active Note checkpoint must have one version")
		}
		noteID := note.noteID
		if note.targetKind != 1 && note.targetKind != 2 {
			return nil, errors.New("Note checkpoint target kind is invalid")
		}
		versions := make([]canonical.Value, 0, len(note.versions))
		for _, version := range note.versions {
			if version.attribution == nil || version.causeID == (canonical.Identifier{}) {
				return nil, errors.New("Note checkpoint version attribution is incomplete")
			}
			causeID, causeErr := remapCause(version.causeID)
			if causeErr != nil {
				return nil, causeErr
			}
			var contentValue canonical.Value
			if version.contentID != nil {
				contentValue = append([]byte(nil), version.contentID[:]...)
			}
			var restoreValue canonical.Value
			if version.restoreID != nil {
				restoreValue = append([]byte(nil), version.restoreID[:]...)
			}
			if contentValue != nil && restoreValue != nil {
				return nil, errors.New("Note checkpoint version contains both content and restore objects")
			}
			if contentValue == nil && restoreValue == nil {
				return nil, errors.New("Note checkpoint deletion has no retained content")
			}
			versions = append(versions, canonical.Map{0: causeID[:], 1: contentValue, 2: restoreValue, 3: version.attribution})
		}
		sort.Slice(versions, func(left, right int) bool {
			leftID, _ := replicaIdentifier(versions[left], 0)
			rightID, _ := replicaIdentifier(versions[right], 0)
			return bytes.Compare(leftID[:], rightID[:]) < 0
		})
		target := canonical.Map{0: note.targetKind, 1: note.targetID[:]}
		noteEntries = append(noteEntries, canonical.Map{0: noteID[:], 1: target, 2: note.stateCode, 3: versions})
	}
	sort.Slice(noteEntries, func(left, right int) bool {
		leftID, _ := replicaIdentifier(noteEntries[left], 0)
		rightID, _ := replicaIdentifier(noteEntries[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	activeConflictEntries := make([]canonical.Value, 0, len(projection.conflictState))
	for _, conflict := range projection.conflictState {
		if conflict.kind != 1 && conflict.kind != 2 && conflict.kind != 3 && conflict.kind != 4 {
			return nil, errors.New("Vacuum active conflict kind is unsupported")
		}
		subjects := make([]canonical.Value, 0, len(conflict.subjects))
		for _, subjectID := range conflict.subjects {
			subjects = append(subjects, subjectID[:])
		}
		candidates := make([]canonical.Value, 0, len(conflict.candidates))
		for _, candidate := range conflict.candidates {
			mappedCause, causeErr := remapCause(candidate.headCauseID)
			if causeErr != nil {
				return nil, causeErr
			}
			var state canonical.Value
			if conflict.kind == 4 {
				if candidate.noteID == (canonical.Identifier{}) {
					return nil, errors.New("Vacuum Note conflict candidate is incomplete")
				}
				var contentValue canonical.Value
				if candidate.contentID != nil {
					contentValue = append([]byte(nil), candidate.contentID[:]...)
				}
				state = canonical.Map{0: candidate.noteID[:], 1: contentValue}
			} else if conflict.kind == 2 {
				placements := make([]canonical.Value, 0, len(candidate.placements))
				for _, placement := range candidate.placements {
					var parentValue canonical.Value
					if placement.parentID != nil {
						parentValue = append([]byte(nil), placement.parentID[:]...)
					}
					placements = append(placements, canonical.Map{0: placement.folderID[:], 1: parentValue})
				}
				sort.Slice(placements, func(left, right int) bool {
					leftID, _ := replicaIdentifier(placements[left], 0)
					rightID, _ := replicaIdentifier(placements[right], 0)
					return bytes.Compare(leftID[:], rightID[:]) < 0
				})
				state = canonical.Map{0: placements}
			} else {
				redirects := make([]canonical.Value, 0, len(candidate.redirects))
				for _, edge := range candidate.redirects {
					redirects = append(redirects, canonical.Map{0: edge.sourceID[:], 1: edge.destinationID[:]})
				}
				sort.Slice(redirects, func(left, right int) bool {
					leftSource, _ := replicaIdentifier(redirects[left], 0)
					rightSource, _ := replicaIdentifier(redirects[right], 0)
					return bytes.Compare(leftSource[:], rightSource[:]) < 0
				})
				state = canonical.Map{0: redirects}
			}
			candidates = append(candidates, canonical.Map{0: mappedCause[:], 1: state})
		}
		sort.Slice(candidates, func(left, right int) bool {
			leftCause, _ := replicaIdentifier(candidates[left], 0)
			rightCause, _ := replicaIdentifier(candidates[right], 0)
			return bytes.Compare(leftCause[:], rightCause[:]) < 0
		})
		activeConflictEntries = append(activeConflictEntries, canonical.Map{0: conflict.kind, 1: canonicalSetValues(subjects), 2: candidates})
	}
	return canonical.Map{
		0: uint64(1), 1: labelCheckpoint, 2: credentialLabelEntries, 3: captureEntries,
		4: collectionEntries, 5: folderEntries, 6: tagEntries, 7: assignmentEntries,
		8: noteEntries, 9: activeConflictEntries,
	}, nil
}

func buildVacuumCredentialLabelEntries(replica *Replica, oldContent canonical.Value) ([]canonical.Value, error) {
	entries, ok := replicaMapArray(oldContent, 2)
	if !ok {
		return nil, errors.New("Baseline Credential label checkpoint is invalid")
	}
	factsByCredential := make(map[canonical.Identifier][]credentialLabelFact)
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 3) {
			return nil, fmt.Errorf("Baseline Credential label entry %d is invalid", index)
		}
		credentialID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return nil, fmt.Errorf("Baseline Credential label entry %d Client Credential ID is invalid", index)
		}
		value, ok := replicaMapNullableText(entry, 1)
		if !ok {
			return nil, fmt.Errorf("Baseline Credential label entry %d value is invalid", index)
		}
		causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 2), "Baseline Credential label causes", true)
		if err != nil {
			return nil, err
		}
		for _, causeID := range causes {
			factsByCredential[credentialID] = append(factsByCredential[credentialID], credentialLabelFact{
				credentialID: credentialID, causeID: causeID, value: cloneStringPointer(value),
			})
		}
	}
	orderedEvents, err := orderedContentEvents(replica)
	if err != nil {
		return nil, err
	}
	for _, event := range orderedEvents {
		if event.Type != 2 {
			continue
		}
		if !replicaMapHasKeys(event.Body, 2) {
			return nil, errors.New("Client Credential Label body is invalid")
		}
		credentialID, ok := replicaIdentifier(event.Body, 0)
		if !ok {
			return nil, errors.New("Client Credential Label Client Credential ID is invalid")
		}
		value, ok := replicaMapNullableText(event.Body, 1)
		if !ok {
			return nil, errors.New("Client Credential Label value is invalid")
		}
		factsByCredential[credentialID] = append(factsByCredential[credentialID], credentialLabelFact{
			credentialID: credentialID, causeID: event.RecordID, value: cloneStringPointer(value),
		})
	}
	result := make([]canonical.Value, 0, len(factsByCredential))
	credentialIDs := make([]canonical.Identifier, 0, len(factsByCredential))
	for credentialID := range factsByCredential {
		credentialIDs = append(credentialIDs, credentialID)
	}
	sort.Slice(credentialIDs, func(left, right int) bool {
		return bytes.Compare(credentialIDs[left][:], credentialIDs[right][:]) < 0
	})
	for _, credentialID := range credentialIDs {
		facts := factsByCredential[credentialID]
		maxima := make([]credentialLabelFact, 0, len(facts))
		for index, candidate := range facts {
			superseded := false
			for otherIndex, other := range facts {
				if index != otherIndex && replica.IsAncestor(candidate.causeID, other.causeID) {
					superseded = true
					break
				}
			}
			if !superseded {
				maxima = append(maxima, candidate)
			}
		}
		if len(maxima) == 0 {
			return nil, errors.New("Credential label checkpoint has no causal maximum")
		}
		sort.Slice(maxima, func(left, right int) bool {
			return bytes.Compare(maxima[left].causeID[:], maxima[right].causeID[:]) > 0
		})
		causeID, err := freshBaselineCauseID()
		if err != nil {
			return nil, err
		}
		result = append(result, canonical.Map{0: credentialID[:], 1: cloneStringValue(maxima[0].value), 2: canonicalSetValues([]canonical.Value{causeID[:]})})
	}
	return result, nil
}

func buildVacuumVaultLabelCheckpoint(replica *Replica, oldContent canonical.Value) (canonical.Value, error) {
	oldLabel, ok := replicaMapEntry(oldContent, 1)
	if !ok || !replicaMapHasKeys(oldLabel, 2) {
		return nil, errors.New("Baseline Vault label checkpoint is invalid")
	}
	value, ok := replicaMapNullableText(oldLabel, 0)
	if !ok {
		return nil, errors.New("Baseline Vault label checkpoint value is invalid")
	}
	causes, err := parseCanonicalIdentifierSet(replicaMapEntryMust(oldLabel, 1), "Baseline Vault label causes", false)
	if err != nil {
		return nil, err
	}
	type labelFact struct {
		causeID canonical.Identifier
		value   *string
		event   bool
	}
	facts := make([]labelFact, 0, len(causes))
	for _, causeID := range causes {
		facts = append(facts, labelFact{causeID: causeID, value: cloneStringPointer(value)})
	}
	orderedEvents, err := orderedContentEvents(replica)
	if err != nil {
		return nil, err
	}
	for _, event := range orderedEvents {
		if event.Type != 1 {
			continue
		}
		if !replicaMapHasKeys(event.Body, 1) {
			return nil, errors.New("Vault Label body is invalid")
		}
		eventValue, valueOK := replicaMapNullableText(event.Body, 0)
		if !valueOK {
			return nil, errors.New("Vault Label value is invalid")
		}
		facts = append(facts, labelFact{causeID: event.RecordID, value: cloneStringPointer(eventValue), event: true})
	}
	if len(facts) == 0 {
		return canonical.Map{0: nil, 1: []canonical.Value{}}, nil
	}
	maxima := make([]labelFact, 0, len(facts))
	for index, candidate := range facts {
		superseded := false
		for otherIndex, other := range facts {
			if index == otherIndex {
				continue
			}
			// A source baseline is the state before every Content Event. Its
			// opaque checkpoint cause is not a DAG vertex, so represent that
			// ordering explicitly instead of letting a random identifier win
			// against a later label Event.
			if !candidate.event && other.event {
				superseded = true
				break
			}
			if candidate.event && other.event && replica.IsAncestor(candidate.causeID, other.causeID) {
				superseded = true
				break
			}
		}
		if !superseded {
			maxima = append(maxima, candidate)
		}
	}
	if len(maxima) == 0 {
		return nil, errors.New("Vault label checkpoint has no causal maximum")
	}
	sort.Slice(maxima, func(left, right int) bool {
		return bytes.Compare(maxima[left].causeID[:], maxima[right].causeID[:]) > 0
	})
	causeID, err := freshBaselineCauseID()
	if err != nil {
		return nil, err
	}
	return canonical.Map{0: cloneStringValue(maxima[0].value), 1: canonicalSetValues([]canonical.Value{causeID[:]})}, nil
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func cloneStringValue(value *string) canonical.Value {
	if value == nil {
		return nil
	}
	return *value
}

func freshBaselineCauseSet() ([]canonical.Value, error) {
	causeID, err := freshBaselineCauseID()
	if err != nil {
		return nil, err
	}
	return canonicalSetValues([]canonical.Value{causeID[:]}), nil
}

func vacuumLifecycleCode(value string) (uint64, bool) {
	switch value {
	case "Active":
		return 1, true
	case "Deleted":
		return 2, true
	default:
		return 0, false
	}
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

type libraryNoteState struct {
	noteID     canonical.Identifier
	targetKind uint64
	targetID   canonical.Identifier
	versions   map[canonical.Identifier]libraryNoteVersionState
}

type libraryNoteVersionState struct {
	causeID     canonical.Identifier
	contentID   *canonical.Identifier
	restoreID   *canonical.Identifier
	title       *string
	body        *string
	dialect     *string
	assertedAt  int64
	attribution canonical.Value
}

func currentNoteHeadCauses(replica *Replica, note *libraryNoteState) []canonical.Identifier {
	causes := make([]canonical.Identifier, 0, len(note.versions))
	for cause := range note.versions {
		superseded := false
		for other := range note.versions {
			if cause != other && replica.IsAncestor(cause, other) {
				superseded = true
				break
			}
		}
		if !superseded {
			causes = append(causes, cause)
		}
	}
	return sortUniqueIdentifiers(causes)
}

func sameNoteIdentifierSet(left, right []canonical.Identifier) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[canonical.Identifier]struct{}, len(left))
	for _, value := range left {
		seen[value] = struct{}{}
	}
	for _, value := range right {
		if _, ok := seen[value]; !ok {
			return false
		}
	}
	return true
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

func decodeLibraryNoteTarget(value canonical.Value) (uint64, canonical.Identifier, error) {
	body, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(body, 2) {
		return 0, canonical.Identifier{}, errors.New("Note target is invalid")
	}
	kind, ok := replicaUnsignedNumber(replicaMapEntryMust(body, 0))
	if !ok || (kind != 1 && kind != 2) {
		return 0, canonical.Identifier{}, errors.New("Note target kind is invalid")
	}
	targetID, ok := replicaIdentifier(body, 1)
	if !ok {
		return 0, canonical.Identifier{}, errors.New("Note target ID is invalid")
	}
	return kind, targetID, nil
}

func projectNoteVersion(replica *Replica, event canonical.Event, causeID canonical.Identifier, contentID *canonical.Identifier) (libraryNoteVersionState, error) {
	version, err := projectNoteContentVersion(replica, causeID, contentID, event.AssertedAt)
	if err != nil {
		return libraryNoteVersionState{}, err
	}
	if event.SignerCredentialID != (canonical.Identifier{}) {
		attribution, attributionErr := captureEventAttribution(replica, event)
		if attributionErr != nil {
			return libraryNoteVersionState{}, fmt.Errorf("Note attribution: %w", attributionErr)
		}
		version.attribution = attribution
	}
	return version, nil
}

func projectNoteContentVersion(replica *Replica, causeID canonical.Identifier, contentID *canonical.Identifier, assertedAt int64) (libraryNoteVersionState, error) {
	version := libraryNoteVersionState{causeID: causeID, assertedAt: assertedAt}
	if contentID == nil {
		return version, nil
	}
	object, ok := replica.Object(*contentID)
	if !ok || object.ObjectType != 3 {
		return libraryNoteVersionState{}, errors.New("Note Content Object is unavailable")
	}
	body, ok := replicaMapValue(object.Body)
	if !ok || !replicaMapHasKeys(body, 4) {
		return libraryNoteVersionState{}, errors.New("Note Content Object body is invalid")
	}
	title, ok := replicaMapNullableText(body, 1)
	if !ok {
		return libraryNoteVersionState{}, errors.New("Note Content title is invalid")
	}
	text, ok := replicaMapText(body, 2)
	if !ok {
		return libraryNoteVersionState{}, errors.New("Note Content body is invalid")
	}
	dialect, ok := replicaMapText(body, 3)
	if !ok || dialect != "awsm.note.commonmark" {
		return libraryNoteVersionState{}, errors.New("Note Content dialect is invalid")
	}
	dialectCopy := dialect
	textCopy := text
	version.contentID = contentID
	version.title = title
	version.body = &textCopy
	version.dialect = &dialectCopy
	return version, nil
}

func seedBaselineNotes(replica *Replica, notes map[canonical.Identifier]*libraryNoteState) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 8)
	if !ok {
		return errors.New("Baseline Note checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 4) {
			return fmt.Errorf("Baseline Note entry %d is invalid", index)
		}
		noteID, ok := replicaIdentifier(entry, 0)
		if !ok {
			return fmt.Errorf("Baseline Note entry %d ID is invalid", index)
		}
		targetKind, targetID, err := decodeLibraryNoteTarget(replicaMapEntryMust(entry, 1))
		if err != nil {
			return err
		}
		stateCode, ok := replicaUnsignedNumber(replicaMapEntryMust(entry, 2))
		if !ok || stateCode < 1 || stateCode > 3 {
			return fmt.Errorf("Baseline Note entry %d state is invalid", index)
		}
		versions, ok := replicaMapArray(entry, 3)
		if !ok || len(versions) == 0 {
			return fmt.Errorf("Baseline Note entry %d versions are invalid", index)
		}
		if stateCode == 1 && len(versions) != 1 {
			return fmt.Errorf("Baseline Note entry %d active state must have one version", index)
		}
		if _, exists := notes[noteID]; exists {
			return fmt.Errorf("Baseline Note %s is repeated", hexIdentifier(noteID))
		}
		versionState := make(map[canonical.Identifier]libraryNoteVersionState, len(versions))
		for versionIndex, versionValue := range versions {
			if !replicaMapHasKeys(versionValue, 4) {
				return fmt.Errorf("Baseline Note %d version %d is invalid", index, versionIndex)
			}
			causeID, ok := replicaIdentifier(versionValue, 0)
			if !ok {
				return fmt.Errorf("Baseline Note %d version %d cause is invalid", index, versionIndex)
			}
			if _, exists := versionState[causeID]; exists {
				return fmt.Errorf("Baseline Note %s repeats version cause", hexIdentifier(noteID))
			}
			var contentID *canonical.Identifier
			if raw := replicaMapEntryMust(versionValue, 1); raw != nil {
				decoded, decodedOK := replicaIdentifierValue(raw)
				if !decodedOK {
					return fmt.Errorf("Baseline Note %d version %d content object is invalid", index, versionIndex)
				}
				contentID = &decoded
			}
			var restoreID *canonical.Identifier
			if raw := replicaMapEntryMust(versionValue, 2); raw != nil {
				decoded, decodedOK := replicaIdentifierValue(raw)
				if !decodedOK {
					return fmt.Errorf("Baseline Note %d version %d restore object is invalid", index, versionIndex)
				}
				restoreID = &decoded
			}
			attribution, ok := replicaMapValue(replicaMapEntryMust(versionValue, 3))
			if !ok || !replicaMapHasKeys(attribution, 4) {
				return fmt.Errorf("Baseline Note %d version %d attribution is invalid", index, versionIndex)
			}
			for _, key := range []uint64{0, 1, 2} {
				if _, valid := replicaIdentifier(attribution, key); !valid {
					return fmt.Errorf("Baseline Note %d version %d attribution identity is invalid", index, versionIndex)
				}
			}
			assertedAt, valid := replicaMapSignedNumber(attribution, 3)
			if !valid {
				return fmt.Errorf("Baseline Note %d version %d attribution timestamp is invalid", index, versionIndex)
			}
			if contentID == nil && restoreID == nil {
				return fmt.Errorf("Baseline Note %d version %d deletion has no retained content", index, versionIndex)
			}
			if contentID != nil && restoreID != nil {
				return fmt.Errorf("Baseline Note %d version %d has both content and restore objects", index, versionIndex)
			}
			version, versionErr := projectNoteContentVersion(replica, causeID, contentID, assertedAt)
			if versionErr != nil {
				return versionErr
			}
			version.attribution = attribution
			version.restoreID = restoreID
			if restoreID != nil {
				if _, restoreErr := projectNoteContentVersion(replica, causeID, restoreID, assertedAt); restoreErr != nil {
					return fmt.Errorf("Baseline Note restore content: %w", restoreErr)
				}
			}
			versionState[causeID] = version
		}
		for _, version := range versionState {
			if stateCode == 1 && version.contentID == nil {
				return fmt.Errorf("Baseline Note %d active state contains deletion", index)
			}
			if stateCode == 2 && version.contentID != nil {
				return fmt.Errorf("Baseline Note %d deleted state contains active content", index)
			}
		}
		notes[noteID] = &libraryNoteState{noteID: noteID, targetKind: targetKind, targetID: targetID, versions: versionState}
	}
	return nil
}

func seedBaselineRedirectConflicts(replica *Replica, collectionRedirects, tagRedirects map[canonical.Identifier]collectionRedirectFact, notes map[canonical.Identifier]*libraryNoteState) error {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return err
	}
	entries, ok := replicaMapArray(content, 9)
	if !ok {
		return errors.New("Baseline active conflict checkpoint is invalid")
	}
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 3) {
			return fmt.Errorf("Baseline active conflict entry %d is invalid", index)
		}
		kind, ok := replicaUnsignedNumber(replicaMapEntryMust(entry, 0))
		if !ok || (kind != 1 && kind != 2 && kind != 3 && kind != 4) {
			return fmt.Errorf("Baseline active conflict entry %d kind is invalid", index)
		}
		candidates, ok := replicaMapArray(entry, 2)
		if !ok || len(candidates) < 2 {
			return fmt.Errorf("Baseline active conflict entry %d candidates are invalid", index)
		}
		if kind == 2 {
			continue
		}
		if kind == 4 {
			subjects, subjectErr := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 1), "Baseline Note conflict subjects", true)
			if subjectErr != nil || len(subjects) != 1 {
				return fmt.Errorf("Baseline Note conflict subjects are invalid")
			}
			note := notes[subjects[0]]
			if note == nil {
				return fmt.Errorf("Baseline Note conflict target %s is unknown", hexIdentifier(subjects[0]))
			}
			for candidateIndex, candidate := range candidates {
				if !replicaMapHasKeys(candidate, 2) {
					return fmt.Errorf("Baseline Note conflict candidate %d is invalid", candidateIndex)
				}
				causeID, causeOK := replicaIdentifier(candidate, 0)
				state, stateOK := replicaMapValue(replicaMapEntryMust(candidate, 1))
				if !causeOK || !stateOK || !replicaMapHasKeys(state, 2) {
					return fmt.Errorf("Baseline Note conflict candidate %d is invalid", candidateIndex)
				}
				candidateNoteID, candidateNoteOK := replicaIdentifier(state, 0)
				if !candidateNoteOK || candidateNoteID != subjects[0] {
					return fmt.Errorf("Baseline Note conflict candidate %d Note ID is invalid", candidateIndex)
				}
				if _, exists := note.versions[causeID]; !exists {
					return fmt.Errorf("Baseline Note conflict candidate %d cause is unknown", candidateIndex)
				}
			}
			continue
		}
		for candidateIndex, candidate := range candidates {
			if !replicaMapHasKeys(candidate, 2) {
				return fmt.Errorf("Baseline active conflict entry %d candidate %d is invalid", index, candidateIndex)
			}
			causeID, ok := replicaIdentifier(candidate, 0)
			if !ok {
				return fmt.Errorf("Baseline active conflict entry %d candidate %d cause is invalid", index, candidateIndex)
			}
			state, ok := replicaMapValue(replicaMapEntryMust(candidate, 1))
			if !ok || !replicaMapHasKeys(state, 1) {
				return fmt.Errorf("Baseline active conflict entry %d candidate %d state is invalid", index, candidateIndex)
			}
			kindName := "Collection"
			redirects := collectionRedirects
			if kind == 3 {
				kindName = "Tag"
				redirects = tagRedirects
			}
			edges, edgeErr := parseLibraryRedirectEdges(replicaMapEntryMust(state, 0), causeID, kindName)
			if edgeErr != nil {
				return edgeErr
			}
			if _, exists := redirects[causeID]; exists {
				return fmt.Errorf("Baseline active conflict candidate %s is repeated", hexIdentifier(causeID))
			}
			redirects[causeID] = collectionRedirectFact{causeID: causeID, edges: edges}
		}
	}
	return nil
}

func seedBaselineFolderConflicts(replica *Replica, folders map[canonical.Identifier]*libraryFolderState) ([]libraryConflictCheckpoint, error) {
	content, err := baselineContentCheckpoint(replica.baseline)
	if err != nil {
		return nil, err
	}
	entries, ok := replicaMapArray(content, 9)
	if !ok {
		return nil, errors.New("Baseline active conflict checkpoint is invalid")
	}
	result := make([]libraryConflictCheckpoint, 0)
	for index, entry := range entries {
		kind, ok := replicaUnsignedNumber(replicaMapEntryMust(entry, 0))
		if !ok || kind != 2 {
			continue
		}
		subjects, err := parseCanonicalIdentifierSet(replicaMapEntryMust(entry, 1), "Baseline Folder conflict subjects", true)
		if err != nil || len(subjects) == 0 {
			return nil, fmt.Errorf("Baseline Folder conflict entry %d subjects are invalid", index)
		}
		candidates, ok := replicaMapArray(entry, 2)
		if !ok || len(candidates) < 2 {
			return nil, fmt.Errorf("Baseline Folder conflict entry %d candidates are invalid", index)
		}
		candidateState := make([]libraryConflictCandidate, 0, len(candidates))
		for candidateIndex, candidate := range candidates {
			if !replicaMapHasKeys(candidate, 2) {
				return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d is invalid", index, candidateIndex)
			}
			causeID, ok := replicaIdentifier(candidate, 0)
			if !ok {
				return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d cause is invalid", index, candidateIndex)
			}
			state, ok := replicaMapValue(replicaMapEntryMust(candidate, 1))
			if !ok || !replicaMapHasKeys(state, 1) {
				return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d state is invalid", index, candidateIndex)
			}
			placements, ok := replicaMapArrayValue(replicaMapEntryMust(state, 0))
			if !ok || len(placements) == 0 {
				return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d placements are invalid", index, candidateIndex)
			}
			candidatePlacements := make([]libraryFolderPlacement, 0, len(placements))
			seen := make(map[canonical.Identifier]struct{}, len(placements))
			for placementIndex, placement := range placements {
				if !replicaMapHasKeys(placement, 2) {
					return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d placement %d is invalid", index, candidateIndex, placementIndex)
				}
				folderID, ok := replicaIdentifier(placement, 0)
				if !ok || folders[folderID] == nil {
					return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d placement %d Folder ID is invalid", index, candidateIndex, placementIndex)
				}
				if _, exists := seen[folderID]; exists {
					return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d repeats Folder ID", index, candidateIndex)
				}
				seen[folderID] = struct{}{}
				parentID, parentErr := nullableIdentifier(replicaMapEntryMust(placement, 1), "Baseline Folder conflict parent Folder ID")
				if parentErr != nil {
					return nil, parentErr
				}
				if parentID != nil && *parentID == folderID {
					return nil, fmt.Errorf("Baseline Folder conflict entry %d candidate %d creates a self-parent", index, candidateIndex)
				}
				candidatePlacements = append(candidatePlacements, libraryFolderPlacement{folderID: folderID, parentID: cloneIdentifierPointer(parentID)})
			}
			sort.Slice(candidatePlacements, func(left, right int) bool {
				return bytes.Compare(candidatePlacements[left].folderID[:], candidatePlacements[right].folderID[:]) < 0
			})
			candidateState = append(candidateState, libraryConflictCandidate{headCauseID: causeID, placements: candidatePlacements})
		}
		sort.Slice(candidateState, func(left, right int) bool {
			return bytes.Compare(candidateState[left].headCauseID[:], candidateState[right].headCauseID[:]) < 0
		})
		result = append(result, libraryConflictCheckpoint{kind: 2, subjects: subjects, candidates: candidateState})
	}
	sort.Slice(result, func(left, right int) bool {
		return bytes.Compare(result[left].subjects[0][:], result[right].subjects[0][:]) < 0
	})
	return result, nil
}

func projectConflictCheckpointState(replica *Replica, conflicts []LibraryConflict, collectionRedirects, tagRedirects map[canonical.Identifier]collectionRedirectFact) ([]libraryConflictCheckpoint, error) {
	result := make([]libraryConflictCheckpoint, 0, len(conflicts))
	for _, conflict := range conflicts {
		kind := uint64(0)
		redirects := collectionRedirects
		switch conflict.Kind {
		case "CollectionMerge":
			kind = 1
		case "TagMerge":
			kind = 3
			redirects = tagRedirects
		case "Folder":
			kind = 2
		default:
			continue
		}
		subjects := make([]canonical.Identifier, 0, len(conflict.SubjectIDs))
		for _, text := range conflict.SubjectIDs {
			id, err := decodeHexIdentifier(text)
			if err != nil {
				return nil, fmt.Errorf("active %s conflict subject is invalid", conflict.Kind)
			}
			subjects = append(subjects, id)
		}
		candidates := make([]libraryConflictCandidate, 0, len(conflict.CandidateRecordIDs))
		if kind == 2 {
			candidateState, candidateErr := projectDynamicFolderConflictCandidates(replica, subjects, conflict.CandidateRecordIDs)
			if candidateErr != nil {
				return nil, candidateErr
			}
			if len(candidateState) == 0 {
				// Baseline Folder conflicts are appended from their authenticated
				// checkpoint below; their Baseline Cause IDs are not Records.
				continue
			}
			result = append(result, libraryConflictCheckpoint{kind: kind, subjects: subjects, candidates: candidateState})
			continue
		}
		for _, text := range conflict.CandidateRecordIDs {
			causeID, err := decodeHexIdentifier(text)
			if err != nil {
				return nil, fmt.Errorf("active %s conflict cause is invalid", conflict.Kind)
			}
			fact, ok := redirects[causeID]
			if !ok {
				return nil, fmt.Errorf("active %s conflict candidate %s is unavailable", conflict.Kind, text)
			}
			candidates = append(candidates, libraryConflictCandidate{headCauseID: causeID, redirects: cloneRedirectEdges(fact.edges)})
		}
		sort.Slice(candidates, func(left, right int) bool {
			return bytes.Compare(candidates[left].headCauseID[:], candidates[right].headCauseID[:]) < 0
		})
		result = append(result, libraryConflictCheckpoint{kind: kind, subjects: subjects, candidates: candidates})
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].kind != result[right].kind {
			return result[left].kind < result[right].kind
		}
		if len(result[left].subjects) == 0 || len(result[right].subjects) == 0 {
			return len(result[left].subjects) < len(result[right].subjects)
		}
		return bytes.Compare(result[left].subjects[0][:], result[right].subjects[0][:]) < 0
	})
	return result, nil
}

func projectDynamicFolderConflictCandidates(replica *Replica, subjects []canonical.Identifier, causeTexts []string) ([]libraryConflictCandidate, error) {
	if replica == nil {
		return nil, errors.New("Folder conflict Replica is required")
	}
	folders := make(map[canonical.Identifier]*libraryFolderState)
	if err := seedBaselineFolders(replica, folders); err != nil {
		return nil, err
	}
	events, err := orderedContentEvents(replica)
	if err != nil {
		return nil, err
	}
	for _, event := range events {
		switch event.Type {
		case 12:
			folderID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return nil, errors.New("Folder conflict checkpoint Folder Created ID is invalid")
			}
			parent, parentErr := nullableIdentifier(replicaMapEntryMust(event.Body, 2), "Folder conflict checkpoint parent Folder ID")
			if parentErr != nil {
				return nil, parentErr
			}
			folder := folders[folderID]
			if folder == nil {
				folders[folderID] = &libraryFolderState{id: folderID, parent: parent, parentCause: event.RecordID}
				continue
			}
			if newerEvent(replica, folder.parentCause, event.RecordID) {
				folder.parent, folder.parentCause = parent, event.RecordID
			}
		case 14:
			folderID, ok := replicaIdentifier(event.Body, 0)
			if !ok {
				return nil, errors.New("Folder conflict checkpoint Parent Placement ID is invalid")
			}
			parent, parentErr := nullableIdentifier(replicaMapEntryMust(event.Body, 1), "Folder conflict checkpoint parent Folder ID")
			if parentErr != nil {
				return nil, parentErr
			}
			folder := folders[folderID]
			if folder == nil {
				folders[folderID] = &libraryFolderState{id: folderID, parent: parent, parentCause: event.RecordID}
				continue
			}
			if newerEvent(replica, folder.parentCause, event.RecordID) {
				folder.parent, folder.parentCause = parent, event.RecordID
			}
		case 17:
			placements, ok := replicaMapArrayValue(replicaMapEntryMust(event.Body, 1))
			if !ok {
				return nil, errors.New("Folder conflict checkpoint Resolution placements are invalid")
			}
			for _, placement := range placements {
				folderBody, ok := replicaMapValue(placement)
				if !ok {
					return nil, errors.New("Folder conflict checkpoint Resolution placement is invalid")
				}
				folderID, ok := replicaIdentifier(folderBody, 0)
				if !ok {
					return nil, errors.New("Folder conflict checkpoint Resolution Folder ID is invalid")
				}
				parent, parentErr := nullableIdentifier(replicaMapEntryMust(folderBody, 1), "Folder conflict checkpoint Resolution parent Folder ID")
				if parentErr != nil {
					return nil, parentErr
				}
				folder := folders[folderID]
				if folder == nil {
					folders[folderID] = &libraryFolderState{id: folderID, parent: parent, parentCause: event.RecordID}
					continue
				}
				folder.parent, folder.parentCause = parent, event.RecordID
			}
		}
	}
	current := make(map[canonical.Identifier]*canonical.Identifier, len(folders))
	for folderID, folder := range folders {
		current[folderID] = cloneIdentifierPointer(folder.parent)
	}
	result := make([]libraryConflictCandidate, 0, len(causeTexts))
	for _, text := range causeTexts {
		causeID, decodeErr := decodeHexIdentifier(text)
		if decodeErr != nil {
			return nil, fmt.Errorf("active Folder conflict cause is invalid")
		}
		candidateParents := make(map[canonical.Identifier]*canonical.Identifier, len(current))
		for folderID, parent := range current {
			candidateParents[folderID] = cloneIdentifierPointer(parent)
		}
		if record, exists := replica.Record(causeID); exists && record.Event != nil {
			if err := applyFolderConflictCandidateEvent(record.Event, candidateParents); err != nil {
				return nil, err
			}
		} else {
			// No current-generation Record means this is a Baseline Cause.
			// Leave its checkpoint-derived placement in the candidate state.
			continue
		}
		placements := make([]libraryFolderPlacement, 0, len(subjects))
		for _, folderID := range subjects {
			parent, exists := candidateParents[folderID]
			if !exists {
				return nil, fmt.Errorf("active Folder conflict subject %s is unavailable", hexIdentifier(folderID))
			}
			placements = append(placements, libraryFolderPlacement{folderID: folderID, parentID: cloneIdentifierPointer(parent)})
		}
		sort.Slice(placements, func(left, right int) bool {
			return bytes.Compare(placements[left].folderID[:], placements[right].folderID[:]) < 0
		})
		result = append(result, libraryConflictCandidate{headCauseID: causeID, placements: placements})
	}
	sort.Slice(result, func(left, right int) bool {
		return bytes.Compare(result[left].headCauseID[:], result[right].headCauseID[:]) < 0
	})
	return result, nil
}

func applyFolderConflictCandidateEvent(event *canonical.Event, parents map[canonical.Identifier]*canonical.Identifier) error {
	if event == nil {
		return errors.New("Folder conflict candidate Event is unavailable")
	}
	switch event.Type {
	case 12:
		folderID, ok := replicaIdentifier(event.Body, 0)
		if !ok {
			return errors.New("Folder conflict candidate Created ID is invalid")
		}
		parent, err := nullableIdentifier(replicaMapEntryMust(event.Body, 2), "Folder conflict candidate parent Folder ID")
		if err != nil {
			return err
		}
		parents[folderID] = parent
	case 14:
		folderID, ok := replicaIdentifier(event.Body, 0)
		if !ok {
			return errors.New("Folder conflict candidate Placement ID is invalid")
		}
		parent, err := nullableIdentifier(replicaMapEntryMust(event.Body, 1), "Folder conflict candidate parent Folder ID")
		if err != nil {
			return err
		}
		parents[folderID] = parent
	case 17:
		placements, ok := replicaMapArrayValue(replicaMapEntryMust(event.Body, 1))
		if !ok {
			return errors.New("Folder conflict candidate Resolution placements are invalid")
		}
		for _, placement := range placements {
			body, ok := replicaMapValue(placement)
			if !ok {
				return errors.New("Folder conflict candidate Resolution placement is invalid")
			}
			folderID, ok := replicaIdentifier(body, 0)
			if !ok {
				return errors.New("Folder conflict candidate Resolution Folder ID is invalid")
			}
			parent, err := nullableIdentifier(replicaMapEntryMust(body, 1), "Folder conflict candidate Resolution parent Folder ID")
			if err != nil {
				return err
			}
			parents[folderID] = parent
		}
	}
	return nil
}

func cloneRedirectEdges(edges []collectionRedirectEdge) []collectionRedirectEdge {
	result := make([]collectionRedirectEdge, len(edges))
	copy(result, edges)
	return result
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

func nearestActiveFolder(folderID canonical.Identifier, folders map[canonical.Identifier]*libraryFolderState, conflicted map[canonical.Identifier]struct{}) *canonical.Identifier {
	current := folderID
	visited := make(map[canonical.Identifier]struct{})
	for {
		folder, ok := folders[current]
		if !ok || folder.parent == nil {
			return nil
		}
		if _, blocked := conflicted[current]; blocked {
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
		if _, blocked := conflicted[parentID]; blocked {
			return nil
		}
		if parent.lifecycle == "Active" {
			return &parentID
		}
		current = parentID
	}
}

func effectiveCollectionFolder(folderID canonical.Identifier, folders map[canonical.Identifier]*libraryFolderState, conflicted map[canonical.Identifier]struct{}) *canonical.Identifier {
	folder, ok := folders[folderID]
	if !ok {
		return nil
	}
	if _, blocked := conflicted[folderID]; !blocked && folder.lifecycle == "Active" {
		return &folderID
	}
	return nearestActiveFolder(folderID, folders, conflicted)
}

func detectFolderConflicts(folders map[canonical.Identifier]*libraryFolderState) (map[canonical.Identifier]struct{}, []LibraryConflict) {
	conflicted := make(map[canonical.Identifier]struct{})
	conflicts := make([]LibraryConflict, 0)
	for start := range folders {
		path := make([]canonical.Identifier, 0)
		positions := make(map[canonical.Identifier]int)
		current := start
		for {
			if _, already := positions[current]; already {
				begin := positions[current]
				cycle := path[begin:]
				causes := make([]canonical.Identifier, 0, len(cycle))
				for _, folderID := range cycle {
					conflicted[folderID] = struct{}{}
					if folder := folders[folderID]; folder != nil {
						causes = append(causes, folder.parentCause)
					}
				}
				conflicts = append(conflicts, libraryConflict("Folder", "Cycle", cycle, causes))
				break
			}
			positions[current] = len(path)
			path = append(path, current)
			folder := folders[current]
			if folder == nil || folder.parent == nil {
				break
			}
			if _, exists := folders[*folder.parent]; !exists {
				break
			}
			current = *folder.parent
		}
	}
	unique := make(map[string]LibraryConflict, len(conflicts))
	for _, conflict := range conflicts {
		key := conflict.Kind + ":" + conflict.Reason + ":" + firstString(conflict.SubjectIDs)
		unique[key] = conflict
	}
	conflicts = conflicts[:0]
	for _, conflict := range unique {
		conflicts = append(conflicts, conflict)
	}
	sort.Slice(conflicts, func(left, right int) bool {
		return firstString(conflicts[left].SubjectIDs) < firstString(conflicts[right].SubjectIDs)
	})
	return conflicted, conflicts
}

func parseLibraryRedirectEdges(value canonical.Value, causeID canonical.Identifier, kind string) ([]collectionRedirectEdge, error) {
	entries, ok := replicaMapArrayValue(value)
	if !ok {
		return nil, fmt.Errorf("%s redirects are invalid", kind)
	}
	edges := make([]collectionRedirectEdge, 0, len(entries))
	seenSources := make(map[canonical.Identifier]struct{}, len(entries))
	for index, entry := range entries {
		if !replicaMapHasKeys(entry, 2) {
			return nil, fmt.Errorf("%s redirect %d is invalid", kind, index)
		}
		source, sourceOK := replicaIdentifier(entry, 0)
		destination, destinationOK := replicaIdentifier(entry, 1)
		if !sourceOK || !destinationOK {
			return nil, fmt.Errorf("%s redirect %d IDs are invalid", kind, index)
		}
		if source == destination {
			return nil, fmt.Errorf("%s redirect %d is self-referential", kind, index)
		}
		if _, exists := seenSources[source]; exists {
			return nil, fmt.Errorf("%s redirects repeat a source", kind)
		}
		seenSources[source] = struct{}{}
		edges = append(edges, collectionRedirectEdge{sourceID: source, destinationID: destination, causeID: causeID})
	}
	sort.Slice(edges, func(left, right int) bool {
		if edges[left].sourceID != edges[right].sourceID {
			return bytes.Compare(edges[left].sourceID[:], edges[right].sourceID[:]) < 0
		}
		return bytes.Compare(edges[left].destinationID[:], edges[right].destinationID[:]) < 0
	})
	return edges, nil
}

func reduceCollectionRedirects(edges []collectionRedirectEdge, redirectIDs map[canonical.Identifier]struct{}) (map[canonical.Identifier]canonical.Identifier, []LibraryConflict) {
	return reduceRedirects("CollectionMerge", edges, redirectIDs)
}

func reduceTagRedirects(edges []collectionRedirectEdge, redirectIDs map[canonical.Identifier]struct{}) (map[canonical.Identifier]canonical.Identifier, []LibraryConflict) {
	return reduceRedirects("TagMerge", edges, redirectIDs)
}

func reduceRedirects(kind string, edges []collectionRedirectEdge, redirectIDs map[canonical.Identifier]struct{}) (map[canonical.Identifier]canonical.Identifier, []LibraryConflict) {
	bySource := make(map[canonical.Identifier][]collectionRedirectEdge)
	for _, edge := range edges {
		bySource[edge.sourceID] = append(bySource[edge.sourceID], edge)
	}
	conflicted := make(map[canonical.Identifier]struct{})
	conflicts := make([]LibraryConflict, 0)
	for source, candidates := range bySource {
		destinations := make(map[canonical.Identifier]struct{})
		causes := make([]canonical.Identifier, 0, len(candidates))
		for _, candidate := range candidates {
			destinations[candidate.destinationID] = struct{}{}
			causes = append(causes, candidate.causeID)
		}
		if len(destinations) <= 1 {
			continue
		}
		conflicted[source] = struct{}{}
		conflicts = append(conflicts, libraryConflict(kind, "MultipleDestinations", []canonical.Identifier{source}, causes))
	}
	for source := range redirectIDs {
		path := make([]canonical.Identifier, 0)
		positions := make(map[canonical.Identifier]int)
		current := source
		for {
			if _, already := conflicted[current]; already {
				break
			}
			if start, seen := positions[current]; seen {
				cycle := path[start:]
				causes := make([]canonical.Identifier, 0, len(cycle))
				for _, cycleSource := range cycle {
					for _, edge := range bySource[cycleSource] {
						causes = append(causes, edge.causeID)
					}
				}
				for _, cycleSource := range cycle {
					conflicted[cycleSource] = struct{}{}
				}
				conflicts = append(conflicts, libraryConflict(kind, "Cycle", cycle, causes))
				break
			}
			positions[current] = len(path)
			path = append(path, current)
			candidates := bySource[current]
			if len(candidates) == 0 || len(uniqueRedirectDestinations(candidates)) != 1 {
				break
			}
			current = candidates[0].destinationID
		}
	}
	redirected := make(map[canonical.Identifier]canonical.Identifier)
	for source := range redirectIDs {
		if _, blocked := conflicted[source]; blocked {
			continue
		}
		current := source
		visited := make(map[canonical.Identifier]struct{})
		for {
			if _, blocked := conflicted[current]; blocked {
				current = source
				break
			}
			candidates := bySource[current]
			if len(candidates) == 0 || len(uniqueRedirectDestinations(candidates)) != 1 {
				break
			}
			if _, seen := visited[current]; seen {
				current = source
				break
			}
			visited[current] = struct{}{}
			current = candidates[0].destinationID
		}
		if current != source {
			redirected[source] = current
		}
	}
	sort.Slice(conflicts, func(left, right int) bool {
		if conflicts[left].Kind != conflicts[right].Kind {
			return conflicts[left].Kind < conflicts[right].Kind
		}
		if conflicts[left].Reason != conflicts[right].Reason {
			return conflicts[left].Reason < conflicts[right].Reason
		}
		return firstString(conflicts[left].SubjectIDs) < firstString(conflicts[right].SubjectIDs)
	})
	return redirected, conflicts
}

func uniqueRedirectDestinations(candidates []collectionRedirectEdge) []canonical.Identifier {
	values := make(map[canonical.Identifier]struct{}, len(candidates))
	for _, candidate := range candidates {
		values[candidate.destinationID] = struct{}{}
	}
	result := make([]canonical.Identifier, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	return result
}

func libraryConflict(kind, reason string, subjects, causes []canonical.Identifier) LibraryConflict {
	subjectIDs := make([]string, 0, len(subjects))
	for _, subject := range subjects {
		subjectIDs = append(subjectIDs, hexIdentifier(subject))
	}
	sort.Strings(subjectIDs)
	candidateRecordIDs := make([]string, 0, len(causes))
	seen := make(map[string]struct{}, len(causes))
	for _, cause := range causes {
		value := hexIdentifier(cause)
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		candidateRecordIDs = append(candidateRecordIDs, value)
	}
	sort.Strings(candidateRecordIDs)
	return LibraryConflict{Kind: kind, Reason: reason, SubjectIDs: subjectIDs, CandidateRecordIDs: candidateRecordIDs}
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func pointerString(value string) *string { return &value }

func cloneIdentifierPointer(value *canonical.Identifier) *canonical.Identifier {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
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
	var attribution canonical.Value
	if event.SignerCredentialID != (canonical.Identifier{}) {
		attribution, err = captureEventAttribution(replica, event)
		if err != nil {
			return nil, err
		}
	}
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
	return &libraryCapture{
		item: item, registrationID: event.RecordID, lifecycleID: event.RecordID, collectionID: event.RecordID,
		assignedCollectionID: collectionID, descriptorID: descriptorID, assignmentCauses: []canonical.Identifier{event.RecordID}, lifecycleCauses: []canonical.Identifier{event.RecordID},
		registrationAttribution: attribution,
	}, nil
}

func captureEventAttribution(replica *Replica, event canonical.Event) (canonical.Value, error) {
	if replica == nil {
		return nil, errors.New("Replica is required")
	}
	genesisRecord, ok := replica.records[replica.genesisID]
	if !ok || genesisRecord.Event == nil {
		return nil, errors.New("Capture attribution requires authenticated Genesis")
	}
	replayed, err := replayReplicaAuthorityState(replica, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("replay Capture attribution: %w", err)
	}
	memberID, ok := replayed.clientMembers[event.SignerCredentialID]
	if !ok {
		return nil, errors.New("Capture attribution Credential is unknown")
	}
	return canonical.Map{0: event.VaultID[:], 1: memberID[:], 2: event.SignerCredentialID[:], 3: event.AssertedAt}, nil
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
