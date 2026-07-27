# Hybrid Local-First Search

**Document:** `docs/plans/18-hybrid-local-first-search.md`

**Status:** Approved implementation plan

**Owner:** Engineering

**Last Updated:** 2026-07-26

**Depends On:** `AGENTS.md`, `DESIGN.md`, `README.md`, `ROADMAP.md`,
`docs/architecture/03-zero-knowledge.md`, `docs/architecture/04-security-model.md`,
`docs/architecture/09-event-model.md`, `docs/architecture/10-projection-engine.md`,
`docs/architecture/11-search.md`, `docs/architecture/13-capture-pipeline.md`,
`docs/architecture/17-extension-framework.md`,
`docs/architecture/19-testing-strategy.md`,
`docs/specifications/bundle/artifact.md`,
`docs/specifications/crypto/key-derivation.md`,
`docs/specifications/runtime/ai.md`, `docs/specifications/runtime/jobs.md`,
`docs/specifications/runtime/search.md`, and
`docs/plans/16-product-design-system-landing-and-surface-redesign.md`

---

# 1. Purpose

This is the decision-complete implementation plan for adding one unified hybrid Search experience
to the AWSM Library. It is written for an implementer starting from a cold checkout with no
conversation context. Do not reopen the fixed product, ranking, provider, privacy, model, lifecycle,
or interface decisions recorded here.

The completed work SHALL:

1. add a persistent Search field to the Library;
2. return Captures with their best matching passage;
3. combine deterministic keyword and semantic retrieval in one ranked result list;
4. preserve useful keyword Search when semantic Search is unconfigured, incomplete, offline, or
   unavailable;
5. keep all Search projections encrypted, local, disposable, and excluded from synchronization,
   Export, Import, and backup packages;
6. support a local English-first MiniLM embedding model downloaded only after explicit user action;
7. support an advanced, explicit, bring-your-own-key remote embedding adapter that implements the
   narrow OpenAI-compatible contract in this plan;
8. make remote disclosure, permission, model identity, dimensions, and indexing coverage visible;
9. index incrementally and resumably only while the unlocked Library is open and visible;
10. target a Vault containing 10,000 Captures without loading the entire corpus into memory;
11. open a result in Capture detail and focus the matched passage;
12. keep query text, result snippets, rankings, and Search history out of persistent storage and
    URLs; and
13. retain Chrome and Firefox production-build parity.

Search Projection Materializations are derived data. Authoritative Objects, Events,
`CONTENT_STRUCTURED`, and `TEXT_EXTRACTED` Artifacts remain unchanged.

# 2. Fixed Decisions, Scope, and Deferrals

## 2.1 Fixed product decisions

The following decisions are final for this plan:

| Concern              | Decision                                                             |
| -------------------- | -------------------------------------------------------------------- |
| Search experience    | One unified hybrid result list                                       |
| Result unit          | Capture plus its best passage                                        |
| Query execution      | Explicit submit with Enter or the Search button                      |
| Semantic default     | Not configured until the user chooses a provider                     |
| Default setup choice | Local MiniLM shown first                                             |
| Remote setup         | Advanced, explicit, OpenAI-compatible, bring-your-own-key            |
| Local model download | On demand only                                                       |
| Local model          | Apache-2.0 `Xenova/all-MiniLM-L6-v2`, pinned by immutable revision   |
| Local language scope | English first                                                        |
| Local dimensions     | 384                                                                  |
| Remote dimensions    | Provider-discovered and optionally user-selected                     |
| Settings scope       | Per Vault                                                            |
| Index lifecycle      | Resumable, while the unlocked Library is open and visible            |
| Partial coverage     | Allowed and labeled with exact completed and eligible Capture counts |
| Filters              | Host, captured date, and Collection                                  |
| Active or Deleted    | Inherited from the current Library section                           |
| Page size            | 50 results, followed by **Load more**                                |
| Exact matches        | Exact title, canonical URL, and balanced quoted phrase matches pin   |
| Semantic behavior    | Retrieval only                                                       |
| Result action        | Open Capture detail and focus the matched passage                    |
| Performance target   | 10,000 Captures per Vault                                            |
| WebGPU               | Deferred; use CPU/WASM for cross-browser parity                      |
| Future models        | Curated, user-selectable per-Vault profiles on the Roadmap           |

“Pinned” means exact matches form a deterministic tier before fused relevance. It does not mean
that exact results are repeated in the ordinary tier.

## 2.2 In scope

This plan includes:

- a deterministic Search document and passage builder;
- an encrypted keyword materialization;
- a keyword provider with field-weighted BM25 and phrase matching;
- a provider-independent semantic interface;
- the pinned local MiniLM provider;
- the strict remote embedding provider;
- encrypted signed-int8 passage vectors and per-Capture centroids;
- hybrid rank fusion;
- Search filtering, paging, and coverage reporting;
- a restart-safe per-Vault Search indexing Job;
- local model download, verification, caching, and removal;
- provider configuration, consent, permissions, and secret handling;
- Library Search UI, settings, progress, errors, and accessibility;
- result-to-detail passage focus;
- schema, Runtime protocol, diagnostics, tests, release checks, public documentation, and Roadmap
  reconciliation.

## 2.3 Explicitly deferred

Do not implement any of the following:

- retrieval-augmented generation, answers, summaries, chat, citations, or generated prose;
- image, screenshot, OCR, handwriting, audio, or video similarity;
- multilingual normalization or a multilingual default model;
- stemming, fuzzy spelling correction, prefix-as-you-type Search, or saved Search queries;
- semantic Search on every keystroke;
- Search query persistence, recent Search, analytics, telemetry, or server-side query logs;
- synchronization of Search settings, projections, vectors, or provider credentials;
- automatic remote provider fallback or automatic local-to-remote fallback;
- mixing vectors created by different provider identities;
- user-supplied arbitrary local models or executable model code;
- WebGPU execution;
- approximate-nearest-neighbor graph persistence;
- tag query syntax or a general query language;
- plugin Search providers;
- cross-Vault Search; or
- pre-release database migrations.

The Roadmap follow-up may describe curated local model profiles. It SHALL NOT promise arbitrary
model loading.

## 2.4 Licensing and provenance gate

The first local model and Runtime dependency are acceptable only under the following fixed gate:

| Item                               | Required license | Required treatment                          |
| ---------------------------------- | ---------------- | ------------------------------------------- |
| `@huggingface/transformers`        | Apache-2.0       | Pin exact package version and retain notice |
| `@noble/hashes`                    | MIT              | Pin exact package version and retain notice |
| `Xenova/all-MiniLM-L6-v2`          | Apache-2.0       | Pin revision and retain model notice        |
| Direct and transitive additions    | Permissive       | Record SPDX IDs and shipped notices         |
| Future curated local model         | Permissive       | Repeat dependency, weights, and notice gate |
| Remote provider SDK                | None             | Use repository-owned `fetch` adapter        |
| GPL or AGPL outside implementation | Forbidden here   | Requires separate explicit user approval    |

Do not add, copy, adapt, or link a GPL or AGPL reference implementation. Do not use
EmbeddingGemma in this implementation. It may be evaluated later only after an explicit licensing
and distribution review.

Before GREEN for the dependency task, add the package and model license texts or notices to the
existing release-notice mechanism and prove that Chrome ZIP, Firefox ZIP, and Firefox source ZIP
contain every required notice.

# 3. Security and Correctness Invariants

These invariants are release blockers:

1. The Coordination Server never receives Search queries, Search projections, ranking data,
   snippets, vector data, or model settings.
2. A remote embedding endpoint receives plaintext passages and queries only after the user has
   explicitly configured that endpoint, granted its exact host permission, and accepted the
   disclosure for the active Vault.
3. No remote call occurs during setup before the disclosure confirmation.
4. A local provider makes no network request after its verified public model files are cached.
5. Search projections use Projection-domain encryption. IndexedDB never contains plaintext
   titles, URLs, passages, tokens, term dictionaries, document frequencies, vectors, centroids, or
   remote configuration.
6. The remote API key is encrypted by a non-exportable device-local key. It never synchronizes,
   exports, enters a URL, appears in DOM after submission, or enters logs.
7. Query strings, Search sessions, snippets, result sets, cursors, and highlights are memory-only.
8. Search only returns results for the request's `expectedVaultId`.
9. A Search result never combines projections from two Vaults or vectors from two provider
   identities.
10. A Capture contributes to semantic coverage only after all of its passage vectors and centroids
    commit atomically.
11. Search materialization corruption is recoverable by deletion and rebuild. It never mutates
    Objects, Events, Bundles, or source Artifacts.
12. Lock, Vault switch, local reset, permission revocation, and background restart clear every
    plaintext Search buffer and invalidate every active Search cursor.
13. Active Search excludes Deleted Captures. Deleted Search includes only Deleted Captures.
14. Keyword Search remains usable without semantic setup.
15. Indexed results are deterministic for identical authoritative inputs, provider identity, and
    implementation version.
16. Search has no implicit migration path. A pre-release schema change requires recreating local
    development state.

# 4. Canonical Architecture

## 4.1 Ownership

Add `apps/browser-extension/src/runtime/search/` with these owned components:

| Component            | Responsibility                                                   |
| -------------------- | ---------------------------------------------------------------- |
| `documents.ts`       | Build deterministic Search documents and passages                |
| `query.ts`           | Strict query and balanced-phrase parsing                         |
| `keyword.ts`         | Tokenization, phrase checks, BM25, and keyword result candidates |
| `semantic.ts`        | Provider contract, quantization, centroids, and semantic ranking |
| `hybrid.ts`          | Exact tiers, RRF, deduplication, filters, and deterministic ties |
| `coverage.ts`        | Eligible, completed, pending, failed, and unavailable counts     |
| `indexer.ts`         | Restart-safe incremental indexing orchestration                  |
| `service.ts`         | Search, paging sessions, settings, and lifecycle boundary        |
| `contracts.ts`       | Runtime types and strict decoders                                |
| `crypto.ts`          | Projection-row sealing and opening                               |
| `local-model/`       | Manifest, download, cache, Transformers.js adapter, and worker   |
| `remote-provider.ts` | Narrow OpenAI-compatible `fetch` adapter                         |

Add IndexedDB repositories under `src/drivers/indexeddb/`. Add browser permission adapters under
`src/hosts/chrome/` and `src/hosts/firefox/`. Keep Library DOM and CSS composition in the existing
Library entrypoint.

Do not place ranking, model, encryption, or provider logic in
`entrypoints/library/main.ts`.

## 4.2 Data flow

The local flow is:

```text
Objects and Events
        |
        v
CONTENT_STRUCTURED, with TEXT_EXTRACTED fallback
        |
        v
Search document and deterministic passages
        |
        +----> encrypted keyword materialization
        |
        +----> local MiniLM ----> encrypted vectors and centroids
                                   |
explicit query                    v
        +----------------> Search Coordinator
                                   |
                                   v
                         Capture plus best passage
```

The remote flow differs only at embedding generation:

```text
explicitly consented passage or query
        |
        v
exact configured HTTPS endpoint
        |
        v
validated float vector
        |
        v
local quantization and encrypted materialization
```

The Search Coordinator owns provider dispatch, result fusion, filtering, deduplication, paging,
and explanation selection. Providers do not consume Events and do not write materializations.
The Projection Builder or Search indexer prepares inputs and owns the atomic commit.

## 4.3 Runtime placement and lifecycle

Search requests pass through the existing background `AppRequest` boundary. Long-lived model
execution SHALL use a dedicated extension worker abstraction that has identical contracts in
Chrome and Firefox:

- Chrome MAY host computation in the existing offscreen document.
- Firefox SHALL host computation in the visible Library page or a dedicated worker owned by it.
- The common Runtime SHALL not depend on Chrome's `offscreen` API.
- Both hosts SHALL use the same bundled WASM artifacts, tokenizer, pooling, normalization,
  quantization, and test vectors.
- Closing or hiding the Library aborts the active plaintext batch and releases model inference
  resources. The durable Job remains resumable.

Subscribe to `AppStateChanged` before the first state fetch. Each asynchronous response carries or
is checked against the Library's current Vault generation. A stale response is discarded.

# 5. Search Document and Passage Contract

## 5.1 Source selection

For each Capture, build one `SearchDocumentV1` from:

1. the current Library projection for title, canonical original URL, known URLs, host, captured
   timestamp, Collection ID, and Active or Deleted status;
2. `CONTENT_STRUCTURED` as the preferred body source; or
3. `TEXT_EXTRACTED` only when structured content is absent or fails authenticated decoding.

Do not decrypt the page snapshot, screenshot, or remote-only Artifact during Search indexing.
`CONTENT_STRUCTURED` and `TEXT_EXTRACTED` are never eligible for storage relief and are therefore
the local rebuild source.

If both body Artifacts are absent, index metadata only. Such a Capture is keyword eligible and
semantic ineligible unless its nonempty title or canonical URL creates a passage. Record typed
coverage state. Do not fail the entire Job.

Canonicalize the original URL with the existing Capture URL contract. Store known URLs as a
lexically sorted unique list after the same canonicalization. Derive `host` from the canonical
original URL in lowercase ASCII form. Reject a Library projection whose URL or Capture timestamp
cannot satisfy the canonical domain decoder and schedule the existing projection rebuild before
Search retry.

## 5.2 Canonical document shape

Use this internal shape:

```ts
interface SearchDocumentV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly bundleId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly status: "Active" | "Deleted";
  readonly title: string;
  readonly canonicalUrl: string;
  readonly knownUrls: readonly string[];
  readonly host: string;
  readonly capturedAt: string;
  readonly sourceRevision: string;
  readonly passages: readonly SearchPassageV1[];
}

interface SearchPassageV1 {
  readonly version: 1;
  readonly passageId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly source:
    | {
        readonly role: "CONTENT_STRUCTURED";
        readonly firstBlockId: string;
        readonly lastBlockId: string;
        readonly startOffset: number;
        readonly endOffset: number;
      }
    | {
        readonly role: "TEXT_EXTRACTED" | "METADATA";
        readonly startOffset: number;
        readonly endOffset: number;
      };
}
```

`sourceRevision` is lowercase SHA-256 over a canonical-CBOR record containing the Library fields,
selected Artifact Object ID, authenticated Artifact payload checksum, passage builder version, and
keyword tokenizer version. It changes whenever a rebuild could produce different materialization
bytes.

`passageId` is lowercase SHA-256 over
`SearchPassage-v1 || bundleId || sourceRevision || ordinal || source locator`. It is not a random
identifier.

Offsets are UTF-16 code-unit offsets because DOM `Range` and JavaScript selection APIs use those
offsets. The source text is NFC before offsets are calculated. Never calculate offsets on one
normalization and display another.

For structured content, `startOffset` is relative to the rendered `firstBlockId` text and
`endOffset` is exclusive relative to the rendered `lastBlockId` text. For `TEXT_EXTRACTED`, offsets
address the entire normalized Artifact string. For `METADATA`, offsets address the title, newline,
and canonical URL string shown above. Validate offsets against their authenticated source before
focusing a passage.

## 5.3 Structured block rendering

Render block text deterministically:

| Block kind   | Indexed text                                            |
| ------------ | ------------------------------------------------------- |
| Heading      | heading text                                            |
| Paragraph    | paragraph text                                          |
| Quote        | quote text                                              |
| ListItem     | item text without a synthetic bullet                    |
| Preformatted | exact normalized block text; preserve internal newlines |
| Table        | cells separated by space, vertical bar, space           |

Trim leading and trailing Unicode whitespace from each block. Collapse internal whitespace to one
ASCII space for Heading, Paragraph, Quote, and ListItem. Preserve newlines and repeated spaces for
Preformatted. Drop empty blocks. Never inject HTML.

Metadata forms passage ordinal zero when title or URL is nonempty:

```text
<title>
<canonical URL>
```

The source role is `METADATA`. Body passage ordinals begin at one.

## 5.4 Passage construction

The general passage builder SHALL:

1. preserve source order;
2. group adjacent prose blocks until adding another block would exceed either 160 whitespace
   separated words or 768 UTF-8 bytes;
3. retain a 20-word overlap between adjacent prose passages;
4. never move a Heading after the prose it introduces;
5. split oversized Preformatted and Table blocks at newline boundaries first, then at Unicode
   scalar boundaries;
6. never split a surrogate pair or UTF-8 sequence;
7. emit no empty passage; and
8. produce identical passages in Chrome and Firefox.

The 768-byte limit is the provider-neutral storage and network batch limit. The local adapter
tokenizes each provider-neutral passage without truncation. When it exceeds the model limit, split
the content token IDs into windows of at most 254 tokens, leaving room for the model's two special
tokens, with a 32-content-token overlap. Embed each window, calculate the arithmetic mean of the
unit window vectors in float64, and L2-normalize that mean to produce the passage's one provider
vector. Use the same rule without overlap for an overlength query. The provider boundary still
returns exactly one vector for each input string.

Use the Transformers.js tokenizer and model primitives directly. Do not rely on an opaque pipeline
truncation default. Unit tests SHALL pin window token IDs, window count, and the final normalized
vector for an overlength passage and query.

Remote input uses the provider-neutral passage without tokenizer-specific splitting. A provider
that rejects the fixed limit is unsupported.

## 5.5 Passage focus

Search result navigation carries only `bundleId` and `passageId` in Library process memory. It
SHALL NOT put query text or passage text in the URL. The existing detail route may retain its
Bundle identifier.

After detail authenticates the matching source Artifact:

1. rebuild passages using the indexed `sourceRevision`;
2. find `passageId`;
3. expand the relevant Capture version;
4. scroll the passage container into view;
5. move programmatic focus to a temporary `tabindex="-1"` passage wrapper;
6. apply a non-color-only Search match treatment; and
7. announce **“Search match focused.”**

If source content changed or the passage is unavailable, open the Capture normally and announce
**“The Capture opened, but the indexed passage is no longer available.”** Trigger reindexing.

# 6. Query and Response Contract

## 6.1 Query parsing

The v1 query parser accepts ordinary text and balanced double-quoted phrases.

- Normalize input to NFC.
- Trim outer whitespace.
- Collapse unquoted whitespace.
- A backslash has no escape semantics.
- A balanced pair of ASCII `"` characters creates one exact phrase.
- An unmatched `"` is treated as an ordinary character.
- Empty phrases are ignored.
- Filters come from controls, never textual operators.
- Reject a query longer than 1,024 UTF-16 code units.
- Reject an empty query after normalization.
- Reject a query that contains no Unicode Letter, Mark, or Number after removing syntactic quote
  delimiters.

Every balanced quoted phrase is a required lexical constraint across title, URL, or one passage;
different phrases may match different fields or passages. When unquoted terms are present, a
Capture must also contain at least one of them. Unquoted terms otherwise use OR candidate semantics
and BM25 ranks how many and how strongly match. Apply required phrases to semantic candidates
before fusion by checking their keyword row.

