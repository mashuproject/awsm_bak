# Account Authentication and Full Vault Synchronization

**Document:** `docs/plans/09-account-authentication-and-full-vault-synchronization.md`
**Status:** Implemented
**Owner:** Engineering
**Last Updated:** 2026-07-19
**Depends On:** `docs/plans/03-multiple-vault-management.md`,
`docs/plans/07-complete-vault-package-import.md`,
`docs/plans/08-coordination-server-contract-and-two-replica-proof.md`, and the architecture and
specifications reconciled by this plan

> **Historical notice:** Plan 15 supersedes this plan's Account-key, extension-signup, and recovery
> model. See
> [Plan 15](15-rails-account-recovery-phrase-device-sync.md) for the implemented canonical
> direction. This document remains unchanged historical implementation context.

---

# 1. Purpose

This is the decision-complete implementation plan for real Account authentication and complete
encrypted Vault synchronization between the Chrome extension and the Coordination Server. The
implementer is expected to begin from a cold checkout with no prior conversation context. Do not
reopen decisions recorded here.

The completed feature SHALL let a user:

1. open the extension for the first time and choose hosted AWSM, one self-hosted Coordination
   Server, or no synchronization;
2. log in with email and password inside the popup or create an Account in an extension-owned tab;
3. create the Account without email verification or any email delivery;
4. create a new synchronized Vault or select one existing local Vault during signup;
5. use the same password on a new browser to authenticate and recover the Account Encryption Key
   without revealing that key or the raw password to the server;
6. bootstrap a fully local Replica of the Account's Vault and continue using it offline;
7. synchronize captures, Vault names, deletion/restoration, Collection operations, and Vault
   Generations automatically in the background;
8. observe synchronization, offline, authentication, progress, and failure states without
   reloading any open surface;
9. sign out without losing or locking already available local Vault data; and
10. resolve a stale offline Replica through export-first explicit discard and atomic verified
    server replacement.

This plan replaces the following pre-release proof decisions in place:

- the fixed proof bearer credential is removed in favor of the sole real Account authenticator;
- one Account owns at most one synchronized Vault instead of multiple Vault replica records;
- the browser extension gains the trusted Runtime Synchronization Service deferred by Plan 08; and
- the proof-only claim that production-style login and client synchronization are wholly future
  work becomes stale and SHALL be removed everywhere.

This implementation remains a pre-release/self-hosted capability, not an authorization to expose
open registration as a public hosted service. Quotas, signup abuse controls, a shared opaque-byte
storage Driver, horizontal deployment, Device authorization/revocation, password change, Account
Recovery Keys, automatic retention policies, and independent security review remain production
gates.

---

# 2. Scope and Non-Goals

## 2.1 In scope

- hosted, self-hosted, and local-only first-launch choices;
- `https://awsm.foo` as the visible hosted default;
- one custom Coordination Server origin with an exact runtime-granted host permission;
- immediate unverified email/password Account signup;
- password-derived, domain-separated Account authentication and encryption keys;
- one random Account Encryption Key protected by an authenticated password envelope;
- one synchronized Account key slot wrapping the Vault Root Key;
- retention of the existing mandatory device-local Vault key slot;
- opaque short-lived access tokens and rotating persistent refresh sessions;
- authenticated HTTP synchronization and one-use Action Cable connection tickets;
- one Account owning zero or one synchronized Vault;
- one extension having at most one active Account while retaining multiple local-only Vaults;
- signup selection of a new Vault or one existing local Vault;
- fully local Replica bootstrap, followed by optional user-approved heavy-wrapper storage relief;
- resumable bounded-memory upload and download through the existing transfer contract;
- persistent Runtime Synchronization Jobs, cursors, retry state, and lifecycle recovery;
- synchronization of all currently implemented authoritative Event/Object behavior;
- live invalidation of popup and Library surfaces after authoritative or synchronization state
  changes;
- synchronized Vault Vacuum with remote compare-and-swap preceding local activation;
- stale-Replica detection, warning, optional exact Complete Export, explicit discard, and verified
  server replacement;
- Account and per-Vault synchronization settings;
- replacement of proof authentication and update of the independent synchronization proof;
- unit, integration, Rails request/Job/contract, Docker black-box, packaged-Chrome, security, and
  rendered visual evidence; and
- complete documentation and Roadmap reconciliation.

## 2.2 Explicitly deferred

- verified email, email delivery, magic links, or email-based reset;
- password change, Account Recovery Keys, trusted-browser password reset, or any other recovery
  ceremony;
- WebAuthn, passkeys, OAuth, SSO, or multiple authentication methods;
- Device public keys, signed Device requests, approval, trust, revocation, or Device management;
- more than one synchronized Vault per Account;
- more than one active Account in one extension installation;
- shared Vaults, memberships, invitations, roles, Organizations, or collaboration;
- public-hosted registration, quotas, billing, rate limiting, CAPTCHA, abuse mitigation, or account
  administration;
- automatic local retention profiles, cache budgets, or pinning beyond manual storage relief;
- automatic semantic merge or selective reapplication of stale unpublished Events;
- importing a stale recovery package as a new local-only Vault;
- preserve-first stale recovery beyond optional Complete Export;
- server-side plaintext, semantic Event interpretation, Search, AI, or key derivation;
- alternate transports, protocol negotiation, compatibility routes, or legacy token readers;
- S3, MinIO, provider-specific object storage, or horizontal Rails deployment; and
- preservation or migration of any pre-release extension, PostgreSQL, proof, or opaque Disk data.

## 2.3 Pre-release replacement policy

- Update the original Coordination Server migration and committed schema in place. Do not add an
  upgrade migration from the proof schema.
- Update the sole canonical IndexedDB schema in place and keep its initial format numbering. Do not
  add old-store detection, a database upgrade reader, dual reads, or compatibility aliases.
- Delete and recreate development/proof PostgreSQL databases, opaque Disk storage, extension
  IndexedDB, OPFS data, fixtures, and browser profiles before final verification.
- Keep HTTP protocol version `1`; it is the sole pre-release externally exchanged contract, not a
  successor protocol.
- Keep transient Commands, request types, view models, Runtime events, and session state
  unversioned. Version only persisted records and authenticated/exchanged key envelopes.

---

# 3. Fixed Product Decisions

## 3.1 Account and Vault cardinality

- An Account owns zero or one synchronized Vault on its Coordination Server.
- Enforce the limit with a unique database constraint on the Account foreign key, not only service
  validation.
- An Account may temporarily own no Vault while signup/enrollment is incomplete or after an
  interrupted attach. The persistent client enrollment Job SHALL resume that state.
- A Workspace may contain the Account Vault plus any number of local-only Vaults.
- Additional Vaults created after the Account owns a Vault are local-only. Do not show an
  unavailable synchronization choice for them.
- One extension installation holds at most one active Account/session/server context.
- Signing out does not detach or delete the remote Vault and does not change local Vault identity.

## 3.2 First launch and server choice

- The first popup state is the local-versus-synchronized onboarding decision, before local Vault
  onboarding.
- Make `Continue without sync` the first and primary action. Present `Set up synchronization` as a
  secondary action and allow synchronization to be configured later from Account settings.
- The synchronization setup tab offers hosted or self-hosted server selection and Account creation;
  an already configured server continues to expose login in the popup.
