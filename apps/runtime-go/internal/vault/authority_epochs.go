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
	firstClientCredential    canonical.Identifier
	featureSetID             canonical.Identifier
	featureSetCause          canonical.Identifier
	featureManifests         map[canonical.Identifier]canonical.FeatureManifest
	featureSetConflict       bool
	featureConflictRecords   []canonical.Identifier
	featureConflictManifests []canonical.Identifier
	activeMembers            map[canonical.Identifier]struct{}
	administrators           map[canonical.Identifier]struct{}
	administratorHeads       map[canonical.Identifier]map[canonical.Identifier]bool
	administratorConflicts   map[canonical.Identifier][]administratorConflictCandidate
	clientMembers            map[canonical.Identifier]canonical.Identifier
	epochs                   map[canonical.Identifier]uint64
	epochCauses              map[canonical.Identifier]canonical.Identifier
	heads                    map[canonical.Identifier]struct{}
	headSlots                map[canonical.Identifier][]keyEpochEnvelopeSlot
	keyEpochConflicts        []keyEpochConflictCandidate
	recoveryMembers          map[canonical.Identifier]canonical.Identifier
	recoveryRevisions        map[canonical.Identifier]uint64
	recoverySigningKeys      map[canonical.Identifier]ed25519.PublicKey
	recoveryCauses           map[canonical.Identifier]canonical.Identifier
	recoveryTargets          map[canonical.Identifier]uint64
	recoveryConflicts        map[canonical.Identifier][]recoveryConflictCandidate
	clientTargets            map[canonical.Identifier]struct{}
	deliveredSlots           map[string]struct{}
	members                  map[canonical.Identifier]struct{}
	invitations              map[canonical.Identifier]invitationCreation
	invitationTerminals      map[canonical.Identifier]struct{}
	invitationCandidates     map[canonical.Identifier]map[canonical.Identifier]invitationTerminalCandidate
	invitationConflicts      map[canonical.Identifier]struct{}
	invitationResolutions    map[canonical.Identifier]struct{}
	closed                   bool
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

type recoveryConflictCandidate struct {
	headRecordID         canonical.Identifier
	recoveryCredentialID canonical.Identifier
}

type keyEpochConflictCandidate struct {
	headRecordID canonical.Identifier
	keyEpochID   canonical.Identifier
}

type administratorConflictCandidate struct {
	headRecordID  canonical.Identifier
	administrator bool
}

type keyDelivery struct {
	slots []keyEpochEnvelopeSlot
}

type invitationAcceptance struct {
	invitationID            canonical.Identifier
	joinRequestID           canonical.Identifier
	proposalID              canonical.Identifier
	memberID                canonical.Identifier
	clientCredentialID      canonical.Identifier
	recoveryCredentialID    canonical.Identifier
	recoveryRevision        uint64
	clientSigningKey        ed25519.PublicKey
	recoverySigningKey      ed25519.PublicKey
	clientPossessionProof   []byte
	recoveryPossessionProof []byte
	redemptionProof         []byte
	receiptID               canonical.Identifier
	receiptInvitationID     canonical.Identifier
	receiptOutcome          uint64
	receiptJoinRequestID    canonical.Identifier
	receiptProposalID       canonical.Identifier
	receiptSignature        []byte
	envelopeSlots           []keyEpochEnvelopeSlot
	proposalAuthorityIDs    []canonical.Identifier
	joinRequestPrefixBytes  []byte
	joinRequestBytes        []byte
	proposalBytes           []byte
	receiptPrefixBytes      []byte
	capabilitiesBytes       []byte
	administrator           bool
}

type invitationCreation struct {
	capabilitiesBytes      []byte
	redemptionVerifier     ed25519.PublicKey
	cancellationVerifier   ed25519.PublicKey
	receiptVerificationKey ed25519.PublicKey
}

type invitationCancellation struct {
	invitationID          canonical.Identifier
	authorityChallenge    []byte
	cancellationSignature []byte
	cancellationRequestID canonical.Identifier
	receiptInvitationID   canonical.Identifier
	receiptOutcome        uint64
	receiptRequestID      canonical.Identifier
	receiptID             canonical.Identifier
	receiptSignature      []byte
	receiptPrefixBytes    []byte
	requestBytes          []byte
}

type invitationResolution struct {
	invitationID       canonical.Identifier
	conflictingReceipt []canonical.Identifier
	conflictingRecords []canonical.Identifier
	outcome            uint64
	selectedJoin       *canonical.Identifier
}

type featureActivation struct {
	previousFeatureSetID  canonical.Identifier
	addedManifests        []canonical.FeatureManifest
	resultingFeatureSetID canonical.Identifier
}

