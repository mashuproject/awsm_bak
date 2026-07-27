# Hybrid Local-First Search TDD Evidence

**Document:** `docs/plans/18-hybrid-local-first-search-tdd-evidence.md`

**Status:** In progress

**Owner:** Engineering

**Last Updated:** 2026-07-26

**Depends On:** `docs/plans/18-hybrid-local-first-search.md`

---

# 1. Evidence Rules

This ledger records contemporaneous RED, GREEN, refactoring, performance, browser, rendered, and
release evidence for Plan 18. It does not backfill failing tests after implementation. Missing
historical evidence is reported as missing rather than invented.

Search is not complete until every Plan 18 completion item has direct current-state evidence.

# 2. Baseline

The baseline was captured before Search implementation changes. The worktree already contained an
unrelated tracked `ROADMAP.md` edit, untracked local `.codex/skills/` state, and the approved Plan
18 document. Those changes are preserved.

| Area              | Command                          | Result                                       |
| ----------------- | -------------------------------- | -------------------------------------------- |
| Extension types   | `corepack pnpm typecheck`        | PASS                                         |
| Unit and release  | `corepack pnpm test`             | PASS: 30 Node tests; 96 files and 417 Vitest |
| IndexedDB browser | `corepack pnpm test:integration` | PASS: 50 Chromium integration tests          |
| Design contract   | Not run yet                      | Pending baseline evidence                    |
| Packaged Chrome   | Not run yet                      | Pending baseline evidence                    |
| Packaged Firefox  | Not run yet                      | Pending baseline evidence                    |
| Cross-browser     | Not run yet                      | Pending baseline evidence                    |
| Release ZIPs      | Not run yet                      | Pending baseline evidence                    |

# 3. Initial Gap Inventory

The cold-checkout audit found:

- no `runtime/search` implementation;
- no Search App requests, responses, or Runtime error identifiers;
- no Search IndexedDB stores or repositories;
- no keyword tokenizer, posting Materialization, BM25, phrase, or hybrid ranking;
- no semantic provider, vector Materialization, local model, or remote adapter;
- no Search indexing Job or Library visibility handshake;
- no Library Search form, filters, results, setup, coverage, or passage focus;
- no model or dependency notice inventory for Search; and
- documentation that still describes Search and semantic Search as future work.

# 4. RED, GREEN, and Refactoring Log

## 4.1 Query, semantic math, and hybrid ranking foundations

### RED

Command:

```text
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/search-query.test.ts \
  tests/unit/search-semantic.test.ts \
  tests/unit/search-hybrid.test.ts
```

Result: FAIL. All three suites failed to import the absent `runtime/search` modules. The tests were
written before the implementation and pin normalization, balanced phrases, Unicode tokenization,
vector validation, signed-int8 quantization, cosine similarity, farthest-first centroids, exact
tiers, reciprocal-rank fusion, deduplication, best-passage choice, and deterministic ties.

### GREEN

Implemented pure Runtime modules for query parsing and Unicode tokenization, semantic vector
validation and quantization, deterministic centroid selection, and exact-tier plus reciprocal-rank
fusion.

The first GREEN attempt retained one failure because the test's float32 input was slightly below a
mathematical half-step. The fixture was corrected to an exactly representable positive and negative
half-step; production rounding was unchanged.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/search-query.test.ts \
  tests/unit/search-semantic.test.ts \
  tests/unit/search-hybrid.test.ts
```

Result: PASS, 3 files and 11 tests.

`corepack pnpm typecheck` also passed.

### Refactoring

Provider candidates are normalized behind one deterministic sort before rank assignment. Semantic
math validates dimensions and finite norms at each public boundary rather than relying on callers.

## 4.2 Search documents, passages, and keyword ranking

### RED

The first focused command failed because `runtime/search/documents` and
`runtime/search/keyword` did not exist:

```text
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/search-documents.test.ts \
  tests/unit/search-keyword.test.ts