- Show `Syncing with awsm.foo` or equivalent visible server context near login/signup actions.
- A server selector offers `AWSM`, `Self-hosted`, and `No sync`.
- `AWSM` resolves to the build-configurable hosted origin whose checked-in default is
  `https://awsm.foo`.
- `Self-hosted` accepts one base origin only. It does not accept separate API, identity, events,
  notification, or web URLs.
- `No sync` persists a local-only onboarding decision and continues to the existing Create/Import
  Vault flow. Account settings allow connecting later; do not periodically prompt.
- Login remains in the popup. `Create account` opens an extension-owned full tab because signup,
  unrecoverability acknowledgement, Vault selection, and initial transfer may outlive the popup.
- `ACCOUNT_UNAVAILABLE` does not confirm Account existence. Explain that the Account may already
  exist or the address may be unavailable, and offer an in-tab `Sign in instead` mode that retains
  the selected server and normalized email.
- Do not automatically open a tab on extension installation. The flow begins when the user opens
  the popup.

## 3.3 Signup and Vault selection

- Signup collects server, email, password, password confirmation, and an explicit acknowledgement
  that AWSM cannot reset the password in this slice.
- After Account creation, establish the extension session automatically; do not require the same
  credentials again.
- If local Vaults exist, show `Create a new synchronized Vault` plus every existing local-only
  Vault. If none exist, show only new Vault creation.
- Selecting an existing Vault requires it to be unlocked through its existing device slot. It does
  not change its Vault ID, Root Key, Objects, Events, name, or history.
- Creating a new Vault asks for its name and creates the local device slot and Account slot in the
  same local authority transaction.
- Account creation may commit before Vault attachment because the network and local stores cannot
  share a transaction. Persist an enrollment Job immediately and resume until the Account owns the
  selected Vault.
- If Account creation succeeds and later enrollment fails, keep the Account signed in, show the
  incomplete setup, and offer Resume. Do not create a second Account or second Vault.

## 3.4 Login and remote bootstrap

- Login accepts exact password input and normalized email input.
- If the Account owns a Vault and no local Vault has its ID, download a fully local Replica,
  create a fresh local device slot, rebuild Projections, select the Vault, and leave it unlocked for
  the just-authenticated session.
- If a local Vault with the remote Vault ID exists, unwrap both the local device slot and remote
  Account slot and require the same verified Vault Root Key before reconciliation.
- A same-ID Root Key mismatch is a terminal integrity/identity collision. Do not overwrite, fork,
  merge, or guess.
- Existing unrelated local-only Vaults remain in the Workspace unchanged.
- If the Account owns no Vault, show the same create-new/select-existing completion flow used after
  interrupted signup.

## 3.5 Session and sign-out behavior

- A successful login persists until explicit logout, server revocation, or refresh expiry.
- Access tokens live for 15 minutes.
- Refresh tokens use a sliding 30-day expiry and rotate on every successful refresh.
- Reuse of a consumed refresh token revokes the complete logical session.
- Browser restart and service-worker suspension recover through the encrypted refresh token.
- Logout revokes the current server session when reachable, deletes local access/refresh
  credentials and all locally wrapped Account Encryption Key material, and pauses synchronization.
- Logout preserves server origin, last email, non-secret Vault/server association, every local
  device slot, and all local encrypted data.
- A failed remote logout still clears local secrets. Server expiry/revocation handles the abandoned
  token.
- Signing out never locks or deletes locally available Vault content. If heavy wrappers are
  remote-only, warn that access to them requires signing in again.
- `Reset this device` is a separate typed-confirmation action. It revokes the reachable active
  session, stops local Jobs and transport, releases in-memory keys, and deletes every extension-local
  database, Vault, key, Artifact wrapper, setting, and temporary file before restarting onboarding.
  It never deletes or mutates the server-side Account or Vault.

## 3.6 Offline behavior

- Capture, browse, Search when implemented, rename, delete/restore, Collection operations, Export,
  Import, and local-only Vault behavior remain local-first.
- Ordinary local authoritative commits never wait for remote acknowledgement.
- A synchronized Vault queues new work and shows `Waiting for connection` when offline.
- Compact content and locally present wrappers remain available while the server is down or
  authentication refresh is temporarily unavailable. Intentionally remote-only wrappers explain
  their offline/authentication requirement without being misreported as corruption.
- Do not render a blank or blocking popup while network work is pending.
- Vault Vacuum is the sole current exception: a synchronized Vault Vacuum requires an online
  reconciliation and remote compare-and-swap because local-first activation could knowingly create
  an unsafe divergent Generation.

---

# 4. Canonical Terminology, Authority, and Security Invariants

Use the glossary's exact capitalization: Account, Vault, Workspace, Replica, Object, Bundle,
Artifact, Event, Projection, Materialization, Runtime, Host, Driver, Service, Coordination Server,
Vault Generation, Vault Vacuum, Import, and Export.

Add and use these terms consistently:

- **Account Encryption Key:** a random client-created symmetric key that wraps the Account Vault's
  Vault Root Key and is itself wrapped by the Account password-derived wrapping key.
- **Account key envelope:** the authenticated password wrapper containing the Account Encryption
  Key. The Coordination Server stores it as opaque Account credential metadata.
- **Account slot:** the authenticated wrapper containing one Vault Root Key under the Account
  Encryption Key.
- **Account session:** one revocable server-authenticated login represented by rotating opaque
  credentials. It is not a Device identity.
- **Synchronization state:** local operational cursor, head, acknowledgement, retry, and status
  records. It is disposable/non-authoritative and never synchronized.
- **Remote-only Artifact:** a device-local operational state in which the authoritative Artifact
  Object remains present but its encrypted wrapper was intentionally removed after exact active-
  server proof.
- **Stale Replica:** a local synchronized Replica with unpublished work based on a superseded Vault
  Generation that cannot be submitted safely to the current server head.

Preserve these invariants:

1. Raw passwords never leave the trusted extension.
2. The authentication derivative cannot derive the Account password wrapping key or Account
   Encryption Key.
3. The Coordination Server never receives an unwrapped Account Encryption Key or Vault Root Key.
4. Email and authentication/session metadata are server-visible Account data and SHALL be
   documented as such.
5. A local device slot remains sufficient for offline Vault access after Account logout.
6. An Account slot does not replace, downgrade, or become a fallback for the device slot.
7. Account authentication grants the current direct Account/Vault synchronization authority; it
   does not claim Device trust, signing, approval, or revocation.
8. Every synchronized authoritative payload is encrypted before transfer.
9. The server never interprets Vault names, URLs, titles, Event subtype, Collection topology,
   Artifact Role, plaintext checksum, Search data, or other content semantics.
10. Local authoritative commits precede synchronization acknowledgement.
11. Local Artifact wrappers are removed only by explicit storage relief after exact proof; ordinary
    synchronization remains full-local for newly learned Artifacts.
12. The Synchronization Service validates downloaded bytes and semantics before authority changes.
13. Action Cable remains a wake-up hint; polling alone converges.
14. Delivery Cursor order never becomes Event replay order.
15. A stale Generation is never silently retried, merged, rebased, discarded, or submitted against
    the new active Generation.
16. A failed stale-resolution attempt leaves the original stale Vault intact and usable for
    read/export.