Semantic embedding input is the normalized full query with quote characters removed but phrase
content retained. Keyword input contains the unquoted terms plus the phrases.

## 6.2 App protocol

Extend `src/app/protocol.ts` with strictly decoded requests:

```ts
type SearchScope = "Active" | "Deleted";

interface SearchFiltersV1 {
  readonly version: 1;
  readonly hosts: readonly string[];
  readonly collectionIds: readonly string[];
  readonly capturedFrom?: string;
  readonly capturedBefore?: string;
}

type SearchRequest =
  | ({
      readonly type: "SearchLibrary";
      readonly query: string;
      readonly clientInstanceId: string;
      readonly scope: SearchScope;
      readonly filters: SearchFiltersV1;
      readonly pageSize: 50;
    } & ExpectedVault)
  | ({
      readonly type: "LoadMoreSearchResults";
      readonly clientInstanceId: string;
      readonly cursor: string;
      readonly pageSize: 50;
    } & ExpectedVault)
  | ({ readonly type: "GetSearchState" } & ExpectedVault)
  | ({ readonly type: "StartSearchIndexing" } & ExpectedVault)
  | ({ readonly type: "PauseSearchIndexing" } & ExpectedVault)
  | ({ readonly type: "RebuildSearchIndex" } & ExpectedVault)
  | ({ readonly type: "DisableSemanticSearch" } & ExpectedVault)
  | ({ readonly type: "RemoveLocalSearchModel" } & ExpectedVault)
  | ({ readonly type: "CancelLocalSearchModelDownload" } & ExpectedVault)
  | ({
      readonly type: "ConfigureLocalSearch";
      readonly acceptedDisclosureVersion: 1;
    } & ExpectedVault)
  | ({
      readonly type: "ProbeRemoteSearchProvider";
      readonly endpoint: string;
      readonly model: string;
      readonly dimensions?: number;
      readonly apiKey: string;
    } & ExpectedVault)
  | ({
      readonly type: "ConfigureRemoteSearch";
      readonly probeId: string;
      readonly acceptedDisclosureVersion: 1;
    } & ExpectedVault);
```

`clientInstanceId` is a random 128-bit base64url value created once for the live Library page. It
is memory-only and lets the background enforce per-page Search-session limits.

`ProbeRemoteSearchProvider` is allowed only after the UI has displayed the disclosure and the user
has pressed **Test connection**. The probe response remains memory-only. `ConfigureRemoteSearch`
consumes an unexpired probe held in the background process and persists the tested configuration
and protected credential.

Use this response:

```ts
interface SearchPageMessage {
  readonly results: readonly SearchResultMessage[];
  readonly nextCursor?: string;
  readonly resultCount: number;
  readonly resultCountIsComplete: boolean;
  readonly coverage: SearchCoverageMessage;
  readonly semantic:
    | { readonly state: "NotConfigured" }
    | { readonly state: "Ready"; readonly providerLabel: string }
    | { readonly state: "Partial"; readonly providerLabel: string }
    | { readonly state: "Unavailable"; readonly providerLabel: string };
}

interface SearchResultMessage {
  readonly bundleId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly originalUrl: string;
  readonly host: string;
  readonly capturedAt: string;
  readonly status: SearchScope;
  readonly passageId: string;
  readonly snippet: string;
  readonly match:
    | "ExactTitle"
    | "ExactUrl"
    | "ExactPhrase"
    | "Keyword"
    | "Semantic"
    | "KeywordAndSemantic";
}

interface SearchCoverageMessage {
  readonly eligibleCaptures: number;
  readonly keywordCaptures: number;
  readonly semanticCaptures: number;
  readonly pendingSemanticCaptures: number;
  readonly failedSemanticCaptures: number;
  readonly indexedAt?: string;
}

interface RemoteSearchProbeMessage {
  readonly probeId: string;
  readonly responseModel: string;
  readonly effectiveDimensions: number;
  readonly expiresAt: string;
}

interface SearchStateMessage {
  readonly coverage: SearchCoverageMessage;
  readonly semantic:
    | { readonly state: "NotConfigured" }
    | {
        readonly state: "Configured";
        readonly kind: "Local" | "Remote";
        readonly providerLabel: string;
        readonly model: string;
        readonly dimensions: number;
      };
  readonly localModel:
    | { readonly state: "NotDownloaded" }
    | {
        readonly state: "Downloading";
        readonly completedBytes: number;
        readonly totalBytes: number;
      }
    | { readonly state: "Ready"; readonly manifestId: string };
  readonly indexing: {
    readonly state:
      | "Idle"
      | "Running"
      | "Paused"
      | "WaitingForUnlock"
      | "WaitingForLibrary"
      | "WaitingForPermission"
      | "WaitingForNetwork"
      | "Failed";
    readonly completedCaptures: number;
    readonly totalCaptures: number;
    readonly errorId?: string;
  };
}
```

Do not expose raw relevance values to the UI. Validate all arrays, timestamps, URLs, UUIDs, counts,
enum values, unknown fields, duplicates, limits, and sort requirements at the protocol boundary.

`hosts` and `collectionIds` are lexically sorted, unique arrays with at most 100 entries each.
Hosts use canonical lowercase ASCII URL host form. Collection entries are lowercase UUIDs.
`clientInstanceId` is exactly 22 unpadded base64url characters. A cursor is exactly 32 unpadded
base64url characters. Model identifiers contain 1 through 256 Unicode scalars. Dimensions are safe
integers from 1 through 4,096. API keys contain 1 through 8,192 UTF-16 code units. Result arrays
contain at most 50 entries, snippets contain at most 320 Unicode scalars, and every count is a
nonnegative safe integer.

## 6.3 Search sessions and paging

The first request computes at most the top 1,000 fused Capture identities and retains only their
identities, selected passage identities, match reason, and scores in a background memory session.
Return 50. `resultCount` is the retained session count. `resultCountIsComplete` is false when an
exact or provider candidate tier was truncated; otherwise it is true.

The cursor is an opaque 192-bit random base64url token that maps to:

- Vault ID;
- active Vault generation;
- Search projection generation;
- scope and filters hash;
- ordered result identities;
- next offset; and
- last-access time.

The cursor itself encodes none of those values. Sessions expire after ten minutes of inactivity,
on `AppStateChanged`, on projection generation change, on lock, on Vault switch, and on background
restart. Keep at most four sessions per Library page and 16 globally. Evict least recently used.

An invalid or stale cursor returns a typed `SEARCH_CURSOR_EXPIRED` error. The UI announces that
results changed and reruns the first page. Never append results from two generations.

## 6.4 Runtime error identifiers

Add these stable `RuntimeErrorId` values and map lower-level errors to them:

```text
SEARCH_QUERY_INVALID
SEARCH_FILTER_INVALID
SEARCH_CURSOR_EXPIRED
SEARCH_INDEX_UNAVAILABLE
SEARCH_INDEX_CORRUPT
SEARCH_PROVIDER_NOT_CONFIGURED
SEARCH_PROVIDER_PERMISSION_REQUIRED
SEARCH_PROVIDER_UNAVAILABLE
SEARCH_PROVIDER_RESPONSE_INVALID
SEARCH_PROVIDER_DIMENSION_CHANGED
SEARCH_MODEL_PERMISSION_REQUIRED
SEARCH_MODEL_DOWNLOAD_FAILED
SEARCH_MODEL_INTEGRITY_FAILED
SEARCH_MODEL_IN_USE
SEARCH_PROBE_EXPIRED
```

Do not expose network response text, model internals, IndexedDB details, or cryptographic failure
details in the user-facing message. Preserve the stable ID and a redacted local diagnostic cause.

# 7. Keyword Provider

## 7.1 Normalization and fields

Use one repository-owned tokenizer:

1. normalize to NFC;
2. apply Unicode lowercase;
3. split on characters outside Unicode Letter, Mark, and Number categories;
4. retain tokens of one or more Unicode scalars;
5. do not stem;
6. do not remove stop words; and
7. index canonical URL host labels, path segments, and query parameter names and values after URL
   decoding each component once.

Do not decode invalid percent escapes and do not index URL credentials or fragments.

Fields and weights are fixed:

| Field         | Weight |
| ------------- | -----: |
| Title         |    5.0 |
| Host          |    4.0 |
| Canonical URL |    3.0 |
| Known URLs    |    2.0 |
| Passage body  |    1.0 |

## 7.2 Materialization

Persist one encrypted keyword row per Capture. Its plaintext contains:

- field lengths;
- normalized title and URLs for exact checks;
- ordered passage IDs and display text;
- each token's per-field term frequency and passage positions; and
- source revision.

Persist one encrypted per-Vault keyword statistics row containing separate Active and Deleted
document counts and average field lengths.

Derive a non-exportable HMAC-SHA-256 lookup key from the active Vault epoch root with Projection
domain context `SearchKeywordLookup-v1:<vaultId>`. A posting key is:

```text
HMAC-SHA-256(lookup key, UTF8(<namespace> || NUL || <normalized value>))
```

Use namespaces `term`, `title-exact`, and `url-exact`. Persist an encrypted posting row under the
opaque MAC. A `term` row contains separate Active and Deleted document frequencies plus sorted
Bundle IDs. Exact rows contain sorted Bundle IDs only. Posting ciphertext uses a Projection-row key
whose context includes the opaque MAC. Neither native key nor ciphertext reveals the term.

