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
		vaultID:        baseline.VaultID,
		generationID:   baseline.GenerationID,
		baseline:       decoded,
		baselineID:     baseline.RecordID,
		records:        map[canonical.Identifier]canonical.Record{baseline.RecordID: {Kind: canonical.BaselineKind, Baseline: &decoded, Bytes: append([]byte(nil), decoded.Bytes...), RecordID: decoded.RecordID}},
		graph:          graph,
		credentialKeys: make(map[canonical.Identifier]ed25519.PublicKey),
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
		if !ok || !bytes.Equal(acceptedKey, signerPublicKey) {
			return errors.New("Event signer Credential is not accepted")
		}
	}
	if err := r.graph.Add(decoded.RecordID, decoded.ParentRecordIDs); err != nil {
		return fmt.Errorf("add Event to causal DAG: %w", err)
	}
	r.records[decoded.RecordID] = canonical.Record{Kind: canonical.EventKind, Event: &decoded, Bytes: append([]byte(nil), decoded.Bytes...), RecordID: decoded.RecordID}
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
	if !ok {
		return errors.New("Event signer Credential is not accepted")
	}
	return r.AdmitEvent(event, key)
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
	}
	for id, key := range r.credentialKeys {
		clone.credentialKeys[id] = append(ed25519.PublicKey(nil), key...)
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
