package vault

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
)

// Replica is the authenticated, in-memory semantic view of one Vault copy.
// Its records are immutable; the frontiers and continuity roots are derived
// from admitted records and can be rebuilt after a restart.
type Replica struct {
	vaultID             canonical.Identifier
	generationID        canonical.Identifier
	baseline            canonical.Baseline
	baselineID          canonical.Identifier
	genesisID           canonical.Identifier
	records             map[canonical.Identifier]canonical.Record
	graph               *canonical.CausalGraph
	causalFrontier      []canonical.Identifier
	authorityFrontier   []canonical.Identifier
	continuityRecordIDs []canonical.Identifier
	credentialKeys      map[canonical.Identifier]ed25519.PublicKey
	objects             map[canonical.Identifier]ReplicaObject
	featureManifests    map[canonical.Identifier]canonical.FeatureManifest
}

type ReplicaObject struct {
	ObjectID             canonical.Identifier
	VaultID              canonical.Identifier
	ObjectType           uint64
	RequiredFeatureSetID canonical.Identifier
	Body                 canonical.Value
	Bytes                []byte
}

type ReplicaState struct {
	VaultID             canonical.Identifier
	GenerationID        canonical.Identifier
	BaselineID          canonical.Identifier
	GenesisID           canonical.Identifier
	CausalFrontier      []canonical.Identifier
	AuthorityFrontier   []canonical.Identifier
	ContinuityRecordIDs []canonical.Identifier
}

// AuthorityState is the deterministic portable authority projection derived
// from the admitted Authority/Lifecycle subgraph. It is a read-only view; it
// is never a second persisted source of Vault authority.
type AuthorityState struct {
	ActiveMemberIDs                []canonical.Identifier
	AdministratorIDs               []canonical.Identifier
	ActiveClientCredentialIDs      []canonical.Identifier
	EffectiveRecoveryCredentialIDs []canonical.Identifier
	RecoveryConflicts              []AuthorityRecoveryConflict
	KeyEpochConflicts              []AuthorityKeyEpochConflict
	CurrentKeyEpochIDs             []canonical.Identifier
	Lifecycle                      string
}

type AuthorityRecoveryConflict struct {
	MemberID   canonical.Identifier
	Candidates []AuthorityRecoveryConflictCandidate
}

type AuthorityRecoveryConflictCandidate struct {
	HeadRecordID         canonical.Identifier
	RecoveryCredentialID canonical.Identifier
}

type AuthorityKeyEpochConflict struct {
	Candidates []AuthorityKeyEpochConflictCandidate
}

type AuthorityKeyEpochConflictCandidate struct {
	HeadRecordID canonical.Identifier
	KeyEpochID   canonical.Identifier
}

func NewReplica(baseline canonical.Baseline) (*Replica, error) {
	if baseline.RecordID == (canonical.Identifier{}) || len(baseline.Bytes) == 0 {
		return nil, errors.New("Replica Baseline is incomplete")
	}
	decoded, err := canonical.DecodeBaseline(baseline.Bytes)
	if err != nil {
		return nil, fmt.Errorf("decode Replica Baseline: %w", err)
	}
	if decoded.RecordID != baseline.RecordID || decoded.VaultID != baseline.VaultID || decoded.GenerationID != baseline.GenerationID {
		return nil, errors.New("Replica Baseline identity changed during decoding")
	}
	graph := canonical.NewCausalGraph()
	if err := graph.AddBaseline(baseline.RecordID, nil); err != nil {
		return nil, fmt.Errorf("add Replica Baseline: %w", err)
	}
	return &Replica{
		vaultID:          baseline.VaultID,
		generationID:     baseline.GenerationID,
		baseline:         decoded,
		baselineID:       baseline.RecordID,
		records:          map[canonical.Identifier]canonical.Record{baseline.RecordID: {Kind: canonical.BaselineKind, Baseline: &decoded, Bytes: append([]byte(nil), decoded.Bytes...), RecordID: decoded.RecordID}},
		graph:            graph,
		credentialKeys:   make(map[canonical.Identifier]ed25519.PublicKey),
		objects:          make(map[canonical.Identifier]ReplicaObject),
		featureManifests: make(map[canonical.Identifier]canonical.FeatureManifest),
	}, nil
}

