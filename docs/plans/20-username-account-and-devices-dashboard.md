# Username Account and Devices Dashboard

**Document:** `docs/plans/20-username-account-and-devices-dashboard.md`

**Status:** Approved implementation plan

**Owner:** Engineering

**Target Release:** `0.2.0`

**Last Updated:** 2026-07-27

**Depends On:** `AGENTS.md`, `DESIGN.md`, `README.md`, `ROADMAP.md`,
`docs/architecture/01-system-overview.md`, `docs/architecture/03-zero-knowledge.md`,
`docs/architecture/04-security-model.md`, `docs/architecture/08-synchronization.md`,
`docs/architecture/15-coordination-server.md`, `docs/architecture/19-testing-strategy.md`,
`docs/architecture/20-deployment-and-operations.md`,
`docs/specifications/protocol/http-api.openapi.yaml`,
`docs/specifications/protocol/messages.md`, `docs/specifications/runtime/runtime.md`,
`docs/plans/15-rails-account-recovery-phrase-device-sync.md`,
`docs/plans/16-product-design-system-landing-and-surface-redesign.md`,
`docs/plans/17-cdn-cached-public-rails-pages.md`,
`docs/plans/19-two-phase-firefox-signing-and-distribution.md`, and
`.codex/skills/release-browser-extension/SKILL.md`

---

# 1. Purpose

This is the decision-complete implementation plan for AWSM `0.2.0`. It is written for an
implementer starting from a cold checkout with no access to the planning conversation. Do not
reopen the product, compatibility, identity, recovery, retention, web-Host, or release decisions
fixed here.

Release `0.2.0` SHALL:

1. replace Account email addresses completely with private, permanent usernames;
2. collect, store, transmit, and render no Account email address;
3. add one responsive website dashboard for Account, Device, browser-session, security, retention,
   and deletion management;
4. keep all Vault content and Vault mutations in trusted extension Hosts rather than creating a
   website Host or a second Vault Replica;
5. let an extension detach a complete local Vault from an unavailable synchronization Account
   without contacting the abandoned server;
6. make detached local Vault authority attachable to another Account/server without changing the
   Vault identity or losing historical decryption keys;
7. permanently delete Accounts on explicit request or after a configurable period of inactivity;
8. provide no password reset, Account recovery, email notification, compatibility reader, data
   conversion, or legacy protocol path;
9. release the complete result as `0.2.0` through the existing two-phase browser-extension release
   process; and
10. deploy the exact verified tag to an isolated, destructively reset reference staging
    environment only after re-proving the live deployment boundary.

Before production code changes, create
`docs/plans/20-username-account-and-devices-dashboard-tdd-evidence.md`. Record every required RED,
GREEN, refactor, rendered inspection, release gate, and staging proof there as work proceeds.

# 2. Governing Decisions

## 2.1 Fixed product decisions

| Concern                 | Canonical `0.2.0` decision                                  |
| ----------------------- | ----------------------------------------------------------- |
| Login identifier        | Private username only                                       |
| Email                   | Never collected, accepted, stored, rendered, or used        |
| Username case           | Trimmed, ASCII-lowercased canonical form                    |
| Username mutability     | Permanent; no edit interface or route                       |
| Password reset          | None                                                        |
| Account recovery        | None                                                        |
| Vault recovery          | Existing Recovery Phrase remains Vault-only authority       |
| Website role            | Account-management site, not a trusted Vault Host           |
| Website Vault storage   | No Vault content, decrypted metadata, or additional Replica |
| Dashboard layout        | One responsive `/account` page                              |
| Website Device controls | Read-only Device facts; removal remains extension-owned     |
| Website sessions        | Browser sessions only; API sessions are never listed        |
| Session telemetry       | Coarse browser family and timestamps only                   |
| IP/raw user agent       | Not persisted in Account session records                    |
| Manual deletion         | Password plus typed username; no Export gate                |
| Inactivity retention    | Server-configurable; reference default 365 days             |
| Activity                | Any successful authenticated browser or API use             |
| Activity write rate     | At most once per Account/session per 24 hours               |
| Inactivity deletion     | Permanent, no grace recovery, no email                      |
| Local detachment        | Available offline and without valid Account credentials     |
| Same-server reuse       | Only after old Account deletion releases the Vault ID       |
| Compatibility           | None                                                        |
| Target release          | `0.2.0`                                                     |

## 2.2 Compatibility prohibition

There are no users or stored data that require preservation. Implement exactly one current design.

The implementation SHALL NOT add or retain:

- email columns, parameters, response fields, form fields, fixtures, aliases, or documentation;
- readers for the pre-`0.2.0` Account shape;
- dual username/email authentication;
- schema conversion or backfill code;
- old IndexedDB record decoders;
- protocol field aliases or negotiation;
- feature flags for the old behavior;
- importers for old Account/session state;
- deprecated methods kept only for callers that no longer exist; or
- tests asserting that obsolete data continues to work.

Use the repository's normal Rails migration and schema tooling to define the clean canonical
database. Update the sole coordination-schema migration in place, regenerate `db/schema.rb`, and
create clean development/test/staging databases from that migration. Do not add a migration whose
only purpose is to transform or preserve the experimental email schema.

Existing format names that remain semantically current may retain their `V1` suffix. A suffix is a
format identifier, not permission to keep an old decoder or invent a successor. Do not create a
`V2` merely because this release is `0.2.0`.

## 2.3 In scope

This plan owns:

- the Rails Account and BrowserSession schema;
- Account lifecycle and asynchronous deletion persistence;
- username signup, authentication, session status, and extension API contracts;
- inactivity policy, activity tracking, dispatch, and deletion;
- the complete `/account` dashboard and its browser-session actions;
- website-safe Device projection;
- Account password and deletion ceremonies;
- extension username surfaces and stored Account metadata;
- local synchronization-server detachment;
- complete-key-epoch attachment needed for detached Vaults;
- affected Runtime, HTTP, OpenAPI, IndexedDB, UI, E2E, and proof contracts;
- privacy, security, glossary, installation, architecture, Roadmap, and public-product copy;
- release `0.2.0`; and
- an exact-tag rollout to the isolated reference staging environment.

## 2.4 Explicitly out of scope

Do not implement or imply:

- a website Vault Host;
- browser-to-website Vault sharing;
- website Capture, Library, Search, Import, Export, recovery, or synchronization;
- a second server-side Vault Replica;
- public profiles or username-addressed URLs;
- username changes;
- email, password reset, magic links, notifications, invitations, or contact discovery;
- passkeys, WebAuthn, OAuth, SSO, billing, teams, or administrator impersonation;
- Account recovery through a Recovery Phrase;
- deletion grace periods, undelete, retained recovery snapshots, or support intervention;
- website Device removal or future-protection actions;
- API-session display or per-API-session management on the website;
- Device `last seen`, IP address, geographic location, raw user agent, or fingerprinting;
- Vault cloning, Vault-ID rewriting, or re-encryption as a detachment shortcut;
- production deployment or production state changes;
- upstream-repository changes while its freeze remains active; or
- new third-party strong-copyleft source or dependencies.

The existing **Zero-Knowledge Web Host** Roadmap item remains a separate future initiative. This
dashboard does not complete, narrow, or substantively implement it.

# 3. Current-State Evidence and Required Reinspection

The implementer SHALL verify these facts against the checkout before editing. They describe the
repository inspected while this plan was authored, not timeless assumptions:

- `apps/coordination-server/db/migrate/20260719000000_create_coordination_schema.rb` is the sole
  application-schema migration.
- `accounts.email` is the current login identifier.
- `browser_sessions` currently persists `ip_address` and `user_agent`.
- `apps/coordination-server/app/views/accounts/show.html.erb` is a minimal Account page.
- `Authentication` currently creates raw-user-agent/IP browser-session records.
- public session status and API Account payloads currently emit `email`.
- the extension currently carries `email` through Account HTTP, Runtime, IndexedDB, UI, and tests.
- the extension already owns Device management; Account-scoped website authority must not cross
  that security boundary.
