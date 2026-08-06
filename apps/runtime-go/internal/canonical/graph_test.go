package canonical

import "testing"

func graphID(value byte) Identifier {
	var id Identifier
	for index := range id {
		id[index] = value + byte(index)
	}
	return id
}

func TestCausalGraphTracksBaselineCausesAndAncestors(t *testing.T) {
	graph := NewCausalGraph()
	baseline := graphID(1)
	cause := graphID(2)
	first := graphID(3)
	second := graphID(4)
	if err := graph.AddBaseline(baseline, []Identifier{cause}); err != nil {
		t.Fatalf("AddBaseline: %v", err)
	}
	if err := graph.Add(first, []Identifier{baseline}); err != nil {
		t.Fatalf("Add first: %v", err)
	}
	if err := graph.Add(second, []Identifier{first}); err != nil {
		t.Fatalf("Add second: %v", err)
	}
	if !graph.Has(cause) || !graph.Has(baseline) || !graph.IsAncestor(cause, second) || !graph.IsAncestor(baseline, second) {
		t.Fatal("graph did not preserve Baseline cause ancestry")
	}
	if graph.IsAncestor(second, first) || graph.IsAncestor(first, first) {
		t.Fatal("graph reported a reverse or reflexive ancestor")
	}
}

func TestCausalGraphRejectsCollisionsCyclesAndConflictingParents(t *testing.T) {
	graph := NewCausalGraph()
	baseline := graphID(10)
	cause := graphID(11)
	child := graphID(12)
	otherParent := graphID(13)
	if err := graph.AddBaseline(baseline, []Identifier{cause}); err != nil {
		t.Fatalf("AddBaseline: %v", err)
	}
	if err := graph.AddBaseline(graphID(14), []Identifier{cause}); err == nil {
		t.Fatal("graph accepted a Baseline cause collision")
	}
	if err := graph.Add(child, []Identifier{baseline}); err != nil {
		t.Fatalf("Add child: %v", err)
	}
	if err := graph.Add(child, []Identifier{otherParent}); err == nil {
		t.Fatal("graph accepted a Record ID with different parents")
	}
	if err := graph.Add(baseline, []Identifier{child}); err == nil {
		t.Fatal("graph accepted a Baseline cycle")
	}
	if err := graph.Add(graphID(15), []Identifier{graphID(15)}); err == nil {
		t.Fatal("graph accepted a self-cycle")
	}
}

func TestCausalGraphRejectsDuplicateBaselineCauses(t *testing.T) {
	graph := NewCausalGraph()
	if err := graph.AddBaseline(graphID(20), []Identifier{graphID(21), graphID(21)}); err == nil {
		t.Fatal("graph accepted duplicate Baseline causes")
	}
}
