# Browser-Independent Web Page Snapshot and Firefox Host

**Document:** `docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md`

**Status:** Approved implementation plan

**Owner:** Engineering

**Last Updated:** 2026-07-24

**Depends On:** `docs/plans/02-chrome-extension-capture-vertical-slice.md`,
`docs/plans/09-account-authentication-and-full-vault-synchronization.md`,
`docs/plans/10-git-like-synchronization-server-switching.md`,
`docs/plans/11-browser-storage-relief-and-remote-artifact-retrieval.md`,
`docs/plans/12-automated-chrome-extension-releases-and-installation.md`,
`docs/specifications/runtime/capture.md`, `docs/specifications/bundle/artifact.md`,
`docs/specifications/bundle/manifest.md`, `docs/specifications/bundle/bundle.md`,
`docs/specifications/event/event.md`, `docs/specifications/portability/import-export.md`,
`docs/architecture/13-capture-pipeline.md`, `docs/architecture/17-extension-framework.md`,
`docs/architecture/19-testing-strategy.md`, and `ROADMAP.md`

---

> **Current release contract:** Plan 19 supersedes this plan's deferred Gate C, tagged-beta,
> packaging-workflow, and distribution sections. The current workflow signs an untagged candidate,
> proves that exact Mozilla-signed XPI locally, records proof on the candidate commit, and only then
> permits an explicit tag to publish the same bytes. Plan 13 remains authoritative for the Capture
> and Firefox Host implementation; it is not authoritative for release sequencing.

# 1. Purpose

This is the decision-complete implementation plan for replacing Chrome-native MHTML Capture with
one browser-independent AWSM page snapshot and then implementing Firefox as a supported extension
Host. It is written for an implementer starting from a cold checkout with no conversation context.
Do not reopen the decisions recorded here.

The work has two mandatory phases:

1. **Phase A — browser-independent snapshot foundation:** prove the required browser capabilities,
   replace the sole canonical Capture Profile, implement it in Chrome, and generate MHTML only as
   an on-demand derivative.
2. **Phase B — Firefox Host:** implement the same Runtime contract in Firefox Manifest V3, prove
   Linux Firefox Stable and ESR parity, and implement a non-submitting, release-gated path for a
   future Mozilla-signed unlisted beta.

Phase B depends on the completed Phase A contract. Do not create a Firefox-only Bundle shape,
Capture Profile, cryptographic path, synchronization behavior, or user-data model.

The completed work SHALL:

1. replace `ChromeWebPage-v1` and MHTML `PRIMARY` with the sole canonical
   `WebPageSnapshot-v1` profile;
2. store one streamed AWSM-native ZIP64 snapshot as the mandatory `PRIMARY`;
3. preserve the post-render DOM, live form state, permitted resource bodies, and typed omissions;
4. retain current screenshot, thumbnail, extracted-text, and structured-content Artifacts;
5. generate a safe offline `.mhtml` file on demand in both Chrome and Firefox without storing it as
   authoritative Vault state;
6. remove the Chrome `pageCapture` dependency;
7. keep platform behavior behind Host and Driver interfaces;
8. ship a Firefox MV3 build with the fixed extension ID and Firefox 140 minimum;
9. keep local-only use available without data transmission and request Mozilla data permissions
   only when the user enables synchronization;
10. prove Chrome-to-Firefox and Firefox-to-Chrome live synchronization without reload;
11. produce a reproducible validated unsigned Linux package and a tested, non-submitting signed-XPI
    workflow before the plan is complete; and
12. leave real AMO signing/distribution, page playback, recorded interactive replay, temporal
    links, public store listing, and non-Linux Firefox claims on the Roadmap.

# 2. Mandatory Stop Gates

## 2.1 Gate A — retained Host feasibility proof

Before changing a formal specification, persisted type, Capture Profile literal, or production
Capture path, add and run a retained automated feasibility proof. This is not a disposable spike.
Its tests and harness remain as regression coverage.

The proof SHALL use:

- the repository-pinned Node and pnpm toolchain through `corepack pnpm`;
- WXT Firefox MV3 output, never WXT's Firefox MV2 default;
- real branded Linux Firefox Stable `153.0`;
- real branded Linux Firefox ESR `140.13.0esr`;
- the permanent Firefox extension ID defined in section 8.2;
- a temporary unsigned install for this pre-signing proof; and
- deterministic local HTTP fixtures, never public sites.

The proof passes only if Stable and ESR both demonstrate:

1. the generated manifest is MV3 and contains no Chrome-only manifest keys or permissions;
2. the extension loads temporarily under the permanent ID;
3. the background event page starts, can be terminated, and resumes on a new extension event;
4. an explicit user gesture grants `activeTab` and permits `scripting.executeScript` in the active
   HTTP fixture;
5. the injected isolated-world collector returns rendered top-document DOM and live form values;
6. a same-origin authenticated GET succeeds without a permanent site permission;
7. a cross-origin fixture body is not fetched;
8. OPFS is available from the Firefox extension background context;
9. `@zip.js/zip.js` streams a ZIP64-capable archive into OPFS without accumulating the archive in
   memory;
10. Firefox can stitch the existing screenshot plan without `browser.offscreen`;
11. `downloads.download` creates a file and the Host observes terminal completion or failure; and
12. temporary plaintext files and Object URLs can be released after completion and after a
    simulated failure.

Use scaled byte limits in ordinary feasibility tests, but include one bounded-memory process test
whose generated source exceeds 64 MiB. The test must sample process or browser memory and prove that
memory growth is not proportional to the complete source plus complete ZIP output.

