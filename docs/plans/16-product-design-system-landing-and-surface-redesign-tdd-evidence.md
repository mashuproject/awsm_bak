# Plan 16 TDD Evidence

**Document:** `docs/plans/16-product-design-system-landing-and-surface-redesign-tdd-evidence.md`

**Status:** Complete

**Owner:** Engineering

**Last Updated:** 2026-07-26

**Depends On:** `docs/plans/16-product-design-system-landing-and-surface-redesign.md`

## Evidence rules

This ledger records contemporaneous RED, GREEN, refactoring, command, and rendered-inspection
evidence. It does not backfill a failing test after implementation. A missing historical RED is
reported as missing rather than invented.

## Baseline

| Area                   | Command                                           | Result                                                           |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Extension types        | `corepack pnpm typecheck`                         | PASS before Plan 16 implementation                               |
| Extension unit/release | `corepack pnpm test`                              | PASS: 95 files and 414 Vitest tests; 29 Node release tests       |
| Rails host process     | `bundle exec rspec` in `apps/coordination-server` | NOT RUN: host has no direct `bundle`; use repository Docker path |

The Plan 16 plan file was the only untracked repository file when implementation started.

## Task 1 — Design contract and routes

### RED

Before implementation, the repository had no root `DESIGN.md`, no `@awsm/design-system` workspace,
no design generation command, no public privacy/security route, and `HomeController#show`
redirected visitors instead of rendering a landing page.

### GREEN

`DESIGN.md` now defines the normative Bright Utility Kit contract. The generated
`@awsm/design-system` workspace supplies shared tokens, primitives, motion, keeper artwork, icons,
and a self-hosted Bricolage Grotesque font to Rails and WXT. Deterministic generation, token
resolution, contrast, local-palette, font-license, icon-provenance, and production-gallery checks
run through `design:check`.

### Refactoring

Token and icon output moved behind repository-owned generators so Rails and extension consumers
cannot drift by copying values. Rails asset paths and all development/proof container contexts were
then reconciled with the workspace source.

### Rendered inspection

Viewed `design-system-linux.png` and the 128px extension icon. The gallery exposes the selected
type, color, control, notice, card, dialog, focus, keeper, and motion rules without production
routing. The icon remains legible as a box/bookmark mark at the generated small sizes.

## Task 2 — Account and public Rails surfaces

### RED

There was no public root page, privacy/security surface, shared responsive navigation, rendered
registration state, signed-in landing state, or design visual lane. Account pages used the prior
unstyled shell. Historical command-level RED output was not retained and is not fabricated here.

### GREEN

Rails now serves the complete public-preview landing at `/`, factual `/privacy` and `/security`
pages, a test/development-only `/design-system`, and one redesigned shell for signup, sign-in,
Account, and password change. Request coverage proves signed-out, signed-in,
registration-disabled, trust-page, no-telemetry, validation, and production gallery behavior.
Stimulus enhances navigation, installation selection, and error focus; the content and forms
remain complete without JavaScript.

### Rendered inspection

Viewed the desktop and narrow landing, reduced-motion landing, signed-in landing, expanded trust
FAQ, open mobile menu, Chrome/Firefox installation content, privacy, security, resting and invalid
signup, sign-in, Account, password change, and design gallery Linux baselines. Typography wraps
cleanly, controls keep meaningful dimensions, accent blocks retain ink contrast, hard shadows are
consistent, and no inspected primary or 390px surface has horizontal overflow.

## Task 3 — Extension preferences and surfaces

### RED

The extension had no canonical `ui_preferences` store, strict presentation-preference decoder,
stable local sort/view contract, responsive drawer, synchronization stepper/dashboard design, or
packaged design baseline lane. Historical command-level RED output was not retained and is not
fabricated here.

### GREEN

