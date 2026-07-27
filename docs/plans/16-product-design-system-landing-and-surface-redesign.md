# Product Design System, Landing Page, and Surface Redesign

**Document:** `docs/plans/16-product-design-system-landing-and-surface-redesign.md`

**Status:** Implemented; Account identity and dashboard content superseded by Plan 20

**Owner:** Engineering

**Last Updated:** 2026-07-27

**Depends On:** `README.md`, `VISION.md`, `AGENTS.md`, `ROADMAP.md`,
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md`,
`docs/plans/15-rails-account-recovery-phrase-device-sync.md`,
`docs/architecture/00-design-principles.md`, `docs/architecture/03-zero-knowledge.md`,
`docs/architecture/04-security-model.md`, `docs/architecture/14-trust-and-device-management.md`,
`docs/architecture/15-coordination-server.md`, `docs/architecture/17-extension-framework.md`,
`docs/architecture/19-testing-strategy.md`, and
`docs/architecture/20-deployment-and-operations.md`

> **Current-contract notice:** Plan 20 replaces this plan's email-based Account copy and expands
> the Account surface. Its design-system, interaction, accessibility, and visual-proof contracts
> remain current. See [Plan 20](20-username-account-and-devices-dashboard.md).

---

# 1. Purpose

This is the decision-complete implementation plan for creating one agent-readable AWSM product
design system, replacing the Coordination Server root redirect with a public-preview product
landing page, redesigning every Rails Account surface, and applying the same system through the
extension popup, Library, synchronization setup, dialogs, and visible operational states.

It is written for an implementer starting from a cold checkout with no conversation context. Do
not reopen the fixed product, brand, interaction, licensing, or scope decisions recorded here.

The completed work SHALL:

1. make a root `DESIGN.md` the normative visual and interaction-design contract for humans and
   coding agents;
2. expose generated, shared design tokens, fonts, primitives, mascot assets, and icons to both
   Rails and the extension without copied local palettes;
3. present AWSM as a public preview for web knowledge collectors with the exact promise
   **“Keep what matters. Even when the web moves on.”**;
4. make installation the primary conversion while presenting local-only operation before optional
   Account synchronization;
5. serve the landing page from the Rails root on hosted and self-hosted Coordination Servers;
6. keep signup on its existing separate route while bringing every Account page into the same
   visual system;
7. use Turbo and Stimulus to enhance Rails pages without making content, installation guidance, or
   Account forms depend on JavaScript;
8. reorganize the extension popup, Library, and synchronization setup around their distinct jobs
   while preserving Runtime authority and all implemented security ceremonies;
9. add only approved local Library sorting and grid/list presentation preferences, without
   presenting Search or any other Roadmap capability;
10. establish deterministic visual regression evidence for Rails and extension surfaces at primary,
    narrow, and reduced-motion configurations;
11. treat landing, trust, setup, and Account pages as evergreen product documentation which agents
    must reconcile whenever shipped behavior changes; and
12. keep unimplemented pricing, waitlist, marketing screenshots, dark mode, and repository
    repointing as explicit future Roadmap work.

This plan changes presentation and interaction hierarchy. It does not change the zero-knowledge
boundary: the Coordination Server remains unable to decrypt Vault content, and the Rails website
does not become a trusted Vault client.

# 2. Fixed Decisions, Scope, and Deferrals

## 2.1 Product and audience decisions

- The primary audience is people who continually collect useful web articles, references, and
  discoveries.
- The emotional promise is preservation first. Privacy and ownership prove the promise rather than
  replacing it with a cryptography-first hero.
- The exact hero heading is **“Keep what matters. Even when the web moves on.”**
- The hero's primary action is **Install AWSM**. It scrolls to an on-page setup guide.
- The hero's secondary action is **How it works**. It scrolls to the product explanation.
- Account creation appears only where optional synchronization is explained. It is not a hero or
  global-header conversion.
- The first landing release is a public preview. It SHALL state current browser and distribution
  limitations honestly.
- Local-only setup is the default path. Optional synchronization is introduced only after local
  installation and Vault creation.
- No pricing, hosted plan, or waitlist UI is included.
- No analytics, tracking pixels, third-party scripts, remote fonts, marketing cookies, or
  conversion telemetry are included.
- Public source, Release, documentation, and license links point to
  `https://github.com/mashuproject/awsm_bak` in this phase.

## 2.2 Visual direction

The system is a **bright utility kit**, not nostalgic archival styling and not generic blue SaaS
minimalism.

- Most visual area uses cream, paper, and ink.
- Saturated coral, yellow, cobalt, powder blue, and green appear as deliberate accent blocks.
- Marketing display type is bold, quirky, and typography-led.
- Working surfaces retain balanced information density and highly readable system UI text.
- Components use chunky medium-rounded geometry, heavy ink outlines, and hard offset shadows.
- Graphics are crisp, flat, code-native vectors without grain, paper textures, halftones, or
  photorealism.
- The mascot is an unnamed, faceless, limbless archive-box keeper derived from the existing
  archive-box/bookmark mark.
- The keeper feels alive only through opening, closing, tilt, squash, motion lines, and movement of
  the bookmark insert. Do not add eyes, a mouth, arms, legs, dialogue, or a public name.
- The keeper appears in brand, onboarding, empty, capture progress/success, offline, and recovery
  moments. It does not appear on every Capture card or act as a persistent companion.
- Public motion is highly expressive but never scroll-jacks, replaces the native cursor, delays
  access, blocks reading, or ignores reduced-motion preferences.
- This plan ships one complete light theme. It defines semantic tokens which can support a later
  dark theme, but does not implement one.
- Product copy is warm and direct. Recovery, security, warning, and destructive-action copy remains
  literal and unambiguous.

## 2.3 In scope

