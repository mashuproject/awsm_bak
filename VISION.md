# VISION.md

# Archive Platform Vision

> **Knowledge belongs to its owner.**

---

# Purpose

Archive Platform exists to preserve digital knowledge in a manner that is durable, private, searchable, and independent of any particular service or vendor.

The modern web is increasingly ephemeral. Articles disappear, websites are redesigned, discussions are deleted, and online services change or cease to exist. Existing bookmarking systems preserve only links. Traditional note-taking applications preserve user notes but often fail to preserve the original source material with high fidelity.

Archive Platform addresses this problem by treating digital knowledge as something worth preserving permanently.

The platform captures information at a point in time, preserves it faithfully, enriches it locally using artificial intelligence, encrypts it, and synchronizes it between trusted devices without exposing its contents to the service provider.

---

# Vision Statement

Archive Platform is a local-first, zero-knowledge knowledge preservation platform.

The platform enables users to collect, preserve, organize, search, and enrich digital knowledge while ensuring that only the user controls access to the underlying content.

The cloud exists solely as a coordination layer for synchronization.

---

# Mission

To become the most trustworthy platform for preserving personal knowledge.

Trustworthiness is defined by four properties:

- The platform preserves information faithfully.
- The platform protects user privacy.
- The platform remains usable for decades.
- The platform avoids vendor lock-in.

---

# Problem Statement

Current solutions typically optimize one aspect of digital knowledge management while compromising another.

Bookmark managers preserve URLs but not content.

Web clipping applications frequently store plaintext on centralized servers.

Cloud-based AI knowledge systems require users to upload private information for processing.

Offline tools often lack synchronization or multi-device support.

No widely adopted platform simultaneously provides:

- faithful archival
- strong privacy
- offline operation
- synchronization
- AI enrichment
- extensibility

Archive Platform aims to combine these capabilities into a single coherent system.

---

# Guiding Principles

## Principle 1 — Local First

The user's device is the primary computing environment.

The cloud is a replication mechanism, not the application.

If the synchronization service becomes unavailable, users should still be able to:

- browse archives
- search archives
- generate AI summaries
- edit notes
- organize folders
- read captured pages

without degradation.

Heavy captured payloads are the deliberate exception a user may choose for a connected Account.
After exact encrypted-copy proof and explicit confirmation, a device may retain their immutable
Artifact records while dropping selected local wrappers. Their content then requires Account and
network access until an integrity-checked retrieval restores it or serves it transiently. Compact
Library content remains local, and Complete Export remains complete.

---

## Principle 2 — Zero Knowledge

User content must never be readable by the service provider.

The backend must not possess the cryptographic material required to decrypt user archives.

Every architectural decision should preserve this property.

If a proposed feature requires server-side access to decrypted content, it should be considered incompatible with the platform unless explicitly implemented as an optional opt-in service.

---

## Principle 3 — Immutable Preservation

Captures represent historical records.

Once a capture has been created, it must never be modified.

Corrections, summaries, annotations, OCR, translations, and other derived information are stored separately.

This separation preserves the authenticity of the original capture.

---

## Principle 4 — AI Augments Knowledge

Artificial intelligence should enhance archived information rather than replace it.

AI-generated content is considered derived information.

Examples include:

- summaries
- tags
- keyword extraction
- semantic embeddings
- translations
- entity recognition
- document classification

Generated artifacts should always remain linked to their original capture.

---

## Principle 5 — Open Architecture

The platform should remain independent of any particular vendor.

Components should be replaceable.

Examples include:

AI providers

- Local LLMs
- Ollama
- LM Studio
- OpenAI
- Anthropic
- Gemini
- future providers

Storage

- local filesystem
- S3
- Cloudflare R2
- Backblaze
- MinIO

Authentication

- private username/password
- OAuth
- enterprise SSO

The architecture should minimize coupling to external services.

---

# Architectural Constraints

Every implementation must satisfy the following constraints.

## Client Responsibilities

The client performs:

- capture
- encryption
- decryption
- search
- indexing
- AI inference
- archive rendering
- synchronization
- conflict resolution
- local storage relief and integrity-checked remote Artifact retrieval

The client is the trusted execution environment.

---

## Server Responsibilities

The backend performs:

- authentication
- authorization
- billing
- encrypted object storage coordination
- synchronization
- device management
- sharing coordination
- quota management
- observability

The backend is intentionally unaware of archive contents.

---

# Preservation Model

The platform is built around immutable Vault history.

Rather than thinking in terms of "web pages", the system stores Bundles and Events.

Examples include:

- web pages
- PDFs
- images
- emails
- EPUB files
- Markdown documents
- office documents
- transcripts
- scanned documents

Every content type follows the same lifecycle.

```text
Capture Request

↓

Immutable Bundle

↓

Independent encrypted Artifacts

↓

Vault Events

↓

Derived Projections
```

This abstraction allows new content types to be introduced without redesigning the platform.

---

# Long-Term Objectives

The architecture should support future capabilities including:

- semantic search
- duplicate detection
- change detection
- scheduled captures
- AI-assisted research
- citation generation
- knowledge graphs
- timeline visualization
- archive comparison
- collaborative sharing through encrypted permissions

without requiring changes to the underlying storage model.

---

# Design Philosophy

The platform values correctness over convenience.

It is preferable to preserve more information than less.

It is preferable to retain immutable history than overwrite it.

It is preferable to keep computation on trusted devices than centralize it.

It is preferable to expose explicit design decisions rather than hidden behavior.

---

# Success Criteria

The platform is successful if users trust it as the permanent home for their digital knowledge.

Specifically, users should believe that:

- their archives cannot be read by the service provider
- their information remains accessible without network connectivity
- their knowledge can outlive individual web services
- their data can be exported without loss
- the platform can continue evolving without requiring fundamental architectural redesign

---

# Anti-Goals

Archive Platform is not intended to become:

- a collaborative wiki
- a social network
- a cloud-first document editor
- an advertising platform
- an analytics platform
- a surveillance platform
- a centralized AI service requiring plaintext access

Features that compromise the platform's core principles should not be introduced merely for convenience.

---

# Decision Framework

Future architectural decisions should be evaluated using the following questions:

1. Does this preserve user ownership of knowledge?

2. Does this maintain zero-knowledge guarantees?

3. Can this function offline?

4. Does this preserve immutable history?

5. Does this reduce vendor lock-in?

6. Can this evolve without redesigning the platform?

If a proposal fails multiple questions, it should be reconsidered.

---

# The North Star

Archive Platform is not simply a browser extension, a Rails application, or a synchronization service.

It is a platform for preserving human knowledge in a manner that remains private, durable, searchable, and under the complete control of its owner.

Everything else is an implementation detail.