- synchronized Objects are encrypted under Vault key epochs, so preserving only a local Vault Root
  Key is insufficient to detach a synchronized Vault.
- the extension already stores a protected Device identity, wrapping key, complete local epoch-key
  set, recovery authority, and synchronization state in IndexedDB.
- a Vault ID is globally unique in `vault_replicas`, preventing attachment of the same Vault to a
  second Account on the same server until the first Replica is deleted.

Before any remote operation, re-inspect the live reference environment and record evidence in the
TDD record. Repository plans and prior observations are not proof of current container names,
routes, volumes, process boundaries, databases, storage paths, revisions, or isolation. Inspection
is read-only until the rollout step explicitly authorizes a staging mutation. Never infer anything
about production from staging or from their presence on the same host.

# 4. Canonical Domain Model and Persistence

## 4.1 Account

Define `accounts` as:

```text
id                uuid primary key
username          string, non-null
password_digest   string, non-null
state             string, non-null, default "Active"
last_activity_at  timestamp, non-null
created_at        timestamp, non-null
updated_at        timestamp, non-null
```

Database invariants:

- unique B-tree index on `username`;
- `username = lower(username)`;
- `char_length(username) BETWEEN 3 AND 32`;
- `username ~ '^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$'`;
- `state IN ('Active', 'Deleting')`; and
- `last_activity_at >= created_at` is not required because database/application clock corrections
  can invalidate that relationship.

Application normalization and validation:

1. require a string;
2. trim leading/trailing ASCII whitespace;
3. lowercase using ASCII semantics;
4. require 3–32 characters;
5. require a letter or digit at the first and last position;
6. allow only lowercase ASCII letters, digits, hyphens, and underscores internally; and
7. validate normalized uniqueness while relying on the database constraint for races.

Examples:

```text
Accepted input        Stored value
"  Quiet_Vault  "     "quiet_vault"
"archive-7"           "archive-7"

Rejected
"ab"
"-archive"
"archive-"
"a..b"
"álbum"
```

Do not add a display name. Do not use username as a public identifier. `id` remains the stable
protocol Account ID.

`Account#active?` is true only for `state == "Active"`. Every authentication and Account-owned
mutation path SHALL require that predicate inside the relevant locked transaction, not only at
controller entry.

## 4.2 BrowserSession

Define `browser_sessions` as:

```text
id                uuid primary key
account_id        uuid, non-null, foreign key
client_family     string, non-null
last_activity_at  timestamp, non-null
created_at        timestamp, non-null
updated_at        timestamp, non-null
```

Database invariants:

- `client_family IN ('Chrome', 'Firefox', 'Other')`; and
- index on `[account_id, last_activity_at]`.

Do not persist IP address, raw user agent, platform, operating-system version, device model,
geolocation, or a user-agent hash. Classify the incoming user agent once at successful sign-in:

1. Firefox tokens map to `Firefox`;
2. Chromium/Chrome-family tokens map to `Chrome`; and
3. everything else maps to `Other`.

The classifier is deliberately coarse and fully unit-tested. It is not an authentication signal.
Delete BrowserSession rows when sessions are revoked; do not retain tombstones.

## 4.3 API sessions

Keep the current Account/VaultDevice scope distinction. API sessions remain operational
credentials and are not dashboard rows. Password change and Account deletion continue to revoke
all BrowserSession and ApiSession authority.

Do not add client telemetry to `api_sessions`. Account activity comes from successful authenticated
API requests, not a separate last-seen field on every API credential.

## 4.4 AccountDeletionJob

Add `account_deletion_jobs`:

```text
id                  uuid primary key
account_id          uuid, nullable, foreign key with ON DELETE SET NULL
reason              string, non-null
state               string, non-null
stage               string, non-null
total_bytes         bigint, non-null, default 0
processed_bytes     bigint, non-null, default 0
retry_count         integer, non-null, default 0
error_outcome       string, nullable
receipt_digest      binary, nullable
started_at          timestamp, nullable
completed_at        timestamp, nullable
receipt_expires_at  timestamp, nullable
created_at          timestamp, non-null
updated_at          timestamp, non-null
```

Database invariants:

- one non-succeeded deletion job per non-null `account_id`, enforced by a partial unique index;
- `reason IN ('Manual', 'Inactivity')`;
- `state IN ('Pending', 'Running', 'FailedRetryable', 'Succeeded')`;
- `stage IN ('Freeze', 'DeleteOpaqueBytes', 'DeleteRelationalState', 'Complete')`;
- `total_bytes >= 0`;
- `processed_bytes >= 0 AND processed_bytes <= total_bytes`;
- `retry_count >= 0`;
- `receipt_digest IS NULL OR octet_length(receipt_digest) = 32`;
- manual jobs have a digest until their successful receipt expires;
- inactivity jobs never have a receipt digest; and
- succeeded jobs have `stage = 'Complete'`, a non-null `completed_at`, and null `account_id`.

Store no username, Vault ID, Device ID, storage key, object digest, error backtrace, raw exception,
or user content in this table. `error_outcome` is a fixed non-identifying enum. Initially support:

```text
STORAGE_UNAVAILABLE
DELETE_VERIFICATION_FAILED
INTERNAL_RETRY
```

Unexpected exceptions are logged through the existing confidential operational boundary with
identifiers redacted and persisted only as `INTERNAL_RETRY`.

The job row is the durable retry and progress record. Solid Queue may deliver the worker more than
once; application correctness must not depend on exactly-once queue delivery.

## 4.5 Canonical Rails migration

Modify the sole canonical migration with normal Rails migration APIs:

- replace `accounts.email` with the Account fields above;
- replace BrowserSession IP/user-agent fields with the fields above;
- add `account_deletion_jobs`;
- add every constraint and index named explicitly;
- add the deletion-job/account foreign key with `ON DELETE SET NULL`; and
- leave unrelated coordination tables semantically unchanged except where complete-key-epoch
  attachment needs an existing constraint generalized.

Then:

1. recreate the development and test application databases;
2. run `bin/rails db:migrate`;
3. regenerate `apps/coordination-server/db/schema.rb`;
4. compare migration output with the intended schema; and
5. prove a clean database can be created from zero without seeds, conversion, or hand-written SQL
   outside the migration.

# 5. Username Authentication and Account Contracts

## 5.1 Signup and website sign-in

Replace website `email` parameters with `username`.

Signup:

- GET `/sign_up` renders `username`, `password`, and password confirmation.
- POST `/sign_up` accepts only those fields.
- Unknown fields, including `email`, are ignored by strong parameters and covered by tests proving
  they do not influence identity.
- On success, create the Account with `last_activity_at = now`, create the BrowserSession, sign it
  in, and redirect to `/account`.

Sign-in:

- GET `/sign_in` renders `username` and password.
- POST `/sign_in` normalizes username exactly once and authenticates it.
- Duplicate/unknown/invalid/password-failure outcomes use one generic response.
- The unknown-username path performs the existing dummy-bcrypt comparison.
- A `Deleting` Account is indistinguishable from an unknown Account.

Use `autocomplete="username"` and `autocomplete="current-password"`. Signup password fields use
`autocomplete="new-password"`.

Literal signup guidance:

> Choose a private username that does not identify you. Your username cannot be changed. AWSM does
> not collect an email address and cannot reset this Account password.

Also show the server's exact inactivity-deletion date derived from the current policy:

> If this Account is not used again, it is scheduled for permanent deletion on
> **<localized exact date>**.

Render the absolute date and a machine-readable `<time datetime="...">`; do not show only a
relative duration.

## 5.2 API Account authentication

Keep protocol version `1`. Canonically replace the Account authentication request:

```json
{
  "username": "quiet_vault",
  "password": "..."
}
```