17. Stale resolution never creates another Vault and never reuses an Object ID with different bytes.
18. The storage transaction, not UI disabled state, enforces every mutation fence.
19. No plaintext, password, key, token, email beyond explicitly allowed Account fields, or content
    metadata enters diagnostics.
20. Pre-release code exposes exactly one Account, session, key-envelope, and synchronization
    contract.

---

# 5. Password and Account-Key Cryptographic Contract

## 5.1 Password input

- Require a non-empty password in the signup UI. The Account cryptographic boundary applies no
  minimum, maximum, or complexity policy before Argon2id derivation.
- Do not trim, normalize, case-fold, or otherwise transform the password.
- Confirm equality in the signup UI before derivation.
- Clear DOM fields immediately after dispatch and release all Runtime string references in
  `finally`.
- The HTTP API cannot prove password length because it never receives the password. It SHALL
  strictly validate the derived credential and KDF parameters instead.

## 5.2 Email input

- Trim surrounding ASCII whitespace, lowercase the complete address, and accept only a syntactically
  valid ASCII email address of at most 254 bytes.
- Use the normalized value for uniqueness and authentication.
- Preserve only the normalized value. Do not store a second display form.
- Reject invalid signup email with `ACCOUNT_INPUT_INVALID`.
- Login failure for invalid, absent, or wrong credentials is always `AUTHENTICATION_FAILED`.

## 5.3 Master derivation

For the sole canonical Account password scheme:

- algorithm: Argon2id13;
- output: 32 bytes;
- salt: random 16 bytes chosen by the extension during signup;
- operations: `3`;
- memory: `67_108_864` bytes (64 MiB);
- password input: the exact non-empty string accepted by the signup UI, without an additional
  length or complexity transformation;

The server stores and returns the public salt and parameters but cannot choose alternate values.
Clients reject any other algorithm, output size, operations count, or memory size in this slice.

## 5.4 Domain separation

Let `master` be the 32-byte Argon2id output and `accountKeyId` be a client-created UUID. Derive two
32-byte values with HKDF-SHA256 using the Account Key ID bytes as salt:

- authentication derivative info: `account:authentication:v1`;
- password wrapping key info: `account:password-wrapping:v1`.

Send only the base64url-no-padding authentication derivative to the server. Never persist it in the
extension. The server hashes it with bcrypt before committing the Account.

Generate the Account Encryption Key as 32 cryptographically random bytes. Do not derive it directly
from the password.

## 5.5 Account key envelope

Use one self-describing exchanged envelope:

```text
version: 1
accountKeyId: UUID
kdfAlgorithm: "kdf:argon2id13:account:v1"
kdfSalt: 16 bytes
kdfOperations: 3
kdfMemoryBytes: 67108864
wrappingAlgorithm: "wrap:xchacha20poly1305:account-password:v1"
nonce: 24 bytes
ciphertext: authenticated Account Encryption Key bytes
```

Authenticate canonical CBOR AAD containing, in order, version, Account Key ID, KDF algorithm, salt,
operations, memory bytes, wrapping algorithm, and nonce. Unknown/missing fields or values fail
closed. A wrong password and envelope authentication failure both surface as
`AUTHENTICATION_FAILED`; do not reveal which field failed.

## 5.6 Account Vault slot

Use one Account slot per synchronized Vault:

```text
version: 1
slotId: UUID
vaultId: UUID
accountKeyId: UUID
algorithm: "wrap:xchacha20poly1305:account:v1"
nonce: 24 bytes
ciphertext: authenticated Vault Root Key bytes
```

Authenticate canonical CBOR AAD containing version, slot ID, Vault ID, Account Key ID, algorithm,
and nonce. After unwrap, verify the Vault Root Key against canonical Vault data before creating a
local device slot or treating the Vault as unlocked.

## 5.7 Secret lifetime

- Wipe Argon2 output, HKDF outputs, raw Account Encryption Key bytes, and raw Vault Root Key carrier
  bytes as soon as their operation completes.
- Hold the unwrapped Account Encryption Key only in the background Runtime while authenticated and
  needed.
- Locally persist it only through a wrapper under a non-exportable 256-bit AES-KW Account device
  key.
- Encrypt the refresh token separately under a non-exportable 256-bit AES-GCM session-storage key
  with a random 12-byte nonce and Account/session-bound AAD.
- Persist neither access token nor authentication derivative. Recover access after worker restart
  through refresh.
- Delete both non-exportable Account-local keys and all dependent ciphertext on logout.

Add deterministic cross-implementation vectors for master derivation, both HKDF domains, Account
key-envelope AAD/ciphertext, Account-slot AAD/ciphertext, wrong-password failure, and metadata
substitution failure.

---

# 6. HTTP, OpenAPI, and Session Contract

OpenAPI remains the exact HTTPS adapter contract. Keep strict unknown-field rejection, protocol
header `1`, lowercase UUID request IDs, stable outcomes, and idempotency keys for mutations.

## 6.1 Public unauthenticated resources

Override the document-level bearer requirement only for these resources:

### `GET /api/server-information`

Returns:

```json
{
  "service": "AWSM Coordination Server",
  "protocolVersion": "1",
  "capabilities": {
    "accountPassword": true,
    "accountVaultLimit": 1,
    "completeReplicaSynchronization": true
  }
}
```

This resource proves server identity/capability only. It does not authenticate the server beyond
TLS and does not return deployment secrets, Account existence, policy, or storage information.

### `POST /api/authentication-parameters`

Request: `{ "email": "normalized@example.test" }`.

Return the Account Key ID and canonical KDF parameters for an existing Account. For an absent or
invalid Account, return a stable synthetic Account Key ID and salt derived with an HMAC server
secret and the same canonical parameters. Do equivalent bounded work so this endpoint does not
become a direct Account enumeration oracle. The synthetic secret is mandatory configuration and
must differ by deployment.

### `POST /api/accounts`

Accept normalized email, one 32-byte base64url authentication derivative, and one complete Account
key envelope. Create the Account and initial session atomically. A duplicate or otherwise
unavailable email returns generic `ACCOUNT_UNAVAILABLE`; do not expose an Account identifier.

Return normalized Account metadata, Account key envelope, access token/expiry, refresh token/expiry,
and session ID. The successful response signs the extension in immediately.

### `POST /api/sessions`

Accept normalized email and authentication derivative. Authenticate through bcrypt and return the
same session/account-key response shape as signup. Invalid email, absent Account, wrong derivative,
or disabled Account all return `AUTHENTICATION_FAILED` with equivalent safe behavior.

### `POST /api/session/refresh`

Accept a refresh token, atomically consume it, create the next refresh token and access token, and
extend the sliding refresh deadline. A replayed consumed refresh token revokes the session and
returns `AUTHENTICATION_FAILED`.

## 6.2 Authenticated session resources

### `DELETE /api/session`

Revoke the complete current session, including unexpired access and refresh credentials. Repeating
logout is harmless. Return `204`.

### `POST /api/cable-tickets`

Issue a random one-use ticket valid for at most 60 seconds and bound to the authenticated Account.
The canonical ticket is an unpadded base64url encoding of 32 random bytes. Redis stores only its
namespaced SHA-256 key, Account UUID value, and TTL. The client opens `/cable?ticket=...`; the
connection consumes the ticket with one atomic `GETDEL` and rejects reuse. Never place an access or
refresh token in a WebSocket URL. Plan 14 owns the exact ephemeral-coordination implementation.

