package canonical

import (
	"bytes"
	"errors"
)

// CausalGraph is the immutable-record relationship index used by replay and
// reducers. Baseline causes are virtual roots: they identify state checkpoint
// facts without pretending to be Vault Records.
type CausalGraph struct {
	parents             map[Identifier][]Identifier
	baselineRootByCause map[Identifier]Identifier
}

func NewCausalGraph() *CausalGraph {
	return &CausalGraph{
		parents:             make(map[Identifier][]Identifier),
		baselineRootByCause: make(map[Identifier]Identifier),
	}
}

func (graph *CausalGraph) AddBaseline(baselineID Identifier, causeIDs []Identifier) error {
	if graph == nil {
		return errors.New("causal graph is required")
	}
	if err := validateIdentifierSet(causeIDs, "Baseline causes"); err != nil {
		return err
	}
	for _, causeID := range causeIDs {
		if causeID == baselineID || graph.hasRecord(causeID) {
			return errors.New("Baseline cause collides with another causal identity")
		}
		if existing, ok := graph.baselineRootByCause[causeID]; ok && existing != baselineID {
			return errors.New("Baseline cause belongs to another Baseline")
		}
	}
	if err := graph.Add(baselineID, nil); err != nil {
		return err
	}
	for _, causeID := range causeIDs {
		graph.baselineRootByCause[causeID] = baselineID
	}
	return nil
}

func (graph *CausalGraph) Add(recordID Identifier, parentRecordIDs []Identifier) error {
	if graph == nil {
		return errors.New("causal graph is required")
	}
	if err := validateIdentifierSet(parentRecordIDs, "causal parents"); err != nil {
		return err
	}
	if _, isCause := graph.baselineRootByCause[recordID]; isCause {
		return errors.New("Record ID collides with a Baseline cause")
	}
	if existing, ok := graph.parents[recordID]; ok {
		if !sameIdentifierSet(existing, parentRecordIDs) {
			return errors.New("one Record ID cannot claim two causal parent sets")
		}
		return nil
	}
	for _, parentID := range parentRecordIDs {
		if parentID == recordID || graph.IsAncestor(recordID, parentID) {
			return errors.New("Record would create a causal cycle")
		}
	}
	graph.parents[recordID] = append([]Identifier(nil), parentRecordIDs...)
	return nil
}

func (graph *CausalGraph) Has(recordID Identifier) bool {
	if graph == nil {
		return false
	}
	return graph.hasRecord(recordID) || graph.hasCause(recordID)
}

func (graph *CausalGraph) IsAncestor(ancestorID, descendantID Identifier) bool {
	if graph == nil || ancestorID == descendantID {
		return false
	}
	target := ancestorID
	if baseline, ok := graph.baselineRootByCause[ancestorID]; ok {
		target = baseline
		if target == descendantID {
			return true
		}
	}
	pending := append([]Identifier(nil), graph.parents[descendantID]...)
	visited := make(map[Identifier]struct{}, len(pending))
	for len(pending) > 0 {
		last := len(pending) - 1
		current := pending[last]
		pending = pending[:last]
		if current == target {
			return true
		}
		if _, ok := visited[current]; ok {
			continue
		}
		visited[current] = struct{}{}
		pending = append(pending, graph.parents[current]...)
	}
	return false
}

func (graph *CausalGraph) hasRecord(recordID Identifier) bool {
	_, ok := graph.parents[recordID]
	return ok
}

func (graph *CausalGraph) hasCause(recordID Identifier) bool {
	_, ok := graph.baselineRootByCause[recordID]
	return ok
}

func sameIdentifierSet(left, right []Identifier) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[Identifier]struct{}, len(left))
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

func compareIdentifier(left, right Identifier) int {
	return bytes.Compare(left[:], right[:])
}