Reject `email` as an unknown field under the strict API contract. Do not accept both fields and do
not provide a fallback.

Every authenticated Account payload becomes:

```json
{
  "accountId": "uuid",
  "username": "quiet_vault",
  "inactiveDeletionAt": "2030-07-27T12:34:56.000Z"
}
```

Apply that exact shape to Account and VaultDevice session creation/refresh results where the
Account projection is present. `inactiveDeletionAt` is computed from the persisted
`last_activity_at` plus the current server policy at response time. It is not a separately stored
deadline.

## 5.3 Public server information

Keep `protocolVersion: "1"` and add:

```json
{
  "accountPolicy": {
    "inactiveRetentionDays": 365
  }
}
```

`inactiveRetentionDays` is a positive integer. Add
`AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS`; absent means `365`. Boot fails closed with a clear
configuration error when the value is missing digits, fractional, zero, negative, or exceeds the
implementation's safe timestamp range.

The authenticated service-policy response adds:

```json
{
  "inactiveAccountRetentionDays": 365
}
```

Update strict serializers, OpenAPI schemas, examples, contract tests, test transports, and
extension decoders together. Unknown fields remain rejected wherever the current strict protocol
requires it.

## 5.4 Public website session status

Keep the private, no-store `/session/status` behavior from Plan 17. Its authenticated Account
projection becomes:

```json
{
  "authenticated": true,
  "account": {
    "username": "quiet_vault"
  },
  "csrfToken": "..."
}
```

It emits no Account ID, deletion date, Device fact, session fact, Vault fact, or email. The
unauthenticated shape remains minimal. Shared public HTML remains Account-independent and
cache-safe.

## 5.5 Logging

Add `username` and every nested username parameter to filtered-parameter configuration. Audit
controller, model, job, request-test, and JavaScript logging so username, passwords, session
tokens, deletion receipts, Device authority, storage keys, and Vault identifiers are not emitted.

Do not interpolate username into exception messages, ActiveJob arguments, queue names, cache keys,
metrics labels, or structured event names.

# 6. Authenticated Activity and Inactivity Deadline

## 6.1 Activity definition

An activity is a request that:

1. presents valid browser-session or API-session authentication;
2. belongs to an `Active` Account;
3. passes authentication and authorization; and
4. reaches a successful response.

Do not refresh activity for failed sign-in, invalid/expired/revoked credentials, authorization
failure, malformed input, health/readiness/public pages, deletion-receipt polling, or WebSocket
heartbeats alone.

For Action Cable, a successfully authenticated connection and a successfully authorized
subscription each count as Account activity; periodic pings do not.

## 6.2 Bounded persistence

Implement one shared `AccountActivity` service. After a successful authenticated operation:

- update `accounts.last_activity_at` only when the stored value is older than `24.hours.ago`;
- update the current BrowserSession's `last_activity_at` under the same rule;
- use a conditional SQL update so concurrent requests do not serialize on unconditional writes;
- do not extend the deadline merely by rendering a failed request; and
- return the deadline computed from the effective timestamp after the conditional update.

The at-most-daily write optimization means the displayed deletion deadline can lag real activity
by less than 24 hours. Product copy presents the persisted exact deadline, not an assertion of
second-level tracking.

## 6.3 Reaper race

The inactivity dispatcher and all authentication paths use the Account row as their lifecycle
fence:

```text
authenticated request                     inactivity dispatcher
---------------------                     ---------------------
lock/recheck Account Active               lock Account
perform authorized transaction            recheck Active and due
conditionally touch activity              create deletion job + mark Deleting
commit                                    commit
```

Whichever obtains the lock first determines the result:

- a successful activity touch makes the Account no longer due; or
- transition to `Deleting` makes the request fail generically and prevents mutation.

No request may authenticate before the transition and then mutate Account-owned state without
rechecking/locking the Account inside its mutation transaction.

# 7. Account Dashboard

## 7.1 Route and rendering model

`GET /account` is one server-rendered, responsive, authenticated page. Reuse the Plan 16 Account
shell and established design tokens. JavaScript may enhance actions and polling but the Overview,
Devices, Sessions, Security, and Danger Zone remain understandable without JavaScript.

The page is private:

```text
Cache-Control: private, no-store
```

It requires a live BrowserSession belonging to an `Active` Account. Cross-Account identifiers
return the same generic 404 used for absent resources.

The page contains five ordered landmarks with stable headings and anchor links:

1. Overview
2. Devices
3. Website sessions
4. Security
5. Delete Account

## 7.2 Overview

Render:

- permanent username;
- Account creation date;
- configured synchronization-server identity using the validated canonical public origin;
- Vault state:
  - `No synchronized Vault`;
  - `Synchronization setup in progress`; or
  - `Synchronized Vault attached`;
- count of active Devices;
- count of live website sessions; and
- exact inactivity deletion date.

Do not render a Vault name, Vault ID, current Generation, object count, content size, recovery ID,
key epoch, or synchronization cursor.

The dashboard is a projection of the existing Coordination Server Replica metadata. It does not
create a local or server-side copy for presentation.

## 7.3 Devices

Project only these fields from the Account's current Active or Provisional Vault Replica:

```text
display_name
client_kind mapped to "Chrome" or "Firefox"
enrolled_at
status "Active" or "Removed"
removed_at when removed
```

Use `vault_devices.revoked_at` as `removed_at`. Any non-null revocation reason is presented simply
as `Removed`; do not expose the reason.

Sort Active Devices first by enrollment time descending, followed by Removed Devices by removal
time descending. Empty state:

> No synchronized Devices are attached to this Account.

Never project:

- Vault ID or Replica ID;
- Device ID or certificate ID;
- certificate CBOR/signature;
- public keys or envelope metadata;
- Recovery Generation or key-epoch IDs;
- synchronization cursors;
- last-seen/activity/IP/user-agent data; or
- content metadata.

The Device section is read-only. Copy:

> Device removal changes Vault cryptographic authority and must be completed in the AWSM
> extension. Open Account settings in an enrolled extension to manage Devices.

Do not add a website mutation route, Account-scope Device token, or hidden removal form.

## 7.4 Website sessions

Each BrowserSession row renders:

- `This session` when its ID equals the signed session cookie's BrowserSession ID;
- coarse `Chrome`, `Firefox`, or `Other`;
- creation date; and
- day-level last activity date.

Sort current session first, then others by `last_activity_at DESC, created_at DESC`.

Routes:

```text
DELETE /account/browser-sessions/:id   revoke one other session
DELETE /account/browser-sessions       revoke all sessions except current
```

Both routes:

- require CSRF;
- scope the row through `Current.account.browser_sessions`;
- reject deletion of the current row with a validation response telling the user to sign out;
- delete rows rather than mark them revoked;
- clear any server-side credential/session cache tied to each row;
- return redirect/Turbo responses with an accessible success message; and
- return generic 404 for a row from another Account.

The collection action is literally “Sign out all other website sessions.” It preserves the
current BrowserSession. The normal global Sign out action deletes the current BrowserSession and
clears its cookie.

Do not list API sessions. Explain:

> Extension sessions are managed by the extension and are revoked when you change your Account
> password or delete the Account.

## 7.5 Security

Keep the existing password-change route and ceremony. Password change:

- requires current password;
- requires a new password and confirmation;
- rotates the password digest;
- revokes every BrowserSession and ApiSession, including the current one;
- clears the website cookie;
- leaves the Account, server Replica, and local Vault data intact; and
- redirects to sign-in with a serious success message.

Render:

> Your username is permanent. To use a different username, permanently delete this Account and
> create a new one.

Render:

> Your Account password proves who you are to this synchronization server. Your Recovery Phrase
> protects access to your Vault on a trusted AWSM client. The Recovery Phrase cannot reset or
> recover the Account password.

Render:

> AWSM does not collect an email address and cannot send a reset link. If you forget the Account
> password, you can keep using a complete local Vault or move it to another synchronization
> server, but you cannot regain access to this Account.