func (r *Replica) AdmitEvent(event canonical.Event, signerPublicKey ed25519.PublicKey) error {
	if r == nil {
		return errors.New("Replica is required")
	}
	decoded, err := canonical.DecodeEvent(event.Bytes)
	if err != nil {
		return fmt.Errorf("decode Event: %w", err)
	}
	if decoded.RecordID != event.RecordID || decoded.VaultID != event.VaultID || decoded.GenerationID != event.GenerationID {
		return errors.New("Event identity changed during decoding")
	}
	if decoded.VaultID != r.vaultID || decoded.GenerationID != r.generationID {
		return errors.New("Event belongs to another Vault Generation")
	}
	if existing, ok := r.records[decoded.RecordID]; ok {
		if existing.Kind == canonical.EventKind && bytes.Equal(existing.Bytes, decoded.Bytes) {
			return nil
		}
		return errors.New("Record identity collision")
	}
	if !canonical.VerifyEventSignature(decoded, signerPublicKey) {
		return errors.New("Event signature is invalid")
	}
	if !(decoded.Family == canonical.AuthorityFamily && decoded.Type == canonical.GenesisEvent) {
		events := r.Events()
		events = append(events, decoded)
		genesisRecord, exists := r.records[r.genesisID]
		if !exists || genesisRecord.Event == nil {
			return errors.New("Event has no authenticated Genesis")
		}
		if _, replayErr := replayAuthenticatedKeyEpochs(events, *genesisRecord.Event, nil); replayErr != nil {
			return fmt.Errorf("admit authenticated Event: %w", replayErr)
		}
	}
	var enrollment *enrollmentCredential
	var acceptance *invitationAcceptance
	if decoded.Family == canonical.AuthorityFamily && decoded.Type == 9 {
		parsed, err := parseEnrollmentCredential(decoded)
		if err != nil {
			return err
		}
		enrollment = &parsed
	}
	if decoded.Family == canonical.AuthorityFamily && decoded.Type == 6 {
		parsed, err := parseInvitationAcceptance(decoded)
		if err != nil {
			return err
		}
		acceptance = &parsed
	}
	if decoded.Family == canonical.AuthorityFamily && decoded.Type == canonical.GenesisEvent {
		if r.genesisID != (canonical.Identifier{}) || len(decoded.ParentRecordIDs) != 0 || len(decoded.AuthorityParentIDs) != 0 {
			return errors.New("Replica already has a Genesis or Genesis has parents")
		}
		if !hasDependency(decoded.Dependencies, 2, r.baselineID) {
			return errors.New("Genesis does not depend on the Replica Baseline")
		}
		credentialID, signingKey, err := genesisCredential(decoded)
		if err != nil {
			return err
		}
		if credentialID != decoded.SignerCredentialID || !bytes.Equal(signingKey, signerPublicKey) {
			return errors.New("Genesis signer Credential does not match its certificate")
		}
		r.credentialKeys[credentialID] = append(ed25519.PublicKey(nil), signerPublicKey...)
		r.genesisID = decoded.RecordID
	} else {
		if len(decoded.ParentRecordIDs) == 0 || len(decoded.AuthorityParentIDs) == 0 {
			return errors.New("non-Genesis Event requires complete parent frontiers")
		}
		if err := r.requireParents(decoded.ParentRecordIDs, "causal"); err != nil {
			return err
		}
		if err := r.requireParents(decoded.AuthorityParentIDs, "Authority"); err != nil {
			return err
		}
		acceptedKey, ok := r.credentialKeys[decoded.SignerCredentialID]
		if enrollment != nil && enrollment.authorizationKind == 2 && decoded.SignerCredentialID == enrollment.credentialID {
			acceptedKey = enrollment.signingPublicKey
			ok = true
		}
		if !ok || !bytes.Equal(acceptedKey, signerPublicKey) {
			return errors.New("Event signer Credential is not accepted")
		}
	}
	if err := r.graph.Add(decoded.RecordID, decoded.ParentRecordIDs); err != nil {
		return fmt.Errorf("add Event to causal DAG: %w", err)
	}
	r.records[decoded.RecordID] = canonical.Record{Kind: canonical.EventKind, Event: &decoded, Bytes: append([]byte(nil), decoded.Bytes...), RecordID: decoded.RecordID}
	if enrollment != nil {
		if _, exists := r.credentialKeys[enrollment.credentialID]; exists {
			return errors.New("Client Enrollment reuses a Client Credential identity")
		}
		r.credentialKeys[enrollment.credentialID] = append(ed25519.PublicKey(nil), enrollment.signingPublicKey...)
	}
	if acceptance != nil {
		r.credentialKeys[acceptance.clientCredentialID] = append(ed25519.PublicKey(nil), acceptance.clientSigningKey...)
	}
	if decoded.Family == canonical.AuthorityFamily || decoded.Family == canonical.LifecycleFamily {
		r.continuityRecordIDs = appendUniqueSorted(r.continuityRecordIDs, decoded.RecordID)
	}
	if decoded.Family == canonical.AuthorityFamily && decoded.Type == canonical.GenesisEvent {
		r.causalFrontier = []canonical.Identifier{decoded.RecordID}
		r.authorityFrontier = []canonical.Identifier{decoded.RecordID}
	} else {
		r.causalFrontier = advanceFrontier(r.causalFrontier, decoded.ParentRecordIDs, decoded.RecordID)
		r.authorityFrontier = advanceFrontier(r.authorityFrontier, decoded.AuthorityParentIDs, decoded.RecordID)
	}
	return nil
}