### `GET /api/vaults`

Return zero or one Account-owned Vault resource, including server Generation/head metadata and the
opaque Account slot. Do not return Vault names or any decrypted metadata.

### Existing Vault resources

- Extend Vault attachment to require the complete Account slot.
- Return the Account slot from Vault show/list bootstrap resources.
- Keep all upload, commit, changes, records, Generation candidate, recovery, purge, transfer, and
  service-policy semantics otherwise canonical.
- Continue requiring recent Account confirmation for manual purge. Login sets confirmation time;
  refresh does not make it recent again. This slice adds no purge UI or password-reconfirmation
  endpoint.

## 6.3 Token representation and persistence

- Access and refresh credentials are opaque `tokenId.secret` values with a random public lookup ID
  and 32 random secret bytes.
- Store only SHA-256 secret digests, token kind, expiry, consumption/revocation state, and session
  relationship.
- Keep consumed refresh rows through their expiry so replay can revoke the session.
- Access refresh creates a new access credential without invalidating already issued access tokens
  before their 15-minute expiry; logout/revocation invalidates all immediately.
- Account authentication returns `AccountPrincipal(account:, confirmed_at:)` through the existing
  boundary so downstream authorization remains decoupled.
- Remove `AWSM_PROOF_ACCOUNT_ID`, `AWSM_PROOF_ACCOUNT_TOKEN`, fixed secure comparison, and every
  proof-only authentication branch.

## 6.4 Outcomes

Add stable outcomes at minimum:

- `ACCOUNT_INPUT_INVALID`;
- `ACCOUNT_UNAVAILABLE`;
- `AUTHENTICATION_FAILED`;
- `SESSION_EXPIRED`;
- `SERVER_INCOMPATIBLE` (client-local mapping where appropriate);
- `SERVER_PERMISSION_DENIED` (client-local);
- `VAULT_ACCOUNT_LIMIT_REACHED`;
- `VAULT_IDENTITY_MISMATCH`;
- `SYNCHRONIZATION_INTEGRITY_FAILED`;
- `SYNCHRONIZATION_INTERRUPTED`;
- `SYNCHRONIZATION_AUTHENTICATION_REQUIRED`;
- `SYNCHRONIZATION_CONFLICT`;
- stale-discard failures use existing synchronization integrity/context outcomes; and
- existing Generation/head outcomes without aliases.

Never branch on diagnostic prose. Map HTTP status and stable outcome independently. Do not return
email, token, KDF secret, ciphertext, or cross-Account existence in error details.

---

# 7. Coordination Server Persistence and Boundaries

## 7.1 Canonical Account schema

Replace the current empty Account row with fields for:

- normalized email with a unique index;
- bcrypt authentication-derivative digest;
- Account Key ID;
- exact canonical KDF public parameters;
- Account key-envelope algorithm, nonce, and ciphertext;
- created/updated timestamps.

Store envelope bytes in binary columns, not JSON strings. Add database constraints for fixed byte
lengths, exact algorithms/parameters, normalized email equality, and required fields.

## 7.2 Sessions and credentials

Add Account sessions and session credentials with foreign keys, token IDs, digests, kinds, expiry,
consumed/revoked timestamps, confirmation time, and timestamps. Enforce:

- token ID uniqueness;
- fixed 32-byte digests;
- allowed credential kinds;
- positive expiry ordering;
- one-use refresh consumption; and
- cascading credential deletion only when an Account/session is intentionally removed by
  administrative development reset, not ordinary logout history needed for replay detection.

## 7.3 Vault Account slot and cardinality

Store Account slot metadata on the Vault replica record or one strict dependent table. Enforce one
slot per Vault and one Vault per Account. Validate fixed nonce/ciphertext lengths and exact current
algorithm. The server treats ciphertext as opaque and never attempts unwrap.

## 7.4 Cable tickets

Persist one-use Cable ticket digest keys, Account binding, and expiry in Redis. Consume with one
atomic `GETDEL`; Redis TTL owns expiry and no cleanup Job or PostgreSQL row exists. Plan 14 owns the
exact representation, failure mapping, and operational topology.

## 7.5 Controller/service boundaries

- Account/password/session controllers validate strict shapes and delegate to bounded services.
- No controller derives keys, hashes passwords directly, or implements token rotation inline.
- `AccountAuthenticator` remains the sole conversion from bearer credential to principal.
- Synchronization controllers continue scoping every lookup from `current_account`.
- Authentication endpoints do not inherit the authenticated API base callback but do reuse protocol,
  request-ID, outcome-rendering, and OpenAPI behavior.
- Filter every credential field and safe variants in Rails parameter logging.
- Add sentinel tests proving secrets never appear in application logs, exceptions, inspection,
  Active Job arguments, Action Cable URLs after ticket consumption, or test failure rendering.

---

# 8. Extension Host Permission and Server Configuration

## 8.1 Manifest permissions

- Add `alarms` for synchronization recovery polling.
- Add optional host patterns for HTTPS and loopback HTTP only.
- Do not add broad permanent host permissions.
- Request the exact selected origin plus `/*` from a user gesture before probing or authenticating.
- If permission is denied, keep the form and show `SERVER_PERMISSION_DENIED`; do not fall back to
  another origin.

## 8.2 Origin validation

Canonicalize through the platform URL parser and require:

- `https:` for all non-loopback hosts;
- `http:` only for `localhost`, `127.0.0.1`, or `[::1]`;
- no username or password;
- root path `/` only;
- no query or fragment;
- explicit non-default ports preserved;
- lowercase canonical host and normalized default port removal.

Reject browser-internal, file, extension, data, blob, IP wildcard, and non-HTTP schemes. Fetch with
redirect mode `error`; never forward authentication to a redirect target. Chrome certificate
validation remains authoritative; add no self-signed-certificate bypass.

## 8.3 Server probe

After permission grant, call `GET /api/server-information` with protocol/request headers and a
bounded timeout. Require exact service name, protocol `1`, password capability, Vault limit `1`, and
full Vault Replica synchronization. Any mismatch is `SERVER_INCOMPATIBLE` and commits no selected
server.

Persist initial server configuration only after a successful probe. Authenticated Coordination
Server switching is governed by
`docs/plans/10-git-like-synchronization-server-switching.md`: it keeps the source context live while
an isolated candidate is probed, authenticated, cryptographically compared, reconciled, and
atomically promoted. It does not log out first or restart unconfigured onboarding.

---

# 9. Extension Persisted State and Runtime Interfaces

## 9.1 Canonical local stores

Add sole canonical version-1 stores/records for:

- Account/server configuration (`Unconfigured`, `LocalOnly`, or configured origin);
- non-secret Account summary and previous Vault association;
- non-exportable local Account wrapping/session-storage keys;
- encrypted refresh credential and locally wrapped Account Encryption Key;
- Account Vault registration and Account slot metadata;
- per-Vault remote Generation/head and Delivery Cursor;
- persistent enrollment and Synchronization Jobs;
- upload/download checkpoints and prepared remote wrapper references;
- synchronization error/status; and
- stale-discard preparation and activation Job state.

