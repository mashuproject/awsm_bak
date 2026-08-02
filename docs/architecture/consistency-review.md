# Canonical Architecture Consistency Review

**Status:** Review Record — reconciled target; repository verification complete

**Evidence scope:** target reconciliation inspected 2026-08-01; implementation evidence updated
through 2026-08-02

**Implementation scope:** active browser and Host convergence

# 1. Result

AWSM's evergreen living documentation now describes one target architecture: a local-first,
location-independent encrypted Vault materialized by zero or more Replicas, operated by trusted
Clients, and optionally stored through opaque Replica Hosts. Portable Vault authority, Host-local
channel access, and Client-local API access are independent domains.

This is a repository-evidence conclusion about the target documents. It is not deployed-state
evidence and does not claim that the browser extension, Rails application, staging, or production
already implements the complete target. The repository now has a substantial canonical browser
substrate, including authenticated Continuity replay and a selected-readable-Replica Member
Recovery foundation. Shipped extension entrypoints, the generated Rails OpenAPI, Host behavior,
and current public pages still expose the earlier pre-release experiment where their inspected
code says so.

# 2. Authority used

The reconciliation applied the repository authority order:

1. `00-design-principles.md` for cross-cutting constraints;
2. `glossary.md` for canonical terms;
3. owning formal specifications for exact contracts;
4. the architecture series for component relationships; and
5. the living PRD, Vision, Roadmap, and README for product scope and evidence boundaries.

The two gitignored architecture-freeze working ledgers under `tmp/` supplied decision evidence.
They are not canonical sources after reconciliation. Numbered plans other than the living PRD were
left unchanged as historical records.

# 3. Canonical model

| Boundary                 | Reconciled contract                                                                |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Vault                    | logical, encrypted, location-independent, and complete as a concept                |
| Replica                  | one complete, sparse, stale, or converged materialization; no portable Replica ID  |
| Client Installation      | trusted container that may manage several Vaults, Replicas, and Credentials        |
| Client Credential        | portable Event-signing and key-delivery authority for one member                   |
| Account                  | optional username-based Host-local Channel Principal with no email                 |
| Replica Host             | storage/channel role; may be opaque and may coexist with a Client role             |
| Vault Member             | equal cryptographic and Recovery class; authority independent of Account access    |
| Vault Administrator      | portable governance role; one or more while a lineage remains writable             |
| Record model             | one signed DAG plus its Authority Parent subgraph; Event and Baseline Record kinds |
| Event model              | 14 Authority, 31 Content, and 2 Lifecycle base Event types                         |
| State                    | deterministic reduction of one authenticated Frontier in one Generation            |
| Time                     | signed audit/provenance only; never portable causality or authority                |
| Synchronization          | receiver-initiated pull with local validation and no privileged origin             |
| Hosting                  | immutable opaque item admission, inventory, reads, ranges, and Wake Hints          |
| Encryption               | independent Key Epoch Keys, per-member Recovery, no portable Vault Root Key        |
| History rewrite          | Vacuum resets Content history but retains an authority Continuity Proof            |
| Independent continuation | state-only Fork with fresh Vault, authority, Object, and entity IDs                |
| Persistence              | eleven logical storage families plus separately classified adjacent state          |
| Evolution                | Required Vault Features for semantics; Advisory Extensions only for ignorable data |
| Search                   | private rebuildable Materialization over authenticated Vault content               |

# 4. Exact contract ownership

The core specifications now own one initial canonical substrate:

- restricted deterministic CBOR, transcript framing, typed dependencies, and typed 32-byte IDs;
- three protected storage format identifiers for outer envelope, Vault Record, and Vault Object;
- Ed25519 Event signatures, SHA-256 identities, HKDF-SHA256 derivation,
  XChaCha20-Poly1305 content protection, and RFC 9180 HPKE Key Envelopes;
- one Event and Baseline envelope, signed causal and Authority Parent Frontiers, exhaustive base
  type registries, reducer classes, and conflict fences;
