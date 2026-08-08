package vault

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
	"golang.org/x/text/unicode/norm"
)

// SearchResult is a Client-facing result from the disposable local Search
// projection. Search never changes the authenticated Replica.
type SearchResult struct {
	Kind      string  `json:"kind"`
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	PassageID string  `json:"passageId"`
	Snippet   string  `json:"snippet"`
	Score     float64 `json:"score"`
}

type SearchCoverage struct {
	EligibleCaptures        int `json:"eligibleCaptures"`
	IndexedCaptures         int `json:"indexedCaptures"`
	UnavailableHeavyContent int `json:"unavailableHeavyContent"`
	FailedCaptures          int `json:"failedCaptures"`
}

type searchQuery struct {
	query          string
	scope          string
	hosts          map[string]struct{}
	collectionIDs  map[string]struct{}
	tagIDs         map[string]struct{}
	capturedFrom   *int64
	capturedBefore *int64
}

type searchField struct {
	kind      string
	text      string
	tokens    []string
	passageID string
}

type searchDocument struct {
	kind          string
	id            string
	status        string
	title         string
	host          string
	capturedAt    *int64
	collectionIDs map[string]struct{}
	tagIDs        map[string]struct{}
	fields        []searchField
}

type parsedSearchQuery struct {
	terms   []string
	phrases [][]string
}

const searchMaterializationStatePrefix = "awsm.runtime.search."

type persistedSearchMaterialization struct {
	Context   string                    `json:"context"`
	Documents []persistedSearchDocument `json:"documents"`
	Coverage  SearchCoverage            `json:"coverage"`
}

type persistedSearchDocument struct {
	Kind          string                 `json:"kind"`
	ID            string                 `json:"id"`
	Status        string                 `json:"status"`
	Title         string                 `json:"title"`
	Host          string                 `json:"host"`
	CapturedAt    *int64                 `json:"capturedAt"`
	CollectionIDs []string               `json:"collectionIds"`
	TagIDs        []string               `json:"tagIds"`
	Fields        []persistedSearchField `json:"fields"`
}

type persistedSearchField struct {
	Kind      string   `json:"kind"`
	Text      string   `json:"text"`
	Tokens    []string `json:"tokens"`
	PassageID string   `json:"passageId"`
}

func (r *Runtime) searchProjection(ctx context.Context, id string, input searchQuery) ([]SearchResult, SearchCoverage, error) {
	documents, coverage, err := r.loadSearchMaterialization(ctx, id)
	if err != nil {
		return nil, SearchCoverage{}, err
	}
	parsed, err := parseSearchQuery(input.query)
	if err != nil {
		return nil, SearchCoverage{}, commandError("SEARCH_QUERY_INVALID", err.Error())
	}
	return querySearchDocuments(documents, parsed, input), coverage, nil
}

func (r *Runtime) loadSearchMaterialization(ctx context.Context, id string) ([]searchDocument, SearchCoverage, error) {
	contextID, err := r.searchMaterializationContext(id)
	if err != nil {
		return nil, SearchCoverage{}, err
	}
	key := searchMaterializationStatePrefix + id
	if encoded, getErr := r.store.Get(ctx, key); getErr == nil {
		var cached persistedSearchMaterialization
		if json.Unmarshal(encoded, &cached) == nil && cached.Context == contextID {
			return restoreSearchDocuments(cached.Documents), cached.Coverage, nil
		}
	} else if !errors.Is(getErr, store.ErrStateNotFound) {
		return nil, SearchCoverage{}, commandError("SEARCH_UNAVAILABLE", "The local Search projection could not be read.")
	}
	projection, err := r.readLibraryProjection(id)
	if err != nil {
		return nil, SearchCoverage{}, err
	}
	documents, err := buildSearchDocuments(projection)
	if err != nil {
		return nil, SearchCoverage{}, commandError("SEARCH_UNAVAILABLE", "The local Search projection could not be built.")
	}
	cached := persistedSearchMaterialization{
		Context:   contextID,
		Documents: persistSearchDocuments(documents),
		Coverage: SearchCoverage{
			EligibleCaptures:        len(projection.Captures),
			IndexedCaptures:         len(projection.Captures),
			UnavailableHeavyContent: len(projection.Captures),
		},
	}
	encoded, err := json.Marshal(cached)
	if err != nil {
		return nil, SearchCoverage{}, commandError("SEARCH_UNAVAILABLE", "The local Search projection could not be encoded.")
	}
	if err := r.store.Put(ctx, key, encoded); err != nil {
		return nil, SearchCoverage{}, commandError("SEARCH_UNAVAILABLE", "The local Search projection could not be stored.")
	}
	return documents, cached.Coverage, nil
}

