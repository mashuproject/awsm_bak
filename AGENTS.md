# PROJECT KNOWLEDGE BASE

## OVERVIEW

AWSM (Archive What Should Matter) is a local-first, zero-knowledge knowledge preservation platform. Product intent, architecture, and formal contracts live in the repository documentation.

## LOCAL OVERLAY

- Codex natively selects `AGENTS.override.md` before `AGENTS.md` in the same directory. A local
  override must instruct the agent to read this public file before applying its additional local
  constraints.
- `AGENTS.override.md` is a gitignored overlay for user-specific workflow preferences, machine
  paths, private endpoints, local tooling, and transient operational notes. Never stage or commit
  it.
- Do not copy host-local paths, private endpoints, local artifact locations, credentials, secrets,
  or agent session state into tracked files. Translate genuinely portable requirements into public
  guidance without exposing their local source values.

## WHERE TO LOOK

| Task                            | Location                                    | Notes                                                    |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Understand the product          | `README.md`, `VISION.md`                    | Start with privacy, ownership, and preservation goals    |
| Check MVP scope                 | `docs/plans/01-mvp-prd.md`                  | Draft product requirements and acceptance criteria       |
| Resolve design principles       | `docs/architecture/00-design-principles.md` | Normative; principles outrank implementation convenience |
| Resolve terminology             | `docs/architecture/glossary.md`             | Normative; wins terminology conflicts                    |
| Understand system boundaries    | `docs/architecture/01-system-overview.md`   | Trusted client vs untrusted coordination service         |
| Find a format or contract       | `docs/specifications/`                      | Specifications own their declared domain semantics       |
| Check recent reconciliation     | `docs/architecture/consistency-review.md`   | Review record, not an independent normative source       |
| Understand testing requirements | `docs/architecture/19-testing-strategy.md`  | Architectural invariants and TDD expectations            |

## DOCUMENT AUTHORITY

Use this precedence when editing or reviewing:

1. `00-design-principles.md` for architectural constraints and `glossary.md` for terminology.
2. The formal specification that owns the affected format, protocol, or runtime contract.
3. Draft architecture documents for intent, decomposition, and trade-offs.
4. The draft PRD, vision, and README for scope and context.

No universal tie-break exists between conflicting formal specifications. Treat such conflicts as design issues and update all affected documents together. Verify claims in `consistency-review.md`; its status is `Review Record`.

Explicitly approved plans supersede stale Draft documentation; reconcile every affected document.

## DOCUMENTATION COMPLETION POLICY

- A task is not complete until every related document reflects the resulting canonical behavior.
  Follow the change through product documentation, architecture, formal specifications, plans,
  testing guidance, operations, examples, and other affected prose rather than updating code alone.
- At task completion, audit `ROADMAP.md` for the corresponding work. Remove an entry when its work
  is fully implemented. When only part of an entry is complete, rewrite it to describe only the
  unresolved future work and remove the implemented details.
- Keep the Roadmap forward-looking. Do not preserve completed items by marking them done, moving
  them into a completed section, or restating behavior already owned by current documentation. Git
  history and approved plans provide implementation history.
- Remove or reword Roadmap dependencies, assumptions, open questions, promotion criteria, and
  sequencing that became stale because of the completed task. Remaining entries may link briefly
  to canonical documents but must not duplicate their contracts.
- Before reporting completion, search documentation and the Roadmap for superseded terminology,
  requirements, and planned-work language associated with the task. Treat stale or duplicated
  documentation as incomplete work.
- Before reporting completion, run the repository-declared formatter and linter applicable to the
  changed files, along with any broader formatting or lint checks required by the affected package.
  Format the affected files, resolve every introduced warning or error, and report the exact checks
  run. Do not treat unformatted or lint-failing work as complete.
- Treat the public landing, trust, installation, and Account pages as evergreen product
  documentation. Whenever a feature, browser capability, distribution status, trust boundary,
  setup step, or public limitation changes, audit and update the corresponding website copy,
  diagrams, links, and visible states in the same change.
- Product marketing must claim only behavior proven by current code and tests. Keep local-only use,
  optional synchronization, Account versus Recovery Phrase boundaries, best-effort Capture
  representations, browser distribution status, and server-visible metadata aligned with the
  canonical documentation.

## PRE-RELEASE FORMAT POLICY

