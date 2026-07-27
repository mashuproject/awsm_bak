# AWSM Roadmap

This roadmap records unresolved future product initiatives. It is not an implementation history,
architecture specification, or authorization to build. Decision-complete work requires an approved
numbered plan and reconciliation with the owning specifications.

## Initiative Statuses

- **Discovery:** the problem, feasibility, or major architectural choices remain open.
- **Candidate:** the direction is coherent, but scope, dependencies, or acceptance criteria remain
  open.
- **Approved:** explicitly approved for conversion into a numbered implementation plan.

---

## Hosted Redis Coordination Rollout

**Status:** Candidate

Reinspect the mutable hosted topology, provision private Redis networking and protected
credentials, select exact application and Redis revisions, and define deployment and rollback
order. Prove degraded mode and recovery, add basic capacity and failure monitoring, and confirm no
Redis port or credential becomes public.

---

## Highly Available Ephemeral Coordination

**Status:** Discovery

Choose standalone replicas plus Sentinel or a managed service and define failover, split-brain,
connection discovery, TLS, and acceptable ticket loss. Prove Action Cable resubscription,
multi-host capacity and fault injection, alerting and incident response, and whether persistence
remains disabled in the selected provider topology.

---

## Executable OpenAPI Contract Generation

**Status:** Candidate

Replace separately maintained OpenAPI YAML with executable Rails API contract specifications as the
authoritative source for exact HTTPS paths, methods, authentication scopes, request bodies,
responses, headers, and stable outcomes. Generate
`docs/specifications/protocol/http-api.openapi.yaml` deterministically from those specifications,
commit the generated artifact, and prohibit manual edits to it. Prefer a permissively licensed,
Rails 8.1-compatible RSpec generator such as RSwag after recording the exact version and license.
Do not infer the contract merely by observing controller traffic: required fields, strict
unknown-field rejection, UUID and byte-length formats, enums, Account versus VaultDevice
authorization, security failures, and unexercised error responses must remain explicit executable
declarations.

Extract reusable Ruby schema definitions for common identifiers, authenticated sessions, Recovery
Kits, Device certificates, Device key envelopes, encrypted Object metadata, and outcomes so
operation specifications do not duplicate their shapes. Continue using Committee to validate real
requests and responses against the generated artifact. Generate extension wire types and, where
practical, its HTTP client boundary from that same artifact without allowing generated code to
bypass Runtime validation or introduce a second domain model.

The implementation plan must define a cold conversion that preserves the complete current
contract while each endpoint moves to the executable source, then removes every hand-maintained
schema fragment. Add deterministic generation, formatting, OpenAPI validation, Rails-route
coverage, operation and response coverage, stale-artifact detection, and generated-client
typechecking to local verification and CI. CI must fail when regeneration changes a tracked
artifact, a Rails API route lacks a declared operation, a declared operation lacks contract
evidence, or implementation behavior violates the generated contract. Keep prose specifications
authoritative for transport-independent security and behavioral invariants, but remove duplicated
JSON field inventories once the generated OpenAPI artifact owns those exact wire shapes.

---

## Repository Implementation and Impact Map

**Status:** Candidate

Create a maintained repository map that lets an agent starting from a cold checkout locate the
authoritative implementation, tests, contracts, generated artifacts, documentation, and
verification commands for each product area without repeating broad source searches. Cover at
least Account identity and lifecycle, Vault persistence, Capture, Library, Search, synchronization,
Device and recovery authority, server switching, storage, public Rails surfaces, browser Hosts,
release automation, and reference deployment operations.

The numbered implementation plan must first inventory the current repository and define which
mapping facts are hand-maintained, derived, or verified. Add:

- one concise human-readable implementation map with exact source, test, specification,
  architecture, and operational entry points for each area;
- an affected-files section template for future numbered plans;
- one canonical subsystem-to-command table covering formatting, lint, typecheck, unit,
  integration, browser, Rails, synchronization-proof, packaging, and release checks;
- generated-file ownership and regeneration commands;
- a terminology-to-code map for foundational concepts such as Account, Vault, Device, Host,
  Replica, Runtime, Object, and Artifact;
