package vault

import (
	"bytes"
	"context"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

func (r *Runtime) createFolder(ctx context.Context, id, name string, parentText *string) (any, error) {
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if parentText != nil {
		parentID, err := decodeHexIdentifier(*parentText)
		if err != nil {
			return nil, commandError("FOLDER_NOT_FOUND", "The parent Folder identity is invalid.")
		}
		if !libraryFolderActiveExists(projection, parentID) {
			return nil, commandError("FOLDER_NOT_FOUND", "The parent Folder is not in the Vault.")
		}
		if folderConflictContains(projection, parentID) {
			return nil, commandError("FOLDER_CONFLICT", "The Folder hierarchy is in Conflict and requires explicit Resolution.")
		}
	}
	folderText, err := randomID()
	if err != nil {
		return nil, commandError("FOLDER_ID_CONFLICT", "A Folder identity could not be generated.")
	}
	folderID, err := decodeHexIdentifier(folderText)
	if err != nil {
		return nil, commandError("FOLDER_ID_CONFLICT", "A Folder identity could not be generated.")
	}
	if libraryFolderExists(projection, folderID) {
		return nil, commandError("FOLDER_ID_CONFLICT", "The generated Folder identity already exists.")
	}
	var parentValue canonical.Value
	if parentText != nil {
		parentID, _ := decodeHexIdentifier(*parentText)
		parentValue = parentID[:]
	}
	result, err := r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType: 12,
		body:      canonical.Map{0: folderID[:], 1: name, 2: parentValue},
	})
	if err != nil {
		return nil, err
	}
	result["folderId"] = folderText
	return result, nil
}

func (r *Runtime) setCollectionTitle(ctx context.Context, id, collectionText string, title *string) (any, error) {
	projection, projectionErr := r.readLibraryProjection(id)
	if projectionErr != nil {
		return nil, projectionErr
	}
	collectionID, err := decodeHexIdentifier(collectionText)
	if err != nil || !libraryCollectionExists(projection, collectionID) {
		return nil, commandError("COLLECTION_NOT_FOUND", "The Collection is not in the Vault.")
	}
	var titleValue canonical.Value
	if title != nil {
		titleValue = *title
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType: 7, body: canonical.Map{0: collectionID[:], 1: titleValue},
	})
}

func (r *Runtime) mergeCollections(ctx context.Context, id string, sourceTexts []string, destinationText string) (any, error) {
	if len(sourceTexts) == 0 || len(uniqueStrings(sourceTexts)) != len(sourceTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Collection merge identities are invalid.")
	}
	destinationID, err := decodeHexIdentifier(destinationText)
	if err != nil {
		return nil, commandError("COLLECTION_NOT_FOUND", "The destination Collection is not in the Vault.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !libraryCollectionExists(projection, destinationID) {
		return nil, commandError("COLLECTION_NOT_FOUND", "The destination Collection is not in the Vault.")
	}
	redirects := make(map[string]string)
	for _, collection := range projection.Collections {
		if collection.RedirectedTo != nil {
			redirects[collection.CollectionID] = *collection.RedirectedTo
		}
	}
	for _, sourceText := range sourceTexts {
		sourceID, decodeErr := decodeHexIdentifier(sourceText)
		if decodeErr != nil || sourceID == destinationID || !libraryCollectionExists(projection, sourceID) {
			return nil, commandError("COLLECTION_NOT_FOUND", "A merged Collection is not in the Vault.")
		}
		redirects[sourceText] = destinationText
	}
	if err := assertStringRedirectsAcyclic(redirects); err != nil {
		return nil, commandError("COLLECTION_MERGE_CONFLICT", "The Collection merge would create a cycle.")
	}
	sources := make([]canonical.Value, 0, len(sourceTexts))
	for _, sourceText := range sourceTexts {
		sourceID, _ := decodeHexIdentifier(sourceText)
		sources = append(sources, sourceID[:])
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType: 8, body: canonical.Map{0: canonicalSetValues(sources), 1: destinationID[:]},
	})
}

