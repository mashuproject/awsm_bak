# Capture Runtime Specification

**Document:** `docs/specifications/runtime/capture.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/bundle/bundle.md`
- `docs/specifications/bundle/page-snapshot.md`
- `docs/specifications/vault/collection.md`

# 1. Purpose

Capture turns one live source observation into one immutable Bundle and, when permitted, one
Bundle Registered Event. Acquisition is local trusted workflow; only the accepted Event makes the
result Vault authority.

# 2. Pipeline

The Runtime:

1. fixes the selected Vault, expected Frontier, adapter, profile, and stable local workflow key;
2. validates browser or source-adapter capabilities and permissions;
3. freezes or snapshots the source as closely as the adapter permits;
4. acquires the mandatory primary representation and optional representations;
5. constructs and verifies every Artifact Object and encrypted wrapper in Prepared Data;
6. constructs and verifies the Bundle Descriptor;
7. derives automatic Collection routing from the accepted parent state;
8. prepares and signs Bundle Registered with the Descriptor dependency;
9. compare-and-swaps the complete accepted Frontier and revalidates if it changed; and
10. atomically promotes Objects, Event, Replica Safety State, and outcome, then rebuilds or updates
    Materializations.

A mandatory failure produces no Bundle Event. Optional failure is represented only by an exact
Descriptor warning. Prepared files are cleaned after failure, cancellation, or successful
promotion.

# 3. Base web profile

The base profile key is `awsm.capture.web-page-snapshot`. It requires one primary
`application/vnd.awsm.web-page+zip` Artifact following
`docs/specifications/bundle/page-snapshot.md`. Optional outputs are a
full WebP screenshot, 640 by 360 WebP thumbnail, canonical structured content, and normalized UTF-8
text. MHTML is an inert on-demand derivative and never stored as canonical Vault content.

The adapter freezes rendered DOM and live non-file form state, collects accessible same-origin
frames and permitted resources, records typed omissions, then captures the screenshot from that
same observation as closely as browser APIs allow. File input paths and bodies, credentials,
cookies, authorization headers, executable replay behavior, and inaccessible cross-origin content
are excluded.

# 4. Routing

Before registration, the Runtime uses `docs/specifications/vault/collection.md`: exact normalized
fragmentless URL matching,
query parameters significant, effective active Collection redirects, and Collection Tail ordering
by causality then Record ID. A merge conflict that makes routing ambiguous creates a fresh
Collection rather than blocking Capture.

# 5. Offline and fenced Capture

Ordinary network disconnection does not block Capture. If portable authority is security-fenced or
the member cannot currently author a valid Event, the complete verified result may remain in
Prepared Data with an explicit user-visible pending state. It may later be committed if valid,
re-authored into eligible continuing state, or preserved by Fork or Export. It is never presented
as synchronized authority before an Event commits.

# 6. Recovery and idempotency

Live acquisition is not resumed after interruption because the source may have changed. The
Runtime first checks the workflow outcome: a committed result returns the existing Bundle; an
uncommitted acquisition requires explicit retry. Event Re-authoring uses the deterministic
recovered Bundle ID contract, while ordinary Capture uses a new random Bundle ID.

# 7. Security

Page code and imported DOM are adversarial. Acquisition runs through bounded adapter messages;
rendering is inert; scripts and active navigation never execute from a preserved snapshot. Exact
size, count, timeout, redirect, origin, and memory limits are owned by
`docs/specifications/bundle/page-snapshot.md`.

# 8. Invariants

- One successful ordinary workflow creates exactly one Bundle ID.
- No incomplete mandatory dependency graph becomes authoritative.
- Capture remains available during ordinary Replica partition.
- Browser adapter capability is not Vault authority.
- Capture Jobs, diagnostics, and Prepared Data never synchronize.

# References

- `docs/specifications/event/commands.md`
- `docs/specifications/runtime/jobs.md`
- `docs/specifications/runtime/synchronization.md`