Do not put these fields into Workspace metadata merely for convenience. Workspace owns local Vault
enumeration/selection; Account configuration and synchronization are separate operational domains.

## 9.2 Runtime services

Add bounded Services for:

- Account configuration and authentication;
- Account key enrollment/unlock;
- Coordination HTTP/Cable client behavior;
- Synchronization planning/execution;
- remote Replica staging/activation; and
- stale-Replica export-first discard and server replacement.

Hosts provide browser permission prompts, fetch/WebSocket primitives, lifecycle signals, file
downloads, and rendering. Hosts do not decide Account/Vault cardinality, key policy, synchronization
ordering, conflict behavior, or recovery semantics.

## 9.3 Commands and state

Extend the application protocol with unversioned Commands for server selection, local-only choice,
signup, login, logout, enrollment resume, manual sync retry, and stale resolution. Do not include a
password in `AppState`, notifications, persisted Jobs, or error details.

Extend `AppState` with an Account/synchronization view containing only:

- configuration mode and safe origin label;
- normalized signed-in email when authenticated;
- Account state (`SignedOut`, `Authenticating`, `Authenticated`, `Expired`);
- Vault sync state (`LocalOnly`, `Enrolling`, `Uploading`, `Downloading`, `UpToDate`, `Offline`,
  `AuthenticationRequired`, `Conflict`, or `Failed`);
- byte/item progress where known;
- stable error ID; and
- whether a stale-resolution action is required.

Every successful change to those visible states publishes the canonical unversioned invalidation
notification. Receivers refetch; the notification carries no trusted state or secrets.

---

# 10. Synchronization Service and Job State Machine

## 10.1 Scheduling and lifecycle

Start or wake reconciliation after:

- Account login/signup/enrollment;
- every successful authoritative local mutation in the synchronized Vault;
- Runtime startup;
- a one-minute Chrome alarm while authenticated;
- Action Cable hint;
- extension surface visibility/focus regain;
- network transition detectable by the Host; and
- explicit Retry.

Subscribe before the initial fetch when the Vault is known. Coalesce repeated wakes while ensuring
one final reconciliation. Serialize per-Vault work and generation-guard responses so an older fetch
cannot overwrite newer local state.

Use exponential retry beginning at five seconds and capped at fifteen minutes for retryable network
or server failures. User Retry, focus, local mutation, or Cable wake resets the delay. Authentication,
integrity, and conflict failures do not retry blindly.

## 10.2 Persistent stages

One reconciliation Job records at minimum:

- `DiscoverAccountVault`;
- `EnrollVault`;
- `Subscribe`;
- `FetchHead`;
- `UploadObjects`;
- `CommitEvents`;
- `FetchChanges`;
- `DownloadRecords`;
- `Validate`;
- `ActivateLocal`;
- `Checkpoint`; and
- terminal `Succeeded`, retryable waiting, authentication-required, conflict, or failed state.

Persist stable IDs, Account/Vault/Generation context, snapshot cursor, item/byte progress,
idempotency keys, upload IDs/received parts, prepared wrapper handles, and safe outcome IDs. Never
persist tokens, passwords, unwrapped keys, decrypted content, Vault names, URLs, or semantic
diagnostics in Jobs.

An interrupted worker resumes from server state and persisted checkpoints. It does not assume that
the prior request failed merely because its response was lost.

## 10.3 Initial enrollment/upload

- Create the Account slot from an unlocked local Vault Root Key.
- Attach Generation zero/current Generation through the existing idempotent Vault resource.
- Stream the encrypted Vault Generation Object, Event envelopes, Bundle Descriptor Objects, and
  Artifact wrappers without whole-object buffering.
- Upload dependencies before each Event and commit one exact Event closure at a time.
- Preserve canonical Event replay order independently of upload/Delivery Cursor order.
- Mark local work remotely durable only after the server acknowledges closure commit.
- Never remove locally durable bytes during ordinary synchronization. Manual storage relief is a
  separate explicit proof-and-confirmation workflow.

For an existing mature local Vault selected during signup, enumerate and upload its complete active
Generation membership. Do not invent a new Generation or rewrite its history merely to attach it.

## 10.4 Initial remote bootstrap

- Fetch the Account's sole Vault and Account slot.
- Derive/unlock the Account Encryption Key and unwrap/verify the Vault Root Key.
- Subscribe, then capture one server head/snapshot cursor.
- Page complete active membership in lexical Object-ID order.
- Download through scoped tickets and ranges into prepared OPFS/IndexedDB staging.
- Verify advertised object type, ID, encrypted byte length, SHA-256, Event ordering metadata, exact
  dependency lists, Generation membership, and all authenticated envelopes.
- Decrypt and semantically validate inside the trusted Runtime.
- Require every Event dependency and Bundle/Artifact graph required by the Vault Replica.
- Build a fresh local device slot and verifier and rebuild Vault name, Library, Collection, and
  other implemented Projections.
- Activate directory entry, Vault authority, key material, Projections, head, and sync checkpoint in
  one IndexedDB transaction after all external wrappers are prepared.
- On failure, leave no local Vault authority and clean prepared wrappers.

## 10.5 Incremental upload

After each local authoritative commit, compare local immutable identifiers with remote acknowledged
state and the server head. Upload only absent bytes, but never trust an identifier match without
matching immutable metadata. Reuse persisted idempotency keys until the logical operation is
resolved.

Commit Events only against the expected active Generation. A Generation/head rejection transitions
to explicit conflict discovery; it never changes the request to the new Generation automatically.

## 10.6 Incremental download

- Fetch changes after the persisted Delivery Cursor using snapshot-bounded pages.
- Treat Cable `latestCursor` only as a reason to fetch.
- Download missing Events and dependencies, verify ciphertext and semantics, and prepare Artifact
  wrappers before the database transaction.
- Replay all accepted Events in canonical Event order, including late Events whose Delivery Cursor
  is newer but ordering timestamp is older.
- Rebuild/update affected Projections and commit authoritative records, Projections, server head,
  and cursor atomically.
- Publish one app invalidation after commit.
- Duplicate changes and replayed pages are harmless. A changed immutable record fails integrity.

## 10.7 Authentication and network failures

- A failed access token triggers one serialized refresh attempt.
- A successful refresh replaces the encrypted persisted refresh credential before retrying the
  operation.
- Refresh expiry/revocation transitions to `AuthenticationRequired`, clears Account key material,
  and pauses sync without affecting local Vault access.
- Network timeout/DNS/TLS/server unavailability transitions to `Offline`/waiting and keeps local UI
  operational.
- Protocol, checksum, envelope, dependency, rollback, or semantic failure transitions to
  `SYNCHRONIZATION_INTEGRITY_FAILED`, cancels staging, preserves current authority, and requires an
  explicit Retry after the cause changes.

---

# 11. Synchronized Vault Vacuum and Stale Replica Resolution

## 11.1 Vacuum initiated on the current device

For a synchronized Vault, alter the current local-only Vacuum sequence:

1. require authentication and online connectivity;
2. reconcile to the exact current remote Generation/head cursor;
3. acquire the existing local mutation fence;
4. build and verify the successor locally as an inactive candidate;
5. upload the successor Generation Object and complete retained membership pages;
6. seal and activate it with the server three-field compare-and-swap;
7. after server activation, atomically activate the already verified local candidate; and
8. publish local invalidation and resume ordinary sync.