// AdmitKnownEvent verifies an Event against the Credential certificate already
// accepted by Genesis. It is the destination-side admission path for pulled
// opaque Records; a sender never supplies an out-of-band trust key.
func (r *Replica) AdmitKnownEvent(event canonical.Event) error {
	if r == nil {
		return errors.New("Replica is required")
	}
	key, ok := r.credentialKeys[event.SignerCredentialID]
	if event.Family == canonical.AuthorityFamily && event.Type == 9 {
		parsed, err := parseEnrollmentCredential(event)
		if err != nil {
			return err
		}
		if parsed.authorizationKind == 2 && parsed.credentialID == event.SignerCredentialID {
			key = parsed.signingPublicKey
			ok = true
		}
	}
	if !ok {
		return errors.New("Event signer Credential is not accepted")
	}
	return r.AdmitEvent(event, key)
}

// AdmitObject verifies the canonical content address and Vault/Feature
// binding before retaining one immutable Object. Objects are independent of
// Event DAG order but remain local Replica state for Library reduction.
func (r *Replica) AdmitObject(objectID canonical.Identifier, encoded []byte) error {
	if r == nil {
		return errors.New("Replica is required")
	}
	object, err := decodeReplicaObject(objectID, encoded)
	if err != nil {
		return err
	}
	if object.VaultID != r.vaultID || object.RequiredFeatureSetID != r.baseline.RequiredFeatureSetID {
		return errors.New("Object belongs to another accepted Vault context")
	}
	if existing, ok := r.objects[objectID]; ok {
		if bytes.Equal(existing.Bytes, encoded) {
			return nil
		}
		return errors.New("Object identity collision")
	}
	r.objects[objectID] = object
	return nil
}

// AdmitFeatureManifest verifies one immutable Feature Manifest content address
// before retaining it for Required Feature Set resolution and export.
func (r *Replica) AdmitFeatureManifest(manifestID canonical.Identifier, encoded []byte) error {
	if r == nil {
		return errors.New("Replica is required")
	}
	manifest, err := canonical.DecodeFeatureManifest(encoded)
	if err != nil {
		return fmt.Errorf("decode Feature Manifest: %w", err)
	}
	if manifest.ID != manifestID {
		return errors.New("Feature Manifest content address does not match its bytes")
	}
	if existing, ok := r.featureManifests[manifestID]; ok {
		if bytes.Equal(existing.Bytes, encoded) {
			return nil
		}
		return errors.New("Feature Manifest identity collision")
	}
	manifest.Bytes = append([]byte(nil), manifest.Bytes...)
	manifest.Parameters = append([]byte(nil), manifest.Parameters...)
	manifest.RequiredManifestIDs = append([]canonical.Identifier(nil), manifest.RequiredManifestIDs...)
	manifest.IncompatibleKeys = append([]string(nil), manifest.IncompatibleKeys...)
	r.featureManifests[manifestID] = manifest
	return nil
}

func (r *Replica) FeatureManifest(manifestID canonical.Identifier) (canonical.FeatureManifest, bool) {
	if r == nil {
		return canonical.FeatureManifest{}, false
	}
	manifest, ok := r.featureManifests[manifestID]
	if !ok {
		return canonical.FeatureManifest{}, false
	}
	return cloneFeatureManifest(manifest), true
}

func (r *Replica) FeatureManifests() []canonical.FeatureManifest {
	if r == nil {
		return nil
	}
	entries := make([]canonical.FeatureManifest, 0, len(r.featureManifests))
	for _, manifest := range r.featureManifests {
		entries = append(entries, cloneFeatureManifest(manifest))
	}
	sort.Slice(entries, func(left, right int) bool {
		return bytes.Compare(entries[left].ID[:], entries[right].ID[:]) < 0
	})
	return entries
}

func (r *Replica) Object(objectID canonical.Identifier) (ReplicaObject, bool) {
	if r == nil {
		return ReplicaObject{}, false
	}
	object, ok := r.objects[objectID]
	if !ok {
		return ReplicaObject{}, false
	}
	object.Bytes = append([]byte(nil), object.Bytes...)
	return object, true
}

func (r *Replica) ReleaseObject(objectID canonical.Identifier) bool {
	if r == nil {
		return false
	}
	if _, ok := r.objects[objectID]; !ok {
		return false
	}
	delete(r.objects, objectID)
	return true
}