```

Fixtures were already asserting structured rendering, text fallback, deterministic identifiers,
passage bounds and overlap, field-weighted BM25, phrase constraints, best-passage selection, and
scope/filter behavior.

A second contemporaneous RED was added for an oversized 400-scalar emoji token. It failed because
the first implementation emitted only the first 768-byte segment and dropped the remainder.

### GREEN

Implemented deterministic Search document construction, source revisions, passage identifiers,
structured and text rendering, bounded passage windows, Unicode-safe scalar splitting, per-field
keyword rows, scope statistics, exact BM25 formula, hard phrase constraints, filters, and
deterministic best-passage ranking.

The oversized-token implementation now emits every scalar in contiguous UTF-16 source ranges and
never exceeds 768 UTF-8 bytes.

Focused result: PASS, 2 files and 7 tests. Extension typecheck also passed after the initial GREEN.

### Refactoring

Document construction is pure and browser-independent. Keyword field indexing and query ranking
share the same Unicode tokenizer, and provider ranking receives only bounded candidate records.

## 4.3 Search protocol and fresh schema

### RED

`tests/unit/search-contracts.test.ts` failed to import the absent Search protocol. Before
implementation it covered all nine fresh-schema stores, strict explicit Search and Load more
requests, sorted and unique filters, request limits, local and remote setup Commands, HTTPS and
loopback endpoint policy, unknown-field rejection, and stable Search Runtime errors.

### GREEN

Added the strict Search request/response boundary, integrated it with `AppRequest` and `AppValue`,
added the stable Runtime error identifiers, and added all nine Search stores while retaining
`DATABASE_VERSION = 1`.

Focused result: PASS, 1 file and 6 tests. The App background currently rejects recognized Search
Commands with `SEARCH_INDEX_UNAVAILABLE` until the Search Service is connected; this is explicit
temporary scaffolding, not claimed Search behavior.

Extension typecheck passed after adding the exhaustive temporary background branch.

### Refactoring

Search validation is isolated from the already large App protocol. It rejects malformed Search
messages before they can reach Runtime state.

## 4.4 Encrypted Search Projection rows

### RED

`tests/unit/search-crypto.test.ts` failed to import the absent Search envelope decoder and
Projection cryptography. The pre-implementation tests required AES-256-GCM round-trip, no plaintext
in persisted ciphertext, strict stored decoding, and authentication of Vault, epoch, row, type,
source revision, and ciphertext.

### GREEN

Added the self-describing persisted Search envelope, strict decoder, Projection-domain HKDF
context, non-exportable AES-GCM key import, 96-bit nonce, canonical-CBOR authenticated data, and
key-byte wiping.

Focused result: PASS, 1 file and 3 tests. Typecheck initially identified TypeScript's stricter
`ArrayBuffer` Web Crypto boundary; explicit owned byte copies resolved it, after which typecheck
passed.

### Refactoring

All Search row kinds share one authenticated envelope and context constructor. Callers cannot
select an unauthenticated header field.

## 4.5 Strict remote embedding adapter

### RED

`tests/unit/search-remote-provider.test.ts` failed to import the absent remote provider. The tests
already pinned exact request URL and JSON, bearer authorization, response reordering, fixed
non-user probe content, response model and dimension stability, dense finite vectors, item-index
coverage, batch bounds, HTTP redaction, and malformed-response rejection.

### GREEN

Implemented the provider-independent embedding boundary and the repository-owned narrow
OpenAI-compatible `fetch` adapter. It normalizes validated vectors, accepts no base64 or sparse
encoding, never incorporates provider response bodies in errors, and clears its API-key reference
when disposed.

Focused result: PASS, 1 file and 4 tests. Typecheck found exact-optional-property and test-mock tuple
typing issues on the first GREEN; both were corrected and typecheck then passed.

### Refactoring

Probe and configured requests share one strict response parser and fixed batch guard. Provider HTTP
errors retain only status and `Retry-After`, never response content.

## 4.6 Secret-keyed keyword postings

### RED

`tests/unit/search-postings.test.ts` failed to import the absent posting-key module. The tests
already required a non-exportable HMAC key, deterministic opaque posting keys, namespace
separation, Vault and epoch-root separation, and rejection of invalid inputs.

### GREEN

Added Projection-domain lookup-key derivation using
`SearchKeywordLookup-v1:<vaultId>` and HMAC-SHA-256 over the canonical
`<namespace> NUL <normalized value>` message. Raw derived key bytes are wiped after importing the
non-exportable signing key.

Focused result: PASS, 1 file and 3 tests. Extension typecheck passed.

## 4.7 Exact oversized structured passages

### RED

Added an oversized Preformatted fixture with a newline, repeated spaces, a tab, and multibyte
Unicode scalars. The existing word-based fallback failed because it discarded formatting and the
newline.

### GREEN

Oversized Preformatted and Table blocks now split their exact normalized text at newline boundaries
first and Unicode-scalar boundaries second. Every chunk retains exact contiguous UTF-16 source
offsets and respects the 160-word and 768-byte limits.

Focused Search result: PASS, 9 files and 35 tests. Extension typecheck passed.

## 4.8 Browser-only inference dependency graph

The exact `@huggingface/transformers` `4.2.0` and `@noble/hashes` `2.2.0` dependencies are
installed. Repository-owned pnpm overrides remove the unused Node-only `onnxruntime-node` and
`sharp` dependency edges; this also removes native image binaries and their LGPL libvips package
from the production install. The remaining production license groups reported by
`corepack pnpm licenses list --prod --json` are MIT, Apache-2.0, BSD-3-Clause, and ISC.

Native build scripts are explicitly denied for the remaining `protobufjs` dependency. A frozen
install succeeds, and both Chrome and Firefox production builds plus their static release
verification pass. Shipped notice and ZIP inspection remain pending and are still required before
the dependency task is complete.

## 4.9 Canonical keyword materialization and IndexedDB repository

### RED

`tests/unit/search-materialization.test.ts` initially failed to import the absent materialization
module. Its fixtures required canonical CBOR round-trip, deterministic field reconstruction,
unknown-field rejection, invalid-identity rejection, forged-field rejection, and rejection of
noncanonical trailing bytes.

The Chromium integration harness then failed to compile because
`IndexedDbSearchRepository` did not exist. The scenario already required an encrypted keyword row
to survive a repository restart without exposing its title, strict authenticated-header tamper
rejection, all nine Search stores in schema version one, and opaque posting-based candidate
retrieval.

### GREEN

Added strict canonical keyword-row and posting plaintext codecs. Keyword fields are reconstructed
from the authenticated Search document and must byte-match the persisted fields, preventing a
forged token index from being accepted.

Added an IndexedDB Search repository that:

- seals keyword Capture and posting rows with Projection-domain AES-256-GCM;
- stores them under Vault-prefixed opaque keys;
- rechecks storage keys, Projection types, source revisions, document identities, and posting
  revisions after authenticated decryption; and
- batch-fetches only sorted unique opaque posting keys.

Focused unit result: PASS. The real Chromium IndexedDB scenario passes and proves restart
round-trip, no title in ciphertext, authenticated-header tamper rejection, nine fresh Search
stores, and posting candidate recovery. Extension and integration typechecks pass.

Atomic Capture/statistics/posting/checkpoint commits and optimistic conflict handling remain
pending; the current individual save methods are not yet the indexer's final commit boundary.

## 4.10 Atomic keyword generation commits

### RED

`tests/unit/search-statistics.test.ts` failed to import the absent incremental statistics module.
Its fixtures already required separate Active and Deleted totals and averages, status replacement,
monotonic projection revisions, Capture-identity checks, and safe-integer overflow rejection.

The statistics materialization fixture then failed because strict statistics codecs were absent.
The Search envelope test also proved the initial decoder incorrectly required a SHA-256 digest for
the statistics row instead of its specified `<generationId>:<revision>` source fence.

`tests/unit/search-job.test.ts` failed because strict Job and checkpoint decoders were absent. The
fixtures pinned progress, lease, state, error, timestamp, source-revision, projection-generation,
and unknown-field invariants.

Finally, the Chromium integration harness failed to compile because generation creation, atomic
Capture commit, statistics/Job/checkpoint reads, and posting-based query candidate lookup did not
exist.

### GREEN

Added:

- incremental Active and Deleted field-length totals and exact averages;
- strict canonical-CBOR statistics Materializations;
- Projection-generation source fences for statistics envelopes only;
- strict restart-safe Search Job and checkpoint decoders;
- atomic initial generation creation;
- one optimistic IndexedDB transaction spanning the Capture row, statistics row, every affected
  opaque posting, Job, and checkpoint;
- previous-row/posting consistency checks and stale-generation/source-revision fences; and
- query candidate discovery that fetches only HMAC-derived term, exact-title, and exact-URL
  postings, with OR terms and required phrase-token intersections.

The real Chromium scenario passes. It proves a generation advances from revision zero to one,
Job/checkpoint progress changes with the Capture, Active statistics update, the term posting
returns the committed Capture, a phrase-plus-term query discovers the same Capture without a Vault
scan, and a stale repeat commit is rejected.

The final indexer still needs lease acquisition/renewal, discovery, scheduling, retry, visibility,
and crash-boundary fault-matrix coverage.

## 4.11 Restart-safe keyword index lifecycle

### RED

`tests/unit/search-index-lifecycle.test.ts` failed to import the absent lifecycle module. The
fixtures already required thirty-second leases, contention before expiry, takeover at expiry,
renewal, owned release, terminal accounting, and deterministic visible/unlocked/paused/
permission/network gate mapping.

The Chromium lease scenario then failed to compile because the IndexedDB repository did not expose
atomic claim, renewal, release, or completion operations.

`tests/unit/search-indexer.test.ts` failed to import the absent indexer. Its fixtures required
resuming a pending checkpoint through the atomic commit boundary and refusing to load plaintext
when the Library is hidden.

### GREEN

Added a single-owner keyword index runner and durable lifecycle operations:

- thirty-second leases with a ten-second renewal threshold;
- atomic contention, expiry takeover, renewal, waiting-state release, and terminal completion;
- lexically ordered checkpoint resume;
- visible Library, expected Vault, unlock, pause, permission, and network gates before plaintext
  load and again before commit;
- source revision and Vault/Capture identity checks;
- one caller-owned AbortSignal passed through plaintext loading;
- atomic Capture progress commits followed by one invalidation callback; and
- terminal success only after every checkpoint is accounted for.

Real Chromium scenarios pass for lease contention/expiry/renewal/release and for a complete
pending-checkpoint → encrypted row/postings/statistics → invalidation → terminal Job run.

Discovery from authoritative Library Artifacts, continuous heartbeat during operations longer
than ten seconds, abort-to-wait transitions, failed-checkpoint retry policy, trigger coalescing, and
the full crash/lifecycle fault matrix remain pending.

## 4.12 Immutable local MiniLM delivery foundations

### RED

`tests/unit/search-local-model-manifest.test.ts` failed to import the absent local-model manifest.
The fixtures already pinned the immutable revision, model properties, exact six-file allowlist,
individual byte sizes and SHA-256 values, total byte budget, URL template, undeclared-path
rejection, incremental streamed verification, cancellation, and redirect-host policy.

`tests/unit/search-local-model-download.test.ts` then failed to import the absent downloader. Its
fixtures required streaming into a temporary generation, exact immutable requests, progress,
promotion only after verification, deletion after corruption, retained prior pointer state, and
redacted HTTP failure behavior.

The real Chromium Cache API scenario initially failed because the integration browser import map
did not expose the exact pinned `@noble/hashes/sha2.js` module. Adding the package's own ESM module
to the test server made the same repository code executable in Chromium.

`tests/unit/search-local-model-math.test.ts` failed to import the absent local inference math. Its
fixtures pinned 254-content-token windows, 32-token document overlap, no query overlap, masked
float64 mean pooling, L2 normalization, and normalized multi-window averaging.

### GREEN

Added:

- the exact Apache-2.0 MiniLM manifest and immutable Hugging Face URL construction;
- strict response-host validation limited to HTTPS `huggingface.co` and `*.hf.co`;
- incremental `@noble/hashes` SHA-256 verification with exact byte budgets and no application
  buffering;
- temporary-generation streaming, safe cached headers, redacted failures, and all-or-nothing
  pointer promotion;
- a Cache Storage adapter with a small atomic public pointer, readiness checks, file access, and
  removal; and
- deterministic token windows, attention-mask-aware float64 mean pooling, window combination, and
  final float32 normalized vectors.

The real Chromium Cache API scenario proves a valid generation is readable only after promotion,
a corrupt replacement is rejected without changing the verified pointer, and removal makes the
model unavailable.

### RED (continued)

`tests/unit/search-local-model-permission.test.ts` failed to import the absent permission boundary.
Its fixtures required the exact two model-host origin patterns, no redundant request when already
granted, and removal after use.

`tests/unit/search-local-model-provider.test.ts` failed to import the absent provider. Its fixtures
required verified-cache-only lookup, immutable URL rejection, read-only cache behavior,
document/query window policy, local pooling and normalization, cancellation, fixed batch limits,
single engine loading, and disposal.

### GREEN (continued)

Added:

- an exact `https://huggingface.co/*` and `https://*.hf.co/*` permission wrapper;
- a read-only Transformers.js custom-cache bridge that resolves only manifest-declared immutable
  URLs from the verified Cache Storage generation;
