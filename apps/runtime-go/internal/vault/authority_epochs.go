package vault

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
)

// keyEpochReplayState is the portion of Authority State that is needed to
// authenticate the Key Epoch inventory. The complete Authority reducer grows
// this state with membership, administration, invitations, and fences; this
// validator deliberately keeps the Epoch boundary strict while those reducers
// are still being ported.
type keyEpochReplayState struct {
	firstClientCredential canonical.Identifier
	epochs                map[canonical.Identifier]uint64
	heads                 map[canonical.Identifier]struct{}
	headSlots             map[canonical.Identifier][]keyEpochEnvelopeSlot
	recoveryTargets       map[canonical.Identifier]uint64
	clientTargets         map[canonical.Identifier]struct{}
}

type keyEpochTransition struct {
	parentEpochIDs []canonical.Identifier
	newEpochID     canonical.Identifier
	displayNumber  uint64
	slots          []keyEpochEnvelopeSlot
}

type keyEpochEnvelopeSlot struct {
	epochID        canonical.Identifier
	targetKind     uint64
	targetID       canonical.Identifier
	targetRevision *uint64
	envelopeID     canonical.Identifier
}

// replayAuthenticatedKeyEpochs derives the authenticated Epoch set from the
// supplied Authority-parent graph. If epochKeys is non-nil, it additionally
// verifies every supplied secret's Vault-scoped commitment and requires a key
// for every authenticated Epoch. A nil map performs only structural replay.
func replayAuthenticatedKeyEpochs(events []canonical.Event, genesis canonical.Event, epochKeys map[canonical.Identifier][]byte) (keyEpochReplayState, error) {
	genesisID := genesis.RecordID
	initialEpoch, firstClient, firstRecovery, err := parseGenesisEpochIdentity(genesis)
	if err != nil {
		return keyEpochReplayState{}, err
	}
	state := keyEpochReplayState{
		firstClientCredential: firstClient,
		epochs:                map[canonical.Identifier]uint64{initialEpoch: 0},
		heads:                 map[canonical.Identifier]struct{}{initialEpoch: {}},
		headSlots:             map[canonical.Identifier][]keyEpochEnvelopeSlot{},
		recoveryTargets:       map[canonical.Identifier]uint64{firstRecovery: 0},
		clientTargets:         map[canonical.Identifier]struct{}{firstClient: {}},
	}
	byID := make(map[canonical.Identifier]canonical.Event, len(events))
	for _, event := range events {
		if event.VaultID != genesis.VaultID || event.GenerationID != genesis.GenerationID {
			return keyEpochReplayState{}, errors.New("Authority Event belongs to another Vault context")
		}
		if _, exists := byID[event.RecordID]; exists {
			return keyEpochReplayState{}, errors.New("Authority Event identity is duplicated")
		}
		byID[event.RecordID] = event
	}
	if existing, ok := byID[genesisID]; !ok || existing.RecordID != genesisID {
		byID[genesisID] = genesis
	} else if !bytes.Equal(existing.Bytes, genesis.Bytes) {
		return keyEpochReplayState{}, errors.New("Genesis identity has conflicting bytes")
	}
	cache := map[canonical.Identifier]keyEpochReplayState{genesisID: state}
	visiting := make(map[canonical.Identifier]struct{})
	var visit func(canonical.Identifier) (keyEpochReplayState, error)
	visit = func(recordID canonical.Identifier) (keyEpochReplayState, error) {
		if cached, ok := cache[recordID]; ok {
			return cloneKeyEpochReplayState(cached), nil
		}
		if _, ok := visiting[recordID]; ok {
			return keyEpochReplayState{}, errors.New("Authority Event graph contains a cycle")
		}
		event, ok := byID[recordID]
		if !ok {
			return keyEpochReplayState{}, fmt.Errorf("Authority Parent %s is unavailable", hexIdentifier(recordID))
		}
		if event.Family == canonical.AuthorityFamily && event.Type == canonical.GenesisEvent {
			return keyEpochReplayState{}, errors.New("Authority graph contains a second Genesis Event")
		}
		if len(event.AuthorityParentIDs) == 0 {
			return keyEpochReplayState{}, errors.New("non-Genesis Authority Event has no Authority Parents")
		}
		visiting[recordID] = struct{}{}
		parentStates := make([]keyEpochReplayState, 0, len(event.AuthorityParentIDs))
		for _, parentID := range event.AuthorityParentIDs {
			parent, parentErr := visit(parentID)
			if parentErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parentErr
			}
			parentStates = append(parentStates, parent)
		}
		current := mergeKeyEpochReplayStates(parentStates)
		if event.Family == canonical.AuthorityFamily && event.Type == 9 {
			enrollment, enrollmentErr := parseEnrollmentCredential(event)
			if enrollmentErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, enrollmentErr
			}
			if _, exists := current.clientTargets[enrollment.credentialID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Client Enrollment reuses a Client Credential identity")
			}
			current.clientTargets[enrollment.credentialID] = struct{}{}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 12 {
			if event.SignerCredentialID != current.firstClientCredential {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Key Epoch Transition signer is not the established Administrator Credential")
			}
			transition, transitionErr := parseKeyEpochTransition(event)
			if transitionErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, transitionErr
			}
			if err := validateKeyEpochTransition(current, event, transition); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			for _, parentID := range transition.parentEpochIDs {
				delete(current.heads, parentID)
			}
			current.heads[transition.newEpochID] = struct{}{}
			current.epochs[transition.newEpochID] = transition.displayNumber
			current.headSlots[transition.newEpochID] = cloneKeyEpochEnvelopeSlots(transition.slots)
		}
		delete(visiting, recordID)
		cache[recordID] = cloneKeyEpochReplayState(current)
		return current, nil
	}

	final := cloneKeyEpochReplayState(state)
	for _, event := range events {
		if event.RecordID == genesisID {
			continue
		}
		candidate, visitErr := visit(event.RecordID)
		if visitErr != nil {
			return keyEpochReplayState{}, visitErr
		}
		final = mergeKeyEpochReplayStates([]keyEpochReplayState{final, candidate})
	}
	if epochKeys != nil {
		for epochID, key := range epochKeys {
			if len(key) != 32 {
				return keyEpochReplayState{}, fmt.Errorf("Key Epoch %s does not contain 32 bytes", hexIdentifier(epochID))
			}
			derived, deriveErr := awsmcrypto.KeyEpochID(genesis.VaultID, key)
			if deriveErr != nil || derived != epochID {
				return keyEpochReplayState{}, fmt.Errorf("Key Epoch %s commitment is invalid", hexIdentifier(epochID))
			}
			if _, established := final.epochs[epochID]; !established {
				return keyEpochReplayState{}, fmt.Errorf("Key Epoch %s is not established by authenticated Authority history", hexIdentifier(epochID))
			}
		}
		for epochID := range final.epochs {
			if _, available := epochKeys[epochID]; !available {
				return keyEpochReplayState{}, fmt.Errorf("authenticated Key Epoch %s is missing from the Key Inventory", hexIdentifier(epochID))
			}
		}
	}
	return final, nil
}