func (r *Runtime) resolveCollectionMergeConflict(ctx context.Context, id string, subjectTexts, causeTexts []string, redirects []contentRedirectInput) (any, error) {
	if len(subjectTexts) == 0 || len(uniqueStrings(subjectTexts)) != len(subjectTexts) || len(causeTexts) == 0 || len(uniqueStrings(causeTexts)) != len(causeTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Collection conflict identities must be unique and nonempty.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !matchingLibraryConflict(projection, "CollectionMerge", subjectTexts, causeTexts) {
		return nil, commandError("COLLECTION_MERGE_CONFLICT_CHANGED", "The Collection merge Conflict is no longer the exact current Conflict.")
	}
	affected := make(map[string]struct{}, len(subjectTexts))
	for _, subject := range subjectTexts {
		if _, err := decodeHexIdentifier(subject); err != nil {
			return nil, commandError("CONTENT_COMMAND_INVALID", "A Collection conflict subject identity is invalid.")
		}
		affected[subject] = struct{}{}
	}
	known := make(map[string]struct{}, len(projection.Collections))
	effective := make(map[string]string)
	for _, collection := range projection.Collections {
		known[collection.CollectionID] = struct{}{}
		if collection.RedirectedTo != nil {
			effective[collection.CollectionID] = *collection.RedirectedTo
		}
	}
	replacementSources := make(map[string]struct{}, len(redirects))
	redirectValues := make([]canonical.Value, 0, len(redirects))
	for _, redirect := range redirects {
		if _, exists := replacementSources[redirect.source]; exists {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Collection conflict redirects must name each affected source at most once.")
		}
		if _, exists := affected[redirect.source]; !exists || redirect.source == redirect.destination {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Collection conflict redirects must name affected non-self sources.")
		}
		if _, exists := known[redirect.destination]; !exists {
			return nil, commandError("COLLECTION_NOT_FOUND", "A Collection conflict destination is not in the Vault.")
		}
		sourceID, sourceErr := decodeHexIdentifier(redirect.source)
		destinationID, destinationErr := decodeHexIdentifier(redirect.destination)
		if sourceErr != nil || destinationErr != nil {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Collection conflict redirect identity is invalid.")
		}
		replacementSources[redirect.source] = struct{}{}
		effective[redirect.source] = redirect.destination
		redirectValues = append(redirectValues, canonical.Map{0: sourceID[:], 1: destinationID[:]})
	}
	if err := assertStringRedirectsAcyclic(effective); err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Collection conflict redirects must be acyclic.")
	}
	causes, err := decodeIdentifierTexts(causeTexts, "CONTENT_COMMAND_INVALID")
	if err != nil {
		return nil, err
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType: 10,
		body:      canonical.Map{0: canonicalSetValues(identifierValues(causes)), 1: canonicalSetValues(redirectValues)},
	})
}

func (r *Runtime) resolveFolderConflict(ctx context.Context, id string, subjectTexts, causeTexts []string, placements []contentFolderPlacementInput) (any, error) {
	if len(subjectTexts) == 0 || len(uniqueStrings(subjectTexts)) != len(subjectTexts) || len(causeTexts) == 0 || len(uniqueStrings(causeTexts)) != len(causeTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Folder conflict identities must be unique and nonempty.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !matchingLibraryConflict(projection, "Folder", subjectTexts, causeTexts) {
		return nil, commandError("FOLDER_CONFLICT_CHANGED", "The Folder Conflict is no longer the exact current Conflict.")
	}
	affected := make(map[string]struct{}, len(subjectTexts))
	for _, subject := range subjectTexts {
		if _, err := decodeHexIdentifier(subject); err != nil {
			return nil, commandError("CONTENT_COMMAND_INVALID", "A Folder conflict subject identity is invalid.")
		}
		affected[subject] = struct{}{}
	}
	if len(placements) != len(affected) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Folder Resolution must replace every affected Folder exactly once.")
	}
	known := make(map[string]struct{}, len(projection.Folders))
	parents := make(map[string]string)
	for _, folder := range projection.Folders {
		known[folder.FolderID] = struct{}{}
		if folder.ParentFolderID != nil {
			parents[folder.FolderID] = *folder.ParentFolderID
		}
	}
	placementValues := make([]canonical.Value, 0, len(placements))
	seen := make(map[string]struct{}, len(placements))
	for _, placement := range placements {
		if _, duplicate := seen[placement.folder]; duplicate {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Folder Resolution must replace every affected Folder exactly once.")
		}
		if _, exists := affected[placement.folder]; !exists {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Folder Resolution names an unaffected Folder.")
		}
		seen[placement.folder] = struct{}{}
		folderID, folderErr := decodeHexIdentifier(placement.folder)
		if folderErr != nil {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Folder placement identity is invalid.")
		}
		delete(parents, placement.folder)
		var parentValue canonical.Value
		if placement.parent != nil {
			parentID, parentErr := decodeHexIdentifier(*placement.parent)
			if parentErr != nil || parentID == folderID {
				return nil, commandError("CONTENT_COMMAND_INVALID", "Folder Resolution names an invalid parent Folder.")
			}
			if _, exists := known[*placement.parent]; !exists {
				return nil, commandError("FOLDER_NOT_FOUND", "A Folder conflict parent is not in the Vault.")
			}
			parents[placement.folder] = *placement.parent
			parentValue = parentID[:]
		}
		placementValues = append(placementValues, canonical.Map{0: folderID[:], 1: parentValue})
	}
	if len(seen) != len(affected) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Folder Resolution must replace every affected Folder exactly once.")
	}
	if err := assertStringParentAcyclic(parents); err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Folder Resolution placements must be acyclic.")
	}
	causes, err := decodeIdentifierTexts(causeTexts, "CONTENT_COMMAND_INVALID")
	if err != nil {
		return nil, err
	}
	sort.Slice(placementValues, func(left, right int) bool {
		leftID, _ := replicaIdentifier(placementValues[left], 0)
		rightID, _ := replicaIdentifier(placementValues[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 17, body: canonical.Map{0: canonicalSetValues(identifierValues(causes)), 1: placementValues}})
}

func (r *Runtime) mergeTags(ctx context.Context, id string, sourceTexts []string, destinationText string) (any, error) {
	if len(sourceTexts) == 0 || len(uniqueStrings(sourceTexts)) != len(sourceTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Tag merge identities are invalid.")
	}
	destinationID, err := decodeHexIdentifier(destinationText)
	if err != nil {
		return nil, commandError("TAG_NOT_FOUND", "The destination Tag is not in the Vault.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !libraryTagExists(projection, destinationID) {
		return nil, commandError("TAG_NOT_FOUND", "The destination Tag is not in the Vault.")
	}
	redirects := make(map[string]string)
	for _, tag := range projection.Tags {
		if tag.RedirectedTo != nil {
			redirects[tag.TagID] = *tag.RedirectedTo
		}
	}
	values := make([]canonical.Value, 0, len(sourceTexts))
	for _, sourceText := range sourceTexts {
		sourceID, decodeErr := decodeHexIdentifier(sourceText)
		if decodeErr != nil || sourceID == destinationID || !libraryTagExists(projection, sourceID) {
			return nil, commandError("TAG_NOT_FOUND", "A merged Tag is not in the Vault.")
		}
		redirects[sourceText] = destinationText
		values = append(values, sourceID[:])
	}
	if err := assertStringRedirectsAcyclic(redirects); err != nil {
		return nil, commandError("TAG_MERGE_CONFLICT", "The Tag merge would create a cycle.")
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType:            24,
		requireAdministrator: true,
		body:                 canonical.Map{0: canonicalSetValues(values), 1: destinationID[:]},
	})
}

func (r *Runtime) revertTagMerge(ctx context.Context, id, causeText string) (any, error) {
	causeID, err := decodeHexIdentifier(causeText)
	if err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Tag redirect Cause identity is invalid.")
	}
	_, err = r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !libraryRecordIsEvent(r, id, causeID, 24, 26) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Tag redirect Cause is not reversible.")
	}
	for _, event := range r.replicas[id].Events() {
		if event.Family == canonical.ContentFamily && event.Type == 25 {
			if target, ok := replicaIdentifier(event.Body, 0); ok && target == causeID {
				return nil, commandError("CONTENT_COMMAND_INVALID", "The Tag redirect is already reverted.")
			}
		}
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType:            25,
		requireAdministrator: true,
		body:                 canonical.Map{0: causeID[:]},
	})
}