func persistSearchDocuments(documents []searchDocument) []persistedSearchDocument {
	result := make([]persistedSearchDocument, 0, len(documents))
	for _, document := range documents {
		collectionIDs := make([]string, 0, len(document.collectionIDs))
		for id := range document.collectionIDs {
			collectionIDs = append(collectionIDs, id)
		}
		tagIDs := make([]string, 0, len(document.tagIDs))
		for id := range document.tagIDs {
			tagIDs = append(tagIDs, id)
		}
		sort.Strings(collectionIDs)
		sort.Strings(tagIDs)
		fields := make([]persistedSearchField, 0, len(document.fields))
		for _, field := range document.fields {
			fields = append(fields, persistedSearchField{Kind: field.kind, Text: field.text, Tokens: field.tokens, PassageID: field.passageID})
		}
		result = append(result, persistedSearchDocument{Kind: document.kind, ID: document.id, Status: document.status, Title: document.title, Host: document.host, CapturedAt: document.capturedAt, CollectionIDs: collectionIDs, TagIDs: tagIDs, Fields: fields})
	}
	return result
}

func restoreSearchDocuments(documents []persistedSearchDocument) []searchDocument {
	result := make([]searchDocument, 0, len(documents))
	for _, document := range documents {
		collectionIDs := make(map[string]struct{}, len(document.CollectionIDs))
		for _, id := range document.CollectionIDs {
			collectionIDs[id] = struct{}{}
		}
		tagIDs := make(map[string]struct{}, len(document.TagIDs))
		for _, id := range document.TagIDs {
			tagIDs[id] = struct{}{}
		}
		fields := make([]searchField, 0, len(document.Fields))
		for _, field := range document.Fields {
			fields = append(fields, searchField{kind: field.Kind, text: field.Text, tokens: field.Tokens, passageID: field.PassageID})
		}
		result = append(result, searchDocument{kind: document.Kind, id: document.ID, status: document.Status, title: document.Title, host: document.Host, capturedAt: document.CapturedAt, collectionIDs: collectionIDs, tagIDs: tagIDs, fields: fields})
	}
	return result
}

func (r *Runtime) searchMaterializationContext(id string) (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if err := r.requireExpectedLocked(&id); err != nil {
		return "", err
	}
	vault, ok := r.vaults[id]
	if !ok || r.replicas[id] == nil {
		return "", commandError("VAULT_NOT_FOUND", "The selected Vault was not found.")
	}
	state := r.replicas[id].State()
	value, err := json.Marshal(struct {
		GenerationID string   `json:"generationId"`
		Frontier     []string `json:"frontier"`
	}{
		GenerationID: vault.GenerationID,
		Frontier:     identifiersHex(state.CausalFrontier),
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(value)
	return hexBytes(digest[:]), nil
}

func identifiersHex(values []canonical.Identifier) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = hexIdentifier(value)
	}
	return result
}
func makeSearchQuery(scope, query string, hosts, collectionIDs, tagIDs []string, capturedFrom, capturedBefore *int64) (searchQuery, error) {
	if scope != "Active" && scope != "Deleted" {
		return searchQuery{}, commandError("SEARCH_QUERY_INVALID", "Search scope must be Active or Deleted.")
	}
	toSet := func(values []string, kind string) (map[string]struct{}, error) {
		result := make(map[string]struct{}, len(values))
		for _, value := range values {
			if _, err := decodeHexIdentifier(value); err != nil {
				return nil, commandError("SEARCH_QUERY_INVALID", fmt.Sprintf("The %s filter identity is invalid.", kind))
			}
			result[value] = struct{}{}
		}
		return result, nil
	}
	collections, err := toSet(collectionIDs, "Collection")
	if err != nil {
		return searchQuery{}, err
	}
	tags, err := toSet(tagIDs, "Tag")
	if err != nil {
		return searchQuery{}, err
	}
	hostSet := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		hostSet[strings.ToLower(strings.TrimSpace(host))] = struct{}{}
	}
	return searchQuery{query: query, scope: scope, hosts: hostSet, collectionIDs: collections, tagIDs: tags, capturedFrom: capturedFrom, capturedBefore: capturedBefore}, nil
}