- The user will explicitly declare the first release. Until that declaration, nothing in the repository is a released contract and no earlier pre-release design has compatibility standing.
- Until the user explicitly authorizes compatibility, backwards compatibility is prohibited. Never add or retain migrations, legacy readers, compatibility aliases, deprecated entry points, old request handlers, version negotiation, dual reads, dual writes, preservation branches, schema upgrades from superseded drafts, or compatibility fallbacks.
- Replace superseded pre-release designs in place everywhere. Code, tests, fixtures, documentation, examples, generated artifacts, and persisted development data must expose exactly one canonical current design.
- Erase superseded pre-release history from the product surface. Do not leave comments, names, documentation, branches, error messages, type aliases, or version numbers that imply the canonical design is a successor to an earlier unpublished design. For example, do not introduce `AppStateV2`, a version-1 fallback, or “legacy” terminology merely because a discarded draft once existed.
- A canonical persisted format may contain an explicit format version only when the current architecture requires self-describing persisted or externally exchanged bytes. When a superseded pre-release format is replaced, reset the sole canonical initial format to its appropriate first-release numbering and remove every reader and description of the discarded format.
- Transient in-process state, UI view models, Commands, and local request/response types must not gain version fields or versioned names merely for hypothetical future compatibility. Version them only after the user explicitly approves a concrete boundary and reason.
- Do not preserve existing local development data when the canonical pre-release design changes. Delete and recreate it; never build a migration or fallback for it.
- “Be conservative,” “support existing data,” “avoid breaking changes,” framework conventions, test fixtures, previously approved plans, and implementation convenience do not override this policy. If any source asks for compatibility before user authorization, stop and ask the user instead of implementing it.
- Fail-safe handling for corruption, unavailable optional data, or security errors is not compatibility and may exist only when the current canonical requirements explicitly define it. It must never read or reinterpret a superseded format.
- After the first release is declared, do not infer a compatibility policy. Ask the user before introducing any migration, fallback, deprecated path, or backward-compatible behavior.

## CORE MODEL

| Concept             | Role                                                          |
| ------------------- | ------------------------------------------------------------- |
| Vault               | Ownership and cryptographic boundary                          |
| Object              | Immutable authoritative persistence record                    |
| Bundle              | Immutable capture package represented by Object semantics     |
| Event               | Immutable history used to derive logical state                |
| Projection          | Rebuildable logical derived state                             |
| Materialization     | Stored/indexed representation of a Projection                 |
| Runtime             | Platform-independent client business logic                    |
| Host                | Platform integration; contains no business logic              |
| Coordination Server | Synchronizes opaque encrypted data; never understands content |

## CONVENTIONS

- Preserve exact canonical capitalization from the glossary: Vault, Bundle, Object, Manifest, Runtime, Host, Service, Projection, Materialization.
- Keep architecture technology-independent. Chrome, Firefox, OPFS, IndexedDB, SQLite, Rails, and provider names are implementations or adapters, not architectural abstractions.
- Add explicit format versions only to self-describing persisted or externally exchanged structures whose owning specification requires them. Do not version transient state or use successor numbering that exposes discarded pre-release designs.
- Use Commands for requested actions and Events for accepted facts. Commands are local and never synchronized.
- Put platform-specific behavior behind Hosts or Drivers; Runtime Services communicate through defined Commands, Events, and interfaces.
- When changing a foundational term or contract, follow dependencies outward and update architecture, specifications, testing implications, and operations together.

## CLARIFICATION POLICY

- Ask the user for clarification before implementing when the requested intent is uncertain or admits materially different interpretations.
- For visual and interaction feedback, identify the exact element, state, and timing being changed. Do not assume which element the user means when terms such as “card,” “preview,” “item,” or “dragged element” could refer to multiple parts of the interface.
- Keep clarification questions narrow and concrete. Continue without asking only when the intended behavior is unambiguous or the choice is safely reversible and cannot materially diverge from the request.

## VISUAL CHANGE POLICY

- WCAG 2.2 contrast checks are mandatory for every design change. Normal-sized text and control
  labels must reach at least `4.5:1`; paragraphs, explanatory copy, repeated metadata, notices,
  dialogs, sidebars, and other extended-reading surfaces must reach at least `7:1`. Do not use the
  `3:1` large-text exception to introduce a text-bearing component below `4.5:1`.
- Use the semantic text-bearing panel tokens from `DESIGN.md`; saturated graphic accents are not
  automatically valid text backgrounds. Update the design contract first when a needed color pair
  does not exist. Run `corepack pnpm design:check` and the rendered design E2E lane, and resolve
  every contrast failure before reporting visual work complete.