- a local MiniLM provider with fixed byte/item limits, cancellation between every inference,
  deterministic windowing and pooling, stable identity, singleton loading, and disposal;
- a Transformers.js tokenizer and int8 ONNX model adapter configured with both remote models and
  network fetch disabled; and
- an exact direct ONNX Runtime dependency plus extension-local asyncify factory/WASM asset URLs.

The focused five tests, package typecheck, full extension lint, and both production browser builds
pass. The model adapter is not yet reachable from a production workflow, so emitted-asset and
real-model inference conformance remain pending until the Search worker/service wiring makes the
adapter part of the executable graph.

The visible permission ceremony, incomplete-generation resume/cancellation policy, serialized
query-priority inference, model notices, and packaged Chrome/Firefox real-model conformance remain
pending.

## 4.13 Encrypted semantic materialization and lifecycle

### RED

The semantic and materialization fixtures initially had no provider-identity hashing, strict
semantic plaintext codecs, whole-Capture builder, or centroid-to-passage reranker. New fixtures
pinned canonical identity hashing, complete ordered passage coverage, strict signed-int8 vectors,
unknown-field rejection, bounded top-100 centroid retention, provider and filter isolation, and
best-passage reranking.

The Chromium integration scenario then failed to compile because the repository had no semantic
row readers, bounded scanner, or atomic semantic commit boundary. The indexer also counted a
configured-semantic Capture complete immediately after keyword commit.