func buildSearchDocuments(projection LibraryProjection) ([]searchDocument, error) {
	documents := make([]searchDocument, 0, len(projection.Captures)+len(projection.Collections)+len(projection.Notes))
	for _, capture := range projection.Captures {
		collection, collectionOK := findCollection(projection.Collections, capture.CollectionID)
		title := capture.OriginalURL
		if capture.Title != nil && strings.TrimSpace(*capture.Title) != "" {
			title = *capture.Title
		}
		host := ""
		if parsed, err := url.Parse(capture.FinalURL); err == nil {
			host = strings.ToLower(parsed.Hostname())
		}
		collectionIDs := map[string]struct{}{capture.CollectionID: {}}
		tagIDs := searchTargetTags(projection, 2, capture.BundleID)
		if collectionOK {
			for tagID := range searchTargetTags(projection, 1, collection.CollectionID) {
				tagIDs[tagID] = struct{}{}
			}
		}
		organization := ""
		if collectionOK {
			organization = collection.Title
		}
		organization += " " + searchTagNames(projection, tagIDs)
		fields, err := makeSearchFields("Capture", capture.BundleID, []searchFieldDraft{
			{kind: "Title", text: title},
			{kind: "Url", text: capture.OriginalURL + " " + capture.FinalURL},
			{kind: "Organization", text: organization},
		})
		if err != nil {
			return nil, err
		}
		capturedAt := capture.CapturedAt
		documents = append(documents, searchDocument{
			kind: "Capture", id: capture.BundleID, status: capture.Lifecycle, title: normalizeSearchText(title),
			host: host, capturedAt: &capturedAt, collectionIDs: collectionIDs, tagIDs: tagIDs, fields: fields,
		})
	}
	for _, collection := range projection.Collections {
		tagIDs := searchTargetTags(projection, 1, collection.CollectionID)
		fields, err := makeSearchFields("Collection", collection.CollectionID, []searchFieldDraft{
			{kind: "Title", text: collection.Title},
			{kind: "Organization", text: searchTagNames(projection, tagIDs)},
		})
		if err != nil {
			return nil, err
		}
		documents = append(documents, searchDocument{
			kind: "Collection", id: collection.CollectionID, status: "Active", title: normalizeSearchText(collection.Title),
			collectionIDs: map[string]struct{}{collection.CollectionID: {}}, tagIDs: tagIDs, fields: fields,
		})
	}
	for _, note := range projection.Notes {
		collectionID := ""
		var capture *LibraryItem
		if note.TargetKind == 1 {
			collectionID = note.TargetID
		} else if note.TargetKind == 2 {
			for index := range projection.Captures {
				if projection.Captures[index].BundleID == note.TargetID {
					capture = &projection.Captures[index]
					collectionID = capture.CollectionID
					break
				}
			}
		}
		tagIDs := searchTargetTags(projection, note.TargetKind, note.TargetID)
		if collectionID != "" {
			for tagID := range searchTargetTags(projection, 1, collectionID) {
				tagIDs[tagID] = struct{}{}
			}
		}
		drafts := make([]searchFieldDraft, 0, len(note.Versions)*2+1)
		title := "Note"
		for _, version := range note.Versions {
			if version.Title != nil {
				drafts = append(drafts, searchFieldDraft{kind: "Title", text: *version.Title})
				if title == "Note" {
					title = *version.Title
				}
			}
			if version.Body != nil {
				drafts = append(drafts, searchFieldDraft{kind: "Body", text: *version.Body})
			}
		}
		drafts = append(drafts, searchFieldDraft{kind: "Organization", text: searchTagNames(projection, tagIDs)})
		fields, err := makeSearchFields("Note", note.NoteID, drafts)
		if err != nil {
			return nil, err
		}
		var host string
		var capturedAt *int64
		if capture != nil {
			if parsed, parseErr := url.Parse(capture.FinalURL); parseErr == nil {
				host = strings.ToLower(parsed.Hostname())
			}
			value := capture.CapturedAt
			capturedAt = &value
		}
		collections := map[string]struct{}{}
		if collectionID != "" {
			collections[collectionID] = struct{}{}
		}
		documents = append(documents, searchDocument{
			kind: "Note", id: note.NoteID, status: noteSearchStatus(note.State), title: normalizeSearchText(title),
			host: host, capturedAt: capturedAt, collectionIDs: collections, tagIDs: tagIDs, fields: fields,
		})
	}
	sort.Slice(documents, func(left, right int) bool {
		kindRank := map[string]int{"Capture": 1, "Collection": 2, "Note": 3}
		return kindRank[documents[left].kind] < kindRank[documents[right].kind] ||
			(kindRank[documents[left].kind] == kindRank[documents[right].kind] && documents[left].id < documents[right].id)
	})
	return documents, nil
}

