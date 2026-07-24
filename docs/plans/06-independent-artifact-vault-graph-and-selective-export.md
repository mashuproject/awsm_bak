# Independent Artifact Vault Graph and Selective Export

**Document:** `docs/plans/06-independent-artifact-vault-graph-and-selective-export.md`
**Status:** Approved implementation plan
**Owner:** Engineering
**Last Updated:** 2026-07-18
**Depends On:** `docs/plans/03-multiple-vault-management.md`,
`docs/plans/04-library-centered-vault-rename.md`,
`docs/plans/05-passphrase-protected-vault-export.md`, and the architecture and specifications
reconciled by this plan

**Current Import authority:** `docs/plans/07-complete-vault-package-import.md`. This plan's Import
deferrals now apply only to Selective coverage, remote availability, retention, and synchronization.

---

# 1. Purpose

This is the decision-complete implementation plan for replacing AWSM's single encrypted Bundle ZIP
with an immutable Bundle graph whose Artifact payloads are independently encrypted, stored, read,
validated, Vacuumed, and exported. The implementer is expected to begin from a cold checkout with
no conversation context. Do not reopen choices recorded here.

The feature changes the canonical pre-release Vault format in place. It does not preserve, migrate,
read, alias, or detect the superseded single-ZIP Bundle format. Before development verification,
clear the extension's local storage and recreate all Vault data. Do not add a database migration,
old reader, schema fallback, successor type name, dual representation, or compatibility branch.

The completed feature SHALL provide:

1. one compact encrypted Bundle Descriptor Object per Capture;
2. one independently encrypted Artifact Object for every successful MHTML, full screenshot,
   thumbnail, normalized-text, or structured-content output;
3. bounded-memory streaming encryption and storage for every Artifact;
4. atomic visibility of the entire successfully produced Bundle graph;
5. a Capture detail Artifact panel that exposes every Role and permits download of every present
   Artifact;
6. passphrase-protected ZIP64 Export containing independent Object records and Artifact wrappers;
7. authenticated selective-package omission records for heavyweight Artifacts; and
8. strict streaming validation of complete and selective packages.

Only `PRIMARY` MHTML is mandatory. Screenshot, thumbnail, normalized text, and structured content
are best-effort outputs. A failure to produce an optional Artifact SHALL be visible through a typed
warning but SHALL NOT invalidate a valid MHTML Capture.

---

# 2. Scope and Non-Goals

## 2.1 In scope

- canonical Bundle Descriptor and Artifact Reference contracts;
- canonical independently encrypted Artifact wrapper format;
- encrypted Artifact persistence in OPFS with authoritative IndexedDB records;
- Capture acquisition, staging, validation, atomic commit, cancellation, and restart cleanup;
- live-DOM normalized text and semantic structured-content extraction;
- authoritative thumbnail promotion while retaining an encrypted Projection cache;
- Library Projection rebuild from Events, descriptors, and Artifacts;
- detail inspection and download of every present Artifact;
- Vault Generation reachability and Vacuum over complete Bundle graphs;
- complete and selective Vault Package contracts;
- strict package validation and test-only selective fixtures;
- documentation reconciliation and removal of the superseded Bundle ZIP model.

## 2.2 Explicitly deferred

- Account creation, Account passwords, Account Recovery Keys, and recovery ceremonies;
- Coordination Server, synchronization, web client, cursors, upload, and remote retrieval;
- automatic retention profiles, pinning, and user-created unavailable Artifact states beyond the
  canonical manual heavy-wrapper storage-relief workflow;
- a user control that intentionally excludes locally present Artifacts from Export;
- `Download all content` from a server;
- Complete Import or destination-Vault writes, which are owned by Plan 07;
- Search Projection implementation, despite producing its source Artifacts;
- AI processing and post-Capture Artifact regeneration;
- additive Artifact replacement or supersession Events;
- content-addressed IDs or plaintext/ciphertext deduplication;
- Backup, Restore, Secure Scrub, or synchronization compatibility.

Current local Vaults remain complete: every Artifact referenced by a committed descriptor SHALL
have a committed local encrypted payload. A missing committed payload is corruption, not an
unavailable state. Selective omission support exists at the Vault Package boundary for future
Import and synchronization work.

---

# 3. Terminology and Authority

- **Bundle** remains the immutable logical Capture package.
- **Bundle Descriptor** is the compact encrypted Object that owns Bundle metadata and references
  its Artifact Objects.
- **Artifact** remains the canonical term for a preserved or derived payload. UI and code SHALL NOT
  rename it to Attachment; attachment is only an analogy.
- **Artifact Object Record** is the authoritative IndexedDB record binding an Object ID to the
  exact encrypted wrapper length and checksum.
- **Artifact Wrapper** is the immutable chunk-framed encrypted byte stream stored in OPFS.
- **Artifact Projection Cache** is rebuildable encrypted presentation data and is not authoritative.
- **Complete package** contains every referenced Artifact wrapper.
- **Selective package** intentionally omits one or more permitted heavyweight wrappers and
  authenticates each omission.

Authority flows as follows:

```text
BundleRegistered Event
        │ references exact Object closure
        ▼
Bundle Descriptor Object ────────┐
        │                         │
        ├── PRIMARY Artifact      │
        ├── SCREENSHOT_FULL       │ all immutable authoritative Objects
        ├── THUMBNAIL             │
        ├── TEXT_EXTRACTED        │
        └── CONTENT_STRUCTURED ───┘

Vault Generation + active head
        │
        └── retain Event IDs and every referenced Object ID

Library Projection / thumbnail cache
        └── rebuildable, local, non-authoritative, excluded from Export
```

An Event SHALL reference the descriptor and every Artifact Object directly. Consumers SHALL NOT
need to decrypt a descriptor merely to determine authoritative reachability.

---

# 4. Canonical Domain Contracts

All structures in this section are the sole canonical initial pre-release formats. Persisted and
externally exchanged structures use format version `1`. Transient Commands, view models, and stream
messages are unversioned unless they are persisted or independently exchanged.

