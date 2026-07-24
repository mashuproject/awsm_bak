# Capture Service Specification

**Document:** `specifications/runtime/capture.md`

**Version:** 1.0

**Status:** Draft

---

# 1. Purpose

The Capture Service converts live browser content into immutable Bundles suitable for long-term archival.

The Capture Service coordinates all browser interactions required to preserve a page.

---

# 2. Design Goals

The Capture Service MUST provide:

- deterministic capture
- resumable execution
- fault tolerance
- browser independence
- reproducible Bundles

---

# 3. Capture Lifecycle

Conceptually:

```
Capture Request

↓

Capture Job

↓

Capture Result

↓

Bundle

↓

BundleRegistered Event
```

Only successful Capture Results produce Bundles.

---

# 4. Capture Request

A Capture Request SHALL include:

- target tab
- target URL
- initiating user
- requested capture profile

Optional fields:

- user note
- user tags
- destination folder
- capture priority

---

# 5. Capture Job

The Runtime creates a Capture Job.

The Job tracks:

- Vault ID
- status
- progress
- retries
- diagnostics

Jobs are ephemeral.

Jobs are never synchronized.

The Vault ID is fixed when the Capture Command is accepted. Later active-Vault changes MUST NOT reroute an accepted Capture Job. Job persistence, recovery, notices, outcomes, and diagnostics remain scoped to that Vault.

---

# 6. Capture Pipeline

The standard pipeline is:

1. Validate permissions
2. Run capability preflight
3. Freeze page state
4. Collect metadata
5. Capture the rendered top document, accessible same-origin frames, live form state, open shadow
   roots, and an ordered resource inventory in one acknowledged frozen result
6. Capture the screenshot immediately from that frozen state
7. Acquire permitted resource bodies and record typed omissions
8. Derive structured content and normalized text from the frozen result
9. Stream and validate the mandatory page-snapshot ZIP64 container in temporary OPFS storage
10. Prepare one independently encrypted Object per successful Artifact
11. Generate and encrypt the Bundle Descriptor
12. Validate the exact descriptor and Artifact dependency closure
13. Atomically persist records, Event, Projection, and command outcome
14. Publish one canonical invalidation after commit

---

# 7. Capability Preflight

Before page capture begins, the Capture Service SHALL run a capability preflight.

Preflight determines:

- available Host capture APIs
- supported page representations
- screenshot capabilities
- permission availability
- restricted URL status
- Capture Profile compatibility

The Capture Job records preflight results. The Capture Service SHALL adapt the remaining pipeline to available capabilities or fail before Bundle generation if the requested Capture Profile cannot be satisfied.

---

# 8. Freeze Page

The Runtime SHOULD minimize observable page changes during capture.

Implementations MAY:

- pause scrolling
- delay navigation
- await network idle
- coordinate with content scripts

Perfect freezing is not guaranteed for all pages.

---

# 9. Metadata Collection

Metadata MAY include:

- URL
- title
- capture timestamp
- MIME type
- HTTP status (if available)
- viewport size
- browser version
- extension version

Metadata becomes part of the Bundle.

---

# 10. Page Representation

A Capture Profile determines which representations are produced.

The first implementation profile SHALL be:

```text
WebPageSnapshot-v1
```

This profile requires:

- an HTTP(S) target
- one valid AWSM page-snapshot Artifact with Kind `CAPTURE`, Role `PRIMARY`, and MIME type
  `application/vnd.awsm.web-page+zip`
- required capture metadata

The page snapshot preserves the post-render DOM, live non-file form state, accessible same-origin
frames, captured resource bodies, and typed omissions. Its canonical contract is defined by the
Page Snapshot Container Specification. MHTML is an on-demand, inert download derivative and is
never an Artifact or synchronized Vault state.

The profile requests a lossy full-page WebP as a best-effort Artifact with Kind `IMAGE`, Role
`SCREENSHOT_FULL`, and MIME type `image/webp`. The snapshot remains the mandatory preserved
representation; the screenshot is a space-efficient visual preview.