type searchFieldDraft struct{ kind, text string }

func findCollection(collections []LibraryCollection, id string) (LibraryCollection, bool) {
	for _, collection := range collections {
		if collection.CollectionID == id {
			return collection, true
		}
	}
	return LibraryCollection{}, false
}

func noteSearchStatus(state string) string {
	if state == "Deleted" {
		return "Deleted"
	}
	return "Active"
}

func searchTargetTags(projection LibraryProjection, targetKind uint64, targetID string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, assignment := range projection.TagAssignments {
		if !assignment.Active || assignment.TargetKind != targetKind || assignment.TargetID != targetID {
			continue
		}
		current := assignment.TagID
		seen := make(map[string]struct{})
		for current != "" {
			if _, ok := seen[current]; ok {
				break
			}
			seen[current] = struct{}{}
			result[current] = struct{}{}
			next := ""
			for _, tag := range projection.Tags {
				if tag.TagID == current && tag.RedirectedTo != nil {
					next = *tag.RedirectedTo
					break
				}
			}
			current = next
		}
	}
	return result
}

func searchTagNames(projection LibraryProjection, ids map[string]struct{}) string {
	names := make([]string, 0, len(ids))
	for id := range ids {
		for _, tag := range projection.Tags {
			if tag.TagID == id && tag.Lifecycle == "Active" {
				names = append(names, tag.Name)
				break
			}
		}
	}
	sort.Strings(names)
	return strings.Join(names, " ")
}

func makeSearchFields(kind, id string, drafts []searchFieldDraft) ([]searchField, error) {
	fields := make([]searchField, 0, len(drafts))
	identifier, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, fmt.Errorf("Search identity is invalid: %w", err)
	}
	passageIndex := 0
	for _, draft := range drafts {
		for _, passage := range searchPassages(draft.text) {
			tokens := tokenizeSearchText(passage)
			if len(tokens) == 0 {
				continue
			}
			value, err := canonical.EncodeValue(canonical.Map{0: "awsm.search.passage", 1: uint64(1), 2: searchKindCode(kind), 3: identifier[:], 4: uint64(passageIndex), 5: searchFieldCode(draft.kind), 6: passage})
			if err != nil {
				return nil, err
			}
			digest := sha256.Sum256(value)
			fields = append(fields, searchField{kind: draft.kind, text: passage, tokens: tokens, passageID: hexBytes(digest[:])})
			passageIndex++
		}
	}
	return fields, nil
}

func searchKindCode(kind string) uint64 {
	switch kind {
	case "Capture":
		return 1
	case "Collection":
		return 2
	default:
		return 3
	}
}
func searchFieldCode(kind string) uint64 {
	switch kind {
	case "Title":
		return 1
	case "Url":
		return 2
	case "Organization":
		return 3
	default:
		return 4
	}
}

func searchPassages(value string) []string {
	words := strings.Fields(normalizeSearchText(value))
	if len(words) == 0 {
		return nil
	}
	result := make([]string, 0, (len(words)+159)/160)
	for start := 0; start < len(words); {
		if len(words[start]) > 768 {
			result = append(result, splitSearchWord(words[start])...)
			start++
			continue
		}
		end := start
		bytes := 0
		for end < len(words) && end-start < 160 {
			candidate := len(words[end])
			if end > start {
				candidate++
			}
			if bytes+candidate > 768 && end > start {
				break
			}
			bytes += candidate
			end++
		}
		result = append(result, strings.Join(words[start:end], " "))
		start = end
	}
	return result
}

func splitSearchWord(value string) []string {
	parts := make([]string, 0, (len(value)+767)/768)
	current := ""
	for _, scalar := range value {
		candidate := current + string(scalar)
		if len(candidate) > 768 {
			if current == "" {
				return nil
			}
			parts = append(parts, current)
			current = string(scalar)
		} else {
			current = candidate
		}
	}
	if current != "" {
		parts = append(parts, current)
	}
	return parts
}

