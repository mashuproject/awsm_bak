package vault

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
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
	activeMembers         map[canonical.Identifier]struct{}
	administrators        map[canonical.Identifier]struct{}
	clientMembers         map[canonical.Identifier]canonical.Identifier
	epochs                map[canonical.Identifier]uint64
	heads                 map[canonical.Identifier]struct{}
	headSlots             map[canonical.Identifier][]keyEpochEnvelopeSlot
	recoveryMembers       map[canonical.Identifier]canonical.Identifier
	recoveryRevisions     map[canonical.Identifier]uint64
	recoverySigningKeys   map[canonical.Identifier]ed25519.PublicKey
	recoveryTargets       map[canonical.Identifier]uint64
	clientTargets         map[canonical.Identifier]struct{}
	closed                bool
}

type recoveryReplacement struct {
	memberID        canonical.Identifier
	replacedIDs     []canonical.Identifier
	recoveryID      canonical.Identifier
	revision        uint64
	signingKey      ed25519.PublicKey
	keyEpochSlots   []keyEpochEnvelopeSlot
	descriptorBytes []byte
	slotsBytes      []byte
	possessionProof []byte
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
	initialEpoch, firstMember, firstClient, firstRecovery, err := parseGenesisEpochIdentity(genesis)
	if err != nil {
		return keyEpochReplayState{}, err
	}
	state := keyEpochReplayState{
		firstClientCredential: firstClient,
		activeMembers:         map[canonical.Identifier]struct{}{firstMember: {}},
		administrators:        map[canonical.Identifier]struct{}{firstMember: {}},
		clientMembers:         map[canonical.Identifier]canonical.Identifier{firstClient: firstMember},
		epochs:                map[canonical.Identifier]uint64{initialEpoch: 0},
		heads:                 map[canonical.Identifier]struct{}{initialEpoch: {}},
		headSlots:             map[canonical.Identifier][]keyEpochEnvelopeSlot{},
		recoveryMembers:       map[canonical.Identifier]canonical.Identifier{firstRecovery: firstMember},
		recoveryRevisions:     map[canonical.Identifier]uint64{firstRecovery: 0},
		recoverySigningKeys:   map[canonical.Identifier]ed25519.PublicKey{firstRecovery: genesisRecoverySigningKey(genesis)},
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
		if current.closed {
			delete(visiting, recordID)
			return keyEpochReplayState{}, errors.New("Event descends from Closed Authority State")
		}
		if event.Family == canonical.AuthorityFamily && event.Type != canonical.GenesisEvent {
			if event.Type != 9 || enrollmentAuthorizationKind(event) != 2 {
				if _, ok := current.activeClientMember(event.SignerCredentialID); !ok {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Authority Event signer is not an active Client Credential")
				}
			}
		}
		if event.Family == canonical.LifecycleFamily && event.Type != 1 {
			if _, ok := current.activeClientMember(event.SignerCredentialID); !ok {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Lifecycle Event signer is not an active Client Credential")
			}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 2 {
			targetMember, parseErr := parseAuthorityTargetMember(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			if _, ok := current.activeMembers[targetMember]; !ok {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Membership End target is not an active Member")
			}
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Membership End signer is not an active Client Credential")
			}
			if signerMember != targetMember {
				if _, admin := current.administrators[signerMember]; !admin {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Membership End signer is not authorized for the target Member")
				}
			}
			delete(current.activeMembers, targetMember)
			delete(current.administrators, targetMember)
			for credentialID, memberID := range current.clientMembers {
				if memberID == targetMember {
					delete(current.clientTargets, credentialID)
				}
			}
			for credentialID, memberID := range current.recoveryMembers {
				if memberID == targetMember {
					delete(current.recoveryTargets, credentialID)
				}
			}
			if len(current.administrators) == 0 {
				current.closed = true
			}
		}
		if event.Family == canonical.AuthorityFamily && (event.Type == 3 || event.Type == 4) {
			targetMember, resolved, parseErr := parseAdministratorRole(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Administrator role signer is not an active Client Credential")
			}
			if _, admin := current.administrators[signerMember]; !admin {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Administrator role signer is not an Administrator")
			}
			if len(resolved) != 0 {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Administrator role resolution is not supported before conflict replay")
			}
			if _, active := current.activeMembers[targetMember]; !active {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Administrator role target is not an active Member")
			}
			_, alreadyAdmin := current.administrators[targetMember]
			if event.Type == 3 {
				if alreadyAdmin {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Administrator Grant target is already an Administrator")
				}
				current.administrators[targetMember] = struct{}{}
			} else {
				if !alreadyAdmin {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Administrator End target is not an Administrator")
				}
				delete(current.administrators, targetMember)
				if len(current.administrators) == 0 {
					current.closed = true
				}
			}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 9 {
			enrollment, enrollmentErr := parseEnrollmentCredential(event)
			if enrollmentErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, enrollmentErr
			}
			if _, active := current.activeMembers[enrollment.memberID]; !active {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Client Enrollment target is not an active Member")
			}
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if enrollment.authorizationKind == 1 && (!signerOK || signerMember != enrollment.memberID) {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Client Enrollment signer does not belong to the target Member")
			}
			if err := validateClientEnrollment(current, event, enrollment); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			if _, exists := current.clientMembers[enrollment.credentialID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Client Enrollment reuses a Client Credential identity")
			}
			current.clientMembers[enrollment.credentialID] = enrollment.memberID
			current.clientTargets[enrollment.credentialID] = struct{}{}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 10 {
			targetCredential, parseErr := parseAuthorityTargetCredential(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			targetMember, targetActive := current.activeClientMember(targetCredential)
			if !targetActive {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Client Credential End target is not active")
			}
			signerMember, signerActive := current.activeClientMember(event.SignerCredentialID)
			if !signerActive {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Client Credential End signer is not active")
			}
			if event.SignerCredentialID != targetCredential && signerMember != targetMember {
				if _, admin := current.administrators[signerMember]; !admin {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Client Credential End signer is not authorized for the target")
				}
			}
			delete(current.clientTargets, targetCredential)
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 11 {
			replacement, parseErr := parseRecoveryReplacement(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK || signerMember != replacement.memberID {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Recovery Replacement signer does not belong to the target Member")
			}
			if _, active := current.activeMembers[replacement.memberID]; !active {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Recovery Replacement target Member is not active")
			}
			expectedReplaced := make(map[canonical.Identifier]struct{})
			maximumRevision := uint64(0)
			for recoveryID, memberID := range current.recoveryMembers {
				if memberID != replacement.memberID {
					continue
				}
				if revision, effective := current.recoveryTargets[recoveryID]; effective {
					expectedReplaced[recoveryID] = struct{}{}
					if revision > maximumRevision {
						maximumRevision = revision
					}
				}
			}
			if !sameIdentifierSet(replacement.replacedIDs, expectedReplaced) {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Recovery Replacement does not name every effective Credential")
			}
			if replacement.revision != maximumRevision+1 {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Recovery Replacement revision does not follow its effective heads")
			}
			if _, exists := current.recoveryRevisions[replacement.recoveryID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Recovery Replacement reuses a Recovery Credential identity")
			}
			if err := validateRecoveryReplacementSlots(current, event, replacement); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			for recoveryID := range expectedReplaced {
				delete(current.recoveryTargets, recoveryID)
			}
			current.recoveryMembers[replacement.recoveryID] = replacement.memberID
			current.recoveryRevisions[replacement.recoveryID] = replacement.revision
			current.recoverySigningKeys[replacement.recoveryID] = append(ed25519.PublicKey(nil), replacement.signingKey...)
			current.recoveryTargets[replacement.recoveryID] = replacement.revision
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 12 {
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Key Epoch Transition signer is not an active Client Credential")
			}
			if _, isAdmin := current.administrators[signerMember]; !isAdmin {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Key Epoch Transition signer is not an Administrator")
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
		if event.Family == canonical.LifecycleFamily && event.Type == 2 {
			body, ok := replicaMapValue(event.Body)
			if !ok || lenReplicaMapEntries(body) != 0 {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Closure Event body is not the canonical empty map")
			}
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Closure signer is not an active Client Credential")
			}
			if _, isAdmin := current.administrators[signerMember]; !isAdmin {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Closure signer is not an Administrator")
			}
			current.closed = true
		}
		delete(visiting, recordID)
		cache[recordID] = cloneKeyEpochReplayState(current)
		return current, nil
	}

	statesByID := make(map[canonical.Identifier]keyEpochReplayState, len(events))
	frontierIDs := make(map[canonical.Identifier]struct{}, len(events))
	for _, event := range events {
		if event.RecordID == genesisID {
			continue
		}
		candidate, visitErr := visit(event.RecordID)
		if visitErr != nil {
			return keyEpochReplayState{}, visitErr
		}
		statesByID[event.RecordID] = candidate
		frontierIDs[event.RecordID] = struct{}{}
		for _, parentID := range event.AuthorityParentIDs {
			delete(frontierIDs, parentID)
		}
	}
	final := cloneKeyEpochReplayState(state)
	if len(frontierIDs) > 0 {
		frontierStates := make([]keyEpochReplayState, 0, len(frontierIDs))
		for recordID := range frontierIDs {
			frontierStates = append(frontierStates, statesByID[recordID])
		}
		final = mergeKeyEpochReplayStates(frontierStates)
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
		activeMembers:         make(map[canonical.Identifier]struct{}, len(value.activeMembers)),
		administrators:        make(map[canonical.Identifier]struct{}, len(value.administrators)),
		clientMembers:         make(map[canonical.Identifier]canonical.Identifier, len(value.clientMembers)),
		epochs:                make(map[canonical.Identifier]uint64, len(value.epochs)),
		heads:                 make(map[canonical.Identifier]struct{}, len(value.heads)),
		headSlots:             make(map[canonical.Identifier][]keyEpochEnvelopeSlot, len(value.headSlots)),
		recoveryMembers:       make(map[canonical.Identifier]canonical.Identifier, len(value.recoveryMembers)),
		recoveryRevisions:     make(map[canonical.Identifier]uint64, len(value.recoveryRevisions)),
		recoverySigningKeys:   make(map[canonical.Identifier]ed25519.PublicKey, len(value.recoverySigningKeys)),
		recoveryTargets:       make(map[canonical.Identifier]uint64, len(value.recoveryTargets)),
		clientTargets:         make(map[canonical.Identifier]struct{}, len(value.clientTargets)),
		closed:                value.closed,
	}
	for id := range value.activeMembers {
		clone.activeMembers[id] = struct{}{}
	}
	for id := range value.administrators {
		clone.administrators[id] = struct{}{}
	}
	for credentialID, memberID := range value.clientMembers {
		clone.clientMembers[credentialID] = memberID
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
	for credentialID, memberID := range value.recoveryMembers {
		clone.recoveryMembers[credentialID] = memberID
	}
	for credentialID, revision := range value.recoveryRevisions {
		clone.recoveryRevisions[credentialID] = revision
	}
	for credentialID, signingKey := range value.recoverySigningKeys {
		clone.recoverySigningKeys[credentialID] = append(ed25519.PublicKey(nil), signingKey...)
	}
	for id := range value.clientTargets {
		clone.clientTargets[id] = struct{}{}
	}
	return clone
}

func mergeKeyEpochReplayStates(values []keyEpochReplayState) keyEpochReplayState {
	if len(values) == 0 {
		return keyEpochReplayState{
			activeMembers:       make(map[canonical.Identifier]struct{}),
			administrators:      make(map[canonical.Identifier]struct{}),
			clientMembers:       make(map[canonical.Identifier]canonical.Identifier),
			epochs:              make(map[canonical.Identifier]uint64),
			heads:               make(map[canonical.Identifier]struct{}),
			headSlots:           make(map[canonical.Identifier][]keyEpochEnvelopeSlot),
			recoveryMembers:     make(map[canonical.Identifier]canonical.Identifier),
			recoveryRevisions:   make(map[canonical.Identifier]uint64),
			recoverySigningKeys: make(map[canonical.Identifier]ed25519.PublicKey),
			recoveryTargets:     make(map[canonical.Identifier]uint64),
			clientTargets:       make(map[canonical.Identifier]struct{}),
		}
	}
	merged := cloneKeyEpochReplayState(values[0])
	for _, value := range values[1:] {
		for id := range value.activeMembers {
			merged.activeMembers[id] = struct{}{}
		}
		for id := range value.administrators {
			merged.administrators[id] = struct{}{}
		}
		for credentialID, memberID := range value.clientMembers {
			merged.clientMembers[credentialID] = memberID
		}
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
		for credentialID, memberID := range value.recoveryMembers {
			merged.recoveryMembers[credentialID] = memberID
		}
		for credentialID, revision := range value.recoveryRevisions {
			if existing, ok := merged.recoveryRevisions[credentialID]; !ok || revision > existing {
				merged.recoveryRevisions[credentialID] = revision
			}
		}
		for credentialID, signingKey := range value.recoverySigningKeys {
			if _, exists := merged.recoverySigningKeys[credentialID]; !exists {
				merged.recoverySigningKeys[credentialID] = append(ed25519.PublicKey(nil), signingKey...)
			}
		}
		for id := range value.clientTargets {
			merged.clientTargets[id] = struct{}{}
		}
		merged.closed = merged.closed || value.closed
	}
	return merged
}

func (value keyEpochReplayState) activeClientMember(credentialID canonical.Identifier) (canonical.Identifier, bool) {
	memberID, ok := value.clientMembers[credentialID]
	if !ok {
		return canonical.Identifier{}, false
	}
	if _, active := value.clientTargets[credentialID]; !active {
		return canonical.Identifier{}, false
	}
	if _, active := value.activeMembers[memberID]; !active {
		return canonical.Identifier{}, false
	}
	return memberID, true
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

func parseGenesisEpochIdentity(event canonical.Event) (canonical.Identifier, canonical.Identifier, canonical.Identifier, canonical.Identifier, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 7) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis authority body is invalid")
	}
	epochBytes, epochOK := replicaMapBytes(body, 4, 32)
	memberBytes, memberOK := replicaMapBytes(body, 1, 32)
	if !epochOK || !memberOK {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Key Epoch or Member identity is invalid")
	}
	clientCredential, ok := replicaMapValue(replicaMapEntryMust(body, 2))
	if !ok || !replicaMapHasKeys(clientCredential, 4) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Client Credential certificate is invalid")
	}
	clientBytes, clientOK := replicaMapBytes(clientCredential, 0, 32)
	clientMemberBytes, clientMemberOK := replicaMapBytes(clientCredential, 1, 32)
	recoveryCredential, ok := replicaMapValue(replicaMapEntryMust(body, 3))
	if !ok || !replicaMapHasKeys(recoveryCredential, 5) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Recovery Credential descriptor is invalid")
	}
	recoveryBytes, recoveryOK := replicaMapBytes(recoveryCredential, 0, 32)
	recoveryMemberBytes, recoveryMemberOK := replicaMapBytes(recoveryCredential, 1, 32)
	recoveryRevision, revisionOK := replicaMapNumber(recoveryCredential, 2)
	if !clientOK || !clientMemberOK || !recoveryOK || !recoveryMemberOK || !revisionOK || recoveryRevision != 0 ||
		!bytes.Equal(memberBytes, clientMemberBytes) || !bytes.Equal(memberBytes, recoveryMemberBytes) {
		return canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, canonical.Identifier{}, errors.New("Genesis Credential identities are invalid")
	}
	return bytesIdentifier(epochBytes), bytesIdentifier(memberBytes), bytesIdentifier(clientBytes), bytesIdentifier(recoveryBytes), nil
}

func genesisRecoverySigningKey(event canonical.Event) ed25519.PublicKey {
	body, ok := replicaMapValue(event.Body)
	if !ok {
		return nil
	}
	recoveryCredential, ok := replicaMapValue(replicaMapEntryMust(body, 3))
	if !ok {
		return nil
	}
	key, ok := replicaMapBytes(recoveryCredential, 3, ed25519.PublicKeySize)
	if !ok {
		return nil
	}
	return append(ed25519.PublicKey(nil), key...)
}

func parseAuthorityTargetMember(event canonical.Event) (canonical.Identifier, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 1) {
		return canonical.Identifier{}, errors.New("Membership End body is invalid")
	}
	memberBytes, ok := replicaMapBytes(body, 0, 32)
	if !ok || bytes.Equal(memberBytes, make([]byte, 32)) {
		return canonical.Identifier{}, errors.New("Membership End target Member ID is invalid")
	}
	return bytesIdentifier(memberBytes), nil
}

func parseAuthorityTargetCredential(event canonical.Event) (canonical.Identifier, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 1) {
		return canonical.Identifier{}, errors.New("Client Credential End body is invalid")
	}
	credentialBytes, ok := replicaMapBytes(body, 0, 32)
	if !ok || bytes.Equal(credentialBytes, make([]byte, 32)) {
		return canonical.Identifier{}, errors.New("Client Credential End target identity is invalid")
	}
	return bytesIdentifier(credentialBytes), nil
}

func parseAdministratorRole(event canonical.Event) (canonical.Identifier, []canonical.Identifier, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 2) {
		return canonical.Identifier{}, nil, errors.New("Administrator role Event body is invalid")
	}
	memberBytes, ok := replicaMapBytes(body, 0, 32)
	if !ok || bytes.Equal(memberBytes, make([]byte, 32)) {
		return canonical.Identifier{}, nil, errors.New("Administrator role target Member ID is invalid")
	}
	resolved, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 1), "resolved Administrator Record IDs", false)
	if err != nil {
		return canonical.Identifier{}, nil, err
	}
	return bytesIdentifier(memberBytes), resolved, nil
}