- explicit dependency links beside foundational schemas and API contracts; and
- a lightweight repository-owned impact command, such as `script/impact-map <area>`, that prints
  the known implementation, test, contract, documentation, and generated consumers for an exact
  area.

Keep the map navigational rather than independently normative: design principles, glossary, formal
specifications, and approved plans retain their existing authority. Do not infer dependencies from
filenames alone, copy host-local paths or deployment secrets into tracked files, or claim that a
map proves completeness merely because a search returned no additional matches.

Acceptance requires a cold-agent exercise across at least Account, synchronization, and release
work; deterministic output and actionable errors for unknown/stale areas; link and path validation;
stale-map detection in CI; documentation for adding and renaming areas; and proof that the map
reduces discovery to a bounded confirmation pass while still requiring current-state verification.
Define an owner and review trigger so foundational moves, new contracts, generated artifacts, or
test-command changes update the map in the same change.

---

## Preserve-First Stale Replica Recovery

**Status:** Candidate

Add an explicit alternative to destructive stale-Replica discard. Retrieve every stale payload from
the retained Recovery Snapshot, decrypt and re-encrypt the complete stale state under fresh Vault,
Generation, Event, Object, Bundle, Artifact, Collection, key, and device identities, and activate it
as a local-only Vault only after complete validation. This future flow must preserve bounded
streaming, remain distinct from Import/Restore, and never weaken the current export-first discard
contract.

---

## Native Download Boundary Journey Proof

**Status:** Candidate

Add a test-only Download Host that replaces only the native save-file interaction which packaged
headless browsers cannot reliably automate. Use it to complete the successful Export branch of
stale-Replica discard and prove that the emitted encrypted Vault Package imports into a fresh
local-only Vault. The test Host must exercise the production Runtime encryption, package creation,
validation, and recovery sequencing without granting the shipped extension broader permissions or
bypassing the real Host in release builds.

---

## Static Archived Page Viewer

**Status:** Discovery

Define a sandboxed viewer for the canonical AWSM page snapshot so a user can view an archived page
inside AWSM instead of relying only on screenshots, extracted content, or a downloaded derivative.
Resolve script isolation, network prohibition, form behavior, missing-resource presentation,
frame composition, accessibility, and navigation before promotion. This initiative does not imply
that MHTML becomes authoritative or that captured scripts execute.

---

## Recorded Web Application Capture and Replay

**Status:** Discovery

Evaluate an optional high-fidelity Capture mode that records response traffic under stronger,
explicit browser permissions and can replay an interactive application offline in a controlled
environment. Resolve permission ceremonies, authenticated and non-GET traffic, credential
exclusion, service workers, storage APIs, script isolation, determinism, bounded storage, and the
zero-knowledge boundary. Also evaluate archive-first and time-relative link resolution without
changing ordinary links in the initial static snapshot contract.

---

## Coordinated Browser Store Release

**Status:** Candidate

Prepare compatible AWSM versions for a public Firefox AMO listing and Chrome Web Store, but
announce the first public browser-store release only after both listings are live. Complete macOS
and Windows Firefox proof, store privacy and permission disclosures, listing assets, review
handling, signed update delivery, release monitoring, and rollback procedures. Preserve the
unlisted Linux Firefox beta and verified GitHub artifacts until this initiative is approved and
implemented.

---

## Incognito Capture Contract

**Status:** Discovery

Define whether and how the Chrome Host may capture a page from an Incognito tab. The decision must
not treat Incognito as an ordinary window: users need an explicit contract for whether a Capture is
permanently encrypted into a regular Vault or retained in an isolated Incognito Workspace whose
content may disappear when the Incognito session ends.

Evaluate Chrome's spanning and split Incognito modes, including packaged Library routing, separate
background and offscreen contexts, IndexedDB and origin-private Artifact storage, Vault key access,
Account state, and lifecycle boundaries. A permanent regular-Vault design must detect the Incognito
source, obtain clear confirmation before persistence, and open Vault surfaces in a normal Chrome
window. An isolated design must define whether transfer, Export, or promotion into a permanent Vault
is possible without silently weakening Incognito expectations. Until one design is approved and
implemented, the extension should enforce its unsupported status rather than relying only on
documentation.