func normalizeSearchText(value string) string {
	return strings.TrimSpace(strings.Join(strings.Fields(norm.NFC.String(value)), " "))
}

func tokenizeSearchText(value string) []string {
	result := make([]string, 0)
	var current []rune
	flush := func() {
		if len(current) > 0 {
			result = append(result, string(current))
			current = nil
		}
	}
	for _, scalar := range strings.ToLower(value) {
		if unicode.IsLetter(scalar) || unicode.IsMark(scalar) || unicode.IsNumber(scalar) {
			current = append(current, scalar)
		} else {
			flush()
		}
	}
	flush()
	return result
}

func parseSearchQuery(value string) (parsedSearchQuery, error) {
	value = strings.TrimSpace(norm.NFC.String(value))
	if value == "" || utf16Length(value) > 1024 {
		return parsedSearchQuery{}, fmt.Errorf("Search query must contain 1 through 1,024 characters.")
	}
	var terms []string
	var phrases [][]string
	for index := 0; index < len(value); {
		for index < len(value) {
			scalar, size := utf8.DecodeRuneInString(value[index:])
			if !unicode.IsSpace(scalar) {
				break
			}
			index += size
		}
		if index >= len(value) {
			break
		}
		quoted := value[index] == '"'
		if quoted {
			index++
		}
		start := index
		if quoted {
			closing := strings.IndexByte(value[index:], '"')
			if closing < 0 {
				quoted = false
				start--
				index = len(value)
			} else {
				index += closing
			}
		} else {
			for index < len(value) {
				scalar, size := utf8.DecodeRuneInString(value[index:])
				if unicode.IsSpace(scalar) {
					break
				}
				index += size
			}
		}
		part := value[start:index]
		if quoted && index < len(value) && value[index] == '"' {
			index++
		}
		tokens := tokenizeSearchText(part)
		if quoted && len(tokens) > 0 {
			phrases = append(phrases, tokens)
		} else {
			terms = append(terms, tokens...)
		}
	}
	if len(terms) == 0 && len(phrases) == 0 {
		return parsedSearchQuery{}, fmt.Errorf("Search query must contain a letter, mark, or number.")
	}
	terms = uniqueSearchStrings(terms)
	return parsedSearchQuery{terms: terms, phrases: phrases}, nil
}

func utf16Length(value string) int { return len(utf16.Encode([]rune(value))) }

func uniqueSearchStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; !ok {
			seen[value] = struct{}{}
			result = append(result, value)
		}
	}
	return result
}

func querySearchDocuments(documents []searchDocument, query parsedSearchQuery, input searchQuery) []SearchResult {
	eligible := make([]searchDocument, 0, len(documents))
	for _, document := range documents {
		if document.status != input.scope || (len(input.hosts) > 0 && !containsSearch(input.hosts, document.host)) || !matchesIDs(input.collectionIDs, document.collectionIDs) || !matchesAllIDs(input.tagIDs, document.tagIDs) || !matchesSearchDates(document, input) {
			continue
		}
		eligible = append(eligible, document)
	}
	terms := uniqueSearchStrings(append(append([]string{}, query.terms...), flattenSearch(query.phrases)...))
	documentFrequency := make(map[string]int)
	for _, document := range eligible {
		present := map[string]struct{}{}
		for _, field := range document.fields {
			for _, token := range field.tokens {
				present[token] = struct{}{}
			}
		}
		for term := range present {
			documentFrequency[term]++
		}
	}
	average := map[string]float64{}
	for _, kind := range []string{"Title", "Url", "Organization", "Body"} {
		total := 0
		for _, document := range eligible {
			for _, field := range document.fields {
				if field.kind == kind {
					total += len(field.tokens)
				}
			}
		}
		if len(eligible) > 0 {
			average[kind] = float64(total) / float64(len(eligible))
		}
	}
	results := make([]SearchResult, 0)
	for _, document := range eligible {
		if !matchesSearchText(document, query) {
			continue
		}
		score := 0.0
		best := searchField{}
		bestContribution := 0.0
		for _, term := range terms {
			weighted := 0.0
			type searchGroup struct {
				frequency, length int
				normalized        float64
			}
			groups := map[string]searchGroup{}
			weights := map[string]float64{"Title": 5, "Url": 3, "Organization": 2, "Body": 1}
			for kind := range weights {
				frequency := 0
				length := 0
				for _, field := range document.fields {
					if field.kind == kind {
						frequency += countSearchToken(field.tokens, term)
						length += len(field.tokens)
					}
				}
				avg := average[kind]
				if frequency == 0 || avg == 0 {
					continue
				}
				normalized := weights[kind] * float64(frequency) / (0.25 + 0.75*float64(length)/avg)
				groups[kind] = searchGroup{frequency: frequency, length: length, normalized: normalized}
				weighted += normalized
			}
			if weighted == 0 {
				continue
			}
			frequency := documentFrequency[term]
			termScore := (searchIDF(len(eligible), frequency) * weighted * 2.2) / (weighted + 1.2)
			score += termScore
			for _, field := range document.fields {
				local := countSearchToken(field.tokens, term)
				if local == 0 {
					continue
				}
				group := groups[field.kind]
				contribution := termScore * (group.normalized / weighted) * (float64(local) / float64(group.frequency))
				if contribution > bestContribution || (contribution == bestContribution && field.passageID < best.passageID) {
					best = field
					bestContribution = contribution
				}
			}
		}
		if score <= 0 || best.passageID == "" {
			continue
		}
		results = append(results, SearchResult{Kind: document.kind, ID: document.id, Title: document.title, PassageID: best.passageID, Snippet: escapeSearchSnippet(best.text), Score: score})
	}
	sort.Slice(results, func(left, right int) bool {
		return results[left].Score > results[right].Score || (results[left].Score == results[right].Score && results[left].ID < results[right].ID)
	})
	if len(results) > 200 {
		results = results[:200]
	}
	return results
}