func parseRecoveryReplacement(event canonical.Event) (recoveryReplacement, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 5) {
		return recoveryReplacement{}, errors.New("Recovery Replacement body is invalid")
	}
	memberBytes, ok := replicaMapBytes(body, 0, 32)
	if !ok || bytes.Equal(memberBytes, make([]byte, 32)) {
		return recoveryReplacement{}, errors.New("Recovery Replacement Member ID is invalid")
	}
	replacedIDs, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 1), "replaced Recovery Credential IDs", true)
	if err != nil {
		return recoveryReplacement{}, err
	}
	descriptorValue := replicaMapEntryMust(body, 2)
	descriptor, ok := replicaMapValue(descriptorValue)
	if !ok || !replicaMapHasKeys(descriptor, 5) {
		return recoveryReplacement{}, errors.New("Recovery Replacement Credential descriptor is invalid")
	}
	recoveryBytes, recoveryOK := replicaMapBytes(descriptor, 0, 32)
	descriptorMemberBytes, descriptorMemberOK := replicaMapBytes(descriptor, 1, 32)
	revision, revisionOK := replicaMapNumber(descriptor, 2)
	signingKey, signingKeyOK := replicaMapBytes(descriptor, 3, ed25519.PublicKeySize)
	if !recoveryOK || !descriptorMemberOK || !revisionOK || !signingKeyOK || bytes.Equal(recoveryBytes, make([]byte, 32)) ||
		!bytes.Equal(memberBytes, descriptorMemberBytes) {
		return recoveryReplacement{}, errors.New("Recovery Replacement Credential descriptor fields are invalid")
	}
	if _, wrappingKeyOK := replicaMapBytes(descriptor, 4, 32); !wrappingKeyOK {
		return recoveryReplacement{}, errors.New("Recovery Replacement wrapping public key is invalid")
	}
	slotsValue := replicaMapEntryMust(body, 3)
	slots, err := parseKeyEpochEnvelopeSlots(slotsValue, "Recovery Replacement Key Envelope slots")
	if err != nil {
		return recoveryReplacement{}, err
	}
	proof, ok := replicaMapBytes(body, 4, ed25519.SignatureSize)
	if !ok {
		return recoveryReplacement{}, errors.New("Recovery Replacement possession proof is invalid")
	}
	descriptorBytes, err := canonical.EncodeValue(descriptorValue)
	if err != nil {
		return recoveryReplacement{}, errors.New("Recovery Replacement descriptor is not canonical")
	}
	slotsBytes, err := canonical.EncodeValue(slotsValue)
	if err != nil {
		return recoveryReplacement{}, errors.New("Recovery Replacement slots are not canonical")
	}
	return recoveryReplacement{
		memberID:        bytesIdentifier(memberBytes),
		replacedIDs:     replacedIDs,
		recoveryID:      bytesIdentifier(recoveryBytes),
		revision:        revision,
		signingKey:      append(ed25519.PublicKey(nil), signingKey...),
		keyEpochSlots:   slots,
		descriptorBytes: descriptorBytes,
		slotsBytes:      slotsBytes,
		possessionProof: append([]byte(nil), proof...),
	}, nil
}