## 7.6 Accessibility and responsive behavior

Meet WCAG 2.2 AA and the repository design contract:

- real headings and landmarks;
- `<dl>` for summary facts where appropriate;
- semantic tables only when they remain usable at narrow width; otherwise use labelled cards;
- no horizontal page scrolling at the repository's primary or narrow viewport;
- visible keyboard focus;
- 44-by-44 CSS-pixel targets for destructive/session actions where layout permits, with no target
  smaller than the WCAG minimum;
- error summaries linked to fields;
- inline field errors;
- `aria-live` status for session actions and deletion polling;
- disabled/busy states that do not depend on color;
- exact dates available to assistive technology;
- no tooltip-only meaning; and
- reduced-motion behavior for progress.

Rendered proof SHALL cover long 32-character usernames, multiple sessions, multiple Devices,
empty states, removed Devices, validation failures, and destructive confirmations.

# 8. Manual Account Deletion

## 8.1 Browser routes and confirmation

Add:

```text
GET  /account/deletion/new
POST /account/deletion
GET  /account/deletion
```

`GET /account/deletion/new` requires the current BrowserSession and renders the confirmation
inside the Account shell.

`POST /account/deletion` requires:

- CSRF;
- current password; and
- the exact normalized username typed into a confirmation field.

Normalize the confirmation with the normal username normalizer, then require exact equality with
the persisted username. Use generic invalid-confirmation copy and do not reveal which field was
wrong in logs.

The form SHALL say:

> Permanently deleting this Account removes its server-side Vault Replica, encrypted objects,
> Recovery Kit ciphertext, Devices, and sessions. It does not delete data stored in your browser
> or in Exports. There is no recovery period and AWSM cannot restore the Account.

Do not require, imply, or record a Complete Export. The user's data-management decision is not a
server-verifiable deletion prerequisite.

## 8.2 Acceptance transaction

Within one database transaction:

1. lock the Account row;
2. require `Active`;
3. verify current password and typed username;
4. create a cryptographically random 32-byte deletion receipt;
5. store only `SHA-256(receipt)` on one `Manual`, `Pending`, `Freeze` deletion job;
6. mark the Account `Deleting`;
7. delete every BrowserSession;
8. revoke every ApiSession and SessionCredential;
9. invalidate/consume Account-owned transfer tickets and outstanding credential challenges;
10. prevent every VaultDevice credential and Cable subscription from further use; and
11. commit.

After commit, enqueue the deletion worker by job ID. Queue failure must be recoverable by the
hourly dispatcher finding `Pending`/`FailedRetryable` jobs.

Do not pass the receipt, username, Account ID, Vault ID, or storage keys as ActiveJob arguments.
The queue argument is the deletion-job UUID only.

## 8.3 Receipt cookie and status

Replace Account authentication with a signed cookie containing the raw random receipt:

```text
HttpOnly
SameSite=Lax
Secure in production
Path=/account/deletion
Expires no later than 24 hours after successful completion
```

The server stores only its digest. Compare with constant-time secure comparison.

`GET /account/deletion` is unauthenticated and receipt-authorized. HTML renders progress; a
strict, no-store JSON variant used by polling returns only:

```json
{
  "state": "Running",
  "stage": "DeleteOpaqueBytes",
  "processedBytes": 1048576,
  "totalBytes": 4194304,
  "retryCount": 1,
  "outcome": null
}
```

Allowed public `state` values are `Pending`, `Running`, `Retrying`, and `Succeeded`. Map internal
`FailedRetryable` to `Retrying`. Allowed public outcomes are `STORAGE_UNAVAILABLE`,
`DELETE_VERIFICATION_FAILED`, and `INTERNAL_RETRY`; return null otherwise.

Do not return username, Account/Vault/Device/object/job IDs, storage keys, timestamps, exceptions,
or content facts. Missing, malformed, mismatched, and expired receipts return one generic 404.

On success, set `receipt_expires_at = completed_at + 24.hours`. A recurring cleanup clears the
digest and deletes the receipt-only succeeded job after expiry. Clear the browser cookie when the
status route observes expiry. Inactivity deletion jobs may be deleted after the same operational
24-hour interval because they have no user receipt.

## 8.4 Lifecycle fencing

Marking the Account `Deleting` is the authoritative write fence. Audit every Account/Vault mutation
transaction:

- Account session creation/refresh;
- BrowserSession creation;
- Vault attachment/enrollment;
- Device challenge/session creation;
- Device removal and future protection;
- upload creation, part upload, assembly, and completion;
- Object/record creation;
- Event commit;
- generation candidate/seal/activate/purge;
- Recovery Kit/generation operations;
- server-switch/replacement candidate operations;
- transfer-ticket issue and consume;
- Cable ticket issue;
- Action Cable connection/subscription; and
- idempotency replay.

Each path SHALL lock/recheck that the owning Account is `Active` before its first durable mutation.
Use one documented lock order:

```text
Account -> VaultReplica -> Generation/Device/Upload/Record -> child rows
```

Never acquire Account after a Vault-owned row in a competing path. Update tests that exercise
concurrent purge/upload/device/session activity to prove the order does not introduce deadlocks.

Transfer-ticket and Cable paths that do not use ordinary controller authentication must resolve
the owning Account and reject a `Deleting` state on every use. Existing tickets are not sufficient
authority after the state transition.

# 9. Idempotent Verified Deletion Pipeline

## 9.1 State machine

```text
Active Account
    |
    | manual confirmation OR inactivity dispatch
    v
Deleting + Pending/Freeze
    |
    v
Running/DeleteOpaqueBytes
    |          |
    | failure  +--> FailedRetryable --retry--> Running/DeleteOpaqueBytes
    v
Running/DeleteRelationalState
    |          |
    | failure  +--> FailedRetryable --retry--> stage recheck
    v
Succeeded/Complete
```

There is no transition from `Deleting` back to `Active`.

## 9.2 Storage boundary

Extend `Coordination::DiskStore` through a provider-neutral deletion interface. The worker must not
construct filesystem paths or depend on the disk implementation directly.

The storage interface SHALL provide idempotent primitives equivalent to:

```text
delete(storage_key) -> Deleted | AlreadyMissing
exists?(storage_key) -> boolean
```

The worker treats an already-missing key as success and requires `exists? == false` after delete.
A future object-store driver must implement the same verified absence contract.

Never log a storage key. Validate every key through the existing storage-key boundary before use.
Never enumerate the entire backend. Select keys only from rows belonging to the deletion job's
Account.

## 9.3 Byte inventory and progress

At the start of `DeleteOpaqueBytes`, under the lifecycle fence:

1. select every non-null `opaque_records.storage_key` belonging to every Account VaultReplica;
2. select every `upload_parts.storage_key` reachable through those OpaqueRecords;
3. deduplicate identical keys defensively;
4. compute `total_bytes` from the associated byte lengths with checked 64-bit arithmetic; and
5. persist bounded progress.

Do not store the inventory in the deletion job. Process database rows in deterministic,
primary-key batches. For each row:

1. delete the referenced byte;
2. verify absence;
3. clear the row's storage key or otherwise persist an idempotent per-item completion marker in
   the existing owning row; and
4. increment `processed_bytes` by that row's bounded byte length.

The implementation SHALL NOT load an opaque object, upload part, or complete key inventory into
memory. Batch size is a tested constant. Re-running after process termination resumes from rows
whose storage key remains non-null. `processed_bytes` is recomputed or reconciled so retries never
exceed `total_bytes`.

Opaque Recovery Kit ciphertext currently resides in PostgreSQL and is removed in relational
deletion; it is not falsely counted as external storage unless the storage design changes.

## 9.4 Relational deletion order

Only enter `DeleteRelationalState` after every selected external byte has verified absent. In a
final transaction, lock the deletion job and Account, recheck `Deleting`, and delete the complete
Account-owned graph dependency-first.