If any required capability fails, stop. Record the browser version, exact failed assertion, minimal
fixture, and observed API behavior in
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host-tdd-evidence.md`. Do not
rewrite the canonical format, add broader permissions, add a native application, substitute MV2,
or invent a browser-specific contract without a new user decision.

## 2.2 Gate B — Firefox data-classification decision

AWSM synchronization transmits encrypted user-selected web content, browsing activity, Account
authentication material, and identifiers to the user's configured Coordination Server. Mozilla's
built-in data-collection taxonomy controls how a new signed Firefox extension declares and requests
that transmission.

Before adding final `optional` data categories or submitting any package to AMO:

1. review Mozilla's current official data-collection permission and AMO submission documentation;
2. obtain an explicit project-owner decision for every category that accurately describes the
   synchronization payload, conservatively including encrypted data transmitted outside Firefox;
3. record the sources, date, decision, rationale, and exact category mapping in the Plan 13 TDD
   evidence document without copying credentials or private user data;
4. make the mapping a single typed source constant consumed by manifest generation, Runtime
   permission requests, UI copy, and tests; and
5. add a manifest snapshot test for the exact approved mapping.

Until this gate passes, the Firefox build SHALL be local-only, declare
`data_collection_permissions.required: ["none"]`, expose no functional synchronization setup
action, make no Coordination Server request, and remain unsigned.

If the official taxonomy cannot accurately describe the payload, stop and return to the user. The
implementer must not omit a category or treat encrypted data as uncollected merely because Mozilla
or the Coordination Server cannot read its plaintext.

## 2.3 Completed Gate C — external signing authorization

Implementing and testing the signing workflow does not authorize creating a tag, GitHub Release, or
AMO submission. Before the first real unlisted submission:

- Gate B must be complete;
- the user must provide or confirm the protected AMO secrets and repository signing gate;
- the user must explicitly authorize the exact beta version/tag submission; and
- the tagged commit must already satisfy every local and CI acceptance gate in this plan.

The project owner authorized the exact first joint version and two-phase execution in Plan 19.
That plan owns AMO submission, signed-XPI retrieval, local proof, tagging, publication, and staging
verification. Do not print secrets or inspect secret values.

# 3. Scope, Deferrals, and Canonical Replacement

## 3.1 In scope

- one browser-independent Capture Profile and `PRIMARY` MIME contract;
- a canonical self-describing AWSM page-snapshot ZIP64 container;
- rendered DOM, live form-state, accessible-frame, and resource collection;
- explicit missing-frame and missing-resource records;
- bounded same-origin resource acquisition under `activeTab`;
- adaptive STORE/DEFLATE compression through the existing permissive `@zip.js/zip.js` dependency;
- streamed OPFS staging, encryption, validation, download, cancellation, and orphan cleanup;
- browser-neutral capture metadata and Runtime ports;
- Chrome migration to the new profile with native MHTML capture deleted;
- shared MHTML derivation and Chrome/Firefox download actions;
- Firefox MV3 manifest, lifecycle, screenshot, storage, download, and permission adapters;
- Linux Firefox Stable and ESR testing;
- mixed Playwright/Selenium E2E orchestration;
- a two-phase Mozilla signing and proof-gated joint-release workflow with synthetic verifier
  coverage;
- live UI state and rendered visual verification;
- full canonical documentation reconciliation; and
- destruction and recreation of pre-release development data.

## 3.2 Explicitly deferred

- later public AMO and Chrome Web Store listings, AMO-managed updates, and non-Linux Firefox
  support;
- an AWSM archived-page viewer or any Library playback surface;
- parsing, importing, or rendering arbitrary third-party MHTML;
- executing captured scripts;
- replaying recorded network traffic or an offline web application;
- Chrome Debugger API capture, Firefox response interception, or any stronger capture permission;
- archive-first or time-relative link resolution;
- fetching cross-origin resource bodies;
- replaying POST, PUT, PATCH, DELETE, or other non-GET requests;
- storing cookies, `Authorization`, `Proxy-Authorization`, `Set-Cookie`, or request headers;
- audio or video response-body recording;
- a per-Capture or configurable resource budget;
- Android Firefox;
- macOS or Windows Firefox support claims;
- public Firefox AMO or Chrome Web Store listing;
- store-hosted automatic updates, listing content, screenshots, review handling, or rollout;
- preservation of existing development Vaults; and
- compatibility with MHTML-primary Bundles or `ChromeWebPage-v1`.

## 3.3 Pre-release replacement rules

- Keep the sole canonical Bundle, Event, Artifact, and snapshot format versions at `1`.
- Do not add `V2` type names, version negotiation, a format migration, a legacy decoder, a dual
  reader, a dual writer, an import converter, or a fallback to native Chrome MHTML.
- Replace `ChromeWebPage-v1` everywhere, including tests, fixtures, docs, UI labels, error names,
  sample data, and development persistence.
- Keep IndexedDB's sole initial schema version unless this plan genuinely changes its store shape.
  If a schema field changes, update the initial schema in place and still keep its canonical version
  at `1`.
- Delete and recreate local browser profiles, IndexedDB, OPFS, proof-server state, and other
  development data before final verification.
- Do not reset the deployed Coordination Server or its data without a separate explicit remote
  mutation authorization.

# 4. Fixed Canonical Snapshot Contract

## 4.1 Bundle and Artifact contract

The sole Capture Profile is:

```text
WebPageSnapshot-v1
```

The mandatory Artifact reference is:

```text
Kind: CAPTURE
Role: PRIMARY
MIME type: application/vnd.awsm.web-page+zip
Required: yes
```

Keep these existing best-effort Artifact contracts unchanged:

| Role                 | Kind                 | MIME type                  |
| -------------------- | -------------------- | -------------------------- |
| `SCREENSHOT_FULL`    | `IMAGE`              | `image/webp`               |
| `THUMBNAIL`          | `IMAGE`              | `image/webp`               |
| `TEXT_EXTRACTED`     | `TEXT`               | `text/plain;charset=utf-8` |
| `CONTENT_STRUCTURED` | `STRUCTURED_CONTENT` | `application/cbor-seq`     |

The `.awsm-page` suffix is an internal diagnostic name only. Do not expose a Library action that
downloads the plaintext snapshot container. Users receive Complete AWSM Export and the generated
MHTML derivative.

## 4.2 Browser-neutral metadata

Replace the Chrome-specific metadata field with this exact logical shape:

```ts
interface CaptureMetadataV1 {
  readonly version: 1;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly contentType: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly document: { readonly width: number; readonly height: number };
  readonly browserName: string;
  readonly browserVersion: string;
  readonly extensionVersion: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly captureProfileVersion: 1;
}
```

Use `Chrome` and `Firefox` as the initial `browserName` values. Do not define the type as a
two-browser union; metadata is a persisted implementation description, not Host dispatch.

`BundleDescriptorV1`, `BundleRegisteredPayloadV1`, capture Commands, registration, Projection
rebuild, Export verification, Import verification, synchronization fixtures, and storage decoders
must accept only `WebPageSnapshot-v1`.

## 4.3 Capture Jobs and errors

Replace the Capture stage set with:

```text
Preflight
Snapshot
Screenshot
Resources
Package
Commit
```

Use these new Runtime errors:

- `PAGE_SNAPSHOT_FAILED` — required top-document collection failed or produced invalid bytes;
- `PAGE_SNAPSHOT_TOO_LARGE` — the required top document exceeds 64 MiB;
- `PAGE_PACKAGE_FAILED` — the required snapshot container could not be constructed or validated;
- `MHTML_DOWNLOAD_FAILED` — derivation, staging, native download, or completion observation failed.

Delete `MHTML_UNAVAILABLE` and `MHTML_CAPTURE_FAILED`. Do not retain aliases.

Add the Bundle warning `PAGE_SNAPSHOT_INCOMPLETE`. Emit it exactly once when the snapshot manifest
contains one or more optional omissions. Preserve the existing screenshot, thumbnail, text, and
structured-content warning behavior.

## 4.4 ZIP member layout

The `PRIMARY` plaintext is a ZIP archive capable of ZIP64. It has this exact member namespace:

```text
documents/000000.html
documents/000001.html
...
resources/000000.bin
resources/000001.bin
...
manifest.cbor
```

Rules:

- `documents/000000.html` is always the required top document.
- Descendant documents use DOM frame-tree preorder after the top document.
- Resource numbers follow first reference in document order, then breadth-first CSS dependency
  discovery.
- Deduplicate repeated references to the same normalized absolute URL within the same top-origin
  credential context.
- Write all document members, then all resource members, then `manifest.cbor`.
- Use UTF-8 names, no directory entries, no archive comment, no per-member comment, and no unknown
  extra member.
- Give every member the Capture timestamp as its modification time.
- Use DEFLATE level 6 for HTML, CSS, JavaScript, JSON, XML, SVG, and other textual media types.
- Use STORE for images, audio/video metadata or posters, fonts, WASM, PDFs, and recognized archive
  or already-compressed formats.
- ZIP implementation output is not required to be byte-identical between compression engines.
  Member names, order, uncompressed member bytes, manifest bytes, and validation behavior are
  canonical.

Construct the final ZIP as a stream into a temporary OPFS file. Never call `Blob.arrayBuffer()` or
equivalent on the complete snapshot, complete resource set, final ZIP, encrypted Artifact, or MHTML
derivative.

## 4.5 Canonical CBOR manifest

`manifest.cbor` is canonical CBOR with this logical schema:

```ts
interface PageSnapshotManifestV1 {
  readonly version: 1;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly capturedAt: string;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly topDocumentId: "d000000";
  readonly documents: readonly SnapshotDocumentV1[];
  readonly resources: readonly SnapshotResourceV1[];
  readonly omissions: readonly SnapshotOmissionV1[];
}