func parseKeyEpochEnvelopeSlots(value canonical.Value, field string) ([]keyEpochEnvelopeSlot, error) {
	values, ok := replicaMapArrayValue(value)
	if !ok || len(values) == 0 {
		return nil, fmt.Errorf("%s are invalid", field)
	}
	result := make([]keyEpochEnvelopeSlot, 0, len(values))
	var previous []byte
	seenTargets := make(map[string]struct{}, len(values))
	seenEnvelopes := make(map[canonical.Identifier]struct{}, len(values))
	for _, entry := range values {
		encoded, err := canonical.EncodeValue(entry)
		if err != nil {
			return nil, fmt.Errorf("%s contain a non-canonical slot", field)
		}
		if previous != nil && bytes.Compare(previous, encoded) >= 0 {
			return nil, fmt.Errorf("%s are not a canonical set", field)
		}
		previous = encoded
		slot, ok := replicaMapValue(entry)
		if !ok || !replicaMapHasKeys(slot, 5) {
			return nil, fmt.Errorf("%s contain an invalid slot", field)
		}
		epochBytes, epochOK := replicaMapBytes(slot, 0, 32)
		targetKind, kindOK := replicaMapNumber(slot, 1)
		targetBytes, targetOK := replicaMapBytes(slot, 2, 32)
		envelopeBytes, envelopeOK := replicaMapBytes(slot, 4, 32)
		if !epochOK || !kindOK || !targetOK || !envelopeOK || bytes.Equal(epochBytes, make([]byte, 32)) ||
			bytes.Equal(targetBytes, make([]byte, 32)) || bytes.Equal(envelopeBytes, make([]byte, 32)) {
			return nil, fmt.Errorf("%s contain an invalid slot identity", field)
		}
		if targetKind != awsmcrypto.RecoveryCredentialTarget && targetKind != awsmcrypto.ClientCredentialTarget {
			return nil, fmt.Errorf("%s contain an invalid target kind", field)
		}
		revisionValue, exists := replicaMapEntry(slot, 3)
		if !exists {
			return nil, fmt.Errorf("%s omit a target revision", field)
		}
		var revision *uint64
		if targetKind == awsmcrypto.RecoveryCredentialTarget {
			number, ok := revisionValue.(uint64)
			if !ok {
				return nil, fmt.Errorf("%s contain an invalid Recovery target revision", field)
			}
			revision = &number
		} else if revisionValue != nil {
			return nil, fmt.Errorf("%s contain a non-null Client target revision", field)
		}
		target := fmt.Sprintf("%d:%x:%v", targetKind, targetBytes, revision)
		if _, exists := seenTargets[target]; exists {
			return nil, fmt.Errorf("%s repeat an Envelope target", field)
		}
		seenTargets[target] = struct{}{}
		envelopeID := bytesIdentifier(envelopeBytes)
		if _, exists := seenEnvelopes[envelopeID]; exists {
			return nil, fmt.Errorf("%s repeat an Envelope identity", field)
		}
		seenEnvelopes[envelopeID] = struct{}{}
		result = append(result, keyEpochEnvelopeSlot{
			epochID: bytesIdentifier(epochBytes), targetKind: targetKind, targetID: bytesIdentifier(targetBytes),
			targetRevision: revision, envelopeID: envelopeID,
		})
	}
	return result, nil
}