- Initial Baseline creation plus Genesis-only authority bootstrap, Vacuum successor proof, Closure,
  Historical View, Fork, and Event Re-authoring;
- exact authority ceremonies for Invitations, membership, administration, Client and Recovery
  Credentials, Key Epochs, Key Delivery, and feature activation;
- exact Collection, Folder, Tag, Note, lifecycle, conflict, and Baseline checkpoint structures;
- protected logical Objects separated from randomized destination-specific Opaque Storage Items;
  and
- Complete Export, Backup, Restore, opaque Host, Runtime, Job, Capture, Search, and persistence
  boundaries.

The generated HTTP OpenAPI remains owned by executable Rails routes and therefore remains current-
implementation evidence until implementation convergence replaces and regenerates it.

# 5. Contradictions closed during review

The audit did more than rename terms. It closed these implementation-significant contradictions:

1. Artifact wrappers are randomized physical representations resolved through Replica Safety
   State, not portable typed dependencies. Artifact Object ID remains the logical identity.
2. Vault Object IDs commit to Vault ID as well as type and canonical bytes, so a state-only Fork
   cannot reuse source Object identity accidentally.
3. Genesis depends only on the Initial Baseline. Initial Key Envelope slots live in the Baseline
   closure, avoiding duplicate dependency claims and content-addressing cycles; a successor's
   authenticated current checkpoint carries those slot candidates after the Initial Baseline is
   reclaimed.
4. Existing-Credential Enrollment is signed by the existing active Credential; recovery-authorized
   Enrollment is signed by the proposed Credential with separate Recovery authorization.
5. Invitation Creation binds both Redemption and Cancellation public verifiers while neither
   bearer secret enters portable history. A cancellation receipt binds a verifiable cancellation
   request, and one Redemption Authority serializes terminal use.
6. Authority Baselines retain the exact active Invitation, conflict candidate, receipt, Recovery,
   Epoch, Administrator, and fence state needed to continue without predecessor reachability.
7. Collection and Tag Baselines retain direct reversible redirect facts and controlling Cause IDs,
   not only transitive destinations, so Vacuum does not silently make active merges permanent.
8. Every retained predecessor Content fact needing a continuing cause identity receives a fresh
   Baseline Cause ID. Post-Baseline Content Events can name exact facts without retaining source
   Event identity, reachability, or invented ancestry.
9. Self-resignation ends contribution immediately but does not claim immediate cryptographic
   exclusion; obtainable old-Epoch updates remain best-effort until a later Epoch or Host cutoff.
10. Synchronization remains pull. Destination item admission is a separate idempotent workflow that
    prepares one fresh representation per logical item and destination.
11. Replica Safety State such as wrapper availability is not a disposable Projection, while Search
    indexes and other algorithm-dependent Materializations remain rebuildable and absent from
    Vacuum Baselines.
12. Shared transcript labels, dependency codes, Artifact digest domains, Host success outcomes, and
    protocol metadata were made internally exact instead of retaining competing spellings.
13. Capture and Note Baselines preserve Historical Attribution without treating source member or
    Credential identifiers as authority after a state-only Fork.
14. The earlier assumption that Vacuum could discard both Content and authority history made fresh
    phrase-only Recovery unable to prove that the Vacuum signer was an Administrator. The canonical
    Event envelope now signs a separate Authority Parent Frontier, and Vacuum permanently retains
    that compact Genesis-to-current Continuity Proof while discarding unrelated Content parents.

# 6. CAP and conflict posture

Portable Vault state favors availability and partition tolerance. Disconnected valid work is
accepted locally and later converges by authenticated DAG union plus deterministic type-specific
reduction. AWSM does not claim a linearizable global head, trusted clock, global freshness, or
global redundancy knowledge.

Conflicts are scoped rather than universal. Scalar presentation facts use causal precedence and a
non-time Record ID tie-break. Unique Note content, authority ambiguity, redirect cycles, sibling Key
Epochs, and sibling Vacuum successors retain every candidate and require their exact resolution or
an informed Vacuum/Fork choice. Narrow fences block only the unsafe capability wherever possible.