interface SnapshotDocumentV1 {
  readonly id: string; // d followed by six decimal digits
  readonly parentId?: string;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly member: string;
  readonly mediaType: "text/html;charset=utf-8";
  readonly byteLength: number;
  readonly sha256: Uint8Array; // exactly 32 bytes
  readonly scrollX: number;
  readonly scrollY: number;
}

interface SnapshotResourceV1 {
  readonly id: string; // r followed by six decimal digits
  readonly ownerDocumentId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly member: string;
  readonly mediaType: string;
  readonly contentLanguage?: string;
  readonly status: number;
  readonly byteLength: number;
  readonly sha256: Uint8Array; // exactly 32 bytes
  readonly acquisition: "Embedded" | "Cache" | "Network";
  readonly compression: "Store" | "Deflate";
}

interface SnapshotOmissionV1 {
  readonly ownerDocumentId: string;
  readonly url: string;
  readonly subject: "Frame" | "Resource" | "Media" | "FileInput";
  readonly reason:
    | "InaccessibleFrame"
    | "CrossOrigin"
    | "UnsupportedScheme"
    | "FetchFailed"
    | "ResourceTooLarge"
    | "CaptureBudgetExceeded"
    | "MediaBodyExcluded"
    | "FileBodyExcluded"
    | "InvalidContent";
}
```

Additional validation:

- records reject unknown fields;
- arrays are in canonical discovery order and reject duplicate IDs or member names;
- IDs must match their array index;
- every `parentId` and `ownerDocumentId` must resolve;
- every document/resource member must exist exactly once and no unreferenced member may exist;
- recorded lengths and SHA-256 values must match decompressed member bytes;
- URLs must be absolute and use the schemes allowed by their record;
- an embedded `data:` body uses `urn:awsm:data:sha256:<lowercase-hex-digest>` as both manifest URL
  values so the manifest does not duplicate the payload;
- an embedded `blob:` body retains its absolute `blob:` URL;
- a `FileInput` omission uses its owner document URL and never a local path or control value;
- the top document has no `parentId`;
- a captured descendant frame must not also have an `InaccessibleFrame` omission;
- the manifest is at most 16 MiB;
- the archive has at most 1,024 documents, 50,000 resources, and 100,000 total entries;
- member names are at most 256 UTF-8 bytes and must exactly match the fixed namespace;
- duplicate names, absolute paths, `..`, backslashes, NUL, encrypted ZIP members, multipart disks,
  and unsupported compression methods are rejected; and
- validation stops once declared or observed decompressed bytes exceed 512 MiB.

Validate the completed plaintext container before Artifact encryption and again whenever it is
resolved for MHTML derivation. An invalid required snapshot fails Capture; it is never registered as
a partial Bundle.

# 5. Fixed Capture Semantics

## 5.1 Preflight and temporal boundary

- Support only the active HTTP(S) tab.
- Require an unlocked active Vault and a user-initiated Capture Command.
- Use `activeTab` and `scripting`; do not request persistent page host access.
- Set `capturedAt` immediately before top-document collection.
- One acknowledged injected call collects the top rendered DOM, live state, metadata, frame
  inventory, resource inventory, and structured/text source blocks.
- The logical Capture becomes frozen when the required top-document result validates.
- If the tab navigates after that point, continue using the frozen result. Later acquisition
  failures become omissions.
- If the top document navigates or disappears before the acknowledged result, fail with
  `PAGE_SNAPSHOT_FAILED`.
- Capture the screenshot immediately after the frozen snapshot and before potentially long resource
  acquisition. Keep screenshot failure best effort.
- Derive `TEXT_EXTRACTED` and `CONTENT_STRUCTURED` from the frozen result, never by reading the
  mutable page again.

## 5.2 DOM serialization

Serialize a standards-valid UTF-8 HTML document with:

- the current doctype;
- the current rendered DOM rather than original response source;
- absolute top and frame URLs in the manifest;
- open shadow roots represented as declarative shadow DOM templates;
- same-origin accessible descendant frames as separate document members;
- inaccessible frame locations replaced with inert placeholders carrying the original absolute URL
  and a matching omission;
- absolute ordinary HTTP(S) navigation links;
- stable `awsm-resource:rNNNNNN` references for captured subresources;
- stable `awsm-document:dNNNNNN` references for captured frames; and
- original absolute URL metadata for omitted subresources without leaving an automatic network
  load in the serialized document.

Do not execute page code during serialization beyond the injected collector itself. Preserve inline
and external script source in the authoritative snapshot, but the snapshot is opaque data and is
never loaded into an extension page by this plan.

Capture live controls as follows:

- copy the current `.value` for every non-file `input`;
- copy current checked state for checkbox and radio controls;
- copy current `textarea.value` into text content;
- copy current selected options for every `select`;
- copy current `details.open`;
- preserve current contenteditable DOM;
- preserve values that may have been autofilled, including passwords, payment data, one-time codes,
  and private drafts; and
- never read or store file-input bodies. Record one `FileInput`/`FileBodyExcluded` omission per file
  control without recording its local path or value.

Do not send form-value categories, counts, element names, or values to logs, diagnostics, the
Coordination Server, or user-visible warnings.

After every successful Capture, the popup success state shows this non-blocking text:

```text
Captured pages preserve filled form values. File contents are not included.
```

Show it for every success so the UI does not reveal whether a particular page contained a sensitive
control. It requires no blocking confirmation and no persistent dismissal preference.

## 5.3 Resource discovery and acquisition

Discover:

- `src`, `srcset`, `poster`, stylesheet links, icons, SVG references, and CSS `url(...)`;
- CSS `@import` recursively;
- external scripts even though playback is deferred;
- accessible `data:` and same-origin `blob:` bodies; and
- same-origin frame resources.

Use one shared, tested CSS URL tokenizer. Do not use regular expressions as the sole CSS parser.
Malformed CSS may be stored as a body, but unresolvable nested references produce `InvalidContent`
omissions and `PAGE_SNAPSHOT_INCOMPLETE`.

Network rules:

- the allowed network origin is exactly the frozen top document's origin;
- use GET only;
- use `credentials: "include"` only for that origin;
- first attempt `cache: "only-if-cached"` with same-origin mode;
- on a miss, retry with the ordinary browser cache policy;
- use manual redirects, follow at most ten, and follow only same-origin HTTP(S) `Location` values;
- reject a response whose final URL is outside the top origin;
- store only decoded body bytes, numeric status, normalized `Content-Type`, and normalized
  `Content-Language`;
- do not store any request header, cookie, authentication header, redirect cookie, `Set-Cookie`,
  cache validator, CSP, report endpoint, or server timing value;
- never request a new host permission to improve completeness; and
- never acquire a cross-origin response body even when CORS would allow it.

An individual document or resource may contribute at most 64 MiB of uncompressed bytes. The total
uncompressed bytes across documents, resources, and the manifest may not exceed 512 MiB.

- A top document that exceeds its individual or total budget fails with
  `PAGE_SNAPSHOT_TOO_LARGE`.
- An optional frame that exceeds the limit is omitted.
- An oversized resource receives `ResourceTooLarge`.
- After the total budget is exhausted, later resources receive `CaptureBudgetExceeded` in canonical
  discovery order.
- Audio and video bodies always receive `MediaBodyExcluded`; retain ordinary DOM metadata and
  acquire a permitted poster as an image resource.
- Missing optional bodies never invalidate the frozen top document.

## 5.4 Packaging, Artifact preparation, and cleanup

Introduce browser-neutral Runtime ports for:

- preflight;
- snapshot collection;
- screenshot acquisition;
- resource byte streams;
- snapshot package staging;
- Artifact preparation;
- native download; and
- temporary-file cleanup.

Runtime modules must not import from `src/hosts/chrome` or `src/hosts/firefox`.

The Capture Runtime SHALL:

1. persist the `Preflight` Job;
2. collect and validate the frozen snapshot;
3. capture screenshot/thumbnail best effort;
4. acquire permitted resources and accumulate typed omissions;
5. stream and validate the `PRIMARY` package;
6. prepare each Artifact independently;
7. prepare the browser-neutral descriptor, Event, and Projection;
8. atomically commit the complete graph; and
9. delete all uncommitted temporary and encrypted Artifact files after any failure.

Register exactly one `PAGE_SNAPSHOT_INCOMPLETE` Bundle warning when the manifest omissions array is
nonempty. The detailed omissions remain encrypted inside `PRIMARY`.

# 6. MHTML Derivative

## 6.1 Product boundary

The Library's `PRIMARY` action is labeled **Download MHTML** in Chrome and Firefox. It resolves and
authenticates the `PRIMARY`, validates the snapshot container, generates a temporary MHTML file,
starts the native download, waits for terminal completion, and deletes the temporary plaintext.

MHTML is:

- never the authoritative `PRIMARY`;
- never included as an additional Vault Artifact;
- never synchronized independently;
- never used to rebuild text, structured content, or Search;
- never previewed by AWSM; and
- not promised to open natively in Firefox.

Use this filename:

```text
awsm-<first-eight-Bundle-ID-characters>-page.mhtml
```

## 6.2 Safe deterministic derivation

Generate `multipart/related` with CRLF line endings. Derive the boundary and Content IDs from the
validated `PRIMARY` checksum and member IDs. Base64-encode every MIME body with 76-character lines
so body bytes cannot collide with the boundary.

The root HTML derivative SHALL:

- rewrite captured document and resource references to matching `cid:` URLs;
- include only validated package members;
- replace missing automatic subresource references with inert placeholders;
- remove meta refresh;
- remove or neutralize every inline event-handler attribute;
- neutralize `javascript:` and other active URLs;
- convert scripts into inert preserved-source elements;
- disable form submission and form actions;
- add a restrictive offline CSP allowing only embedded MIME/data resources needed for rendering;
- retain ordinary absolute HTTP(S) anchors;
- add `target="_blank"` and `rel="noopener noreferrer"` to those anchors; and
- perform no network request until the user deliberately follows an ordinary link.

Preserve included CSS, images, SVG, fonts, posters, and captured frame documents. Rewrite CSS
resource URLs with the same tokenizer used during Capture.

Stream the MHTML output into OPFS and then through the browser's download Host. Base64 expansion may
cause the derivative to exceed remaining quota; this fails only the download with
`MHTML_DOWNLOAD_FAILED` and does not mutate or invalidate the stored Bundle.

Clean:

- the temporary MHTML after completed, interrupted, cancelled, or failed downloads;
- stale MHTML/download staging files during background startup reconciliation; and
- Object URLs and download listeners in `finally` blocks.

# 7. Chrome Foundation Changes

## 7.1 Manifest

The Chrome manifest retains:

```text
activeTab
scripting
offscreen
unlimitedStorage
downloads
alarms
```

Delete `pageCapture`. Keep Chrome minimum version `116`.

Update `scripts/verify-release.mjs` so it verifies the exact current Chrome manifest, rejects
`pageCapture`, rejects broad mandatory host permissions, and continues enforcing CSP and prohibited
storage/network rules.

## 7.2 Host decomposition

Move browser-neutral behavior out of `src/hosts/chrome`. Use:

```text
src/hosts/shared/
src/hosts/chrome/
src/hosts/firefox/
```

Organize responsibilities as follows:

- `src/hosts/shared` owns OPFS file primitives, download terminal-state waiting, snapshot/MHTML
  temporary-file cleanup, and extension-origin validation;
- `src/hosts/chrome` owns `browser.offscreen`, Chrome service-worker lifecycle integration, visible
  tab capture, and Chrome download invocation;
- `src/hosts/firefox` owns background-event-page lifecycle integration, DOM/canvas fallback,
  visible tab capture, Firefox download invocation, and Firefox permission integration;
- `src/runtime/capture` owns the browser-neutral ports, snapshot orchestration, error mapping, and
  atomic registration;
- `src/runtime/page-snapshot` owns manifest/container encoding, decoding, validation, resource
  rewriting, and MHTML derivation; and
- extension-origin validation uses `browser.runtime.getURL`, never a hardcoded
  `chrome-extension://` prefix.