func (r *Runtime) resolveTagMergeConflict(ctx context.Context, id string, subjectTexts, causeTexts []string, redirects []contentRedirectInput) (any, error) {
	if len(subjectTexts) == 0 || len(uniqueStrings(subjectTexts)) != len(subjectTexts) || len(causeTexts) == 0 || len(uniqueStrings(causeTexts)) != len(causeTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Tag conflict identities must be unique and nonempty.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !matchingLibraryConflict(projection, "TagMerge", subjectTexts, causeTexts) {
		return nil, commandError("TAG_MERGE_CONFLICT_CHANGED", "The Tag merge Conflict is no longer the exact current Conflict.")
	}
	affected := make(map[string]struct{}, len(subjectTexts))
	known := make(map[string]struct{}, len(projection.Tags))
	effective := make(map[string]string)
	for _, tag := range projection.Tags {
		known[tag.TagID] = struct{}{}
		if tag.RedirectedTo != nil {
			effective[tag.TagID] = *tag.RedirectedTo
		}
	}
	for _, subject := range subjectTexts {
		affected[subject] = struct{}{}
	}
	seen := make(map[string]struct{}, len(redirects))
	values := make([]canonical.Value, 0, len(redirects))
	for _, redirect := range redirects {
		if _, exists := seen[redirect.source]; exists {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Tag conflict redirects must name each affected source once.")
		}
		if _, exists := affected[redirect.source]; !exists || redirect.source == redirect.destination {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Tag conflict redirects must name affected non-self sources.")
		}
		if _, exists := known[redirect.destination]; !exists {
			return nil, commandError("TAG_NOT_FOUND", "A Tag conflict destination is not in the Vault.")
		}
		sourceID, sourceErr := decodeHexIdentifier(redirect.source)
		destinationID, destinationErr := decodeHexIdentifier(redirect.destination)
		if sourceErr != nil || destinationErr != nil {
			return nil, commandError("CONTENT_COMMAND_INVALID", "Tag conflict redirect identity is invalid.")
		}
		seen[redirect.source] = struct{}{}
		effective[redirect.source] = redirect.destination
		values = append(values, canonical.Map{0: sourceID[:], 1: destinationID[:]})
	}
	if err := assertStringRedirectsAcyclic(effective); err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Tag conflict redirects must be acyclic.")
	}
	causes, err := decodeIdentifierTexts(causeTexts, "CONTENT_COMMAND_INVALID")
	if err != nil {
		return nil, err
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 26, requireAdministrator: true, body: canonical.Map{0: canonicalSetValues(identifierValues(causes)), 1: canonicalSetValues(values)}})
}

type contentRedirectInput struct {
	source      string
	destination string
}

type contentFolderPlacementInput struct {
	folder string
	parent *string
}