If the server CAS fails, do not activate the local candidate. Refetch, discard/rebuild deliberately,
and preserve the predecessor. If the server activation succeeds but the worker stops before local
activation, the persistent Job resumes by recognizing the exact verified local candidate and
server head; it does not enter stale-discard flow for its own already-approved candidate.

## 11.2 Detecting a stale Replica

A Replica is stale when it has unpublished local work based on a server-superseded Generation and
that work was not the locally prepared candidate already activated by the same Job.

On detection:

- stop Capture and every authoritative management mutation for the affected original Vault;
- allow Library reads and Complete Export;
- leave local-only Vaults unaffected;
- show the predecessor/server Generation context without exposing technical identifiers as the
  primary explanation;
- explain that automatic merge could restore content intentionally removed by Vacuum;
- offer only `Discard stale local Replica and use server data` plus optional Cancel/return to
  read-only;
- do not offer selective Events, local-wins, merge, or silent discard.

## 11.3 Optional exact Export

Before resolution, recommend a normal Complete Vault Package Export of the exact stale local
Generation. Preselect/feature it as the safest additional backup, but allow the user to skip after a
second explicit warning. Export remains identity-preserving and is not automatically imported or
associated with the Account.

## 11.4 Explicit stale discard semantics

Resolution offers the exact Complete Export first. Continuing without it requires two separate
acknowledgements: declining the recommended Export and permanently overwriting unpublished stale
state. Resolution never creates another Vault, re-authors local content, selectively reapplies
Events, or merges histories.

## 11.5 Server replacement transaction

The stale-discard Job SHALL:

1. retain the stale Generation only as the exact scope for optional Complete Export;
2. download and prepare the complete active server Replica for the original Vault ID, retrieving
   stale remote-only source wrappers through Recovery Snapshot scope when Export needs them;
3. journal each prepared server Artifact wrapper before its write;
4. verify the Account slot yields the same original Vault Root Key;
5. validate the complete server Replica and rebuild its Projections;
6. use one IndexedDB activation transaction to replace the original Vault's authority, Projections,
   head, availability rows, and maintenance Jobs with server state; and
7. unlock the replaced original for the current authenticated session.

Prepared OPFS wrappers may exist before the IndexedDB transaction but are not authoritative. On any
pre-activation failure, retain the stale original unchanged, remove journaled prepared wrappers, and
keep the conflict actionable. A restart after activation retains the complete server Replica. If the
user downloaded an exact Export, it remains external and unaffected.

---

# 12. User Interface and Live-State Contract

## 12.1 Popup states

Add explicit rendered states for:

- unconfigured server choice;
- hosted versus self-hosted context;
- custom URL permission/probe progress and errors;
- email/password login, pending, invalid credentials, and unavailable server;
- local-only continuation;
- incomplete Account Vault enrollment;
- initial upload/download progress;
- ready/up-to-date, syncing, offline, authentication-required, integrity failure, and conflict;
- existing locked/ready/capturing states combined with Account status without displacing the primary
  Capture action unnecessarily; and
- stale conflict summary with a link to the full Library resolution surface.

The popup remains usable at 360 px, never holds the only copy of progress state, and may close while
Jobs continue.

## 12.2 Signup tab

Create one extension-owned Account setup entrypoint with sequential, restorable steps:

1. server context and custom-origin editing;
2. email/password/confirmation plus no-recovery acknowledgement;
3. create-new or select-existing Vault;
4. Account/Vault enrollment progress; and
5. success with `Open Library`.

Subscribe before initial fetch, generation-guard rendering, persist non-secret progress in the Job,
and reconcile on focus/visibility. Passwords never enter URL parameters, browser storage, history,
or rendered success/error text.

## 12.3 Library Account/settings surface

Add a full-page Account/settings surface reachable from the Library and popup. Show:

- normalized email;
- hosted/custom origin;
- Account Vault versus local-only Vault badges;
- safe synchronization status and progress;
- last successful synchronization time;
- Retry, Resume enrollment, Log out, and Change server actions as applicable;
- the fact that additional Vaults are local-only because the Account already owns one Vault; and
- no password change, recovery, delete-Account, Device list, quota, or detach controls.

## 12.4 Conflict surface

Render a dedicated stale-Replica dialog/page with:

- plain-language cause and consequences;
- confirmation that local content is still readable;
- recommended `Export stale Vault` action;
- `Discard stale local Replica and use server data` action;
- two explicit acknowledgements when Export was skipped;
- server-replacement download, validation, and activation progress;
- safe retry after failure; and
- success identifying the verified synchronized Vault without creating another Vault.

Mutating controls for the stale original remain visibly disabled with an explanation until
resolution. Focus moves to the conflict heading/error, returns predictably after dialogs, and all
asynchronous changes use polite live announcements except blocking errors, which use alerts.

## 12.5 Visual requirements

Preserve the existing warm-paper/dark-green design language, typography, spacing cadence, native
control semantics, visible focus, reduced motion, and narrow layouts. Use scoped styles for server
context, authentication forms, sync status, progress, and conflict warnings. Do not rely on generic
input/button styling where it changes composition.

Every affected state requires rendered screenshot inspection in the primary and materially narrow
layout, including focus, pending, disabled, error, success, offline, and conflict states.

---

# 13. Error, Privacy, and Operational Behavior

- Use bounded timeouts for server probe, control requests, transfer parts, and Cable confirmation.
- Treat browser suspension like interruption, not cancellation.
- Persist safe retry checkpoints before announcing visible progress.
- Cancel prepared stale-discard downloads on logout without touching authoritative local data.
  Server Switch preparation follows its persisted restart and terminal-cleanup contract.
- Never cancel a committed local mutation because its upload failed.
- Never put email in general request logs beyond explicitly secured Account audit records; log
  Account/session IDs instead.
- Never log password, authentication derivative, access/refresh token, Account/Vault keys, envelope
  ciphertext, Vault names, URLs, titles, filenames, or decrypted metadata.
- Server readiness SHALL verify required database/storage/queue configuration but not expose
  Account counts or authentication configuration secrets.
- Production boot SHALL require TLS-proxy/host/synthetic-KDF-secret/session configuration and remain
  explicitly gated from public signup claims.
- Development may use loopback HTTP. Non-loopback HTTP is never accepted by the extension.
- Account/session tables belong in PostgreSQL; opaque Object payload bytes remain outside it.
- Keep current transfer-ticket semantics and bounded-memory behavior beyond 4 GiB.

---

# 14. Documentation Reconciliation

Documentation is part of implementation, not follow-up. Reconcile at minimum:

## Product and plans

- README/VISION claims about real authentication, extension synchronization, offline behavior, and
  production gates;
- the MVP PRD user stories and acceptance criteria;
- this approved Plan 09 plus a Plan 09 TDD evidence record during implementation; and
- any Plan 08 prose cited as current proof behavior, while preserving Plan 08 as implementation
  history and making Plan 09's supersession explicit.

## Normative and formal contracts

- glossary Account cardinality and new Account Encryption Key, Account slot, Account session,
  Stale Replica, remote-only Artifact, and stale-discard terminology;