- root `DESIGN.md`;
- one shared design-system workspace package;
- exact token generation and drift enforcement;
- vendored/self-hosted display typography and license notice;
- new keeper, wordmark composition, Rails icons, and browser-extension icon family;
- a development/test-only rendered design-system gallery;
- a public Rails landing page at `/`;
- factual non-legal `/privacy` and `/security` pages;
- deployment-aware and registration-aware shared landing state plus private authenticated
  enhancement;
- responsive Rails navigation and full Account surface redesign;
- Hotwire enhancement for the Rails website;
- extension popup UX and visual redesign;
- responsive Library application-shell redesign;
- locally persisted sort and grid/list preferences;
- synchronization setup stepper and post-enrollment Device dashboard redesign;
- all current loading, empty, busy, offline, locked, auth-required, error, success, and dangerous
  ceremony states;
- deterministic screenshot baselines and visual interaction E2E;
- agent guidance and evergreen-document reconciliation;
- three new forward-looking Roadmap entries; and
- a Plan 16 TDD evidence document created during implementation.

## 2.4 Explicitly deferred

- dark mode;
- pricing, billing, payment processing, plan comparison, subscription state, or quota UI;
- collecting waitlist contact details or displaying a “plans coming soon” teaser;
- legal Terms of Service or a counsel-approved legal Privacy Policy;
- landing-page analytics or product telemetry;
- product screenshots in public marketing;
- testimonials, customer logos, user counts, GitHub-star counts, or other social proof;
- Search, quick title/URL filtering, tags, annotations, AI, summaries, or any other unimplemented
  product feature;
- new synchronization, recovery, Device, Vault, Capture, Import, Export, or storage semantics;
- Firefox signing, browser-store publication, or distribution-policy changes;
- the trusted Zero-Knowledge Web Host described separately on the Roadmap;
- white-label or administrator-configurable self-host branding;
- compatibility migrations for existing pre-release browser data;
- hosted deployment or mutation of `awsm.foo`; and
- repointing public links to `parasquid/awsm` before the active fork is merged back.

## 2.5 Licensing gate

Only permissively licensed tooling and assets selected below are authorized:

| Dependency or asset                        | Exact version/source | License    | Use                                                  |
| ------------------------------------------ | -------------------- | ---------- | ---------------------------------------------------- |
| `@google/design.md`                        | `0.3.0`              | Apache-2.0 | Development-only validation of root `DESIGN.md`      |
| `yaml`                                     | `2.9.0`              | ISC        | Development-only token generation and drift checking |
| `@fontsource-variable/bricolage-grotesque` | `5.3.0`              | OFL-1.1    | Reproducible self-hosted display-font files          |

Pin exact versions in the root lockfile. Copy only the required WOFF2 assets into the shared
design-system package, preserve the OFL text beside them, and do not fetch a font at runtime.
Retain all required Apache, ISC, and OFL notices.

Do not copy design-system code, illustration assets, CSS, or prose from outside reference
products. The keeper and all AWSM component styling must be independently authored from the fixed
description in this plan.

# 3. Canonical Design Contract

## 3.1 Root `DESIGN.md`

Create `DESIGN.md` at the repository root. It has two normative layers:

1. YAML front matter contains exact tokens that can be machine-validated and generated.
2. Markdown explains why and where those tokens apply.

The front matter SHALL use the selected DESIGN.md format and define at least:

- `version: alpha`;
- `name: AWSM Bright Utility Kit`;
- the complete color palette;
- display, product-heading, body, label, and monospace typography;
- spacing and radius scales;
- primary, secondary, quiet, danger, input, card, notice, dialog, sidebar, and focus components;
- component hover, active, focus, disabled, busy, error, and success variants.

The prose SHALL contain the known sections in their required order and add project-specific
guidance for:

- overview and product character;
- color roles and prohibited combinations;
- typography and content density;
- layout and responsive behavior;
- elevation and hard-shadow rules;
- shape language;
- reusable components and their states;
- motion and reduced motion;
- keeper/mark construction and allowed use;
- brand mode versus working-product mode;
- accessibility;
- writing voice;
- public product claims;
- implementation mapping to shared assets; and
- explicit dos and don'ts.

Tokens are normative values. Prose is normative usage guidance. A local stylesheet may not invent a
new hex color, font family, spacing rhythm, radius, shadow, or animation curve without first
updating `DESIGN.md` and the generated shared output.

## 3.2 Exact palette

Define these base tokens:

| Token       | Value     | Role                                                    |
| ----------- | --------- | ------------------------------------------------------- |
| `ink`       | `#18181B` | Primary foreground, outline, hard shadow, default icon  |
| `cream`     | `#FFF7E6` | Primary page background                                 |
| `paper`     | `#FFFFFF` | Raised working surface                                  |
| `coral`     | `#FF6B57` | Primary conversion and expressive action                |
| `yellow`    | `#FFD84D` | preservation, saved, keeper-bookmark, and focus moments |
| `cobalt`    | `#4E6BFF` | informational and technical accent                      |
| `sky-panel` | `#B8DFF5` | secondary expressive panel                              |
| `green`     | `#2E9B72` | local ownership and success accent                      |

Generate accessible pale and strong semantic variants for:

- ordinary and muted text;
- links;
- borders and subdued dividers;
- focus;
- informational notices;
- success;
- warning;
- danger;
- disabled controls; and
- selected navigation.

Ink is the default foreground on bright accent backgrounds. Do not assume white text passes on
coral, yellow, cobalt, powder blue, or green. Every component foreground/background pair must be
checked at WCAG AA by the design validator or a repository-owned test.

Color never communicates state alone. Pair semantic colors with text and, when useful, an icon.

## 3.3 Type, spacing, shape, and motion

- Marketing display headings use the locally bundled variable Bricolage Grotesque face.
- Dense application headings, body copy, labels, buttons, and forms use the existing native system
  sans stack.
- Recovery Phrase, identifiers, checksums, and explicitly technical fixed-width values use the
  native system monospace stack.