### GREEN

Added:

- canonical SHA-256 provider identity hashing over the complete persisted identity;
- strict canonical-CBOR Capture-centroid and full-passage vector Materializations;
- deterministic construction from every Search document passage, normalized before quantization;
- provider-aware, filter-aware, bounded top-100 centroid collection and exact passage reranking;
- encrypted semantic Capture and passage readers with authenticated-header/source validation;
- bounded IndexedDB scanning in configurable batches without decrypting the Vault corpus at once;
- one optimistic transaction spanning both semantic rows, Job progress, and checkpoint state;
- stale-race and partial-pair rejection; and
- semantic indexer execution that embeds each passage, commits whole-Capture coverage, and counts a
  configured-semantic Capture complete only after semantic commit.

All 68 focused Search unit tests, package typecheck, full extension lint, integration TypeScript,
and five real-Chromium Search/model scenarios pass. The semantic Chromium scenario proves
encrypted persistence, paired restoration, bounded scanning, committed checkpoint state, and
stale repeat rejection.

Authoritative discovery, batching multiple provider-neutral passages per provider request,
continuous lease heartbeat/abort-to-wait handling, retry policy, and the complete Search Service
query path remain pending.

## 4.14 Encrypted per-Vault provider settings

### RED

`tests/unit/search-settings.test.ts` failed to import the absent settings contract. Its fixtures
pinned canonical disabled/local/remote variants, complete provider identities, deterministic
setting revisions, strict unknown-field rejection, and endpoint-origin consistency.

The semantic Chromium scenario then exposed that a semantic commit could not yet prove its
provider was the active per-Vault setting and changing provider could leave incompatible vectors.

### GREEN

Added strict canonical-CBOR Search settings and revisions: the fixed disabled setting hashes its
canonical value, while configured settings use the complete provider identity hash. Settings rows
are Projection-encrypted and authenticated like every other Search row.