Delete the native MHTML Capture adapter and `mhtml-download.ts` behavior that merely retypes an
already captured MHTML Blob. Replace it with the shared derivation Service.

## 7.3 Chrome regression boundary

Before beginning Phase B, Chrome must pass:

- canonical format and malformed-container tests;
- IndexedDB/OPFS integration tests;
- every existing packaged Chrome E2E journey, updated to the new profile;
- Capture with complete and incomplete fixtures;
- generated MHTML byte inspection and successful Chrome download;
- Complete Export/Import round trip;
- synchronization, storage relief, stale-Replica, server-switch, lock, and live-Projection journeys;
- production build and manifest security verification; and
- rendered popup/Library inspection at desktop and narrow widths.

# 8. Firefox Host

## 8.1 Fixed support boundary

Released Firefox beta support:

- desktop Linux only;
- current Stable and current ESR;
- Manifest V3 only;
- minimum installable version `140.0`; and
- unlisted Mozilla-signed XPI installation from the GitHub Release.

The initial reproducible CI pins are Stable `153.0` and ESR `140.13.0esr`. Store these pins in one
checked-in test configuration. Download official Mozilla release archives and verify them against
the corresponding official release SHA512 sums before execution. Updating either pin is an explicit
browser-test dependency change with manifest and parity reruns.