// AdoptVacuum validates the predecessor-generation Vacuum Event against this
// Replica, then installs its authenticated successor Baseline as the active
// root while retaining the event and prior continuity records for restart and
// audit. The event is never rewritten into the successor generation.
func (r *Replica) AdoptVacuum(baseline canonical.Baseline, event canonical.Event) (*Replica, error) {
	if r == nil {
		return nil, errors.New("Replica is required")
	}
	if event.Family != canonical.LifecycleFamily || event.Type != 1 {
		return nil, errors.New("Record is not a Vacuum Event")
	}
	if baseline.VaultID != r.vaultID || baseline.GenerationID == r.generationID {
		return nil, errors.New("Vacuum successor Baseline has an invalid context")
	}
	if !hasDependency(event.Dependencies, 2, baseline.RecordID) {
		return nil, errors.New("Vacuum Event does not depend on its successor Baseline")
	}
	candidate := r.Clone()
	if err := candidate.AdmitKnownEvent(event); err != nil {
		return nil, fmt.Errorf("admit Vacuum Event: %w", err)
	}
	if err := candidate.graph.AddBaseline(baseline.RecordID, nil); err != nil {
		return nil, fmt.Errorf("add successor Baseline: %w", err)
	}
	decodedBaseline, err := canonical.DecodeBaseline(baseline.Bytes)
	if err != nil || decodedBaseline.RecordID != baseline.RecordID {
		return nil, errors.New("successor Baseline identity is invalid")
	}
	candidate.baseline = decodedBaseline
	candidate.baselineID = baseline.RecordID
	candidate.generationID = baseline.GenerationID
	candidate.records[baseline.RecordID] = canonical.Record{Kind: canonical.BaselineKind, Baseline: &decodedBaseline, Bytes: append([]byte(nil), decodedBaseline.Bytes...), RecordID: decodedBaseline.RecordID}
	candidate.causalFrontier = []canonical.Identifier{baseline.RecordID}
	candidate.authorityFrontier = []canonical.Identifier{event.RecordID}
	candidate.continuityRecordIDs = appendUniqueSorted(candidate.continuityRecordIDs, event.RecordID)
	return candidate, nil
}

func decodeReplicaObject(objectID canonical.Identifier, encoded []byte) (ReplicaObject, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return ReplicaObject{}, fmt.Errorf("decode Vault Object: %w", err)
	}
	if !replicaMapHasKeys(value, 6) {
		return ReplicaObject{}, errors.New("Vault Object fields are invalid")
	}
	format, ok := replicaMapNumber(value, 0)
	if !ok || format != 1 {
		return ReplicaObject{}, errors.New("Vault Object format is invalid")
	}
	vaultBytes, ok := replicaMapBytes(value, 1, 32)
	if !ok {
		return ReplicaObject{}, errors.New("Vault Object Vault ID is invalid")
	}
	var vaultID canonical.Identifier
	copy(vaultID[:], vaultBytes)
	objectType, ok := replicaMapNumber(value, 2)
	if !ok || objectType < 1 || objectType > 3 {
		return ReplicaObject{}, errors.New("Vault Object type is invalid")
	}
	featureBytes, ok := replicaMapBytes(value, 3, 32)
	if !ok {
		return ReplicaObject{}, errors.New("Vault Object Required Feature Set ID is invalid")
	}
	var featureID canonical.Identifier
	copy(featureID[:], featureBytes)
	body, ok := replicaMapEntry(value, 4)
	if !ok {
		return ReplicaObject{}, errors.New("Vault Object body is missing")
	}
	if _, ok := replicaMapEntry(value, 5); !ok {
		return ReplicaObject{}, errors.New("Vault Object extensions are missing")
	}
	derived, err := canonical.VaultObjectID(vaultID, objectType, encoded)
	if err != nil {
		return ReplicaObject{}, err
	}
	if derived != objectID {
		return ReplicaObject{}, errors.New("Vault Object content address does not match its bytes")
	}
	return ReplicaObject{ObjectID: objectID, VaultID: vaultID, ObjectType: objectType, RequiredFeatureSetID: featureID, Body: body, Bytes: append([]byte(nil), encoded...)}, nil
}

func (r *Replica) Record(id canonical.Identifier) (canonical.Record, bool) {
	if r == nil {
		return canonical.Record{}, false
	}
	record, ok := r.records[id]
	if !ok {
		return canonical.Record{}, false
	}
	record.Bytes = append([]byte(nil), record.Bytes...)
	return record, true
}

func (r *Replica) IsAncestor(ancestor, descendant canonical.Identifier) bool {
	if r == nil {
		return false
	}
	if ancestor == r.baselineID && descendant == r.genesisID {
		return true
	}
	return r.graph.IsAncestor(ancestor, descendant)
}

func (r *Replica) State() ReplicaState {
	if r == nil {
		return ReplicaState{}
	}
	return ReplicaState{
		VaultID:             r.vaultID,
		GenerationID:        r.generationID,
		BaselineID:          r.baselineID,
		GenesisID:           r.genesisID,
		CausalFrontier:      cloneIdentifiers(r.causalFrontier),
		AuthorityFrontier:   cloneIdentifiers(r.authorityFrontier),
		ContinuityRecordIDs: cloneIdentifiers(r.continuityRecordIDs),
	}
}