- Do not use the display font for paragraphs, form values, Library metadata, or dense settings.

Use one spacing scale: `4`, `8`, `12`, `16`, `24`, `32`, `48`, `64`, and `96px`.

Use radii:

- `8px` for compact controls;
- `12px` for ordinary controls and working cards;
- `20px` for expressive marketing panels;
- `999px` only for status pills, circular controls, and compact badges.

Use:

- `2px solid var(--awsm-ink)` as the characteristic outline;
- `4px 4px 0 var(--awsm-ink)` as the expressive hard shadow;
- no blurred shadow on primary brand cards;
- low or no elevation on repeated working-product rows;
- minimum `44px × 44px` interactive targets.

Define responsive breakpoints at `480`, `768`, and `1024px`. Components must respond to their
available width; breakpoints are not permission to assume one fixed desktop canvas.

Define motion durations for:

- immediate press/focus feedback;
- ordinary component transition;
- expressive reveal;
- long hero composition.

Use one standard ease-out and one expressive spring-like cubic Bézier. Reduced-motion maps
nonessential animation to `0ms`, removes travel, rotation, scale, stagger, parallax, and looping,
and renders the final visible state immediately.

## 3.4 Shared design package

Create `apps/design-system` as workspace package `@awsm/design-system`. It owns:

- `tokens.css`, generated from root `DESIGN.md`;
- base/reset CSS;
- typography declarations;
- reusable button, link, input, notice, card, dialog, navigation, badge, progress, and empty-state
  primitives;
- motion utilities;
- font assets and OFL notice;
- keeper/mark SVG source and reusable variants;
- source used to generate Rails and extension PNG icons;
- the DESIGN.md token generator and `--check` drift mode; and
- a package manifest exposing explicit CSS and asset entry points.

Rails adds the package asset directory to Propshaft paths and references digested assets normally.
The extension declares `@awsm/design-system: workspace:*` and imports the exposed CSS/assets through
WXT/Vite. Neither application copies the generated token file.

Add root scripts:

```json
{
  "design:generate": "node apps/design-system/scripts/generate.mjs",
  "design:check": "designmd lint DESIGN.md && node apps/design-system/scripts/generate.mjs --check"
}
```

Use the package's actual binary alias that works on the supported Node platforms. Root `lint` and
CI SHALL run `design:check` before application-specific lint.

Generation is deterministic. `--check` writes nothing, regenerates in memory, and fails when the
tracked CSS differs. It also fails on unknown required tokens, malformed YAML, unresolved
references, or an unlicensed/missing font asset.

## 3.5 Keeper and icon family

Independently redraw the existing archive-box/bookmark concept as one flat SVG source:

- ink archive-box silhouette;
- one contrasting bookmark insert;
- no face or limbs;
- no embedded raster data;
- no text baked into the mark;
- recognizable at 16px;
- no detail thinner than survives the 16px browser icon.

Provide controlled compositions for:

- static closed mark;
- open/catching;
- preserved/success;
- offline/resting;
- protected/recovery.

These may be separate SVGs or one symbol sheet, but they must share geometry rather than becoming
unrelated illustrations. Decorative instances use empty alternative text or `aria-hidden`.
Meaningful status instances require adjacent visible text; the keeper never carries the status
semantics alone.

Generate the full existing extension icon-size family and replace the Rails placeholder icons from
the same source. Check transparency, padding, and legibility at every emitted size.

## 3.6 Development design gallery

Add `/design-system` only in development and test routing. Production routing must not recognize
it and must return 404.

The gallery renders real shared assets and component primitives, not copied showcase-only styles.
It SHALL include:

- all palette tokens and foreground/background pairs;
- type scale and long-copy examples;
- spacing, radius, border, and shadow scales;
- every control variant and state;
- fields with help, validation, error, disabled, and autofill treatment;
- notices and progress;
- cards in brand and workspace density;
- navigation, sidebar, drawer, dialogs, forms, and tables/lists;
- keeper compositions;
- motion and reduced-motion representations;
- long strings, empty content, maximum content, and narrow layouts.

The gallery is a visual test fixture and agent reference. It is not a public brand page.

# 4. Rails Product Site

## 4.1 Routes and root behavior

Keep all existing API and Account routes. Add:

- `GET /privacy` → `HomeController#privacy`;
- `GET /security` → `HomeController#security`;
- development/test-only `GET /design-system`.

`HomeController#show` renders one cache-safe landing representation for authenticated and
unauthenticated visitors. It does not redirect or resolve browser-session state.

The home view receives:

- validated configured public origin;
- registration enabled/disabled state from `Coordination::Registration`;
- latest-Release, install-guide, source, documentation, and license links from one Rails helper or
  immutable configuration object.

Do not expose credentials, Account data, session state, CSRF tokens, or Vault facts in the shared
view model.

## 4.2 Universal and self-hosted presentation

Every Coordination Server deployment serves the same AWSM product page. It is not white-label.

Show a compact deployment-aware strip which:

- identifies the current server origin;
- states whether this server currently permits Account creation;
- never claims an arbitrary self-hosted deployment is the official hosted service;
- does not send the origin to analytics or another host.

When a readable non-authoritative session hint is present, a private no-store status request
progressively adds a non-dismissible synchronization-focused banner:

- state that the Account is signed in on the displayed server;
- link to Account management;
- provide a CSRF-protected sign-out action;
- link or scroll to the optional synchronization setup explanation;
- do not imply that browser login alone unlocks a Vault.

When unauthenticated, the global navigation shows **Sign in**. It does not show **Create Account**.

## 4.3 Header and page outline

The sticky header contains:

- keeper mark and AWSM wordmark linking to `/`;
- **How it works**, **Privacy**, and **Open source** anchors;
- cache-safe **Sign in**, enhanced privately to **Account** for a valid hinted browser session;
- **Install AWSM**, scrolling to `#install-awsm`;
- an accessible mobile-menu button below the navigation breakpoint.

