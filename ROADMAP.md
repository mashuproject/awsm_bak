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

## Redis-Backed Ephemeral Coordination

**Status:** Candidate

Replace PostgreSQL-backed one-use Cable ticket rows with atomic, TTL-bound digest entries in Redis
after Redis becomes an approved Coordination Server dependency. Evaluate using that same Redis
deployment as the Action Cable adapter so multi-process hint delivery and ephemeral authentication
share one operational dependency. The implementation plan must preserve 60-second expiry,
Account binding, atomic one-use consumption, digest-only storage, and polling as the sufficient
synchronization path when hints are lost.

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

## Firefox Extension Host

**Status:** Approved

Implement the Linux Firefox Manifest V3 Host defined by Phase B of
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md`. Gate A feasibility and
the browser-independent snapshot foundation are complete. Remaining stop gates require written
Mozilla data-classification guidance and explicit authorization for the first signed unlisted
beta. Firefox-specific behavior must remain behind Host or Driver boundaries and must not fork
canonical Vault, Bundle, Account, synchronization, or cryptographic contracts.

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

Prepare compatible AWSM versions for Firefox AMO and Chrome Web Store, but announce the first public
browser-store release only after both listings are live. Complete macOS and Windows Firefox proof,
Mozilla data-classification review, store privacy and permission disclosures, listing assets,
review handling, signed update delivery, release monitoring, and rollback procedures. Preserve the
separate unlisted Linux Firefox beta and verified GitHub artifacts until this initiative is
approved and implemented.

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

## Device Trust and Revocation

**Status:** Discovery

Define cryptographic Device identities, signed requests, enrollment approval, per-Device Vault key
wrapping, audit Events, capability restrictions, and revocation. Resolve the approval ceremony,
offline authorization, lost or compromised Device behavior, key rotation, and how revocation
interacts with synchronized history without giving the Coordination Server plaintext or unwrapped
keys.

---

## Account Credential Lifecycle and Recovery

**Status:** Discovery

Define password change, Account Recovery Keys, recovery Devices, and recovery after every enrolled
browser is lost. Account recovery and Vault recovery must remain distinct, and no email,
administrator, or server-side reset may gain access to plaintext Vault keys.

Alternative authentication methods such as passkeys, WebAuthn, OAuth, or SSO require a separately
approved contract. Resolve recovery ceremonies, key-envelope replacement, credential revocation,
all-browser-loss guarantees, and proof that recovery does not weaken the zero-knowledge boundary.

---

## Production Coordination Server Hardening

**Status:** Candidate

Promote the pre-release Coordination Server boundary with production quotas, abuse controls,
billing, shared immutable-byte storage, shared Cable and Job infrastructure, multi-process and
multi-host deployment, operational backup and restore exercises, alerting, incident response, and
independent security review.

The work must preserve opaque encrypted storage and bounded transfers. Before promotion, define
quota accounting, rate and signup controls, final-copy deletion policy, metadata and traffic
analysis, provider-independent shared storage requirements, recovery objectives, and production
evidence for failure, corruption, omission, and restore scenarios.