The service SHALL explicitly cover these records:

1. `generation_reachability_entries`;
2. `generation_reachability_pages`;
3. `generation_memberships`;
4. `record_dependencies`;
5. `delivery_changes`;
6. `event_commits`;
7. `purge_job_generations`;
8. `purge_jobs`;
9. `upload_parts`;
10. `uploads`;
11. `device_key_envelopes`;
12. `session_credentials`;
13. `api_sessions`;
14. `transfer_tickets`;
15. `idempotency_records`;
16. `opaque_records`;
17. `vault_devices`;
18. `vault_key_epochs`;
19. `recovery_generations`, including Recovery Kit ciphertext;
20. `vault_generations`;
21. `vault_replicas`;
22. `browser_sessions`; and
23. `accounts`, last.

Before coding this order, derive and record the current foreign-key graph from the canonical
migration. Where cycles exist through active-generation pointers or generation predecessors,
clear those pointers inside the same transaction before deletion. Do not disable foreign keys,
truncate shared tables, use unscoped `delete_all`, or depend on database cascade without a test
that names the covered relation.

After deleting the Account, atomically:

- set the job's `account_id` null;
- set `state = 'Succeeded'`;
- set `stage = 'Complete'`;
- clear `error_outcome`;
- set `completed_at`;
- set receipt expiry when applicable; and
- commit.

Account deletion never:

- writes a Recovery Snapshot;
- preserves encrypted content for possible recovery;
- deletes browser-local IndexedDB/OPFS data;
- deletes exported files;
- contacts enrolled Devices; or
- affects another Account's rows or storage keys.

## 9.5 Retry behavior

On a retryable storage or process failure:

- leave the Account `Deleting`;
- persist `FailedRetryable`, the current stage, stable outcome, and incremented retry count;
- use bounded exponential retry through Solid Queue;
- let the recurring dispatcher recover stranded Pending/FailedRetryable jobs; and
- keep authentication and synchronization rejected.

A database failure before commit leaves the prior durable stage. A process crash after external
delete but before row update observes the byte already missing and advances safely.

Do not silently mark success after an unverifiable delete. Do not provide an operator bypass that
deletes relational rows while opaque bytes may remain.

# 10. Inactivity Reaping

## 10.1 Policy

`Coordination::ServicePolicy` owns `inactive_account_retention_days`, configured by
`AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS` with reference default `365`.

The due instant is:

```text
accounts.last_activity_at + inactive_account_retention_days.days
```

Changing the server configuration changes the computed deadline immediately for all Active
Accounts. The dashboard and extension always render the deadline returned/computed under the
current policy.

## 10.2 Dispatcher

Add an hourly recurring job. It:

1. selects a bounded batch of apparently due Active Account IDs;
2. locks one Account at a time with skip-locked semantics;
3. re-reads current service policy and `last_activity_at`;
4. skips any Account no longer due or no longer Active;
5. creates one `Inactivity`, `Pending`, `Freeze` AccountDeletionJob with no receipt;
6. marks Account `Deleting` and revokes authority using the same acceptance service as manual
   deletion;
7. commits; and
8. enqueues the same deletion worker.

Also enqueue stranded Pending/FailedRetryable deletion jobs and clean expired succeeded receipt
rows. Bound every pass and make duplicate dispatch harmless.

There is no warning email, reset path, grace state, restore button, support override, or retained
snapshot. The exact date shown before inactivity is the available warning.

## 10.3 Username and Vault-ID reuse

The unique username and Vault ID remain reserved while deletion is Pending, Running, or
FailedRetryable. They become reusable only after verified byte deletion and final relational
commit.

Recreating the same username creates a new Account UUID. Attaching the formerly local Vault after
the old Replica is deleted reuses the Vault UUID but creates new server-side Account/session rows.
Neither operation recovers the old Account.

# 11. Extension Account Replacement

## 11.1 Canonical local Account records

Replace every extension `email` field with `username` in:

- Account configuration;
- stored Account metadata;
- stored Account/Vault binding;
- Device session metadata;
- server-switch candidate metadata;
- Runtime command inputs and view state;
- HTTP request/response types;
- popup setup, login, Account, synchronization, and error UI;
- diagnostics allowlists;
- fixtures and test helpers; and
- IndexedDB decoders.

Do not retain email aliases. Existing IndexedDB data may fail the canonical decoder and be cleared
only through the normal clean-development/test setup; do not add an upgrade transaction.

Keep Account UUID comparisons as the identity invariant. Username is rendered identity, not a
substitute for UUID equality.

## 11.2 Extension UI

Signup/login use username and the same validation/copy as the website. The Account settings view
shows:

- username;
- configured server origin;
- synchronized/local-only state;
- exact `inactiveDeletionAt` when synchronized;
- Device management already owned by the extension;
- server-switch controls;
- normal Sign out; and
- **Stop using this synchronization server** as a separate destructive action.

The extension SHALL distinguish:

- **Sign out**: clears Account credentials according to the existing logout contract but does not
  convert the synchronized Vault to local-only; and
- **Stop using this synchronization server**: preserves a complete local Vault and permanently
  removes the local Account/server binding without mutating the server.

Do not label detachment “Delete Account,” “Remove remote data,” or “Disconnect Device.”

# 12. Stop Using This Synchronization Server

## 12.1 Runtime contract

Add the strict unversioned Runtime command:

```ts
{
  readonly type: "StopUsingSynchronizationServer";
  readonly expectedVaultId: string;
}
```

Reject unknown fields. Require `expectedVaultId` to equal the active Vault so stale popup/options
surfaces cannot detach a newly switched Vault.

Add a serious two-step confirmation in Account settings:

> This keeps the complete Vault on this browser and stops using the configured synchronization
> server. It does not delete the remote Account or remote encrypted data. Other Devices may keep
> using that server until the Account is deleted for inactivity.

The action is available without network access and without a valid Account access/refresh token.
It never makes an HTTP, WebSocket, DNS, or ticket request.

## 12.2 Preconditions

Before mutation, require:

- active Vault matches `expectedVaultId`;
- Vault is unlocked;
- no Capture, Import, Export, vacuum, storage-relief, replacement, future-protection,
  server-switch, sync-apply, or sync-publish operation is active;
- no upload/download or artifact session is open;
- every authoritative Artifact referenced by the active Vault is present in OPFS, passes its
  length/digest verification, and is not remote-only;
- every Event, descriptor, Generation, Recovery Kit, Device authority record, and key epoch needed
  to interpret the local history is locally present and validated; and
- the complete contiguous epoch-key set for the current Recovery Generation unwraps successfully.

If any Artifact is remote-only or unverifiable, refuse without mutation using:

```text
VAULT_LOCAL_COPY_INCOMPLETE
```

Show the count of missing Artifacts but no content titles in logs/diagnostics. UI guidance:

> This Vault is not fully stored on this browser. Reconnect to the synchronization server and
> retrieve the missing items before stopping synchronization.

Do not discard remote-only content and do not offer a “continue anyway” path.

## 12.3 DetachedVaultAuthority

A synchronized Vault cannot become safely local-only by deleting Device/epoch state. Define one
canonical protected record, `DetachedVaultAuthorityV1`, keyed by Vault ID:

```ts
interface DetachedVaultAuthorityV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly activeRecoveryGenerationId: string;
  readonly activeKeyEpochId: string;
  readonly deviceIdentity: {
    readonly deviceId: string;
    readonly certificate: DeviceCertificate;
    readonly envelopes: readonly DeviceKeyEnvelope[];
    readonly wrappedSigningSecretKey: Uint8Array;
    readonly signingPublicKey: Uint8Array;
    readonly wrappedWrappingSecretKey: Uint8Array;
    readonly wrappingPublicKey: Uint8Array;
  };
  readonly epochKeys: readonly {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly wrappedRootKey: Uint8Array;
  }[];
  readonly recoveryKit: ProtectedRecoveryKit;
}
```