- zero-knowledge/server-visible metadata including normalized email and session metadata;
- Vault/key-slot, cryptography, key derivation, Runtime, Jobs, storage, synchronization, protocol,
  messages, errors, and OpenAPI contracts;
- synchronization/Vacuum Generation fencing and stale recovery behavior; and
- Import/Export language clarifying that stale discard is not Import/Restore and an optional stale
  Complete Export remains identity-preserving.

## Architecture and implementation guidance

- system overview, security, Runtime boundary, synchronization, Device-trust deferrals,
  Coordination Server, protocol adapter, cryptography, testing, deployment/operations, and
  consistency review;
- browser extension design and Coordination Server README/runbook;
- exact hosted/self-hosted/local-only UI behavior and optional host-permission boundary; and
- local Replica bootstrap, manual storage relief, and public-hosting limitations.

## Roadmap

- Remove production email/password Account login and trusted extension Vault Replica
  synchronization from future work.
- Remove the open choice about whether the Account login password is distinct from the Account
  Master Password; this plan selects one password with domain-separated authentication/wrapping
  derivatives.
- Remove the open Account Encryption Key hierarchy question now owned by canonical specs.
- Retain password change, Account Recovery Key, all-browser-loss recovery, Device trust/revocation,
  quotas/abuse controls, shared storage, automatic retention policies, public deployment hardening,
  and independent review.
- Rewrite dependencies, evidence gates, and sequence so they do not imply completed Account/client
  synchronization remains unimplemented.
- Do not add completed checkboxes/history to the Roadmap.

Before completion, search all documentation for at least: `proof credential`, `production
authentication`, `client integration remains future`, `multiple Vaults`, `Account Master Password`,
`extension sync`, `Device authorization`, `fixed token`, `no network requests`, `no account`, and
`server is not required`. Reconcile each semantic occurrence rather than blindly replacing text.

---

# 15. Ordered TDD Implementation Tasks

Follow RED → GREEN → REFACTOR. Do not implement later tasks by bypassing an earlier contract.

## Task 1: Canonical documentation and vectors

**RED:** add failing/absent-vector checks that demonstrate Account cardinality, KDF domains,
envelopes, slot metadata, and public API shapes are not yet canonical.

**GREEN:** reconcile owning specs/OpenAPI first and add deterministic cryptographic vectors.

**REFACTOR:** remove superseded proof/future-work language before code gains a competing contract.

## Task 2: Server Account and session persistence

**RED:** cover normalized uniqueness, constraints, Account Vault limit, envelope strictness, token
digests, expiry, rotation, replay revocation, and transaction rollback.

**GREEN:** replace the initial migration/schema, add models/services, bcrypt, and database
constraints.

**REFACTOR:** keep secrets out of model inspection and centralize token generation/digest logic.

## Task 3: Public authentication and Cable APIs

**RED:** add OpenAPI/request/response tests for information, parameters, signup, login, refresh,
logout, Cable tickets, generic failures, unknown fields, and filtered logs.

**GREEN:** implement strict endpoints, real `AccountAuthenticator`, session issuance, and ticket
consumption; remove the proof token adapter.

**REFACTOR:** reuse protocol/outcome handling without making public endpoints accidentally bearer
protected or lax.

## Task 4: One-Vault server contract and proof update

**RED:** fail on a second Vault, absent/malformed Account slot, cross-Account access, and the old
fixed-token Compose flow.

**GREEN:** enforce the unique Account Vault, return slots, and make the independent Node proof
signup/login/refresh through public APIs.

**REFACTOR:** keep proof clients independent of Rails code and raw database setup.

## Task 5: Extension Account cryptography and persistence

**RED:** cover non-empty Account passwords, KDF vectors, domain separation, envelope/slot substitution, local
non-exportable key validation, restart unlock, logout erasure, and decoder strictness.

**GREEN:** implement Account crypto/services and sole canonical IndexedDB records.

**REFACTOR:** wipe all byte carriers and isolate Account state from Workspace/Vault authority.

## Task 6: Server selection, permissions, login, and signup

**RED:** packaged-Chrome tests fail on missing first-launch choices, exact permission request,
origin validation, probe, popup login, signup tab, unrecoverability acknowledgement, and existing/new
Vault choice.

**GREEN:** implement Host permission/network adapters, Runtime Commands, UI state, and persistent
enrollment Job.

**REFACTOR:** keep popup/signup views pure where practical and remove business decisions from DOM
handlers.

## Task 7: Initial Vault enrollment and remote bootstrap

**RED:** cover existing local upload, new Vault dual-slot creation, empty Account resume, Complete
remote download, same-ID key mismatch, bounded Artifact transfer, atomic activation, and interruption
at every stage.

**GREEN:** implement enrollment/upload/download/rebuild Services and persistent checkpoints.

**REFACTOR:** share package-import preparation/activation primitives only where semantics match; do
not conflate Import and synchronization.

## Task 8: Incremental two-client synchronization

**RED:** cover local-first capture, dependency-before-Event upload, cursor snapshots, canonical Event
order, duplicate/lost/reordered hints, polling-only convergence, offline changes, retries, and
service-worker restart.

**GREEN:** implement synchronization planning, upload/commit, pull/validate/activate, alarms, Cable
tickets, and invalidation.

**REFACTOR:** ensure no correctness depends on Cable or an open UI surface.

## Task 9: All existing mutations and live UI

**RED:** keep two surfaces/two clients open and fail on stale lock/unlock, active Vault, name,
Capture, delete/restore, Collection, busy, and content changes.

**GREEN:** route every authoritative commit through one sync wake and one app invalidation, update
Projections, and render status/settings.

**REFACTOR:** centralize mutation hooks so new Commands cannot silently omit synchronization.

## Task 10: Synchronized Vacuum

**RED:** cover offline rejection, pre-reconcile, candidate upload, head race, server-first activation,
worker interruption after server activation, local activation recovery, and other-client stale
detection.

**GREEN:** adapt Vacuum Job ordering and persist remote/local candidate checkpoints.

**REFACTOR:** keep local-only Vacuum on its existing fully local path while sharing verified
successor construction.

## Task 11: Explicit stale Replica discard

**RED:** cover mutation fencing, read/Export availability, skipped-Export confirmation, complete
server staging, absence of another Vault, and rollback at every preparation/activation boundary.

**GREEN:** implement the stale-discard Service, full server staging, one activation transaction, UI,
progress, cleanup, and success state.

**REFACTOR:** keep stale discard distinct from Import/Restore and prove no partial or additional
Vault authority is created.

## Task 12: Operations, documentation, and complete evidence

**RED:** make CI/search/format/visual evidence fail on stale proof claims, missing Roadmap pruning,
secret leakage, absent screenshots, or unrun black-box flows.

**GREEN:** finish all documentation, Compose/config/runbook changes, tests, screenshots, evidence
record, and exact verification.

**REFACTOR:** remove dead proof environment variables, unused scaffold mail UI, compatibility-shaped
branches, and duplicated prose.

---

# 16. Required Verification

Discover final commands from manifests, but run and report at least the following.