type invitationTerminalCandidate struct {
	recordID             canonical.Identifier
	outcome              uint64
	receiptID            canonical.Identifier
	joinRequestID        canonical.Identifier
	memberID             canonical.Identifier
	clientCredentialID   canonical.Identifier
	recoveryCredentialID canonical.Identifier
	administrator        bool
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
		firstClientCredential:  firstClient,
		featureSetID:           genesis.RequiredFeatureSetID,
		featureSetCause:        genesisID,
		featureManifests:       map[canonical.Identifier]canonical.FeatureManifest{},
		activeMembers:          map[canonical.Identifier]struct{}{firstMember: {}},
		members:                map[canonical.Identifier]struct{}{firstMember: {}},
		administrators:         map[canonical.Identifier]struct{}{firstMember: {}},
		administratorHeads:     map[canonical.Identifier]map[canonical.Identifier]bool{firstMember: {genesisID: true}},
		administratorConflicts: map[canonical.Identifier][]administratorConflictCandidate{},
		clientMembers:          map[canonical.Identifier]canonical.Identifier{firstClient: firstMember},
		epochs:                 map[canonical.Identifier]uint64{initialEpoch: 0},
		epochCauses:            map[canonical.Identifier]canonical.Identifier{initialEpoch: genesisID},
		heads:                  map[canonical.Identifier]struct{}{initialEpoch: {}},
		headSlots:              map[canonical.Identifier][]keyEpochEnvelopeSlot{},
		keyEpochConflicts:      []keyEpochConflictCandidate{},
		recoveryMembers:        map[canonical.Identifier]canonical.Identifier{firstRecovery: firstMember},
		recoveryRevisions:      map[canonical.Identifier]uint64{firstRecovery: 0},
		recoverySigningKeys:    map[canonical.Identifier]ed25519.PublicKey{firstRecovery: genesisRecoverySigningKey(genesis)},
		recoveryCauses:         map[canonical.Identifier]canonical.Identifier{firstRecovery: genesisID},
		recoveryTargets:        map[canonical.Identifier]uint64{firstRecovery: 0},
		recoveryConflicts:      map[canonical.Identifier][]recoveryConflictCandidate{},
		clientTargets:          map[canonical.Identifier]struct{}{firstClient: {}},
		deliveredSlots:         map[string]struct{}{},
		invitations:            map[canonical.Identifier]invitationCreation{},
		invitationTerminals:    map[canonical.Identifier]struct{}{},
		invitationCandidates:   map[canonical.Identifier]map[canonical.Identifier]invitationTerminalCandidate{},
		invitationConflicts:    map[canonical.Identifier]struct{}{},
		invitationResolutions:  map[canonical.Identifier]struct{}{},
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
		if current.featureSetConflict {
			delete(visiting, recordID)
			return keyEpochReplayState{}, errors.New("Event descends from a Required Feature Set conflict")
		}
		if event.RequiredFeatureSetID != current.featureSetID {
			delete(visiting, recordID)
			return keyEpochReplayState{}, errors.New("Event Required Feature Set does not match its Authority Parents")
		}
		if event.Family == canonical.ContentFamily {
			if err := validateContentEvent(event); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
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
			delete(current.administratorHeads, targetMember)
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
		if event.Family == canonical.AuthorityFamily && event.Type == 5 {
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Creation signer is not an active Client Credential")
			}
			if _, admin := current.administrators[signerMember]; !admin {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Creation signer is not an Administrator")
			}
			if err := validateInvitationCreation(event, signerMember); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			invitationID, invitationErr := parseInvitationCreationID(event)
			if invitationErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, invitationErr
			}
			if _, exists := current.invitations[invitationID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Creation reuses an Invitation identity")
			}
			creation, creationErr := parseInvitationCreation(event)
			if creationErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, creationErr
			}
			current.invitations[invitationID] = creation
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 6 {
			acceptance, parseErr := parseInvitationAcceptance(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			invitation, exists := current.invitations[acceptance.invitationID]
			if !exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Acceptance references an unknown Invitation")
			}
			if err := validateInvitationAcceptance(current, event, acceptance, invitation); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			if _, exists := current.members[acceptance.memberID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Acceptance reuses a Member identity")
			}
			if _, exists := current.clientMembers[acceptance.clientCredentialID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Acceptance reuses a Client Credential identity")
			}
			if _, exists := current.recoveryMembers[acceptance.recoveryCredentialID]; exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Acceptance reuses a Recovery Credential identity")
			}
			current.members[acceptance.memberID] = struct{}{}
			current.activeMembers[acceptance.memberID] = struct{}{}
			current.clientMembers[acceptance.clientCredentialID] = acceptance.memberID
			current.clientTargets[acceptance.clientCredentialID] = struct{}{}
			current.recoveryMembers[acceptance.recoveryCredentialID] = acceptance.memberID
			current.recoveryRevisions[acceptance.recoveryCredentialID] = acceptance.recoveryRevision
			current.recoverySigningKeys[acceptance.recoveryCredentialID] = append(ed25519.PublicKey(nil), acceptance.recoverySigningKey...)
			current.recoveryCauses[acceptance.recoveryCredentialID] = event.RecordID
			current.recoveryTargets[acceptance.recoveryCredentialID] = acceptance.recoveryRevision
			if acceptance.administrator {
				current.administrators[acceptance.memberID] = struct{}{}
			}
			current.administratorHeads[acceptance.memberID] = map[canonical.Identifier]bool{event.RecordID: acceptance.administrator}
			delete(current.invitations, acceptance.invitationID)
			current.invitationTerminals[acceptance.invitationID] = struct{}{}
			candidates := current.invitationCandidates[acceptance.invitationID]
			if candidates == nil {
				candidates = make(map[canonical.Identifier]invitationTerminalCandidate)
				current.invitationCandidates[acceptance.invitationID] = candidates
			}
			candidates[event.RecordID] = invitationTerminalCandidate{
				recordID: event.RecordID, outcome: 1, receiptID: acceptance.receiptID, joinRequestID: acceptance.joinRequestID, memberID: acceptance.memberID,
				clientCredentialID: acceptance.clientCredentialID, recoveryCredentialID: acceptance.recoveryCredentialID,
				administrator: acceptance.administrator,
			}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 7 {
			cancellation, parseErr := parseInvitationCancellation(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			invitation, exists := current.invitations[cancellation.invitationID]
			if !exists {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Cancellation references an unknown Invitation")
			}
			if err := validateInvitationCancellation(cancellation, invitation); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			delete(current.invitations, cancellation.invitationID)
			current.invitationTerminals[cancellation.invitationID] = struct{}{}
			candidates := current.invitationCandidates[cancellation.invitationID]
			if candidates == nil {
				candidates = make(map[canonical.Identifier]invitationTerminalCandidate)
				current.invitationCandidates[cancellation.invitationID] = candidates
			}
			candidates[event.RecordID] = invitationTerminalCandidate{recordID: event.RecordID, outcome: 2, receiptID: cancellation.receiptID}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 8 {
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Conflict Resolution signer is not an active Client Credential")
			}
			if _, administrator := current.administrators[signerMember]; !administrator {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Invitation Conflict Resolution signer is not an Administrator")
			}
			resolution, parseErr := parseInvitationResolution(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			selected, validateErr := validateInvitationResolution(current, resolution)
			if validateErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, validateErr
			}
			for _, candidate := range current.invitationCandidates[resolution.invitationID] {
				if candidate.outcome != 1 {
					continue
				}
				delete(current.activeMembers, candidate.memberID)
				delete(current.administrators, candidate.memberID)
				delete(current.clientTargets, candidate.clientCredentialID)
				delete(current.recoveryTargets, candidate.recoveryCredentialID)
			}
			if resolution.outcome == 1 {
				current.activeMembers[selected.memberID] = struct{}{}
				current.clientTargets[selected.clientCredentialID] = struct{}{}
				current.recoveryTargets[selected.recoveryCredentialID] = current.recoveryRevisions[selected.recoveryCredentialID]
				if selected.administrator {
					current.administrators[selected.memberID] = struct{}{}
				}
			}
			delete(current.invitationConflicts, resolution.invitationID)
			current.invitationResolutions[resolution.invitationID] = struct{}{}
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
			if _, active := current.activeMembers[targetMember]; !active {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Administrator role target is not an active Member")
			}
			conflict, hasConflict := current.administratorConflicts[targetMember]
			if hasConflict {
				expected := make(map[canonical.Identifier]struct{}, len(conflict))
				for _, candidate := range conflict {
					expected[candidate.headRecordID] = struct{}{}
				}
				if !sameIdentifierSet(resolved, expected) {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Administrator role resolution does not name every candidate")
				}
			} else if len(resolved) != 0 {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Ordinary Administrator role change cannot resolve Record IDs")
			}
			_, alreadyAdmin := current.administrators[targetMember]
			if event.Type == 3 {
				if !hasConflict && alreadyAdmin {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Administrator Grant target is already an Administrator")
				}
				current.administrators[targetMember] = struct{}{}
			} else {
				if !hasConflict && !alreadyAdmin {
					delete(visiting, recordID)
					return keyEpochReplayState{}, errors.New("Administrator End target is not an Administrator")
				}
				delete(current.administrators, targetMember)
			}
			current.administratorHeads[targetMember] = map[canonical.Identifier]bool{event.RecordID: event.Type == 3}
			if len(current.administrators) == 0 {
				current.closed = true
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
			current.recoveryCauses[replacement.recoveryID] = event.RecordID
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
			current.epochCauses[transition.newEpochID] = event.RecordID
			current.headSlots[transition.newEpochID] = cloneKeyEpochEnvelopeSlots(transition.slots)
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 13 {
			delivery, parseErr := parseKeyDelivery(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			if err := validateKeyDelivery(current, event, delivery); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			for _, slot := range delivery.slots {
				current.deliveredSlots[keyDeliverySlotKey(slot)] = struct{}{}
			}
		}
		if event.Family == canonical.AuthorityFamily && event.Type == 14 {
			signerMember, signerOK := current.activeClientMember(event.SignerCredentialID)
			if !signerOK {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Feature Activation signer is not an active Client Credential")
			}
			if _, administrator := current.administrators[signerMember]; !administrator {
				delete(visiting, recordID)
				return keyEpochReplayState{}, errors.New("Feature Activation signer is not an Administrator")
			}
			activation, parseErr := parseFeatureActivation(event)
			if parseErr != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, parseErr
			}
			if err := validateFeatureActivation(current, event, activation); err != nil {
				delete(visiting, recordID)
				return keyEpochReplayState{}, err
			}
			for _, manifest := range activation.addedManifests {
				current.featureManifests[manifest.ID] = cloneFeatureManifest(manifest)
			}
			current.featureSetID = activation.resultingFeatureSetID
			current.featureSetCause = event.RecordID
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
		deriveAdministratorConflicts(&current)
		deriveKeyEpochConflicts(&current)
		deriveRecoveryConflicts(&current)
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
	}
	for _, event := range events {
		if event.RecordID == genesisID {
			continue
		}
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
		firstClientCredential:    value.firstClientCredential,
		featureSetID:             value.featureSetID,
		featureSetCause:          value.featureSetCause,
		featureManifests:         make(map[canonical.Identifier]canonical.FeatureManifest, len(value.featureManifests)),
		featureSetConflict:       value.featureSetConflict,
		featureConflictRecords:   append([]canonical.Identifier(nil), value.featureConflictRecords...),
		featureConflictManifests: append([]canonical.Identifier(nil), value.featureConflictManifests...),
		activeMembers:            make(map[canonical.Identifier]struct{}, len(value.activeMembers)),
		members:                  make(map[canonical.Identifier]struct{}, len(value.members)),
		administrators:           make(map[canonical.Identifier]struct{}, len(value.administrators)),
		administratorHeads:       make(map[canonical.Identifier]map[canonical.Identifier]bool, len(value.administratorHeads)),
		administratorConflicts:   make(map[canonical.Identifier][]administratorConflictCandidate, len(value.administratorConflicts)),
		clientMembers:            make(map[canonical.Identifier]canonical.Identifier, len(value.clientMembers)),
		epochs:                   make(map[canonical.Identifier]uint64, len(value.epochs)),
		epochCauses:              make(map[canonical.Identifier]canonical.Identifier, len(value.epochCauses)),
		heads:                    make(map[canonical.Identifier]struct{}, len(value.heads)),
		headSlots:                make(map[canonical.Identifier][]keyEpochEnvelopeSlot, len(value.headSlots)),
		keyEpochConflicts:        append([]keyEpochConflictCandidate(nil), value.keyEpochConflicts...),
		recoveryMembers:          make(map[canonical.Identifier]canonical.Identifier, len(value.recoveryMembers)),
		recoveryRevisions:        make(map[canonical.Identifier]uint64, len(value.recoveryRevisions)),
		recoverySigningKeys:      make(map[canonical.Identifier]ed25519.PublicKey, len(value.recoverySigningKeys)),
		recoveryCauses:           make(map[canonical.Identifier]canonical.Identifier, len(value.recoveryCauses)),
		recoveryTargets:          make(map[canonical.Identifier]uint64, len(value.recoveryTargets)),
		recoveryConflicts:        make(map[canonical.Identifier][]recoveryConflictCandidate, len(value.recoveryConflicts)),
		clientTargets:            make(map[canonical.Identifier]struct{}, len(value.clientTargets)),
		deliveredSlots:           make(map[string]struct{}, len(value.deliveredSlots)),
		invitations:              make(map[canonical.Identifier]invitationCreation, len(value.invitations)),
		invitationTerminals:      make(map[canonical.Identifier]struct{}, len(value.invitationTerminals)),
		invitationCandidates:     make(map[canonical.Identifier]map[canonical.Identifier]invitationTerminalCandidate, len(value.invitationCandidates)),
		invitationConflicts:      make(map[canonical.Identifier]struct{}, len(value.invitationConflicts)),
		invitationResolutions:    make(map[canonical.Identifier]struct{}, len(value.invitationResolutions)),
		closed:                   value.closed,
	}
	for id, manifest := range value.featureManifests {
		clone.featureManifests[id] = cloneFeatureManifest(manifest)
	}
	for id := range value.activeMembers {
		clone.activeMembers[id] = struct{}{}
	}
	for id := range value.members {
		clone.members[id] = struct{}{}
	}
	for id := range value.administrators {
		clone.administrators[id] = struct{}{}
	}
	for memberID, heads := range value.administratorHeads {
		clone.administratorHeads[memberID] = make(map[canonical.Identifier]bool, len(heads))
		for recordID, administrator := range heads {
			clone.administratorHeads[memberID][recordID] = administrator
		}
	}
	for memberID, candidates := range value.administratorConflicts {
		clone.administratorConflicts[memberID] = append([]administratorConflictCandidate(nil), candidates...)
	}
	for credentialID, memberID := range value.clientMembers {
		clone.clientMembers[credentialID] = memberID
	}
	for id, display := range value.epochs {
		clone.epochs[id] = display
	}
	for id, causeID := range value.epochCauses {
		clone.epochCauses[id] = causeID
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
	for credentialID, causeID := range value.recoveryCauses {
		clone.recoveryCauses[credentialID] = causeID
	}
	for memberID, candidates := range value.recoveryConflicts {
		clone.recoveryConflicts[memberID] = append([]recoveryConflictCandidate(nil), candidates...)
	}
	for id := range value.clientTargets {
		clone.clientTargets[id] = struct{}{}
	}
	for key := range value.deliveredSlots {
		clone.deliveredSlots[key] = struct{}{}
	}
	for id, invitation := range value.invitations {
		clone.invitations[id] = cloneInvitationCreation(invitation)
	}
	for id := range value.invitationTerminals {
		clone.invitationTerminals[id] = struct{}{}
	}
	for invitationID, candidates := range value.invitationCandidates {
		clone.invitationCandidates[invitationID] = make(map[canonical.Identifier]invitationTerminalCandidate, len(candidates))
		for recordID, candidate := range candidates {
			clone.invitationCandidates[invitationID][recordID] = candidate
		}
	}
	for invitationID := range value.invitationConflicts {
		clone.invitationConflicts[invitationID] = struct{}{}
	}
	for invitationID := range value.invitationResolutions {
		clone.invitationResolutions[invitationID] = struct{}{}
	}
	return clone
}

func mergeKeyEpochReplayStates(values []keyEpochReplayState) keyEpochReplayState {
	if len(values) == 0 {
		return keyEpochReplayState{
			featureManifests:       make(map[canonical.Identifier]canonical.FeatureManifest),
			activeMembers:          make(map[canonical.Identifier]struct{}),
			members:                make(map[canonical.Identifier]struct{}),
			administrators:         make(map[canonical.Identifier]struct{}),
			administratorHeads:     make(map[canonical.Identifier]map[canonical.Identifier]bool),
			administratorConflicts: make(map[canonical.Identifier][]administratorConflictCandidate),
			clientMembers:          make(map[canonical.Identifier]canonical.Identifier),
			epochs:                 make(map[canonical.Identifier]uint64),
			epochCauses:            make(map[canonical.Identifier]canonical.Identifier),
			heads:                  make(map[canonical.Identifier]struct{}),
			headSlots:              make(map[canonical.Identifier][]keyEpochEnvelopeSlot),
			keyEpochConflicts:      []keyEpochConflictCandidate{},
			recoveryMembers:        make(map[canonical.Identifier]canonical.Identifier),
			recoveryRevisions:      make(map[canonical.Identifier]uint64),
			recoverySigningKeys:    make(map[canonical.Identifier]ed25519.PublicKey),
			recoveryCauses:         make(map[canonical.Identifier]canonical.Identifier),
			recoveryTargets:        make(map[canonical.Identifier]uint64),
			recoveryConflicts:      make(map[canonical.Identifier][]recoveryConflictCandidate),
			clientTargets:          make(map[canonical.Identifier]struct{}),
			deliveredSlots:         make(map[string]struct{}),
			invitations:            make(map[canonical.Identifier]invitationCreation),
			invitationTerminals:    make(map[canonical.Identifier]struct{}),
			invitationCandidates:   make(map[canonical.Identifier]map[canonical.Identifier]invitationTerminalCandidate),
			invitationConflicts:    make(map[canonical.Identifier]struct{}),
			invitationResolutions:  make(map[canonical.Identifier]struct{}),
		}
	}
	merged := cloneKeyEpochReplayState(values[0])
	for _, value := range values[1:] {
		for id := range value.activeMembers {
			merged.activeMembers[id] = struct{}{}
		}
		if merged.featureSetID != value.featureSetID {
			merged.featureSetConflict = true
			merged.featureConflictRecords = append(merged.featureConflictRecords, merged.featureSetCause, value.featureSetCause)
			for manifestID := range merged.featureManifests {
				merged.featureConflictManifests = append(merged.featureConflictManifests, manifestID)
			}
			for manifestID := range value.featureManifests {
				merged.featureConflictManifests = append(merged.featureConflictManifests, manifestID)
			}
		}
		if value.featureSetConflict {
			merged.featureSetConflict = true
			merged.featureConflictRecords = append(merged.featureConflictRecords, value.featureConflictRecords...)
			merged.featureConflictManifests = append(merged.featureConflictManifests, value.featureConflictManifests...)
		}
		for id, manifest := range value.featureManifests {
			if existing, exists := merged.featureManifests[id]; !exists {
				merged.featureManifests[id] = cloneFeatureManifest(manifest)
			} else if !bytes.Equal(existing.Bytes, manifest.Bytes) {
				merged.featureSetConflict = true
			}
		}
		for id := range value.members {
			merged.members[id] = struct{}{}
		}
		for id := range value.administrators {
			merged.administrators[id] = struct{}{}
		}
		for memberID, heads := range value.administratorHeads {
			mergedHeads := merged.administratorHeads[memberID]
			if mergedHeads == nil {
				mergedHeads = make(map[canonical.Identifier]bool, len(heads))
				merged.administratorHeads[memberID] = mergedHeads
			}
			for recordID, administrator := range heads {
				mergedHeads[recordID] = administrator
			}
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
		for id, causeID := range value.epochCauses {
			if _, exists := merged.epochCauses[id]; !exists {
				merged.epochCauses[id] = causeID
			}
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
		for credentialID, causeID := range value.recoveryCauses {
			if _, exists := merged.recoveryCauses[credentialID]; !exists {
				merged.recoveryCauses[credentialID] = causeID
			}
		}
		for id := range value.clientTargets {
			merged.clientTargets[id] = struct{}{}
		}
		for key := range value.deliveredSlots {
			merged.deliveredSlots[key] = struct{}{}
		}
		for id, invitation := range value.invitations {
			if existing, exists := merged.invitations[id]; !exists {
				merged.invitations[id] = cloneInvitationCreation(invitation)
			} else if !bytes.Equal(existing.capabilitiesBytes, invitation.capabilitiesBytes) {
				delete(merged.invitations, id)
				merged.invitationTerminals[id] = struct{}{}
			}
		}
		for id := range value.invitationTerminals {
			delete(merged.invitations, id)
			merged.invitationTerminals[id] = struct{}{}
		}
		for invitationID, candidates := range value.invitationCandidates {
			mergedCandidates := merged.invitationCandidates[invitationID]
			if mergedCandidates == nil {
				mergedCandidates = make(map[canonical.Identifier]invitationTerminalCandidate, len(candidates))
				merged.invitationCandidates[invitationID] = mergedCandidates
			}
			for recordID, candidate := range candidates {
				mergedCandidates[recordID] = candidate
			}
		}
		for invitationID := range value.invitationConflicts {
			merged.invitationConflicts[invitationID] = struct{}{}
		}
		for invitationID := range value.invitationResolutions {
			merged.invitationResolutions[invitationID] = struct{}{}
		}
		merged.closed = merged.closed || value.closed
	}
	merged.featureConflictRecords = uniqueSortedIdentifiers(merged.featureConflictRecords)
	merged.featureConflictManifests = uniqueSortedIdentifiers(merged.featureConflictManifests)
	deriveAdministratorConflicts(&merged)
	deriveKeyEpochConflicts(&merged)
	deriveRecoveryConflicts(&merged)
	reduceInvitationConflicts(&merged)
	return merged
}

func deriveRecoveryConflicts(state *keyEpochReplayState) {
	if state == nil {
		return
	}
	state.recoveryConflicts = make(map[canonical.Identifier][]recoveryConflictCandidate)
	byMember := make(map[canonical.Identifier][]recoveryConflictCandidate)
	for recoveryID := range state.recoveryTargets {
		memberID, memberOK := state.recoveryMembers[recoveryID]
		causeID, causeOK := state.recoveryCauses[recoveryID]
		if !memberOK || !causeOK {
			continue
		}
		byMember[memberID] = append(byMember[memberID], recoveryConflictCandidate{
			headRecordID: causeID, recoveryCredentialID: recoveryID,
		})
	}
	for memberID, candidates := range byMember {
		if len(candidates) < 2 {
			continue
		}
		sort.Slice(candidates, func(left, right int) bool {
			if candidates[left].headRecordID != candidates[right].headRecordID {
				return bytes.Compare(candidates[left].headRecordID[:], candidates[right].headRecordID[:]) < 0
			}
			return bytes.Compare(candidates[left].recoveryCredentialID[:], candidates[right].recoveryCredentialID[:]) < 0
		})
		state.recoveryConflicts[memberID] = candidates
	}
}

func deriveAdministratorConflicts(state *keyEpochReplayState) {
	if state == nil {
		return
	}
	state.administratorConflicts = make(map[canonical.Identifier][]administratorConflictCandidate)
	for memberID, heads := range state.administratorHeads {
		if _, active := state.activeMembers[memberID]; !active {
			delete(state.administrators, memberID)
			continue
		}
		candidates := make([]administratorConflictCandidate, 0, len(heads))
		anyAdmin := false
		anyNonAdmin := false
		for recordID, administrator := range heads {
			candidates = append(candidates, administratorConflictCandidate{headRecordID: recordID, administrator: administrator})
			if administrator {
				anyAdmin = true
			} else {
				anyNonAdmin = true
			}
		}
		if anyAdmin && anyNonAdmin {
			sort.Slice(candidates, func(left, right int) bool {
				return bytes.Compare(candidates[left].headRecordID[:], candidates[right].headRecordID[:]) < 0
			})
			state.administratorConflicts[memberID] = candidates
			delete(state.administrators, memberID)
			continue
		}
		if anyAdmin {
			state.administrators[memberID] = struct{}{}
		} else {
			delete(state.administrators, memberID)
		}
	}
}

func uniqueSortedIdentifiers(values []canonical.Identifier) []canonical.Identifier {
	if len(values) == 0 {
		return nil
	}
	sort.Slice(values, func(left, right int) bool {
		return bytes.Compare(values[left][:], values[right][:]) < 0
	})
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}

func deriveKeyEpochConflicts(state *keyEpochReplayState) {
	if state == nil {
		return
	}
	state.keyEpochConflicts = nil
	if len(state.heads) < 2 {
		return
	}
	for epochID := range state.heads {
		causeID, ok := state.epochCauses[epochID]
		if !ok {
			continue
		}
		state.keyEpochConflicts = append(state.keyEpochConflicts, keyEpochConflictCandidate{
			headRecordID: causeID, keyEpochID: epochID,
		})
	}
	sort.Slice(state.keyEpochConflicts, func(left, right int) bool {
		if state.keyEpochConflicts[left].headRecordID != state.keyEpochConflicts[right].headRecordID {
			return bytes.Compare(state.keyEpochConflicts[left].headRecordID[:], state.keyEpochConflicts[right].headRecordID[:]) < 0
		}
		return bytes.Compare(state.keyEpochConflicts[left].keyEpochID[:], state.keyEpochConflicts[right].keyEpochID[:]) < 0
	})
}

func reduceInvitationConflicts(state *keyEpochReplayState) {
	if state == nil {
		return
	}
	for invitationID, candidates := range state.invitationCandidates {
		if _, resolved := state.invitationResolutions[invitationID]; resolved {
			delete(state.invitationConflicts, invitationID)
			continue
		}
		outcomes := make(map[string]struct{}, len(candidates))
		for _, candidate := range candidates {
			if candidate.outcome == 1 {
				outcomes[fmt.Sprintf("1:%x:%x", candidate.joinRequestID, candidate.memberID)] = struct{}{}
			} else {
				outcomes["2"] = struct{}{}
			}
		}
		if len(outcomes) <= 1 {
			continue
		}
		state.invitationConflicts[invitationID] = struct{}{}
		for _, candidate := range candidates {
			if candidate.outcome != 1 {
				continue
			}
			delete(state.activeMembers, candidate.memberID)
			delete(state.administrators, candidate.memberID)
			delete(state.clientTargets, candidate.clientCredentialID)
			delete(state.recoveryTargets, candidate.recoveryCredentialID)
		}
	}
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

func validateInvitationCreation(event canonical.Event, signerMember canonical.Identifier) error {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 6) {
		return errors.New("Invitation Creation body is invalid")
	}
	invitationID, invitationOK := replicaMapBytes(body, 0, 32)
	redemptionVerifier, redemptionOK := replicaMapBytes(body, 2, 32)
	cancellationVerifier, cancellationOK := replicaMapBytes(body, 3, 32)
	redemptionAuthority, authorityOK := replicaMapBytes(body, 4, 32)
	receiptKey, receiptOK := replicaMapBytes(body, 5, 32)
	if !invitationOK || !redemptionOK || !cancellationOK || !authorityOK || !receiptOK ||
		bytes.Equal(invitationID, make([]byte, 32)) || bytes.Equal(redemptionVerifier, make([]byte, 32)) ||
		bytes.Equal(cancellationVerifier, make([]byte, 32)) || bytes.Equal(redemptionAuthority, make([]byte, 32)) ||
		bytes.Equal(receiptKey, make([]byte, 32)) {
		return errors.New("Invitation Creation identity fields are invalid")
	}
	capabilityValue, ok := replicaMapEntry(body, 1)
	if !ok {
		return errors.New("Invitation Creation capabilities are missing")
	}
	capabilities, ok := replicaMapArrayValue(capabilityValue)
	if !ok || len(capabilities) == 0 {
		return errors.New("Invitation Creation capabilities are invalid")
	}
	var previous []byte
	seen := make(map[string]struct{}, len(capabilities))
	for _, capabilityValue := range capabilities {
		encoded, err := canonical.EncodeValue(capabilityValue)
		if err != nil {
			return errors.New("Invitation Creation capability is not canonical")
		}
		if previous != nil && bytes.Compare(previous, encoded) >= 0 {
			return errors.New("Invitation Creation capabilities are not a canonical set")
		}
		previous = encoded
		key := string(encoded)
		if _, duplicate := seen[key]; duplicate {
			return errors.New("Invitation Creation capabilities contain a duplicate")
		}
		seen[key] = struct{}{}
		capability, ok := replicaMapValue(capabilityValue)
		if !ok || !replicaMapHasKeys(capability, 5) {
			return errors.New("Invitation Creation capability descriptor is invalid")
		}
		domain, domainOK := replicaMapEntry(capability, 0)
		issuer, issuerOK := replicaMapBytes(capability, 1, 32)
		targetVault, targetOK := replicaMapBytes(capability, 2, 32)
		action, actionOK := replicaMapEntry(capability, 3)
		parameters, parametersOK := replicaMapEntry(capability, 4)
		domainText, domainTextOK := domain.(string)
		actionText, actionTextOK := action.(string)
		_, parameterBytesOK := parameters.([]byte)
		if !domainOK || !issuerOK || !targetOK || !actionOK || !parametersOK || !domainTextOK || !actionTextOK || !parameterBytesOK ||
			!bytes.Equal(issuer, signerMember[:]) || !bytes.Equal(targetVault, event.VaultID[:]) || domainText != "awsm.vault" ||
			(actionText != "awsm.vault.join" && actionText != "awsm.vault.administrator") {
			return errors.New("Invitation Creation capability is not authorized by the signing Administrator")
		}
	}
	return nil
}

func parseInvitationCreationID(event canonical.Event) (canonical.Identifier, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 6) {
		return canonical.Identifier{}, errors.New("Invitation Creation body is invalid")
	}
	invitationBytes, ok := replicaMapBytes(body, 0, 32)
	if !ok || bytes.Equal(invitationBytes, make([]byte, 32)) {
		return canonical.Identifier{}, errors.New("Invitation Creation identity fields are invalid")
	}
	return bytesIdentifier(invitationBytes), nil
}

func parseInvitationCreation(event canonical.Event) (invitationCreation, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 6) {
		return invitationCreation{}, errors.New("Invitation Creation body is invalid")
	}
	capabilities, ok := replicaMapEntry(body, 1)
	if !ok {
		return invitationCreation{}, errors.New("Invitation Creation capabilities are missing")
	}
	capabilitiesBytes, err := canonical.EncodeValue(capabilities)
	if err != nil {
		return invitationCreation{}, errors.New("Invitation Creation capabilities are not canonical")
	}
	redemptionVerifier, ok := replicaMapBytes(body, 2, ed25519.PublicKeySize)
	if !ok {
		return invitationCreation{}, errors.New("Invitation Redemption verifier is invalid")
	}
	cancellationVerifier, ok := replicaMapBytes(body, 3, ed25519.PublicKeySize)
	if !ok {
		return invitationCreation{}, errors.New("Invitation Cancellation verifier is invalid")
	}
	receiptVerificationKey, ok := replicaMapBytes(body, 5, ed25519.PublicKeySize)
	if !ok {
		return invitationCreation{}, errors.New("Invitation receipt verification key is invalid")
	}
	return invitationCreation{
		capabilitiesBytes:      append([]byte(nil), capabilitiesBytes...),
		redemptionVerifier:     append(ed25519.PublicKey(nil), redemptionVerifier...),
		cancellationVerifier:   append(ed25519.PublicKey(nil), cancellationVerifier...),
		receiptVerificationKey: append(ed25519.PublicKey(nil), receiptVerificationKey...),
	}, nil
}

func cloneInvitationCreation(value invitationCreation) invitationCreation {
	return invitationCreation{
		capabilitiesBytes:      append([]byte(nil), value.capabilitiesBytes...),
		redemptionVerifier:     append(ed25519.PublicKey(nil), value.redemptionVerifier...),
		cancellationVerifier:   append(ed25519.PublicKey(nil), value.cancellationVerifier...),
		receiptVerificationKey: append(ed25519.PublicKey(nil), value.receiptVerificationKey...),
	}
}

func validateInvitationAcceptance(state keyEpochReplayState, event canonical.Event, acceptance invitationAcceptance, invitation invitationCreation) error {
	if !bytes.Equal(invitation.capabilitiesBytes, acceptance.capabilitiesBytes) {
		return errors.New("Invitation Acceptance capabilities differ from the Invitation")
	}
	if !sameIdentifierSlice(acceptance.proposalAuthorityIDs, event.AuthorityParentIDs) {
		return errors.New("Invitation Acceptance Authority Parents differ from its Proposal")
	}
	if acceptance.receiptInvitationID != acceptance.invitationID || acceptance.receiptOutcome != 1 ||
		acceptance.receiptJoinRequestID != acceptance.joinRequestID || acceptance.receiptProposalID != acceptance.proposalID {
		return errors.New("Invitation Acceptance receipt does not match its request")
	}
	joinTranscript, err := canonical.Transcript("awsm:invitation-join-request:v1", acceptance.joinRequestPrefixBytes)
	if err != nil || !ed25519.Verify(acceptance.clientSigningKey, joinTranscript, acceptance.clientPossessionProof) ||
		!ed25519.Verify(acceptance.recoverySigningKey, joinTranscript, acceptance.recoveryPossessionProof) ||
		!ed25519.Verify(invitation.redemptionVerifier, joinTranscript, acceptance.redemptionProof) {
		return errors.New("Invitation Acceptance possession or redemption proof is invalid")
	}
	receiptTranscript, err := canonical.Transcript("awsm:invitation-receipt:v1", acceptance.receiptPrefixBytes)
	if err != nil || !ed25519.Verify(invitation.receiptVerificationKey, receiptTranscript, acceptance.receiptSignature) {
		return errors.New("Invitation Acceptance receipt signature is invalid")
	}
	if err := validateInvitationAcceptanceSlots(state, acceptance, event); err != nil {
		return err
	}
	return nil
}

func validateInvitationAcceptanceSlots(state keyEpochReplayState, acceptance invitationAcceptance, event canonical.Event) error {
	dependencyIDs := make(map[canonical.Identifier]struct{}, len(event.Dependencies))
	for _, dependency := range event.Dependencies {
		if dependency.Type != 7 {
			return errors.New("Invitation Acceptance dependencies must be Key Envelopes")
		}
		dependencyIDs[dependency.ID] = struct{}{}
	}
	if len(dependencyIDs) != len(acceptance.envelopeSlots) {
		return errors.New("Invitation Acceptance dependencies do not match Envelope slots")
	}
	seen := make(map[string]struct{}, len(acceptance.envelopeSlots))
	for _, slot := range acceptance.envelopeSlots {
		if _, established := state.epochs[slot.epochID]; !established {
			return errors.New("Invitation Acceptance Envelope slot names an unknown Key Epoch")
		}
		if _, dependency := dependencyIDs[slot.envelopeID]; !dependency {
			return errors.New("Invitation Acceptance omits an Envelope dependency")
		}
		var target string
		switch slot.targetKind {
		case awsmcrypto.RecoveryCredentialTarget:
			if slot.targetID != acceptance.recoveryCredentialID || slot.targetRevision == nil || *slot.targetRevision != acceptance.recoveryRevision {
				return errors.New("Invitation Acceptance Recovery Envelope target is invalid")
			}
			target = fmt.Sprintf("%d:%x:%d", slot.targetKind, slot.targetID, *slot.targetRevision)
		case awsmcrypto.ClientCredentialTarget:
			if slot.targetID != acceptance.clientCredentialID || slot.targetRevision != nil {
				return errors.New("Invitation Acceptance Client Envelope target is invalid")
			}
			target = fmt.Sprintf("%d:%x:null", slot.targetKind, slot.targetID)
		default:
			return errors.New("Invitation Acceptance Envelope target kind is invalid")
		}
		key := fmt.Sprintf("%s:%x", target, slot.epochID)
		if _, duplicate := seen[key]; duplicate {
			return errors.New("Invitation Acceptance repeats an Envelope target")
		}
		seen[key] = struct{}{}
	}
	expected := len(state.epochs) * 2
	if len(seen) != expected {
		return errors.New("Invitation Acceptance Envelope slots are not the complete target set")
	}
	for epochID := range state.epochs {
		for _, target := range []string{
			fmt.Sprintf("%d:%x:%d:%x", awsmcrypto.RecoveryCredentialTarget, acceptance.recoveryCredentialID, acceptance.recoveryRevision, epochID),
			fmt.Sprintf("%d:%x:null:%x", awsmcrypto.ClientCredentialTarget, acceptance.clientCredentialID, epochID),
		} {
			if _, present := seen[target]; !present {
				return errors.New("Invitation Acceptance Envelope slots omit a readable Key Epoch")
			}
		}
	}
	return nil
}

func parseInvitationCancellation(event canonical.Event) (invitationCancellation, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 2) {
		return invitationCancellation{}, errors.New("Invitation Cancellation body is invalid")
	}
	requestValue := replicaMapEntryMust(body, 0)
	request, ok := replicaMapValue(requestValue)
	if !ok || !replicaMapHasKeys(request, 3) {
		return invitationCancellation{}, errors.New("Invitation Cancellation Request is invalid")
	}
	receiptValue := replicaMapEntryMust(body, 1)
	receipt, ok := replicaMapValue(receiptValue)
	if !ok || !replicaMapHasKeys(receipt, 6) {
		return invitationCancellation{}, errors.New("Cancelled Invitation receipt is invalid")
	}
	invitationBytes, invitationOK := replicaMapBytes(request, 0, 32)
	challenge, challengeOK := replicaMapBytes(request, 1, 32)
	cancellationSignature, signatureOK := replicaMapBytes(request, 2, ed25519.SignatureSize)
	receiptInvitationBytes, receiptInvitationOK := replicaMapBytes(receipt, 0, 32)
	receiptOutcome, receiptOutcomeOK := replicaMapNumber(receipt, 1)
	receiptRequestBytes, receiptRequestOK := replicaMapBytes(receipt, 2, 32)
	receiptReceiptBytes, receiptIDOK := replicaMapBytes(receipt, 4, 32)
	receiptSignature, receiptSignatureOK := replicaMapBytes(receipt, 5, ed25519.SignatureSize)
	receiptProposal, receiptProposalOK := replicaMapEntry(receipt, 3)
	if !invitationOK || !challengeOK || !signatureOK || !receiptInvitationOK || !receiptOutcomeOK || !receiptRequestOK || !receiptIDOK || !receiptSignatureOK || receiptProposal != nil || !receiptProposalOK || bytes.Equal(invitationBytes, make([]byte, 32)) || bytes.Equal(receiptInvitationBytes, make([]byte, 32)) || bytes.Equal(receiptRequestBytes, make([]byte, 32)) || bytes.Equal(receiptReceiptBytes, make([]byte, 32)) || receiptOutcome != 2 {
		return invitationCancellation{}, errors.New("Invitation Cancellation identity or receipt fields are invalid")
	}
	requestBytes, err := canonical.EncodeValue(requestValue)
	if err != nil {
		return invitationCancellation{}, errors.New("Invitation Cancellation Request is not canonical")
	}
	requestIDTranscript, err := canonical.Transcript("awsm:invitation-cancel-request-id:v1", requestBytes)
	if err != nil {
		return invitationCancellation{}, errors.New("Invitation Cancellation Request identity is invalid")
	}
	requestID := sha256.Sum256(requestIDTranscript)
	if !bytes.Equal(requestID[:], receiptRequestBytes) {
		return invitationCancellation{}, errors.New("Cancelled Invitation receipt does not name its Request")
	}
	receiptPrefix := canonical.Map{}
	for key := uint64(0); key < 5; key++ {
		value, exists := replicaMapEntry(receipt, key)
		if !exists {
			return invitationCancellation{}, errors.New("Invitation Cancellation receipt prefix is incomplete")
		}
		receiptPrefix[key] = value
	}
	receiptPrefixBytes, err := canonical.EncodeValue(receiptPrefix)
	if err != nil {
		return invitationCancellation{}, errors.New("Invitation Cancellation receipt prefix is not canonical")
	}
	return invitationCancellation{
		invitationID:          bytesIdentifier(invitationBytes),
		authorityChallenge:    append([]byte(nil), challenge...),
		cancellationSignature: append([]byte(nil), cancellationSignature...),
		cancellationRequestID: requestID,
		receiptInvitationID:   bytesIdentifier(receiptInvitationBytes),
		receiptOutcome:        receiptOutcome,
		receiptRequestID:      bytesIdentifier(receiptRequestBytes),
		receiptID:             bytesIdentifier(receiptReceiptBytes),
		receiptSignature:      append([]byte(nil), receiptSignature...),
		receiptPrefixBytes:    receiptPrefixBytes,
		requestBytes:          requestBytes,
	}, nil
}

func validateInvitationCancellation(cancellation invitationCancellation, invitation invitationCreation) error {
	if cancellation.receiptInvitationID != cancellation.invitationID || cancellation.receiptRequestID != cancellation.cancellationRequestID {
		return errors.New("Invitation Cancellation receipt does not match its Request")
	}
	requestTranscript, err := canonical.Transcript("awsm:invitation-cancel-request:v1", cancellation.invitationID[:], cancellation.authorityChallenge)
	if err != nil || !ed25519.Verify(invitation.cancellationVerifier, requestTranscript, cancellation.cancellationSignature) {
		return errors.New("Invitation Cancellation proof is invalid")
	}
	receiptTranscript, err := canonical.Transcript("awsm:invitation-receipt:v1", cancellation.receiptPrefixBytes)
	if err != nil || !ed25519.Verify(invitation.receiptVerificationKey, receiptTranscript, cancellation.receiptSignature) {
		return errors.New("Invitation Cancellation receipt signature is invalid")
	}
	return nil
}

func parseInvitationResolution(event canonical.Event) (invitationResolution, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 5) {
		return invitationResolution{}, errors.New("Invitation Conflict Resolution body is invalid")
	}
	invitationBytes, invitationOK := replicaMapBytes(body, 0, 32)
	if !invitationOK || bytes.Equal(invitationBytes, make([]byte, 32)) {
		return invitationResolution{}, errors.New("Invitation Conflict Resolution Invitation ID is invalid")
	}
	receiptIDs, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 1), "Invitation Conflict Resolution receipt IDs", true)
	if err != nil {
		return invitationResolution{}, err
	}
	recordIDs, err := parseCanonicalIdentifierSet(replicaMapEntryMust(body, 2), "Invitation Conflict Resolution record IDs", true)
	if err != nil {
		return invitationResolution{}, err
	}
	outcome, outcomeOK := replicaMapNumber(body, 3)
	if !outcomeOK || (outcome != 1 && outcome != 2) {
		return invitationResolution{}, errors.New("Invitation Conflict Resolution outcome is invalid")
	}
	selectedValue, selectedExists := replicaMapEntry(body, 4)
	if !selectedExists {
		return invitationResolution{}, errors.New("Invitation Conflict Resolution selection is missing")
	}
	var selected *canonical.Identifier
	if selectedValue != nil {
		selectedBytes, ok := selectedValue.([]byte)
		if !ok || len(selectedBytes) != 32 || bytes.Equal(selectedBytes, make([]byte, 32)) {
			return invitationResolution{}, errors.New("Invitation Conflict Resolution selected Join Request ID is invalid")
		}
		id := bytesIdentifier(selectedBytes)
		selected = &id
	}
	if (outcome == 1) != (selected != nil) {
		return invitationResolution{}, errors.New("Invitation Conflict Resolution outcome does not match its selection")
	}
	return invitationResolution{
		invitationID:       bytesIdentifier(invitationBytes),
		conflictingReceipt: receiptIDs,
		conflictingRecords: recordIDs,
		outcome:            outcome,
		selectedJoin:       selected,
	}, nil
}