Saving a changed setting atomically replaces the per-Vault setting and deletes both semantic
stores while preserving keyword rows and postings. Semantic commits now require the active
setting's identity hash. The real Chromium scenario configures local semantics, commits a complete
Capture, restores it, then disables semantics and proves both semantic stores are cleared.

Remote protected-credential persistence, permission revocation, and the setup/probe UI remain
pending.

## 4.15 Memory-only coordinator, paging, and background query path

### RED

`tests/unit/search-service.test.ts` failed to import the absent service and session store. Its
fixtures required opaque 192-bit cursors, generation/Vault/client fences, fifty-result pages,
ten-minute inactivity expiry, four sessions per page, sixteen globally, LRU eviction, and explicit
invalidation.

The coordinator fixture then required posting-selected keyword retrieval, global BM25 statistics,
best-passage selection, bounded snippets, coverage, and useful keyword results while semantics are
disabled. A real Chromium query was added to the atomic keyword scenario to prevent a unit-only
coordinator implementation.

Making the local provider reachable from the background exposed a production-build failure: ONNX
Runtime was initially inlined into a 96 MB service-worker script. Selecting the external-WASM
package condition alone still produced a 33 MB script.

### GREEN

Added:

- memory-only LRU Search sessions with all required limits and fences;
- posting-derived per-query document frequencies and keyword row reads capped at 256 identifiers;
- a coordinator that decrypts keyword candidates in batches of 128, retains only the top 200,
  streams semantic centroids in bounded batches, retains 100, reranks complete passage rows, and
  fuses at most 1,000 identities;
- exact-title, exact-URL, and exact-phrase tiers, deterministic best passages, and escaped
  memory-only snippets capped at 320 Unicode scalars;
- query vector timeout and explicit wiping, provider identity checks, keyword fallback when
  semantic embedding fails, generation revalidation, coverage, and semantic state;
- background handlers for Search, Load more, state, local setup/download/cancel/removal, and
  disabling semantics; and
- App-state invalidation of every cursor.

The production build now selects ONNX Runtime's external-WASM export. A repository-owned Vite
emitter packages the exact asyncify factory and 23,567,050-byte WASM file separately in both
browser outputs; the background script is 1.92 MB instead of 96 MB. Release verification still
needs to assert these assets and the remaining Transformers.js `import.meta` warnings need packaged
inference proof.

All 74 focused Search unit tests, typecheck, lint, both production builds, and five real-Chromium
Search/model scenarios pass. Chromium now executes the coordinator against encrypted IndexedDB
and returns the expected exact-phrase result without semantic setup.

Index creation/discovery controls, remote setup, real packaged MiniLM inference, and the Library UI
remain pending.

## 4.16 Persistent Library Search surface

### RED

The packaged Library had no Search form, results surface, semantic setup state, live-query
reconciliation, or narrow-layout proof. Initial implementation checks also exposed descending CSS
specificity warnings, retained Search plaintext across Vault lock and replacement, discarded the
Search context when returning from detail, and surfaced an expired cursor as a generic failure.

### GREEN

Added the persistent labelled Search form below the Vault title, in-memory query/result state,
fifty-result paging, literal match badges, escaped selectable snippets, semantic list markup,
coverage and empty-state copy, and a deliberate two-step local model setup card. Search results
remain available through detail navigation, while lock and active-Vault replacement clear the
query and decrypted results. App-state invalidations refetch the submitted first page, and cursor
expiry announces the specified refresh message before safely resubmitting.

The rendered design lane now covers the Search form in the wide Library and a separate closed
390-pixel narrow shell. Both screenshots were inspected for wrapping, spacing, target size,
clipping, and hierarchy. Contrast auditing, extension typecheck, affected-file Biome checks, the
full 491-test unit run, and all seven packaged design scenarios pass.

Host, Captured, and Collection filters; Search settings and indexing controls; rendered result and
setup states; passage focus; and complete live multi-surface Search coverage remain pending.

## 4.17 Scoped Search filters

### RED

`tests/unit/search-filters.test.ts` first failed because no filter-boundary implementation existed.
The fixtures required normalized sorted hosts without ports, inclusive From and exclusive Before
UTC midnights, strict calendar validation, and rejection when Before precedes From.

The first packaged filter scenario then failed the rendered target-size gate because the visible
checkbox was only 20 pixels wide.

### GREEN

Added Host, Captured, and Collection filter controls derived only from decrypted Collections in the
current Library or Deleted scope. Multi-select values are sorted before entering the strict
protocol. Date fields produce canonical UTC-midnight bounds. Invalid ranges retain the Library
surface, focus a date field, and announce the precise correction.

Filter changes never submit Search. Submitted filters are snapshotted separately so a later
App-state invalidation cannot silently apply an edited but unsubmitted filter. Literal removable
chips and Clear filters affect only filters, while scope changes clear result and filter state but
retain the editable query. Lock and active-Vault replacement now also clear decrypted filter
options. Returning from result detail restores the Search scroll position without animated
scrolling.