func matchingLibraryConflict(projection LibraryProjection, kind string, subjects, causes []string) bool {
	for _, conflict := range projection.Conflicts {
		if conflict.Kind == kind && sameStringSet(conflict.SubjectIDs, subjects) && sameStringSet(conflict.CandidateRecordIDs, causes) {
			return true
		}
	}
	return false
}

func libraryRecordIsEvent(r *Runtime, id string, recordID canonical.Identifier, types ...uint64) bool {
	if r.replicas[id] == nil {
		return false
	}
	record, ok := r.replicas[id].Record(recordID)
	if !ok || record.Event == nil || record.Event.Family != canonical.ContentFamily {
		return false
	}
	for _, eventType := range types {
		if record.Event.Type == eventType {
			return true
		}
	}
	return false
}

func (r *Runtime) placeCollectionInFolder(ctx context.Context, id, collectionText string, folderText *string) (any, error) {
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	collectionID, err := decodeHexIdentifier(collectionText)
	if err != nil || !libraryCollectionExists(projection, collectionID) {
		return nil, commandError("COLLECTION_NOT_FOUND", "The Collection is not in the Vault.")
	}
	var folderValue canonical.Value
	if folderText != nil {
		folderID, decodeErr := decodeHexIdentifier(*folderText)
		if decodeErr != nil || !libraryFolderActiveExists(projection, folderID) {
			return nil, commandError("FOLDER_NOT_FOUND", "The Folder is not in the Vault.")
		}
		if folderConflictContains(projection, folderID) {
			return nil, commandError("FOLDER_CONFLICT", "The Folder hierarchy is in Conflict and requires explicit Resolution.")
		}
		folderValue = folderID[:]
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 11, body: canonical.Map{0: collectionID[:], 1: folderValue}})
}

func (r *Runtime) renameFolder(ctx context.Context, id, folderText, name string) (any, error) {
	folderID, projection, err := r.requireFolderProjection(id, folderText)
	if err != nil {
		return nil, err
	}
	if folderConflictContains(projection, folderID) {
		return nil, commandError("FOLDER_CONFLICT", "The Folder hierarchy is in Conflict and requires explicit Resolution.")
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 13, body: canonical.Map{0: folderID[:], 1: name}})
}

func (r *Runtime) placeFolder(ctx context.Context, id, folderText string, parentText *string) (any, error) {
	folderID, projection, err := r.requireFolderProjection(id, folderText)
	if err != nil {
		return nil, err
	}
	if folderConflictContains(projection, folderID) {
		return nil, commandError("FOLDER_CONFLICT", "The Folder hierarchy is in Conflict and requires explicit Resolution.")
	}
	var parentValue canonical.Value
	parents := make(map[string]string)
	for _, folder := range projection.Folders {
		if folder.ParentFolderID != nil {
			parents[folder.FolderID] = *folder.ParentFolderID
		}
	}
	delete(parents, folderText)
	if parentText != nil {
		parentID, decodeErr := decodeHexIdentifier(*parentText)
		if decodeErr != nil || !libraryFolderActiveExists(projection, parentID) || parentID == folderID {
			return nil, commandError("FOLDER_NOT_FOUND", "The parent Folder is not in the Vault.")
		}
		if folderConflictContains(projection, parentID) {
			return nil, commandError("FOLDER_CONFLICT", "The Folder hierarchy is in Conflict and requires explicit Resolution.")
		}
		parents[folderText] = *parentText
		parentValue = parentID[:]
	}
	if err := assertStringParentAcyclic(parents); err != nil {
		return nil, commandError("FOLDER_CONFLICT", "The Folder placement would create a cycle.")
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 14, body: canonical.Map{0: folderID[:], 1: parentValue}})
}

func (r *Runtime) lifecycleFolder(ctx context.Context, id, folderText string, eventType uint64) (any, error) {
	folderID, projection, err := r.requireFolderProjection(id, folderText)
	if err != nil {
		return nil, err
	}
	if folderConflictContains(projection, folderID) {
		return nil, commandError("FOLDER_CONFLICT", "The Folder hierarchy is in Conflict and requires explicit Resolution.")
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: eventType, body: canonical.Map{0: folderID[:]}})
}

func (r *Runtime) moveCaptures(ctx context.Context, id string, bundleTexts []string, destinationText string) (any, error) {
	if len(bundleTexts) == 0 || len(uniqueStrings(bundleTexts)) != len(bundleTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Capture moves require unique Capture IDs.")
	}
	destinationID, err := decodeHexIdentifier(destinationText)
	if err != nil {
		return nil, commandError("COLLECTION_NOT_FOUND", "The destination Collection is not in the Vault.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	if !libraryCollectionExists(projection, destinationID) {
		return nil, commandError("COLLECTION_NOT_FOUND", "The destination Collection is not in the Vault.")
	}
	captures := make(map[string]LibraryItem, len(projection.Captures))
	for _, capture := range projection.Captures {
		captures[capture.BundleID] = capture
	}
	moves := make([]canonical.Value, 0, len(bundleTexts))
	for _, bundleText := range bundleTexts {
		capture, exists := captures[bundleText]
		if !exists {
			return nil, commandError("CAPTURE_NOT_FOUND", "A selected Capture is not in the Vault.")
		}
		fromID, decodeErr := decodeHexIdentifier(capture.CollectionID)
		if decodeErr != nil {
			return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Capture Collection identity is invalid.")
		}
		bundleID, decodeErr := decodeHexIdentifier(bundleText)
		if decodeErr != nil {
			return nil, commandError("CAPTURE_NOT_FOUND", "A selected Capture identity is invalid.")
		}
		moves = append(moves, canonical.Map{0: bundleID[:], 1: fromID[:], 2: destinationID[:]})
	}
	sort.Slice(moves, func(left, right int) bool {
		leftID, _ := replicaIdentifier(moves[left], 0)
		rightID, _ := replicaIdentifier(moves[right], 0)
		return bytes.Compare(leftID[:], rightID[:]) < 0
	})
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 6, body: canonical.Map{0: moves, 1: nil}})
}