func cloneKeyEpochReplayState(value keyEpochReplayState) keyEpochReplayState {
	clone := keyEpochReplayState{
		firstClientCredential: value.firstClientCredential,
		epochs:                make(map[canonical.Identifier]uint64, len(value.epochs)),
		heads:                 make(map[canonical.Identifier]struct{}, len(value.heads)),
		headSlots:             make(map[canonical.Identifier][]keyEpochEnvelopeSlot, len(value.headSlots)),
		recoveryTargets:       make(map[canonical.Identifier]uint64, len(value.recoveryTargets)),
		clientTargets:         make(map[canonical.Identifier]struct{}, len(value.clientTargets)),
	}
	for id, display := range value.epochs {
		clone.epochs[id] = display
	}
	for id, slots := range value.headSlots {
		clone.headSlots[id] = cloneKeyEpochEnvelopeSlots(slots)
	}
	for id := range value.heads {
		clone.heads[id] = struct{}{}
	}
	for id, revision := range value.recoveryTargets {
		clone.recoveryTargets[id] = revision
	}
	for id := range value.clientTargets {
		clone.clientTargets[id] = struct{}{}
	}
	return clone
}

func mergeKeyEpochReplayStates(values []keyEpochReplayState) keyEpochReplayState {
	if len(values) == 0 {
		return keyEpochReplayState{
			epochs:          make(map[canonical.Identifier]uint64),
			heads:           make(map[canonical.Identifier]struct{}),
			headSlots:       make(map[canonical.Identifier][]keyEpochEnvelopeSlot),
			recoveryTargets: make(map[canonical.Identifier]uint64),
			clientTargets:   make(map[canonical.Identifier]struct{}),
		}
	}
	merged := cloneKeyEpochReplayState(values[0])
	for _, value := range values[1:] {
		for id, display := range value.epochs {
			if existing, ok := merged.epochs[id]; ok && existing != display {
				continue
			}
			merged.epochs[id] = display
		}
		for id := range value.heads {
			merged.heads[id] = struct{}{}
		}
		for id, slots := range value.headSlots {
			if _, exists := merged.headSlots[id]; !exists {
				merged.headSlots[id] = cloneKeyEpochEnvelopeSlots(slots)
			}
		}
		for id, revision := range value.recoveryTargets {
			if existing, ok := merged.recoveryTargets[id]; !ok || revision > existing {
				merged.recoveryTargets[id] = revision
			}
		}
		for id := range value.clientTargets {
			merged.clientTargets[id] = struct{}{}
		}
	}
	return merged
}