func validateInvitationResolution(state keyEpochReplayState, resolution invitationResolution) (invitationTerminalCandidate, error) {
	if _, resolved := state.invitationResolutions[resolution.invitationID]; resolved {
		return invitationTerminalCandidate{}, errors.New("Invitation Conflict Resolution is already terminal")
	}
	if _, conflict := state.invitationConflicts[resolution.invitationID]; !conflict {
		return invitationTerminalCandidate{}, errors.New("Invitation Conflict Resolution has no current conflict")
	}
	candidates := state.invitationCandidates[resolution.invitationID]
	expectedReceiptIDs := make(map[canonical.Identifier]struct{}, len(candidates))
	expectedRecordIDs := make(map[canonical.Identifier]struct{}, len(candidates))
	var selected invitationTerminalCandidate
	selectedFound := false
	for _, candidate := range candidates {
		expectedReceiptIDs[candidate.receiptID] = struct{}{}
		expectedRecordIDs[candidate.recordID] = struct{}{}
		if resolution.selectedJoin != nil && candidate.outcome == 1 && candidate.joinRequestID == *resolution.selectedJoin {
			selected = candidate
			selectedFound = true
		}
	}
	if !sameIdentifierSet(resolution.conflictingReceipt, expectedReceiptIDs) || !sameIdentifierSet(resolution.conflictingRecords, expectedRecordIDs) {
		return invitationTerminalCandidate{}, errors.New("Invitation Conflict Resolution does not name every candidate")
	}
	if resolution.outcome == 1 && !selectedFound {
		return invitationTerminalCandidate{}, errors.New("Invitation Conflict Resolution selected candidate is unavailable")
	}
	return selected, nil
}