func (r *Runtime) lifecycleCaptures(ctx context.Context, id string, bundleTexts []string, eventType uint64) (any, error) {
	if len(bundleTexts) == 0 || len(uniqueStrings(bundleTexts)) != len(bundleTexts) {
		return nil, commandError("CONTENT_COMMAND_INVALID", "Capture lifecycle changes require unique Capture IDs.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	known := make(map[string]struct{}, len(projection.Captures))
	for _, capture := range projection.Captures {
		known[capture.BundleID] = struct{}{}
	}
	values := make([]canonical.Value, 0, len(bundleTexts))
	for _, text := range bundleTexts {
		if _, exists := known[text]; !exists {
			return nil, commandError("CAPTURE_NOT_FOUND", "A selected Capture is not in the Vault.")
		}
		bundleID, decodeErr := decodeHexIdentifier(text)
		if decodeErr != nil {
			return nil, commandError("CAPTURE_NOT_FOUND", "A selected Capture identity is invalid.")
		}
		values = append(values, bundleID[:])
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: eventType, body: canonical.Map{0: canonicalSetValues(values)}})
}

func (r *Runtime) createTag(ctx context.Context, id, name string) (any, error) {
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	tagText, err := randomID()
	if err != nil {
		return nil, commandError("TAG_ID_CONFLICT", "A Tag identity could not be generated.")
	}
	tagID, err := decodeHexIdentifier(tagText)
	if err != nil {
		return nil, commandError("TAG_ID_CONFLICT", "A Tag identity could not be generated.")
	}
	if libraryTagExists(projection, tagID) {
		return nil, commandError("TAG_ID_CONFLICT", "The generated Tag identity already exists.")
	}
	result, err := r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 18, body: canonical.Map{0: tagID[:], 1: name}})
	if err != nil {
		return nil, err
	}
	result["tagId"] = tagText
	return result, nil
}

func (r *Runtime) tagEvent(ctx context.Context, id, tagText string, eventType uint64, bodyExtra canonical.Value) (any, error) {
	tagID, projection, err := r.requireTagProjection(id, tagText)
	if err != nil {
		return nil, err
	}
	if eventType != 18 && eventType != 19 && eventType != 22 && eventType != 23 && tagConflictContains(projection, tagID) {
		return nil, commandError("TAG_CONFLICT", "The Tag is in Conflict and requires explicit Resolution.")
	}
	body := canonical.Map{0: tagID[:]}
	if bodyExtra != nil {
		body[1] = bodyExtra
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: eventType, body: body})
}

func (r *Runtime) renameTag(ctx context.Context, id, tagText, name string) (any, error) {
	return r.tagEvent(ctx, id, tagText, 19, name)
}

func (r *Runtime) assignTag(ctx context.Context, id, tagText, targetKind, targetText string) (any, error) {
	tagID, projection, err := r.requireTagProjection(id, tagText)
	if err != nil {
		return nil, err
	}
	if tagConflictContains(projection, tagID) {
		return nil, commandError("TAG_CONFLICT", "The Tag is in Conflict and requires explicit Resolution.")
	}
	targetID, err := decodeHexIdentifier(targetText)
	if err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Tag target identity is invalid.")
	}
	var kind uint64
	switch targetKind {
	case "Collection":
		kind = 1
		if !libraryCollectionExists(projection, targetID) {
			return nil, commandError("COLLECTION_NOT_FOUND", "The Tag target Collection is not in the Vault.")
		}
	case "Capture":
		kind = 2
		if !libraryCaptureExists(projection, targetText) {
			return nil, commandError("CAPTURE_NOT_FOUND", "The Tag target Capture is not in the Vault.")
		}
	default:
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Tag target kind is invalid.")
	}
	assignmentText, err := randomID()
	if err != nil {
		return nil, commandError("TAG_ASSIGNMENT_ID_CONFLICT", "A Tag Assignment identity could not be generated.")
	}
	assignmentID, _ := decodeHexIdentifier(assignmentText)
	for _, assignment := range projection.TagAssignments {
		if assignment.AssignmentID == assignmentText {
			return nil, commandError("TAG_ASSIGNMENT_ID_CONFLICT", "The generated Tag Assignment identity already exists.")
		}
	}
	result, err := r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 20, body: canonical.Map{0: assignmentID[:], 1: tagID[:], 2: canonical.Map{0: kind, 1: targetID[:]}}})
	if err != nil {
		return nil, err
	}
	result["assignmentId"] = assignmentText
	return result, nil
}

