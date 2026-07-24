# Capture Pipeline

**Document:** `architecture/13-capture-pipeline.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/05-client-runtime.md
- architecture/06-bundle-format.md
- architecture/12-processing-pipeline.md

---

# Purpose

This document defines how content enters the Archive Platform.

The Capture Pipeline converts data from external sources into immutable Bundles.

Capture is platform-independent.

Source-specific logic is isolated in Capture Adapters.

---

# Design Goals

The Capture Pipeline must provide:

- faithful preservation
- deterministic processing
- extensibility
- offline operation
- resumable capture
- validation
- reproducibility where practical

---

# Philosophy

Capture is the only time the platform observes external state.

After capture, the archived representation becomes immutable.

The pipeline therefore prioritizes completeness and fidelity over performance.

---

# Architecture

```
Capture Source

↓

Capture Adapter

↓

Capture Pipeline

↓

Bundle Builder

↓

Bundle

↓

Processing Pipeline
```

---

# Capture Sources

The platform may support multiple sources.

Examples:

- Browser Extension
- HTML Import
- PDF Import
- MHTML Import
- ZIP Import
- Email Import (future)
- Filesystem Import (future)
- Mobile Share Sheet (future)
- Public API (future)

All sources produce a common Capture model.

---

# Capture Adapter

The adapter is responsible for interacting with the external environment.

Examples:

Chrome Adapter

Firefox Adapter

Import Adapter

Filesystem Adapter

Adapters should contain no archival logic.

Their responsibility ends after producing a Capture.

---

# Capture Model

A Capture represents external data before archival packaging.

A Capture may include:

- primary content
- metadata
- binary Artifacts
- timestamps
- source information
- capture diagnostics

A Capture is mutable only while the pipeline is executing.

It is never persisted directly.

---

# Capture Phases

The pipeline executes the following phases.

```
Acquire

↓

Normalize

↓

Validate

↓

Package

↓

Freeze
```

---

## Acquire

Acquire data from the source.

Browser example:

- page URL
- page title
- rendered DOM snapshot and permitted resource bodies
- full-page screenshot
- favicon
- browser metadata

No transformation occurs.

---

## Normalize

Convert source-specific data into canonical internal representations.

Examples:

- normalize timestamps
- normalize MIME types
- normalize metadata keys
- normalize character encodings

Normalization should not discard information.

---

## Validate

Verify capture completeness.

Checks may include:

- required metadata present
- Artifacts readable
- supported formats
- checksum verification
- capture consistency

Invalid captures do not proceed.

---

## Package

Construct a Bundle using the Bundle SDK.

Responsibilities:

- assign identifiers
- populate manifest
- register Artifacts
- register metadata

The Bundle remains mutable during packaging.

---

## Freeze

Freeze the Bundle.

After freezing:

- no Artifacts may be added
- no Artifacts may be removed
- metadata becomes immutable

The Bundle is then passed to encryption and storage.

---

# Browser Capture

The browser adapter should collect, where available:

- current URL
- final resolved URL
- page title
- rendered page snapshot and permitted resource bodies
- full-page screenshot
- viewport dimensions
- document dimensions
- favicon
- capture timestamp
- browser name
- browser version
- extension version
- content type

Optional:

- response headers
- selected text
- user annotations
- scroll position

The platform should tolerate unavailable fields.

## Initial Web Page Capture Profile

The first implementation profile is `WebPageSnapshot-v1`.

The profile requires an HTTP(S) target, browser-neutral capture metadata, and a valid canonical
AWSM page-snapshot `PRIMARY` Artifact. It requests a lossy full-page WebP `SCREENSHOT_FULL` preview
on a best-effort basis.

Failure to collect, package, or validate the snapshot fails before Bundle persistence. Optional
omissions are typed in the snapshot and produce one `PAGE_SNAPSHOT_INCOMPLETE` warning. Failure to
encode the WebP records a warning and preserves the valid snapshot Bundle.

Live page acquisition is not automatically resumed after Runtime interruption because the external page may have changed. Recovery either recognizes an already committed Command outcome or requires a new user-initiated capture.

---

# Browser-Specific Considerations

Browser APIs differ.

The adapter abstracts these differences.

Examples:

Chrome and Firefox expose different screenshot, lifecycle, storage, and download APIs. Hosts adapt
those mechanics to the same frozen-snapshot and Artifact contracts. Native browser archive formats
are not Capture inputs.

The Capture Pipeline remains unchanged.

---

# Import Sources

Imported content should pass through the same pipeline.

Examples:

```
PDF

↓

PDF Adapter

↓

Capture
```

or

```
ZIP

↓

Import Adapter

↓

Capture
```

This ensures a single archival model regardless of origin.

---

# Capture Metadata

Every Capture records provenance information.

Examples:

- source type
- capture method
- capture version
- originating application
- adapter version

This metadata supports deterministic debugging of the canonical format.

---

# Error Handling

Capture failures should be classified.

Examples:

Recoverable:

- temporary browser error
- transient filesystem error

Non-recoverable:

- unsupported format
- corrupted input
- permission denied

Partial authoritative Bundle graphs are never created. The Runtime prepares independently encrypted
Artifact wrappers, creates the compact descriptor last, validates the exact dependency closure, and
commits all records and `BundleRegistered` atomically. Failed preparation removes every temporary
wrapper.

---

# Determinism

Given identical input and identical adapter versions, the pipeline should produce equivalent Bundles where practical.

Sources of unavoidable variation (for example, timestamps) should be explicitly identified.

---

# Security

Capture Adapters must treat all external input as untrusted.

Validation occurs before registration. MHTML and screenshots stream across Host boundaries in
acknowledged bounded chunks. Structured content uses bounded acknowledged batches and excludes
hidden content and unsafe links.

Executable content is preserved as data, not executed by the pipeline.

---

# Extensibility

New Capture Adapters require no changes to the Capture Pipeline.

They need only produce a valid Capture model.

---

# Design Decisions

## Why Separate Adapters?

Platform-specific code changes more frequently than archival logic.

Isolation minimizes maintenance.

---

## Why Phase-Based Processing?

Phases simplify testing, validation, and future enhancements.

---

## Why a Common Capture Model?

A unified internal representation enables all sources to share the same Bundle creation logic.

---

## Why Preserve Rather Than Interpret?

The platform's primary responsibility is archival fidelity.

Interpretation belongs to later processing stages.

---

# Open Questions

Should multiple captures of the same URL be automatically linked?

Should failed captures be retained for diagnostic purposes?

How should dynamic or continuously updating pages be represented?

What capture capabilities should be required versus optional for each adapter?

---

# References

- `docs/architecture/06-bundle-format.md`
- `docs/architecture/12-processing-pipeline.md`
- `docs/architecture/14-trust-and-device-management.md`