The indexer opens the prior Capture row, derives its old and new posting sets, and updates the
Capture row, statistics, every affected posting, and checkpoint in one transaction. Delete empty
postings. Query execution fetches only query term and exact-value postings, intersects or unions
candidate Bundle IDs as appropriate, then opens candidate Capture rows for BM25 and phrase checks.
Do not scan every Capture for an ordinary keyword query.

## 7.3 BM25 and phrase matching

Use BM25 with:

```text
k1 = 1.2
b = 0.75
idf(term) = ln(1 + (N - df(term) + 0.5) / (df(term) + 0.5))
field(term) = idf(term) * (tf * (k1 + 1))
              / (tf + k1 * (1 - b + b * fieldLength / averageFieldLength))
```

Calculate per-field BM25 and multiply by the fixed field weight. Sum fields and query terms. Phrase
matching requires adjacent normalized token positions within the same field or passage. It does
not cross passage boundaries.

`N` and document frequency count Captures in the request's Active or Deleted scope before optional
filters. Maintain separate Active and Deleted statistics in the encrypted statistics row. Query
terms are unique for scoring; repetition in the query adds no multiplier. Quoted tokens participate
once in ordinary BM25 in addition to their hard phrase constraint. A field with zero average length
contributes zero.

Select the passage with the highest contributing keyword score. Break passage ties by ordinal
ascending. A metadata-only match returns the metadata passage.

Keyword provider candidates are sorted by score descending, `capturedAt` descending, then
`bundleId` ascending. Retain the top 200 for fusion.

# 8. Semantic Provider

## 8.1 Provider identity and interface

Use this provider boundary:

```ts
interface EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentityV1;
  readonly maximumBatchItems: number;
  readonly maximumInputBytes: number;
  embed(input: {
    readonly purpose: "Document" | "Query" | "Probe";
    readonly texts: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly Float32Array[]>;
  dispose(): Promise<void>;
}

interface EmbeddingProviderIdentityV1 {
  readonly version: 1;
  readonly kind: "LocalMiniLm" | "RemoteOpenAiCompatible";
  readonly endpointOrigin?: string;
  readonly model: string;
  readonly modelRevision?: string;
  readonly dimensions: number;
  readonly pooling: "Mean";
  readonly normalized: true;
}
```

Provider identity is part of every semantic row and the Search projection generation. Endpoint
identity stores the normalized origin and SHA-256 of the normalized path plus query string. It
does not expose query parameters, which may contain provider routing information.

Changing provider, endpoint, model, revision, dimensions, pooling, vector format, or semantic
schema invalidates the entire Vault semantic materialization. Never reuse or mix it.

## 8.2 Vector validation and quantization

For every returned vector:

1. require the configured number of dimensions;
2. reject `NaN`, infinity, nested non-numbers, sparse objects, and unequal lengths;
3. calculate the L2 norm in float64;
4. reject zero or non-finite norm;
5. L2-normalize;
6. set `scale = max(abs(component)) / 127`;
7. round each `component / scale` to the nearest integer, ties away from zero;
8. clamp to signed int8 `[-127, 127]`; and
9. persist `Int8Array`, float32 scale, dimensions, and provider identity.

Semantic similarity dequantizes each stored component as `signedByte * scale` and calculates
`dot(query, stored) / norm(stored)` in float64; the query norm is one. Reject an opened stored
vector with zero or non-finite norm as corrupt. Query vectors remain float32 in memory and are
destroyed after the request. Unit tests SHALL pin quantization bytes and cosine ordering.

## 8.3 Capture centroids

Use these semantic plaintexts inside the encrypted envelopes:

```ts
interface QuantizedVectorV1 {
  readonly version: 1;
  readonly dimensions: number;
  readonly scale: number;
  readonly values: Uint8Array;
}

interface SearchSemanticCaptureV1 {
  readonly version: 1;
  readonly bundleId: string;
  readonly collectionId: string;
  readonly status: "Active" | "Deleted";
  readonly host: string;
  readonly capturedAt: string;
  readonly sourceRevision: string;
  readonly providerIdentityHash: string;
  readonly centroids: readonly {
    readonly passageId: string;
    readonly passageOrdinal: number;
    readonly vector: QuantizedVectorV1;
  }[];
}

interface SearchSemanticPassagesV1 {
  readonly version: 1;
  readonly bundleId: string;
  readonly sourceRevision: string;
  readonly providerIdentityHash: string;
  readonly passages: readonly {
    readonly passageId: string;
    readonly passageOrdinal: number;
    readonly vector: QuantizedVectorV1;
  }[];
}
```

`values` contains the signed int8 values in two's-complement byte representation. Decode with an
`Int8Array` view over those exact bytes. Passage text remains in the encrypted keyword row and is
not duplicated in the semantic row.

Persist at most four deterministic centroids per Capture:

1. use the normalized float passage vectors before quantization;
2. choose the first centroid as passage ordinal zero;
3. repeatedly choose the passage with the lowest maximum cosine similarity to already selected
   centroids;
4. break ties by passage ordinal ascending;
5. stop after four or after all passages are selected; and
6. quantize selected passage vectors as centroids.

Do not compute average centroids. The selected real-passage vectors preserve a direct best-passage
path.

At query time:

1. scan all Capture centroids in bounded decrypted batches;
2. retain the top 100 Capture candidates;
3. decrypt and score every passage vector for those Captures;
4. select the highest-scoring passage per Capture;
5. sort by cosine descending, `capturedAt` descending, then `bundleId` ascending; and
6. retain all reranked candidates, at most 100, for fusion.

## 8.4 Partial coverage

Semantic coverage counts only whole Capture commits with the active provider identity and source
revision. A partially embedded Capture is pending, not covered.

If semantic coverage is below eligible coverage, Search still embeds the query and ranks completed
Captures. The UI displays exact counts. Keyword results can include every keyword-indexed Capture.
Do not impute semantic scores for pending Captures.

If query embedding fails, return keyword results and semantic state `Unavailable`. Do not silently
call another provider. If the query has no keyword candidates, return the ordinary empty state plus
the semantic error notice.

# 9. Hybrid Ranking

Apply Active or Deleted scope, host, captured date, and Collection filters inside each provider
before candidate truncation and rank assignment. A filtered-out Capture contributes no provider
rank. Use the same canonical filter predicate for exact, keyword, and semantic paths.

## 9.1 Exact tier

Before score fusion, identify:

1. exact normalized title equality;
2. exact canonical URL equality after URL canonicalization; and
3. complete balanced phrase occurrence in title, URL, or one passage.

The exact-comparison value is the parsed query with syntactic quote delimiters removed, remaining
parts joined by one ASCII space, trimmed, NFC-normalized, and Unicode-lowercased. Attempt URL
canonicalization only when that complete value parses as one absolute HTTP(S) URL. Phrase matching
uses each parsed phrase independently.

Order exact results by exact reason priority in the list above, then keyword score descending,
`capturedAt` descending, and `bundleId` ascending. A Capture appears once with its highest-priority
reason. Exact results still honor scope and filters.

## 9.2 Reciprocal rank fusion

Fuse the top 200 keyword candidates and up to 100 semantic candidates using equal-weight
reciprocal rank fusion:

```text
RRF score = 1 / (60 + keyword rank) + 1 / (60 + semantic rank)
```

Ranks are one-based. A missing provider contribution is zero. Sort by RRF descending, then:

1. number of contributing providers descending;
2. best provider rank ascending;
3. `capturedAt` descending; and
4. `bundleId` ascending.

Remove exact-tier Captures from the fused tier and concatenate exact followed by fused. Do not add a
recency score or semantic threshold in v1.

## 9.3 Best passage and snippet

For exact title or URL matches, prefer the metadata passage. For exact phrase, choose the first
passage containing the phrase. For fused results:

- choose the keyword passage when only keyword contributed;
- choose the semantic passage when only semantic contributed; and
- when both contributed, choose the passage whose provider rank is better; ties choose keyword.

Construct a memory-only snippet of at most 320 Unicode scalars centered on the first keyword or
phrase match. A semantic-only snippet starts at the passage beginning. Trim at a word boundary
where possible and add a single ellipsis at each omitted edge. Escape through DOM text nodes; never
emit markup from indexed content.

# 10. Local MiniLM Provider

## 10.1 Pinned dependency

Add exact dependencies:

```json
"@huggingface/transformers": "4.2.0",
"@noble/hashes": "2.2.0"
```

Use Transformers.js's documented Cache API hook. Bundle the required ONNX Runtime WASM files in the
extension. Set remote-model loading off during inference. Do not load a script, WASM binary,
tokenizer, config, or model file from a remote URL at execution time.

Use `@noble/hashes` only for incremental SHA-256 during streamed download verification. Continue
to use Web Crypto and the repository's existing helpers for Vault cryptography.

Use CPU/WASM only. The same conformance vectors SHALL pass in packaged Chrome and packaged Firefox.
Retain `wasm-unsafe-eval` only where ONNX Runtime requires it. Do not add `unsafe-eval`, remote
script sources, remote worker sources, or remote object sources to the extension CSP.

For each model input, mean-pool `last_hidden_state` across tokens whose attention-mask value is one,
using float64 accumulation, then L2-normalize and return float32. Do not include padding tokens.
The tokenizer adds the model's standard special tokens.

Run at most one local inference at a time and batch at most eight provider-neutral passages. A
submitted query has priority after the current inference returns; do not abort an ONNX call in a
way the runtime cannot safely support. Yield to the Library event loop between batches.

## 10.2 Immutable model manifest

Create a repository-owned manifest for:

```text
model: Xenova/all-MiniLM-L6-v2
revision: 751bff37182d3f1213fa05d7196b954e230abad9
dtype: int8
dimensions: 384
maximum wordpieces: 256
pooling: mean
normalization: L2
language: English
license: Apache-2.0
```

Allow exactly these files:

| Path                      |      Bytes | SHA-256                                                            |
| ------------------------- | ---------: | ------------------------------------------------------------------ |
| `config.json`             |        650 | `7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7` |
| `special_tokens_map.json` |        125 | `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3` |
| `tokenizer.json`          |    711,661 | `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` |
| `tokenizer_config.json`   |        366 | `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3` |
| `vocab.txt`               |    231,508 | `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3` |
| `onnx/model_int8.onnx`    | 22,972,370 | `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` |

Download from the immutable Hugging Face revision, never `main`. Keep the manifest independent of
Transformers.js URL construction and reject every undeclared file.

The only source URL template is:

```text
https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/<manifest-path>
```

## 10.3 Permission and download ceremony

The local setup card says:

> **Search by meaning on this device**
>
> Download an English Search model, about 24 MB. Your Captures and searches stay in this browser.
> After download, semantic Search works offline.

Actions are **Download model** and **Not now**.

Only **Download model** may request exact optional host permissions for
`https://huggingface.co/*` and `https://*.hf.co/*`. Permission denial leaves keyword Search intact.
Do not request model-host access at install, Library open, or query submit.

After permission succeeds, `ConfigureLocalSearch` downloads the model when absent and configures
the active Vault only after verified promotion. When the model is already verified, it configures
the Vault without network access. `CancelLocalSearchModelDownload` deletes the temporary cache,
leaves the Vault unconfigured, and preserves keyword Search.

Stream every response to a temporary Cache API namespace while calculating incremental SHA-256.
Require HTTP success, expected byte budget, exact hash, and no redirect outside the two permitted
host patterns. After all six files validate, atomically promote the cache generation by replacing
one small manifest pointer. Delete the temporary generation on failure or cancellation.

Never expose partial files to inference. Model download progress may persist only byte counts and
manifest version, not response URLs containing transient parameters.

Closing, hiding, locking, or switching the initiating Library aborts the current transfer and
deletes its incomplete file. Fully verified files may remain in the temporary generation. V1 does
not resume partial HTTP ranges; the next explicit **Download model** restarts the current file from
byte zero. Explicit cancellation deletes the entire temporary generation.

After verified promotion or explicit cancellation, remove the two model-host optional permissions.
A later missing-file repair requests them again. Permission removal failure is a redacted
diagnostic warning, not grounds to discard an already verified model.

## 10.4 Public model cache

The verified model cache is public, device-wide, and shared among Vaults. It requires no Vault
encryption because the bytes are public and hash-pinned.

Per-Vault settings record model use. **Remove downloaded model** is enabled only when no Vault uses
the local model. Otherwise list the count of Vaults and instruct the user to disable semantic
Search in those Vaults first. Removal deletes only the verified model Cache API generations and
bundled inference session cache. It does not delete Captures or keyword materializations.

Maintain that count with one local operational reference per configured Vault. The reference uses
a device-local HMAC-SHA-256 of the Vault ID, never the raw Vault ID, and the public model manifest
ID. Update it atomically with the encrypted Search setting. The reference never synchronizes or
exports and reveals only that an opaque local Vault uses a public model.

# 11. Remote OpenAI-Compatible Provider

## 11.1 Supported contract

Use repository-owned `fetch`. Do not install a vendor SDK.

The user supplies:

- exact embedding endpoint URL;
- model identifier;
- bearer API key; and
- optional positive integer dimensions.

Allow HTTPS endpoints. Allow HTTP only for `localhost`, `127.0.0.1`, and `[::1]`. Reject URL
credentials, fragments, unsupported ports syntax, non-HTTP schemes, relative URLs, and endpoint
URLs longer than 2,048 characters. Preserve the exact normalized path. Do not append `/v1` or
`/embeddings`.

Request:

```http
POST <exact endpoint>
Authorization: Bearer <api key>
Content-Type: application/json
Accept: application/json
```

```json
{
  "model": "<configured model>",
  "input": ["<one or more passages>"],
  "encoding_format": "float"
}
```

Include `"dimensions"` only when configured.

Accept only:

```ts
interface OpenAiEmbeddingResponse {
  readonly object: "list";
  readonly data: readonly {
    readonly object: "embedding";
    readonly embedding: readonly number[];
    readonly index: number;
  }[];
  readonly model: string;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
}
```

Require each index from zero through `input.length - 1` exactly once. Reorder by index. Require the
response model to remain identical to the probe response. Reject unknown vector encodings,
base64 vectors, sparse vectors, missing items, duplicate indices, mixed dimensions, response bodies
over 32 MiB, and non-JSON content.

## 11.2 Disclosure and setup probe

Place remote setup under **Advanced: use a remote embedding service**.

Before credential fields, show:

> AWSM will send Capture passages from this Vault to the endpoint you choose while indexing. It
> will also send each submitted Search query. The provider may retain content or charge for use
> under its own terms. AWSM synchronization remains end-to-end encrypted, but remote embedding
> processing is not local.

Require an unchecked confirmation:

> I understand that this Vault's passage text and my Search queries will be sent to this endpoint.

The **Test connection** button remains disabled until the confirmation, valid fields, and
least-privilege browser host permission are present. Derive the permission match pattern as
`<protocol>://<hostname>/*`; browser match patterns cannot restrict a grant by path and may not
distinguish ports. The Runtime still fetches only the exact configured scheme, host, explicit port,
path, and query. Firefox SHALL request its current optional website-content, browsing-activity,
authentication-information, and personally-identifying-information collection categories together
with that host pattern. Chrome SHALL request only that host pattern. Do not expand required
install-time host access.

The probe sends the constant non-user string:

```text
AWSM embedding compatibility test.
```

It displays the response model and effective dimensions. The probe expires after ten minutes,
background restart, Vault switch, input edit, or permission revocation. **Use this provider**
commits only the exact probed endpoint, model, dimensions, key, and disclosure version.

The background probe session temporarily owns the API key. Clear the credential field and its DOM
value after the probe response. On configuration, encrypt the key and clear the probe. On failure,
expiry, cancellation, lock, or switch, overwrite the temporary key buffer where practical and
release it. Never send the key back to the Library response.

## 11.3 Batching, retries, and errors

Use at most 32 passages and 24 KiB of UTF-8 input per remote request. Use the smaller provider
limit if later exposed by a curated adapter. Do not run more than one remote indexing request
concurrently.

Abort a probe after 15 seconds, query embedding after 20 seconds, and indexing batch after 60
seconds. Compose the timeout signal with lifecycle cancellation. A timeout is transient for
indexing and visible for an explicit query.

Retry `408`, `429`, and `5xx` responses with full jitter and durable Job backoff capped at five
minutes. Respect a valid `Retry-After` up to five minutes. Do not retry other `4xx` responses.
Maximum automatic attempts per batch are five. A later **Resume indexing** may retry a failed
Capture.

For attempt number `n` starting at zero, the jitter cap is
`min(300_000, 1_000 * 2 ** n)` milliseconds and the delay is uniformly random from zero through
that cap. A valid `Retry-After` replaces the random delay when it is longer, still capped at five
minutes. Tests inject the clock and random source.

Never log request bodies, response bodies, Authorization headers, endpoint query parameters,
snippets, or provider error bodies. Map errors to stable typed IDs and show concise local copy.

## 11.4 Credential protection and revocation

Store the API key through the existing protected-credential pattern using a distinct
`search-remote-api-key:v1` context and a non-exportable AES-GCM key. Bind its authenticated data to
Vault ID, endpoint identity, model, and dimensions.

If endpoint permission is removed:

- abort in-flight requests;
- clear plaintext batches and query vectors;
- mark the provider unavailable;
- retain already encrypted vectors;
- refuse remote query embedding;
- show **“Remote Search access was removed. Grant access or choose another provider.”**

Disabling semantic Search deletes the Vault's semantic materialization, provider setting, protected
API key, and pending semantic Job checkpoints. It does not delete keyword materialization or the
shared public local model.

# 12. Persistence, Encryption, and Rebuild

## 12.1 Version-1 schema additions

Keep `DATABASE_VERSION = 1`. Add these stores to the fresh schema:

```ts
searchSettings: "search_settings";
searchModelReferences: "search_model_references";
searchKeywordRows: "search_keyword_rows";
searchKeywordStatistics: "search_keyword_statistics";
searchKeywordPostings: "search_keyword_postings";
searchSemanticRows: "search_semantic_rows";
searchSemanticPassages: "search_semantic_passages";
searchIndexJobs: "search_index_jobs";
searchIndexCheckpoints: "search_index_checkpoints";
```

This repository is pre-release and does not implement migrations. Existing development profiles
must recreate local state. Update schema inventory, reset, integration, Export/Import exclusion,
release archive, and object-store tests.

Never add a native IndexedDB index whose key reveals a Vault ID paired with plaintext Search data.
Use the repository's canonical Vault-prefixed opaque key helpers.

## 12.2 Encrypted row format

Use one `StoredSearchEnvelopeV1` wrapper:

```ts
interface StoredSearchEnvelopeV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly rowId: string;
  readonly projectionType:
    | "SearchSettings-v1"
    | "SearchKeyword-v1"
    | "SearchKeywordStatistics-v1"
    | "SearchKeywordPosting-v1"
    | "SearchSemantic-v1"
    | "SearchSemanticPassages-v1";
  readonly sourceRevision: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}
```