func (r *Runtime) removeTagAssignments(ctx context.Context, id, tagText, targetKind, targetText string) (any, error) {
	_, projection, err := r.requireTagProjection(id, tagText)
	if err != nil {
		return nil, err
	}
	wantKind := uint64(0)
	if targetKind == "Collection" {
		wantKind = 1
	} else if targetKind == "Capture" {
		wantKind = 2
	} else {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Tag target kind is invalid.")
	}
	causes := make([]canonical.Value, 0)
	for _, assignment := range projection.TagAssignments {
		if assignment.TagID == tagText && assignment.TargetKind == wantKind && assignment.TargetID == targetText && assignment.Active {
			causeID, decodeErr := decodeHexIdentifier(assignment.AssignmentID)
			if decodeErr != nil {
				return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Tag Assignment identity is invalid.")
			}
			causes = append(causes, causeID[:])
		}
	}
	if len(causes) == 0 {
		return nil, commandError("TAG_ASSIGNMENT_NOT_FOUND", "The Tag relation has no active assignment.")
	}
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{eventType: 21, body: canonical.Map{0: canonicalSetValues(causes)}})
}

func (r *Runtime) createNote(ctx context.Context, id, targetKind, targetText string, title *string, body string) (any, error) {
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	targetID, err := decodeHexIdentifier(targetText)
	if err != nil {
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Note target identity is invalid.")
	}
	var kind uint64
	switch targetKind {
	case "Collection":
		kind = 1
		if !libraryCollectionExists(projection, targetID) {
			return nil, commandError("COLLECTION_NOT_FOUND", "The Note target Collection is not in the Vault.")
		}
	case "Capture":
		kind = 2
		if !libraryCaptureExists(projection, targetText) {
			return nil, commandError("CAPTURE_NOT_FOUND", "The Note target Capture is not in the Vault.")
		}
	default:
		return nil, commandError("CONTENT_COMMAND_INVALID", "The Note target kind is invalid.")
	}
	noteText, err := randomID()
	if err != nil {
		return nil, commandError("NOTE_ID_CONFLICT", "A Note identity could not be generated.")
	}
	noteID, _ := decodeHexIdentifier(noteText)
	if libraryNoteExists(projection, noteID) {
		return nil, commandError("NOTE_ID_CONFLICT", "The generated Note identity already exists.")
	}
	result, err := r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType: 27,
		bodyFactory: func(objectIDs []canonical.Identifier) canonical.Value {
			return canonical.Map{0: noteID[:], 1: canonical.Map{0: kind, 1: targetID[:]}, 2: objectIDs[0][:]}
		},
		objectDependencies: true,
		objects:            []contentObjectDraft{noteContentDraft(title, body)},
	})
	if err != nil {
		return nil, err
	}
	result["noteId"] = noteText
	return result, nil
}

func (r *Runtime) reviseNote(ctx context.Context, id, noteText string, title *string, body string) (any, error) {
	note, err := r.requireNote(id, noteText)
	if err != nil {
		return nil, err
	}
	if note.State != "Active" {
		return nil, commandError("NOTE_NOT_ACTIVE", "Only an Active Note can be revised.")
	}
	causes, err := noteHeadIdentifiers(note)
	if err != nil {
		return nil, err
	}
	frontier, err := r.currentContentFrontier(id)
	if err != nil {
		return nil, err
	}
	noteID, _ := decodeHexIdentifier(noteText)
	result, err := r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType:              28,
		expectedCausalFrontier: frontier,
		objectDependencies:     true,
		objects:                []contentObjectDraft{noteContentDraft(title, body)},
		bodyFactory: func(objectIDs []canonical.Identifier) canonical.Value {
			return canonical.Map{0: noteID[:], 1: canonicalSetValues(identifierValues(causes)), 2: objectIDs[0][:]}
		},
	})
	return result, err
}

func (r *Runtime) lifecycleNote(ctx context.Context, id, noteText string, eventType uint64) (any, error) {
	note, err := r.requireNote(id, noteText)
	if err != nil {
		return nil, err
	}
	if eventType == 29 && note.State != "Active" {
		return nil, commandError("NOTE_NOT_ACTIVE", "Only an Active Note can be deleted.")
	}
	if eventType == 30 && note.State != "Deleted" {
		return nil, commandError("NOTE_NOT_DELETED", "Only a Deleted Note can be restored.")
	}
	causes, err := noteHeadIdentifiers(note)
	if err != nil {
		return nil, err
	}
	frontier, err := r.currentContentFrontier(id)
	if err != nil {
		return nil, err
	}
	noteID, _ := decodeHexIdentifier(noteText)
	return r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType:              eventType,
		expectedCausalFrontier: frontier,
		body:                   canonical.Map{0: noteID[:], 1: canonicalSetValues(identifierValues(causes))},
	})
}