The page uses this exact narrative order:

1. deployment/public-preview context;
2. hero;
3. changing-web problem;
4. product proof;
5. how preservation works;
6. optional encrypted synchronization and privacy;
7. ownership/open-source proof;
8. install/setup guide;
9. FAQ;
10. final CTA and footer.

The page may use asymmetric graphic composition, but headings, source order, focus order, and
reading order must remain linear and sensible.

## 4.4 Hero

Use:

```text
Keep what matters.
Even when the web moves on.
```

Supporting copy SHALL say, without claiming unimplemented behavior:

```text
AWSM saves the page—not just the link—into a private archive on your device. Keep it available
offline, export it, and optionally synchronize encrypted copies across browsers.
```

Primary button: **Install AWSM** → `#install-awsm`.

Secondary link/button: **How it works** → the first product-proof section.

Add a visible **Public preview** label. Do not say “free forever,” “production ready,” “available in
browser stores,” or “works everywhere.”

The composition is typography-led. Animate words and abstract page shapes into the keeper, but do
not require animation to understand the heading or actions.

## 4.5 Product story and abstract diagrams

The changing-web section contrasts:

- a bookmark retaining only an address; and
- AWSM preserving a browser-independent page snapshot plus the best-effort representations it
  actually captures today.

Use concise claims for:

- authoritative page snapshot;
- full-page screenshot when successful;
- extracted text and structured content when successful;
- local encrypted Vault;
- offline Library;
- Collections;
- Complete Export/Import;
- optional encrypted synchronization.

Do not turn best-effort Artifacts into unconditional promises.

Use independently authored abstract SVG diagrams rather than extension screenshots or fake UI:

1. a web-page shape enters the keeper;
2. preserved representations enter a local Vault;
3. the local Vault remains usable without network;
4. an opaque encrypted package crosses to the Coordination Server;
5. another certified browser recovers it using the Account plus Recovery Phrase.

The server diagram must not visually receive readable titles, URLs, thumbnails, or plaintext.
Label the Account password as server identity only and the Recovery Phrase as client-held Vault
recovery. Expandable detail may mention Device certificates and encrypted key envelopes, but the
plain summary comes first.

## 4.6 Ownership and open-source section

Give this a major visual section rather than footer badges. Explain:

- the device is the primary application environment;
- local use requires no Account;
- synchronization is optional;
- the server stores encrypted opaque records and operational metadata;
- Complete Export avoids provider lock-in;
- source is available under AGPL;
- the Coordination Server can be self-hosted.

Link to the current public fork's source, license, self-host documentation, and technical security
model. Do not claim that self-hosting removes all traffic or metadata exposure.

## 4.7 Installation guide

The `#install-awsm` section is the destination of every public install CTA.

The browser-distribution bullets below record the state required when this design plan was
implemented. Plan 19 supersedes the Firefox distribution copy with the unlisted Mozilla-signed
desktop-Linux beta; current public surfaces follow Plan 19 and the installation guide.

Use a progressively enhanced browser selector with complete static content:

### Chrome

- identify it as the currently downloadable preview;
- link to `https://github.com/mashuproject/awsm_bak/releases/latest`;
- link to the checksum and existing Chrome installation guide through the Release/guide, without
  hardcoding a versioned ZIP;
- summarize download, checksum verification, unpacked installation, and local Vault creation;
- do not claim Chrome Web Store availability.

### Firefox

- identify it as tested but unsigned/development-only;
- link to the existing Firefox development installation guide;
- explain that temporary installation ends when Firefox restarts;
- do not offer an unsigned archive as ordinary consumer installation;
- do not imply AMO approval.

### First use

Present:

1. install;
2. choose **Continue without sync**;
3. create a local Vault;
4. archive an HTTP(S) page.

Only after that, explain optional synchronization:

- select a Coordination Server;
- create an Account on this server only when registration is enabled;
- sign in through the extension;
- save and confirm the Recovery Phrase;
- enroll other Chrome or Firefox Devices.

When registration is disabled, show factual unavailability instead of a broken signup link.

## 4.8 FAQ

Use native `<details>` unless a specific Hotwire behavior materially improves accessibility. Cover:

- Does AWSM save the page or only the link?
- Does AWSM require an Account?
- Can the Coordination Server read a Vault?
- What is the difference between the Account password and Recovery Phrase?
- Does AWSM work offline?
- Which browsers and installation forms are supported today?
- Can AWSM be self-hosted?
- Can data be exported?
- Is Search or AI available today?

Answers must be derived from current evergreen documentation. Do not copy long specification prose
into the view.

## 4.9 Footer

Include:

- Install;
- Chrome guide;
- Firefox guide;
- Privacy;
- Security;
- source;
- documentation;
- license;
- Sign in or Account.

Do not include pricing, careers, press, social-media placeholders, newsletter signup, cookie
preferences, or nonfunctional links.

# 5. Privacy and Security Pages

Create factual product explanations, not legal documents.

## 5.1 `/privacy`

Describe:

- local Capture and Vault content;
- private Account username and password digest;
- browser and API session records;
- Device certificates and encrypted key envelopes;
- server-visible identifiers, byte counts, timing, IP/access logs, and traffic patterns;
- opaque encrypted Vault records and Artifact bytes;
- no landing analytics or third-party tracking;
- the fact that a self-hosted operator controls its own deployment and logs;
- Export and local deletion boundaries.

Do not promise that the server sees “nothing.” It cannot decrypt content, but it sees operational
metadata.

## 5.2 `/security`

Describe:

- Account password over TLS and bcrypt storage;
- Recovery Phrase remaining client-held;
- certified Device identity and Device-scoped access;
- local encryption and opaque synchronization;
- ordinary Device removal versus future-content protection;
- limitations after a Device or export has already copied plaintext or keys;
- browser/device compromise limitations;
- the distinction between the marketing/Account Rails site and a trusted Vault client.