func cloneKeyEpochEnvelopeSlots(values []keyEpochEnvelopeSlot) []keyEpochEnvelopeSlot {
	result := make([]keyEpochEnvelopeSlot, len(values))
	for index, value := range values {
		result[index] = value
		if value.targetRevision != nil {
			revision := *value.targetRevision
			result[index].targetRevision = &revision
		}
	}
	return result
}

func parseGenesisEpochIdentity(event canonical.Event) (canonical.Identifier, canonical.Identifier, canonical.Identifier, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 7) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis authority body is invalid")
	}
	epochBytes, epochOK := replicaMapBytes(body, 4, 32)
	_, memberOK := replicaMapBytes(body, 1, 32)
	if !epochOK || !memberOK {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Key Epoch or Member identity is invalid")
	}
	clientCredential, ok := replicaMapValue(replicaMapEntryMust(body, 2))
	if !ok || !replicaMapHasKeys(clientCredential, 4) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Client Credential certificate is invalid")
	}
	clientBytes, clientOK := replicaMapBytes(clientCredential, 0, 32)
	recoveryCredential, ok := replicaMapValue(replicaMapEntryMust(body, 3))
	if !ok || !replicaMapHasKeys(recoveryCredential, 5) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Recovery Credential descriptor is invalid")
	}
	recoveryBytes, recoveryOK := replicaMapBytes(recoveryCredential, 0, 32)
	recoveryRevision, revisionOK := replicaMapNumber(recoveryCredential, 2)
	if !clientOK || !recoveryOK || !revisionOK || recoveryRevision != 0 {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Credential identities are invalid")
	}
	return bytesIdentifier(epochBytes), bytesIdentifier(clientBytes), bytesIdentifier(recoveryBytes), nil
}

