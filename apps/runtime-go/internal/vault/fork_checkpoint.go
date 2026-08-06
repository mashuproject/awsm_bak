package vault

import (
	"errors"
	"fmt"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

type forkContentMappings struct {
	bundles     map[canonical.Identifier]canonical.Identifier
	objects     map[canonical.Identifier]canonical.Identifier
	collections map[canonical.Identifier]canonical.Identifier
	folders     map[canonical.Identifier]canonical.Identifier
	tags        map[canonical.Identifier]canonical.Identifier
	assignments map[canonical.Identifier]canonical.Identifier
	notes       map[canonical.Identifier]canonical.Identifier
	causes      map[canonical.Identifier]canonical.Identifier
	destination map[canonical.Identifier]struct{}
}

func newForkContentMappings() *forkContentMappings {
	return &forkContentMappings{
		bundles: make(map[canonical.Identifier]canonical.Identifier), objects: make(map[canonical.Identifier]canonical.Identifier),
		collections: make(map[canonical.Identifier]canonical.Identifier), folders: make(map[canonical.Identifier]canonical.Identifier),
		tags: make(map[canonical.Identifier]canonical.Identifier), assignments: make(map[canonical.Identifier]canonical.Identifier),
		notes: make(map[canonical.Identifier]canonical.Identifier), causes: make(map[canonical.Identifier]canonical.Identifier),
		destination: make(map[canonical.Identifier]struct{}),
	}
}

func (m *forkContentMappings) fresh(kind string, source canonical.Identifier, values map[canonical.Identifier]canonical.Identifier) (canonical.Identifier, error) {
	if mapped, ok := values[source]; ok {
		return mapped, nil
	}
	for attempt := 0; attempt < 8; attempt++ {
		textID, err := randomID()
		if err != nil {
			return canonical.Identifier{}, err
		}
		mapped, err := decodeHexIdentifier(textID)
		if err != nil {
			return canonical.Identifier{}, err
		}
		if mapped == source {
			continue
		}
		if _, collision := m.destination[mapped]; collision {
			continue
		}
		values[source] = mapped
		m.destination[mapped] = struct{}{}
		return mapped, nil
	}
	return canonical.Identifier{}, fmt.Errorf("Fork %s identity mapping collided", kind)
}

func (m *forkContentMappings) mapID(kind string, source canonical.Identifier) (canonical.Identifier, error) {
	switch kind {
	case "Bundle":
		return m.fresh(kind, source, m.bundles)
	case "VaultObject":
		mapped, ok := m.objects[source]
		if !ok {
			return canonical.Identifier{}, fmt.Errorf("Fork %s mapping is unavailable for %s", kind, hexIdentifier(source))
		}
		return mapped, nil
	case "Collection":
		return m.fresh(kind, source, m.collections)
	case "Folder":
		return m.fresh(kind, source, m.folders)
	case "Tag":
		return m.fresh(kind, source, m.tags)
	case "TagAssignment":
		return m.fresh(kind, source, m.assignments)
	case "Note":
		return m.fresh(kind, source, m.notes)
	case "BaselineCause":
		return m.fresh(kind, source, m.causes)
	default:
		return canonical.Identifier{}, fmt.Errorf("Fork identifier kind %q is unsupported", kind)
	}
}

func prepareForkObjectMappings(source *Replica, sourceState *canonicalReplicaState, destinationVaultID, requiredFeatureSetID canonical.Identifier) (*forkContentMappings, error) {
	if source == nil || sourceState == nil {
		return nil, errors.New("Fork source Object state is unavailable")
	}
	mappings := newForkContentMappings()
	for _, objectIDText := range sortedStringKeys(sourceState.ObjectStorageItemIDs) {
		objectID, err := decodeHexIdentifier(objectIDText)
		if err != nil {
			return nil, errors.New("Fork source Object identity is invalid")
		}
		object, ok := source.Object(objectID)
		if !ok {
			return nil, fmt.Errorf("Fork source Object %s is unavailable", objectIDText)
		}
		var rebuilt []byte
		switch object.ObjectType {
		case 1:
			// Bundle descriptors refer to leaf Objects and their Bundle ID;
			// those mappings are prepared below after the leaf identities.
			continue
		case 2:
			rebuilt, err = rebuildForkArtifactObject(object, destinationVaultID, requiredFeatureSetID)
		case 3:
			rebuilt, err = rebuildForkNoteObject(object, destinationVaultID, requiredFeatureSetID)
		default:
			return nil, fmt.Errorf("Fork Object type %d re-authoring is not implemented by this Runtime", object.ObjectType)
		}
		if err != nil {
			return nil, err
		}
		mapped, err := canonical.VaultObjectID(destinationVaultID, object.ObjectType, rebuilt)
		if err != nil {
			return nil, err
		}
		if mapped == objectID {
			return nil, errors.New("Fork Object identity was not fresh")
		}
		if _, collision := mappings.destination[mapped]; collision {
			return nil, errors.New("Fork Object identity mapping collided")
		}
		mappings.objects[objectID] = mapped
		mappings.destination[mapped] = struct{}{}
	}
	for _, objectIDText := range sortedStringKeys(sourceState.ObjectStorageItemIDs) {
		objectID, err := decodeHexIdentifier(objectIDText)
		if err != nil {
			return nil, errors.New("Fork source Object identity is invalid")
		}
		object, ok := source.Object(objectID)
		if !ok || object.ObjectType != 1 {
			continue
		}
		rebuilt, err := rebuildForkBundleDescriptor(object, destinationVaultID, requiredFeatureSetID, mappings.objects, mappings.bundles)
		if err != nil {
			return nil, err
		}
		mapped, err := canonical.VaultObjectID(destinationVaultID, object.ObjectType, rebuilt)
		if err != nil {
			return nil, err
		}
		if mapped == objectID {
			return nil, errors.New("Fork Bundle Descriptor identity was not fresh")
		}
		if _, collision := mappings.destination[mapped]; collision {
			return nil, errors.New("Fork Bundle Descriptor identity mapping collided")
		}
		mappings.objects[objectID] = mapped
		mappings.destination[mapped] = struct{}{}
	}
	return mappings, nil
}

func mapForkCauseSet(value canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	ids, err := parseCanonicalIdentifierSet(value, "Fork Baseline Cause set", false)
	if err != nil {
		return nil, err
	}
	result := make([]canonical.Value, 0, len(ids))
	for _, id := range ids {
		mapped, mapErr := mappings.mapID("BaselineCause", id)
		if mapErr != nil {
			return nil, mapErr
		}
		result = append(result, mapped[:])
	}
	return canonicalSetValues(result), nil
}

func mapForkNullableID(value canonical.Value, kind string, mappings *forkContentMappings) (canonical.Value, error) {
	if value == nil {
		return nil, nil
	}
	id, ok := replicaIdentifierValue(value)
	if !ok {
		return nil, fmt.Errorf("Fork %s identity is invalid", kind)
	}
	mapped, err := mappings.mapID(kind, id)
	if err != nil {
		return nil, err
	}
	return mapped[:], nil
}

func mapForkRequiredID(value canonical.Value, kind string, mappings *forkContentMappings) (canonical.Value, error) {
	mapped, err := mapForkNullableID(value, kind, mappings)
	if err != nil || mapped == nil {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("Fork %s identity is missing", kind)
	}
	return mapped, nil
}

func mapForkCauseID(value canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	return mapForkRequiredID(value, "BaselineCause", mappings)
}

func mapForkTarget(value canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	target, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(target, 2) {
		return nil, errors.New("Fork target is invalid")
	}
	kind, ok := replicaMapNumber(target, 0)
	if !ok || (kind != 1 && kind != 2) {
		return nil, errors.New("Fork target kind is invalid")
	}
	identifierKind := "Collection"
	if kind == 2 {
		identifierKind = "Bundle"
	}
	identifier, err := mapForkRequiredID(replicaMapEntryMust(target, 1), identifierKind, mappings)
	if err != nil {
		return nil, err
	}
	return canonical.Map{0: kind, 1: identifier}, nil
}

func mapForkTail(value canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	if value == nil {
		return nil, nil
	}
	tail, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(tail, 2) {
		return nil, errors.New("Fork Collection tail is invalid")
	}
	bundle, err := mapForkRequiredID(replicaMapEntryMust(tail, 0), "Bundle", mappings)
	if err != nil {
		return nil, err
	}
	cause, err := mapForkCauseID(replicaMapEntryMust(tail, 1), mappings)
	if err != nil {
		return nil, err
	}
	return canonical.Map{0: bundle, 1: cause}, nil
}

func mapForkRedirect(value canonical.Value, kind string, mappings *forkContentMappings) (canonical.Value, error) {
	if value == nil {
		return nil, nil
	}
	redirect, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(redirect, 2) {
		return nil, errors.New("Fork redirect is invalid")
	}
	source, err := mapForkRequiredID(replicaMapEntryMust(redirect, 0), kind, mappings)
	if err != nil {
		return nil, err
	}
	cause, err := mapForkCauseID(replicaMapEntryMust(redirect, 1), mappings)
	if err != nil {
		return nil, err
	}
	return canonical.Map{0: source, 1: cause}, nil
}

func mapForkPlacements(value canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	entries, ok := replicaMapArray(value, 0)
	if !ok {
		return nil, errors.New("Fork Folder conflict placements are invalid")
	}
	result := make([]canonical.Value, 0, len(entries))
	for _, entry := range entries {
		placement, ok := replicaMapValue(entry)
		if !ok || !replicaMapHasKeys(placement, 2) {
			return nil, errors.New("Fork Folder conflict placement is invalid")
		}
		folder, err := mapForkRequiredID(replicaMapEntryMust(placement, 0), "Folder", mappings)
		if err != nil {
			return nil, err
		}
		parent, err := mapForkNullableID(replicaMapEntryMust(placement, 1), "Folder", mappings)
		if err != nil {
			return nil, err
		}
		result = append(result, canonical.Map{0: folder, 1: parent})
	}
	return canonical.Map{0: result}, nil
}

func mapForkConflictState(kind uint64, value canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	state, ok := replicaMapValue(value)
	if !ok || !replicaMapHasKeys(state, 1) {
		return nil, errors.New("Fork conflict candidate state is invalid")
	}
	switch kind {
	case 1:
		entries, ok := replicaMapArray(state, 0)
		if !ok {
			return nil, errors.New("Fork Collection conflict redirects are invalid")
		}
		mapped := make([]canonical.Value, 0, len(entries))
		for _, entry := range entries {
			redirect, ok := replicaMapValue(entry)
			if !ok || !replicaMapHasKeys(redirect, 2) {
				return nil, errors.New("Fork Collection conflict redirect is invalid")
			}
			source, err := mapForkRequiredID(replicaMapEntryMust(redirect, 0), "Collection", mappings)
			if err != nil {
				return nil, err
			}
			destination, err := mapForkRequiredID(replicaMapEntryMust(redirect, 1), "Collection", mappings)
			if err != nil {
				return nil, err
			}
			mapped = append(mapped, canonical.Map{0: source, 1: destination})
		}
		return canonical.Map{0: mapped}, nil
	case 2:
		return mapForkPlacements(value, mappings)
	case 3:
		entries, ok := replicaMapArray(state, 0)
		if !ok {
			return nil, errors.New("Fork Tag conflict redirects are invalid")
		}
		mapped := make([]canonical.Value, 0, len(entries))
		for _, entry := range entries {
			redirect, ok := replicaMapValue(entry)
			if !ok || !replicaMapHasKeys(redirect, 2) {
				return nil, errors.New("Fork Tag conflict redirect is invalid")
			}
			source, err := mapForkRequiredID(replicaMapEntryMust(redirect, 0), "Tag", mappings)
			if err != nil {
				return nil, err
			}
			destination, err := mapForkRequiredID(replicaMapEntryMust(redirect, 1), "Tag", mappings)
			if err != nil {
				return nil, err
			}
			mapped = append(mapped, canonical.Map{0: source, 1: destination})
		}
		return canonical.Map{0: mapped}, nil
	case 4:
		note, err := mapForkRequiredID(replicaMapEntryMust(state, 0), "Note", mappings)
		if err != nil {
			return nil, err
		}
		content, err := mapForkNullableID(replicaMapEntryMust(state, 1), "VaultObject", mappings)
		if err != nil {
			return nil, err
		}
		return canonical.Map{0: note, 1: content}, nil
	default:
		return nil, errors.New("Fork conflict kind is unsupported")
	}
}

func mapForkContentCheckpoint(source canonical.Value, mappings *forkContentMappings) (canonical.Value, error) {
	content, ok := replicaMapValue(source)
	if !ok || !replicaMapHasKeys(content, 10) {
		return nil, errors.New("Fork source content checkpoint is invalid")
	}
	format, ok := replicaMapNumber(content, 0)
	if !ok || format != 1 {
		return nil, errors.New("Fork source content checkpoint format is invalid")
	}
	label, ok := replicaMapValue(replicaMapEntryMust(content, 1))
	if !ok || !replicaMapHasKeys(label, 2) {
		return nil, errors.New("Fork source Vault label checkpoint is invalid")
	}
	labelCauses, err := mapForkCauseSet(replicaMapEntryMust(label, 1), mappings)
	if err != nil {
		return nil, err
	}
	labelCheckpoint := canonical.Map{0: replicaMapEntryMust(label, 0), 1: labelCauses}

	captures, ok := replicaMapArray(content, 3)
	if !ok {
		return nil, errors.New("Fork source Capture checkpoint is invalid")
	}
	mappedCaptures := make([]canonical.Value, 0, len(captures))
	for _, value := range captures {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 8) {
			return nil, errors.New("Fork source Capture checkpoint entry is invalid")
		}
		bundle, err := mapForkRequiredID(replicaMapEntryMust(entry, 0), "Bundle", mappings)
		if err != nil {
			return nil, err
		}
		descriptor, err := mapForkRequiredID(replicaMapEntryMust(entry, 1), "VaultObject", mappings)
		if err != nil {
			return nil, err
		}
		collection, err := mapForkRequiredID(replicaMapEntryMust(entry, 2), "Collection", mappings)
		if err != nil {
			return nil, err
		}
		assignmentCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 3), mappings)
		if err != nil {
			return nil, err
		}
		lifecycleCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 5), mappings)
		if err != nil {
			return nil, err
		}
		registrationCause, err := mapForkCauseID(replicaMapEntryMust(entry, 6), mappings)
		if err != nil {
			return nil, err
		}
		mappedCaptures = append(mappedCaptures, canonical.Map{0: bundle, 1: descriptor, 2: collection, 3: assignmentCauses, 4: replicaMapEntryMust(entry, 4), 5: lifecycleCauses, 6: registrationCause, 7: replicaMapEntryMust(entry, 7)})
	}

	collections, ok := replicaMapArray(content, 4)
	if !ok {
		return nil, errors.New("Fork source Collection checkpoint is invalid")
	}
	mappedCollections := make([]canonical.Value, 0, len(collections))
	for _, value := range collections {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 8) {
			return nil, errors.New("Fork source Collection checkpoint entry is invalid")
		}
		collection, err := mapForkRequiredID(replicaMapEntryMust(entry, 0), "Collection", mappings)
		if err != nil {
			return nil, err
		}
		titleCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 2), mappings)
		if err != nil {
			return nil, err
		}
		folder, err := mapForkNullableID(replicaMapEntryMust(entry, 3), "Folder", mappings)
		if err != nil {
			return nil, err
		}
		folderCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 4), mappings)
		if err != nil {
			return nil, err
		}
		redirect, err := mapForkRedirect(replicaMapEntryMust(entry, 5), "Collection", mappings)
		if err != nil {
			return nil, err
		}
		intrinsic, err := mapForkTail(replicaMapEntryMust(entry, 6), mappings)
		if err != nil {
			return nil, err
		}
		effective, err := mapForkTail(replicaMapEntryMust(entry, 7), mappings)
		if err != nil {
			return nil, err
		}
		mappedCollections = append(mappedCollections, canonical.Map{0: collection, 1: replicaMapEntryMust(entry, 1), 2: titleCauses, 3: folder, 4: folderCauses, 5: redirect, 6: intrinsic, 7: effective})
	}

	folders, ok := replicaMapArray(content, 5)
	if !ok {
		return nil, errors.New("Fork source Folder checkpoint is invalid")
	}
	mappedFolders := make([]canonical.Value, 0, len(folders))
	for _, value := range folders {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 7) {
			return nil, errors.New("Fork source Folder checkpoint entry is invalid")
		}
		folder, err := mapForkRequiredID(replicaMapEntryMust(entry, 0), "Folder", mappings)
		if err != nil {
			return nil, err
		}
		nameCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 2), mappings)
		if err != nil {
			return nil, err
		}
		parent, err := mapForkNullableID(replicaMapEntryMust(entry, 3), "Folder", mappings)
		if err != nil {
			return nil, err
		}
		parentCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 4), mappings)
		if err != nil {
			return nil, err
		}
		lifecycleCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 6), mappings)
		if err != nil {
			return nil, err
		}
		mappedFolders = append(mappedFolders, canonical.Map{0: folder, 1: replicaMapEntryMust(entry, 1), 2: nameCauses, 3: parent, 4: parentCauses, 5: replicaMapEntryMust(entry, 5), 6: lifecycleCauses})
	}

	tags, ok := replicaMapArray(content, 6)
	if !ok {
		return nil, errors.New("Fork source Tag checkpoint is invalid")
	}
	mappedTags := make([]canonical.Value, 0, len(tags))
	for _, value := range tags {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 6) {
			return nil, errors.New("Fork source Tag checkpoint entry is invalid")
		}
		tag, err := mapForkRequiredID(replicaMapEntryMust(entry, 0), "Tag", mappings)
		if err != nil {
			return nil, err
		}
		nameCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 2), mappings)
		if err != nil {
			return nil, err
		}
		redirect, err := mapForkRedirect(replicaMapEntryMust(entry, 3), "Tag", mappings)
		if err != nil {
			return nil, err
		}
		lifecycleCauses, err := mapForkCauseSet(replicaMapEntryMust(entry, 5), mappings)
		if err != nil {
			return nil, err
		}
		mappedTags = append(mappedTags, canonical.Map{0: tag, 1: replicaMapEntryMust(entry, 1), 2: nameCauses, 3: redirect, 4: replicaMapEntryMust(entry, 4), 5: lifecycleCauses})
	}

	assignments, ok := replicaMapArray(content, 7)
	if !ok {
		return nil, errors.New("Fork source Tag Assignment checkpoint is invalid")
	}
	mappedAssignments := make([]canonical.Value, 0, len(assignments))
	for _, value := range assignments {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 4) {
			return nil, errors.New("Fork source Tag Assignment checkpoint entry is invalid")
		}
		assignment, err := mapForkRequiredID(replicaMapEntryMust(entry, 0), "TagAssignment", mappings)
		if err != nil {
			return nil, err
		}
		cause, err := mapForkCauseID(replicaMapEntryMust(entry, 1), mappings)
		if err != nil {
			return nil, err
		}
		tag, err := mapForkRequiredID(replicaMapEntryMust(entry, 2), "Tag", mappings)
		if err != nil {
			return nil, err
		}
		target, err := mapForkTarget(replicaMapEntryMust(entry, 3), mappings)
		if err != nil {
			return nil, err
		}
		mappedAssignments = append(mappedAssignments, canonical.Map{0: assignment, 1: cause, 2: tag, 3: target})
	}

	notes, ok := replicaMapArray(content, 8)
	if !ok {
		return nil, errors.New("Fork source Note checkpoint is invalid")
	}
	mappedNotes := make([]canonical.Value, 0, len(notes))
	for _, value := range notes {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 4) {
			return nil, errors.New("Fork source Note checkpoint entry is invalid")
		}
		note, err := mapForkRequiredID(replicaMapEntryMust(entry, 0), "Note", mappings)
		if err != nil {
			return nil, err
		}
		target, err := mapForkTarget(replicaMapEntryMust(entry, 1), mappings)
		if err != nil {
			return nil, err
		}
		versions, ok := replicaMapArray(entry, 3)
		if !ok {
			return nil, errors.New("Fork source Note versions are invalid")
		}
		mappedVersions := make([]canonical.Value, 0, len(versions))
		for _, versionValue := range versions {
			version, ok := replicaMapValue(versionValue)
			if !ok || !replicaMapHasKeys(version, 4) {
				return nil, errors.New("Fork source Note version is invalid")
			}
			cause, err := mapForkCauseID(replicaMapEntryMust(version, 0), mappings)
			if err != nil {
				return nil, err
			}
			contentObject, err := mapForkNullableID(replicaMapEntryMust(version, 1), "VaultObject", mappings)
			if err != nil {
				return nil, err
			}
			restoreObject, err := mapForkNullableID(replicaMapEntryMust(version, 2), "VaultObject", mappings)
			if err != nil {
				return nil, err
			}
			mappedVersions = append(mappedVersions, canonical.Map{0: cause, 1: contentObject, 2: restoreObject, 3: replicaMapEntryMust(version, 3)})
		}
		mappedNotes = append(mappedNotes, canonical.Map{0: note, 1: target, 2: replicaMapEntryMust(entry, 2), 3: mappedVersions})
	}

	conflicts, ok := replicaMapArray(content, 9)
	if !ok {
		return nil, errors.New("Fork source conflict checkpoint is invalid")
	}
	mappedConflicts := make([]canonical.Value, 0, len(conflicts))
	for _, value := range conflicts {
		entry, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(entry, 3) {
			return nil, errors.New("Fork source conflict checkpoint entry is invalid")
		}
		kind, ok := replicaMapNumber(entry, 0)
		if !ok {
			return nil, errors.New("Fork source conflict kind is invalid")
		}
		subjectValues, ok := replicaMapArray(entry, 1)
		if !ok {
			return nil, errors.New("Fork source conflict subjects are invalid")
		}
		subjects := make([]canonical.Value, 0, len(subjectValues))
		subjectKind := "Collection"
		if kind == 2 {
			subjectKind = "Folder"
		} else if kind == 3 {
			subjectKind = "Tag"
		} else if kind == 4 {
			subjectKind = "Note"
		}
		for _, subject := range subjectValues {
			mapped, mapErr := mapForkRequiredID(subject, subjectKind, mappings)
			if mapErr != nil {
				return nil, mapErr
			}
			subjects = append(subjects, mapped)
		}
		candidateValues, ok := replicaMapArray(entry, 2)
		if !ok {
			return nil, errors.New("Fork source conflict candidates are invalid")
		}
		candidates := make([]canonical.Value, 0, len(candidateValues))
		for _, candidateValue := range candidateValues {
			candidate, ok := replicaMapValue(candidateValue)
			if !ok || !replicaMapHasKeys(candidate, 2) {
				return nil, errors.New("Fork source conflict candidate is invalid")
			}
			cause, err := mapForkCauseID(replicaMapEntryMust(candidate, 0), mappings)
			if err != nil {
				return nil, err
			}
			state, err := mapForkConflictState(kind, replicaMapEntryMust(candidate, 1), mappings)
			if err != nil {
				return nil, err
			}
			candidates = append(candidates, canonical.Map{0: cause, 1: state})
		}
		mappedConflicts = append(mappedConflicts, canonical.Map{0: kind, 1: canonicalSetValues(subjects), 2: candidates})
	}

	return canonical.Map{0: uint64(1), 1: labelCheckpoint, 2: []canonical.Value{}, 3: mappedCaptures, 4: mappedCollections, 5: mappedFolders, 6: mappedTags, 7: mappedAssignments, 8: mappedNotes, 9: mappedConflicts}, nil
}

func forkFeatureInputs(replica *Replica, expected canonical.Identifier) ([]canonical.FeatureManifestInput, error) {
	manifests := replica.FeatureManifests()
	inputs := make([]canonical.FeatureManifestInput, 0, len(manifests))
	for _, manifest := range manifests {
		inputs = append(inputs, manifest.FeatureManifestInput)
	}
	setID, err := canonical.RequiredFeatureSetID(inputs)
	if err != nil || setID != expected {
		return nil, errors.New("Fork source Required Feature Set is not unambiguous")
	}
	return inputs, nil
}
