# FORMAL SPECIFICATIONS

## OVERVIEW

These Draft v1.0 documents define the platform's versioned formats, protocol messages, storage semantics, runtime contracts, and portability behavior.

## STRUCTURE

| Domain         | Owns                                                     |
| -------------- | -------------------------------------------------------- |
| `core/`        | Stable identifiers and canonical serialization rules     |
| `storage/`     | Logical Object persistence and opaque outer envelopes    |
| `crypto/`      | Primitives, key derivation, encrypted Object layout      |
| `vault/`       | Vault, authority, content, Replica, and Vacuum semantics |
| `bundle/`      | Bundle, Manifest, and Artifact contracts                 |
| `event/`       | Commands, Events, and canonical Event encoding           |
| `runtime/`     | Host-independent services and long-running Jobs          |
| `protocol/`    | Opaque Replica resources, outcomes, and errors           |
| `portability/` | Complete Export, Import, Backup Sets, and Restore        |

## WHERE TO LOOK

| Task                         | Start with                                  | Then reconcile                                           |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Change an identifier         | `core/identifiers.md`                       | Every serialized consumer                                |
| Change persistence authority | `storage/object-store.md`, `vault/vault.md` | Bundle/Event/crypto/runtime semantics                    |
| Change encryption            | `crypto/crypto.md`                          | Key derivation, Object encryption, protocol, portability |
| Change Bundle contents       | `bundle/bundle.md`                          | `bundle/artifact.md` and `bundle/manifest.md` together   |
| Change history or commands   | `event/event.md`                            | Event format, commands, projections, synchronization     |
| Change client services       | `runtime/runtime.md`, `runtime/jobs.md`     | Domain service spec and Host/Driver boundary             |
| Change wire behavior         | `protocol/protocol.md`                      | Messages and errors; keep transport independent          |
| Change recovery/interchange  | `vault/authority.md`, `portability/`        | Jobs, Objects, encryption, projection rebuild            |

## CONTRACT STYLE

- Keep `Document`, `Version`, `Status`, and real dependencies current.
- Use MUST/SHALL for requirements, SHOULD for recommendations, and MAY for supported options; avoid casual uppercase normative terms.
- Put encoding layouts, validation, invariants, unknown-version behavior, and error conditions in the owning specification.
- Define persisted/wire structures independently of a language, framework, database, browser, or transport.
- Before the user declares the first release and explicitly authorizes compatibility, specify and implement only the one canonical current format. Do not preserve or reinterpret unsupported fields or content from discarded drafts. Reject anything outside the canonical specification.
- Require deterministic serialization, stable identifiers, idempotent retries, and integrity verification at trust/storage boundaries.

## DEPENDENCY ORDER

For cross-cutting changes, reconcile in this order:

1. Identifiers, Object Store, and cryptographic primitives.
2. Vault authority, Vault Record semantics, and Bundle and Artifact Object semantics.
3. Runtime, Jobs, storage Drivers, capture, and synchronization.
4. Search/AI, protocol, portability, and Restore.
5. Architecture, testing, and operations documents that explain or verify the contract.

`bundle/artifact.md` and `bundle/manifest.md` explicitly depend on each other; treat that pair as
one change unit. Many semantic dependencies are undeclared, so use the consistency review as a
search aid, not as normative authority.

## ANTI-PATTERNS

- Do not redefine canonical glossary terms or use synonyms for reserved concepts.
- Do not allow servers to access plaintext, raw keys, decrypted metadata, search content, or AI inputs.
- Do not mutate or reuse authoritative identifiers/Objects; model change through new Objects and Events.
- Do not make Projections, Materializations, caches, Jobs, cursors, or registries authoritative.
- Do not specify Commands as synchronized history or allow extensions to emit Events directly.
- Do not reuse cryptographic nonces or domain labels, invent algorithms, or let rotation invalidate historical data.
- Do not parse diagnostic text for behavior; use stable protocol outcome/error identifiers.
- Do not merge Backup/Restore semantics with Export/Import semantics.

## VALIDATION

The target conformance suite described by `docs/architecture/19-testing-strategy.md` is not yet
implemented. Documentation changes must search canonical terms and affected Object, Event, and
protocol names across living documents; check every codec, unknown-field rule, dependency, and
invariant manually.