Do not claim macOS, Windows, Android, public AMO availability, or AMO-managed automatic updates.
Temporary unsigned installation remains available only for development.

## 8.2 Permanent identity and manifest

Use this exact permanent ID:

```text
{f6f49704-8d53-4eda-aef7-619ab88dda5f}
```

The generated Firefox manifest SHALL include:

```json
{
  "manifest_version": 3,
  "browser_specific_settings": {
    "gecko": {
      "id": "{f6f49704-8d53-4eda-aef7-619ab88dda5f}",
      "strict_min_version": "140.0",
      "data_collection_permissions": {
        "required": ["none"],
        "optional": [
          "websiteContent",
          "browsingActivity",
          "authenticationInfo",
          "personallyIdentifyingInfo"
        ]
      }
    }
  }
}
```

The four optional categories are the project-owner-approved Gate B mapping; do not change
`required`.

Firefox permissions are exactly:

```text
activeTab
scripting
unlimitedStorage
downloads
alarms
```

Preserve the existing optional HTTP(S)/localhost Host permissions used only for a user-selected
Coordination Server. Do not include `pageCapture`, `offscreen`, `minimum_chrome_version`, a Chrome
service-worker manifest key, or `<all_urls>`.

Generate Chrome and Firefox manifests from one WXT configuration using the target-browser input.
Add production manifest snapshot tests. Build Firefox with an explicit MV3 target in every script
and workflow.

## 8.3 Lifecycle and Host adapters

Firefox MV3 uses a background event page rather than Chrome's extension service worker. The Firefox
Host SHALL:

- initialize the same App/Runtime composition root;
- preserve persisted Job reconciliation across event-page suspension;
- use Runtime messages/ports without assuming `context.serviceWorkers()`;
- perform OPFS and DOM-capable work in the background page;
- stitch screenshot tiles through `OffscreenCanvas` when available and a detached document canvas
  fallback otherwise;
- create extension Object URLs in the active Firefox extension origin;
- set the intended filename directly in `downloads.download`;
- observe `downloads.onChanged` completion/interruption;
- clean listeners and temporary files on every terminal path; and
- use `browser.runtime.getURL` for extension pages.

Do not introduce keepalive loops into production. Tests may use an explicitly e2e-only keepalive
when needed to inject a termination boundary, but must also prove recovery without it.

## 8.4 Synchronization consent

After Gate B:

- local-only Vault creation, Capture, Library, Export, Import, lock, and MHTML download work without
  optional data permissions;
- choosing Account/synchronization setup from a user gesture requests the complete approved optional
  category set in one Firefox native prompt;
- denial returns to a functional local-only state and sends no request;
- approval continues the existing Account and server-origin flow;
- revocation immediately prevents new Coordination Server traffic, cancels or pauses active
  transfers at a safe persisted boundary, and shows synchronization as permission-required;
- reapproval resumes through the existing reconciliation logic;
- optional site-origin permission and data-collection permission are both required before a
  Firefox transport is constructed; and
- Chrome retains its current product consent flow because Chrome lacks Firefox's data-collection
  permission API.

Permission changes are live invalidations. Every open popup and Library refetches canonical Runtime
state without reload.

# 9. Mixed-Driver Browser Proof

## 9.1 Fixed dependencies

Add these exact development dependencies to `@awsm/browser-extension`:

```text
selenium-webdriver 4.46.0  Apache-2.0
web-ext            10.5.0 MPL-2.0
geckodriver         6.1.1 MIT package wrapper
```

Keep Playwright at the repository-pinned version. These are test/build dependencies, not shipped
Runtime code.

Before installation, record license review in the TDD evidence. Do not add GPL, AGPL, or another
strong-copyleft third-party implementation. Do not copy WACZ code or another archive tool's
implementation. Independently implement the AWSM format from this plan.

## 9.2 Driver responsibilities

- Playwright Test remains the test runner, fixture server orchestrator, assertion library, trace
  collector, and Chrome driver.