## 4.1 Artifact Roles and Kinds

Replace the current two-Role contract with:

```ts
type ArtifactRole =
  | "PRIMARY"
  | "SCREENSHOT_FULL"
  | "THUMBNAIL"
  | "TEXT_EXTRACTED"
  | "CONTENT_STRUCTURED";

type ArtifactKind = "CAPTURE" | "IMAGE" | "TEXT" | "STRUCTURED_CONTENT";
```

The closed Role contracts are:

| Role                 | Kind                 | MIME type                           | Production rule                        | Selective omission |
| -------------------- | -------------------- | ----------------------------------- | -------------------------------------- | ------------------ |
| `PRIMARY`            | `CAPTURE`            | `application/vnd.awsm.web-page+zip` | mandatory, valid                       | permitted          |
| `SCREENSHOT_FULL`    | `IMAGE`              | `image/webp`                        | best effort, non-empty                 | permitted          |
| `THUMBNAIL`          | `IMAGE`              | `image/webp`                        | best effort, 640×360, non-empty        | prohibited         |
| `TEXT_EXTRACTED`     | `TEXT`               | `text/plain;charset=utf-8`          | best effort, empty permitted           | prohibited         |
| `CONTENT_STRUCTURED` | `STRUCTURED_CONTENT` | `application/cbor-seq`              | best effort, empty block set permitted | prohibited         |

Unknown Kinds, Roles, MIME types, duplicate Roles, or Role/Kind/MIME mismatches SHALL be rejected.
Each Bundle has exactly one `PRIMARY` reference and at most one reference for every optional Role.

## 4.2 Artifact identity

Every Artifact gets a fresh random UUID. That UUID is both its Artifact identity and its Object ID.
Remove Bundle-local identifiers such as `A000001`. Hashes verify bytes and SHALL NOT determine IDs.
Do not deduplicate equal plaintext or ciphertext.

## 4.3 Artifact Reference

The descriptor contains one sorted reference per Artifact:

```ts
interface ArtifactReferenceV1 {
  readonly artifactVersion: 1;
  readonly artifactObjectId: string; // canonical UUID
  readonly kind: ArtifactKind;
  readonly role: ArtifactRole;
  readonly mimeType: string;
  readonly acquiredAt: string; // canonical UTC timestamp
  readonly plaintextByteLength: number; // safe non-negative integer
  readonly checksumAlgorithm: "hash:sha256:v1";
  readonly plaintextChecksum: Uint8Array; // exactly 32 bytes
}
```

References SHALL be sorted by `artifactObjectId`. Object IDs and Roles SHALL both be unique. The
descriptor SHALL reject unknown fields.

## 4.4 Bundle Descriptor

Replace the Bundle Manifest plus metadata ZIP entries with one canonical-CBOR record:

```ts
interface BundleDescriptorV1 {
  readonly descriptorVersion: 1;
  readonly bundleId: string;
  readonly createdAt: string;
  readonly clientVersion: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly captureAdapterVersion: 1;
  readonly metadata: CaptureMetadataV1;
  readonly artifacts: readonly ArtifactReferenceV1[];
}
```

`metadata` retains the current canonical Capture metadata fields. Do not duplicate warnings in the
descriptor; warnings are accepted facts in `BundleRegistered`. Do not add filenames, OPFS paths,
wrapper lengths, wrapper checksums, or storage state to descriptor plaintext.

The descriptor is canonical CBOR encrypted with the existing envelope primitive using:

```text
objectType: BundleDescriptor
key domain: vault:bundle-descriptor:v1
context ID: Bundle ID
envelope Object ID: descriptor Object UUID
```

The descriptor is expected to be compact and remains an inline encrypted Object. Apply a fixed
16 MiB maximum before allocating or decrypting it.

## 4.5 Stored Object union

Replace the monomorphic stored Object with this strict union:

```ts
interface StoredBundleDescriptorObjectV1 {
  readonly version: 1;
  readonly objectId: string;
  readonly objectType: "BundleDescriptor";
  readonly envelopeBytes: Uint8Array;
}

interface StoredArtifactObjectV1 {
  readonly version: 1;
  readonly objectId: string;
  readonly objectType: "Artifact";
  readonly envelopeFormat: "artifact:xchacha20poly1305-chunked:v1";
  readonly envelopeByteLength: number;
  readonly envelopeChecksumAlgorithm: "hash:sha256:v1";
  readonly envelopeChecksum: Uint8Array;
}

type StoredObjectV1 = StoredBundleDescriptorObjectV1 | StoredArtifactObjectV1;
```

`StoredArtifactObjectV1` contains no local path. The storage Driver derives the relative path from
Vault ID and Object ID. Its checksum covers the exact complete encrypted wrapper bytes.

## 4.6 BundleRegistered Event

Replace the canonical payload with:

```ts
interface BundleRegisteredPayloadV1 {
  readonly version: 1;
  readonly eventType: "BundleRegistered";
  readonly eventVersion: 1;
  readonly payloadVersion: 1;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly timestamp: string;
  readonly protocolVersion: 1;
  readonly correlationId: string;
  readonly bundleId: string;
  readonly descriptorObjectId: string;
  readonly artifactObjectIds: readonly string[];
  readonly collectionId: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly warnings: readonly CaptureWarningId[];
}
```

`artifactObjectIds` SHALL be sorted and unique. The stored Event's `referencedObjectIds` SHALL be
the sorted unique union of `descriptorObjectId` and `artifactObjectIds`; the decoder and every
replay/verification path SHALL require exact equality.

Remove `bundleObjectId`, `captureMetadata`, `screenshotPresent`, and whole-Bundle `integrity` from
the Event. Projection rebuild decrypts and validates the referenced descriptor to obtain metadata
and Role availability.

The Command outcome replaces `bundleObjectId` with `descriptorObjectId` and retains Bundle ID,
Event ID, command identity, and success status.

## 4.7 Warnings

Retain the current screenshot warnings and add:

```text
THUMBNAIL_CAPTURE_FAILED
TEXT_EXTRACTION_FAILED
STRUCTURED_CONTENT_EXTRACTION_FAILED
```

Warnings are sorted and unique. `SCREENSHOT_CAPTURE_FAILED` implies neither screenshot nor
thumbnail was produced. `THUMBNAIL_CAPTURE_FAILED` is valid only when `SCREENSHOT_FULL` exists and
`THUMBNAIL` does not. Empty text or an empty block set is successful output and creates no warning.

---

# 5. Structured Content and Normalized Text

## 5.1 Source and timing

Extract both representations from the trusted live DOM during the same bounded Capture sequence as
MHTML and screenshot acquisition. This is a best coherent attempt, not an atomic browser snapshot.
Record per-Artifact acquisition timestamps. Do not fingerprint the DOM, fail on normal mutation, or
inject behavior that freezes the page.

The collector SHALL ignore:

- `script`, `style`, `noscript`, and `template` subtrees;
- nodes hidden by `hidden`, `aria-hidden="true"`, `display:none`, or `visibility:hidden`;
- empty semantic blocks after normalization.

The collector SHALL preserve document order and SHALL NOT store arbitrary HTML, CSS, layout boxes,
event handlers, form values, or executable content.

## 5.2 CBOR sequence format

`CONTENT_STRUCTURED` uses a deterministic CBOR sequence rather than one CBOR array so it can be
produced and consumed incrementally. Every sequence item is independently canonical CBOR.

The first item is exactly:

```ts
interface StructuredContentHeaderV1 {
  readonly structuredContentVersion: 1;
  readonly source: "LiveDOM";
}
```

All following items are blocks. EOF terminates the sequence. No count or indefinite-length CBOR
container is used. Unknown fields and unknown block Kinds are rejected.

## 5.3 Block union

Block IDs use `B` plus six decimal digits, start at `B000001`, and increase contiguously in emitted
document order.

```ts
interface StructuredLinkV1 {
  readonly text: string;
  readonly href: string; // resolved absolute URL
}

type StructuredBlockV1 =
  | {
      readonly blockVersion: 1;
      readonly blockId: string;
      readonly kind: "Heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly text: string;
      readonly links: readonly StructuredLinkV1[];
    }
  | {
      readonly blockVersion: 1;
      readonly blockId: string;
      readonly kind: "Paragraph" | "Quote";
      readonly text: string;
      readonly links: readonly StructuredLinkV1[];
    }
  | {
      readonly blockVersion: 1;
      readonly blockId: string;
      readonly kind: "ListItem";
      readonly ordered: boolean;
      readonly depth: number;
      readonly text: string;
      readonly links: readonly StructuredLinkV1[];
    }
  | {
      readonly blockVersion: 1;
      readonly blockId: string;
      readonly kind: "Preformatted";
      readonly text: string;
    }
  | {
      readonly blockVersion: 1;
      readonly blockId: string;
      readonly kind: "Table";
      readonly rows: readonly (readonly string[])[];
    };
```

`depth` is a safe integer from 0 through 32. Tables require at least one row and one cell; all rows
need not have equal width. Link order follows DOM order. Duplicate equal links are permitted when
they occur separately in the source. The inspector renders only HTTP(S) links as clickable; other
schemes remain visible text.

## 5.4 Text normalization

Derive `TEXT_EXTRACTED` from the same ordered block stream whenever structured extraction succeeds.
For every text field:

1. normalize Unicode to NFC;
2. convert CRLF and CR to LF;
3. replace non-line-breaking horizontal whitespace runs with one ASCII space, except inside
   `Preformatted` blocks;
4. remove trailing horizontal whitespace from every line;
5. trim leading and trailing blank lines within a block.

Render headings, paragraphs, list items, quotes, and preformatted blocks as their normalized text.
Render each table row by joining cells with one tab and rows with one LF. Join blocks with two LFs,
collapse any longer blank-line run to two LFs, and add exactly one final LF when the result is
non-empty. An empty block sequence produces a zero-byte text Artifact.

If semantic traversal fails, independently attempt `document.body?.innerText ?? ""` using the same
NFC, line-ending, trailing-whitespace, blank-line, and final-LF rules. This fallback may create
`TEXT_EXTRACTED` while `CONTENT_STRUCTURED` is absent and warned. Do not synthesize structured
blocks from the fallback string.

---

# 6. Chunked Artifact Encryption Format

## 6.1 Key derivation

For each Artifact derive a 32-byte key from the Vault Root Key using the existing HKDF contract:

```text
Vault ID: owning Vault UUID
domain: vault:artifact:v1
context ID: Artifact Object UUID
key version: 1
```

Keep the derived key only for the duration of wrapper production or reading and wipe it afterward.
Never transfer the Root Key or raw Artifact key outside the trusted Runtime.

## 6.2 Wrapper layout

The exact wrapper byte layout is:

```text
8 bytes   ASCII magic "AWSMART1"
4 bytes   unsigned big-endian header byte length
N bytes   canonical-CBOR ArtifactEnvelopeHeaderV1
frames... exactly one or more
EOF       immediately after the final frame ciphertext
```

The header is:

```ts
interface ArtifactEnvelopeHeaderV1 {
  readonly artifactEnvelopeVersion: 1;
  readonly objectId: string;
  readonly algorithm: "enc:xchacha20poly1305-chunked:v1";
  readonly chunkPlaintextBytes: 1048576;
  readonly noncePrefix: Uint8Array; // exactly 16 random bytes
}
```

Apply a 64 KiB maximum header length before allocation. The header contains no Role, MIME type,
plaintext checksum, URL, title, or other content-derived value.

Each frame is:

```text
8 bytes   unsigned big-endian chunk index
1 byte    final flag, exactly 0 or 1
4 bytes   unsigned big-endian plaintext byte length
L+16      XChaCha20-Poly1305 ciphertext and tag
```

Rules:

- index starts at zero and increments by one;
- nonce is `noncePrefix || uint64be(index)`;
- every non-final frame has exactly 1,048,576 plaintext bytes;
- a final frame has 0 through 1,048,576 plaintext bytes;
- exactly one final frame exists and is immediately followed by EOF;
- an empty Artifact is represented by index 0, final 1, plaintext length 0, and a 16-byte tag;
- index overflow is rejected;
- no padding, footer, compression, or alternate algorithm exists.

Frame AAD is canonical CBOR of this exact ordered array:

```text
[
  artifactEnvelopeVersion,
  objectId,
  algorithm,
  chunkPlaintextBytes,
  noncePrefix,
  chunkIndex,
  finalFlag,
  plaintextByteLength
]
```

The writer keeps at most the current 1 MiB chunk plus one lookahead chunk so it can mark the final
frame. It computes plaintext SHA-256/length and complete-wrapper SHA-256/length incrementally.

## 6.3 Reader validation order

Before yielding plaintext, the reader SHALL:

1. validate magic and bounded header length;
2. strictly decode canonical header CBOR;
3. verify expected Object ID and algorithm;
4. validate frame index, flag, and length before allocating ciphertext;
5. authenticate the frame;
6. only then yield its plaintext;
7. require final-frame EOF; and
8. compare complete plaintext length/checksum with the encrypted descriptor reference.

Wrong key, tampering, substitution, malformed framing, or checksum failure returns the existing
non-diagnostic cryptographic/package error appropriate to the calling boundary. Never log frame
bytes, plaintext, nonce material, URLs, titles, or keys.

---

# 7. OPFS Artifact Store

## 7.1 Paths

Use one Host-owned OPFS root:

```text
awsm-vault-objects/
  <vault-id>/
    <artifact-object-id>.artifact
```

Temporary Export files remain in their existing separate export directory. Artifact filenames are
opaque UUIDs. Validate every ID before deriving a path; never accept a caller-provided path.

## 7.2 Driver interface

Add a platform-independent `ArtifactStore` interface owned by the Runtime boundary:

```ts
interface PreparedArtifact {
  readonly object: StoredArtifactObjectV1;
  readonly plaintextByteLength: number;
  readonly plaintextChecksum: Uint8Array;
}

interface ArtifactStore {
  prepare(input: {
    vaultId: string;
    objectId: string;
    key: CryptoKey;
    plaintext: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<PreparedArtifact>;

  openEncrypted(
    vaultId: string,
    objectId: string,
  ): Promise<ReadableStream<Uint8Array>>;
  openPlaintext(input: {
    vaultId: string;
    object: StoredArtifactObjectV1;
    reference: ArtifactReferenceV1;
    key: CryptoKey;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>>;

  remove(vaultId: string, objectId: string): Promise<void>;
  reconcile(authoritativeIds: ReadonlySet<string>): Promise<void>;
}
```

`prepare` writes the final immutable filename before the IndexedDB transaction. The file is not
authoritative or visible to Runtime readers until its Object record commits. UUID collision with
different bytes fails. Identical immutable bytes are idempotent.

## 7.3 Crash and rollback behavior

- If acquisition, encryption, descriptor creation, or validation fails before commit, remove every
  prepared file for that Capture.
- If the IndexedDB transaction aborts, remove every prepared file.
- If the worker stops before commit, startup reconciliation removes files without authoritative
  Artifact records.
- If the transaction committed before worker termination, the records and files are authoritative;
  Capture Job reconciliation may mark the Job succeeded or interrupted according to the existing
  commit-boundary rule, but SHALL NOT delete committed files.
- A committed Artifact record whose file is absent, truncated, or checksum-mismatched is corruption.
  Do not convert it to Not Produced or unavailable.
- Reconciliation compares validated Vault-scoped filenames with authoritative Artifact record IDs.
  It SHALL never delete a file belonging to another Vault or an active staging operation.

---

# 8. Capture Pipeline

## 8.1 Runtime stages

Replace the Capture Job stages with:

```text
Preflight
Snapshot
Content
Screenshot
Commit
```

The pass through a page is:

1. validate active Vault, URL, permission, idempotency, and management lease;
2. create the Capture Job;
3. collect, package, and validate the mandatory page snapshot, then stream-encrypt it;
4. collect metadata and stream live-DOM semantic blocks plus normalized text;
5. acquire and stream-encrypt full screenshot and thumbnail best effort;
6. validate every successfully prepared Artifact;
7. build and encrypt the compact descriptor;
8. build `BundleRegistered`, Projection, and command outcome;
9. atomically commit all Object records and derived records;
10. publish one invalidation after commit and mark the Job succeeded.

Cancellation propagates through Blob reads, DOM extraction, offscreen encoding, chunk encryption,
OPFS writes, and the IndexedDB pre-commit path. Cancellation before commit leaves no authoritative
records or Artifact files.

## 8.2 Host streaming

- Page-snapshot packaging streams its ZIP64-capable output into temporary OPFS storage and passes
  the validated staged Blob directly to chunk encryption.
- The screenshot offscreen document may use canvas/Blob internally because image encoding requires
  it, but it SHALL return bounded Blob slices over an acknowledged port instead of one complete
  base64 string.
- The content collector sends bounded block batches over a long-lived port. The Runtime validates
  and canonical-encodes each block before feeding the structured and text writers.
- Use bounded base64 only when Chrome extension-message serialization requires it. Decode and wipe
  each chunk immediately. Never encode an entire Artifact as base64.
- Backpressure requires one acknowledgement per batch; producers SHALL stop when the consumer
  cancels, locks, changes Vault, or disconnects.

## 8.3 Atomic registration

Replace `AtomicRegistrationV1.object` with `objects: readonly StoredObjectV1[]`. The array contains
one descriptor first followed by Artifact records sorted by Object ID. The IndexedDB transaction
SHALL add all Objects, the Event, Projection, command outcome, and updated head together.

The transaction SHALL verify before writing:

- no active Export or Vacuum conflicts;
- the active Vault context is unchanged and unlocked;
- every Object ID is unique and scoped;
- Event references equal the supplied Object IDs exactly;
- descriptor Bundle ID equals Projection/outcome Bundle ID;
- every Artifact record has a matching descriptor reference;
- no descriptor reference lacks an Artifact record.

Do not perform OPFS I/O inside the IndexedDB transaction. Prepared and validated encrypted files
already exist; only their authoritative records become visible in the transaction.

---

# 9. Library, Projection Rebuild, and Artifact UI

## 9.1 Projection changes

Replace `bundleObjectId` with `descriptorObjectId`. Store Role presence and the bounded thumbnail
bytes in the encrypted Library Projection. Thumbnail bytes are a rebuildable cache copied from the
authoritative decrypted `THUMBNAIL` Artifact and remain excluded from Generation, Export, and
synchronization authority.

Projection rebuild now requires Event and Object read ports. For every `BundleRegistered` Event it
SHALL:

1. verify exact referenced closure;
2. decrypt and validate the descriptor;
3. match descriptor Artifact IDs to Event IDs;
4. read/decrypt the thumbnail when present;
5. derive title, URL, captured time, Role presence, warnings, and thumbnail cache;
6. produce the same logical Library state as the original commit.

Failure to authenticate a descriptor or present thumbnail fails rebuild. An optional Role absent
from the descriptor does not.

## 9.2 Artifact detail model

Add one row for each canonical Role, including Roles not produced:

```ts
interface ArtifactDetailItem {
  readonly role: ArtifactRole;
  readonly state: "Present" | "NotProduced" | "Failed";
  readonly kind: ArtifactKind;
  readonly mimeType: string;
  readonly byteLength?: number;
  readonly acquiredAt?: string;
  readonly warning?: CaptureWarningId;
  readonly canPreview: boolean;
  readonly canInspect: boolean;
  readonly canDownload: boolean;
}
```

`Failed` requires the matching typed warning. `NotProduced` is used when an optional Role does not
exist and no Role-specific failure applies, such as thumbnail absence following screenshot failure.
`PRIMARY` can never be absent in a valid detail model.

## 9.3 User-visible behavior

- Keep the full screenshot preview.
- List every Role, MIME type, size, acquisition time, state, warning, and action in an Artifact
  panel on Capture detail.
- Inspect normalized text as readable pre-wrapped text.
- Inspect structured content as semantic headings, paragraphs, lists, quotes, preformatted blocks,
  tables, and safe HTTP(S) links.
- Download every present Artifact using neutral filenames based on Bundle ID prefix and Role:
  `.mhtml`, `.webp`, `.txt`, or `.cborseq` as appropriate.
- Do not use title or URL in filenames.
- A missing optional Artifact has no download control.
- Errors remain in the panel and do not move or hide the rest of Capture detail.

## 9.4 Streaming read sessions

Add a Vault-context-bound Runtime port for Artifact plaintext reads. Opening a session validates
the unlocked active Vault, Bundle, descriptor, Role, Object record, and wrapper checksum. The port
then emits bounded chunks with acknowledgements, EOF, cancellation, and one stable safe error.

Immediately cancel and discard all plaintext chunks, `TextDecoder` state, rendered structured
blocks, selections, and Object URLs when the Vault locks, active Vault changes, context generation
changes, the surface closes, or the user cancels.

For downloads, the Library Host opens a user-gesture file picker and writes the decrypted stream
directly to its writable destination. It SHALL not create a plaintext OPFS temporary file. For image
preview, an ephemeral Blob URL is permitted; revoke it on replacement, dismissal, or context loss.

---

# 10. Vault Generation and Vacuum

Vault Generation reachability remains a sorted set of Object IDs and Event IDs. It now includes
both Bundle Descriptor and Artifact Object IDs. Generation verification SHALL reject a descriptor
without its complete referenced Object closure or an Object not reachable from exactly one retained
registration under the current no-deduplication model.

Vacuum analysis SHALL use each retained `BundleRegistered` Event's exact closure. When permanently
removing a deleted Bundle:

1. rewrite affected Events according to the existing additive Vacuum rules;
2. exclude the descriptor and all its Artifact Object IDs from the new Generation;
3. atomically commit the new Generation/head and delete their IndexedDB Object records;
4. only after commit, delete the encrypted Artifact files;
5. leave interrupted post-commit deletion to startup orphan reconciliation.

Reclaimed-byte estimates include inline descriptor envelope bytes and exact external wrapper byte
lengths. Do not count Projection caches as authoritative reclaimed bytes. Never delete files before
the generation compare-and-swap succeeds.

---

# 11. Vault Package Format

## 11.1 Container and paths

Retain the existing MIME type, `.awsm` extension, passphrase key envelope, Argon2id parameters,
ZIP64 STORE container, deterministic metadata, OPFS temporary file, Export Job, exclusive lease,
Save As behavior, and neutral package filename.

Replace the exact package layout with:

```text
key.cbor
manifest.cbor
generation.cbor
head.cbor
events/<event-id>.cbor
objects/<object-id>.cbor
artifacts/<artifact-object-id>.bin
```

Every authoritative Object record is included under `objects/`, including Artifact records whose
payload is selectively omitted. Present Artifact wrappers are copied byte-for-byte from OPFS under
`artifacts/`. Paths remain lexically sorted and unique.

## 11.2 Manifest

Replace the current Export Manifest with:

```ts
interface ExportManifestV1 {
  readonly exportFormatVersion: 1;
  readonly packageId: string;
  readonly createdAt: string;
  readonly originatingVaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly coverage: "Complete" | "Selective";
  readonly eventCount: number;
  readonly objectCount: number;
  readonly artifactPayloadCount: number;
  readonly supportedFeatures: readonly [
    "artifact-graph",
    "selective-coverage",
    "vault-generation",
  ];
  readonly entries: readonly ExportEntryDescriptorV1[];
  readonly omissions: readonly ExportOmissionV1[];
  readonly contentIntegrity: {
    readonly algorithm: "hash:sha256:v1";
    readonly checksum: Uint8Array;
  };
}
```