The exact repository types may be reused instead of duplicated, but the persisted record SHALL:

- preserve the Vault ID;
- preserve the current local Device ID and cryptographic keys;
- preserve the signed Device certificate and envelopes as publication material;
- preserve every contiguous epoch key needed to decrypt local history;
- preserve the encrypted Recovery Kit and active Recovery Generation;
- keep all private/epoch keys protected by the existing non-extractable local wrapping key;
- contain no Account ID, username, server origin, ApiSession ID, token, ticket, cursor, or remote
  job/checkpoint; and
- pass strict structural, UUID, byte-length, algorithm, continuity, signature, and cross-reference
  validation before commit.

The Recovery Phrase remains usable as Vault recovery authority on a trusted client. It never
recovers the abandoned Account or password.

## 12.4 Atomic transition

Prepare every cryptographic value and verify every local Artifact before opening the IndexedDB
write transaction. This preserves the Firefox rule against holding a write transaction open across
WebCrypto work.

Then, in one IndexedDB transaction:

1. compare the current Account/Vault binding and active Vault against the precondition snapshot;
2. write validated `DetachedVaultAuthorityV1`;
3. set Account configuration to canonical `LocalOnly`;
4. preserve Vault metadata, key slots, Device local keys, epoch keys, Captures, Events,
   Collections, Search indexes, and verified OPFS Artifact bytes;
5. delete Account metadata and Account/Vault binding;
6. delete Account and VaultDevice session credentials;
7. delete server origin/configuration;
8. delete Cable/ticket state;
9. delete sync cursor/state, upload/download state, retries, idempotency state, checkpoints,
   server-switch candidates, and sync-only jobs;
10. commit.

Outside the transaction, abort live synchronization/Cable work before opening it and publish one
AppState update after commit. If any precondition or transaction step fails, leave the original
synchronized state unchanged. Startup reconciliation accepts only the fully bound synchronized
state or fully detached local-only state; partial state fails closed.

Preserving Device cryptographic material locally is intentional. “Stop using the server” removes
server authority and credentials, not the keys required to read the user's local Vault.

## 12.5 Reattachment

A detached Vault can attach to:

- the original Account when the password is remembered and the original Replica still exists;
- a different server immediately; or
- a new Account on the same server only after inactivity/manual deletion of the old Account has
  released the Vault ID.

Do not add an Account recovery path.

Generalize the canonical initial Vault-attachment request so it accepts the complete current
Recovery Generation authority:

```json
{
  "vaultId": "uuid",
  "recoveryGeneration": { "...": "existing canonical fields" },
  "keyEpochs": [
    {
      "keyEpochId": "uuid",
      "ordinal": 0,
      "activatedAt": "..."
    }
  ],
  "activeKeyEpochId": "uuid",
  "device": { "...": "existing canonical certificate fields" },
  "deviceKeyEnvelopes": [{ "...": "one envelope for each supplied epoch" }],
  "initialGeneration": { "...": "existing canonical fields" }
}
```

Rules:

- `keyEpochs` is non-empty, strictly contiguous from ordinal zero, uniquely identified, and ordered;
- `activeKeyEpochId` names the final non-retired epoch;
- every epoch belongs to the supplied current Recovery Generation;
- the Device has one valid administrator-signed envelope for every epoch;
- the Recovery Kit covers the same complete epoch set;
- the initial published Generation/Object uses the active key epoch;
- ordinary never-synchronized local Vaults supply one ordinal-zero epoch;
- detached Vaults supply the complete retained set; and
- the endpoint remains protocol version `1` with one canonical request shape.

Refactor `Coordination::VaultAttachment`, OpenAPI, serializers, extension preparation, and
server-switch publication to use this array contract. Do not keep the single-epoch request as an
alternative.

Reuse the existing verified server-switch publication machinery:

1. inspect the destination and require no conflicting Replica for the Vault;
2. authenticate the destination Account;
3. publish complete local authority and all required encrypted history;
4. obtain new Account/VaultDevice sessions;
5. verify destination parity and Recovery authority;
6. atomically replace detached authority with the new Account/server binding; and
7. leave the detached Vault unchanged if any destination step fails.

Do not rewrite Vault/Object/Generation IDs or re-encrypt content merely to attach. A same-server
conflict while the old Account remains returns the existing conflict outcome plus guidance to use
another server or wait for deletion; it does not reveal which Account owns the Vault.

# 13. Security and Privacy Requirements

## 13.1 Authority boundary

The website BrowserSession proves Account authority only. It may:

- read the allowlisted Device projection;
- manage BrowserSessions;
- change Account password; and
- initiate complete Account deletion.

It may not:

- decrypt Vault data;
- retrieve Recovery Kit plaintext;
- receive Device private keys or envelopes;
- create VaultDevice authority;
- remove a Device;
- perform future protection;
- read or mutate content; or
- become a Host.

Retain the Plan 15 rule that cryptographic Device management requires active VaultDevice authority
inside a trusted extension Host.

## 13.2 Enumeration and side channels

Prove:

- one generic sign-in failure for unknown, malformed, wrong-password, and Deleting Accounts;
- dummy bcrypt for paths without a real digest;
- no public username availability endpoint;
- signup duplicate errors do not expose Account metadata;
- cross-Account BrowserSession IDs return generic 404;
- deletion receipts are unguessable bearer values stored only as digests;
- receipt comparisons are constant-time;
- receipt polling is no-store and rate limited through the existing provider-neutral boundary;
- Device projection is an explicit serializer allowlist; and
- job/error responses contain no identifiers or storage facts.

## 13.3 Data minimization and disclosures

Update the privacy and security pages to describe accurately:

- username and password-digest storage;
- coarse website browser-family and session timestamps;
- Account/activity/deletion-job retention;
- encrypted Replica and operational records;
- local-only detachment behavior;
- absence of product email and password reset;
- inactivity deletion and its configured reference default;
- the fact that CDN, infrastructure, or access logs can still process online identifiers outside
  the minimized application session table; and
- the distinction between Account deletion and browser-local/Export deletion.

Do not claim anonymity or GDPR compliance. Data minimization does not eliminate controller
obligations. Use the official GDPR Articles 4–5 source when making the limited legal-context
statement, and obtain legal review before publishing any broader compliance claim.

# 14. Documentation and Roadmap Reconciliation

Audit tracked source and current normative documentation with:

```bash
rg -n -i 'e-?mail|password reset|forgot password|account recovery' \
  README.md VISION.md ROADMAP.md DESIGN.md docs apps packages tests
```

Classify every hit. Remove stale product/schema/fixture behavior. Historical plan evidence may
retain factual history only when it is clearly historical and not a current contract; update
superseded normative claims that would mislead an implementer.

At minimum reconcile:

- `README.md`;
- `DESIGN.md`;
- `ROADMAP.md`;
- Account/privacy/security/glossary public pages;
- coordination-server README and deployment configuration;
- architecture 01, 03, 04, 08, 15, 19, and 20;
- HTTP OpenAPI and Runtime messaging specifications;
- Plan 15 current Account/API contracts;
- Plan 16 Account/privacy/security surface claims;
- Plan 17 session-status Account projection;
- installation guides and screenshots;
- release notes/download references; and
- extension and coordination E2E fixture documentation.

Roadmap actions:

1. remove or narrow any Account-management item completed by this plan;
2. remove email/password-reset wording from current Account initiatives;
3. retain future optional authentication methods only if described without implying email;
4. retain **Zero-Knowledge Web Host** as future work and state that it would be a trusted local
   client, not this dashboard; and
5. do not claim shipped status until release and verification complete.

# 15. TDD Implementation Sequence

Create the TDD evidence document first. For every task below, record:

- exact RED command and focused failure proving missing behavior;
- implementation commit/diff scope;
- exact GREEN command and result;
- refactor command/result;
- affected full-suite result; and
- artifact/screenshot path where applicable.

