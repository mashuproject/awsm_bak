# Client Runtime Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/01-system-overview.md`
- `docs/architecture/04-security-model.md`

# Purpose

The Client Runtime is the trusted, user-interface-independent execution environment for Vault
plaintext and authority. Browser extension, desktop, mobile, headless HTTP, and future thin-client
surfaces provide adapters around the same semantic responsibilities.

# Modules

```text
surface and platform adapters
             |
trusted Runtime
  Command and authority validation
  Capture and Bundle construction
  cryptography and secure key access
  Record/Object validation and replay
  projection, search, and optional AI
  pull synchronization and hydration
  import, export, Fork, Vacuum, and GC
             |
Storage Drivers and optional Channels
```

The Runtime owns business semantics. Adapters provide tabs, files, screenshots, secure storage,
network connections, notifications, and presentation without independently authoring Events.

# Multiple Vaults and Credentials

One installation may manage several Vault Replicas and several Client Credentials, including
different members or Vaults in one browser profile. Selecting a Vault is the ordinary way to make
its protected context available. Switching clears prior plaintext and never creates a Vault Event.

# Local-first execution

Commands validate against exact accepted causal and Authority Frontiers. Valid local work commits
without a Remote. Synchronization later pulls and validates immutable items. When a security fence
prevents valid Event authoring, Capture may finish into explicit Prepared Data for later safe
handling rather than blocking acquisition or pretending it is committed.

# Extension and API boundary

First-party and extension code submits capability-scoped Commands. A headless installation may
offer an HTTP API for operating its local Replica; API credentials authorize that Client surface,
not portable Vault membership. The selected Client Credential still signs every resulting Event.

# State boundaries

The Runtime uses the eleven logical storage families in the storage specification. It keeps
Replica Safety State distinct from preferences, Quarantine distinct from trusted Prepared Data,
and Materializations disposable. Durable Jobs bridge operations that span databases, wrapper
stores, and Channels.

# Invariants

- Platform adapters do not own Vault semantics.
- One installation can be both Client and Replica Host.
- No routine workflow requires a particular coordination service.
- Plaintext and secrets stay inside the trusted Runtime by default.
- Every accepted remote byte passes the same validation as an import.

# References

- `docs/specifications/runtime/runtime.md`
- `docs/specifications/runtime/storage.md`
- `docs/architecture/17-extension-framework.md`