Do not retain stale `bundleFormatVersion`, `vaultFormatVersion`, or other discarded-draft fields.
The current self-describing Export format remains its sole canonical initial version `1`.

Entry descriptors use record types:

```text
VaultGeneration
VaultHead
Event
Object
ArtifactPayload
```

They retain path, record ID, exact byte length, SHA-256 algorithm, and checksum. Object record and
Artifact payload descriptors may share a record ID because their record types and paths differ;
uniqueness is enforced on `(recordType, recordId)` and path.

Omissions are:

```ts
interface ExportOmissionV1 {
  readonly artifactObjectId: string;
  readonly expectedPath: string;
  readonly envelopeByteLength: number;
  readonly envelopeChecksumAlgorithm: "hash:sha256:v1";
  readonly envelopeChecksum: Uint8Array;
  readonly reason: "NotLocallyAvailable";
}
```

Omissions are sorted by `artifactObjectId`. `contentIntegrity.checksum` is SHA-256 of canonical CBOR
of `{ entries, omissions, coverage }` with those exact fields. The readable Manifest SHALL NOT
expose Role, MIME type, plaintext length/checksum, title, URL, Vault name, or content-derived data.

## 11.3 Coverage rules

- `Complete` requires zero omissions and one present payload for every reachable Artifact record.
- `Selective` requires at least one omission.
- Only descriptor references with Role `PRIMARY` or `SCREENSHOT_FULL` may be omitted.
- `THUMBNAIL`, `TEXT_EXTRACTED`, and `CONTENT_STRUCTURED` are compact and always included when
  referenced.
- An Artifact cannot be both present and omitted.
- Omission length/checksum/path SHALL equal the reachable Artifact Object record exactly.
- Missing payload without an authenticated omission is invalid.
- Extra, unreferenced, duplicate, or cross-Vault payloads are invalid.

The current exporter has no exclusion control and local Vaults are complete, so it emits Complete
packages. Implement Selective package construction as a Runtime-capable path exercised by fixtures,
not as current user-facing UI.

## 11.4 Export streaming and validation

Enumerate all Events and Object records twice as in the current snapshot design. Enumerate Artifact
wrappers through streaming metadata/read ports. The Export lease SHALL also prevent Capture,
Vacuum, lock, rename, active-Vault change, and any future availability mutation.

Before Save As, the completed-package validator SHALL:

1. validate ZIP64 and exact canonical inventory;
2. authenticate key/Manifest binding and unwrap the Root Key;
3. authenticate Generation/head identity and exact Event/Object reachability;
4. replay every supported Event and prove every registration closure;
5. decrypt every descriptor and validate its Role graph;
6. match every descriptor reference to exactly one Artifact Object record;
7. stream-check present wrapper length/checksum without loading it whole;
8. stream-decrypt every present wrapper and verify reference plaintext length/checksum;
9. validate Role-specific payload structure;
10. verify text normalization and canonical structured CBOR sequence;
11. verify every omission and coverage rule; and
12. reject missing, extra, duplicate, corrupt, substituted, cross-package, or cross-Vault bytes.

Artifact wrappers are already encrypted and SHALL be copied directly into ZIP64. Export SHALL never
decrypt, base64-encode, or buffer a complete Artifact merely to package it.

---

# 12. Error and Security Behavior

Add or reuse stable safe errors for:

```text
ARTIFACT_INVALID
ARTIFACT_UNAVAILABLE
ARTIFACT_DOWNLOAD_FAILED
CAPTURE_INTERRUPTED
STORAGE_QUOTA_EXCEEDED
EXPORT_PACKAGE_INVALID
EXPORT_INTERRUPTED
```

`ARTIFACT_UNAVAILABLE` is an access-boundary error for absent package payloads and Selective Import; a
missing payload in a current complete local Vault maps to `ARTIFACT_INVALID`, not unavailable.

Diagnostics SHALL contain only operation, stage, safe error ID, bounded counts, byte counts, and
duration. They SHALL NOT contain:

- Artifact plaintext or ciphertext samples;
- page title, URL, normalized text, structured blocks, MHTML, or image bytes;
- Object-derived filenames other than already non-content UUIDs;
- Root Keys, Artifact keys, Export passphrases, nonces, or AAD;
- decrypted descriptors or checksums of plaintext content.

Server-visible or package-readable operational metadata is limited to IDs, encrypted-wrapper
lengths/checksums, ordering/fencing values, and ciphertext.

---

# 13. Documentation Reconciliation

Before implementation is complete, replace the superseded design everywhere. Follow document
authority outward:

1. update design principles and glossary so a Bundle is an immutable graph rather than one ZIP;
2. rewrite Bundle, Manifest/Descriptor, and Artifact specifications atomically;
3. update Object Store, Vault, key derivation, and Object encryption specifications for external
   chunked Artifact wrappers;
4. update Event and Capture specifications for exact dependency-closure registration;
5. update Runtime storage, Jobs, Vacuum, Projection, search-source, and Host boundaries;
6. rewrite Import/Export around Artifact payload entries and authenticated omissions;
7. update security, synchronization, content storage, capture pipeline, testing, deployment, README,
   Vision, PRD, and operations claims;
8. audit the entire Roadmap against the implemented product and canonical documentation, then
   remove every completed item and every duplicated description of behavior that is already
   implemented or owned by an architecture/specification document;
9. reconcile older numbered plans so they describe only the canonical current model or explicitly
   defer to this approved plan without retaining executable stale contracts.

## 13.1 Roadmap pruning rule

`ROADMAP.md` is a forward-looking list of unresolved initiatives, not an implementation history,
release note, architecture overview, or second copy of product specifications. At the end of this
feature, inspect every Roadmap paragraph and bullet rather than editing only the Artifact section.

For each Roadmap item:

1. identify whether its observable behavior and owning contract already exist in the implemented
   repository after this plan;
2. if complete, delete it from the Roadmap rather than marking it done;
3. if partially complete, delete the completed portion and retain only the concrete unresolved
   future delta;