// AuthorityState replays the authenticated Authority and Lifecycle Events and
// returns the current derived membership, administrator, credential, recovery,
// epoch, and lifecycle state.
func (r *Replica) AuthorityState() (AuthorityState, error) {
	if r == nil {
		return AuthorityState{}, errors.New("Replica is required")
	}
	genesisRecord, ok := r.records[r.genesisID]
	if !ok || genesisRecord.Event == nil {
		return AuthorityState{}, errors.New("authenticated Genesis is unavailable")
	}
	replayed, err := replayAuthenticatedKeyEpochs(r.Events(), *genesisRecord.Event, nil)
	if err != nil {
		return AuthorityState{}, fmt.Errorf("replay Authority State: %w", err)
	}
	state := AuthorityState{
		ActiveMemberIDs:                sortedIdentifierKeys(replayed.activeMembers),
		AdministratorIDs:               sortedIdentifierKeys(replayed.administrators),
		EffectiveRecoveryCredentialIDs: sortedIdentifierKeys(replayed.recoveryTargets),
		CurrentKeyEpochIDs:             sortedIdentifierKeys(replayed.heads),
		Lifecycle:                      "Open",
	}
	for memberID, candidates := range replayed.recoveryConflicts {
		conflict := AuthorityRecoveryConflict{MemberID: memberID, Candidates: make([]AuthorityRecoveryConflictCandidate, 0, len(candidates))}
		for _, candidate := range candidates {
			conflict.Candidates = append(conflict.Candidates, AuthorityRecoveryConflictCandidate{
				HeadRecordID: candidate.headRecordID, RecoveryCredentialID: candidate.recoveryCredentialID,
			})
		}
		state.RecoveryConflicts = append(state.RecoveryConflicts, conflict)
	}
	sort.Slice(state.RecoveryConflicts, func(left, right int) bool {
		return bytes.Compare(state.RecoveryConflicts[left].MemberID[:], state.RecoveryConflicts[right].MemberID[:]) < 0
	})
	if len(replayed.keyEpochConflicts) > 0 {
		conflict := AuthorityKeyEpochConflict{Candidates: make([]AuthorityKeyEpochConflictCandidate, 0, len(replayed.keyEpochConflicts))}
		for _, candidate := range replayed.keyEpochConflicts {
			conflict.Candidates = append(conflict.Candidates, AuthorityKeyEpochConflictCandidate{
				HeadRecordID: candidate.headRecordID, KeyEpochID: candidate.keyEpochID,
			})
		}
		state.KeyEpochConflicts = []AuthorityKeyEpochConflict{conflict}
	}
	for credentialID := range replayed.clientTargets {
		if _, active := replayed.activeClientMember(credentialID); active {
			state.ActiveClientCredentialIDs = append(state.ActiveClientCredentialIDs, credentialID)
		}
	}
	sort.Slice(state.ActiveClientCredentialIDs, func(left, right int) bool {
		return bytes.Compare(state.ActiveClientCredentialIDs[left][:], state.ActiveClientCredentialIDs[right][:]) < 0
	})
	if replayed.closed || len(state.AdministratorIDs) == 0 {
		state.Lifecycle = "Closed"
	}
	return state, nil
}

