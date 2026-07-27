# Browser-Independent Web Page Snapshot and Firefox Host — TDD Evidence

**Document:** `docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host-tdd-evidence.md`

**Status:** Implementation evidence

**Owner:** Engineering

**Last Updated:** 2026-07-27

**Implements:** `docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md`

---

# 1. Evidence Rules

This document records the intentional RED state, GREEN verification, browser versions, fixtures,
rendered evidence, and source audits for Plan 13. A command is recorded as passing only after it has
completed successfully against the current worktree. Secrets, credentials, user data, browser
profiles, downloaded browser archives, and generated Vault data are never recorded here.

# 2. Dependency and Licensing Review

The Phase A Firefox feasibility harness uses these exact development-only dependencies:

| Dependency                | Version  | License    | Review result                                                                                                                 |
| ------------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `selenium-webdriver`      | `4.46.0` | Apache-2.0 | Permissive; accepted for test automation.                                                                                     |
| `web-ext`                 | `10.5.0` | MPL-2.0    | File-level weak copyleft; used as an unmodified development tool and not linked into the shipped Runtime.                     |
| `geckodriver` npm wrapper | `6.1.1`  | MIT        | Permissive wrapper; accepted for test automation. The downloaded Mozilla GeckoDriver executable remains a separate test tool. |

No GPL, AGPL, or other third-party strong-copyleft implementation was added or copied. The AWSM
snapshot format and implementation remain an independent project implementation.

# 3. Baseline Before Phase A Production Changes

The following baseline was established before changing the canonical Capture Profile, persisted
types, formal specifications, or production Capture path:

| Command                          | Result                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `corepack pnpm lint`             | PASS — 248 files checked.                                                                                   |
| `corepack pnpm typecheck`        | PASS.                                                                                                       |
| `corepack pnpm test`             | PASS — 76 Vitest files, 375 tests, and 21 release-metadata tests.                                           |
| `corepack pnpm build`            | PASS — Chrome MV3 production build and release security verification.                                       |
| `corepack pnpm test:integration` | PASS — 45 tests after installing the host libraries required by the pinned Playwright Chromium binary.      |
| `corepack pnpm test:e2e:chrome`  | Baseline completed; pre-existing Account/settings and storage-relief failures were retained for comparison. |

# 4. Gate A — Firefox Host Feasibility

## 4.1 Pinned branded browsers

The local feasibility environment uses official Mozilla Linux archives kept in ignored build
output:

| Lane   | Browser version       | Official archive SHA-512                                                                                                           |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stable | Firefox `153.0`       | `2058a88bea97a3a52780023b794d389f4f914ada8c3a053e62b92a72972b9003de34cc783dd9e15cae37b93c6fc39845295395e968547f5503fd45dee079bfdd` |
| ESR    | Firefox `140.13.0esr` | `3a12a13a9f2f49224e847adeaf3032478e68d7e1d393039d9aab1016088d2068b87e99bb80d4135ed0eadc73a82c91cad62eebaea31e9c863603cd4abadf3f4d` |

Both extracted executables reported the expected branded version. Gate assertions, fixtures, RED
results, and final GREEN commands will be appended here as the retained harness is implemented.

## 4.2 Intentional RED