Required evidence includes packaged-Chrome journeys for page snapshots, MHTML download, full-page
screenshot, extracted text, structured content, cancellation, failure, locking, worker termination,
and Incognito-window closure. Tests must prove the chosen persistence boundary, prevent
cross-profile Vault-context confusion, and verify that plaintext or temporary Capture data does not
enter unintended storage or diagnostics.

---

## Zero-Knowledge Web Host

**Status:** Candidate

**Potential product surface:** a configurable production web origin, currently referred to as
`awsm.foo`.

Implement a trusted web Host for Library browsing, organization, local Search, Export, Import,
Vault management, and Account management. It must reuse the canonical Runtime, Account, Vault,
cryptographic, and synchronization contracts rather than create a parallel client or key model.
Capture remains extension-only for the first web-Host scope.

Before promotion, resolve supported browsers, storage-clear recovery, selective Import semantics,
local persistence boundaries, lifecycle behavior, accessibility, and the web-Host threat model.
Required evidence includes multi-client fault injection, bounded-memory transfers beyond 4 GiB,
authenticated omission-versus-corruption tests, and proof that no plaintext or content-derived
metadata crosses the Coordination Server boundary.

---

## Retrieval-Grounded Archive Answers with Gemma 4

**Status:** Discovery

Evaluate an optional trusted-client AI experience that answers questions about an unlocked Vault
from a bounded set of locally retrieved passages and links every material claim back to the
matching Capture. Use an exact Apache-2.0-licensed Gemma 4 model and a pinned, permissively licensed
local inference stack only after measuring download size, memory, latency, battery use, supported
hardware, quantization quality, cancellation, and browser lifecycle behavior. The model must
receive only the minimum retrieved plaintext needed for the requested answer; it must never scan
the Vault independently, communicate with the Coordination Server, or become authoritative.

Before promotion, define the user initiation and model-download ceremony, deterministic retrieval
boundary, prompt and model provenance, citation validation, unsupported-device behavior, and
whether a user may preserve an answer as a separately encrypted Derived Artifact. Search must
remain useful without generation, model failure must not alter authoritative data, and this
initiative must consume semantic Search results rather than use Gemma 4 as an embedding provider.

---

## Chrome Built-In Prompt API Host

**Status:** Discovery

Evaluate Chrome's built-in Prompt API and browser-managed Gemini Nano as an optional Host adapter
for the same retrieval-grounded answer capability. Keep the Runtime request, retrieved context,
citations, validation, and failure semantics provider-neutral; capability detection, user-activated
model download, session creation, top-level extension-document execution, and Chrome lifecycle
behavior belong behind the Chrome Host boundary.

Prove behavior when the API, required hardware, language, model download, or model session is
unavailable, and never silently fall back to remote plaintext processing. Firefox and unsupported
Chrome installations must retain complete Search and Library behavior without this adapter.
Evaluate browser-managed model updates, non-deterministic output, prompt-injection resistance,
structured-output validation, cancellation, memory clearing on lock or Vault change, accessibility,
and store privacy disclosures before promotion.

---

## Automatic Replica Retention and Pinning

**Status:** Candidate

Add persistent device-local Full and Selective retention profiles beyond the implemented manual
storage-relief workflow. Define automatic age, quota, least-recently-used, and storage-pressure
policies; per-Artifact or per-Capture controls; cache budgets; offline guarantees; and explicit
pinning such as `Always keep on this device`.

The policy must remain local to each Replica, preserve the server's zero-knowledge boundary, and
never delete a final unverified copy. Resolve retention defaults, final-copy safeguards, background
prefetch, eviction observability, and interactions with Export, Import, synchronization, Vault
Vacuum, server switching, and stale-Replica recovery before promotion.

---

## Alternative Account Authentication and Reset

**Status:** Discovery