// Clone copies the authenticated Replica indexes without sharing mutable
// slices or record byte buffers. The canonical Record bytes themselves remain
// immutable values; callers may safely use the clone for a compare-and-swap
// mutation and discard it on persistence failure.
func (r *Replica) Clone() *Replica {
	if r == nil {
		return nil
	}
	clone := &Replica{
		vaultID:             r.vaultID,
		generationID:        r.generationID,
		baseline:            r.baseline,
		baselineID:          r.baselineID,
		genesisID:           r.genesisID,
		records:             make(map[canonical.Identifier]canonical.Record, len(r.records)),
		graph:               canonical.NewCausalGraph(),
		causalFrontier:      cloneIdentifiers(r.causalFrontier),
		authorityFrontier:   cloneIdentifiers(r.authorityFrontier),
		continuityRecordIDs: cloneIdentifiers(r.continuityRecordIDs),
		credentialKeys:      make(map[canonical.Identifier]ed25519.PublicKey, len(r.credentialKeys)),
		objects:             make(map[canonical.Identifier]ReplicaObject, len(r.objects)),
		featureManifests:    make(map[canonical.Identifier]canonical.FeatureManifest, len(r.featureManifests)),
	}
	for id, key := range r.credentialKeys {
		clone.credentialKeys[id] = append(ed25519.PublicKey(nil), key...)
	}
	for id, object := range r.objects {
		copyObject := object
		copyObject.Bytes = append([]byte(nil), object.Bytes...)
		clone.objects[id] = copyObject
	}
	for id, manifest := range r.featureManifests {
		clone.featureManifests[id] = cloneFeatureManifest(manifest)
	}
	clone.baseline.Bytes = append([]byte(nil), r.baseline.Bytes...)
	_ = clone.graph.AddBaseline(clone.baselineID, nil)
	for id, record := range r.records {
		copyRecord := record
		copyRecord.Bytes = append([]byte(nil), record.Bytes...)
		if record.Event != nil {
			event := *record.Event
			event.Bytes = append([]byte(nil), record.Event.Bytes...)
			event.ParentRecordIDs = append([]canonical.Identifier(nil), record.Event.ParentRecordIDs...)
			event.AuthorityParentIDs = append([]canonical.Identifier(nil), record.Event.AuthorityParentIDs...)
			event.Dependencies = append([]canonical.Dependency(nil), record.Event.Dependencies...)
			event.Signature = append([]byte(nil), record.Event.Signature...)
			copyRecord.Event = &event
		}
		if record.Baseline != nil {
			baseline := *record.Baseline
			baseline.Bytes = append([]byte(nil), record.Baseline.Bytes...)
			copyRecord.Baseline = &baseline
		}
		clone.records[id] = copyRecord
	}
	// Rebuild the graph in causal depth order. Every admitted non-Baseline
	// Record already has all of its parents in the source graph, so repeatedly
	// admitting a ready Record is deterministic and cannot invent new edges.
	pending := make(map[canonical.Identifier]canonical.Record)
	for id, record := range clone.records {
		if id != clone.baselineID {
			pending[id] = record
		}
	}
	for len(pending) > 0 {
		progress := false
		for id, record := range pending {
			if record.Event == nil {
				delete(pending, id)
				progress = true
				continue
			}
			ready := true
			for _, parent := range record.Event.ParentRecordIDs {
				if !clone.graph.Has(parent) {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			if err := clone.graph.Add(id, record.Event.ParentRecordIDs); err != nil {
				return clone
			}
			delete(pending, id)
			progress = true
		}
		if !progress {
			break
		}
	}
	return clone
}

func cloneFeatureManifest(manifest canonical.FeatureManifest) canonical.FeatureManifest {
	copyValue := manifest
	copyValue.Bytes = append([]byte(nil), manifest.Bytes...)
	copyValue.Parameters = append([]byte(nil), manifest.Parameters...)
	copyValue.RequiredManifestIDs = append([]canonical.Identifier(nil), manifest.RequiredManifestIDs...)
	copyValue.IncompatibleKeys = append([]string(nil), manifest.IncompatibleKeys...)
	return copyValue
}

func (r *Replica) Events() []canonical.Event {
	if r == nil {
		return nil
	}
	events := make([]canonical.Event, 0, len(r.records))
	for _, record := range r.records {
		if record.Event == nil {
			continue
		}
		event := *record.Event
		event.Bytes = append([]byte(nil), record.Event.Bytes...)
		event.ParentRecordIDs = append([]canonical.Identifier(nil), record.Event.ParentRecordIDs...)
		event.AuthorityParentIDs = append([]canonical.Identifier(nil), record.Event.AuthorityParentIDs...)
		event.Dependencies = append([]canonical.Dependency(nil), record.Event.Dependencies...)
		event.Signature = append([]byte(nil), record.Event.Signature...)
		events = append(events, event)
	}
	sort.Slice(events, func(left, right int) bool {
		return bytes.Compare(events[left].RecordID[:], events[right].RecordID[:]) < 0
	})
	return events
}

func (r *Replica) requireParents(parents []canonical.Identifier, label string) error {
	for _, parent := range parents {
		if _, ok := r.records[parent]; !ok {
			return fmt.Errorf("%s parent %x is not admitted", label, parent)
		}
	}
	return nil
}

func genesisCredential(event canonical.Event) (canonical.Identifier, []byte, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 7) {
		return canonical.Identifier{}, nil, errors.New("Genesis authority body is invalid")
	}
	certificate, ok := replicaMapEntry(body, 2)
	if !ok || !replicaMapHasKeys(certificate, 4) {
		return canonical.Identifier{}, nil, errors.New("Genesis Client Certificate is invalid")
	}
	credentialBytes, ok := replicaMapBytes(certificate, 0, 32)
	if !ok {
		return canonical.Identifier{}, nil, errors.New("Genesis Client Credential ID is invalid")
	}
	publicKey, ok := replicaMapBytes(certificate, 2, ed25519.PublicKeySize)
	if !ok {
		return canonical.Identifier{}, nil, errors.New("Genesis signing public key is invalid")
	}
	var credentialID canonical.Identifier
	copy(credentialID[:], credentialBytes)
	return credentialID, publicKey, nil
}

type enrollmentCredential struct {
	authorizationKind     uint64
	credentialID          canonical.Identifier
	memberID              canonical.Identifier
	signingPublicKey      []byte
	wrappingPublicKey     []byte
	proposalBytes         []byte
	proposalPrefixBytes   []byte
	possessionSignature   []byte
	envelopeSlots         []keyEpochEnvelopeSlot
	recoveryCredentialID  *canonical.Identifier
	recoveryAuthorization []byte
}

func parseEnrollmentCredential(event canonical.Event) (enrollmentCredential, error) {
	body, ok := replicaMapValue(event.Body)
	if !ok || !replicaMapHasKeys(body, 4) {
		return enrollmentCredential{}, errors.New("Client Enrollment body is invalid")
	}
	proposal, ok := replicaMapValue(replicaMapEntryMust(body, 0))
	if !ok || !replicaMapHasKeys(proposal, 6) {
		return enrollmentCredential{}, errors.New("Client Enrollment proposal is invalid")
	}
	proposalVaultBytes, proposalVaultOK := replicaMapBytes(proposal, 0, 32)
	proposalMemberBytes, proposalMemberOK := replicaMapBytes(proposal, 1, 32)
	proposalParentsValue, _ := replicaMapEntry(proposal, 2)
	proposalParents, proposalParentsErr := parseCanonicalIdentifierSet(proposalParentsValue, "Client Enrollment Authority Parents", true)
	if !proposalVaultOK || !proposalMemberOK || proposalParentsErr != nil || !bytes.Equal(proposalVaultBytes, event.VaultID[:]) || !identifierSlicesEqual(proposalParents, event.AuthorityParentIDs) {
		return enrollmentCredential{}, errors.New("Client Enrollment proposal context is invalid")
	}
	authorizationKind, ok := replicaMapNumber(body, 1)
	if !ok || (authorizationKind != 1 && authorizationKind != 2) {
		return enrollmentCredential{}, errors.New("Client Enrollment authorization kind is invalid")
	}
	certificate, ok := replicaMapValue(replicaMapEntryMust(proposal, 3))
	if !ok || !replicaMapHasKeys(certificate, 4) {
		return enrollmentCredential{}, errors.New("Client Enrollment certificate is invalid")
	}
	credentialBytes, ok := replicaMapBytes(certificate, 0, 32)
	if !ok {
		return enrollmentCredential{}, errors.New("Client Enrollment Credential ID is invalid")
	}
	memberBytes, ok := replicaMapBytes(certificate, 1, 32)
	if !ok {
		return enrollmentCredential{}, errors.New("Client Enrollment Member ID is invalid")
	}
	if !bytes.Equal(proposalMemberBytes, memberBytes) {
		return enrollmentCredential{}, errors.New("Client Enrollment proposal Member ID does not match its certificate")
	}
	publicKey, ok := replicaMapBytes(certificate, 2, ed25519.PublicKeySize)
	if !ok {
		return enrollmentCredential{}, errors.New("Client Enrollment signing public key is invalid")
	}
	wrappingPublicKey, ok := replicaMapBytes(certificate, 3, 32)
	if !ok {
		return enrollmentCredential{}, errors.New("Client Enrollment wrapping public key is invalid")
	}
	slotsValue, ok := replicaMapEntry(proposal, 4)
	if !ok {
		return enrollmentCredential{}, errors.New("Client Enrollment Key Envelope slots are missing")
	}
	slots, err := parseKeyEpochEnvelopeSlots(slotsValue, "Client Enrollment Key Envelope slots")
	if err != nil {
		return enrollmentCredential{}, err
	}
	for _, slot := range slots {
		if slot.targetKind != awsmClientCredentialTarget || slot.targetID != bytesIdentifier(credentialBytes) {
			return enrollmentCredential{}, errors.New("Client Enrollment Key Envelope slot target is invalid")
		}
	}
	proposalBytes, err := canonical.EncodeValue(replicaMapEntryMust(body, 0))
	if err != nil {
		return enrollmentCredential{}, errors.New("Client Enrollment proposal is not canonical")
	}
	proposalPrefix := canonical.Map{}
	for key := uint64(0); key < 5; key++ {
		value, exists := replicaMapEntry(proposal, key)
		if !exists {
			return enrollmentCredential{}, errors.New("Client Enrollment proposal prefix is incomplete")
		}
		proposalPrefix[key] = value
	}
	proposalPrefixBytes, err := canonical.EncodeValue(proposalPrefix)
	if err != nil {
		return enrollmentCredential{}, errors.New("Client Enrollment proposal prefix is not canonical")
	}
	possessionSignature, ok := replicaMapBytes(proposal, 5, ed25519.SignatureSize)
	if !ok {
		return enrollmentCredential{}, errors.New("Client Enrollment possession signature is invalid")
	}
	var recoveryCredentialID *canonical.Identifier
	var recoveryAuthorization []byte
	recoveryIDValue, recoveryIDExists := replicaMapEntry(body, 2)
	recoveryAuthorizationValue, recoveryAuthorizationExists := replicaMapEntry(body, 3)
	if authorizationKind == 1 {
		if !recoveryIDExists || !recoveryAuthorizationExists || recoveryIDValue != nil || recoveryAuthorizationValue != nil {
			return enrollmentCredential{}, errors.New("Client Enrollment recovery authorization fields are invalid")
		}
	} else {
		recoveryBytes, recoveryOK := recoveryIDValue.([]byte)
		authorizationBytes, authorizationOK := recoveryAuthorizationValue.([]byte)
		if !recoveryIDExists || !recoveryAuthorizationExists || !recoveryOK || len(recoveryBytes) != 32 || !authorizationOK || len(authorizationBytes) != ed25519.SignatureSize {
			return enrollmentCredential{}, errors.New("Client Enrollment recovery authorization is invalid")
		}
		id := bytesIdentifier(recoveryBytes)
		recoveryCredentialID = &id
		recoveryAuthorization = append([]byte(nil), authorizationBytes...)
	}
	return enrollmentCredential{
		authorizationKind:     authorizationKind,
		credentialID:          bytesIdentifier(credentialBytes),
		memberID:              bytesIdentifier(memberBytes),
		signingPublicKey:      append([]byte(nil), publicKey...),
		wrappingPublicKey:     append([]byte(nil), wrappingPublicKey...),
		proposalBytes:         proposalBytes,
		proposalPrefixBytes:   proposalPrefixBytes,
		possessionSignature:   append([]byte(nil), possessionSignature...),
		envelopeSlots:         slots,
		recoveryCredentialID:  recoveryCredentialID,
		recoveryAuthorization: recoveryAuthorization,
	}, nil
}

const awsmClientCredentialTarget uint64 = 2

func replicaMapEntryMust(value canonical.Value, key uint64) canonical.Value {
	entry, _ := replicaMapEntry(value, key)
	return entry
}

func bytesIdentifier(value []byte) canonical.Identifier {
	var identifier canonical.Identifier
	copy(identifier[:], value)
	return identifier
}

func replicaMapValue(value canonical.Value) (canonical.Value, bool) {
	switch typed := value.(type) {
	case canonical.Map:
		return typed, true
	case map[any]any:
		return typed, true
	default:
		return nil, false
	}
}

func replicaMapEntry(value canonical.Value, key uint64) (canonical.Value, bool) {
	switch typed := value.(type) {
	case canonical.Map:
		entry, ok := typed[key]
		return entry, ok
	case map[any]any:
		entry, ok := typed[key]
		return entry, ok
	default:
		return nil, false
	}
}

func replicaMapHasKeys(value canonical.Value, count int) bool {
	if _, ok := replicaMapValue(value); !ok {
		return false
	}
	for index := 0; index < count; index++ {
		if _, ok := replicaMapEntry(value, uint64(index)); !ok {
			return false
		}
	}
	switch typed := value.(type) {
	case canonical.Map:
		return len(typed) == count
	case map[any]any:
		return len(typed) == count
	default:
		return false
	}
}

func replicaMapBytes(value canonical.Value, key uint64, length int) ([]byte, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return nil, false
	}
	bytesValue, ok := entry.([]byte)
	return bytesValue, ok && len(bytesValue) == length
}