4. if the remaining initiative depends on current behavior, link to the owning canonical document
   in one short sentence instead of restating that behavior;
5. if the text is a format, schema, algorithm, validation rule, or invariant now owned by a formal
   specification, remove the duplicate details from the Roadmap even when later work depends on it;
6. retain open questions only when they still require a future product or architectural decision;
7. remove open questions that this approved plan or earlier implemented plans have settled; and
8. re-read headings, statuses, assumptions, deviations, promotion criteria, evidence lists, and
   sequencing after deletion so they describe only work that remains.

At minimum, remove Roadmap duplication of foundations already implemented before or by this plan,
including local-only device-key Vault access, multiple local Vault management, Capture, current
complete passphrase-protected Export, the independent Bundle Descriptor/Artifact graph, chunked
local Artifact storage, and authenticated selective-package coverage. Do not add an `Implemented`,
`Completed`, `History`, or equivalent section to preserve the deleted prose. Git history and the
numbered approved plans record that history.

The remaining synchronized-web-client initiative may assume the canonical local Vault, Artifact,
and Export foundations by linking to their owning documents. It SHALL describe only unimplemented
work such as Accounts, enrollment/recovery, Coordination Server behavior, synchronization,
retention profiles, remote availability, web-client Hosts, selective Import, and server-backed
complete Export retrieval.

Remove all production and normative references to:

- `bundle:zip:v1`;
- a complete Bundle ZIP byte limit;
- Artifact paths inside a Bundle;
- `bundleObjectId`;
- Bundle-local Artifact IDs;
- MHTML/screenshot payloads embedded in one Bundle Object;
- Export validation through `readBundle()`;
- the claim that every Vault Package must be complete.

Do not use terms such as legacy, old format, v2, migration, upgrade reader, or backwards-compatible
path in product code or normative documentation.

---

# 14. Ordered TDD Implementation Tasks

Each task begins with failing tests, introduces the minimum canonical implementation, and finishes
with the listed verification. Do not implement later compatibility or synchronization concepts to
make an earlier task convenient.

## Task 1: Reconcile contracts and reset test data

**RED:** decoder tests reject the current Bundle ZIP manifest, Bundle-local Artifact IDs, stale
Event payload, and stale Object type. Schema tests require the new strict unions.

**GREEN:** introduce the new domain/storage types and strict decoders. Update test builders to create
only the new canonical initial structures. Delete and recreate development test/profile databases.

**Verification:** focused decoder/type tests, typecheck, and repository searches for stale contract
names. Do not implement a reader for previous local data.

## Task 2: Structured content and normalized text

**RED:** vectors cover every block Kind, hidden-node exclusion, DOM order, links, nested lists,
tables, preformatted text, Unicode NFC, blank lines, final LF, and empty content.

**GREEN:** implement the injected block collector, strict sequence decoder, block encoder, and
incremental text renderer with acknowledged bounded batches.

**Verification:** deterministic vectors, malformed CBOR-sequence rejection, fallback text path,
content-script cancellation, and no arbitrary HTML persistence.

## Task 3: Chunked Artifact cryptography

**RED:** vectors require exact header/frame bytes, empty output, one chunk, exact-multiple chunks,
partial final chunk, and deterministic output with injected key/nonce/source.

**GREEN:** implement streaming writer/reader, HKDF domain, AAD, incremental hashes, and wiping.

**Verification:** reject wrong keys, substitution, index reorder/duplication/gap, forged final flag,
truncation, extra bytes, bad lengths, invalid CBOR, and cross-Vault/Object reads. Assert peak retained
plaintext is bounded by two chunks.

## Task 4: OPFS Artifact Store

**RED:** browser integration tests require immutable scoped writes, streaming reads, collision
behavior, rollback cleanup, restart orphans, cross-Vault isolation, and corruption detection.

**GREEN:** implement the Chrome OPFS adapter and Runtime interface. Keep paths Host-local and derived.

**Verification:** real Chromium OPFS tests, quota errors, cancellation, file checksum/length binding,
and raw-file scans proving known plaintext is absent.

## Task 5: Atomic Bundle graph Capture

**RED:** Runtime and IndexedDB tests require five-Artifact success, every independent optional
failure, mandatory snapshot failure, exact Event closure, and rollback at every store write.

**GREEN:** replace Bundle construction with streamed Artifact preparation, descriptor encryption,
and multi-Object atomic registration. Stream page-snapshot and offscreen image output in bounded
chunks.

**Verification:** unit, integration, worker-restart, idempotency, quota, cancellation, dynamic-page,
and no-partial-authority tests.

## Task 6: Library Projection and Artifact UI

**RED:** rebuild tests require identical state from Events/descriptors/Artifacts. View tests require
all five Role rows, warnings, inspection, downloads, and context cancellation.

**GREEN:** update Library services, Projection encryption/cache, streaming read sessions, Artifact
panel, inspectors, neutral downloads, and live invalidation handling.

**Verification:** unit tests plus rendered desktop/narrow screenshots for present, optional failure,
loading, download, lock, and Vault-switch states. Inspect focus, dimensions, wrapping, clipping,
Object URL cleanup, and keyboard workflows.

## Task 7: Generation and Vacuum graph semantics

**RED:** Generation/Vacuum tests reject missing closure, extra Objects, cross-Bundle Objects, and
pre-commit payload deletion. Estimates include external wrapper bytes.

**GREEN:** update reachability validation, Event rewriting, CAS commit, post-commit deletion, and
orphan cleanup.

**Verification:** full Vacuum suite, interruption on both sides of commit, retained Deleted history,
Projection rebuild, and source Artifact immutability.

## Task 8: Vault Package contract

**RED:** package vectors require the new layout, Manifest, Complete coverage, Selective coverage,
permitted heavy omission, and prohibited compact omission.

**GREEN:** replace Export contracts, writer inventory, source enumeration, and strict decoders while
retaining the current key envelope and ZIP64 rules.