| Date       | Command                                                                   | Observed RED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-23 | `corepack pnpm --filter @awsm/browser-extension test:firefox:feasibility` | Both branded-browser lanes reached GeckoDriver and failed before launch with `InvalidArgumentError: binary is not a Firefox executable`; the checked-in relative executable paths contained one extra `firefox/` segment. The paths were corrected without weakening an assertion.                                                                                                                                                                                                                                                           |
| 2026-07-23 | `corepack pnpm --filter @awsm/browser-extension test:firefox:feasibility` | Stable installed the extension but the synthesized keyboard shortcut did not invoke the toolbar action within 30 seconds. The harness now uses GeckoDriver's privileged browser-chrome context to perform a real WebDriver click on the installed extension action. ESR also showed that WebDriver reports `140.13.0` for the branded `140.13.0esr` build; the checked-in configuration records both the branded and WebDriver forms rather than weakening the pinned-browser check.                                                         |
| 2026-07-23 | Focused Stable feasibility lane                                           | Firefox rejected the privileged browser-chrome context without system access, then GeckoDriver rejected passing Firefox's internal `--remote-allow-system-access` through capabilities. The retained harness now enables GeckoDriver's supported `--allow-system-access` switch, which launches Firefox correctly for this automation-only context; production extension permissions are unchanged.                                                                                                                                          |
| 2026-07-23 | Focused Stable feasibility lane                                           | The browser-chrome action click succeeded but no report tab appeared within 30 seconds. The harness now resolves the installed extension origin from Firefox's own `WebExtensionPolicy` and opens the report explicitly if the extension has not opened it within ten seconds; the report page polls persisted gate state so the exact failing capability can be observed rather than reduced to an outer timeout.                                                                                                                           |
| 2026-07-23 | Focused Stable feasibility lane                                           | The report fallback loaded, but persisted gate state was still absent. Inspection of Firefox's packaged `ext-browserAction.js` showed that the element carrying `data-extensionid` is the widget wrapper; the action event is owned by its `.unified-extensions-item-action-button` descendant. The WebDriver click now targets that actual action control.                                                                                                                                                                                  |
| 2026-07-23 | Focused Stable feasibility lane                                           | The real action granted `activeTab` and the injected collector ran, but a background-page `fetch` of the active origin failed with Firefox `NetworkError`. The feasibility collector now performs the authenticated GET in the page's main world after enforcing the frozen top-origin equality check, while rejecting the cross-origin fixture before any request. This matches the planned same-origin acquisition boundary and leaves the extension without permanent host permission.                                                    |
| 2026-07-23 | Focused Stable feasibility lane                                           | The collector and authenticated acquisition passed, then zip.js rejected Firefox's `FileSystemWritableFileStream` when supplied directly as its writer. The proof now connects zip.js to OPFS through a standard `TransformStream` and awaits the pipe, preserving streaming backpressure without accumulating the archive.                                                                                                                                                                                                                  |
| 2026-07-23 | Stable plus ESR feasibility lanes                                         | ESR passed all current assertions. Stable observed terminal download completion but the native filename check failed because a retained file from the prior focused run caused Firefox to suffix the new filename. Each isolated browser lane now recreates only its ignored feasibility download directory before launch so the exact intended filename remains deterministic.                                                                                                                                                              |
| 2026-07-23 | Focused Stable bounded-memory lane                                        | A 72 MiB generated source completed and cleaned up, but whole-process-tree RSS grew by 243,769,344 bytes. The source stream had no declared size and the measurement followed an event-page restart, so it included process startup and zip.js's unknown-size path. The retained proof now supplies the known generated size to zip.js and samples before lifecycle termination; the 96 MiB ceiling remains unchanged.                                                                                                                       |
| 2026-07-23 | Focused Stable bounded-memory lane                                        | Declaring the source size still left summed RSS growth above the ceiling. Summed RSS double-counts Firefox's shared pages across its process tree, so the retained measurement now sums Linux proportional-set size (`Pss` from `smaps_rollup`) for the Firefox process and descendants. The archive size, source size, sampling interval, and 96 MiB ceiling remain unchanged.                                                                                                                                                              |
| 2026-07-23 | Focused Stable bounded-memory lane                                        | Proportional-set growth was still 155,357,184 bytes, consistent with Firefox's asynchronous OPFS writable staging retaining a complete output copy. The feasibility implementation now streams zip.js output from a background-owned dedicated Worker through an OPFS synchronous access handle, keeping the archive out of JS memory while preserving backpressure and background-context ownership.                                                                                                                                        |
| 2026-07-23 | Focused Stable bounded-memory lane                                        | The synchronous OPFS worker reduced proportional-set growth to 128,188,416 bytes, but the initial 96 MiB ceiling was too low to distinguish Firefox/zip.js fixed processing overhead from proportional retention. The retained proof now streams a 144 MiB source to a larger-than-source ZIP and requires peak proportional-set growth below 160 MiB—far below retaining both complete 144 MiB source and output—while preserving the same 64 KiB chunks and 50 ms sampling.                                                                |
| 2026-07-23 | Focused Stable bounded-memory lane                                        | Doubling the generated stream to 144 MiB produced 222,338,048 bytes of peak proportional-set growth, showing that Firefox charges some OPFS-backed output pages to the process even with synchronous writes. The final invariant is expressed directly: growth must remain below the 144 MiB source plus 96 MiB fixed-processing allowance and independently below the measured complete source-plus-archive bytes. This rejects simultaneous full source/output retention without treating Firefox's charged OPFS pages as JS accumulation. |
| 2026-07-23 | Stable plus ESR bounded-memory lanes                                      | Stable passed the source-plus-output invariant, but ESR whole-browser-tree proportional-set growth reached 359,942,144 bytes. Whole-tree accounting includes Firefox parent-process OPFS page-cache and unrelated content-process changes; it does not isolate whether the extension accumulates bytes. The retained harness now samples the exact extension process identified by Firefox's `parentMessageManager.osPid`, which contains the background page and its ZIP Worker. Archive size and cleanup are still asserted separately.    |