Derive an AES-256-GCM Projection-row key with the active Vault epoch root and:

```text
domain: vault:projection:v1
context: <projectionType>:<bundleId-or-vaultId>:<rowId>
salt scope: vaultId
```

Authenticated data is canonical CBOR containing wrapper version, Vault ID, projection type, row
ID, source revision, semantic provider identity hash when applicable, and encryption algorithm.
Use a fresh 96-bit random nonce for every write. Never reuse a row's ciphertext or nonce across an
epoch or provider change.

For Capture rows, `sourceRevision` is the section 5 document revision. For the Vault statistics
row, it is the active Search projection generation. For settings, it is the semantic provider
identity hash or the fixed disabled-setting hash. For a posting, it is SHA-256 over canonical CBOR
of the posting namespace, opaque MAC, document frequency, and sorted Bundle IDs. A row decoder
recomputes and rejects a revision that does not match its row kind.

The implementer SHALL reconcile this concrete Search use with
`docs/specifications/crypto/key-derivation.md` and reuse the established HKDF/AES-GCM helpers.

## 12.3 Settings

The per-Vault encrypted Search setting is:

```ts
type SearchSettingsV1 =
  | {
      readonly version: 1;
      readonly semantic: "Disabled";
    }
  | {
      readonly version: 1;
      readonly semantic: "Local";
      readonly provider: EmbeddingProviderIdentityV1;
      readonly disclosureVersion: 1;
    }
  | {
      readonly version: 1;
      readonly semantic: "Remote";
      readonly provider: EmbeddingProviderIdentityV1;
      readonly endpoint: string;
      readonly protectedCredentialId: string;
      readonly disclosureVersion: 1;
    };
```

Keyword indexing needs no setting and begins automatically when the Library is visible and
unlocked.

`search_model_references` contains only:

```ts
interface StoredSearchModelReferenceV1 {
  readonly version: 1;
  readonly vaultReference: string;
  readonly manifestId: string;
}
```

Derive `vaultReference` with a distinct non-exportable device-local HMAC key context
`search-model-reference:v1`. Reject duplicate references. Enabling local semantic Search adds the
reference in the settings transaction. Changing away from local or disabling semantic Search
deletes it in the settings transaction. Local reset deletes every reference.

## 12.4 Job and checkpoint

The keyword statistics row owns a `generationId` lowercase UUID and nonnegative safe-integer
`revision`. A rebuild, Search schema change, tokenizer change, or provider identity change creates
a new generation with revision zero. Every atomic Capture commit or filter-metadata update
increments revision by one in the same transaction. The `projectionGeneration` string is exactly
`<generationId>:<revision>`. Search sessions bind both parts.

Use one current `SearchIndexJobV1` per Vault and provider generation:

```ts
interface SearchIndexJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly vaultId: string;
  readonly state:
    | "Created"
    | "Running"
    | "Paused"
    | "WaitingForUnlock"
    | "WaitingForLibrary"
    | "WaitingForPermission"
    | "WaitingForNetwork"
    | "Failed"
    | "Succeeded";
  readonly stage: "Discover" | "Keyword" | "Semantic" | "Validate" | "Terminal";
  readonly projectionGeneration: string;
  readonly providerIdentityHash?: string;
  readonly completedCaptures: number;
  readonly totalCaptures: number;
  readonly failedCaptures: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly retryAt?: string;
  readonly errorId?: string;
}
```

Each checkpoint binds Bundle ID, source revision, keyword state, semantic state, attempt count, and
last stable error ID. Order discovery by Bundle ID ascending. Use a renewable 30-second lease and
renew no later than every ten seconds. A new owner may resume only after expiration.

Commit one Capture's keyword row, semantic rows, checkpoint, Job counters, and projection
generation change atomically where they change together. A crash before commit exposes none of the
Capture. A crash after commit resumes after it.

## 12.5 Triggers and invalidation

Reconcile Search after:

- Capture completion;
- synchronized Object/Event activation;
- Import activation;
- Vault recovery or replacement activation;
- Capture delete or restore;
- Collection move, extract, merge, or undo;
- Vacuum;
- active epoch change;
- Search schema or tokenizer change;
- semantic provider identity change; and
- authenticated materialization failure.

Metadata-only changes may rebuild keyword rows without regenerating semantic body vectors if the
passage texts and semantic provider identity are unchanged. Status and Collection changes update
filter metadata atomically.

Import and synchronization SHALL never import Search rows. They schedule local discovery from
authoritative activated state. Export SHALL omit every Search store and setting, including remote
credentials.

## 12.6 Pause and resume

Indexing runs only when all are true:

- the Library page is connected;
- `document.visibilityState === "visible"`;
- the expected Vault is still active;
- the Vault is unlocked;
- the user has not paused indexing;
- required provider permission is present; and
- the remote provider, when selected, is online.

Check cancellation between passages and before every network request. Hidden, closed, locked, or
switched state immediately aborts the current plaintext batch and transitions to the appropriate
waiting state. Already committed Captures remain searchable.

# 13. Library Experience

## 13.1 Persistent Search bar

Place one Search form in the Library workspace header below the Vault title and above the current
Active or Deleted content. It remains visible on empty, populated, Search results, detail-return,
wide, and narrow Library surfaces.

The field label is **Search this Vault**. Placeholder:

> Search titles, URLs, and captured text

The literal submit button is **Search**. Do not run semantic Search on `input`, `change`, or filter
selection. Enter submits unless focus is in an open filter control.

Keep the submitted query visibly editable. Do not add it to the route or browser history. Clear it
on Vault switch and lock. Returning from result detail during the same live Library process
restores the in-memory query, filters, results, and scroll position.

## 13.2 Filters

Provide buttons or popovers for:

- **Host**, with normalized hosts present in the current scope;
- **Captured**, with From and Before date fields; and
- **Collection**, with Collections present in the current scope.

Multiple hosts and Collections use OR within the filter and AND across filter kinds. `capturedFrom`
is inclusive UTC midnight. `capturedBefore` is exclusive UTC midnight. Reject Before earlier than
From.

The Library's current **Library** or **Deleted** section supplies the Search scope. Switching scope
clears results and resubmits only when the user presses Search. Do not search both scopes.

Selected filters appear as removable literal chips. **Clear filters** removes only filters, not the
query.

## 13.3 Results

Use heading:

> Search results

Show **“N results”** when `resultCountIsComplete` is true and **“Showing the top N results”** when
it is false. Each result shows:

- title;
- host and captured date;
- Collection name;
- one escaped best-passage snippet;
- a literal match badge such as **Exact title**, **Exact phrase**, **Keyword and meaning**,
  **Keyword**, or **Meaning**; and
- a button or linked title whose accessible name is **Open Capture: {title}**.

Do not show raw relevance scores, vector values, provider ranks, or debugging labels.

Render 50 results. If `nextCursor` exists, show **Load more**. Preserve existing results while the
next page loads. Disable the button with stable accessible name during the request.

## 13.4 Coverage and setup states

Keyword Search is always the baseline. Use these semantic states:

### Not configured

Show a quiet notice after keyword results:

> Search by meaning is not set up for this Vault. Keyword results are complete.

Actions: **Set up semantic Search** and **Keep keyword Search**.

### Indexing

Show exact coverage:

> Semantic Search covers 2,450 of 10,000 eligible Captures. Keyword results include all indexed
> Captures.

Actions: **Pause indexing** and, when paused, **Resume indexing**.

### Unavailable

Show the typed provider error without removing keyword results. Offer **Retry semantic Search** or
**Search settings** as appropriate.

### Complete

Show no celebratory persistent banner. Search settings may report:

> Semantic Search covers all 10,000 eligible Captures.

Use an `aria-live="polite"` region for submitted result count, coverage transitions, cursor expiry,
and passage focus. Do not announce per-batch progress more than once every five seconds.

## 13.5 Empty and error states

Use:

- **“Enter a Search to find Captures in this Vault.”** before first submit;
- **“No Captures matched this Search.”** for a complete empty result;
- **“No indexed Captures matched. Semantic indexing is still in progress.”** when partial semantic
  coverage may explain the empty result;
- **“Search results changed. AWSM refreshed them.”** after cursor expiry or projection change; and
- **“Search could not open an authenticated index row. AWSM will rebuild it.”** for corruption.

Do not claim that partial semantic Search found every conceptual match.

## 13.6 Settings

Add a **Search** section to the existing Library settings dialog. It shows:

- keyword indexed Capture count;
- selected semantic provider or **Not configured**;
- model, effective dimensions, and Local or Remote badge;
- exact semantic coverage;
- indexing state and last completed time;
- **Rebuild Search index**;
- **Change semantic provider**;
- **Disable semantic Search**; and
- conditional **Remove downloaded model**.

Changing provider and disabling semantic Search require a precise confirmation describing local
vector deletion and rebuild. They do not require destructive styling equivalent to deleting
Captures because authoritative content remains safe.

## 13.7 Responsive and accessible behavior

Use `@awsm/design-system` tokens and primitives. Do not add local palette values.

- At 390 CSS pixels, the Search field and button may stack but do not clip.
- Filter controls wrap and remain at least 44 by 44 CSS pixels.
- Results use semantic list markup.
- Snippets remain selectable text.
- Keyboard order is query, Search, filters, results, Load more.
- Popovers trap no focus and return focus to their trigger.
- Setup and confirmation dialogs trap focus and restore it.
- Match emphasis does not rely on color alone.
- At 200% zoom, all result metadata wraps without horizontal scrolling.
- Reduced motion removes passage-focus scrolling animation and uses immediate positioning.

