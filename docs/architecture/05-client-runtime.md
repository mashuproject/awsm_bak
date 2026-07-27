# Client Runtime Architecture

**Document:** `architecture/05-client-runtime.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/01-system-overview.md
- architecture/02-domain-model.md
- architecture/03-zero-knowledge.md
- architecture/04-security-model.md

---

# Purpose

This document defines the architecture of the Archive Client Runtime.

The Client Runtime is the trusted execution environment responsible for all operations involving plaintext user data.

It is intentionally independent of any specific user interface or host application.

Browser extensions, desktop applications, and future mobile clients all embed the same logical runtime.

---

# Goals

The Client Runtime must provide:

- Offline-first operation
- Zero-knowledge processing
- Immutable archive management
- Local search
- AI processing
- Synchronization
- Encryption
- Rendering

without depending on backend participation.

---

# Runtime Overview

```text
                  Host Application

        Chrome Extension
        Firefox Extension
        Desktop App
        Mobile App

                  │

                  ▼

          Archive Client Runtime

     ┌────────────────────────────┐
      │ Capture Service            │
      │ Storage Service            │
      │ Search Service             │
      │ AI Service                 │
      │ Event Service              │
      │ Projection Service         │
      │ Synchronization Service    │
      │ Trust Service              │
     └────────────────────────────┘

                  │

          Local Database
          Local Object Store

                  │

          Coordination Server
```

The runtime exposes services to the host application.

The host provides user interface and platform-specific capabilities.

---

# Responsibilities

The runtime owns:

- vault management
- archive lifecycle
- bundle creation
- encryption
- decryption
- local persistence
- synchronization
- search
- AI
- rendering
- import/export

The runtime does **not** own:

- browser UI
- menus
- dialogs
- extension permissions
- browser APIs

These belong to the host.

---

# Runtime Modules

## Capture Service

Responsibilities:

- capture browser state
- extract metadata
- preserve page Artifacts
- invoke browser-specific adapters
- normalize capture output

Output:

A Capture Result.

Successful Capture Results produce immutable Bundles.

---

## Bundle Creation

Bundle creation converts a Capture Result into an immutable Bundle.

Responsibilities:

- package Artifacts
- package artifacts
- create manifest
- validate completeness
- assign bundle identifier

After bundle creation the Bundle becomes immutable.

---

## Encryption Engine

Responsibilities:

- derive Bundle, Event, and Projection keys
- encrypt Bundles
- wrap and unwrap Vault Root Keys for authorized local key slots
- verify integrity
- decrypt Bundles

The Encryption Engine never communicates directly with the server.

---

## Storage Service

Responsibilities:

- maintain local Object Store
- maintain bundle cache
- garbage collection
- integrity verification
- compression management

The Storage Service exposes opaque Object retrieval.

It does not interpret archive semantics.

---

## Search Service

Responsibilities:

- query Search Projection Materializations
- execute local queries
- rank results
- semantic search
- incremental indexing

The Search Service never sends plaintext or Search state to the Coordination Server. An optional
remote embedding adapter communicates directly with the exact user-configured HTTPS endpoint only
after active-Vault disclosure consent and Host permission.

Search Projection Materializations, settings, credentials, Jobs, checkpoints, queries, and paging
sessions remain local.

---

## AI Service

Responsibilities:

- summarization
- tagging
- embeddings
- OCR
- entity extraction
- keyword extraction

The AI Service operates on plaintext data inside the trusted runtime.

Generated Artifacts are persisted as immutable Objects and recorded through Events.

---

## Synchronization Service

Responsibilities:

- detect local Events and Objects
- upload missing Objects or Blocks
- download missing Objects or Blocks
- reconcile synchronization cursors
- coordinate device state
- verify integrity

The Synchronization Service does not understand browser APIs.

---

## Rendering Service

Responsibilities:

- reconstruct bundles
- decrypt Artifacts
- display captures
- render annotations
- render AI artifacts

Rendering occurs entirely locally.

---

## Trust Service

Responsibilities:

- unlock vaults
- manage active vault
- rotate keys
- manage device trust
- maintain vault metadata

Every runtime operation executes within a Vault context.

---

# Runtime State

The runtime maintains:

```text
Vault

↓

Archives

↓

Bundles

↓

Local Objects

↓

Projection Materializations