func flattenSearch(values [][]string) []string {
	result := []string{}
	for _, value := range values {
		result = append(result, value...)
	}
	return result
}
func containsSearch(values map[string]struct{}, value string) bool { _, ok := values[value]; return ok }
func matchesIDs(filters map[string]struct{}, values map[string]struct{}) bool {
	if len(filters) == 0 {
		return true
	}
	for filter := range filters {
		if _, ok := values[filter]; ok {
			return true
		}
	}
	return false
}
func matchesAllIDs(filters map[string]struct{}, values map[string]struct{}) bool {
	for filter := range filters {
		if _, ok := values[filter]; !ok {
			return false
		}
	}
	return true
}
func matchesSearchDates(document searchDocument, input searchQuery) bool {
	if input.capturedFrom != nil && (document.capturedAt == nil || *document.capturedAt < *input.capturedFrom) {
		return false
	}
	if input.capturedBefore != nil && (document.capturedAt == nil || *document.capturedAt >= *input.capturedBefore) {
		return false
	}
	return true
}
func matchesSearchText(document searchDocument, query parsedSearchQuery) bool {
	for _, phrase := range query.phrases {
		matched := false
		for _, field := range document.fields {
			if containsTokenSequence(field.tokens, phrase) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if len(query.terms) > 0 {
		for _, term := range query.terms {
			found := false
			for _, field := range document.fields {
				if countSearchToken(field.tokens, term) > 0 {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	return true
}
func containsTokenSequence(values, expected []string) bool {
	if len(expected) == 0 || len(expected) > len(values) {
		return false
	}
	for start := 0; start+len(expected) <= len(values); start++ {
		matched := true
		for offset := range expected {
			if values[start+offset] != expected[offset] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}
func countSearchToken(values []string, expected string) int {
	count := 0
	for _, value := range values {
		if value == expected {
			count++
		}
	}
	return count
}
func searchIDF(total, frequency int) float64 {
	return logSearch(1 + (float64(total)-float64(frequency)+0.5)/(float64(frequency)+0.5))
}
func logSearch(value float64) float64 { return math.Log(value) }
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func escapeSearchSnippet(value string) string {
	var output strings.Builder
	for _, character := range value {
		escaped := string(character)
		switch character {
		case '&':
			escaped = "&amp;"
		case '<':
			escaped = "&lt;"
		case '>':
			escaped = "&gt;"
		case '"':
			escaped = "&quot;"
		case '\'':
			escaped = "&#39;"
		}
		if output.Len()+len(escaped) > 240 {
			return output.String() + "…"
		}
		output.WriteString(escaped)
	}
	return output.String()
}

func hexBytes(value []byte) string {
	const hex = "0123456789abcdef"
	output := make([]byte, len(value)*2)
	for index, item := range value {
		output[index*2] = hex[item>>4]
		output[index*2+1] = hex[item&15]
	}
	return string(output)
}