Link to the current architecture and specification sources for exact contracts.

Neither page uses legal-policy language such as “we may,” retention promises not implemented in
code, or counsel assertions.

# 6. Hotwire and Progressive Enhancement

Hotwire applies to Rails website surfaces only.

## 6.1 Turbo

- Keep Turbo Drive enabled for ordinary navigation.
- Ensure form validation renders with HTTP 422 and preserves field values except passwords.
- Use Turbo Frames only where they simplify Account form/status replacement.
- Do not introduce server round trips for browser selection, scroll reveals, or animation.
- Preserve server redirects and session semantics from Plan 15.

## 6.2 Stimulus

Delete the generated `hello_controller.js`. Add focused controllers for:

- mobile navigation and focus restoration;
- hero/keeper animation lifecycle;
- intersection-driven reveal and stamp effects;
- install-browser selection and locally detected browser emphasis; and
- any disclosure behavior not adequately served by native HTML.

The browser selector may highlight a locally detected browser but always renders both Chrome and
Firefox choices. It sends no user-agent result to the server.

Controllers SHALL:

- declare targets and values rather than query unrelated global DOM;
- clean up observers, listeners, and animations on disconnect;
- tolerate Turbo cache and reconnection;
- never inject trusted HTML strings;
- preserve the complete cache-safe server-rendered anonymous state;
- avoid layout thrashing and continuous scroll handlers.

## 6.3 Motion

Use CSS transitions/keyframes and the Web Animations API through Stimulus. Add no animation library.

Permitted expressive behavior:

- staggered hero type arrival;
- keeper tilt/open/close;
- abstract page shapes moving into the keeper;
- section color-panel reveal;
- hard-shadow press movement;
- capture-success placement;
- one-shot progress/success state transition.

Prohibited behavior:

- scroll-jacking;
- parallax required for comprehension;
- looping decorative motion near forms;
- animated Recovery Phrase words;
- animation of destructive warnings;
- custom cursors;
- autoplay sound;
- motion before reduced-motion preference is known.

# 7. Account Surface Redesign

Preserve these separate routes and their Plan 15 behavior:

- `/sign_up`;
- `/session/new`;
- `/account`;
- `/account/password`.

## 7.1 Account shell

At `768px` and above, use a two-column shell:

- expressive color/keeper story panel;
- focused paper form or Account panel.

Below `768px`, collapse the story panel into a compact branded header. The form comes first in
source and focus order. Do not force a full-viewport minimum height that clips errors or the mobile
keyboard.

## 7.2 Forms

Every form SHALL provide:

- visible labels;
- required semantics and existing autocomplete values;
- an error summary focused after invalid Turbo submission;
- summary links to invalid fields;
- inline field errors associated through `aria-describedby`;
- retained username and non-secret values;
- cleared password fields after failure;
- visible focus and autofill treatment;
- minimum 44px controls;
- disabled/busy state only while a submission is in flight.

Signup and login copy SHALL explain that the Account password identifies the user to this
Coordination Server and cannot decrypt a Vault.

Password change copy SHALL preserve the literal distinction from the Recovery Phrase and warn that
successful change revokes sessions.

The Account page may show Account and session facts already available today. It must not show Vault
names, Capture content, Recovery Phrases, keys, or cryptographic Device management.

# 8. Extension UX Redesign

The extension remains native TypeScript, DOM, and CSS. Do not introduce Hotwire, a component
framework, an animation framework, or remote assets.

Refactor large entrypoint render functions into focused view modules before or while restyling so
individual states can be rendered and tested directly. Business rules, validation, persistence,
and Commands remain in the Runtime/Driver layers.

Every successful mutation continues to use the existing live-state invalidation and reconciliation
contract. A visual refactor must not replace live Runtime state with cached UI state.

## 8.1 Popup

The ready state is a minimal one-button capture tool:

- compact keeper/wordmark;
- current page title and host when capturable;
- subtle active Vault and synchronization state;
- one visually dominant **Archive this page** button;
- compact secondary **Open library** and settings affordances.

While capturing:

- keep the popup stable rather than replacing its entire geometry;
- show current capture stage and meaningful progress;
- disable duplicate capture;
- use one keeper capture animation unless reduced motion is enabled;
- retain live status semantics.

On success:

- show the recent Capture title and thumbnail only when available;
- provide **Open in library**;
- preserve dismissal behavior;
- never keep decrypted content after a Vault context change.

The minimal ready state does not remove required alternate states:

- first use;
- local-only choice;
- permission request;
- Account login/setup continuation;
- locked Vault;
- unsupported URL;
- offline;
- authentication required;
- stale Replica;
- capture warning;
- safe failure and retry.

Security and recovery states may use a larger popup composition when needed. Do not hide them behind
an unlabeled gear solely for visual simplicity.

## 8.2 Library application shell

At `768px` and above, create a persistent sidebar and main content canvas.

Sidebar order:

1. keeper/wordmark;
2. active Vault and Vault management/switch affordance;
3. Library;
4. active Collections;
5. Deleted;
6. storage and maintenance;
7. Account, synchronization, and settings at the bottom.

Below `768px`:

- replace the rail with a labeled menu button;
- open an overlay drawer;
- trap focus within the drawer;
- close on Escape and explicit close;
- restore focus to the menu button;
- prevent background interaction and scroll while open;
- do not use a persistent bottom navigation.

The content canvas retains all current capabilities:

- active and Deleted Collection groups;
- Collection preview;
- Collection detail/history;
- Capture detail;
- screenshots and Artifact actions;
- drag/drop;
- keyboard-accessible move/extract/merge;
- delete/restore;
- Vault create/switch/rename/lock;
- Import/Export;
- storage relief;
- Vacuum;
- Account and server switching.

Use contextual menus or grouped action bars to reduce repeated button noise, but keep dangerous and
primary actions visibly labeled. Do not hide critical errors, synchronization conflicts, or active
maintenance behind menus.

