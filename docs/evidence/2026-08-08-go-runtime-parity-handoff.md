# Go Runtime parity handoff — 2026-08-08

## Current state

This checkout is on `main` at base commit `5a91ace` (`test(runtime): share browser crypto conformance vectors`). The change set below is the unversioned source to commit and push before release preparation. The package remains at `0.3.4`; no `0.3.5` candidate number has been created or consumed. The worktree contains the Go parity changes and the browser-capture follow-up below; there are no unrelated edits.

The larger Go/Wails semantic-parity objective is not complete. This handoff covers one concrete parity correction: Go Library and Search Materializations now use the installation-wrapped local-storage boundary required by `docs/specifications/runtime/storage.md`.

Capture remains extension-only. The extension-to-desktop Capture Bundle bridge is still out of scope.

## Brave capture follow-up

The user reported that an installed `0.3.4` extension in Brave did not capture. Repository evidence
shows why the previous Brave proof was insufficient: the post-release smoke rewrote its copied
manifest to require `<all_urls>` and injected a `tabId` into the capture message, while the
production popup sent no tab ID. The `v0.3.4` tag itself contains neither the later smoke proof nor
the explicit popup target selection. No direct inspection of the user's installed Brave profile was
available, so the exact installed-state failure remains user-reported; the following root-cause
statement is an inference supported by the repository mismatch and reproduced Brave behavior.

The popup now queries `{ active: true, currentWindow: true }` and passes the active tab ID through
`captureActivePage`. This keeps capture on the user-selected page and avoids adding a broad runtime
host-permission prompt; the shipping manifest remains the approved `activeTab`/`scripting` design.
The CDP smoke grants only `http://127.0.0.1/*` in its copied test artifact because opening
`popup.html` as a CDP page cannot invoke Brave's toolbar action to grant temporary `activeTab`
access. The production artifact itself is not mutated.

### Browser red/green evidence

1. `tests/unit/active-tab.test.ts` first failed because `src/hosts/shared/active-tab.ts` did not
   exist. After adding the helper and wiring the popup, the focused run passed 2 files and 4 tests.
2. The production Chrome build and `scripts/verify-release.mjs` passed; the manifest still has no
   required `host_permissions`.
3. `corepack pnpm test:e2e:brave` passed with `Brave capture E2E passed.` and exited 0. The exact
   temporary Brave process group, profile, and capture directory were verified absent afterward.
4. `corepack pnpm --filter @awsm/browser-extension test` passed 47 release-script tests and 741
   Vitest tests, with 2 skipped tests.
5. Chrome and Firefox production packaging/security verification passed. Firefox Stable and ESR
   production capture passed 2/2 each.
6. The packaged Chromium canonical journey reached and completed Capture, then failed later at a
   44px interactive-target assertion in the unavailable Library state. That visual-gate failure is
   separate from the capture fix and remains open.

## Implemented in this worktree

- Added `apps/runtime-go/internal/vault/materialization.go`.
  - Creates or reopens one installation-local 32-byte materialization key through `internal/securestore`.
  - Protects replaceable local snapshots with XChaCha20-Poly1305.
  - Authenticates the domain, Vault ID, and Frontier-bound materialization context as AAD.
  - Uses a mutex around first-key creation so concurrent Library/Search misses cannot seal with different first keys.
  - Treats missing, stale, malformed, unauthenticated, or unavailable snapshots as cache misses.
- Changed `ListLibraryProjection` in `apps/runtime-go/internal/vault/runtime.go` to load/store the encrypted Frontier-bound Library snapshot. `ListLibrary` now returns captures from that same projection path instead of rebuilding a separate view.
- Changed the existing Go Search materialization in `apps/runtime-go/internal/vault/search.go` from plaintext JSON in the state store to the shared encrypted wrapper. If secure storage is unavailable, Search still returns a freshly rebuilt result and simply cannot retain the replaceable cache.
- Added focused tests:
  - `TestRuntimeLibraryMaterializationIsInstallationWrappedAndSurvivesRestart`
  - `TestRuntimeLibraryMaterializationRefreshesAvailabilityAfterStorageRelief`
  - `TestRuntimeLibraryMaterializationRebuildsAfterTamper`
  - plaintext assertion in `TestSearchIndexesAuthenticatedLibraryProjection`
  - `TestSearchMaterializationRebuildsAfterTamperOnRestart`
- Cached Library projections refresh each capture's `AvailableLocally` flag against the current
  authenticated Replica on every successful cache read. Storage Relief therefore becomes visible
  immediately without making the disposable projection authoritative or rewriting it merely for a
  physical availability change.
- Updated the runtime README, desktop-command contract, testing strategy, and `ROADMAP.md` to record the invariant: Materializations are installation-wrapped, never Vault authority, and rebuild from authenticated Replica state when unusable.

## Honest red/green evidence

1. The new Library test first failed to compile because the materialization boundary and constants did not exist.
2. After the Library implementation, the new Search plaintext assertion failed and printed the prior unwrapped JSON Search document.
3. After wrapping both paths, the focused tests passed, including restart with the same state store and secure store.
4. The follow-up local-availability test was then run before the refresh implementation and failed by
   returning the cached `AvailableLocally: true` after Storage Relief. After adding the Replica-backed
   refresh, the focused refresh and restart tests passed.