Do not implement several tasks and retroactively invent RED evidence.

## Task 1 — Canonical username schema

RED:

- Account normalization/validation/model tests;
- database constraint tests;
- BrowserSession telemetry/constraint tests;
- schema test proving email/IP/raw-UA columns are absent; and
- clean migration test.

GREEN:

- update the canonical migration/schema;
- update Account and BrowserSession models;
- update factories/helpers; and
- remove mailer scaffolding unused by the application.

## Task 2 — Username website authentication

RED:

- signup normalization and permanence copy;
- login generic failure and dummy-bcrypt timing path;
- Deleting Account rejection;
- absence/ignoring of email parameters;
- `autocomplete` attributes; and
- filtered-parameter behavior.

GREEN:

- update registrations, sessions, authentication concern, views, and public-session enhancement.

## Task 3 — API and policy contracts

RED:

- strict OpenAPI examples;
- username-only Account requests/responses;
- `inactiveDeletionAt`;
- public `accountPolicy`;
- authenticated policy field;
- invalid environment values; and
- strict rejection of `email`.

GREEN:

- update service policy, serializers, controllers, OpenAPI, extension HTTP types/decoders, and
  contract fixtures without changing protocol version.

## Task 4 — Activity lifecycle fence

RED:

- daily conditional Account/BrowserSession touch;
- failed request does not touch;
- browser/API/Cable successful activity;
- concurrent activity versus reaper;
- Deleting state rejection across every mutation family; and
- lock-order concurrency tests.

GREEN:

- add shared lifecycle/activity services and apply them to every audited mutation path.

## Task 5 — Dashboard projections

RED:

- authorization and no-store response;
- Overview states/counts/deadline;
- exact Device serializer allowlist;
- active/removed/empty Device states;
- BrowserSession ordering/current marker;
- cross-Account isolation;
- current-session refusal;
- individual/all-other revocation; and
- proof that no API session or forbidden Device field renders.

GREEN:

- implement route, query objects/presenters, controllers, views, styles, and session actions.

## Task 6 — Security and deletion UI

RED:

- password-change full revocation;
- no reset/recovery copy;
- password-plus-username deletion confirmation;
- CSRF and validation;
- no Export gate; and
- receipt cookie/status authorization and safe shape.

GREEN:

- implement confirmation, acceptance service, receipt storage/cookie, polling, and serious copy.

## Task 7 — Verified deletion worker

RED:

- empty Account deletion;
- synchronized Account full graph deletion;
- unfinished uploads and upload parts;
- external byte absence verification;
- already-missing idempotence;
- storage failure and retry;
- crash between byte deletion and row update;
- process restart;
- relational failure;
- no Recovery Snapshot;
- no cross-Account deletion;
- receipt success/expiry;
- username/Vault-ID reservation and reuse; and
- bounded-memory/batch behavior.

GREEN:

- add DiskStore primitives, lifecycle services, worker, dispatcher, recurring schedule, and cleanup.

## Task 8 — Inactivity reaping

RED:

- policy default/config validation;
- computed exact deadline;
- any successful auth activity;
- at-most-daily write;
- not-yet-due skip;
- lock/recheck race;
- duplicate/stranded dispatch;
- identical deletion pipeline;
- no receipt/recovery/snapshot; and
- username reuse only after completion.

GREEN:

- implement dispatcher and recurring configuration.

## Task 9 — Extension username replacement

RED:

- strict username Runtime/HTTP/IndexedDB contracts;
- stale `email` rejection;
- username UI and copy;
- exact inactivity date;
- restart/persistence; and
- two-open-surface AppState consistency.

GREEN:

- replace all extension Account identity fields and fixtures, with no old decoder.

## Task 10 — Detachment preflight and atomic transition

RED:

- offline and expired-credential success;
- assertion of zero HTTP/WebSocket/DNS calls;
- unlocked/idle checks;
- refusal during each conflicting operation;
- remote-only/missing/corrupt Artifact refusal;
- complete epoch-key validation;
- transaction rollback on injected failure;
- Firefox WebCrypto-before-write ordering;
- preserved local content/Search/history across restart;
- removed server/Account/session/sync state;
- preserved protected cryptographic authority;
- two-open-surface state update; and
- startup partial-state failure.

GREEN:

- implement Runtime command, preflight service, detached authority repository, atomic repository
  transition, startup reconciliation, and UI.

## Task 11 — Complete-authority attachment

RED:

- one-epoch ordinary attachment;
- multi-epoch detached attachment;
- non-contiguous/duplicate/misordered epochs;
- missing/mismatched envelopes;
- Recovery Kit mismatch;
- wrong active epoch;
- encrypted historical Object readability after reattachment;
- destination conflict without owner disclosure;
- destination failure leaves detached source unchanged;
- different-server success;
- same-server success only after old Replica deletion; and
- server-switch reuse.

GREEN:

- replace single-epoch attachment contract and refactor attachment/server-switch publication.

## Task 12 — Documentation, design, release, and rollout

RED:

- stale-copy scan;
- rendered design assertions;
- version/download mismatch tests; and
- staging precondition proof.

GREEN:

- reconcile documents/public pages/Roadmap;
- set all extension version outputs to `0.2.0`;
- update release metadata and test assertions;
- complete every local/release gate; and
- roll out only the exact verified tag to isolated staging.

# 16. Verification Matrix

## 16.1 Rails and server verification

From `apps/coordination-server`, run the repository-pinned equivalents of:

```bash
bin/rails db:drop db:create db:migrate RAILS_ENV=test
bin/rails db:prepare
bin/ci
bin/rubocop
bin/brakeman
```

Also run focused RSpec groups for:

- Account model/authentication;
- website signup/sign-in/session status;
- dashboard/session actions;
- service policy;
- API contract/OpenAPI;
- lifecycle/activity races;
- Device projection;
- manual deletion;
- inactivity deletion;
- storage retries/restarts; and
- full coordination integration.

Build the production coordination-server image from a clean tree and run its health/readiness
checks with a newly migrated database.

## 16.2 Repository gates