func replicaMapNumber(value canonical.Value, key uint64) (uint64, bool) {
	entry, ok := replicaMapEntry(value, key)
	if !ok {
		return 0, false
	}
	number, ok := entry.(uint64)
	return number, ok
}

func hasDependency(dependencies []canonical.Dependency, kind uint64, id canonical.Identifier) bool {
	for _, dependency := range dependencies {
		if dependency.Type == kind && dependency.ID == id {
			return true
		}
	}
	return false
}

func advanceFrontier(frontier, parents []canonical.Identifier, recordID canonical.Identifier) []canonical.Identifier {
	result := make([]canonical.Identifier, 0, len(frontier)+1)
	for _, current := range frontier {
		if !containsIdentifier(parents, current) {
			result = append(result, current)
		}
	}
	result = append(result, recordID)
	return sortUniqueIdentifiers(result)
}

func appendUniqueSorted(values []canonical.Identifier, value canonical.Identifier) []canonical.Identifier {
	return sortUniqueIdentifiers(append(append([]canonical.Identifier(nil), values...), value))
}

func sortUniqueIdentifiers(values []canonical.Identifier) []canonical.Identifier {
	result := append([]canonical.Identifier(nil), values...)
	sort.Slice(result, func(left, right int) bool { return bytes.Compare(result[left][:], result[right][:]) < 0 })
	unique := result[:0]
	for _, value := range result {
		if len(unique) == 0 || unique[len(unique)-1] != value {
			unique = append(unique, value)
		}
	}
	return unique
}

func sortedIdentifierKeys[T any](values map[canonical.Identifier]T) []canonical.Identifier {
	result := make([]canonical.Identifier, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(left, right int) bool {
		return bytes.Compare(result[left][:], result[right][:]) < 0
	})
	return result
}

func containsIdentifier(values []canonical.Identifier, target canonical.Identifier) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func cloneIdentifiers(values []canonical.Identifier) []canonical.Identifier {
	return append([]canonical.Identifier(nil), values...)
}