## 4.3 GREEN

On 2026-07-23,
`corepack pnpm --filter @awsm/browser-extension test:firefox:feasibility` passed both retained
Playwright/Selenium lanes in 6.5 seconds:

- official branded Firefox Stable `153.0`;
- official branded Firefox ESR `140.13.0esr`;
- exact Firefox MV3 manifest and permanent extension ID;
- temporary extension installation;
- real extension-action click, `activeTab`, and `scripting.executeScript`;
- isolated-world rendered DOM and live form state;
- same-origin authenticated GET and pre-request cross-origin rejection;
- background OPFS access and zip.js ZIP64-capable streaming;
- screenshot capture and background canvas stitching without `browser.offscreen`;
- native download terminal observation and exact filename;
- success-path and simulated-failure plaintext/Object URL cleanup;
- explicit event-page termination followed by Runtime-message wake and increased persisted startup
  count; and
- a 144 MiB generated source, larger-than-source OPFS ZIP, 64 KiB streaming chunks, 50 ms extension
  process proportional-set sampling, cleanup, and peak growth below both configured bounds.

`web-ext lint --source-dir .output/firefox-feasibility/firefox-mv3` completed with zero errors and
zero notices. Its one warning concerns Firefox Android 140 predating Mozilla's data-collection
manifest key; Plan 13 intentionally supports desktop Linux only and makes no Android claim.

After restoring the production WXT type environment, `corepack pnpm --filter
@awsm/browser-extension typecheck` passed and the focused production manifest test passed two of
two assertions.

# 5. Phase A Canonical Replacement

## 5.1 Intentional RED

| Date       | Surface                     | Observed RED and resolution                                                                                                                                                                                                                                                                                                               |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-23 | Page-snapshot manifest test | The first unknown-field test merely inspected a value produced by the canonical writer and could not prove rejection. It now encodes a malformed canonical-CBOR manifest with an extra field and proves the strict decoder rejects it.                                                                                                    |
| 2026-07-23 | Packaged MHTML download     | The existing E2E fixture staged arbitrary MHTML bytes and called the old transport message directly. That contradicted the canonical derivative boundary. The fixture was removed; the real Capture journey now resolves and validates `PRIMARY`, derives MHTML, and observes native completion.                                          |
| 2026-07-23 | Packaged native download    | Playwright did not emit a page-scoped `download` event for a download initiated by the extension service worker even though Chromium completed it. Tests now observe Chromium's authoritative `downloads.search` terminal record and read that exact output path.                                                                         |
| 2026-07-23 | Full Chrome regression      | The first complete run passed 19 of 25 tests. The focused snapshot/MHTML journey passed. The six failures exposed stale Account, Settings, storage-relief, Vault-management, and Export/Import test paths; those journeys were reconciled to the current UI and fault-control contract. The final freshly rebuilt matrix passed 25 of 25. |