# 7. Current implementation boundary

Repository inspection, summarized in `implementation-convergence-impact.md`, found current browser
and Rails code organized around the superseded experiment. Accordingly this reconciliation did
not:

- change browser or Rails product behavior;
- change database schemas, routes, executable protocol types, or generated OpenAPI;
- relabel current Rails public pages as if target behavior shipped;
- implement the canonical glossary renderer;
- reset development, test, staging, or production data;
- inspect or mutate staging, production, Cloudflare, GitHub, or any other external service; or
- add compatibility readers, migrations, aliases, or dual formats.

Current public pages remain current-implementation copy. The Roadmap retains deterministic
rendering of the tracked canonical glossary as implementation work, preventing a second editable
definition source without pretending that behavior exists today.

Subsequent repository work has implemented canonical browser foundations without changing this
evidence boundary. In particular, selected readable-Replica Recovery now verifies the complete
authenticated authority state, matches phrase-derived public keys before phrase-authorized opaque
Envelope access, enrolls a fresh same-member Client atomically, and follows it with a
confirmation-gated all-head Recovery replacement. Focused real-crypto tests and a real Chromium
IndexedDB restart prove that narrow path. They do not yet prove phrase-only discovery without a
known Vault, a packaged management surface, multi-Remote withholding behavior, Rails Host opacity,
or any live deployment.

# 8. Deliberately future work

Foundational Vault semantics are no longer Roadmap questions. Genuine product or Host-policy work
remains forward-looking, including:

- implementation of the canonical Client and opaque Host substrate;
- exact generated HTTP routes and transport adapters;
- Host-local billing/resource responsibility, grace, suspension, and reaping policy;
- optional former-member Recovery Snapshots;
- direct peer and headless transports, thin and web Clients, and Runtime API Grants;
- activity-review and abuse-assistance views built on signed Event evidence;
- selective transfer, richer Notes, additional storage backends, and later Required Features; and
- release, native-platform, AI, accessibility, and operational initiatives already owned by the
  Roadmap.

These candidates may add implementations or explicit Required Features. They may not silently
reinterpret the canonical initial substrate.

# 9. Implementation handoff

`implementation-convergence-impact.md` is the cold-start impact map. It identifies current browser
and Rails modules, persistence and schema replacement, generated artifacts, test replacement,
public surfaces, implementation slices, destructive development reset consequences, and the later
authorization boundary for reference staging.

No implementation plan should use old numbered plans as current requirements. It must reconcile
the executable system directly to the living principles, glossary, owning formal specifications,
architecture, and PRD, deleting superseded experimental behavior instead of migrating it.

# 10. Verification record

Repository-only verification completed on 2026-08-01:

- a local-reference checker covered 68 living Markdown files; every Markdown link resolved;
- 448 backticked Markdown document paths resolved, and every declared `Depends On` Markdown path
  used a repository-root path;
- mechanical registry and body-owner checks found exactly 14 Authority, 31 Content, and 2 Lifecycle
  Event types plus 11 logical storage families;
- negative terminology searches found discarded names only in explicit current-implementation
  evidence or canonical statements that reject those concepts;
- `git diff --check` passed;
- `corepack pnpm exec prettier --check` passed for every changed Markdown file; and
- `corepack pnpm lint` passed, including the design-system check and Biome over 405 files with zero
  errors or warnings.

The unchanged generated HTTP OpenAPI remains current-code evidence and was not reformatted or
regenerated. No product source, Rails view, database, live deployment, browser state, staging,
production, Cloudflare, or other external service was changed or used as proof. Because this was a
documentation-only reconciliation with no rendered surface change, no visual assertion is part of
this review.

# References

- `docs/architecture/00-design-principles.md`
- `docs/architecture/glossary.md`
- `docs/plans/01-mvp-prd.md`
- `docs/architecture/implementation-convergence-impact.md`
- `ROADMAP.md`