**Verification:** deterministic package vectors, Manifest/key binding, exact paths/order, STORE-only
ZIP64 metadata, no plaintext scan hits, and no stale Bundle ZIP fields.

## Task 9: Streaming package validator

**RED:** validation tests cover complete recovery, valid synthetic selective packages, false
coverage, bad omissions, corrupt wrappers, plaintext mismatch, malformed structured content, and
wrong passphrase.

**GREEN:** extend independent validation through Event closure, descriptors, Object records,
Artifact wrappers, Role rules, and omissions without destination writes.

**Verification:** independently open a generated package using only package bytes and passphrase;
compare recovered logical graph with the source; assert source head and all authoritative bytes are
unchanged.

## Task 10: Full integration and documentation

**RED:** source audits and documentation searches identify every stale contract and promise. A
Roadmap audit enumerates completed, duplicated, partially complete, and still-open passages, and
fails while completed or specification-owned details remain in `ROADMAP.md`.

**GREEN:** reconcile all affected documentation, tests, fixtures, examples, security allowlists, and
release checks in one canonical change. Prune the Roadmap according to section 13.1, retaining only
future deltas and links to canonical owners.

**Verification:** run every command in section 15, inspect all required screenshots, scan built
artifacts, complete the acceptance checklist, and manually compare every remaining Roadmap item
against implementation and owning documentation to prove it is unresolved and non-duplicative.

---

# 15. Required Verification

Discover commands from manifests at implementation time. At minimum run:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
git diff --check
```

Required focused evidence includes:

- canonical descriptor and structured-content vectors;
- chunked encryption vectors and adversarial framing cases;
- actual Chromium IndexedDB plus OPFS integration;
- Capture rollback injection at every authoritative write;
- worker termination before and after atomic commit;
- known-plaintext scans of IndexedDB, OPFS, Export files, diagnostics, and production build output;
- Complete Export independent recovery;
- synthetic Selective Export validation;
- forced ZIP64 on small fixtures;
- generated multi-gigabyte logical input proving counters and streaming without proportional memory;
- at least two open Library surfaces proving live updates and plaintext disposal;
- rendered and inspected desktop and narrow UI states.

Do not claim successful native Save As automation in headless Chrome if the operating-system chooser
cannot be controlled. Preserve `saveAs: true`; test package creation/validation, download lifecycle,
and cancellation independently, and document the environment limitation accurately.

---

# 16. Acceptance Criteria

The feature is complete only when every statement is true:

1. No canonical Bundle ZIP, embedded Artifact payload, Bundle-local Artifact ID, or 100 MiB
   whole-Bundle limit remains.
2. Every Capture has one encrypted descriptor and one independently encrypted Object per successful
   Artifact.
3. The `PRIMARY` page snapshot remains mandatory; all other Artifacts are best effort with typed
   visible warnings.
4. Empty text creates valid empty text and structured Artifacts rather than a failure.
5. Artifact plaintext is never persisted in IndexedDB, OPFS, logs, diagnostics, package metadata,
   or temporary extension files.
6. Chunk encryption and decryption retain bounded memory and reject every malformed or substituted
   stream before exposing unauthenticated plaintext.
7. A committed registration contains the descriptor, exact Artifact closure, Event, Projection,
   outcome, and head update atomically.
8. Worker interruption cannot produce a visible incomplete Bundle or retain an authoritative
   partial payload.
9. Vault Generation and Vacuum include and remove complete Bundle graphs correctly.
10. Projection rebuild reproduces metadata, Role presence, warnings, and thumbnail cache solely from
    authoritative Events and Objects.
11. Capture detail shows every Role and supports inspection/download of every present Artifact.
12. Lock and active-Vault changes immediately discard every plaintext stream, rendered inspection,
    selection, and Object URL.
13. Complete packages contain every reachable wrapper and remain independently recoverable with
    only package plus passphrase.
14. Selective packages authenticate every permitted heavy omission and never omit compact Artifacts.
15. Export streams wrappers directly from OPFS through ZIP64 without whole-Artifact decryption,
    base64, or buffering.
16. The strict validator authenticates Generation, Event replay, exact Object closure, descriptors,
    every present Artifact, structured/text canonical form, and coverage metadata.
17. Export never changes source Vault authoritative bytes or persists the Export passphrase.
18. Existing development data is cleared; no migration, fallback, alias, or superseded-format reader
    exists.
19. The Roadmap contains only unresolved future initiatives: completed items are removed, partial
    items retain only their unimplemented delta, and no format or behavior already owned by current
    architecture/specifications is duplicated there.
20. Unit, browser integration, E2E, typecheck, lint, build, release security, source audits, visual
    inspection, and `git diff --check` all pass.

---

# 17. Fixed Decisions

The implementer SHALL treat these as settled:

- implement the independent-Artifact foundation, not the entire synchronized web-client roadmap;
- retain full-local capture/bootstrap defaults while allowing the canonical explicit manual
  heavy-wrapper storage-relief UI;
- implement authenticated omission format now even though current local Export normally completes;
- use random Artifact/Object UUIDs, not content addressing;
- make `BundleRegistered` reference the entire Object closure directly;
- produce MHTML, screenshot, thumbnail, normalized text, and structured-content Roles;
- generate derived Artifacts best effort before the initial atomic registration;
- source text and semantic blocks from the live DOM;
- represent normalized text and structured content as separate Artifacts;
- use semantic reading blocks, not sanitized HTML;
- always include thumbnail, text, and structured content in Selective Export when referenced;
- store authoritative encrypted Artifact wrappers in OPFS;
- use the exact framed chunked XChaCha format in this plan;
- keep the encrypted thumbnail Projection cache for Library performance;
- expose all Artifact rows, inspection, warnings, and downloads for now;
- require clearing existing development storage and add no backwards compatibility;
- accept a best coherent multi-representation Capture rather than freezing or fingerprint-failing
  dynamic pages;
- treat no visible text as successful empty output;
- retain the existing device-only local Vault key model and fresh per-package Export passphrase.