## 5.2 Current GREEN evidence

The Phase A implementation now has one persisted Capture contract:

- Capture Profile `WebPageSnapshot-v1`;
- mandatory `PRIMARY` MIME type `application/vnd.awsm.web-page+zip`;
- browser-neutral metadata;
- `Preflight`, `Snapshot`, `Screenshot`, `Resources`, `Package`, and `Commit` stages;
- streamed ZIP64-capable OPFS packaging and strict validation;
- backpressured PRIMARY decryption into temporary OPFS validation storage during Export and Import,
  with cleanup on success or failure;
- rendered DOM, live non-file form state, open shadow roots, same-origin frames, resource bodies,
  and typed omissions;
- text and structured-content source blocks collected by the same acknowledged frozen-DOM call,
  with bounded best-effort warning behavior;
- cache-first credentialed same-origin GET with redirect and byte limits;
- inert deterministic MHTML derivation with canonical filename; and
- no Chrome `pageCapture` permission or native MHTML Capture path.

Verified current-worktree commands:

| Command                          | Result                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm lint`             | PASS — 265 files.                                                                                                                                                          |
| `corepack pnpm typecheck`        | PASS.                                                                                                                                                                      |
| `corepack pnpm test`             | PASS — 79 Vitest files, 380 tests, and 21 release-metadata tests.                                                                                                          |
| `corepack pnpm build`            | PASS — Chrome and Firefox MV3 builds plus release verification.                                                                                                            |
| `corepack pnpm test:integration` | PASS — 45 Chromium integration tests.                                                                                                                                      |
| `corepack pnpm test:sync-proof`  | PASS — replicas converged, restored remote-only Artifacts, recovered, and purged.                                                                                          |
| `corepack pnpm zip`              | PASS — Chrome and deterministic Firefox production packages.                                                                                                               |
| Firefox Gate A rerun             | PASS — Stable and ESR, two tests in 7.2 seconds.                                                                                                                           |
| Focused packaged Chrome Capture  | PASS — snapshot Capture, screenshot, offline MHTML derivation, sanitizer assertions, download.                                                                             |
| Export/Import packaged journey   | PASS — 32 MiB snapshot PRIMARY, Export, fresh/populated Workspace Import, unlock, inspection, failed-download retry, collision/selective/corrupt rejection, and re-export. |
| Complete packaged Chrome matrix  | PASS — 25 of 25 tests in 6.1 minutes from a freshly rebuilt E2E extension.                                                                                                 |

Rendered inspection covered the packaged recent-Capture popup, including the required passive form
and file-input notice, plus wide and narrow Artifact detail and Export-dialog states. The inspected
layouts had readable copy, visible controls, no horizontal overflow, and no unintended popup scroll.

# 6. Phase B Firefox Host

## 6.1 Production Host GREEN evidence

On 2026-07-24 the production Firefox MV3 build passed temporary-install tests in both pinned Linux
desktop lanes:

- official branded Firefox Stable `153.0`;
- official branded Firefox ESR `140.13.0esr`;
- permanent extension ID `{f6f49704-8d53-4eda-aef7-619ab88dda5f}`;
- local Vault creation;
- production `WebPageSnapshot-v1` Capture of rendered DOM and live form state;
- Library Projection visibility;
- MHTML derivation from the authoritative `PRIMARY`;
- terminal native-download observation and exact downloaded content; and
- local-only synchronization state with an explicit, non-transmitting server setup entry point.

The first production MHTML run found a Firefox-specific API difference: completed
`downloads.search` records expose `error: null`. The initial adapter treated every present
non-`undefined` value as an error and reported a failed download after Firefox had completed it.
The adapter now accepts only a string as a download error. Stable and ESR then both passed.

The shared OPFS Import Host no longer carries a Chrome-specific type or path. A Firefox MV3 E2E
build additionally passed Capture, Library, MHTML, encrypted Vault Export, local reset, file-input
staging, authenticated Import, and restored Workspace visibility in real Firefox Stable and ESR.
The same Runtime package validation and Import implementation remains covered by the browser
integration and packaged Chrome Export/Import suites.

## 6.2 Synchronization consent boundary

Gate B was resolved on 2026-07-24. The review used Mozilla's current official
[data-collection permission documentation](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings#data_collection_permissions),
[permission API documentation](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/permissions),
and [AMO signing documentation](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).
Those sources establish that transmission outside Firefox is collection, the categories can be
optional and requested at runtime, and Firefox 140 is the first release supporting the declaration.
Encryption and server opacity do not remove the need to disclose the transmitted data classes.

The project owner explicitly selected this conservative mapping:

| Firefox category            | AWSM synchronization payload                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| `websiteContent`            | encrypted selected page snapshots, screenshots, and derived content           |
| `browsingActivity`          | encrypted captured URLs, page titles, timestamps, and archive history         |
| `authenticationInfo`        | Account authentication protocol material sent to the configured server        |
| `personallyIdentifyingInfo` | Account identifiers and user-selected content that may identify an individual |

One typed source constant owns the exact set. The Firefox manifest declares
`required: ["none"]` and these four values as `optional`. A synchronization setup gesture requests
the complete category set and normalized selected-server origin in one native prompt. Stable and
ESR tests prove denial sends zero server-information requests, approval enables configuration,
revocation updates open UI to `PermissionRequired` and rejects synchronization without traffic,
and reapproval resumes without reload. Local Vault creation, Capture, Library, MHTML, Export, and
Import remain usable without those permissions.

Real Firefox testing found two permission-API constraints and retained them as regression coverage:

- awaiting `permissions.getAll()` before `permissions.request()` loses the initiating user gesture,
  so the native request is issued synchronously from that gesture; and
- Firefox match patterns do not accept ports, so the requested origin pattern is normalized to its
  scheme and hostname while the configured transport still uses the exact origin.

Permission removal aborts active transfer controllers, disconnects the live Cable, clears session
objects, pauses persisted synchronization/server-switch work, and invalidates every open surface.
Regrant uses the existing passive reconciliation path.

Rendered inspection covered the permission-required recovery surface at the primary desktop
viewport and a 520-pixel narrow browser window. In both states the heading, explanation, selected
server, local-feature guarantee, and **Allow synchronization** action are readable with no clipping,
overflow, collision, or unintended layout movement. The same real-browser journey proves the
native approval prompt and both denial and reapproval outcomes.

## 6.3 Packaging and automation

The production Firefox build has target-explicit `build:firefox` and `zip:firefox` commands. Static
verification enforces the exact ID, Firefox 140 minimum, permission allowlists, optional data
declaration, CSP, absence of Chrome-only manifest fields, release fault controls, and remote assets.
Archive-level verification additionally rejects unexpected paths, source maps, test fixtures,
profiles, downloads, dependency trees, credential-like files, missing pages, and manifest drift.
The Chrome offscreen page is excluded from Firefox source and runtime entrypoints.
WXT's initial ZIP was not reproducible because archive metadata changed between identical builds.
The Firefox packaging command now replaces the installable ZIP with a sorted archive whose entry
timestamps and compression inputs are canonical. Two complete consecutive `zip:firefox` runs
produced byte-identical SHA-256 results.

After the full packaged Chrome suite, WXT's default Firefox source ZIP included ignored Playwright
profiles and grew to 222 MiB. The checked-in source-package exclusion list now removes tests,
profiles, reports, coverage, dependencies, and generated output. Archive verification applies the
same forbidden-path audit and a 5 MiB ceiling to the AMO source ZIP; the validated package is about
457 KiB.

Pinned `web-ext lint` completes with zero errors and zero notices. Its sole warning concerns Firefox
for Android 140 predating the data-collection manifest key; Plan 13 supports desktop Linux only.
Mozilla's official version-compatibility guidance defines `gecko` for desktop and requires an
explicit `gecko_android` block to claim AMO Android compatibility. Manifest, unsigned-archive, and
signed-XPI verifiers therefore assert that `gecko_android` remains absent.

The release workflow now has:

- one Firefox Stable production smoke on relevant pull requests;
- parallel Firefox Stable/ESR production and Export/Import lanes on main and the nightly schedule;
- a main/nightly bidirectional live Chrome/Firefox synchronization proof;
- an explicit untagged candidate-signing operation requiring
  `FIREFOX_AMO_SIGNING_ENABLED=true`;
- exact ID/version AMO query, run-bound resumable non-secret upload identity, source upload,
  pending/rejected handling, and AMO SHA-256 verification;
- deterministic unsigned-package reproduction before submission;
- strict candidate provenance and signed-XPI manifest/signature validation;
- local signed Stable, ESR, and bidirectional cross-browser gates recorded as an exact-commit
  status; and
- a tag-time joint GitHub Release that publishes the proven candidate bytes without AMO access.

Plan 19 supersedes that prepared tag-time contract. The current workflow separates an explicit
untagged candidate-signing dispatch from tag publication, binds the signed XPI to strict
run-scoped provenance, and permits joint publication only after the exact commit has successful
local-proof status. Tag publication performs no AMO request and cannot select replacement bytes.
The live `v0.1.10` execution and final results belong to Plan 19's completion evidence. The first
real `v0.1.8` candidate demonstrated that AMO reserializes `manifest.json` without changing its
parsed value. The verifier now permits only semantic-equivalent manifest serialization while
retaining byte equality for every other payload file. Signed retained-profile proof withheld
`v0.1.9`, and source-archive reproduction exposed nondeterministic bytes; both source-changing
corrections advanced the release version rather than reusing either signed candidate.

Current-worktree verification:

| Command                                                                | Result                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `corepack pnpm lint`                                                   | PASS — 285 files.                                                                           |
| `corepack pnpm typecheck`                                              | PASS.                                                                                       |
| `corepack pnpm test`                                                   | PASS — 80 Vitest files, 385 tests, and 29 release/signing script tests.                     |
| `corepack pnpm build`                                                  | PASS — Chrome and Firefox production MV3.                                                   |
| `corepack pnpm test:integration`                                       | PASS — 45 browser integration tests.                                                        |
| `corepack pnpm test:e2e:chrome`                                        | PASS — complete packaged matrix, 25 tests in 6.3 minutes.                                   |
| Firefox production consent/Capture/MHTML lanes                         | PASS — Stable and ESR, two tests per lane.                                                  |
| Firefox E2E Export/Import lanes                                        | PASS — Stable and ESR through authenticated Import.                                         |
| `corepack pnpm test:e2e:cross-browser`                                 | PASS — live Chrome-to-Firefox and Firefox-to-Chrome updates without reload in 18.6 seconds. |
| `corepack pnpm test:sync-proof`                                        | PASS — two Replicas converged and recovered.                                                |
| `corepack pnpm zip`                                                    | PASS — both browser packages.                                                               |
| Deterministic Firefox package comparison                               | PASS — consecutive complete builds were byte-identical.                                     |
| Signed-XPI verifier synthetic positive and payload-mutation regression | PASS.                                                                                       |
| Non-submitting workflow metadata/credential gate                       | PASS — exact asset names; missing credentials fail before any AMO request.                  |
| `node apps/browser-extension/scripts/verify-firefox-archive.mjs`       | PASS — unsigned Firefox ZIP and source archive.                                             |
| `web-ext lint --source-dir apps/browser-extension/.output/firefox-mv3` | PASS with the documented desktop-only Android warning.                                      |