The packaged Chromium scenario selects a real normalized Host, proves the Library remains visible
until Search is explicitly pressed, exercises invalid date feedback and Clear filters, and audits
the open filter at 1,280 and 390 CSS pixels. Both screenshots were inspected; the popover,
checkbox, wrapping, and surrounding layout remain visible without horizontal clipping. The 22
focused Search test files now pass with 77 tests, along with typecheck and affected-file Biome.

Search result/setup rendering, passage focus, settings, indexing controls, and complete live
multi-surface Search coverage remain pending.

## 4.18 Authoritative discovery and packaged keyword Search

### RED

A metadata-only Search document fixture failed because the builder required a body Artifact even
though the approved contract keeps such Captures keyword-eligible. The authoritative-source suite
then failed to import the absent adapter. It pinned local structured-content preference,
authenticated local text fallback, exact-length streaming, deterministic discovery revisions, and
refusal to open remote-only body Artifacts.

`tests/unit/search-discovery.test.ts` next failed to import restart-safe discovery. Its fixtures
required an empty durable Discover Job, one atomic checkpoint append per sorted Capture, a
transition to Keyword only after every checkpoint was stored, and crash resume without rebuilding
an existing checkpoint.

The first packaged run also exposed an App-state invalidation loop: reopening an already succeeded
Job still broadcast a completion wake-up, which caused the live Library to refetch and reopen the
same Job indefinitely.

### GREEN

Added:

- deterministic metadata-only Search documents;
- a bounded authoritative Library adapter that reads exactly the authenticated Artifact length,
  prefers `CONTENT_STRUCTURED`, falls back to strict UTF-8 `TEXT_EXTRACTED`, and never opens
  remote-only body content;
- streaming sorted discovery with plaintext released between Captures;
- atomic empty-generation creation, per-Capture checkpoint append, discovery completion, and
  interrupted-Discover resume;
- background discovery and keyword indexing when the unlocked Library is opened;
- in-memory Capture and Library-operation invalidation that starts a fresh generation on the next
  live Library reconciliation;
- durable pause/resume transitions that clear leases; and
- Search state backed by the current durable Job rather than a fixed Idle placeholder.

The background now exits without broadcasting when an already succeeded Job needs no work,
eliminating the live refetch loop.

The packaged Chromium design scenario captures a real page, waits for its encrypted keyword
materialization, submits **AWSM tall fixture**, receives the real exact-title result, and renders
the result and semantic setup state at 1,280 and 390 CSS pixels. Both screenshots were inspected
for hierarchy, wrapping, clipping, target size, and contrast. Twenty-four focused Search files pass
with 83 tests, along with typecheck, affected-file Biome, the packaged build, and the end-to-end
rendered scenario.

Durable invalidation across background restart, every synchronization/Import/Vacuum/epoch trigger,
Library visibility and disconnect handshakes, failure/retry transitions, provider batching, and
semantic packaged inference remain pending.

## 4.19 Live Search settings and safe shared-model removal

### RED

The Library had no Search settings tab, no live indexing controls, and no way to explain or safely
remove the device-wide public model. The approved removal contract also lacked its required opaque
per-Vault reference, so a cache deletion could not prove that no Vault still depended on the
model.

The first rendered confirmation exposed an action-order defect: the secondary **Cancel** action
inherited the dialog's primary cobalt treatment and measured only 4.31:1 against white text.

### GREEN

Added a live, generation-guarded Search settings tab showing keyword and semantic coverage,
provider identity, model dimensions and location, durable indexing state and progress, and the last
completed time. It offers pause, resume, rebuild, semantic setup/change, disable, and conditional
shared-model removal controls. Canonical invalidations refetch the open surface without trusting
notification payloads.

Local provider configuration now derives a stable opaque Vault reference with a distinct
non-exportable device-local HMAC-SHA-256 key. The reference and encrypted per-Vault setting change
in one IndexedDB transaction; repeated setup cannot duplicate it, and disabling semantics removes
it while clearing only semantic materialization. Removal is serialized with configuration and
disable operations, rejects while any manifest reference remains, and deletes only the verified
public model generation once the reference count is zero.

The Settings surface lists how many Vaults use the model and instructs the user to disable semantic
Search there first. The removal confirmation states exactly which local bytes are deleted and
which Captures, keyword materialization, and settings remain. Secondary actions now precede the
trailing danger action, resolving the contrast failure.

Twenty-five focused Search files pass with 85 tests. The full 56-scenario real-Chromium IndexedDB
lane passed before the final idempotence assertion; that focused semantic transaction scenario
then passed with the added one-reference-after-repeated-setup and zero-after-disable checks.
Typecheck and affected-file Biome pass. The packaged design scenario exercises the blocked,
enabled, confirmed, and completed removal states. Its model-in-use and confirmation screenshots
were inspected at 1,280 CSS pixels, the confirmation was also inspected at 390 CSS pixels, and all
rendered states pass the contrast and target-size audits.

Remote provider setup, safe provider-change confirmation, visibility/disconnect lifecycle,
durable invalidation coverage, packaged local inference, and complete multi-surface live-state
proof remain pending.

## 4.20 Explicit remote-provider setup and durable Library lifecycle

### RED