- `selenium-webdriver` controls real branded Firefox through GeckoDriver.
- Firefox temporary tests call `installAddon(path, true)`.
- Signed-XPI tests call `installAddon(path, false)`.
- A shared browser-client abstraction exposes extension ID, popup/Library navigation, active-page
  Capture, Runtime message invocation, reload/termination, download observation, and cleanup.
- Do not expose Playwright's `BrowserContext` or Selenium's `WebDriver` through Runtime/product
  helpers.
- Use isolated fresh browser profiles per test unless a scenario explicitly proves restart or
  upgrade behavior.
- Allocate unique test Accounts, Vaults, ports, download directories, and OPFS profiles so parallel
  jobs cannot share state.

## 9.3 Tiered lanes

### Pull requests

Run:

- dependency/license and manifest snapshot tests;
- lint, typecheck, unit tests, integration tests, and production builds;
- Chrome packaged tests already required by the changed behavior; and
- one Firefox Stable temporary-install smoke proving create local Vault, Capture the dynamic fixture,
  see the Library item, and download MHTML.

Do not run ESR, signing, or the full cross-browser matrix on every pull request.

### Main/nightly

Run the compact Firefox Stable parity suite:

1. first-use local Vault, lock, unlock, and event-page restart;
2. complete/incomplete Capture with dynamic DOM, form state, frame, CSS, and resource assertions;
3. screenshot, thumbnail, text, structured content, and passive form notice;
4. Library open, live update, and generated MHTML download;
5. Complete Export and Import into a fresh profile;
6. storage relief and remote-only Artifact retrieval;
7. stale-Replica recovery and server switching; and
8. Account synchronization and live Projection reconciliation.

Also run one Chrome-to-Firefox and one Firefox-to-Chrome synchronization scenario against the same
local proof server. Each scenario SHALL mutate through the source client and prove the already-open
destination Library updates without reload.

### Signed Linux beta

Plan 19 owns the exact two-phase release execution. Run:

Run:

- the complete existing Chrome packaged suite once;
- the compact parity suite against the exact signed XPI on Firefox Stable and ESR;
- both cross-browser synchronization directions;
- signed-XPI manifest and signature verification;
- native download filename/checksum proof; and
- final release-asset checksum verification.

Run Stable and ESR in parallel jobs. Do not duplicate every browser-neutral Runtime scenario in
both. Runtime contracts remain covered by unit/integration suites; signed-browser jobs cover Host
boundaries.

# 10. Firefox Packaging and Two-Phase Signing Gate

## 10.1 Local packaging

Add scripts with unambiguous names:

```text
build:chrome
build:firefox
zip:chrome
zip:firefox
test:e2e:chrome
test:e2e:firefox
test:e2e:cross-browser
```

Keep `build`, `zip`, and `test:e2e` as explicit aggregate aliases only if their final behavior is
documented and deterministic. Every Firefox WXT invocation includes both the Firefox browser target
and MV3.

Validate the unsigned Firefox ZIP before signing:

- one root `manifest.json`;
- exact permanent ID and minimum version;
- exact permissions and optional permissions;
- no Chrome-only keys;
- no remote code;
- no source maps, profiles, test fixtures, credentials, or plaintext Vault files;
- expected extension pages and packaged assets only; and
- successful `web-ext lint` with pinned `web-ext`.

## 10.2 Workflow contract

Plan 19 supersedes the original tag-time signing design. One workflow owns both phases without
creating competing publishers. Before candidate signing, configure:

```text
Repository variable: FIREFOX_AMO_SIGNING_ENABLED=true
Protected secret: AMO_JWT_ISSUER
Protected secret: AMO_JWT_SECRET
```

Never echo, transform into an output, upload, or interpolate either secret into a command string
that can be printed.

The candidate phase SHALL:

1. run only by explicit manual `sign-firefox-candidate` dispatch on an exact pushed commit;
2. prove package-version, intended tag, repository, commit, and main-branch ancestry;
3. package and validate deterministic unsigned Firefox and source archives;
4. submit or resume the exact permanent ID/version through `web-ext sign --channel=unlisted`;
5. retrieve and validate the Mozilla-signed XPI;
6. preserve a run-scoped provenance manifest binding all input and output hashes;
7. create no tag or GitHub Release; and
8. expose the exact run ID to the local verifier.

The local phase SHALL reproduce the unsigned inputs, prove the exact signed XPI in Firefox Stable,
Firefox ESR, and both cross-browser directions, and then write success context
`awsm/firefox-signed-local-proof` on the exact candidate commit. Failure SHALL write failure rather
than leave stale success.

Every validated `v<package-version>` tag SHALL:

1. prove package-version/tag equality and main-branch ancestry;
2. resolve the exact successful proof status and validate its candidate workflow run;
3. download and revalidate that run's provenance-bound XPI without contacting AMO;
4. rename assets to:

   ```text
   awsm-chrome-v<version>.zip
   awsm-chrome-v<version>.zip.sha256
   awsm-firefox-v<version>.xpi
   awsm-firefox-v<version>.xpi.sha256
   ```

5. revalidate both checksums after artifact transfer; and
6. create one GitHub Release only after every browser artifact passes.

AMO review may outlive one workflow run. Persist only non-secret submission identity as a workflow
artifact. A manual resume path SHALL validate the prior run and query the exact add-on ID/version
without resubmitting. Pending review creates no GitHub Release. Rejection creates no Release.

If `FIREFOX_AMO_SIGNING_ENABLED` is absent or not exactly `true`, a tag follows the Chrome-only
publication path and performs no AMO request. When it is exactly `true`, the Chrome-only publisher
is disabled and the joint publisher requires exact local proof. A validate-only dispatch performs
no AMO request; only the explicit candidate operation can submit.

## 10.3 Release documentation

Update release notes and installation guides so one release describes:

- Chrome ZIP checksum, unpacking, Developer Mode installation, and manual upgrade;
- Firefox XPI checksum and ordinary signed-add-on installation;
- Linux-only Firefox beta support;
- current Stable/ESR tested versions;
- no public browser-store availability or automatic updates;
- Firefox data-permission behavior when synchronization is enabled; and
- MHTML download availability in both browsers, with no claim that Firefox natively renders it.

Do not declare the first stable product release. Do not submit to Chrome Web Store or public AMO.

# 11. Documentation Reconciliation

Implementation is incomplete until every current-product document uses the new sole contract.

At minimum reconcile:

- `README.md` and installation/release guides;
- `docs/architecture/00-design-principles.md`;
- `docs/architecture/01-system-overview.md`;
- `docs/architecture/02-domain-model.md`;
- `docs/architecture/04-security-model.md`;
- `docs/architecture/06-bundle-format.md`;
- `docs/architecture/11-search.md`;
- `docs/architecture/13-capture-pipeline.md`;
- `docs/architecture/17-extension-framework.md`;
- `docs/architecture/19-testing-strategy.md`;
- `docs/architecture/consistency-review.md`;
- `docs/specifications/bundle/artifact.md`;
- `docs/specifications/bundle/manifest.md`;
- `docs/specifications/bundle/bundle.md`;
- `docs/specifications/event/event.md`;
- `docs/specifications/portability/import-export.md`;
- `docs/specifications/runtime/ai.md`;
- `docs/specifications/runtime/capture.md`;
- `docs/specifications/runtime/synchronization.md`; and
- every earlier plan only where it makes a present-tense canonical claim that became false.

Repository-wide searches must find no current-product use of:

```text
ChromeWebPage-v1
mandatory MHTML
MHTML PRIMARY
native MHTML support
chromeVersion
MHTML_UNAVAILABLE
MHTML_CAPTURE_FAILED
pageCapture
```

Historical approved plans may retain implementation-history statements only when clearly scoped as
history and not contradicted by a current canonical claim. Prefer replacing stale present-tense
language over adding compatibility commentary.

During implementation:

- keep **Firefox Extension Host** on the Roadmap only while work remains;
- remove it when this plan is fully implemented;
- add and retain separate future entries for **Static Archived Page Viewer**,
  **Recorded Web Application Capture and Replay**, and
  **Coordinated Browser Store Release**;
- do not describe completed snapshot or Firefox Host behavior as future work; and
- do not expand the deferred entries into implementation specifications.

# 12. Mandatory TDD and Evidence Workflow

Create
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host-tdd-evidence.md` before
production implementation. For each ordered task below, record:

- the failing test or audit and why it failed;
- the minimal production change;
- the passing focused command;
- defects discovered outside the expected failure;
- retained regression coverage;
- relevant browser/version/manifest evidence; and
- visual screenshots inspected for user-visible work.

For each task:

1. write the smallest meaningful failing unit, integration, manifest, browser, or source-audit test;
2. run it and record RED;
3. implement only that task's contract;
4. run the focused test and record GREEN;
5. run adjacent regression tests;
6. refactor only while green; and
7. update affected canonical docs before moving past a contract boundary.

Do not write a fabricated RED after implementation. Do not mark a browser proof passed from DOM
assertions alone when the requirement is a native permission prompt, lifecycle boundary, download,
or rendered surface.

# 13. Cold-Start Implementation Order

Execute in this order. A later task does not authorize skipping an earlier gate.

1. **Baseline and audit**
   - Run current lint, typecheck, unit, integration, Chrome E2E, build, and sync proof.
   - Record current counts/results and known environment failures.
   - Search all MHTML/profile/Chrome Host dependencies and list their owners.
   - Inspect dependency licenses.

2. **Feasibility RED/GREEN**
   - Add the real-Firefox harness, pinned versions, and minimal MV3 test extension.
   - Prove every Gate A assertion in Stable and ESR.
   - Stop on a failed required capability.

3. **Canonical contract RED**
   - Add failing domain/spec vectors for `WebPageSnapshot-v1`, new MIME, browser metadata, stages,
     errors, warning, and strict rejection of every superseded literal.
   - Add failing container decoder vectors before the encoder.

4. **Snapshot manifest and container**
   - Implement strict canonical-CBOR manifest decode/encode.
   - Implement ZIP writer/reader limits, member validation, adaptive compression, and hash checks.
   - Add corruption, traversal, duplicate, decompression-budget, and cancellation tests.

5. **Frozen DOM collector**
   - Add deterministic fixtures for client-rendered text, forms, password/autofill-like values,
     file inputs, open shadow DOM, same-origin frames, inaccessible frames, DOM mutation, and
     navigation.
   - Implement one acknowledged collection result.
   - Derive text and structured content from it.

6. **Resource acquisition**
   - Add authenticated cache/network, redirect, CSS, data/blob, cross-origin, size, total-budget,
     media, and failure fixtures.
   - Implement the exact GET/origin/header rules.
   - Prove deterministic resource and omission order.

7. **Capture Runtime and OPFS streaming**
   - Replace MHTML acquisition with Snapshot/Resources/Package ports and stages.
   - Stream, validate, encrypt, register, cancel, and reconcile temporary files.
   - Prove mandatory failure leaves no Bundle or plaintext orphan.

8. **Chrome Host replacement**
   - Remove `pageCapture` and native MHTML Capture.
   - Complete Chrome adapters, manifest verifier, and full regression suite.
   - Reset development browser state; add no compatibility path.

9. **MHTML derivation**
   - Add MIME vectors, sanitizer tests, CSS rewrites, form/script/network neutralization, filename,
     download completion/failure, and orphan cleanup.
   - Inspect a generated MHTML in Chrome with network logging proving zero automatic requests.

10. **Shared and Firefox Host decomposition**
    - Move shared adapters out of `hosts/chrome`.
    - Add target-specific manifests and Firefox background/event-page adapters.
    - Add Firefox local-first UI and Runtime parity.

11. **Firefox temporary-install parity**
    - Run the compact suite in Stable and ESR.
    - Prove lifecycle suspension, OPFS, native downloads, Export/Import, storage relief,
      stale-Replica/server switching, lock, and live surfaces.

12. **Mozilla consent gate**
    - Review Mozilla's current taxonomy and record the explicit Gate B owner decision.
    - Add exact categories, permission request/revocation behavior, UI, and tests.
    - Run both cross-browser synchronization directions without reload.

13. **Tiered CI**
    - Add PR, main/nightly, and tag lanes with the fixed scope.
    - Prove PR jobs do not run the Stable/ESR release matrix.
    - Prove isolated profiles and cleanup.

14. **Signing workflow**
    - Add deterministic metadata, dry-run, AMO submission/resume, checksum, and Release tests.
    - Run a manual non-publishing dry run.
    - Do not cross Gate C without explicit authorization.

15. **Defer authorized signed beta proof**
    - Keep submission, retrieval, signed Stable/ESR proof, and publication on the Roadmap.
    - Do not cross Gate C as part of Plan 13.

16. **Documentation and Roadmap**
    - Reconcile every current contract.
    - Add only the three deferred roadmap initiatives.
    - Run stale-term and broken-link audits.

17. **Final full verification**
    - Run every command in section 14.
    - Inspect the complete diff for secrets, generated browsers, profiles, downloads, archives,
      broad permissions, strong-copyleft code, stale formats, and compatibility branches.
    - Record final evidence and exact remaining external limitations.

# 14. Verification Commands

The completed repository must provide and run these exact root commands:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e:chrome
corepack pnpm test:e2e:firefox
corepack pnpm test:e2e:cross-browser
corepack pnpm test:sync-proof
corepack pnpm zip
```