## 8.3 Sort and view preferences

Add exactly two new presentation utilities:

- sort by **Newest**, **Oldest**, or **Title**;
- display as **Grid** or **Compact list**.

Defaults:

- sort: `CapturedNewest`;
- view: `Grid`.

Sorting is stable:

- newest and oldest compare canonical `capturedAt`, then title, then identifier;
- title uses locale-aware comparison, then newest, then identifier;
- it changes presentation only and emits no Command/Event.

Grid/list choice changes markup appropriate to each layout rather than using CSS to disguise one
semantic structure.

Do not add a text input, quick filter, domain filter, status filter, tag filter, or Search-like
feature.

## 8.4 Preference persistence

Add canonical IndexedDB store:

```text
ui_preferences
```

Use key:

```text
library
```

Use exact persisted shape:

```ts
interface StoredLibraryPreferencesV1 {
  readonly version: 1;
  readonly sort: "CapturedNewest" | "CapturedOldest" | "TitleAscending";
  readonly view: "Grid" | "List";
}
```

Rules:

- absence returns defaults;
- unknown or extra fields are malformed and produce a safe diagnostic/error rather than being
  silently interpreted;
- writes replace the one complete record atomically;
- preferences contain no Account, Vault, Capture, title, URL, or content identifier;
- preferences remain device-local and non-authoritative;
- exclude them from synchronization, Export, Import, Backup, and Vault deletion semantics;
- a preference failure must not prevent authoritative Library use; render defaults for that
  session and surface a non-content diagnostic.

Because AWSM is pre-release, add the store directly to the sole canonical version-1 database
definition. Recreate development, test, E2E, and proof databases/profiles. Add no version bump,
migration, fallback, or schema-upgrade reader.

## 8.5 Library content presentation

Use balanced workspace density:

- expressive page/Collection headings;
- compact repeated metadata;
- clear thumbnail hierarchy;
- visible host and captured time;
- explicit local/remote availability status;
- warnings attached to the affected Capture;
- stable card/row geometry while thumbnails load;
- no keeper repeated on content cards.

Empty, offline, auth-required, failed-integrity, no-thumbnail, remote-only, and loading states get
purpose-built presentation rather than blank grids.

## 8.6 Synchronization setup and Device dashboard

Reorganize first setup/recovery into a visible five-step sequence:

1. **Server**
2. **Account**
3. **Vault**
4. **Recovery**
5. **Complete**

Only the current step is interactive, but prior completed steps remain summarized and navigable
only when revisiting cannot bypass a server, authentication, or recovery invariant.

Preserve:

- hosted/self-hosted server choice;
- Firefox optional permission ceremony;
- server registration discovery;
- extension login only;
- existing local Vault versus new Vault choice;
- Recovery Phrase reveal, download, and full re-entry;
- fresh-Device Recovery Phrase enrollment;
- restart-safe recovery and replacement state;
- all existing error and retry outcomes.

After enrollment, replace the setup view with a dashboard containing:

- current server origin;
- Account identity;
- synchronized Vault context;
- synchronization state and last meaningful outcome;
- enrolled Devices;
- setup/recovery actions that are currently valid.

Create a clearly separated **Security and danger area** for:

- Device removal;
- future-content protection;
- full Vault replacement.

Do not soften, abbreviate, or animate away Plan 15 warnings. Recovery Phrase words remain static,
selectable, readable, and excluded from decorative animation. Preserve full re-entry, verified
Export gates, destructive confirmation, progress, cancellation, retry, and failure behavior.

# 9. Accessibility, Responsiveness, and Content Rules

## 9.1 Accessibility

All surfaces SHALL:

- meet WCAG 2.2 AA for contrast and interaction;
- retain semantic landmarks and heading order;
- provide visible focus not dependent on color alone;
- expose accessible names for icon-only controls;
- keep interactive targets at least 44px in both dimensions unless an inline text link;
- support keyboard operation for drawers, menus, dialogs, drag/drop alternatives, forms, sort, and
  view selection;
- preserve live-region behavior for operation progress and completion;
- remain usable at 200% text zoom;
- prevent horizontal page overflow at supported narrow widths;
- use reduced-motion final states;
- keep error text adjacent/associated with the failing action.

The hard shadow may move on press, but focus must not be represented only by that movement.

## 9.2 Responsive targets

At minimum inspect and test:

- `1440 × 1000` public desktop;
- `1024 × 768` compact desktop;
- `390 × 844` narrow/mobile Rails;
- packaged extension popup at its actual browser dimensions;
- Library at wide and sub-768px narrow widths;
- sync setup at wide and narrow widths.

No supported surface may depend on hover. Touch, keyboard, and pointer paths must be equivalent.

## 9.3 Content truth

Public copy and diagrams are product documentation:

- advertise only behavior proved in the shipped repository;
- distinguish mandatory from best-effort Capture Artifacts;
- distinguish local-only, optional synchronization, and remote-only storage relief;
- distinguish Account password from Recovery Phrase;
- distinguish Firefox development support from signed distribution;
- distinguish Rails marketing/Account pages from a Vault web client;
- do not duplicate low-level protocol schemas in marketing prose;
- link to owning technical documentation for exact details.

# 10. Documentation and Roadmap Reconciliation

## 10.1 Agent guidance

Update root `AGENTS.md`:

- add `DESIGN.md` to **Where to look** as the normative visual-system source;
- require application code to consume shared tokens/assets rather than introducing local values;
- define public landing, privacy, security, setup, Account copy, diagrams, and availability as
  evergreen product documentation;
- require every feature completion to audit these pages just as it audits README and architecture;
- prohibit presenting Roadmap, partially implemented, or unverified behavior as current;
- require visual-baseline updates and rendered inspection when a feature affects public claims or a
  visible state;
- require privacy/security claim reconciliation when server-visible data changes.

## 10.2 Evergreen documentation