The remote adapter existed only as an isolated request boundary. There was no exact endpoint
permission ceremony, protected credential commit, expiring probe, provider-change confirmation,
Library visibility handshake, or durable failure state. A packaged attempt also proved that a
background permission request loses the browser's required user activation.

The narrow setup state initially inherited a cobalt dialog action with insufficient white-text
contrast. The first lifecycle pass also left an interrupted owner in `Running` until lease expiry
because the Library had no presence port and abort did not durably yield ownership.

### GREEN

Remote setup now normalizes and binds the exact endpoint origin and path/query identity, requests
least-privilege host permission directly from the Library's user activation, requires an explicit
unchecked disclosure, probes with a fixed non-user string, and retains the API key only in an
expiring Vault-bound memory buffer. Successful configuration atomically commits the encrypted
setting and an AES-GCM-protected credential whose additional data binds the Vault, credential,
endpoint, model, and dimensions. Disable or provider replacement deletes the old credential and
semantic rows in the same transaction.

Remote requests omit credentials and referrers, reject redirects, use bounded batches and
timeouts, preserve lifecycle cancellation, and retry only transient network, `408`, `429`, and
`5xx` failures with capped full jitter and `Retry-After`. Provider permission is rechecked at each
index gate and credential bytes are overwritten after provider construction.

The Library now maintains an unversioned, random-client runtime port reporting the active Vault
and document visibility. Hide, disconnect, Vault switch, provider change, and forced rebuild abort
the current plaintext batch and durably release its lease into the applicable waiting state.
Provider failures persist only a stable error ID; transient unavailability also persists a
five-minute retry deadline and schedules a browser alarm. A visible Library resumes the same
generation after the deadline, while explicit **Resume indexing** can retry sooner.

The dialog uses the root coral/ink primary token, and its secondary actions precede the primary
action. The packaged Chromium design scenario passes after exercising the complete pre-permission
remote ceremony at 1,280 and 390 CSS pixels. The wide, narrow top, and narrow scrolled-action
screenshots were inspected for disclosure prominence, wrapping, clipping, target size, and
contrast. Twenty-seven focused Search files pass with 92 tests, along with typecheck, affected-file
Biome, and the packaged build.

A live external endpoint probe is intentionally not claimed by the design lane: the provider
adapter has deterministic unit coverage and the protected-credential transaction has real
Chromium IndexedDB coverage. Per-Capture failed-checkpoint accounting and final multi-surface
verification remain pending.

## 4.21 Durable invalidation and accessible result focus

### RED

The background's invalidation set vanished on service-worker restart, so a synchronized,
recovered, imported, vacuumed, or otherwise replaced authoritative Vault head could retain a
stale succeeded generation. Result navigation also discarded the selected passage and opened only
the ordinary Capture detail.

### GREEN

The repository now stores the last successfully indexed authoritative Vault generation in the
device-local operational store. Every indexing reconciliation compares that marker to the live
authenticated head; any mismatch creates a fresh local generation. This covers every activation
path that changes the head without importing or synchronizing Search rows. The marker is written
only after Job success, so interruption remains conservatively rebuildable. Its real-Chromium
round trip passes in the semantic transaction scenario.

Result navigation carries only Bundle and passage IDs in Library process memory. The background
re-authenticates the authoritative source, deterministically rebuilds its passages, and returns at
most the selected 768-byte passage. The detail surface renders a labeled, non-color-only Search
match treatment, applies temporary programmatic focus, honors reduced motion, scrolls the match
into view, and announces **Search match focused.** Query and passage text never enter the URL.
Missing or changed passages open the Capture normally, announce the stale condition, clear the
selection, and schedule a rebuild.

The packaged Chromium scenario captures a real structured paragraph, finds it by body text,
re-authenticates that structured passage, and focuses it under reduced motion. It asserts keyboard
focus and the query-free detail route, passes target-size and contrast audits, and retains an
inspected wide screenshot that also shows the source Structured content Artifact.

## 4.22 Real browser MiniLM inference and release notices

### RED

The initial real-model Chromium gate failed before tokenizer initialization. Transformers.js
queries a custom Cache using both local-path strings and `Request` objects, while the adapter
recognized only immutable URL strings. That made verified model files appear absent. The release
archives also lacked the required dependency and model notices.

### GREEN

The verified read-only cache now recognizes only two representations of each pinned file: its
immutable Hugging Face revision URL and the exact Transformers.js local path for the pinned model.
Both resolve through the already hash-verified promoted generation. Unknown model paths and hosts
remain unavailable, writes still fail, and inference installs a fetch function that always
rejects.

An opt-in real-Chromium gate accepts only a directory containing the exact pinned files, loads the
real Transformers.js tokenizer and int8 ONNX model through the shipped asyncify WASM runtime, and
asserts two finite, normalized, distinct 384-dimensional embeddings. All six downloaded proof
files matched the manifest's exact byte counts and SHA-256 digests. The gate then passed in 2.4
seconds with network fallback disabled, proving the reported `import.meta` rewrite does not affect
the explicitly supplied WASM paths.