func sameIdentifierSlice(left, right []canonical.Identifier) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func parseInvitationAcceptance(event canonical.Event) (invitationAcceptance, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 3) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance body is invalid")
	}
	joinValue := replicaMapEntryMust(body, 0)
	join, ok := replicaMapValue(joinValue)
	if !ok || !replicaMapHasKeys(join, 8) {
		return invitationAcceptance{}, errors.New("Invitation Join Request is invalid")
	}
	proposalValue := replicaMapEntryMust(body, 1)
	proposal, ok := replicaMapValue(proposalValue)
	if !ok || !replicaMapHasKeys(proposal, 8) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Proposal is invalid")
	}
	receiptValue := replicaMapEntryMust(body, 2)
	receipt, ok := replicaMapValue(receiptValue)
	if !ok || !replicaMapHasKeys(receipt, 6) {
		return invitationAcceptance{}, errors.New("Consumed Invitation receipt is invalid")
	}
	invitationBytes, invitationOK := replicaMapBytes(join, 0, 32)
	joinRequestBytes, joinRequestOK := replicaMapBytes(proposal, 1, 32)
	memberBytes, memberOK := replicaMapBytes(join, 2, 32)
	if !invitationOK || !joinRequestOK || !memberOK || bytes.Equal(invitationBytes, make([]byte, 32)) || bytes.Equal(joinRequestBytes, make([]byte, 32)) || bytes.Equal(memberBytes, make([]byte, 32)) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance identity fields are invalid")
	}
	certificate, ok := replicaMapValue(replicaMapEntryMust(join, 3))
	if !ok || !replicaMapHasKeys(certificate, 4) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Client Certificate is invalid")
	}
	clientBytes, clientOK := replicaMapBytes(certificate, 0, 32)
	clientMemberBytes, clientMemberOK := replicaMapBytes(certificate, 1, 32)
	clientSigningKey, clientSigningOK := replicaMapBytes(certificate, 2, ed25519.PublicKeySize)
	if !clientOK || !clientMemberOK || !clientSigningOK || !bytes.Equal(memberBytes, clientMemberBytes) || bytes.Equal(clientBytes, make([]byte, 32)) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Client Certificate fields are invalid")
	}
	recovery, ok := replicaMapValue(replicaMapEntryMust(join, 4))
	if !ok || !replicaMapHasKeys(recovery, 5) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Recovery Credential is invalid")
	}
	recoveryBytes, recoveryOK := replicaMapBytes(recovery, 0, 32)
	recoveryMemberBytes, recoveryMemberOK := replicaMapBytes(recovery, 1, 32)
	recoveryRevision, recoveryRevisionOK := replicaMapNumber(recovery, 2)
	recoverySigningKey, recoverySigningOK := replicaMapBytes(recovery, 3, ed25519.PublicKeySize)
	if !recoveryOK || !recoveryMemberOK || !recoveryRevisionOK || !recoverySigningOK || !bytes.Equal(memberBytes, recoveryMemberBytes) || bytes.Equal(recoveryBytes, make([]byte, 32)) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Recovery Credential fields are invalid")
	}
	proposalAuthorityIDs, err := parseCanonicalIdentifierSet(replicaMapEntryMust(proposal, 2), "Invitation Acceptance Authority Parents", true)
	if err != nil {
		return invitationAcceptance{}, err
	}
	slots, err := parseKeyEpochEnvelopeSlots(replicaMapEntryMust(proposal, 7), "Invitation Acceptance Envelope slots")
	if err != nil {
		return invitationAcceptance{}, err
	}
	clientProof, clientProofOK := replicaMapBytes(join, 5, ed25519.SignatureSize)
	recoveryProof, recoveryProofOK := replicaMapBytes(join, 6, ed25519.SignatureSize)
	redemptionProof, redemptionProofOK := replicaMapBytes(join, 7, ed25519.SignatureSize)
	receiptInvitationBytes, receiptInvitationOK := replicaMapBytes(receipt, 0, 32)
	receiptOutcome, receiptOutcomeOK := replicaMapNumber(receipt, 1)
	receiptJoinRequestBytes, receiptJoinRequestOK := replicaMapBytes(receipt, 2, 32)
	receiptProposalBytes, receiptProposalOK := replicaMapBytes(receipt, 3, 32)
	receiptIDBytes, receiptIDOK := replicaMapBytes(receipt, 4, 32)
	receiptSignature, receiptSignatureOK := replicaMapBytes(receipt, 5, ed25519.SignatureSize)
	if !clientProofOK || !recoveryProofOK || !redemptionProofOK || !receiptInvitationOK || !receiptOutcomeOK || !receiptJoinRequestOK || !receiptProposalOK || !receiptIDOK || !receiptSignatureOK || bytes.Equal(receiptInvitationBytes, make([]byte, 32)) || bytes.Equal(receiptJoinRequestBytes, make([]byte, 32)) || bytes.Equal(receiptProposalBytes, make([]byte, 32)) || bytes.Equal(receiptIDBytes, make([]byte, 32)) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance signatures are invalid")
	}
	joinPrefix := canonical.Map{}
	for key := uint64(0); key < 5; key++ {
		value, exists := replicaMapEntry(join, key)
		if !exists {
			return invitationAcceptance{}, errors.New("Invitation Join Request prefix is incomplete")
		}
		joinPrefix[key] = value
	}
	joinPrefixBytes, err := canonical.EncodeValue(joinPrefix)
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation Join Request prefix is not canonical")
	}
	receiptPrefix := canonical.Map{}
	for key := uint64(0); key < 5; key++ {
		value, exists := replicaMapEntry(receipt, key)
		if !exists {
			return invitationAcceptance{}, errors.New("Invitation receipt prefix is incomplete")
		}
		receiptPrefix[key] = value
	}
	receiptPrefixBytes, err := canonical.EncodeValue(receiptPrefix)
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation receipt prefix is not canonical")
	}
	capabilitiesBytes, err := canonical.EncodeValue(replicaMapEntryMust(join, 1))
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation capabilities are not canonical")
	}
	proposalBytes, err := canonical.EncodeValue(proposalValue)
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Proposal is not canonical")
	}
	joinRequestBytesEncoded, err := canonical.EncodeValue(joinValue)
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation Join Request is not canonical")
	}
	capabilityValues, ok := replicaMapArrayValue(replicaMapEntryMust(join, 1))
	if !ok || len(capabilityValues) == 0 {
		return invitationAcceptance{}, errors.New("Invitation capabilities are invalid")
	}
	administrator := false
	var previousCapability []byte
	seenCapabilities := make(map[string]struct{}, len(capabilityValues))
	for _, capabilityValue := range capabilityValues {
		encoded, encodeErr := canonical.EncodeValue(capabilityValue)
		if encodeErr != nil || (previousCapability != nil && bytes.Compare(previousCapability, encoded) >= 0) {
			return invitationAcceptance{}, errors.New("Invitation capabilities are not a canonical set")
		}
		if _, duplicate := seenCapabilities[string(encoded)]; duplicate {
			return invitationAcceptance{}, errors.New("Invitation capabilities contain a duplicate")
		}
		seenCapabilities[string(encoded)] = struct{}{}
		previousCapability = encoded
		capability, capabilityOK := replicaMapValue(capabilityValue)
		if !capabilityOK || !replicaMapHasKeys(capability, 5) {
			return invitationAcceptance{}, errors.New("Invitation capability descriptor is invalid")
		}
		action, actionOK := replicaMapEntry(capability, 3)
		if !actionOK {
			return invitationAcceptance{}, errors.New("Invitation capability action is missing")
		}
		if actionText, actionOK := action.(string); actionOK && actionText == "awsm.vault.administrator" {
			administrator = true
		}
	}
	joinRequestIDTranscript, err := canonical.Transcript("awsm:invitation-join-request-id:v1", joinRequestBytesEncoded)
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation Join Request identity is invalid")
	}
	derivedJoinRequestID := sha256.Sum256(joinRequestIDTranscript)
	if !bytes.Equal(derivedJoinRequestID[:], joinRequestBytes) {
		return invitationAcceptance{}, errors.New("Invitation Join Request identity does not match its bytes")
	}
	proposalIDTranscript, err := canonical.Transcript("awsm:invitation-acceptance-proposal-id:v1", proposalBytes)
	if err != nil {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Proposal identity is invalid")
	}
	derivedProposalID := sha256.Sum256(proposalIDTranscript)
	if !bytes.Equal(derivedProposalID[:], receiptProposalBytes) {
		return invitationAcceptance{}, errors.New("Invitation Acceptance Proposal identity does not match its bytes")
	}
	return invitationAcceptance{
		invitationID:            bytesIdentifier(invitationBytes),
		joinRequestID:           bytesIdentifier(joinRequestBytes),
		proposalID:              bytesIdentifier(receiptProposalBytes),
		memberID:                bytesIdentifier(memberBytes),
		clientCredentialID:      bytesIdentifier(clientBytes),
		recoveryCredentialID:    bytesIdentifier(recoveryBytes),
		recoveryRevision:        recoveryRevision,
		clientSigningKey:        append(ed25519.PublicKey(nil), clientSigningKey...),
		recoverySigningKey:      append(ed25519.PublicKey(nil), recoverySigningKey...),
		clientPossessionProof:   append([]byte(nil), clientProof...),
		recoveryPossessionProof: append([]byte(nil), recoveryProof...),
		redemptionProof:         append([]byte(nil), redemptionProof...),
		receiptID:               bytesIdentifier(receiptIDBytes),
		receiptInvitationID:     bytesIdentifier(receiptInvitationBytes),
		receiptOutcome:          receiptOutcome,
		receiptJoinRequestID:    bytesIdentifier(receiptJoinRequestBytes),
		receiptProposalID:       bytesIdentifier(receiptProposalBytes),
		receiptSignature:        append([]byte(nil), receiptSignature...),
		envelopeSlots:           slots,
		proposalAuthorityIDs:    proposalAuthorityIDs,
		joinRequestPrefixBytes:  joinPrefixBytes,
		joinRequestBytes:        joinRequestBytesEncoded,
		proposalBytes:           proposalBytes,
		receiptPrefixBytes:      receiptPrefixBytes,
		capabilitiesBytes:       capabilitiesBytes,
		administrator:           administrator,
	}, nil
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