Also run:

```bash
corepack pnpm exec prettier --check \
  docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md \
  docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host-tdd-evidence.md \
  ROADMAP.md \
  <all-other-changed-Markdown-paths>
```

Mandatory source audits include:

```bash
rg -n 'ChromeWebPage-v1|MHTML_UNAVAILABLE|MHTML_CAPTURE_FAILED|chromeVersion|pageCapture' \
  README.md ROADMAP.md apps/browser-extension docs

rg -n 'minimum_chrome_version|offscreen|browser_specific_settings|data_collection_permissions' \
  apps/browser-extension/.output

rg -n 'chrome-extension://' apps/browser-extension/src apps/browser-extension/tests
```

The first search may match clearly historical evidence only. It must not match production code,
formal specifications, current architecture, current UI, current tests, or forward-looking
Roadmap text.

For bounded-memory evidence, use generated streams and record peak memory for:

- a resource just below 64 MiB;
- a resource just above 64 MiB;
- a scaled total-budget exhaustion case;
- a large streamed snapshot package;
- a large streamed MHTML derivative; and
- Complete Export/Import containing the new `PRIMARY`.

# 15. Rendered Visual Evidence

Capture and inspect screenshots for Chrome and Firefox:

- successful Capture with the passive form-state notice;
- incomplete Capture warning;
- Capture failure;
- Library detail with **Download MHTML**;
- MHTML download busy, success, and failure states;
- local-only Firefox first use;
- Firefox synchronization permission-required state;
- Firefox permission denial and approval outcomes;
- synchronization paused after revocation;
- desktop Library;
- materially narrow Library;
- desktop popup; and
- materially narrow popup.

For every state inspect text wrapping, focus, accessible names, visible control size, spacing,
overflow, disabled/busy prominence, and unexpected layout movement. Keep two surfaces open for live
permission, Capture, lock, and synchronization changes and prove the observer updates without
reload.

# 16. Acceptance Criteria

This plan is complete only when all statements are true:

1. Gate A passes in real Linux Firefox Stable and ESR.
2. Exactly one canonical Capture Profile, `WebPageSnapshot-v1`, exists.
3. Every new Capture has one validated AWSM snapshot `PRIMARY`.
4. No production code or manifest requests Chrome `pageCapture`.
5. No compatibility reader accepts `ChromeWebPage-v1` or MHTML-primary Bundles.
6. Required top DOM, live form state, accessible frames, permitted resources, and typed omissions
   follow sections 4 and 5.
7. Capture and MHTML construction are bounded-memory and use OPFS staging.
8. Partial mandatory snapshots never register.
9. Chrome and Firefox generate the same logical MHTML derivative from the same `PRIMARY`.
10. Generated MHTML performs no automatic network request and executes no captured script.
11. Firefox is MV3, uses the permanent ID, enforces Firefox 140, and has no Chrome-only manifest
    key.
12. Local-only Firefox works without data transmission permission.
13. Gate B sources and owner decision are recorded and the exact approved optional categories drive manifest,
    Runtime, UI, and tests.
14. Denied or revoked Firefox data permission prevents Coordination Server traffic without breaking
    local-only Vault use.
15. Chrome and Firefox share authoritative Bundle, Event, Object, Export, Import, crypto, and sync
    contracts.
16. Chrome-to-Firefox and Firefox-to-Chrome mutations appear live without reload.
17. PR CI uses one Firefox Stable smoke rather than the full matrix.
18. PR and nightly lanes follow section 9.3, and the deferred tag lane is implemented without being
    executed.
19. Consecutive Firefox package builds are byte-identical, and signed-XPI verification rejects
    missing signatures or any AMO payload mutation in synthetic regression coverage.
20. Manual workflow dispatch is non-publishing, the credential guard stops an invoked signing path
    before AMO traffic, and no tag, AMO submission, or GitHub Release is required by this plan.
21. No public AMO/Chrome Web Store submission or non-Linux claim was introduced.
22. No playback, recorded app replay, temporal link, WACZ, broad Host permission, or audio/video
    body recording was implemented.
23. No third-party strong-copyleft implementation entered the dependency graph or source tree.
24. All affected formal specifications, architecture, product docs, guides, tests, and Roadmap text
    describe the sole current design.
25. All automated, source-audit, security, visual, and manual evidence is recorded in the Plan 13
    TDD evidence document.

# 17. Fixed Decisions Checklist

- [x] One plan contains two sequential phases; Firefox cannot precede the shared snapshot.
- [x] Feasibility is a retained automated stop gate.
- [x] `WebPageSnapshot-v1` is the sole canonical profile.
- [x] `application/vnd.awsm.web-page+zip` is the sole `PRIMARY` MIME type.
- [x] The internal container is streamed adaptive ZIP64 with canonical CBOR metadata.
- [x] Resource limits are fixed at 64 MiB each and 512 MiB total.
- [x] The top document is required; optional incompleteness is explicit.
- [x] Resource acquisition is same-top-origin GET only.
- [x] Live form values, including sensitive autofill, are preserved.
- [x] File bodies, credentials, request headers, and audio/video bodies are excluded.
- [x] The success notice is passive, generic, and shown after every Capture.
- [x] Captured scripts are preserved but never executed by this plan.
- [x] MHTML is a shared inert/offline download derivative, not authoritative state.
- [x] Chrome native MHTML Capture and `pageCapture` are deleted.
- [x] Firefox is MV3 desktop Linux Stable plus ESR with minimum version 140.
- [x] The Firefox ID is `{f6f49704-8d53-4eda-aef7-619ab88dda5f}`.
- [x] Mozilla's official taxonomy review and an explicit project-owner category decision are
      mandatory before data-category declaration or signing.
- [x] Firefox data permission is optional and requested only when enabling synchronization.
- [x] The deferred tag workflow produces both browser artifacts only after signing is enabled.
- [x] Plan 13 deferred real AMO submission, signed-XPI proof, and GitHub Release publication; Plan
      19 subsequently completed that release contract for the unlisted desktop-Linux beta.
- [x] Browser tests use tiered Playwright/Selenium lanes.
- [x] Public stores, macOS/Windows proof, playback, recorded replay, and temporal links remain future
      Roadmap work.
- [x] Pre-release data is recreated; no migration or compatibility behavior is allowed.
- [x] WACZ and third-party strong-copyleft implementation code are excluded.