Run all required root gates with the repository-pinned package manager:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm zip
corepack pnpm design:check
corepack pnpm test:e2e:chrome
corepack pnpm test:e2e:firefox
corepack pnpm test:e2e:cross-browser
corepack pnpm test:e2e:design
corepack pnpm test:sync-proof
corepack pnpm test:e2e:coordination
```

Do not omit `test:sync-proof` or `test:e2e:coordination` from the plan evidence. Rebuild immediately
before packaged-browser E2E so proof does not use stale archives.

## 16.3 Required behavioral scenarios

Prove at minimum:

| Scenario                              | Required result                                      |
| ------------------------------------- | ---------------------------------------------------- |
| Signup with mixed-case/spaces         | Canonical lowercase username, no email               |
| Unknown/malformed/deleting login      | Same generic outcome with dummy bcrypt where needed  |
| Dashboard with no Vault               | No Devices/content claims                            |
| Dashboard with active/removed Devices | Only allowlisted facts                               |
| Revoke another website session        | Target loses access; current remains                 |
| Revoke all other website sessions     | Current remains; every other row deleted             |
| Password change                       | Every browser/API session revoked                    |
| Manual deletion, empty Account        | Verified success and username reusable               |
| Manual deletion, synchronized Account | Every byte/row gone; local Device untouched          |
| Storage unavailable                   | Retrying status; Account remains inaccessible        |
| Worker process restart                | Idempotent resume and correct progress               |
| Activity/reaper race                  | Exactly one valid lock-ordered outcome               |
| Inactivity deadline                   | Exact persisted-policy date on web and extension     |
| Offline detachment                    | Local Vault works; no remote contact                 |
| Remote-only Artifact detachment       | Refused without any state change                     |
| Detached restart                      | Complete local Vault and protected authority survive |
| Different-server reattach             | Same Vault/history/IDs/epoch readability             |
| Same-server pre-reap attach           | Generic conflict                                     |
| Same-server post-reap attach          | New Account can attach same Vault                    |

## 16.4 Rendered and accessibility proof

Inspect real renders at repository primary and narrow widths for:

- signup;
- login;
- Account Overview;
- no-Vault and attached-Vault Overview;
- empty, active, and removed Devices;
- one and many website sessions;
- individual/all-other session actions;
- Security/password flow;
- deletion confirmation;
- deletion Pending/Running/Retrying/Succeeded;
- 32-character username wrapping;
- inactivity warning;
- synchronized extension Account settings;
- incomplete-local-copy detachment refusal;
- detachment confirmation/success; and
- detached local-only settings.

Capture deterministic screenshots in the repository's established evidence location. Inspect them
visually, not only by pixel or selector assertions. Verify keyboard-only operation, focus order,
focus visibility, error navigation, screen-reader names, live regions, contrast, zoom/reflow, and
reduced motion.

## 16.5 Security/privacy proof

Record evidence that:

- `rg` finds no current email/reset contract;
- database schema contains no Account email/session IP/raw-UA column;
- logs contain none of the submitted username/password/receipt/token test sentinels;
- public/shared cached HTML is Account-independent;
- dashboard responses are private/no-store;
- Device/API serializers expose only approved fields;
- receipt responses are minimal and no-store;
- deletion touches only selected Account storage;
- detachment makes no network calls; and
- website assets contain no trusted Vault Host implementation.

# 17. Release `0.2.0`

## 17.1 Version scope

Set the browser-extension package version and generated Chrome/Firefox manifest versions to
`0.2.0`. Update:

- package metadata;
- deterministic archives;
- public download URLs;
- installation guides;
- checksums/provenance expectations;
- release notes;
- design/E2E assertions; and
- any server/site copy that names the current extension release.

Use one immutable candidate commit. Do not tag until every source, server, extension, documentation,
and local real-browser gate is green.

## 17.2 Two-phase browser release

Follow `.codex/skills/release-browser-extension/SKILL.md` and Plan 19:

1. validate clean candidate bytes;
2. submit the untagged exact `0.2.0` Firefox candidate for unlisted Mozilla signing;
3. retrieve and validate the signed XPI;
4. run repository-pinned Firefox Stable and ESR retained-profile/restart proof;
5. run signed Chrome/Firefox cross-browser proof;
6. record the successful local-proof status on the exact candidate commit;
7. create the annotated `v0.2.0` tag only after human authorization required by the release
   workflow;
8. publish the exact proven XPI and exact Chrome ZIP through the joint Release; and
9. independently verify Release assets, checksums, manifests, provenance, and public links.

Any source or packaged extension byte change after candidate signing invalidates the candidate.
Choose the next allowed patch version and repeat the workflow; never reuse changed bytes as
`0.2.0`.

# 18. Reference Staging Rollout

The rollout is staging-only. Production and the frozen upstream repository remain untouched.

Before mutation, record read-only evidence proving:

- exact staging source revision/current image;
- staging Compose/project/service boundary;
- staging application database identity;
- staging opaque-storage volume/mount identity;
- absence of those exact resources from production;
- origin bind/route;
- health/readiness path;
- rollback source/image;
- environment/config preservation plan; and
- no command can select production by default or wildcard.

Only after that proof:

1. prepare an archive from the exact verified `v0.2.0` tag with no ignored/local files;
2. preserve current staging source and application image under explicit rollback names;
3. stop only the staging application boundary needed for a consistent destructive reset;
4. delete the authorized isolated staging PostgreSQL data;
5. delete the authorized isolated staging opaque-storage contents;
6. preserve staging Redis, environment configuration, ingress, shared connector, and every
   production resource;
7. install the exact tagged source;
8. run the canonical Rails migrations against the new empty staging database;
9. rebuild and replace only the staging application service;
10. verify origin liveness/readiness before public routing assertions;
11. exercise signup, username login, dashboard, session actions, Device projection, inactivity
    date, detachment/reattachment test journey, and deletion against synthetic staging data; and
12. inspect primary/narrow public renders.

Do not print, copy, retain, or commit credentials, environment contents, Account data, database
contents, storage contents, identifiers, or unrelated configuration.

This plan does not authorize a future CDN/cache mutation. If rendered evidence shows stale shared
content, begin with read-only proof and request separate authorization for the smallest exact
staging-only purge scope. Do not restart/reload shared ingress merely because the application was
deployed.

Rollback may restore the preserved staging source/image only if doing so does not require
reintroducing the deleted incompatible database. Do not attempt to convert `0.2.0` data backward.
For application defects, prefer fixing forward with an authorized new exact build and another
clean staging reset.

# 19. Completion Checklist

Implementation is complete only when every item is true:

- [ ] TDD evidence was created before production changes and contains real RED/GREEN history.
- [ ] Username is the only Account identifier in schema, web, API, extension, tests, and current
      documentation.
- [ ] No Account email/reset/recovery compatibility path exists.
- [ ] Username normalization, permanence, uniqueness, privacy, and enumeration controls pass.
- [ ] Session records contain only coarse browser family and timestamps.
- [ ] Any successful authenticated use updates Account activity at most once daily.
- [ ] Website and extension show the exact current inactivity-deletion date.
- [ ] `/account` is one responsive, accessible, private/no-store dashboard.
- [ ] Website Device facts are strictly allowlisted and Device mutation remains extension-owned.
- [ ] Browser-session individual/all-other controls are Account-isolated and CSRF-protected.
- [ ] Password change revokes every website and extension session.
- [ ] Manual deletion requires password plus exact username and has no Export gate.
- [ ] Receipt polling exposes only bounded, non-identifying status for 24 hours after success.
- [ ] Manual and inactivity deletion share one idempotent verified-byte pipeline.
- [ ] Every Account-owned row and opaque byte is deleted before username/Vault-ID reuse.
- [ ] Storage failure/restart/race tests pass without restoring Account access.
- [ ] Inactivity reaping is configurable, hourly, lock-safe, irreversible, and notification-free.
- [ ] Offline detachment refuses incomplete local Vaults and never contacts the old server.
- [ ] Detachment preserves complete protected local cryptographic authority and Vault usability.
- [ ] Detached Vaults reattach with the same identity/history and complete epoch readability.
- [ ] The canonical attachment request accepts all required epochs and has no legacy alternative.
- [ ] Website code is not a Vault Host and creates no additional Replica.
- [ ] Privacy/security copy is factual and makes no anonymity or compliance claim.
- [ ] Architecture, specifications, public pages, plans, guides, and Roadmap agree.
- [ ] Rails, lint, typecheck, unit, integration, build, package, design, browser, sync-proof, and
      coordination gates pass.
- [ ] Primary/narrow visual and WCAG 2.2 evidence is inspected and recorded.
- [ ] Exact `0.2.0` signed/unsigned browser artifacts pass the two-phase proof and Release checks.
- [ ] Live deployment isolation is re-proven before any staging mutation.
- [ ] Exact-tag staging reset/deploy/health/journey evidence passes.
- [ ] Production, shared ingress, frozen upstream, and unauthorized cache state remain unchanged.

# 20. Required Failure Behavior

Fail closed in these cases:

- invalid username policy/configuration;
- malformed or stale Account/Device/attachment contracts;
- `Deleting` Account access;
- lifecycle lock/recheck failure;
- deletion receipt mismatch;
- inability to prove external-byte absence;
- deletion worker partial failure;
- missing/corrupt/remote-only local Artifact at detachment;
- incomplete or non-contiguous key epochs;
- IndexedDB partial detached/bound state;
- destination Replica conflict;
- signed-candidate/source-byte mismatch;
- uncertain staging/production isolation; or
- inability to prove the exact deployed revision.

None of these failures authorizes a compatibility reader, manual database edit, relational deletion
before byte verification, Vault clone, identity rewrite, production mutation, cache purge, shared
connector restart, or release-gate bypass.