func parseKeyEpochTransition(event canonical.Event) (keyEpochTransition, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 4) {
		return keyEpochTransition{}, errors.New("Key Epoch Transition body is invalid")
	}
	parentEpochIDs, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 0), "parent Key Epoch IDs", true)
	if err != nil {
		return keyEpochTransition{}, err
	}
	newEpochBytes, ok := replicaMapBytes(body, 1, 32)
	if !ok || bytes.Equal(newEpochBytes, make([]byte, 32)) {
		return keyEpochTransition{}, errors.New("Key Epoch Transition new Key Epoch ID is invalid")
	}
	displayNumber, ok := replicaMapNumber(body, 2)
	if !ok {
		return keyEpochTransition{}, errors.New("Key Epoch Transition display number is invalid")
	}
	values, ok := replicaMapArrayValue(replicaMapEntryMust(body, 3))
	if !ok || len(values) == 0 {
		return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope slots are invalid")
	}
	slots := make([]keyEpochEnvelopeSlot, 0, len(values))
	var previous []byte
	seenTargets := make(map[string]struct{}, len(values))
	seenEnvelopes := make(map[canonical.Identifier]struct{}, len(values))
	for _, value := range values {
		encoded, encodeErr := canonical.EncodeValue(value)
		if encodeErr != nil {
			return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope slot is not canonical")
		}
		if previous != nil && bytes.Compare(previous, encoded) >= 0 {
			return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope slots are not a canonical set")
		}
		previous = encoded
		slot, ok := replicaMapValue(value)
		if !ok || !replicaMapHasKeys(slot, 5) {
			return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope slot is invalid")
		}
		epochBytes, epochOK := replicaMapBytes(slot, 0, 32)
		targetKind, kindOK := replicaMapNumber(slot, 1)
		targetBytes, targetOK := replicaMapBytes(slot, 2, 32)
		envelopeBytes, envelopeOK := replicaMapBytes(slot, 4, 32)
		if !epochOK || !kindOK || !targetOK || !envelopeOK || bytes.Equal(envelopeBytes, make([]byte, 32)) {
			return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope slot identity is invalid")
		}
		if targetKind != awsmcrypto.RecoveryCredentialTarget && targetKind != awsmcrypto.ClientCredentialTarget {
			return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope target kind is invalid")
		}
		var revision *uint64
		revisionValue, exists := replicaMapEntry(slot, 3)
		if !exists {
			return keyEpochTransition{}, errors.New("Key Epoch Transition Envelope target revision is missing")
		}
		if targetKind == awsmcrypto.RecoveryCredentialTarget {
			number, ok := revisionValue.(uint64)
			if !ok {
				return keyEpochTransition{}, errors.New("Recovery Key Envelope target revision is invalid")
			}
			revision = &number
		} else if revisionValue != nil {
			return keyEpochTransition{}, errors.New("Client Key Envelope target revision must be null")
		}
		target := fmt.Sprintf("%d:%x:%v", targetKind, targetBytes, revision)
		if _, exists := seenTargets[target]; exists {
			return keyEpochTransition{}, errors.New("Key Epoch Transition repeats an Envelope target")
		}
		seenTargets[target] = struct{}{}
		envelopeID := bytesIdentifier(envelopeBytes)
		if _, exists := seenEnvelopes[envelopeID]; exists {
			return keyEpochTransition{}, errors.New("Key Epoch Transition repeats an Envelope identity")
		}
		seenEnvelopes[envelopeID] = struct{}{}
		slots = append(slots, keyEpochEnvelopeSlot{
			epochID: bytesIdentifier(epochBytes), targetKind: targetKind, targetID: bytesIdentifier(targetBytes),
			targetRevision: revision, envelopeID: envelopeID,
		})
	}
	return keyEpochTransition{parentEpochIDs: parentEpochIDs, newEpochID: bytesIdentifier(newEpochBytes), displayNumber: displayNumber, slots: slots}, nil
}