The profile also requests a 640×360 WebP `THUMBNAIL`, canonical-CBOR-sequence
`CONTENT_STRUCTURED`, and normalized UTF-8 `TEXT_EXTRACTED`. These are best effort. Structured and
text outputs SHALL derive from the same size-bounded live-DOM block sequence. A browser Host that
collects the sequence through an injected page function SHALL return it in one acknowledged script
result so page lifecycle changes cannot interrupt a multi-message producer handshake.

Failure to produce the WebP SHALL record a typed warning but SHALL NOT invalidate an otherwise
valid required snapshot.

---

# 11. Screenshot

The Runtime SHOULD capture:

- viewport screenshot
- full-page screenshot (when supported)

Large pages MAY require stitched captures.

When the native-resolution bitmap exceeds the Host's safe canvas dimension, the Chrome Host SHALL retain the top-left region at native resolution up to 16,384 pixels on each axis, persist that valid partial screenshot, and record `SCREENSHOT_TRUNCATED`. It SHALL NOT discard an otherwise valid partial image or downscale it to fit.

The initial Chrome Host SHALL implement full-page capture by scrolling, throttling visible-tab captures, stitching tiles in a trusted extension context, and restoring page scroll and temporary styles even after failure.

---

# 12. Auxiliary Artifacts

Optional artifacts include:

- favicon
- extracted text
- readability output
- user annotations
- cookies (disabled by default)
- response headers (if permissions allow)

---

# 13. Bundle Graph Generation

The Capture Service prepares every successful Artifact independently, then creates one compact
Bundle Descriptor referencing those Artifacts.

The descriptor SHALL describe every Artifact and SHALL contain no payload bytes.

The Bundle becomes immutable immediately after creation.

---

# 14. Persistence

Successful Bundles SHALL be written through the Storage Service.

The descriptor record, every Artifact record, `BundleRegistered`, Projection update, and command
outcome MUST commit atomically. Prepared wrapper files SHALL be removed if validation or commit
fails. Startup reconciliation SHALL remove unreferenced prepared files.

---

# 15. Events

Successful capture SHALL emit:

- BundleRegistered

`BundleRegistered` MUST include the assigned Collection ID. Before registration, the Runtime selects the newest Active Collection containing an exact fragmentless match for the captured URL, with query parameters significant and ascending Collection ID as the final tie-breaker. If none matches, it generates a new Collection ID. Hosts and storage Drivers MUST NOT decide this routing policy.

Failures MAY emit diagnostic Runtime Events.

Capture Jobs themselves are not synchronized.

---

# 16. Failure Recovery

Recoverable failures MAY retry individual pipeline stages.

Permanent failures terminate the Capture Job.

Partial authoritative Bundle graphs SHALL NOT be persisted.

Because live page state is external and mutable, interrupted page acquisition SHALL NOT resume automatically. Recovery SHALL mark the Capture Job interrupted and require an explicit new user action to retry.

If recovery detects that the original Command's authoritative transaction already committed, it SHALL report the existing successful result rather than create another Bundle or Event.

---

# 17. Capture Profiles

Implementations MAY define profiles.

Example profiles:

- Minimal
- Standard
- Complete
- Research
- Custom

Profiles specify which Artifacts are required and which Host capabilities are mandatory.

Profile identifiers and versions are stable persisted values. Hosts SHALL reject profiles whose mandatory capabilities they cannot satisfy before Bundle generation.

---

# 18. Browser Compatibility

Hosts SHALL expose browser capabilities.

Unavailable capabilities SHALL degrade gracefully.

Examples include unavailable screenshot capture, restricted URLs, and inaccessible frames or
resources.

---

# 19. Invariants

Capture Jobs are ephemeral.

Bundles are immutable.

Successful captures produce exactly one Bundle.

Incomplete Bundles are never stored.

Capability preflight completes before any Bundle is generated.

The `WebPageSnapshot-v1` profile never persists a Bundle without a valid canonical page snapshot.

Screenshot and omission warnings never weaken mandatory snapshot validation.

---

# References

bundle/bundle.md

runtime/runtime.md

storage/object-store.md