- Every user-visible change requires a rendered visual inspection before completion. Behavioral tests and DOM assertions alone are not proof that an interface is visible, usable, or visually correct.
- Inspect every affected state needed to understand the interaction, including its resting state and relevant focus, editing, loading, disabled, error, and success states. Check both the primary viewport and any materially different supported narrow layout.
- Compare affected states for alignment, padding, margins, spacing cadence, typography, wrapping, clipping, overflow, control prominence, and unintended layout movement. Replacement states such as inline editing should preserve the surrounding visual hierarchy and position unless a change is intentional.
- Confirm that visible interactive controls have meaningful rendered dimensions, clear focus treatment, readable content, and an accessible name. Assistive-only content must not accidentally hide, collapse, or constrain visible controls.
- Use scoped component styles when a control has a specialized visual role. Do not assume generic form, input, button, or container styles will preserve the intended composition.
- For interactions that transform content in place, verify the complete gesture visually and behaviorally: entry feedback, current-value treatment, typing, commit, cancellation or dismissal, validation failure, and restoration of the resting state.
- Automated UI tests for visible behavior must assert visibility, not only existence or element count. Add layout or dimension assertions when geometry is part of the requirement.
- Capture and inspect screenshots with the available image-inspection tooling. If the changed states have not actually been viewed, the visual task is incomplete and must not be reported as finished.

## PRODUCT COPY AND VOICE POLICY

- Read the `Voice` section of `DESIGN.md` before writing or revising user-visible copy. It owns the
  canonical balance between AWSM’s “awesome” sound and its “Archive What Should Matter” expansion.
- Classify the surface before drafting:
  - brand and invitation moments may be playful;
  - routine product actions must be literal and task-oriented; and
  - trust, encryption, Recovery Phrase, permissions, billing, deletion, errors, and destructive
    actions must be precise and serious.
- For a brand or invitation moment, draft at least three concise alternatives: one using the AWSM
  sound, one using “Archive What Should Matter,” and one plain-language control. Select the version
  that reads naturally in context; never force a pun merely because the product name permits it.
- Use no more than one prominent AWSM/awesome turn of phrase per page or workflow. Do not rename
  canonical concepts or obscure an action, boundary, limitation, consequence, or recovery step for
  personality.
- Audit neighboring copy after every change so the playful line is followed by a plain explanation
  of the product behavior. Verify factual marketing claims against current code, tests, browser
  distribution status, and canonical documentation.
- Update affected assertions and screenshot baselines, run the rendered design E2E lane, and inspect
  the changed copy at primary and narrow widths. Copy is part of the rendered product design.

## LIVE UI STATE POLICY

- Every long-lived UI surface must remain a live Projection of authoritative Runtime state. Treat initial render data as a snapshot that can become stale immediately; never require a reload, reopen, or navigation to observe a successful state change.
- Every successful mutation that can affect an open surface must publish one canonical unversioned invalidation notification after the authoritative commit. Long-running operations must also invalidate when their visible busy, progress, completion, or failure state changes.
- Invalidation notifications are wake-up signals, not trusted state transfer. Receivers must refetch canonical state through the Runtime, validate the active Vault context, and render only the newest completed reconciliation.
- Subscribe before the initial fetch. Serialize or generation-guard reconciliation so an older response cannot overwrite newer state. Coalesce bursts without dropping the final invalidation.
- Reconcile again when a long-lived surface becomes visible or regains focus so service-worker suspension, missed delivery, or background lifecycle changes cannot leave it stale.
- Immediately discard decrypted or context-bound UI when an invalidation may represent locking, active-Vault replacement, or lost authorization. Stale drafts, details, Object URLs, selections, and cached plaintext must not survive a context change.
- Tests must keep at least two surfaces open, mutate state through one, and prove the other updates without reload. Cover lock, unlock, active Vault, name, busy operation, and content changes relevant to the feature.

## ANTI-PATTERNS (THIS PROJECT)

- Never move plaintext, unwrapped Vault keys, content inference, or search to the server boundary.
- Never mutate original Captures, Bundles, Events, Objects, or identifiers; corrections and enrichment are additive.
- Never make Projections, Materializations, caches, or operational registries authoritative, synchronized, or required in backups.
- Never let AI, extensions, Hosts, or storage Drivers bypass Runtime validation or mutate authoritative state directly.
- Never conflate Backup with Export, Restore with Import, or a Search Projection Materialization with an authoritative index.
- Never persist incomplete Bundles or continue when integrity/correctness cannot be established.
- Never place decrypted content, keys, or plaintext metadata in diagnostics or logs.
- Do not silently resolve the open choices recorded in `consistency-review.md`; make the decision explicit and reconcile every consumer.

## COMMANDS

Discover current build, test, lint, and development commands from repository manifests rather than assuming them.