Reconcile at least:

- root README product availability and hosted-origin description;
- Coordination Server README root route and public pages;
- system overview and Coordination Server architecture;
- zero-knowledge/security explanations;
- testing strategy;
- deployment and operations;
- installation guides;
- Roadmap dependencies and future initiatives.

The Rails site is a product landing and Account surface, not the Roadmap's **Zero-Knowledge Web
Host**. It never captures, decrypts, browses, searches, imports, or exports Vault content. Remove
stale claims that the server origin exposes only an API, while retaining the trusted-client
boundary.

Preserve prior plan documents as history. Create
`docs/plans/16-product-design-system-landing-and-surface-redesign-tdd-evidence.md` during
implementation.

## 10.3 New Roadmap entries

Add exactly these forward-looking initiatives:

### Hosted Plans, Billing, and Preview Waitlist

**Status:** Discovery

Define pricing, quotas, payment processing/provider, taxes, abuse controls, legal/privacy terms,
support commitments, cancellation/refund behavior, and production readiness before presenting plan
teasers or collecting waitlist contact details.

### Authentic Product Screenshot Marketing

**Status:** Candidate

After the redesigned popup, Library, and synchronization surfaces stabilize, capture deterministic
real product states and replace or supplement the landing's abstract diagrams. Screenshots must be
fixture-backed, current, privacy-safe, and updated under the website-as-documentation rule.

### Public Repository Repointing

**Status:** Candidate

After the hackathon-judged upstream and active fork merge back, repoint landing, Release, source,
documentation, installation, and license links from `mashuproject/awsm_bak` to
`parasquid/awsm`. Do not dual-link or add an automatic fallback.

# 11. Testing and Evidence

## 11.1 TDD requirement

Create the Plan 16 evidence file before implementation. For each task record:

- the RED command and failure;
- the smallest implementation that made it GREEN;
- refactoring performed afterward;
- exact final command/result;
- screenshot paths and manual inspection notes for visible changes.

Do not backfill fabricated RED evidence after the implementation exists.

## 11.2 Design contract tests

Prove:

- `DESIGN.md` parses and passes pinned validator rules;
- every token reference resolves;
- required foreground/background pairs pass AA;
- generated CSS is deterministic and current;
- both Rails and WXT consume the shared package;
- no application-local hardcoded palette is introduced except explicitly permitted
  browser/platform fallbacks;
- font files and license notice exist;
- all emitted icon sizes derive from the canonical keeper source;
- the development gallery is unavailable in production.

## 11.3 Rails request tests

Cover:

- signed-out `/` renders landing and Sign in;
- signed-in `/` returns the same shared HTML and privately enhances to the synchronization-focused
  banner;
- Account and CSRF-protected sign-out actions are correct;
- configured deployment origin is escaped and displayed independently of request Host;
- registration enabled shows contextual Create Account;
- registration disabled shows no signup action;
- `/privacy` and `/security` render factual content;
- the four public responses have the shared-cache contract and contain no Account, CSRF, or cookie
  state;
- anonymous public visits make no session-status request and status failures remain anonymous;
- public pages emit no third-party asset URLs or telemetry code;
- existing signup, login, logout, Account, and password behavior remains unchanged;
- invalid forms return 422 and contain error summary/field associations;
- production routing does not recognize `/design-system`.

## 11.4 Extension unit and integration tests

Add unit coverage for:

- preference strict decoding;
- default values only when absent;
- stable sort tie-breaks;
- grid/list view selection;
- preference repository atomic replacement;
- preference failure falling back for the current session without affecting authoritative state;
- exclusion from Export/Import/synchronization;
- popup state view models;
- sidebar/drawer destinations;
- setup-step gating;
- dashboard/danger-area state mapping.

Browser integration proves the canonical `ui_preferences` store exists in a fresh database and is
absent from all authoritative transaction closures where it does not belong.

## 11.5 Dedicated visual E2E

Add root/package script `test:e2e:design` using the existing real Rails browser-proof topology and
packaged extension. Do not build a disconnected fake site harness.

Commit deterministic Linux screenshot baselines for:

### Rails

- landing desktop;
- landing narrow;
- reduced-motion landing;
- signed-in banner;
- registration-disabled self-host state;
- mobile menu open/focused;
- install selector for Chrome and Firefox;
- expanded privacy detail and FAQ;
- `/privacy`;
- `/security`;
- signup resting and validation error;
- sign-in;
- password change;
- Account;
- development design gallery.

### Popup

- first use;
- local-only ready;
- current page ready;
- capture working;
- capture success;
- locked;
- unsupported URL;
- permission;
- offline/auth-required;
- stale Replica;
- safe failure/retry.

### Library

- empty;
- populated grid;
- compact list;
- each sort choice;
- wide sidebar;
- narrow drawer open;
- Collection history;
- Capture detail;
- Deleted;
- storage relief;
- Vacuum;
- Account/settings dialog;
- loading, error, offline, remote-only, and busy states.

### Synchronization

- each setup step;
- Recovery Phrase reveal and entry;
- dashboard;
- Device list;
- removal warning;
- future protection;
- replacement preflight;
- replacement progress;
- authentication-required and failure/retry.

For every visible interactive control, assert visibility and meaningful dimensions, not only DOM
existence.

## 11.6 Interaction and accessibility scenarios

Prove:

- complete keyboard navigation;
- focus trap and restoration for drawer/dialog;
- Escape/cancel paths;
- mobile navigation;
- no-JavaScript landing, setup links, FAQ, privacy/security, and Account forms;
- Turbo navigation and validation after cache restoration;
- reduced motion has no travel/stagger/loop;
- 200% text zoom and long localized-style strings do not clip;
- no horizontal overflow;
- no remote font/script/image request;
- no telemetry storage;
- live Runtime invalidation still refreshes multiple extension surfaces;
- context change still clears decrypted UI.

## 11.7 Retained verification

