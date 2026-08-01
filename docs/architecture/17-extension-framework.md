# Client Extension Framework

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/05-client-runtime.md`
- `docs/specifications/event/commands.md`

# Purpose

Client extensions add adapters, processors, views, and local workflows without bypassing Runtime
authority, storage, privacy, or Required Feature rules. This concept is distinct from the Firefox
or Chrome browser extension, which is itself a Client Installation.

# Boundary

An extension manifest declares stable extension identity, code revision, minimum Runtime features,
requested capabilities, contributed adapters or views, and storage namespaces. The Runtime grants
least privilege and mediates every call.

Extensions may:

- submit Commands;
- observe sanitized projection updates;
- provide Capture or file adapters;
- contribute local processors and Materializations;
- render capability-scoped UI; and
- request explicit network or platform operations.

They may not access raw private keys, write Vault Records or Replica Safety State directly, bypass
canonical validation, invent an authoritative field, or treat local storage as authority.

# Authoritative evolution

A local-only extension can use Advisory Extensions, Managed Resources, Jobs, and Materializations
within their limits. If its data must synchronize or affect reduction, the extension requires a
Required Vault Feature with exact Object/Event codes, reducers, Baseline codec, reachability, and
unsupported-client behavior.

# Isolation and failure

Untrusted or third-party code runs in the strongest practical sandbox. Inputs and outputs are
bounded and schema-checked. Crashes disable the extension or fail its Command without corrupting
Vault state. Network access is origin-scoped and user-visible.

# Licensing

Extension APIs may interoperate with independently implemented software, but the project does not
copy strong-copyleft reference code without explicit relicensing review. Dependencies and bundled
models retain their applicable notices and licenses.

# References

- `docs/architecture/12-processing-pipeline.md`
- `docs/specifications/core/serialization.md`
- `docs/specifications/runtime/runtime.md`