# 14. Privacy, Diagnostics, and Release Metadata

## 14.1 Prohibited persistence and logging

Add automated guards proving these values do not enter IndexedDB, extension storage, URL history,
logs, diagnostics, synchronization uploads, Export bytes, or Rails requests:

- Search queries;
- Search result snippets;
- plaintext passages;
- plaintext keyword tokens;
- float query vectors;
- remote API keys;
- remote request or response bodies; and
- provider error bodies.

Memory-only query and snippet values may exist while the unlocked Library is live. Clear buffers by
overwriting typed arrays where practical and releasing references in `finally`.

## 14.2 Diagnostics

Diagnostics may expose only:

- provider kind and non-secret model label;
- effective dimensions;
- materialization schema versions;
- eligible, completed, pending, and failed counts;
- Job state, stage, attempt count, stable error ID, and timestamps;
- model cache present or absent and verified manifest version; and
- aggregate duration and byte counts.

Never expose Capture IDs together with error detail outside local developer-only test hooks. Never
include endpoint query parameters or credentials.

## 14.3 Manifest and store disclosure

Keep remote hosts optional. Update Firefox optional data-collection declarations and store listing
copy to state that remote semantic Search sends captured website content, browsing context,
authentication information, and potentially identifying content only when the user configures a
remote endpoint.

Local model download sends no user content. Document that it contacts the pinned model host only
after the user selects **Download model**.

# 15. Documentation Reconciliation

Implementation is not complete until the following documents describe shipped behavior rather
than future intent:

| Document                                       | Required change                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `README.md`                                    | Present hybrid Search as implemented, local-first, and optional        |
| `ROADMAP.md`                                   | Remove shipped Search work; add curated model profiles as future       |
| `docs/architecture/11-search.md`               | Replace open questions with the fixed coordinator and ranking          |
| `docs/specifications/runtime/search.md`        | Specify hybrid query, materializations, encryption, and remote opt-in  |
| `docs/specifications/runtime/ai.md`            | Distinguish embedding Search materializations from immutable Artifacts |
| `docs/specifications/runtime/jobs.md`          | Add Search indexing lifecycle and visibility pause rules               |
| `docs/specifications/crypto/key-derivation.md` | Pin Search Projection-row contexts                                     |
| Capture and Artifact docs                      | Confirm structured/text rebuild authority                              |
| `DESIGN.md`                                    | Add any reusable Search component or copy rule actually introduced     |
| privacy and security public pages              | Explain local Search and explicit remote processing                    |
| extension release/store metadata               | Declare optional model and remote provider network behavior            |

The future Roadmap entry is **Curated Semantic Model Profiles**. It SHALL say:

- users choose from reviewed, permissively licensed profiles;
- profiles are per Vault;
- language, download size, dimensions, and performance are visible before selection;
- dimensions are an informed user choice only when the selected model supports them;
- changing profile rebuilds disposable local semantic materialization; and
- EmbeddingGemma remains only an evaluation candidate subject to licensing review.

Do not edit Roadmap history to imply Search shipped earlier than it did. Preserve unrelated existing
worktree changes and reconcile them rather than overwriting them.

Create `docs/plans/18-hybrid-local-first-search-tdd-evidence.md` when implementation begins. Record
actual RED, GREEN, refactoring, performance, permission, network, rendered, and release evidence.
Never fabricate retrospective RED output.

# 16. Cold Implementation Sequence

Each task follows RED, GREEN, and refactor. Do not implement later layers to make an earlier test
pass.

## Task 1 — Freeze baseline and dependency provenance

### RED

- Create the evidence ledger.
- Record clean baseline results for typecheck, unit, integration, design, Chrome, Firefox, and
  release archive lanes.
- Add failing tests that the Transformers.js and incremental-hash dependencies, notices, model
  manifest, six hashes, bundled WASM, and no remote SDK are present.
- Add a failing release test that undeclared model or license files are rejected.

### GREEN

- Add exact `@huggingface/transformers` and `@noble/hashes` dependencies.
- Record dependency and transitive SPDX licenses.
- Add model manifest and notices.
- Bundle only required inference WASM.
- Update Chrome and Firefox release/archive allowlists.

### Refactor

- Centralize release inventory and notice verification.
- Prove deterministic lockfile and archive output.

## Task 2 — Add strict Search contracts and fresh schema

### RED

- Add unit tests for every App request and response decoder, unknown field, limit, enum, date, UUID,
  URL, duplicate, page-size, and stale-Vault case.
- Add schema inventory tests for all nine new stores.
- Add Export, Import, synchronization, reset, and release tests proving Search stores are local
  only.

### GREEN

- Implement contracts, error IDs, schema constants, stores, repositories, and typed decoders.
- Keep database version one.
- Wire local reset and database close owners.

### Refactor

- Extract shared strict decoder helpers only when at least two Search decoders use them.
- Re-run full existing schema tests to catch accidental persistence expansion.

## Task 3 — Build deterministic documents and passages

### RED

- Pin fixtures for every structured block kind, empty content, text fallback, metadata-only,
  Unicode NFC, surrogate pairs, oversized tables, oversized preformatted text, prose overlap, and
  Chrome/Firefox equality.
- Assert exact `sourceRevision`, passage IDs, ordinals, text, and source offsets.
- Add a corruption case for authenticated Artifact failure.

### GREEN

- Implement source selection, block rendering, chunking, locators, revisions, and passage IDs.
- Reuse the canonical structured-content decoder and Artifact resolver.

### Refactor

- Keep document construction pure and browser-independent.
- Remove any duplicated block rendering already owned by structured-content code.

## Task 4 — Implement encrypted keyword materialization

### RED

- Add tokenizer vectors for Unicode, punctuation, URL components, invalid percent escapes, and no
  stemming.
- Pin HMAC lookup keys, opaque posting keys, posting updates, BM25 outputs, field weights, phrase
  positions, exact tiers, tie breaks, and best passages.
- Add IndexedDB inspection proving plaintext tokens, titles, URLs, and passages are absent.
- Add corrupted-envelope rebuild tests.

### GREEN

- Implement keyword rows, statistics, secret-keyed postings, Projection encryption, atomic
  updates, candidate lookup, and ranking.
- Implement exact title, URL, and phrase tiers.

### Refactor

- Profile allocations and bound candidate-row decryption.
- Keep lookup MACs and posting ciphertext out of diagnostics.

## Task 5 — Implement the provider-independent semantic core

### RED

- Pin provider identity hashes, vector validation, normalization, signed-int8 bytes, dequantized
  ordering, farthest-first centroid identities, candidate reranking, and provider-change
  invalidation.
- Prove a partial Capture commit is never counted or searchable.
- Prove vectors from mismatched providers cannot be opened as one generation.

### GREEN

- Implement semantic contracts, quantization, centroid selection, encrypted rows, coverage, and
  bounded scan/rerank.

### Refactor

- Reuse typed-array buffers without retaining plaintext between Captures.
- Keep similarity math pure and separately benchmarkable.

## Task 6 — Implement local model acquisition and inference

### RED

- Mock permission, redirects, Cache API, cancellation, truncated response, wrong length, wrong hash,
  undeclared file, partial generation, and interrupted promotion.
- Pin tokenizer-aware 256-wordpiece splitting.
- Pin at least ten public English sentence-pair ordering fixtures.
- Add packaged Chrome and Firefox tests proving identical dimension, normalization, and similarity
  order.
- Add a no-network-after-cache assertion.

### GREEN

- Implement exact host permission request, streaming verification, temporary cache, atomic
  promotion, custom cache adapter, bundled WASM path, local inference, and resource disposal.
- Set remote model and remote WASM loading off.

### Refactor

- Separate downloader from inference.
- Make the model manifest the only source of paths, hashes, dimensions, revision, and display size.

## Task 7 — Implement strict remote provider setup

### RED

- Test URL normalization, loopback exceptions, exact permission patterns, disclosure gating,
  constant probe, probe expiry, response validation, ordering, dimensions, batching, retry, abort,
  permission revocation, and log redaction.
- Test Chrome and Firefox permission differences.
- Prove no request occurs before confirmation and no request body enters evidence logs.

### GREEN

- Implement the permission adapters, protected credential, probe session, strict `fetch` adapter,
  batching, backoff, error mapping, configuration commit, and revocation handling.

### Refactor

- Share no permission broadening with synchronization unless the exact privacy categories and
  origin contract match.
- Keep Authorization header creation inside the smallest possible function.

## Task 8 — Implement restart-safe indexing

### RED

- Test discover, keyword, semantic, validate, and terminal state transitions.
- Test lease contention, lease expiry, crash before and after atomic commit, hide, close, lock,
  Vault switch, offline, permission loss, provider change, capture, sync activation, Import,
  delete, restore, Collection change, undo, Vacuum, and epoch change.
- Test exact coverage throughout each transition.

### GREEN

- Implement Job repository, checkpoints, lease, invalidation queue, visibility handshake, resumable
  batches, and `AppStateChanged` broadcasts.

### Refactor

- Consolidate lifecycle cancellation under one `AbortController` owner.
- Ensure no UI process is authoritative for durable progress.

## Task 9 — Implement Search and hybrid paging

### RED

- Test parser limits and balanced phrases.
- Pin exact tier plus RRF ordering, deduplication, filters, scope, 50-result pages, 1,000-result cap,
  cursor entropy, expiry, LRU, generation invalidation, and deterministic ties.