Run and record:

```text
corepack pnpm design:check
corepack pnpm exec prettier --check <changed Markdown/YAML/CSS where applicable>
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:e2e:design
corepack pnpm test:e2e:chrome
corepack pnpm test:e2e:cross-browser
docker compose exec -T coordination-server env RAILS_ENV=test bundle exec rspec
docker compose exec -T coordination-server bundle exec rubocop
git diff --check
```

Retain Firefox production Stable/ESR, Firefox Export/Import parity, release-verifier, and production
Rails image checks affected by shared fonts/assets.

## 11.8 Manual visual inspection

Actually view every affected representative screenshot with the available image-inspection tool.
Inspect resting, hover, focus, loading, disabled, success, error, empty, locked, offline,
auth-required, and destructive states at primary and narrow widths.

Record:

- typography and wrapping;
- alignment and spacing cadence;
- hard-shadow consistency;
- control dimensions and focus;
- overflow/clipping;
- color balance and contrast;
- motion final state and reduced-motion equivalence;
- mascot restraint;
- unchanged security prominence.

Automated snapshots without rendered inspection do not complete this plan.

# 12. Cold Implementation Order

The implementer SHALL follow this order.

## Task 1 — Start evidence and freeze baselines

1. Create the Plan 16 TDD evidence document.
2. Run current Rails, extension, and release checks.
3. Capture representative before screenshots for comparison, but do not commit them as product
   assets.
4. Add failing design-contract and route tests.

## Task 2 — Design contract and shared package

1. Add exact licensed dependencies.
2. Create `DESIGN.md`.
3. Create `@awsm/design-system`.
4. Implement deterministic generation/check.
5. Vendor font and notice.
6. Create keeper SVG and generated icon family.
7. Wire Rails and WXT to shared assets.
8. Add the development gallery.
9. Make contract tests GREEN.

## Task 3 — Static Rails site

1. Change root behavior.
2. Add landing, privacy, and security routes/views.
3. Implement complete semantic static content.
4. Add deployment, registration, and authenticated states.
5. Make request/no-JS tests GREEN.

## Task 4 — Hotwire enhancement

1. Remove placeholder controller.
2. Add mobile navigation.
3. Add hero/keeper motion.
4. Add reveal effects and install selector.
5. Add reduced-motion and Turbo lifecycle handling.
6. Make Hotwire E2E GREEN.

## Task 5 — Account surfaces

1. Implement shared split shell.
2. Add error summary and field errors.
3. Restyle signup, login, password, and Account.
4. Prove existing Account/session behavior and narrow layouts.

## Task 6 — Preference persistence

1. Add RED decode/repository/sort tests.
2. Add canonical v1 `ui_preferences` store and strict contract.
3. Add repository and defaults-on-absence behavior.
4. Prove exclusion from authoritative/synchronized/exported state.
5. Recreate all development/test profiles.

## Task 7 — Popup

1. Extract focused state/view modules.
2. Implement minimal ready composition.
3. Redesign every alternate state.
4. Add motion/reduced motion.
5. Update behavior and screenshot evidence.

## Task 8 — Library

1. Extract application-shell and content views.
2. Implement wide sidebar and narrow drawer.
3. Add exact sort and grid/list controls.
4. Apply shared components to every current workflow.
5. Add empty/error/offline/busy presentation.
6. Prove keyboard alternatives and live invalidation.

## Task 9 — Synchronization

1. Extract setup step views.
2. Implement gated stepper.
3. Implement post-enrollment dashboard.
4. Separate security/danger actions without changing ceremonies.
5. Update all recovery/replacement visual evidence.

## Task 10 — Visual lane and inspection

1. Add deterministic screenshots.
2. Add geometry, accessibility, no-remote-asset, and no-telemetry assertions.
3. Inspect actual rendered outputs.
4. Fix every introduced visual/accessibility defect.

## Task 11 — Evergreen reconciliation

1. Update agent guidance.
2. Update README and affected non-plan docs.
3. Add three Roadmap initiatives.
4. Audit non-plan documentation and website copy for stale claims.
5. Leave historical plans intact.

## Task 12 — Final gate

1. Run the complete retained verification matrix.
2. Confirm production build packages font/assets locally.
3. Confirm no generated output, browser profile, test result, secret, or local override is staged.
4. Complete evidence with exact results and inspected screenshot paths.

# 13. Completion Checklist

Plan 16 is complete only when all of the following are true:

- root `DESIGN.md` is normative, linted, and agent-readable;
- Rails and extension consume one shared generated token source;
- licensed font and notices are present;
- keeper/icon family is coherent at every size;
- production does not expose the design gallery;
- Rails root is a public-preview landing page on hosted and self-hosted deployments;
- signed-in users see the shared landing plus a privately enhanced synchronization-focused banner;
- installation is the primary conversion and local-only setup comes first;
- signup appears only in synchronization context when enabled;
- landing claims only implemented behavior;
- abstract diagrams reveal no plaintext at the server boundary;
- privacy/security pages are factual and non-legal;
- Rails pages are complete without JavaScript and enhanced with Hotwire;
- Account flows retain Plan 15 semantics and accessible validation;
- popup ready state is capture-first without losing alternate states;
- Library has the selected responsive sidebar, drawer, sorting, and grid/list presentation;
- preferences are strict, local-only, and excluded from authoritative data;
- sync setup is a guided stepper and enrolled state is a dashboard;
- recovery/destructive warnings retain full prominence and behavior;
- light theme, reduced motion, keyboard, zoom, and narrow layouts pass;
- visual baselines and manual inspection cover every representative surface;
- no telemetry, remote assets, pricing, waitlist, Search, AI, or fake social proof was added;
- agent guidance treats website surfaces as evergreen documentation;
- the three future Roadmap initiatives exist with the selected statuses;
- all affected evergreen documentation describes only the resulting current system; and
- every retained verification command passes.