func (r *Runtime) resolveNoteConflict(ctx context.Context, id, noteText string, causeTexts []string, retainedTitle *string, retainedBody *string, split []noteSplitInput) (any, error) {
	if len(causeTexts) < 2 || len(uniqueStrings(causeTexts)) != len(causeTexts) {
		return nil, commandError("NOTE_CONFLICT_CHANGED", "Note Resolution requires every unique current conflict Cause.")
	}
	note, err := r.requireNote(id, noteText)
	if err != nil {
		return nil, err
	}
	if note.State != "Conflict" {
		return nil, commandError("NOTE_CONFLICT_CHANGED", "The current Note Conflict has changed.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, err
	}
	matching := false
	for _, conflict := range projection.Conflicts {
		if conflict.Kind == "Note" && len(conflict.SubjectIDs) == 1 && conflict.SubjectIDs[0] == noteText && sameStringSet(conflict.CandidateRecordIDs, causeTexts) {
			matching = true
			break
		}
	}
	if !matching {
		return nil, commandError("NOTE_CONFLICT_CHANGED", "The current Note Conflict has changed.")
	}
	noteID, _ := decodeHexIdentifier(noteText)
	objectDrafts := make([]contentObjectDraft, 0, len(split)+1)
	if retainedBody != nil {
		objectDrafts = append(objectDrafts, noteContentDraft(retainedTitle, *retainedBody))
	}
	splitIDs := make([]canonical.Identifier, 0, len(split))
	for _, item := range split {
		text, randomErr := randomID()
		if randomErr != nil {
			return nil, commandError("NOTE_ID_CONFLICT", "A split Note identity could not be generated.")
		}
		splitID, decodeErr := decodeHexIdentifier(text)
		if decodeErr != nil {
			return nil, commandError("NOTE_ID_CONFLICT", "A split Note identity could not be generated.")
		}
		if libraryNoteExists(projection, splitID) {
			return nil, commandError("NOTE_ID_CONFLICT", "The generated split Note identity already exists.")
		}
		splitIDs = append(splitIDs, splitID)
		objectDrafts = append(objectDrafts, noteContentDraft(item.title, item.body))
	}
	causes, err := decodeIdentifierTexts(causeTexts, "NOTE_CONFLICT_CHANGED")
	if err != nil {
		return nil, err
	}
	frontier, err := r.currentContentFrontier(id)
	if err != nil {
		return nil, err
	}
	result, err := r.authorContentEvent(ctx, id, contentAuthoringRequest{
		eventType:              31,
		expectedCausalFrontier: frontier,
		objects:                objectDrafts,
		objectDependencies:     true,
		bodyFactory: func(objectIDs []canonical.Identifier) canonical.Value {
			var retainedValue canonical.Value
			offset := 0
			if retainedBody != nil {
				retainedValue = objectIDs[0][:]
				offset = 1
			}
			splitValues := make([]canonical.Value, 0, len(splitIDs))
			for index, splitID := range splitIDs {
				splitValues = append(splitValues, canonical.Map{0: splitID[:], 1: objectIDs[offset+index][:]})
			}
			return canonical.Map{0: noteID[:], 1: canonicalSetValues(identifierValues(causes)), 2: retainedValue, 3: canonicalSetValues(splitValues)}
		},
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"eventRecordId": result["eventRecordId"], "splitNoteIds": identifierTexts(splitIDs)}, nil
}

type noteSplitInput struct {
	title *string
	body  string
}

func (r *Runtime) requireNote(id, noteText string) (LibraryNote, error) {
	noteID, err := decodeHexIdentifier(noteText)
	if err != nil {
		return LibraryNote{}, commandError("NOTE_NOT_FOUND", "The Note is not in the Vault.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return LibraryNote{}, err
	}
	for _, note := range projection.Notes {
		decoded, decodeErr := decodeHexIdentifier(note.NoteID)
		if decodeErr == nil && decoded == noteID {
			return note, nil
		}
	}
	return LibraryNote{}, commandError("NOTE_NOT_FOUND", "The Note is not in the Vault.")
}

func noteHeadIdentifiers(note LibraryNote) ([]canonical.Identifier, error) {
	result := make([]canonical.Identifier, 0, len(note.Versions))
	for _, version := range note.Versions {
		id, err := decodeHexIdentifier(version.HeadCauseID)
		if err != nil {
			return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Note head identity is invalid.")
		}
		result = append(result, id)
	}
	return result, nil
}

func identifierValues(values []canonical.Identifier) []canonical.Value {
	result := make([]canonical.Value, 0, len(values))
	for _, value := range values {
		result = append(result, value[:])
	}
	return result
}

func decodeIdentifierTexts(values []string, errorID string) ([]canonical.Identifier, error) {
	result := make([]canonical.Identifier, 0, len(values))
	for _, value := range values {
		decoded, err := decodeHexIdentifier(value)
		if err != nil {
			return nil, commandError(errorID, "A conflict Cause identity is invalid.")
		}
		result = append(result, decoded)
	}
	return result, nil
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	for index := range leftCopy {
		if leftCopy[index] != rightCopy[index] {
			return false
		}
	}
	return true
}

func identifierTexts(values []canonical.Identifier) []string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, hexIdentifier(value))
	}
	return parts
}