func parseKeyDelivery(event canonical.Event) (keyDelivery, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 1) {
		return keyDelivery{}, errors.New("Key Delivery body is invalid")
	}
	slots, err := parseKeyEpochEnvelopeSlots(replicaMapEntryMust(body, 0), "Key Delivery Envelope slots")
	if err != nil {
		return keyDelivery{}, err
	}
	return keyDelivery{slots: slots}, nil
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

func validateKeyDelivery(state keyEpochReplayState, event canonical.Event, delivery keyDelivery) error {
	dependencyIDs := make(map[canonical.Identifier]struct{}, len(event.Dependencies))
	for _, dependency := range event.Dependencies {
		if dependency.Type != 7 {
			return errors.New("Key Delivery dependencies must be Key Envelopes")
		}
		dependencyIDs[dependency.ID] = struct{}{}
	}
	if len(dependencyIDs) != len(delivery.slots) {
		return errors.New("Key Delivery dependencies do not match Envelope slots")
	}
	seenTargets := make(map[string]struct{}, len(delivery.slots))
	for _, slot := range delivery.slots {
		if _, established := state.epochs[slot.epochID]; !established {
			return errors.New("Key Delivery names an unknown Key Epoch")
		}
		if _, dependency := dependencyIDs[slot.envelopeID]; !dependency {
			return errors.New("Key Delivery omits an Envelope dependency")
		}
		var target string
		if slot.targetKind == awsmcrypto.RecoveryCredentialTarget {
			if slot.targetRevision == nil {
				return errors.New("Key Delivery Recovery slot omits its revision")
			}
			revision, effective := state.recoveryTargets[slot.targetID]
			if !effective || revision != *slot.targetRevision {
				return errors.New("Key Delivery Recovery target is not an effective Credential")
			}
			target = fmt.Sprintf("%d:%x:%d", slot.targetKind, slot.targetID, *slot.targetRevision)
		} else if slot.targetKind == awsmcrypto.ClientCredentialTarget {
			if slot.targetRevision != nil {
				return errors.New("Key Delivery Client slot has a target revision")
			}
			if _, active := state.activeClientMember(slot.targetID); !active {
				return errors.New("Key Delivery Client target is not active")
			}
			target = fmt.Sprintf("%d:%x:null", slot.targetKind, slot.targetID)
		} else {
			return errors.New("Key Delivery target kind is invalid")
		}
		key := fmt.Sprintf("%s:%x", target, slot.epochID)
		if _, duplicate := seenTargets[key]; duplicate {
			return errors.New("Key Delivery repeats a target and Key Epoch")
		}
		if _, delivered := state.deliveredSlots[key]; delivered {
			return errors.New("Key Delivery repeats an already delivered target and Key Epoch")
		}
		seenTargets[key] = struct{}{}
	}
	return nil
}

