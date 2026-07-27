# Product Requirements Document

**Document:** `docs/plans/01-mvp-prd.md`

**Status:** Draft

**Owner:** Product

**Last Updated:** 2026-06-27

---

# 1. Executive Summary

Archive Platform is a privacy-first, local-first knowledge preservation platform that enables users to permanently archive digital information while retaining complete ownership of their data.

Unlike traditional bookmark managers or note-taking applications, Archive Platform captures complete snapshots of digital content, preserves them as immutable records, enriches them locally using artificial intelligence, and synchronizes encrypted objects across trusted devices.

The platform is built around a zero-knowledge architecture. User content is encrypted before leaving trusted devices, ensuring that the service provider cannot read, analyze, or monetize archived information.

The first release focuses on web page archival through browser extensions. The long-term vision expands to become a general-purpose personal knowledge archive supporting many digital content types.

---

# 2. Problem Statement

The modern web is transient.

Users regularly encounter situations where:

- articles disappear
- documentation changes
- discussions are edited or deleted
- web applications evolve
- URLs become invalid
- images are removed
- embedded media becomes unavailable

Traditional bookmarking systems preserve only links.

Traditional note-taking systems often preserve extracted text but not the original source.

Existing archival solutions either:

- fail to preserve dynamic web content,
- expose user data to centralized services,
- require server-side processing,
- or provide limited search and organization capabilities.

Users need a system that faithfully preserves information while respecting privacy.

---

# 3. Product Vision

Archive Platform enables users to build a permanent digital knowledge library.

Every archived Bundle becomes:

- permanently preserved
- searchable
- available offline
- synchronized securely
- AI-enhanced
- exportable
- user-owned

The platform should become the trusted repository for everything a user wishes to preserve.

---

# 4. Goals

## Primary Goals

### G1 — Faithful Preservation

Capture content with sufficient fidelity that it can be viewed years later even if the original source disappears.

---

### G2 — Privacy

The service provider must not be capable of reading archived content.

---

### G3 — Offline Operation

Users should continue using the product without network connectivity.

---

### G4 — AI Enhancement

Artificial intelligence should improve archived information without compromising privacy.

---

### G5 — Long-Term Durability

Archives should remain accessible regardless of future implementation changes.

---

# 5. Non-Goals

The platform is not intended to replace:

- collaborative documentation platforms
- real-time editors
- project management software
- cloud office suites
- enterprise content management systems

The focus remains knowledge preservation.

---

# 6. Target Users

## Primary

Researchers

Software developers

Students

Journalists

Writers

Lawyers

Consultants

Knowledge workers

Anyone maintaining long-term reference material.

---

## Secondary

Teams requiring encrypted knowledge archives.

Organizations preserving internal documentation.

Academic institutions.

Digital historians.

---

# 7. Personas

## Researcher

Needs permanent references.

Requires citations.

Frequently revisits archived material.

Values search accuracy.

---

## Developer

Archives documentation.

Stores blog posts.

Captures GitHub issues.

Archives Stack Overflow discussions.

Uses AI summaries.

---

## Student

Archives learning material.

Organizes subjects.

Searches by concept.

Uses AI-generated summaries.

---

# 8. User Stories

## Capture

As a user,

I want to archive a web page,

so that I can access it in the future even if it disappears.

---

As a user,

I want the archived page to look like the original.

---

As a user,

I want dynamic content preserved whenever possible.

---

## Search

As a user,

I want to search my archive instantly,

without requiring an Internet connection.

---

## AI

As a user,

I want summaries generated locally,

without exposing private information.

---

As a user,

I want AI-generated tags and keywords.

---

## Organization

As a user,

I want folders and tags.

---

As a user,

I want notes attached to archived content.

---

## Synchronization

As a user,

I want multiple devices synchronized securely.

---

## Privacy

As a user,

I want confidence that the service provider cannot read my archives.

---

# 9. Functional Requirements

## Capture

The system shall:

- capture complete web pages
- capture page metadata
- attempt full-page screenshots and report a warning when the Host cannot produce one
- preserve a bounded thumbnail plus normalized text and structured semantic content when available
- preserve dynamic DOM state
- preserve page title
- preserve URL
- preserve timestamps
- preserve favicons
- preserve Open Graph metadata

The first `WebPageSnapshot-v1` Capture Profile requires a valid canonical AWSM page snapshot.

Every successful payload is an independently encrypted Artifact Object referenced by one compact
Bundle Descriptor. Mandatory snapshot failure rejects Capture; optional Artifact failure remains
visible through a typed warning.

Browser Hosts produce the same self-contained snapshot representation. The Linux Firefox Host
implements local Capture, portability, and optional synchronization parity. Its unlisted
Mozilla-signed desktop-Linux beta is distributed through the joint browser-extension GitHub
Release under Plan 19.

---

## Local Storage

The client shall maintain a local encrypted Vault replica.

Large Artifact reads and writes shall stream with bounded memory. A Bundle is authoritative only
after its descriptor and exact Artifact dependency closure commit atomically.

The local archive shall support:

- offline browsing
- offline search
- offline AI
- offline annotations

---

## Search

The client shall provide:

- deterministic title, URL, Host, Collection-title, and preserved-text keyword Search;
- exact title, canonical URL, and balanced quoted-phrase tiers;
- optional semantic Search through an explicitly configured local or remote embedding provider;
- Host, captured-date, and Collection filters;
- a Capture result with its best matching passage; and
- offline keyword Search, plus offline semantic Search after the local model is cached.

Search shall not require Coordination Server participation. Remote semantic Search is an advanced
opt-in mode that may disclose bounded plaintext passages and submitted queries only to the exact
user-configured endpoint after disclosure consent and Host permission.