func validateRecoveryReplacementSlots(state keyEpochReplayState, event canonical.Event, replacement recoveryReplacement) error {
	if len(replacement.keyEpochSlots) != len(state.epochs) {
		return errors.New("Recovery Replacement must provide one Envelope slot for every readable Key Epoch")
	}
	seenEpochs := make(map[canonical.Identifier]struct{}, len(replacement.keyEpochSlots))
	dependencyIDs := make(map[canonical.Identifier]struct{}, len(event.Dependencies))
	for _, dependency := range event.Dependencies {
		if dependency.Type != 7 {
			return errors.New("Recovery Replacement dependencies must be Key Envelopes")
		}
		dependencyIDs[dependency.ID] = struct{}{}
	}
	if len(dependencyIDs) != len(replacement.keyEpochSlots) {
		return errors.New("Recovery Replacement dependencies do not match Envelope slots")
	}
	for _, slot := range replacement.keyEpochSlots {
		if slot.targetKind != awsmcrypto.RecoveryCredentialTarget || slot.targetID != replacement.recoveryID ||
			slot.targetRevision == nil || *slot.targetRevision != replacement.revision {
			return errors.New("Recovery Replacement Envelope slot target is invalid")
		}
		if _, established := state.epochs[slot.epochID]; !established {
			return errors.New("Recovery Replacement Envelope names an unknown Key Epoch")
		}
		if _, duplicate := seenEpochs[slot.epochID]; duplicate {
			return errors.New("Recovery Replacement repeats a Key Epoch slot")
		}
		seenEpochs[slot.epochID] = struct{}{}
		if _, dependency := dependencyIDs[slot.envelopeID]; !dependency {
			return errors.New("Recovery Replacement omits an Envelope dependency")
		}
	}
	for epochID := range state.epochs {
		if _, present := seenEpochs[epochID]; !present {
			return errors.New("Recovery Replacement omits a readable Key Epoch slot")
		}
	}
	authorityParents := canonicalSetValues(identifiersToValues(event.AuthorityParentIDs))
	authorityParentsBytes, err := canonical.EncodeValue(authorityParents)
	if err != nil {
		return errors.New("Recovery Replacement Authority Parents are not canonical")
	}
	transcript, err := canonical.Transcript(
		"awsm:recovery-replacement-possession:v1", event.VaultID[:], replacement.memberID[:],
		authorityParentsBytes, replacement.descriptorBytes, replacement.slotsBytes,
	)
	if err != nil || !ed25519.Verify(replacement.signingKey, transcript, replacement.possessionProof) {
		return errors.New("Recovery Replacement possession proof is invalid")
	}
	return nil
}