↓

Caches

↓

Pending Jobs
```

Authoritative and Vault-derived persistent state belongs to exactly one named Vault. Workspace
metadata and the Active Vault selection are device-local operational state outside every Vault.
The Runtime constructs one scoped context for the Active Vault and never retains a Root Key for an
inactive Vault.

---

# Host Responsibilities

The host application supplies platform-specific capabilities.

Examples:

Chrome Extension

- browser capture APIs
- toolbar
- popup UI
- context menus
- keyboard shortcuts

Desktop Application

- filesystem integration
- drag-and-drop
- native menus
- local notifications

The runtime should remain unaware of these details.

---

# Browser Adapter

The browser extension communicates through an adapter.

```text
Chrome APIs

↓

Browser Adapter

↓

Capture Service
```

This isolates browser-specific behavior.

Firefox implements its own adapter.

Future browsers implement additional adapters.

The Capture Service remains unchanged.

---

# Service Interfaces

Modules communicate through explicit interfaces.

Example:

```text
Capture Service

↓

Bundle Creation

↓

Encryption Engine

↓

Storage Service

↓

Synchronization Service
```

Direct module coupling should be avoided.

---

# Event Model

The runtime is event-driven.

Examples:

CaptureCompleted

BundleRegistered

SyncStarted

SyncCompleted

VaultUnlocked

SearchProjectionUpdated

AIArtifactsGenerated

Modules react to events rather than invoking unrelated modules directly where practical.

This improves extensibility and testability.

---

# Local Persistence

The runtime persists three categories of data.

## Structured Data

Examples:

- archive metadata
- folders
- notes
- synchronization state

Stored in the local database.

---

## Binary Data

Examples:

- encrypted Objects
- temporary bundle cache

Stored in the local Object Store.

For a synchronized Vault, selected heavy Artifact wrappers may be intentionally remote-only after
user confirmation and exact Coordination Server proof. The Storage Service records this device-local
availability separately from authoritative Objects. All consumers use the Runtime Artifact resolver:
it verifies local bytes, retrieves active- or Recovery-scoped opaque bytes when explicitly absent,
restores locally when quota permits, and uses a verified transient stream when quota does not.

---

## Projection Materializations

Examples:

- full-text Materializations
- semantic Materializations
- AI Materializations

Maintained separately from binary storage.

Projection Materializations can be rebuilt.

---

# Failure Recovery

The runtime should recover safely after:

- power loss
- browser crash
- interrupted Synchronization Jobs
- interrupted storage-relief deletion or Artifact restoration
- interrupted AI Jobs
- interrupted Capture Jobs

Bundles are committed atomically.

Partially created Bundles are discarded.

---

# Extensibility

New capabilities should appear as runtime modules.

Examples:

Timeline Engine

Knowledge Graph Engine

Citation Engine

Duplicate Detection Engine

Change Detection Engine

These modules consume runtime events without requiring architectural changes.

---

# Design Decisions

## Why a Runtime?

Separating the runtime from the host application allows multiple clients to share a common implementation while presenting different user experiences.

---

## Why Modules?

Modules provide clear ownership boundaries, facilitate testing, and reduce coupling.

---

## Why Event-Driven?

An event-driven architecture supports background processing, incremental indexing, and future plugins without introducing tight dependencies.

---

## Why Bundle Creation Before Encryption?

Bundles represent the immutable archival unit.

Encryption is a transport and storage concern applied after archival packaging.

---

# Complete Vault Import

The Runtime owns Import policy and the Workspace-scoped Job state machine. It authenticates the
package through the shared Export validator, rejects Selective coverage locally, preserves the
authoritative graph, provisions fresh device-local credentials, rebuilds Projections, and submits
one atomic activation. Hosts may stage and stream encrypted bytes but never receive the Root Key or
interpret Vault content. Drivers enforce the Import lease in every mutating transaction.

# Open Questions

Should the runtime expose a public plugin API?

Should AI providers execute in isolated workers?

Should search indexing be incremental or batch-based?

These questions are deferred to future design documents.

---

# References

- `docs/architecture/06-bundle-format.md`
- `docs/architecture/07-content-storage.md`
- `docs/architecture/08-synchronization.md`
- `docs/architecture/11-search.md`
- `docs/architecture/12-processing-pipeline.md`