- Test semantic failure with keyword success.
- Test empty partial-coverage copy conditions.

### GREEN

- Implement Search Coordinator, provider dispatch, fusion, snippets, memory sessions, paging, and
  coverage responses.

### Refactor

- Ensure provider scores never cross the App protocol.
- Bound every result, row, and memory collection.

## Task 10 — Build the Library Search UI

### RED

- Add DOM tests for explicit submit, field/filter validation, scope, setup cards, remote disclosure,
  coverage, errors, paging, stale results, provider change, disable, model removal, and lock/Vault
  clearing.
- Add accessibility tests for labels, names, focus order, live regions, dialogs, 200% zoom, reduced
  motion, and non-color-only match emphasis.

### GREEN

- Add the persistent Search form, filters, results, settings, local and remote setup, progress,
  notices, and responsive styling with design-system primitives.
- Preserve memory-only Search state during detail return.

### Refactor

- Extract UI state reducers and formatting helpers from the entrypoint.
- Keep all visible copy consistent with section 13 and `DESIGN.md`.

## Task 11 — Focus the matched passage

### RED

- Test structured and text locators, metadata matches, missing passage, changed source revision,
  keyboard focus, live announcement, reduced motion, and query-free URL.
- Add real Capture fixtures with Heading, Paragraph, Preformatted, and Table matches.

### GREEN

- Rebuild the selected passage in detail, focus it, apply the match treatment, and handle stale
  source gracefully.

### Refactor

- Reuse passage builder and do not create a second highlighting parser.

## Task 12 — Reconcile documentation and release metadata

### RED

- Add documentation assertions that the README no longer says Search is unimplemented.
- Add release/store tests for optional network and remote-data disclosures.
- Add link checks for model and license provenance.

### GREEN

- Complete every section 15 update.
- Add the future curated-model Roadmap entry.
- Update privacy, security, install, release, and store metadata.

### Refactor

- Remove obsolete semantic-future wording and duplicated copy.
- Audit tracked docs for contradictions, placeholders, and stale links.

## Task 13 — Performance, browser, and final gate

### RED

- Capture pre-optimization benchmark evidence using the deterministic 10,000-Capture corpus.
- Run packaged Chrome and Firefox scenarios before final performance changes.

### GREEN

- Meet every section 18 target.
- Pass unit, integration, design, Chrome, Firefox, cross-browser, release ZIP, source ZIP, typecheck,
  lint, documentation format, and diff checks.
- Manually inspect the required wide, narrow, progress, setup, result, partial, offline, and
  passage-focus screenshots.

### Refactor

- Remove test-only capability leaks, unused permissions, debug logging, temporary model files, and
  dead provider branches.
- Complete the evidence ledger with actual commands and outcomes.

# 17. Required Test Matrix

## 17.1 Unit and property tests

At minimum, cover:

- strict protocol and stored-record decoding;
- canonical query normalization;
- phrase parsing;
- passage determinism;
- UTF-8 and UTF-16 boundaries;
- tokenizer and BM25 math;
- exact-tier ordering;
- RRF ordering and ties;
- filters and scope;
- vector validation and quantization;
- centroid selection;
- provider identity invalidation;
- local model manifest and cache;
- remote URL and response validation;
- encryption and authenticated data;
- Job transitions, lease, and checkpoint invariants;
- cursor entropy, expiry, and generation isolation;
- snippet escaping; and
- diagnostics redaction.

Use property tests or generated cases for Unicode boundary safety, vector finite-number validation,
RRF deterministic ties, and record decoder rejection.

## 17.2 IndexedDB integration

In a real browser:

- create the fresh version-one schema;
- commit and reopen encrypted Search rows;
- prove wrong Vault, row, provider, source revision, and epoch authentication fail;
- reconcile crashes on each side of commit;
- rebuild after corruption;
- exclude Search from Export, Import, synchronization, and storage relief;
- reset all Search and Cache API state deliberately;
- preserve shared public model cache across ordinary Vault deletion when another Vault uses it; and
- prove no plaintext corpus term appears in a byte/string walk of IndexedDB values.

## 17.3 Packaged browser journeys

Run in production-built Chrome and Firefox:

1. keyword-only Search while offline;
2. local setup permission, download, verification, indexing, restart, and offline query;
3. local download denial and retry;
4. partial semantic coverage with useful keyword results;
5. remote disclosure, exact permission, probe, indexing, query, revocation, and no fallback;
6. Vault switch during indexing;
7. lock during query;
8. Capture arrival and incremental index update;
9. Delete, Deleted Search, Restore, Collection filter, move, merge, and undo;
10. 50 results followed by Load more;
11. cursor expiry and automatic refresh;
12. result detail passage focus;
13. provider change and semantic rebuild;
14. disable semantic Search and protected-key deletion;
15. 390px narrow layout, 200% zoom, keyboard-only flow, and reduced motion; and
16. Chrome and Firefox ranking parity for the deterministic fixture Vault.

The remote test endpoint is a local repository-owned fixture server. It records counts and hashes,
not plaintext bodies, in retained evidence.

## 17.4 Manual rendered inspection

Retain and view:

- wide keyword-only results;
- narrow results with filters;
- local setup before permission;
- verified model download progress;
- partial coverage;
- remote disclosure before confirmation;
- remote tested provider details;
- provider unavailable with keyword results;
- empty results;
- 50-result page with Load more;
- Search settings;
- focused structured passage; and
- focused passage under reduced motion.

Screenshots containing a query, snippet, endpoint, model credential, or real Capture content stay in
ignored local evidence and never enter the public repository.

# 18. Performance and Resource Gates

Use a deterministic synthetic Vault with:

- 10,000 Captures;
- median 12 and p95 40 passages per Capture;
- mixed title, URL, prose, preformatted, and table content;
- 384-dimensional vectors;
- both Active and Deleted records; and
- at least 100 Collections and 500 hosts.

Measure on the repository's documented Linux reference environment after one warm run:

| Operation                                 | Required gate                         |
| ----------------------------------------- | ------------------------------------- |
| Keyword query, warm index                 | p95 at or below 100 ms                |
| Hybrid query after query embedding        | p95 local ranking at or below 500 ms  |
| First 50 result serialization             | at or below 50 ms after ranking       |
| Library main-thread blocking slice        | no task above 50 ms during indexing   |
| Keyword indexing resident memory          | below 256 MiB                         |
| Semantic ranking resident incremental use | below 256 MiB excluding model runtime |
| Search session retained identities        | at most 1,000 per session             |
| Remote request concurrency                | exactly one                           |
| Model network after verified cache        | zero                                  |

Local model inference speed is recorded but not assigned a universal wall-clock gate because host
CPUs vary. Indexing must yield between Captures and keep Library interaction responsive.

If the secret-keyed postings implementation misses the 100 ms gate, profile posting fetch,
candidate decryption, and BM25 separately, then optimize batching or postings sharding. Do not
weaken the target, persist plaintext, or introduce a native dependency without returning to the
licensing gate.

# 19. Completion Checklist

Implementation is complete only when all are true:

- [x] One explicit-submit Search field works in Active and Deleted Library sections.
- [x] Keyword Search is complete and useful without semantic setup.
- [x] Local MiniLM downloads only on request, verifies all pinned bytes, and works offline.
- [x] Remote Search requires disclosure, exact permission, a successful constant probe, and
      explicit commitment.
- [x] Remote configuration never falls back or mixes providers.
- [x] Search returns Captures with a deterministic best passage.
- [x] Exact title, URL, and phrase matches precede RRF results.
- [x] BM25 and RRF constants match this plan.
- [x] Fifty results and Load more use memory-only generation-bound cursors.
- [x] Host, captured date, Collection, Active, and Deleted filtering match this plan.
- [x] Semantic coverage reports whole committed Captures exactly.
- [x] Indexing pauses while the Library is hidden, closed, locked, or switched and resumes safely.
- [x] Every Search materialization is Projection-encrypted and local only.
- [x] Query, snippet, Search session, and query vector state is never persisted or placed in URLs.
- [x] The protected remote API key is removed on semantic disable and local reset.
- [x] Result navigation focuses the matching passage accessibly.
- [x] Chrome and Firefox packaged builds produce the same deterministic rankings.
- [x] The 10,000-Capture performance and memory gates pass.
- [x] Dependency, model, and release notices pass the commercial-flexibility licensing gate.
- [x] README, Roadmap, architecture, specifications, privacy, security, and release metadata agree.
- [x] The TDD evidence ledger contains actual RED, GREEN, refactoring, performance, rendered, and
      final verification evidence.
- [x] `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test`,
      `corepack pnpm test:integration`, the relevant design and packaged E2E lanes, Chrome and
      Firefox builds, release ZIP verification, Prettier, and `git diff --check` pass.

# 20. Implementation Handoff

Start with Task 1 and preserve any unrelated worktree changes. Do not switch branches, deploy,
publish, push, or modify production as part of this plan unless separately authorized.

When an implementation detail appears ambiguous:

1. apply the invariants in section 3;
2. prefer the exact types, constants, ordering, copy, and lifecycle rules in this document;
3. preserve keyword functionality and local-only safety on semantic failure;
4. keep authoritative Capture state untouched;
5. reject malformed or mixed provider data rather than guessing; and
6. record any necessary deviation in the evidence ledger before implementing it.

The plan deliberately leaves implementation techniques flexible only where they do not change
observable behavior, privacy, persistence, licensing, ranking, provider identity, or browser
parity.