func (r *Runtime) requireFolderProjection(id, folderText string) (canonical.Identifier, LibraryProjection, error) {
	folderID, err := decodeHexIdentifier(folderText)
	if err != nil {
		return canonical.Identifier{}, LibraryProjection{}, commandError("FOLDER_NOT_FOUND", "The Folder is not in the Vault.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return canonical.Identifier{}, LibraryProjection{}, err
	}
	if !libraryFolderKnown(projection, folderID) {
		return canonical.Identifier{}, LibraryProjection{}, commandError("FOLDER_NOT_FOUND", "The Folder is not in the Vault.")
	}
	return folderID, projection, nil
}

func (r *Runtime) requireTagProjection(id, tagText string) (canonical.Identifier, LibraryProjection, error) {
	tagID, err := decodeHexIdentifier(tagText)
	if err != nil {
		return canonical.Identifier{}, LibraryProjection{}, commandError("TAG_NOT_FOUND", "The Tag is not in the Vault.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return canonical.Identifier{}, LibraryProjection{}, err
	}
	if !libraryTagExists(projection, tagID) {
		return canonical.Identifier{}, LibraryProjection{}, commandError("TAG_NOT_FOUND", "The Tag is not in the Vault.")
	}
	return tagID, projection, nil
}

func libraryCollectionExists(projection LibraryProjection, id canonical.Identifier) bool {
	for _, collection := range projection.Collections {
		if decoded, err := decodeHexIdentifier(collection.CollectionID); err == nil && decoded == id {
			return true
		}
	}
	return false
}

func libraryCaptureExists(projection LibraryProjection, text string) bool {
	for _, capture := range projection.Captures {
		if capture.BundleID == text {
			return true
		}
	}
	return false
}

func libraryTagExists(projection LibraryProjection, id canonical.Identifier) bool {
	for _, tag := range projection.Tags {
		if decoded, err := decodeHexIdentifier(tag.TagID); err == nil && decoded == id {
			return true
		}
	}
	return false
}

func libraryNoteExists(projection LibraryProjection, id canonical.Identifier) bool {
	for _, note := range projection.Notes {
		if decoded, err := decodeHexIdentifier(note.NoteID); err == nil && decoded == id {
			return true
		}
	}
	return false
}

func tagConflictContains(projection LibraryProjection, id canonical.Identifier) bool {
	needle := hexIdentifier(id)
	for _, conflict := range projection.Conflicts {
		if conflict.Kind == "TagMerge" {
			for _, subject := range conflict.SubjectIDs {
				if subject == needle {
					return true
				}
			}
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; !exists {
			seen[value] = struct{}{}
			result = append(result, value)
		}
	}
	return result
}

func assertStringRedirectsAcyclic(redirects map[string]string) error {
	for source := range redirects {
		seen := map[string]struct{}{}
		current := source
		for current != "" {
			if _, exists := seen[current]; exists {
				return fmt.Errorf("redirect cycle")
			}
			seen[current] = struct{}{}
			current = redirects[current]
		}
	}
	return nil
}

func assertStringParentAcyclic(parents map[string]string) error {
	for source := range parents {
		seen := map[string]struct{}{}
		current := source
		for current != "" {
			if _, exists := seen[current]; exists {
				return fmt.Errorf("parent cycle")
			}
			seen[current] = struct{}{}
			current = parents[current]
		}
	}
	return nil
}

func (r *Runtime) readLibraryProjection(id string) (LibraryProjection, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, err := r.vaultLocked(id)
	if err != nil {
		return LibraryProjection{}, err
	}
	if r.replicas[id] == nil || value.Canonical == nil {
		return LibraryProjection{}, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	projection, err := ProjectLibraryProjection(r.replicas[id])
	if err != nil {
		return LibraryProjection{}, commandError("VAULT_REPLAY_UNAVAILABLE", "The Library projection is unavailable.")
	}
	return projection, nil
}

func libraryFolderExists(projection LibraryProjection, id canonical.Identifier) bool {
	for _, folder := range projection.Folders {
		if decoded, err := decodeHexIdentifier(folder.FolderID); err == nil && decoded == id {
			return true
		}
	}
	return false
}

func libraryFolderActiveExists(projection LibraryProjection, id canonical.Identifier) bool {
	for _, folder := range projection.Folders {
		if decoded, err := decodeHexIdentifier(folder.FolderID); err == nil && decoded == id && folder.Lifecycle == "Active" {
			return true
		}
	}
	return false
}

func libraryFolderKnown(projection LibraryProjection, id canonical.Identifier) bool {
	return libraryFolderExists(projection, id)
}

func folderConflictContains(projection LibraryProjection, id canonical.Identifier) bool {
	needle := hexIdentifier(id)
	for _, conflict := range projection.Conflicts {
		if conflict.Kind != "Folder" {
			continue
		}
		for _, subject := range conflict.SubjectIDs {
			if subject == needle {
				return true
			}
		}
	}
	return false
}