The fresh version-1 schema now includes local-only `ui_preferences`, with strict default/read and
atomic replacement behavior that is excluded from synchronization, Export, and Import. Library
sorting is stable for Newest, Oldest, and Title; Grid and Compact list use distinct semantic
markup. The popup is capture-first, Library has the specified responsive application shell and
drawer focus contract, and synchronization presents the five-step sequence plus a Device
dashboard and unchanged security/danger ceremonies.

The packaged Chrome visual lane exercises first use, local readiness, live Capture progress and
success, wide/narrow Library, persisted presentation, Collection history, every setup step, and
the enrolled dashboard against the real Rails proof topology. The retained Chrome, Firefox, and
cross-browser lanes continue to cover alternate operational, recovery, failure, and destructive
states.

### Rendered inspection

Viewed `popup-first-use-linux.png`, `popup-capture-success-linux.png`,
`library-empty-wide-shell-linux.png`, `library-populated-grid-linux.png`,
`library-empty-narrow-drawer-linux.png`, `sync-recovery-step-linux.png` (with the secret masked), and
`sync-complete-dashboard-linux.png`. The popup hierarchy remains stable at 400px, grid and list
content are readable, the sidebar follows the Vault/Library/Collections/Deleted/maintenance/Account
hierarchy without overflow, the drawer clearly separates navigation from inert content, the
Recovery Phrase is static and prominent, and the dashboard exposes Server, Account, Vault,
synchronization, Devices, and the danger area without clipping.

## Final verification

| Command                                                                             | Result                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm design:generate && corepack pnpm design:check`                       | PASS: deterministic output; 0 errors, 0 warnings, 1 informational validator result                            |
| `corepack pnpm lint`                                                                | PASS: design contract plus Biome over 328 files                                                               |
| `corepack pnpm typecheck`                                                           | PASS                                                                                                          |
| `corepack pnpm test`                                                                | PASS: 29 Node release tests; 96 Vitest files and 417 tests                                                    |
| `corepack pnpm test:integration`                                                    | PASS: 50 Chromium IndexedDB tests                                                                             |
| `corepack pnpm test:e2e:design`                                                     | PASS: 5 real-topology visual tests                                                                            |
| `corepack pnpm test:e2e:chrome`                                                     | PASS: 23 packaged-Chrome journeys                                                                             |
| `corepack pnpm test:e2e:cross-browser`                                              | PASS: 8 production-build, release, and parity journeys                                                        |
| `corepack pnpm test:e2e:firefox`                                                    | PASS: 4 production plus 4 Export/Import Stable/ESR journeys                                                   |
| `corepack pnpm --filter @awsm/browser-extension zip:firefox`                        | PASS: deterministic release/source archives and static/archive verification                                   |
| Rails `bundle exec rspec` through the repository Compose service                    | PASS: 85 examples                                                                                             |
| Rails `bundle exec rubocop` through the repository Compose service                  | PASS: 138 files, no offenses                                                                                  |
| `docker build -f apps/coordination-server/Dockerfile -t awsm-coordination-plan16 .` | PASS; production Propshaft manifest includes the local font, keeper SVGs, icons, CSS, and Hotwire controllers |
| `corepack pnpm exec prettier --check <changed Markdown>`                            | PASS                                                                                                          |
| `git diff --check`                                                                  | PASS                                                                                                          |

The Firefox Export/Import lane initially exposed that Device and Vault-replacement repository
connections were omitted from local-reset shutdown. After closing both owners before deleting the
database, the focused Stable/ESR scenario passed 2/2 and the complete retained Firefox command
passed 8/8.

The production build first exposed that asset precompilation loaded registration configuration
without a public origin. The build now supplies only a reserved compile-time `.invalid` origin;
runtime deployments must still provide the actual required origin. A final-container assertion
confirmed the compiled CSS, WOFF2, and keeper SVG assets are present.

The Firefox archive gate also exposed stale `signup.html` inventory and a CSS-only asset allowlist.
The verifier now requires `sync-setup.html` and permits the licensed local WOFF2 asset; the complete
deterministic ZIP/source-ZIP command passes.