func keyDeliverySlotKey(slot keyEpochEnvelopeSlot) string {
	var target string
	if slot.targetKind == awsmcrypto.RecoveryCredentialTarget && slot.targetRevision != nil {
		target = fmt.Sprintf("%d:%x:%d", slot.targetKind, slot.targetID, *slot.targetRevision)
	} else {
		target = fmt.Sprintf("%d:%x:null", slot.targetKind, slot.targetID)
	}
	return fmt.Sprintf("%s:%x", target, slot.epochID)
}

func parseFeatureActivation(event canonical.Event) (featureActivation, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 3) {
		return featureActivation{}, errors.New("Feature Activation body is invalid")
	}
	previousBytes, previousOK := replicaMapBytes(body, 0, 32)
	resultingBytes, resultingOK := replicaMapBytes(body, 2, 32)
	if !previousOK || !resultingOK || bytes.Equal(previousBytes, make([]byte, 32)) || bytes.Equal(resultingBytes, make([]byte, 32)) {
		return featureActivation{}, errors.New("Feature Activation Required Feature Set IDs are invalid")
	}
	values, ok := replicaMapArrayValue(replicaMapEntryMust(body, 1))
	if !ok || len(values) == 0 {
		return featureActivation{}, errors.New("Feature Activation Manifest set is invalid")
	}
	manifests := make([]canonical.FeatureManifest, 0, len(values))
	seenIDs := make(map[canonical.Identifier]struct{}, len(values))
	seenKeys := make(map[string]struct{}, len(values))
	var previous []byte
	for _, value := range values {
		encoded, err := canonical.EncodeValue(value)
		if err != nil || (previous != nil && bytes.Compare(previous, encoded) >= 0) {
			return featureActivation{}, errors.New("Feature Activation Manifests are not a canonical set")
		}
		previous = encoded
		manifestBytes, ok := value.([]byte)
		if !ok {
			return featureActivation{}, errors.New("Feature Activation Manifest is not complete bytes")
		}
		manifest, err := canonical.DecodeFeatureManifest(manifestBytes)
		if err != nil {
			return featureActivation{}, fmt.Errorf("decode Feature Activation Manifest: %w", err)
		}
		if _, exists := seenIDs[manifest.ID]; exists {
			return featureActivation{}, errors.New("Feature Activation repeats a Manifest identity")
		}
		if _, exists := seenKeys[manifest.FeatureKey]; exists {
			return featureActivation{}, errors.New("Feature Activation repeats a feature key")
		}
		seenIDs[manifest.ID] = struct{}{}
		seenKeys[manifest.FeatureKey] = struct{}{}
		manifests = append(manifests, manifest)
	}
	return featureActivation{
		previousFeatureSetID:  bytesIdentifier(previousBytes),
		addedManifests:        manifests,
		resultingFeatureSetID: bytesIdentifier(resultingBytes),
	}, nil
}