Tracked notices now record exact Transformers.js, MiniLM, ONNX Runtime, and Noble Hashes
provenance plus complete Apache-2.0 and MIT terms. Chrome and Firefox production verifiers require
the notice. Production builds pass, Chrome and Firefox ZIPs each contain one notice and one WASM
runtime pair, and the Firefox source ZIP contains the tracked notice. The reporter lists emitted
assets twice, but filesystem and ZIP inspection prove a single 23,567,050-byte WASM file per
target.

## 4.23 Atomic failed-Capture retry

### RED

After the remote adapter exhausted its bounded request attempts, the Job stored a safe failure but
left the exact Capture checkpoint pending with no incremented attempt count. Resume therefore
could not prove which Capture was being retried.

### GREEN

An exhausted semantic provider request now atomically transitions the owned Job and exact semantic
checkpoint to `Failed`, increments both failed-Capture and checkpoint-attempt accounting, stores
only the stable error ID, clears the lease, and retains the capped retry deadline. The alarm path
recognizes the already failed transaction rather than trying to fail it a second time.

Explicit or due automatic resume atomically resets failed checkpoints to `Pending`, removes their
stable errors, decrements failed-Capture accounting, and returns the same Job generation to
`Created`. A missing indexed-head marker no longer forces a replacement generation while an
incomplete Job exists; only an explicit rebuild, a changed persisted authoritative generation, or
a legacy succeeded Job without a marker does so.

The focused indexer suite proves the semantic provider-error mapping and five-minute retry
deadline. It also proves that a malformed embedding count records
`SEARCH_PROVIDER_RESPONSE_INVALID` on the exact checkpoint without a transient retry deadline. A
real-Chromium IndexedDB scenario proves atomic Job/checkpoint failure and resume round-trip.

# 5. Performance and Rendered Evidence

The deterministic opt-in performance lane uses 10,000 Captures, 100 Collections, 500 hosts, mixed
Active and Deleted status, mixed prose/preformatted/table-like text, 384-dimensional vectors,
median 12 passages, and p95 40 passages. It performs one warm run and twenty measured runs on the
repository's Linux reference environment.

The first keyword run failed RED at 107.16 ms p95. `rankKeywordRows` repeatedly filtered every
Capture's fields and allocated flattened token arrays inside the BM25F loop. Grouping fields once
per row and calculating local and total term frequencies without flattened token arrays reduced
the measured gate to:

| Gate                                      | Measured p95 / retained heap | Required |
| ----------------------------------------- | ---------------------------- | -------- |
| Warm common-term keyword ranking          | 68.26 ms                     | ≤100 ms  |
| First 50 result serialization             | 0.07 ms                      | ≤50 ms   |
| Semantic ranking plus fusion after embed  | 9.86 ms                      | ≤500 ms  |
| Keyword corpus retained heap              | 163.98 MiB                   | <256 MiB |
| Semantic corpus incremental retained heap | 75.00 MiB                    | <256 MiB |

The heap lane ran under `node --expose-gc` with Vitest's worker-thread pool and measured retained
heap after collection. Remote provider unit tests prove sequential retry and exactly one request
at a time; the indexer awaits each bounded batch before constructing the next. Search sessions are
memory-only, retain at most 1,000 result identities, expire after ten minutes, and are covered by
the coordinator suite. Indexing and inference execute in the extension background context, not on
the Library document's main thread. The packaged Library design journey remains responsive and
passes its interaction-target checks while indexing wakes in the background.

Rendered evidence includes inspected wide and narrow Search results, host filtering, Search
settings, remote setup, shared-model removal, and wide reduced-motion structured-passage focus.
The checked-in fixtures contain only deterministic synthetic Capture content and a non-secret
design credential. No user content or operational credential was retained.

# 6. Final Verification

The final current-worktree verification completed on 2026-07-26:

- `corepack pnpm lint`: design contract and Biome passed across 391 files with no warnings;
- `corepack pnpm typecheck`: TypeScript passed;
- `corepack pnpm test`: 30 Node release-workflow tests and 512 Vitest tests passed, with two
  intentional opt-in skips;
- `corepack pnpm test:integration`: 57 real-Chromium IndexedDB scenarios passed and the opt-in
  real-model scenario skipped in the ordinary lane;
- the opt-in real-model Chromium scenario separately passed with the six exact pinned model files
  and network fallback disabled;
- the opt-in 10,000-Capture performance lane passed every latency and memory gate with the
  measurements above;
- `corepack pnpm test:e2e:design`: all seven packaged-extension and public-site rendered scenarios
  passed after the Search privacy/security copy baselines were inspected and deliberately updated;
- the Firefox stable production Capture journey passed and returned the same exact-title Search
  tier used by the packaged Chromium fixture;
- the two affected Rails public-page request suites passed 17 examples;
- `corepack pnpm build`: Chrome and Firefox production builds and their static security verifiers
  passed;
- `corepack pnpm zip`: Chrome, Firefox, and Firefox source archives passed release, notice, and
  archive verification;
- Prettier passed on all affected Markdown, Biome passed on affected source, and
  `git diff --check` passed.

WXT reports the emitted model runtime and notice entries twice and warns about Transformers.js
`import.meta` under IIFE output. The archives and filesystem contain one runtime pair and one
notice per browser, while the real-browser MiniLM gate proves the explicitly configured WASM path
works. These are reporter/bundler warnings, not failed release gates.