func validateKeyEpochTransition(state keyEpochReplayState, event canonical.Event, transition keyEpochTransition) error {
	if len(transition.parentEpochIDs) != len(state.heads) {
		return errors.New("Key Epoch Transition does not name every effective Epoch head")
	}
	for _, parentID := range transition.parentEpochIDs {
		if _, ok := state.heads[parentID]; !ok {
			return errors.New("Key Epoch Transition names an ineffective Epoch head")
		}
	}
	if _, exists := state.epochs[transition.newEpochID]; exists {
		return errors.New("Key Epoch Transition reuses a Key Epoch identity")
	}
	maximum := uint64(0)
	for _, parentID := range transition.parentEpochIDs {
		if display := state.epochs[parentID]; display > maximum {
			maximum = display
		}
	}
	expectedDisplay := maximum + 1
	if transition.displayNumber != expectedDisplay {
		return fmt.Errorf("Key Epoch display number %d does not follow effective heads (want %d)", transition.displayNumber, expectedDisplay)
	}
	expectedTargets := make(map[string]struct{}, len(state.recoveryTargets)+len(state.clientTargets))
	for targetID, revision := range state.recoveryTargets {
		expectedTargets[fmt.Sprintf("%d:%x:%d", awsmcrypto.RecoveryCredentialTarget, targetID, revision)] = struct{}{}
	}
	for targetID := range state.clientTargets {
		expectedTargets[fmt.Sprintf("%d:%x:%v", awsmcrypto.ClientCredentialTarget, targetID, nil)] = struct{}{}
	}
	actualTargets := make(map[string]struct{}, len(transition.slots))
	dependencyIDs := make(map[canonical.Identifier]struct{}, len(event.Dependencies))
	for _, dependency := range event.Dependencies {
		if dependency.Type != 7 {
			return errors.New("Key Epoch Transition dependencies must be Key Envelopes")
		}
		dependencyIDs[dependency.ID] = struct{}{}
	}
	if len(dependencyIDs) != len(transition.slots) {
		return errors.New("Key Epoch Transition dependencies do not match Envelope slots")
	}
	for _, slot := range transition.slots {
		if slot.epochID != transition.newEpochID {
			return errors.New("Key Epoch Transition slot names a different Key Epoch")
		}
		var target string
		if slot.targetKind == awsmcrypto.RecoveryCredentialTarget {
			if slot.targetRevision == nil {
				return errors.New("Recovery Key Envelope slot omits its revision")
			}
			target = fmt.Sprintf("%d:%x:%d", slot.targetKind, slot.targetID, *slot.targetRevision)
		} else {
			target = fmt.Sprintf("%d:%x:%v", slot.targetKind, slot.targetID, nil)
		}
		actualTargets[target] = struct{}{}
		if _, ok := dependencyIDs[slot.envelopeID]; !ok {
			return errors.New("Key Epoch Transition omits a slot Envelope dependency")
		}
	}
	if len(actualTargets) != len(expectedTargets) {
		return errors.New("Key Epoch Transition Envelope slots are not the exact eligible target set")
	}
	for target := range expectedTargets {
		if _, ok := actualTargets[target]; !ok {
			return errors.New("Key Epoch Transition Envelope slots are not the exact eligible target set")
		}
	}
	return nil
}

func parseCanonicalIdentifierSet(value canonical.Value, field string, nonempty bool) ([]canonical.Identifier, error) {
	values, ok := replicaMapArrayValue(value)
	if !ok || (nonempty && len(values) == 0) {
		return nil, fmt.Errorf("%s is invalid", field)
	}
	result := make([]canonical.Identifier, 0, len(values))
	var previous []byte
	seen := make(map[canonical.Identifier]struct{}, len(values))
	for _, entry := range values {
		encoded, err := canonical.EncodeValue(entry)
		if err != nil {
			return nil, fmt.Errorf("%s is not canonical", field)
		}
		if previous != nil && bytes.Compare(previous, encoded) >= 0 {
			return nil, fmt.Errorf("%s is not a canonical set", field)
		}
		previous = encoded
		bytesValue, ok := entry.([]byte)
		if !ok || len(bytesValue) != 32 {
			return nil, fmt.Errorf("%s contains an invalid identifier", field)
		}
		id := bytesIdentifier(bytesValue)
		if _, exists := seen[id]; exists {
			return nil, fmt.Errorf("%s contains a duplicate", field)
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, nil
}

func validateReplicaKeyEpochHistory(replica *Replica, state *canonicalReplicaState) error {
	if replica == nil || state == nil {
		return errors.New("authenticated Replica is unavailable")
	}
	genesis, ok := replica.Record(mustDecodeIdentifier(state.GenesisID))
	if !ok || genesis.Event == nil {
		return errors.New("authenticated Genesis is unavailable")
	}
	structural, err := replayAuthenticatedKeyEpochs(replica.Events(), *genesis.Event, nil)
	if err != nil {
		return err
	}
	for _, epochIDText := range state.StorageItemKeyEpochIDs {
		epochID, decodeErr := decodeHexIdentifier(epochIDText)
		if decodeErr != nil {
			return errors.New("Storage Item Key Epoch identity is invalid")
		}
		if _, established := structural.epochs[epochID]; !established {
			return fmt.Errorf("Key Epoch %s is not established by authenticated Authority history", epochIDText)
		}
	}
	return nil
}

func mustDecodeIdentifier(value string) canonical.Identifier {
	id, err := decodeHexIdentifier(value)
	if err != nil {
		return canonical.Identifier{}
	}
	return id
}

func sortedEpochIDs(values map[canonical.Identifier]struct{}) []canonical.Identifier {
	result := make([]canonical.Identifier, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Slice(result, func(left, right int) bool { return bytes.Compare(result[left][:], result[right][:]) < 0 })
	return result
}
