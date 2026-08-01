# System Architecture Overview

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/00-design-principles.md`
- `docs/architecture/glossary.md`

# Purpose

AWSM is a local-first encrypted preservation system. Its canonical architecture separates one
location-independent Vault from the Clients that operate it, the Replicas that materialize it, and
the optional Hosts that expose Replica access.

# System shape

```text
                          person
                             |
                 trusted Client Installation
          Commands, keys, Capture, Events, replay, search
                     /                  \
             local Replica          optional Remotes
                                      /          \
                              peer Client    Replica Host
                                              opaque Replica
```

A browser extension is one Client Installation. Desktop, mobile, headless, and API-driven clients
can implement the same trusted Runtime. An installation may also expose a Replica as a Host.

# Core boundaries

- **Vault:** stable logical identity, authenticated Record DAG, Objects, members, keys, and current
  state.
- **Replica:** one stored materialization of that Vault, possibly complete, on-demand, stale, or
  offline.
- **Client:** trusted software that can decrypt, validate, author through a Client Credential, and
  provide user or API workflows.
- **Host:** a service boundary that authenticates Channel Principals and exposes a Replica. An
  opaque Host need not be a Client.
- **Account:** optional Host-local login identity. It is not a Vault member or cryptographic owner.

# Data flow

Capture creates immutable Bundle and Artifact Objects locally. A signed Vault Event admits them to
one hash-linked DAG. Other Replicas pull opaque randomized storage items, decrypt and validate them
locally, and reduce compatible concurrent history deterministically. Search and AI indexes remain
local rebuildable Materializations unless a user explicitly preserves a result as Vault content.

# Consistency model

Vault work is available during network partitions and may temporarily diverge. Causal ancestry and
deterministic reducers converge compatible work; scoped conflicts retain every authenticated head
for explicit resolution. Host-local Account, Grant, quota, and cursor state may use ordinary
strong database consistency without becoming Vault causality.

# History and evolution

Genesis authenticates an Initial Baseline. Vacuum signs a complete successor Baseline and starts a
fresh Generation while retaining the Vault ID. Its Authority Parent subgraph remains as the
Continuity Proof required for phrase-only recovery; discarded Content history does not. A Fork
creates a new Vault from selected logical state without copying source history or authority.
Required Vault Features explicitly evolve authoritative semantics; advisory extensions cannot
change them.

# Implementation status

This document is the canonical target direction. The current extension and coordination-server
code still contain earlier single-user Device and recovery experiments. Current public claims must
continue to follow tested implementation until code, schemas, generated API, and staging are
separately reconciled.

# References

- `docs/architecture/02-domain-model.md`
- `docs/architecture/03-zero-knowledge.md`
- `docs/architecture/08-synchronization.md`
- `docs/specifications/vault/vault.md`
