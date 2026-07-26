---
version: alpha
name: AWSM Bright Utility Kit
description: A warm, expressive utility system for preserving knowledge without surrendering ownership.
colors:
  primary: "#FF6B57"
  ink: "#18181B"
  cream: "#FFF7E6"
  paper: "#FFFFFF"
  coral: "#FF6B57"
  yellow: "#FFD84D"
  cobalt: "#4E6BFF"
  cobalt-panel: "#91A2FF"
  lavender: "#C8B8FF"
  green: "#2E9B72"
  green-panel: "#98D8BE"
  text-muted: "#56535B"
  link: "#263CBE"
  border-subtle: "#B9B2A7"
  surface-subtle: "#F4EBD8"
  info-pale: "#E8ECFF"
  success-pale: "#E0F4EB"
  warning-pale: "#FFF0B8"
  danger: "#A92E22"
  danger-pale: "#FFE5E0"
  disabled: "#D7D0C3"
  selected: "#E7E0FF"
  focus: "#18181B"
  accent-foreground: "#000000"
typography:
  display:
    fontFamily: '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif'
    fontSize: 4rem
    fontWeight: 750
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  product-heading:
    fontFamily: '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif'
    fontSize: 2.5rem
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.025em"
  section-heading:
    fontFamily: '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif'
    fontSize: 1.75rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0em
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 0.875rem
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0.02em
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace"
    fontSize: 0.9375rem
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0em
rounded:
  compact: 8px
  control: 12px
  expressive: 20px
  full: 999px
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  12: 48px
  16: 64px
  24: 96px
components:
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.3}"
  secondary-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.3}"
  quiet-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.link}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.3}"
  danger-button:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.3}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.compact}"
    height: 44px
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.6}"
  notice:
    backgroundColor: "{colors.info-pale}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.4}"
  dialog:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.expressive}"
    padding: "{spacing.8}"
  sidebar:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    padding: "{spacing.4}"
    width: 256px
  focus:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.focus}"
    rounded: "{rounded.compact}"
  disabled:
    backgroundColor: "{colors.disabled}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
  busy:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  error:
    backgroundColor: "{colors.danger-pale}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.4}"
  success:
    backgroundColor: "{colors.success-pale}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.4}"
  information:
    backgroundColor: "{colors.cobalt-panel}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.control}"
  selection:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.compact}"
  expressive-panel:
    backgroundColor: "{colors.lavender}"
    textColor: "{colors.ink}"
    rounded: "{rounded.expressive}"
    padding: "{spacing.8}"
  expressive-action:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  local-ownership:
    backgroundColor: "{colors.green-panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  subtle-panel:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.6}"
  warning:
    backgroundColor: "{colors.warning-pale}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.4}"
  divider:
    backgroundColor: "{colors.border-subtle}"
    textColor: "{colors.ink}"
    height: 2px
  cobalt-graphic-accent:
    backgroundColor: "{colors.cobalt}"
    rounded: "{rounded.compact}"
  green-graphic-accent:
    backgroundColor: "{colors.green}"
    rounded: "{rounded.compact}"
contrast:
  normalTextMinimum: 4.5
  extendedTextMinimum: 7
  extendedTextComponents:
    - card
    - notice
    - dialog
    - sidebar
    - error
    - success
    - expressive-panel
    - local-ownership
    - subtle-panel
    - warning
  auditedPairs:
    - foreground: ink
      background: cream
      minimum: 7
      use: Default page text
    - foreground: ink
      background: paper
      minimum: 7
      use: Working surfaces
    - foreground: ink
      background: lavender
      minimum: 7
      use: Expressive reading panels
    - foreground: ink
      background: cobalt-panel
      minimum: 7
      use: Informational reading panels
    - foreground: ink
      background: green-panel
      minimum: 7
      use: Ownership and success reading panels
    - foreground: text-muted
      background: cream
      minimum: 7
      use: Muted page text
    - foreground: text-muted
      background: paper
      minimum: 7
      use: Muted working-surface text
    - foreground: ink
      background: coral
      minimum: 4.5
      use: Short action labels
    - foreground: paper
      background: danger
      minimum: 4.5
      use: Short danger-action labels
---

# AWSM Bright Utility Kit

## Overview

AWSM helps web knowledge collectors preserve useful pages in a private archive they control. The
interface should feel warm, capable, optimistic, and direct: a bright utility kit built for real
work, not a generic software dashboard and not a nostalgic scrapbook.

Use a typography-led brand mode for public storytelling and a calmer, denser workspace mode for
the extension. The unnamed archive-box keeper is a supporting mark, never a character that competes
with a task. Product claims must describe shipped behavior. Local-only use comes first; optional
encrypted synchronization follows.

## Colors

Cream is the default canvas, paper is the working surface, and ink is the default foreground,
outline, and hard shadow. Saturated accents are deliberate blocks, not decoration sprinkled over
every component.