func validateClientEnrollment(state keyEpochReplayState, event canonical.Event, enrollment enrollmentCredential) error {
	if len(enrollment.envelopeSlots) != len(state.epochs) {
		return errors.New("Client Enrollment must provide one Envelope slot for every readable Key Epoch")
	}
	seenEpochs := make(map[canonical.Identifier]struct{}, len(enrollment.envelopeSlots))
	dependencyIDs := make(map[canonical.Identifier]struct{}, len(event.Dependencies))
	for _, dependency := range event.Dependencies {
		if dependency.Type != 7 {
			return errors.New("Client Enrollment dependencies must be Key Envelopes")
		}
		dependencyIDs[dependency.ID] = struct{}{}
	}
	if len(dependencyIDs) != len(enrollment.envelopeSlots) {
		return errors.New("Client Enrollment dependencies do not match Envelope slots")
	}
	for _, slot := range enrollment.envelopeSlots {
		if slot.targetKind != awsmcrypto.ClientCredentialTarget || slot.targetID != enrollment.credentialID || slot.targetRevision != nil {
			return errors.New("Client Enrollment Envelope slot target is invalid")
		}
		if _, established := state.epochs[slot.epochID]; !established {
			return errors.New("Client Enrollment Envelope names an unknown Key Epoch")
		}
		if _, duplicate := seenEpochs[slot.epochID]; duplicate {
			return errors.New("Client Enrollment repeats a Key Epoch slot")
		}
		seenEpochs[slot.epochID] = struct{}{}
		if _, dependency := dependencyIDs[slot.envelopeID]; !dependency {
			return errors.New("Client Enrollment omits an Envelope dependency")
		}
	}
	for epochID := range state.epochs {
		if _, present := seenEpochs[epochID]; !present {
			return errors.New("Client Enrollment omits a readable Key Epoch slot")
		}
	}
	proposalTranscript, err := canonical.Transcript("awsm:client-enrollment-proposal:v1", enrollment.proposalPrefixBytes)
	if err != nil || !ed25519.Verify(enrollment.signingPublicKey, proposalTranscript, enrollment.possessionSignature) {
		return errors.New("Client Enrollment possession proof is invalid")
	}
	if enrollment.authorizationKind != 2 {
		return nil
	}
	if enrollment.recoveryCredentialID == nil || len(enrollment.recoveryAuthorization) != ed25519.SignatureSize {
		return errors.New("Client Enrollment recovery authorization is invalid")
	}
	recoveryID := *enrollment.recoveryCredentialID
	memberID, memberOK := state.recoveryMembers[recoveryID]
	if !memberOK || memberID != enrollment.memberID {
		return errors.New("Client Enrollment recovery Credential is not an effective same-member Credential")
	}
	if _, effective := state.recoveryTargets[recoveryID]; !effective {
		return errors.New("Client Enrollment recovery Credential is not effective")
	}
	proposalIDTranscript, err := canonical.Transcript("awsm:client-enrollment-proposal-id:v1", enrollment.proposalBytes)
	if err != nil {
		return errors.New("Client Enrollment proposal identity is invalid")
	}
	proposalID := sha256.Sum256(proposalIDTranscript)
	recoveryTranscript, err := canonical.Transcript("awsm:recovery-client-enrollment-authorization:v1", proposalID[:])
	if err != nil {
		return errors.New("Client Enrollment recovery authorization transcript is invalid")
	}
	recoveryKey := state.recoverySigningKeys[recoveryID]
	if !ed25519.Verify(recoveryKey, recoveryTranscript, enrollment.recoveryAuthorization) {
		return errors.New("Client Enrollment recovery authorization is invalid")
	}
	return nil
}

func sameIdentifierSet(values []canonical.Identifier, expected map[canonical.Identifier]struct{}) bool {
	if len(values) != len(expected) {
		return false
	}
	for _, value := range values {
		if _, ok := expected[value]; !ok {
			return false
		}
	}
	return true
}

func enrollmentAuthorizationKind(event canonical.Event) uint64 {
	body, ok := replicaMapValue(event.Body)
	if !ok {
		return 0
	}
	value, ok := replicaMapEntry(body, 1)
	if !ok {
		return 0
	}
	kind, ok := value.(uint64)
	if !ok {
		return 0
	}
	return kind
}

func lenReplicaMapEntries(value canonical.Value) int {
	switch typed := value.(type) {
	case canonical.Map:
		return len(typed)
	case map[any]any:
		return len(typed)
	default:
		return -1
	}
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