func validateFeatureActivation(state keyEpochReplayState, event canonical.Event, activation featureActivation) error {
	if activation.previousFeatureSetID != state.featureSetID {
		return errors.New("Feature Activation previous Required Feature Set does not match its Authority Parents")
	}
	dependencyIDs := make(map[canonical.Identifier]struct{}, len(event.Dependencies))
	for _, dependency := range event.Dependencies {
		if dependency.Type != 8 {
			return errors.New("Feature Activation dependencies must be Feature Manifests")
		}
		dependencyIDs[dependency.ID] = struct{}{}
	}
	if len(dependencyIDs) != len(activation.addedManifests) {
		return errors.New("Feature Activation dependencies do not match added Manifests")
	}
	for _, manifest := range activation.addedManifests {
		if _, exists := dependencyIDs[manifest.ID]; !exists {
			return errors.New("Feature Activation omits a Manifest dependency")
		}
	}
	if state.featureSetID == canonical.EmptyRequiredFeatureSetID() || len(state.featureManifests) > 0 {
		inputs := make([]canonical.FeatureManifestInput, 0, len(state.featureManifests)+len(activation.addedManifests))
		for _, manifest := range state.featureManifests {
			inputs = append(inputs, manifest.FeatureManifestInput)
		}
		for _, manifest := range activation.addedManifests {
			inputs = append(inputs, manifest.FeatureManifestInput)
		}
		resulting, err := canonical.RequiredFeatureSetID(inputs)
		if err != nil {
			return fmt.Errorf("derive Feature Activation Required Feature Set: %w", err)
		}
		if resulting != activation.resultingFeatureSetID {
			return errors.New("Feature Activation resulting Required Feature Set is invalid")
		}
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