From the repository root:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:e2e:chrome
corepack pnpm build
corepack pnpm test:sync-proof
corepack pnpm exec prettier --check docs/plans/09-account-authentication-and-full-vault-synchronization.md <all-other-changed-documentation>
git diff --check
```

For the Coordination Server:

```bash
cd apps/coordination-server
bin/rubocop
bin/bundler-audit
bin/importmap audit
bin/brakeman --quiet --no-pager --exit-on-warn --exit-on-error
bundle exec rspec
bin/ci
```

Run the isolated proof teardown only against its explicit Compose file/project and volumes. Never
delete development data through an unresolved environment variable or broad Docker volume command.

Required test groups include:

- cryptographic vectors and negative substitution cases;
- strict OpenAPI load/request/response/path coverage;
- Account, session, token-replay, Cable-ticket, and one-Vault database constraints;
- generic authentication timing/outcome behavior and secret log capture;
- exact Host permission/origin/redirect behavior;
- IndexedDB non-exportable-key and restart tests;
- initial existing/new Vault enrollment and empty-Account recovery;
- Complete remote bootstrap with bounded-memory Artifacts beyond 4 GiB using counters/streams rather
  than equivalent allocations;
- incremental upload/download, idempotency, duplicated pages, out-of-order Event replay, and
  malicious server response rejection;
- two independent packaged Chrome contexts through real Rails/PostgreSQL/opaque storage;
- polling-only convergence after every Cable hint is lost;
- service-worker suspension during every persistent stage;
- offline local commits followed by convergence;
- logout/relogin with continued local Vault access;
- synchronized Vacuum race and server-first/local-resume activation;
- stale-discard exact current-state preservation before activation, complete server replacement,
  and rollback;
- two open extension surfaces proving live Projection updates without reload; and
- accessibility and screenshot evidence for every affected visible state.

Use the image-inspection tool to view, not merely capture, screenshots. Inspect alignment, spacing,
wrapping, clipping, focus, disabled geometry, progress movement, error prominence, and narrow layout.
Record inspected states and findings in the Plan 09 TDD evidence document.

---

# 17. Acceptance Criteria

Work is complete only when all statements are true:

1. First popup use requires an explicit hosted, self-hosted, or local-only decision.
2. Hosted context defaults visibly to `https://awsm.foo`.
3. A custom server receives only its exact runtime-granted origin permission.
4. Non-loopback HTTP, redirects, credentials, paths, queries, fragments, and incompatible servers
   fail before configuration commits.
5. Login occurs in the popup and signup in an extension-owned full tab.
6. Signup requires email, password confirmation, and acknowledgement that recovery is unavailable.
7. No email is sent or implied verified.
8. Email is normalized once and uniquely stored.
9. Raw password never leaves or persists in the extension.
10. Argon2id and HKDF outputs match committed vectors.
11. Authentication and wrapping derivations are domain-separated.
12. The server cannot derive the Account Encryption Key from stored/sent authentication material.
13. Account key envelope and Account slot authenticate all required metadata.
14. The existing local device slot remains mandatory and sufficient offline.
15. Access/refresh tokens are opaque, digest-only server-side, expiring, rotating, and revocable.
16. Refresh replay revokes the complete session.
17. Cable URLs never contain Account access or refresh credentials.
18. Proof fixed-token authentication and its environment variables are absent.
19. An Account owns at most one server Vault under a database constraint.
20. A Workspace may retain unrelated local-only Vaults.
21. Signup can create a new Vault or attach one chosen existing local Vault.
22. Interrupted post-signup enrollment resumes without duplicate Account/Vault creation.
23. Login on a new browser creates a fully local Replica and fresh device slot.
24. Same-ID key mismatch fails without writes or replacement.
25. Ordinary local operations succeed while offline and never await remote acknowledgement.
26. Every local authoritative mutation wakes persistent synchronization.
27. Dependencies are durable before their Event becomes remotely visible.
28. Downloaded bytes, envelopes, dependencies, Generations, and semantics are validated before local
    authority changes.
29. Event replay order remains canonical and independent of Delivery Cursor order.
30. Polling alone converges after all Cable hints are lost.
31. Runtime/service-worker interruption resumes every synchronization stage idempotently.
32. Ordinary synchronization never removes local content; explicit storage relief follows the
    current Runtime storage and synchronization specifications.
33. Logout removes Account secrets but leaves local Vaults usable and unlocked according to local
    device state.
34. All open surfaces update Account, lock, active Vault, name, busy, Capture, Collection, and
    content state without reload.
35. Synchronized Vacuum refuses to begin offline.
36. Synchronized Vacuum activates the server successor before local activation and resumes safely
    after interruption.
37. A different offline Replica based on a superseded Generation enters explicit conflict without
    automatic retry/merge.
38. The stale original remains readable and exportable while mutations are fenced.
39. Exact stale Export is recommended but may be skipped only after explicit warning.
40. Resolution creates no additional Vault.
41. The stale Vault is replaced only by a fully verified complete server Replica.
42. Every prepared replacement wrapper is journaled for restart cleanup.
43. Activation replaces authority and clears obsolete operational availability atomically.
44. Any pre-activation failure leaves the stale original unchanged and no partial replacement
    authoritative.
45. No selective reapply, local-wins, implicit merge, or same-ID divergent Workspace entry exists.
46. No plaintext content, unwrapped key, password, token, or forbidden metadata appears in server
    persistence, logs, Jobs, hints, errors, or diagnostics.
47. Public-hosted readiness is not claimed; remaining gates are explicit.
48. Every affected document and OpenAPI contract reflects the canonical result.
49. The Roadmap contains only unresolved forward-looking work.
50. All formatter, lint, type, security, unit, integration, black-box, packaged-browser, build, and
    visual checks pass with exact commands/evidence reported.

---

# 18. Fixed Decisions Checklist

- [x] Real email/password authentication; no email integration.
- [x] Immediate unverified signup.
- [x] One password with domain-separated authentication and encryption derivatives.
- [x] Random Account Encryption Key; password wraps it rather than directly wrapping every Vault.
- [x] Existing LUKS-like local device slot retained; synchronized Account slot added.
- [x] No password change or recovery in this slice.
- [x] Persistent rotating session until logout/revocation/expiry.
- [x] One active Account per extension.
- [x] One synchronized Vault per Account; additional Workspace Vaults are local-only.
- [x] Signup chooses new or one existing local Vault.
- [x] Hosted AWSM, custom self-hosted origin, or no sync.
- [x] Login popup; signup full extension tab.
- [x] Continue without sync remains reversible later.
- [x] Exact optional host permission; no broad permanent network access.
- [x] Fully local bootstrap plus explicit manual heavy-wrapper storage relief and retrieval.
- [x] All ordinary mutations local-first and background synchronized.
- [x] Cable hints advisory; polling sufficient.
- [x] Server-first compare-and-swap for synchronized Vault Vacuum.
- [x] No automatic stale merge or selective reapply.
- [x] Stale resolution offers Export first, then explicitly discards stale local state and uses
      verified server data without creating another Vault.
- [x] Optional exact Export recommended but skippable with warning.
- [x] No implicit preserve-as-copy or alternate Import capability.
- [x] Proof credential removed rather than retained as compatibility.
- [x] Protocol remains the sole canonical pre-release version `1`.
- [x] Pre-release databases and development data are recreated, not migrated.
- [x] Public-hosting quotas, abuse controls, Device trust, selective retention, shared storage, and
      independent security review remain deferred.
- [x] Documentation, Roadmap pruning, TDD evidence, and rendered visual inspection are mandatory.