Define optional Account identity methods such as passkeys, WebAuthn, OAuth, or SSO, plus whether a
privacy-preserving server-side password-reset ceremony is possible without introducing email
identity. Account reset must remain separate from Recovery Phrase-based Vault recovery: no
administrator, identity provider, or Coordination Server reset may gain access to plaintext Vault
keys or silently enroll a Device.

---

## S3-Backed Opaque Byte Storage

**Status:** Candidate

Replace the Coordination Server's Rails-local `DiskStore` with one provider-independent S3 Driver.
Bundle Apache-2.0-licensed VersityGW as the ordinary single-host self-hosted Compose service, backed
by a private persistent volume. Hosted production should use managed S3-compatible object storage
instead of VersityGW. Rails, synchronization semantics, and tests must depend only on the shared
S3 contract so changing deployments does not create different storage behavior or a compatibility
path.

The implementation plan must preserve bounded streaming, resumable and idempotent upload parts,
complete-object length and SHA-256 verification before `DurableUncommitted`, immutable publication,
full and ranged downloads, scoped authorization, verified deletion, and the existing zero-knowledge
boundary. PostgreSQL remains authoritative for upload state, publication, Generation membership,
Delivery Cursors, and Purge Job checkpoints; the S3 service stores only opaque encrypted bytes and
must not become a semantic database. Define private bucket provisioning, least-privilege
credentials, health/readiness behavior, incomplete-part cleanup, key layout, conditional-operation
requirements, backup and restore coordination, corruption and omission handling, and fault
evidence across process and service restarts.

The bundled VersityGW topology is deliberately single-host and non-HA: its durability depends on
the host volume and coordinated PostgreSQL/object-volume backups. Multi-host self-hosting requires
an explicitly selected shared S3-compatible backend. Validate the exact AWSM operation subset
against both VersityGW and managed S3, without relying on provider-specific notifications,
versioning, lifecycle rules, metadata semantics, or direct filesystem access. SeaweedFS remains a
possible advanced distributed self-hosted backend; RustFS requires a separate maturity evaluation.
MinIO and Garage are excluded from the default stack because their strong-copyleft or current
licensing terms conflict with the project's commercial-licensing flexibility absent a new explicit
owner decision.

---

## Production Coordination Server Hardening

**Status:** Candidate

Promote the pre-release Coordination Server boundary with production quotas, abuse controls,
billing, shared immutable-byte storage and Job infrastructure, multi-host deployment, operational
backup and restore exercises, alerting, incident response, and independent security review. Hosted
Redis rollout, highly available ephemeral coordination, and the S3-backed opaque-byte boundary
remain the separate initiatives above.

The work must preserve opaque encrypted storage and bounded transfers. Before promotion, define
quota accounting, rate and signup controls, final-copy deletion policy, metadata and traffic
analysis, provider-independent shared storage requirements, recovery objectives, and production
evidence for failure, corruption, omission, and restore scenarios.

---

## Hosted Plans, Billing, and Preview Waitlist

**Status:** Discovery

Define hosted service plans, quota presentation, billing provider boundaries, subscription
lifecycle, abuse controls, and whether a waitlist is useful before collecting any visitor data.
Resolve legal copy, consent, retention, support expectations, self-hosted differentiation, and
failure behavior without weakening local-only use or granting billing systems access to Vault
content. Until approved and implemented, the public website must not display pricing, plan teasers,
or collect visitor contact details.

---

## Authentic Product Screenshot Marketing

**Status:** Candidate

Replace public abstract product diagrams with, or supplement them using, deterministic screenshots
only after the redesigned extension UI and fixture states are stable. Capture real rendered
fixture-backed states at supported primary and narrow viewports, define a reproducible refresh
workflow, exclude user data and secrets, and prevent screenshots from promising unavailable
features. Website screenshot updates must remain coupled to material product-surface changes.

---

## Public Repository Repointing

**Status:** Candidate

After hackathon judging is complete and the active fork is fast-forwarded back into the canonical
repository, repoint public website, installation, Release, documentation, license, and source links
from `mashuproject/awsm_bak` to `parasquid/awsm`. Verify every destination and downloadable artifact
before changing the links; do not introduce redirects or dual-link compatibility into the product
surface.