---

## AI

The client shall support:

- summarization

- automatic tagging

- keyword extraction

- entity extraction

- embeddings

Future AI capabilities should integrate through a provider abstraction.

---

## Synchronization

The platform shall synchronize immutable Bundles, Vault Events, wrapped keys, and coordination metadata between trusted devices.

Implementation status: the Chrome extension and untrusted Coordination Server implement private
username/password Account authentication, client-only Account-key enrollment, one Complete
synchronized Vault, background convergence, synchronized Vacuum, manual heavy-Artifact storage
relief with on-demand retrieval, and export-first stale-Replica discard.
The Linux Firefox Host provides the same optional synchronization after native data-collection and
server-origin consent. Its signed unlisted desktop-Linux beta is distributed through the joint
browser-extension GitHub Release. Public browser-store listings, Selective Replicas, and production
deployment hardening remain future.

Synchronization shall:

- resume automatically

- support interrupted uploads

- converge by replaying ordered Events

- synchronize incrementally

- minimize bandwidth

---

## Security

The platform shall:

encrypt before upload

never transmit plaintext

verify object integrity

support device revocation

support encrypted backups

---

# 10. Non-Functional Requirements

## Performance

Archive creation:

Target:

<10 seconds for average pages.

Search:

<100 milliseconds for local queries.

Archive opening:

<500 milliseconds for cached captures.

Synchronization:

Background operation without blocking the UI.

---

## Scalability

The architecture should support:

millions of users

billions of archived objects

petabyte-scale encrypted storage

without architectural redesign.

---

## Reliability

Synchronization failures must never corrupt local archives.

Uploads must be resumable.

Stored Objects must be verifiable using integrity metadata.

---

## Portability

The client shall export the exact active Vault Generation as a passphrase-protected streaming ZIP64
Vault Package. Complete packages include every Artifact; Selective packages authenticate each
permitted heavyweight omission. Export shall remain distinct from Backup and shall not create a
local passphrase credential.

The client shall import a validated Complete Vault Package into a new local Vault. Import preserves
the package Vault ID, Generation, head, Events, Objects, and encrypted Artifact wrappers; creates
fresh device-local credentials and rebuildable Projections; and commits the imported Vault locked.
It rejects an existing Vault identity and valid Selective packages. Import is distinct from Restore,
does not merge or replace a Vault, and never uses the Export passphrase as a local unlock credential.

The platform should support:

Chrome

Firefox

Edge

Brave

Safari (future)

Desktop operating systems.

---

# 11. MVP Scope

## Implementation Sequence

The first executable slice is defined by `docs/plans/02-chrome-extension-capture-vertical-slice.md`.

It includes Vault onboarding/unlock, a mandatory browser-independent page snapshot, best-effort
full-page WebP, deterministic encrypted Bundle persistence, `BundleRegistered`, an offline
library, and derived MHTML download. The remaining items below describe the broader public-release
target and do not expand that first slice.

The first public release includes:

Browser Extension

- Capture current page
- Full-page screenshot
- Derived MHTML download
- Metadata extraction
- Local encrypted storage
- Local search
- Manual tags
- Manual folders
- Notes
- Synchronization
- Multi-device support

Backend

- Authentication
- Multi-tenancy
- Object storage
- Synchronization
- Device registry
- Billing foundation

Excluded:

- Sharing
- OCR
- Scheduled captures
- Mobile applications
- Public archives
- Semantic search
- Browser history import

---

# 12. Success Metrics

Technical

- Successful capture rate >99%

- Synchronization success >99.9%

- Search latency <100 ms

- Zero known plaintext leaks

User

- Daily active users

- Monthly retained users

- Average archive count

- Search usage frequency

- AI usage frequency

Business

- Storage growth

- Paid conversion

- Device count per account

---

# 13. Risks

## Browser API changes

Mitigation:

Introduce a browser abstraction layer.

---

## Storage growth

Mitigation:

Content-addressed object storage.

Compression.

Incremental synchronization.

---

## AI evolution

Mitigation:

Provider abstraction.

Regenerable artifacts.

Versioned AI outputs.

---

## Cryptographic mistakes

Mitigation:

Keep cryptography simple.

Use established libraries.

Never invent new algorithms.

Subject cryptographic design to external review before production.

---

# 14. Open Questions

How should encrypted sharing be implemented?

Workspaces expose one device-local active Vault plus an accessible Vault picker in Capture and Library surfaces. Selection is global on the device, persists until changed, locks the previous Vault, and sets the destination for subsequent Captures. Vault names are encrypted Event-derived state with a rebuildable local encrypted cache for locked display.

How should large media files be archived?

Should browser tabs automatically synchronize?

Should archive comparison become a first-class feature?

How should long-term key recovery operate?

These questions are intentionally deferred to later design and specification documents.

---

# 15. Acceptance Criteria

The MVP is considered complete when a user can:

1. Install the browser extension.

2. Create an account.

3. Archive any supported web page.

4. Browse archives offline.

5. Search archives offline.

6. Add notes.

7. Add tags.

8. Synchronize between two devices.

9. Restore a second device from the encrypted cloud backup.

10. Confirm that the backend never possesses plaintext archive contents.

---

# Appendix A — Product Principles

Every feature should improve at least one of the following:

- Preservation
- Privacy
- Performance
- Portability
- Simplicity

Features that compromise these principles require strong justification.

---

# Appendix B — Future Vision

The architecture should ultimately support a universal encrypted knowledge archive containing:

- Web pages
- PDFs
- Books
- Emails
- Images
- Videos
- Audio
- Source code
- Personal notes
- Research papers
- Office documents
- AI-generated knowledge artifacts

without requiring changes to the platform's core architecture.