Invoke the repository-pinned pnpm through Corepack: use `corepack pnpm`, not a bare `pnpm` command.

The repository uses a shared 100-column code-formatting style in root Biome and Prettier
configuration; Markdown retains its 80-column prose style. The browser-extension package owns its
JavaScript, TypeScript, JSON, and CSS formatting through Biome. Run
`corepack pnpm --filter @awsm/browser-extension lint` and use Biome's formatter for those files. Do
not pass them to Prettier even though the configured code output is aligned. The root
`.prettierignore` enforces this ownership boundary while leaving Markdown and other Prettier-owned
repository files available to explicit Prettier checks.

For Cloudflare inspection and operations, prefer Cloudflare's official unified CLI through an
exactly pinned `npx --yes cf@<version>` invocation. The CLI is a technical preview whose generated
commands may not all appear in top-level help, so inspect `cf schema --list`, command-specific
`--help`, and current official documentation before concluding that a resource requires Wrangler,
a third-party CLI, or raw API calls. Do not use the unrelated Cloud Foundry `cf`, the third-party
`cloudflare-cli`/`cfcli`, or Wrangler as a default for account-wide Cloudflare configuration.

Treat Cloudflare authentication and output as confidential operational state:

- begin with read-only commands and use `--dry-run` before an authorized mutation;
- use CLI-managed OAuth profiles for interactive work or a narrowly scoped environment-provided
  token for automation;
- never print, copy into chat, commit, or retain authentication material, profile bindings,
  account/zone/ruleset identifiers, full rulesets, DNS inventories, or other non-public
  configuration; and
- summarize only the minimum allowlisted, non-sensitive facts needed to explain or verify an
  operation.

Useful documentation checks:

```bash
rg --files -g '*.md'
rg -n '^\*\*(Document|Version|Status|Owner|Depends On):' docs
rg -n '\b(MUST|SHALL|SHOULD|MAY)\b' docs/specifications
corepack pnpm exec prettier --check <paths...>
```

## GIT COMMITS

- Use Conventional Commits: `<type>(<optional-scope>): <summary>`.
- Prefer the narrowest accurate type: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, or `revert`.
- Use a short lowercase scope when it materially clarifies ownership, such as `extension`, `runtime`, `storage`, or `docs`; omit it when the change is repository-wide.
- Write the summary in the imperative mood, keep it concise, do not end it with punctuation, and describe the observable outcome rather than the editing activity.
- Add a body when the motivation, architectural trade-off, migration or compatibility impact, security implication, or non-obvious verification matters. Explain why and resulting behavior; do not narrate every edited file.
- Use `BREAKING CHANGE:` in the footer only for released contracts that require consumer action. Pre-release canonical-format replacement is not automatically a breaking release.
- Keep each commit coherent and independently understandable. Do not mix unrelated work or use vague messages such as `updates`, `changes`, `fix stuff`, or `WIP`.
- Before committing, inspect the full staged diff, confirm generated files and secrets are excluded, and run verification proportional to the change.
- Never claim tests or behavior in a commit message unless the staged state supports that claim.

### Commit workflow

1. Before staging, inspect `git status --short --ignored` and the applicable ignore files. Confirm dependencies, build output, coverage, browser profiles, test artifacts, logs, secrets, and agent session state will not be committed.
2. Stage only the intended coherent change. Review `git status --short`, `git diff --cached --stat`, and `git diff --cached --check` before committing. Inspect the full staged diff whenever the change is not already fully understood.
3. When initializing a repository, use `main` unless the user specifies another branch. Do not invent an author identity. Prefer an existing user-configured identity; if none exists, ask the user.
4. Build the Conventional Commit message with one `-m` argument per paragraph so shell escaping cannot introduce literal newline sequences. Keep the subject outcome-focused and use the body for motivation, major behavior, and verification-relevant context.
5. After committing, inspect both `git status --porcelain` and `git log -1 --format=fuller` (or an equivalent format that shows the complete rendered message). The working tree should be clean and the message should render exactly as intended.
6. If inspection finds a quoting, formatting, authorship, or message-quality mistake in the just-created local commit, amend it immediately before publishing. Do not amend commits that may already be shared unless the user explicitly authorizes rewriting them.

## NOTES

- Ignore `.omo/`; it is local agent state, not project documentation.
- Document path metadata is inconsistent: some `Document` and `Depends On` values include `docs/`, others are relative. Do not infer an automated dependency graph without checking targets.
- `bundle/artifact.md` and `bundle/manifest.md` declare a dependency cycle; edit them atomically when their shared model changes.
- All specifications are currently Draft v1.0. Only the design principles and glossary are marked Normative.