5. The tamper tests passed after insertion because they exercise the already-established invalid-wrapper
   rebuild contract; the Search assertion was corrected to account for both Capture and Collection
   results while requiring the admitted Bundle result.

## Passing gates

These were run against the current source after the implementation:

- `go test ./...` from `apps/runtime-go`: passed.
- `go test -race ./internal/vault -run 'Test(RuntimeLibraryMaterializationRefreshesAvailabilityAfterStorageRelief|RuntimeLibraryMaterializationRebuildsAfterTamper|SearchMaterializationRebuildsAfterTamperOnRestart|RuntimeLibraryMaterializationIsInstallationWrappedAndSurvivesRestart|SearchIndexesAuthenticatedLibraryProjection)$' -count=1`: passed.
- `corepack pnpm lint`: passed after formatting the three ignored Wails-generated runtime files
  regenerated by the packaging build; it reported seven generated-file warnings and no errors. No
  generated Wails files are tracked.
- `corepack pnpm typecheck`: passed, including `go vet`.
- `corepack pnpm test:sync-proof`: passed; the proof verified opaque Hosted Replica isolation,
  transfer, and Grant boundaries.
- `corepack pnpm test:e2e:coordination`: passed; the E2E verified independent Host-process failover
  and restart while preserving opaque Replica access and bytes.
- `corepack pnpm test:e2e:desktop-runtime`: passed serially: packaged Chromium Runtime lane 2/2 and Wails Playwright lane 11/11.
- `corepack pnpm test:e2e:desktop-runtime:firefox`: passed 2/2 across Firefox stable and ESR.
- `corepack pnpm test:e2e:brave` passed with `Brave capture E2E passed.` and exited cleanly after
  the smoke teardown was changed to terminate the exact detached Flatpak profile/process group.
  The known Wayland/Vulkan warning was present but did not affect the capture result. Verification
  found no remaining test Brave process or `/tmp/awsm-brave-capture-*` directory.
- `corepack pnpm --filter @awsm/browser-extension test:e2e:canonical-surface` reached successful
  Capture, then failed later at `assertInteractiveTargets(library)` in the unavailable Library
  state. This remains a separate visual gate, not a Capture failure.

The first Chrome desktop attempt was launched concurrently with Firefox and failed because both fixtures use the fixed `127.0.0.1:37373` port. The serial Chrome rerun passed. Do not run those two fixed-port desktop lanes in parallel.

## Native and Docker evidence

- Host Fedora prerequisite attempt was made earlier: `sudo dnf install -y pkgconf-pkg-config gtk3-devel webkit2gtk4.0-devel xorg-x11-server-Xvfb`. It was blocked by the interactive sudo password prompt, not by an untried dependency.
- The documented Debian fallback was then used successfully to build the current source with `desktop,production` tags. Required packages were installed inside `golang:1.25-bookworm`: `pkg-config`, `libgtk-3-dev`, `libwebkit2gtk-4.0-dev`, and `xvfb`.
- The current Docker-built binary was written to `apps/runtime-go/cmd/awsm/build/bin/awsm-desktop` as a build artifact.
- A host-side AppImage attempt downloaded and checksum-verified the pinned `linuxdeploy` and `appimagetool` binaries, then failed because the Fedora host lacked `libwebkit2gtk-4.0.so.37`. This is expected for host packaging after a Debian-container build.
- A complete retry ran entirely in a disposable `golang:1.25-bookworm` container with the pinned
  Wails v2.13.0 build and the workflow-pinned linuxdeploy/appimagetool hashes. It produced
  `/tmp/awsm-appimage-proof.pMQX2s/release/awsm-desktop-linux-x86_64-v0.3.4.AppImage`; `file`, the
  packaging checksum, and `script/packaged-desktop-smoke.mjs` all passed. The AppImage SHA-256 was
  `84720ec98513c5e3921e679431e89cc49f8f8362228e113833bcc5ad3cd9ef96`. Temporary proof directories
  are outside the repository and disposable.

## Remaining work

1. Continue the larger parity audit: remaining shared cross-language command/replay and Complete
   Export vectors, randomized multi-Replica/restart/crash/authority-conflict/Sparse hydration
   coverage, and any still-missing native-package evidence.
2. If a completely green browser-gate record is required, repair the separate unavailable-Library
   interactive-target assertion exposed after the Capture step.
3. After the change set is pushed, keep the release unversioned at `0.3.4` until the complete
   pre-versioning gates pass; only then prepare the `0.3.5` candidate. Do not claim the larger parity
   audit is complete.

## Useful commands

```bash
cd /var/home/tristan/Documents/parasquid/awsm_bak
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:sync-proof
corepack pnpm test:e2e:coordination
go -C apps/runtime-go test ./...
corepack pnpm test:e2e:desktop-runtime
corepack pnpm test:e2e:desktop-runtime:firefox
corepack pnpm test:e2e:brave
```

For native Wails build fallback, use the exact Docker recipe in the repository-root `AGENTS.md`; do not classify missing GTK/WebKit libraries as an environment limitation before attempting installation or that fallback.
