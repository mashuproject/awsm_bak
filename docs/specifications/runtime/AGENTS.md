# RUNTIME SPECIFICATIONS

## OVERVIEW

This domain defines the platform-independent client Runtime, its Service boundaries, persistent Jobs, storage Drivers, capture/synchronization workflows, search, and AI processing.

## WHERE TO LOOK

| Concern                        | Document             | Boundary to preserve                                                            |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------- |
| Runtime lifecycle and Services | `runtime.md`         | Host integrates platforms; Runtime owns behavior                                |
| Desktop/API command boundary  | `desktop-command.md` | Paired API Clients use the same Vault Command contract; transfer is not sync |
| Long-running execution         | `jobs.md`            | Scheduling, persistence, retry, cancellation, recovery                          |
| Persistence access             | `storage.md`         | Runtime uses Drivers, not OPFS/platform APIs directly                           |
| Capture                        | `capture.md`         | Capability preflight precedes immutable Bundle creation                         |
| Synchronization                | `synchronization.md` | Receiver pull cycles run within a durable synchronization Job                   |
| Search                         | `search.md`          | Query rebuildable Search Projection Materializations                            |
| AI                             | `ai.md`              | Produce local Materializations; shared output requires explicit Vault semantics |

## SERVICE MODEL

- Services communicate through defined interfaces, Commands, and Runtime Events; they do not access one another's internal state.
- A Service failure stays isolated and persistent state survives Runtime restart or interruption.
- Jobs own orchestration mechanics. Domain specs define Work Items and domain behavior rather than duplicating retry/checkpoint scheduling.
- Hosts supply UI, permissions, lifecycle, network, and filesystem integration. Drivers isolate storage-platform details.
- Diagnostics are structured and operational only; never expose decrypted user content, keys, or sensitive plaintext metadata.

## DATA FLOW INVARIANTS

- Capture validates permissions and Host capabilities before freezing input; incomplete Bundles are never stored.
- Synchronization exchanges opaque Vault Records and Objects, is resumable and idempotent, and
  does not make either Replica inherently authoritative.
- Search reads projections; queries never modify stored data and Materializations are rebuildable, local, and unsynchronized.
- AI consumes decrypted content only inside trusted clients unless explicit user policy permits a
  remote provider. Output remains a local Materialization unless a separate Required Feature and
  user Command preserve it as Vault content.
- Storage caches and indexes remain derived. Authoritative Objects are removed only through defined retention semantics.

## ANTI-PATTERNS

- Do not put business logic in Hosts or platform API calls outside Drivers.
- Do not let Services share internal mutable state or let one failure terminate unrelated Services.
- Do not implement workflow-specific retry, persistence, or cancellation outside the Job Framework.
- Do not synchronize Jobs, Projections, Search Materializations, caches, or plaintext.
- Do not let AI modify Bundles, Projections, or search storage directly.
- Do not buffer large Objects wholesale when the storage contract calls for streaming.
- Do not record secrets or decrypted content in Job errors, progress, health, or synchronization diagnostics.

## CROSS-DOCUMENT CHECKS

Runtime changes commonly affect `docs/specifications/vault/vault.md`,
`docs/specifications/storage/object-store.md`, Bundle/Event specs, protocol messages, portability
Jobs, and architecture documents `05`, `08`, `10`-`13`, and `19`. Search all of them when changing
a Service boundary, Job type, authoritative input, emitted Event, or persisted checkpoint.