- Coral drives the primary conversion and expressive actions.
- Yellow marks preservation, focus, progress, and the keeper bookmark.
- Cobalt explains technical or informational concepts.
- Lavender supports secondary expressive panels and selection.
- Green marks local ownership and success.
- Cobalt-panel and green-panel are the text-bearing counterparts to the stronger graphic accents.
- Pale semantic surfaces always pair state color with text or an icon.

Ink is the default foreground on bright accents. White text is permitted only where an audited
semantic token explicitly provides sufficient contrast. Never communicate state through color
alone. Do not invent local hex values: change this contract and regenerate shared output.

WCAG 2.2 contrast is the measurable floor. Normal-sized text and control labels require at least
`4.5:1`. Paragraphs, explanatory copy, repeated metadata, notices, dialogs, sidebars, and other
extended-reading surfaces require at least `7:1`. Large display text may legally use `3:1`, but
AWSM does not use that exception to justify a text-bearing component below `4.5:1`. Raw cobalt and
green are graphic accents only; use their audited panel variants behind text.

## Typography

Bricolage Grotesque is self-hosted and used only for marketing display, product headings, and
expressive section headings. Body copy, controls, forms, Library metadata, and dense settings use
the native system sans stack. Recovery Phrases, identifiers, checksums, and deliberately technical
values use the native monospace stack.

Display type may wrap dramatically but must remain readable at 200% zoom. Working-product type
prioritizes stable rhythm and scanability. Use sentence case. Reserve uppercase for the compact
AWSM wordmark and short eyebrow labels.

## Layout

Use only the `4, 8, 12, 16, 24, 32, 48, 64, 96px` spacing scale. Public sections use generous
vertical rhythm and a readable content measure; workspace surfaces use the same scale at denser
steps. Supported responsive thresholds are 480px, 768px, and 1024px, but components respond to
their available width instead of assuming a fixed desktop canvas.

The source order, reading order, and focus order remain linear. At narrow widths, sidebars become
drawers, split account layouts collapse to one column, and action groups wrap rather than clip.
Every interactive target is at least 44px by 44px.

## Elevation & Depth

The signature expressive elevation is a `2px` ink outline with a `4px 4px 0` ink hard shadow.
Primary brand cards and buttons use no blurred shadow. Repeated workspace rows use an outline,
divider, or no elevation so dense content does not become a wall of floating cards.

Pressed expressive controls translate by `2px` and reduce their hard shadow. Dialogs may use a
quiet backdrop, but the dialog itself retains the same outline language.

## Shapes

Use 8px radii for compact controls, 12px for ordinary controls and working cards, and 20px for
expressive panels. The 999px radius is limited to pills, compact badges, and circular controls.
Avoid excessive capsules and avoid mixing unrelated corner systems.

Graphics are crisp, flat, code-native vectors. Do not add grain, paper texture, halftones,
photorealism, faces, arms, or legs to the keeper.

## Components

Buttons, links, fields, notices, cards, dialogs, navigation, badges, progress, and empty states come
from `@awsm/design-system`. Application styles may compose these primitives but may not redefine
their palette, spacing rhythm, radii, shadows, or motion curves.

All controls define resting, hover, active, focus-visible, disabled, busy, error, and success
states where applicable. Focus uses a visible 3px ink outline with a yellow offset. Disabled
controls retain readable text and never rely on opacity alone. Busy controls preserve their width
and accessible name.

Motion uses immediate press feedback, ordinary component transitions, expressive reveals, and a
long hero composition. Motion may tilt, squash, open, close, and move the keeper bookmark, but may
not scroll-jack, replace the cursor, delay reading, or block input. Reduced motion removes travel,
rotation, scale, stagger, parallax, and loops and displays the final state immediately.

The keeper appears in branding, onboarding, empty, capture progress and success, offline, and
recovery moments. It is not repeated on every Capture card and is not a persistent companion.
Decorative instances are hidden from assistive technology. Meaningful instances have adjacent
visible status text.

Copy is warm and direct. Recovery, security, warning, and destructive-action copy is literal and
unambiguous. Never conflate an Account password with a Vault password or Recovery Phrase.

## Do's and Don'ts

Do:

- lead with preservation and prove it with privacy and ownership;
- keep local-only operation prominent before optional synchronization;
- use real semantic HTML and complete no-JavaScript content on Rails;
- show best-effort capture representations as conditional;
- keep the Coordination Server side of diagrams opaque and free of readable Vault content;
- make focus, errors, loading, offline, success, and destructive states visible; and
- update public product pages whenever shipped behavior changes.

Don't:

- invent unimplemented Search, AI, pricing, browser-store, telemetry, or social-proof claims;
- imply that signing into an Account unlocks or decrypts a Vault;
- use remote fonts, scripts, images, trackers, or third-party marketing assets;
- use the display face for dense application data;
- repeat the keeper until it becomes visual noise; or
- preserve superseded pre-release presentation contracts.
