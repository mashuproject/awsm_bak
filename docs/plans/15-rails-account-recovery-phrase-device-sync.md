# Rails Account, Recovery-Phrase Device Sync, and Revocation

**Document:** `docs/plans/15-rails-account-recovery-phrase-device-sync.md`

**Status:** Implemented foundation; Account identity, dashboard, and lifecycle superseded by Plan 20

**Owner:** Engineering

**Last Updated:** 2026-07-27

**Depends On:** `docs/plans/09-account-authentication-and-full-vault-synchronization.md`,
`docs/plans/10-git-like-synchronization-server-switching.md`,
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md`,
`docs/plans/14-redis-backed-ephemeral-coordination.md`,
`docs/architecture/00-design-principles.md`, `docs/architecture/03-zero-knowledge.md`,
`docs/architecture/08-synchronization.md`, `docs/architecture/15-coordination-server.md`,
`docs/architecture/19-testing-strategy.md`, `docs/specifications/crypto/key-derivation.md`,
`docs/specifications/crypto/object-encryption.md`,
`docs/specifications/protocol/http-api.openapi.yaml`,
`docs/specifications/runtime/synchronization.md`, and `ROADMAP.md`

> **Current-contract notice:** Plan 20 replaces this plan's email-based Account identity, Account
> and session dashboard, retained session metadata, Account deletion deferral, and related
> authentication payloads with the sole canonical username-only Account and lifecycle contract.
> The Device, Recovery Phrase, Vault authority, and cryptographic separation decisions that Plan 20
> does not replace remain implemented foundation. See
> [Plan 20](20-username-account-and-devices-dashboard.md). Email-era passages below are historical
> implementation context, not accepted fields, compatibility behavior, or current instructions.

---

# 1. Purpose

This is the decision-complete implementation plan for separating conventional Rails Account
authentication from client-only Vault cryptography, moving Account signup to the Coordination
Server, and synchronizing one Vault across fresh Chrome and Firefox extension installations with a
12-word Recovery Phrase and cryptographic Device identities.

It is written for an implementer starting from a cold checkout with no conversation context. Do not
reopen the fixed product and cryptographic decisions recorded here.

The completed work SHALL:

1. let Rails receive and authenticate a normal Account password over HTTPS without making that
   password a Vault encryption input;
2. provide server-owned signup, browser login/logout, a minimal Account page, and authenticated
   password change using Rails 8 authentication-generator conventions adapted to `Account`;
3. remove Account creation from the browser extension while retaining extension Account login;
4. remove the Account Encryption Key, password-derived client authentication secret, Account key
   envelope, and Account Vault slot completely;
5. preserve the rule that the Coordination Server can never derive or receive an unwrapped Vault
   key;
6. let the first extension create or select a local Vault, generate a Recovery Phrase, enroll its
   Device, and attach the encrypted Vault to the Account;
7. let a fresh Chrome or Firefox extension log into the same Account and recover the synchronized
   Vault by entering the Recovery Phrase, without approval from an already enrolled Device;
8. distinguish Account-scoped API sessions from Vault-Device-scoped API sessions;
9. support ordinary Device removal, future-content protection through key/recovery rotation, and
   an explicit maximum-security full Vault re-encryption;
10. preserve one active synchronized Vault per Account;
11. prove Chrome-to-Chrome, Firefox-to-Firefox, Chrome-to-Firefox, and Firefox-to-Chrome enrollment
    and synchronization in the separate coordination interaction E2E suite;
12. replace every superseded pre-release schema, format, route, UI, test, fixture, and document
    without compatibility code or development-data migration; and
13. make every non-plan document evergreen by rewriting it to describe only the resulting canonical
    system, leaving plans and their TDD evidence as the sole historical record.

The Account exists for identity, authorization, sessions, quotas, and billing. It is not a
cryptographic owner of the Vault. Knowledge of the Account password, access to the Account
database, or control of Rails must not reveal a Vault key.

# 2. Fixed Decisions, Scope, and Deferrals

## 2.1 Fixed product decisions

- The Rails Account password and the Vault Recovery Phrase are different credentials with different
  trust boundaries.
- Rails receives the raw Account password over HTTPS and stores only the normal bcrypt digest
  produced by `has_secure_password`.
- Rails owns Account signup at `/sign_up`. The extension never submits an Account-creation API
  request.
- The extension owns Vault setup, Recovery Phrase handling, Device enrollment, synchronization,
  Device management, and cryptographic rotation.
- A new Device requires both a successful Account login and the Recovery Phrase. No email,
  administrator, support operator, server reset, or existing-Device approval can substitute for the
  Recovery Phrase.
- The Recovery Phrase is exactly 12 randomly generated English BIP39 words. It is never
  user-authored.
- The user receives both the words and an encrypted, self-describing `.awsm-recovery` file. The
  file does not contain the words or their entropy.
- Full phrase re-entry is required before synchronization is enabled on the first Device and before
  a newly entered phrase is accepted for recovery or rotation.
- One Account owns zero or one active synchronized Vault. Local-only Vaults remain independent.
- Device management is an extension surface. The Rails Account page shows Account and browser/API
  session facts, not Vault names, Vault contents, Recovery Phrases, keys, or cryptographic Device
  controls.
- Password change requires the current Account password, changes only Rails authentication, revokes
  every browser and API session, and forces a fresh login everywhere.
- Registration is configurable per Coordination Server and disabled by default in production.
- There is no backward compatibility. Existing development databases, browser profiles, fixtures,
  and proof state are discarded and recreated.

## 2.2 In scope

- Rails HTML signup, login, logout, Account, session, and password-change surfaces;
- configuration and discovery of server-owned registration;
- raw-password Account API login over HTTPS;
- Account-scoped and VaultDevice-scoped bearer/refresh sessions;
- Device Ed25519 signing identity and X25519 wrapping identity;
- Recovery Phrase generation, validation, presentation, confirmation, and memory wiping;
- the encrypted Recovery Kit server record and `.awsm-recovery` file;
- initial synchronized-Vault attachment;
- recovery-based Device enrollment without another Device;
- Device proof-of-possession login;
- per-Device envelopes for every Vault key epoch;
- key-epoch identification in every encrypted authoritative Object;
- Device listing and ordinary removal;
- Recovery Phrase and content-key rotation for future-content protection;
- an optional full clone-and-replace re-encryption ceremony;
- Chrome and Firefox production-shaped flows;
- server switching under the new Account/Device model;
- evergreen rewriting of README, Vision, architecture, specifications, testing, operations,
  examples, and Roadmap material affected by the superseded direction;
- historical annotations in prior plans and their TDD evidence where needed to prevent them from
  being mistaken for current instructions; and
- a Plan 15 TDD evidence document.

## 2.3 Explicitly deferred

- email verification, email delivery, magic links, and email-based password reset;
- administrator-assisted Account or Vault recovery;
- passkeys, WebAuthn, OAuth, OpenID Connect, SSO, or social login;
- more than one synchronized Vault per Account;
- more than one active Account in one extension installation;
- shared Vaults, Organizations, invitations, roles, or collaborative key distribution;
- mobile, desktop, CLI, or web Vault clients;
- billing UI, quota UI, plan selection, payment handling, and Account deletion;
- recovery-phrase language selection or a word count other than 12;
- Shamir sharing, social recovery, printed QR recovery, or hardware-backed recovery;
- automatic approval from an existing Device;
- hiding server-visible Account, Device, byte-count, timing, and traffic metadata;
- hosted deployment or mutation of a deployed Coordination Server;
- post-release migrations or compatibility negotiation; and
- a claim that Device revocation can erase plaintext or keys already copied by a removed Device.

## 2.4 Licensing gate

Add `@scure/bip39` pinned to `2.2.0` for BIP39 checksum, entropy, mnemonic validation, and the English
wordlist. The package and upstream BIP39 specification are MIT licensed. Continue using the
existing `libsodium-wrappers-sumo` dependency for Ed25519, X25519, XChaCha20-Poly1305, secure random
bytes, and memory wiping.

Record resolved package versions and licenses in the Plan 15 TDD evidence. Do not copy code or a
wordlist from a GPL/AGPL wallet, Telegram client, or other strong-copyleft reference
implementation. Do not add a second general-purpose cryptographic library unless an implementation
blocker is documented and the project owner approves the exact dependency.

# 3. Security and Correctness Invariants

Implementation and tests SHALL preserve all of these invariants:

1. The Coordination Server never receives a Recovery Phrase, BIP39 entropy, unwrapped Vault Root
   Key, Vault epoch root key, Device private key, recovery administrator private key, derived
   wrapping key, or decrypted Vault content.
2. The Account password is used only for Rails Account authentication. No client KDF, Vault
   envelope, Device key, Recovery Kit, Object key, or server switch derives from it.
3. Account-scoped API credentials cannot read, upload, commit, download, purge, replace, or
   subscribe to synchronized Vault records.
4. Every existing Vault data endpoint, transfer endpoint, Cable ticket, and Vault channel requires
   a live VaultDevice-scoped session for an active Device belonging to that exact Vault.
5. A server database and opaque-byte-store compromise plus an Account password is insufficient to
   decrypt the Vault.
6. A Recovery Phrase is owner-equivalent for the Vault while its recovery generation remains
   active. The UI must say this plainly.
7. The phrase is generated from 128 bits of cryptographically secure entropy and encoded as 12
   English BIP39 words with the BIP39 checksum.
8. Phrase text and entropy exist only for the active ceremony, are never written to IndexedDB,
   extension storage, Rails, Redis, logs, diagnostics, telemetry, URLs, clipboard automatically, or
   the `.awsm-recovery` file, and are wiped from mutable buffers on every exit path.
9. The encrypted Recovery Kit authenticates its public metadata and contains every epoch root key
   needed to decrypt the current synchronized history.
10. Device certificates bind the Vault, recovery generation, Device identifier, user-visible
    label, client kind, signing public key, and wrapping public key.
11. Device enrollment proves possession of the certified Device signing private key.
12. Device-session issuance requires a fresh, one-use server challenge and a valid signature by an
    active certified Device.
13. A revoked Device cannot obtain a Device session, refresh an old Device session, receive a Cable
    ticket, use a transfer ticket, or authorize a Vault mutation.
14. Ordinary Device removal cannot erase keys or ciphertext already downloaded by that Device.
15. Future-content protection rotates the content-key epoch and Recovery Phrase authority. The old
    phrase, old certificate, and old epoch cannot enroll a Device or decrypt Objects accepted after
    activation.
16. Full re-encryption cannot erase an adversary's independent copies. It only removes the old
    synchronized generation and keys from cooperating current clients and the Coordination Server.
17. Server-provided certificates, key envelopes, Recovery Kits, epoch metadata, and encrypted
    Objects are untrusted until their canonical encoding, signatures, binding fields, AEAD, and
    expected identifiers validate.
18. No failure path falls back to the discarded Account Encryption Key or Account Vault slot.
19. Synchronization remains local-first. A Device with locally available keys and Objects remains
    usable offline, subject to explicit stale-epoch handling before its new work can synchronize.
20. Diagnostics contain fixed outcomes and safe identifiers only. They never contain passwords,
    phrases, phrase words, entropy, private/public key byte dumps, signatures, challenges, bearer
    credentials, Recovery Kit ciphertext, Object ciphertext, or decrypted values.

# 4. Canonical User Journeys

## 4.1 First Account and first synchronized Vault

1. The user opens the Coordination Server's `/sign_up` page in a normal browser tab.
2. Rails accepts email, password, and password confirmation, creates the Account, creates a browser
   session, and redirects to `/account`.
3. The user opens the extension, chooses that Coordination Server, and selects **Log in**.
4. The extension sends email and password to `POST /api/sessions` and receives an Account-scoped
   session. It does not receive Vault keys or a key envelope.
5. Because the Account has no synchronized Vault, the extension offers to create a new local Vault
   or select one existing local-only Vault.
6. The extension creates the first Device identity and a fresh 12-word Recovery Phrase.
7. It derives the recovery wrapping key and recovery administrator signing seed, creates the first
   key epoch, encrypted Recovery Kit, first Device certificate, and first Device key envelope.
8. It shows the Recovery Phrase and offers the `.awsm-recovery` download.
9. The user re-enters all 12 words. Only then may the extension submit the atomic initial-attach
   request.
10. The server validates the self-consistent signed attach package, creates the Vault records, and
    issues a VaultDevice-scoped session.
11. The extension stores only protected local Device material, the encrypted Recovery Kit, public
    metadata, and session credentials. It wipes phrase entropy and derived recovery private
    material.
12. Normal synchronization begins.

If attach fails, the local Vault stays local and usable. The extension keeps no phrase. The user
must explicitly restart setup and generate a new phrase rather than silently reusing an
unconfirmed phrase.

## 4.2 Fresh extension on the same Account

1. The user installs a fresh packaged Chrome or Firefox extension.
2. The user selects the same Coordination Server and logs into the Account.
3. The Account-scoped discovery response says that one Vault is attached and returns its active
   encrypted Recovery Kit and public recovery metadata.
4. The extension asks for the 12-word Recovery Phrase. It does not offer Account creation or
   existing-Device approval.
5. The extension normalizes and validates the BIP39 phrase, derives recovery keys, decrypts and
   validates the Recovery Kit, and requires a complete second entry before enrollment.
6. It creates a new Device signing/wrapping identity, signs a Device certificate and all required
   key envelopes with the active recovery administrator key, and proves possession of the Device
   signing key.
7. The server validates the current recovery generation, certificate, envelopes, proof, and
   one-Vault Account binding, then creates the Device and issues a VaultDevice session.
8. The extension installs protected local epoch keys, downloads and validates the full active
   generation, activates the local Replica atomically, and begins normal synchronization.
9. It wipes phrase text, entropy, the recovery wrapping key, and recovery signing seed even when
   any step fails.

## 4.3 Returning enrolled Device

After Account login, an installation with a matching local Device identity requests a one-use
Device challenge, signs the canonical challenge transcript, and exchanges it for a VaultDevice
session. It does not ask for the Recovery Phrase unless local Device secrets are missing, invalid,
or no longer certified.

## 4.4 Local-only use

Local-only Vault creation and use require no Account, Rails session, Device certificate, Recovery
Phrase, remote revocation, or server permission. The synchronization setup flow is optional and
must not weaken local-only behavior.

# 5. Rails Account Web Surface

## 5.1 Generator convention

Use Rails 8.1's `bin/rails generate authentication` output as the convention source, but adapt it
to the existing canonical `Account` model and a separately named `BrowserSession`.

Do not commit a parallel `User`, generated `Session`, duplicate password digest, password-reset
mailer, or reset-token route. Because the application already has an API session concept, do not
let generator naming obscure the boundary:

- `Account` is the authenticatable principal;
- `BrowserSession` is a cookie-backed Rails web session; and
- `ApiSession` is a bearer/refresh session with an explicit scope.

If the generator cannot target these names directly, generate into a disposable temporary copy to
inspect the Rails-version-correct files, then port the relevant conventions. Never keep temporary
generated files in the repository.

## 5.2 Account password model

`Account` SHALL use:

```ruby
has_secure_password
```

The canonical password rules are exactly:

- password and confirmation are required for signup;
- confirmation must match;
- bcrypt's 72-byte maximum is enforced;
- no custom minimum length, character class, complexity score, breached-password lookup, or
  whitespace normalization is added; and
- the password string is never stripped, lowercased, logged, or returned.

Email remains normalized with trim plus lowercase, required, case-insensitively unique, at most 254
characters, and subject to the existing simple email shape check.

Delete `has_secure_password :authentication_secret` and every Account KDF/key-envelope constant and
validation.

## 5.3 Routes and views

Add these HTML routes outside `/api`:

| Method   | Path                | Purpose                                  |
| -------- | ------------------- | ---------------------------------------- |
| `GET`    | `/sign_up`          | Account signup form                      |
| `POST`   | `/sign_up`          | Create Account and browser session       |
| `GET`    | `/session/new`      | Browser login form                       |
| `POST`   | `/session`          | Create browser session                   |
| `DELETE` | `/session`          | Revoke current browser session           |
| `GET`    | `/account`          | Minimal authenticated Account page       |
| `GET`    | `/account/password` | Password-change form                     |
| `PATCH`  | `/account/password` | Change password and revoke every session |

Set the root route to redirect signed-in browsers to `/account` and signed-out browsers to
`/session/new`.

Use normal Rails layouts, form helpers, authenticity tokens, parameter filtering, encrypted signed
cookies, secure/HTTP-only/SameSite cookie settings appropriate to the environment, `Current`, and
the generated authentication concern pattern.

The signup page contains email, password, password confirmation, submit, and a sign-in link. The
login page contains email, password, submit, and a signup link only when registration is enabled.
The Account page contains normalized email, Account creation time, current/recent browser and API
session facts, links to change password and log out, and no Vault cryptographic data.

Password-change success revokes all `BrowserSession` and `ApiSession` rows, clears the current
cookie, and redirects to login with a generic success message. It must not rotate, delete, or
replace any Vault key material.

## 5.4 Registration configuration

Add:

```text
AWSM_ACCOUNT_REGISTRATION_ENABLED
```

Parse only case-insensitive `true` and `false`. Development and test default to `true`. Production
defaults to `false` when absent. Invalid non-empty values fail boot while naming only the setting.

When disabled:

- `GET /sign_up` and `POST /sign_up` return 404;
- the browser login page has no signup link; and
- the API discovery response reports registration disabled and omits `signUpUrl`.

When enabled, `signUpUrl` is exactly the configured public Coordination Server origin plus
`/sign_up`. It must be same-origin, HTTPS in production, contain no query or fragment, and never be
derived from an untrusted request `Host` header.

A duplicate email receives HTTP 422 and the same generic visible message used for an unavailable
signup: **We couldn't create that account. Check the details or sign in.** Do not confirm that the
email exists. Server logs and metrics must not add a duplicate-email value.

# 6. API Authentication and Session Scopes

## 6.1 Remove the discarded API

Delete:

- `POST /api/accounts`;
- `POST /api/authentication-parameters`;
- `Api::AccountsController`;
- `Api::AuthenticationParametersController`;
- `Coordination::AccountSignup`;
- `Coordination::AccountAuthenticator`'s derived-secret behavior;
- `Coordination::AccountPayload` key-envelope encoding/decoding;
- `signup_registrations`;
- Account-signup idempotency behavior;
- `authenticationSecret`, `accountKeyId`, `accountKeyEnvelope`, Account KDF fields, and Account
  Vault slot fields from OpenAPI and JSON; and
- extension methods, Commands, fixtures, and tests that call those routes.

Do not retain disabled routes, aliases, tombstone controllers, deprecated response fields, or a
reader for the discarded payload.

## 6.2 Account login

Keep `POST /api/sessions`, but its canonical request becomes:

```json
{
  "email": "reader@example.test",
  "password": "the exact Account password"
}
```

Successful login returns:

```json
{
  "account": {
    "accountId": "lowercase UUID",
    "email": "normalized email"
  },
  "sessionId": "lowercase UUID",
  "scope": "Account",
  "accessToken": "opaque credential",
  "accessExpiresAt": "RFC 3339 timestamp",
  "refreshToken": "opaque credential",
  "refreshExpiresAt": "RFC 3339 timestamp"
}
```

Keep the current 15-minute access and 30-day refresh lifetimes, opaque token construction,
SHA-256-at-rest token digests, rotating one-use refresh behavior, replay-family revocation, logout,
and protocol/request headers.

Unknown email and wrong password both return `AUTHENTICATION_FAILED`, HTTP 401, not retryable.
Authenticate a fixed dummy bcrypt digest for unknown email so the obvious lookup timing difference
is removed. Never echo validation details.

## 6.3 Scope behavior

Every `ApiSession` has exactly one scope:

- `Account`: authenticated only by Account password; or
- `VaultDevice`: authenticated by an active certified Device and bound to exactly one
  `VaultDevice`.

Refresh preserves the session's scope and binding. It never promotes Account to VaultDevice.

Account scope permits only:

- Account facts needed by the extension;
- active synchronized-Vault enrollment discovery;
- initial Vault attachment when no active Vault exists;
- Device challenge issue and completion;
- recovery-authorized new-Device enrollment; and
- logout/refresh.

VaultDevice scope permits the existing synchronization endpoints only for its bound Vault, plus
Device listing/removal/rotation/replacement endpoints. It does not permit Rails password change.

The authorization boundary SHALL reject a valid credential with the wrong scope using
`AUTHORIZATION_FAILED`, HTTP 403, not retryable. Invalid, expired, replayed, or revoked credentials
remain `AUTHENTICATION_FAILED`, HTTP 401.

Revoking a Device immediately revokes all its `ApiSession` rows and credentials in the same
database transaction. Every request also checks current Device status, so a missed credential-row
update cannot preserve authority.

# 7. Recovery Phrase and Key Derivation

## 7.1 Phrase generation and input

Use `@scure/bip39@2.2.0` with its English wordlist.

Generation:

1. obtain exactly 16 bytes from libsodium's cryptographically secure random generator;
2. encode those bytes with BIP39 English into exactly 12 lowercase words;
3. display words separated by one ASCII space and numbered 1 through 12; and
4. retain the mutable 16-byte entropy only for the active ceremony.

Input:

1. accept pasted or individually entered words;
2. apply the BIP39-required Unicode NFKD normalization;
3. lowercase with locale-independent English handling;
4. trim leading/trailing whitespace and collapse internal Unicode whitespace to one ASCII space;
5. require exactly 12 words from the English list;
6. validate the BIP39 checksum;
7. decode to exactly 16 entropy bytes; and
8. reject every other word count, language, abbreviation, fuzzy match, autocomplete substitution,
   or checksum failure.

Error text is generic: **That Recovery Phrase is not valid. Check all 12 words and try again.** Do
not identify the first wrong word.

## 7.2 Domain-separated derivation

Let:

```text
E = the 16 decoded BIP39 entropy bytes
S = the 16 raw bytes of the lowercase Vault UUID
```

Use HKDF-SHA256 with `IKM = E`, `salt = S`, and these exact UTF-8 `info` strings:

```text
awsm:recovery-kit-wrapping:v1
awsm:recovery-administrator-ed25519-seed:v1
```

Derive exactly 32 bytes for each domain:

- `RecoveryKitWrappingKey`; and
- `RecoveryAdministratorSeed`.

Construct the Ed25519 recovery administrator keypair from the second value as a seed. The public
key may be stored and uploaded. The seed and secret key are ceremony-only secrets and must be
wiped.

Do not use the BIP39 seed/PBKDF2 wallet derivation, a BIP32 path, cryptocurrency terminology, an
optional BIP39 passphrase, Argon2, or the Account password. AWSM uses BIP39 only as a
checksummed human encoding of 128 random bits.

# 8. Recovery Kit Contract

## 8.1 Encrypted keyring plaintext

Encode the keyring as canonical CBOR containing exactly:

```text
version: 1
vaultId: lowercase UUID
recoveryGenerationId: lowercase UUID
activeKeyEpochId: lowercase UUID
keyEpochs:
  - keyEpochId: lowercase UUID
    ordinal: non-negative safe integer
    rootKey: exactly 32 bytes
```

`keyEpochs` is sorted by ascending `ordinal`, ordinals are unique and contiguous from zero, IDs are
unique, and `activeKeyEpochId` names the last entry. Reject unknown fields, duplicate keys,
non-canonical CBOR, missing historical epochs, non-contiguous ordinals, and trailing bytes.

## 8.2 Public envelope

The Recovery Kit public metadata contains exactly:

```text
version: 1
vaultId: lowercase UUID
recoveryGenerationId: lowercase UUID
derivationAlgorithm: "kdf:hkdf-sha256:recovery-entropy:v1"
wrappingAlgorithm: "wrap:xchacha20poly1305:recovery-kit:v1"
administratorSigningAlgorithm: "sign:ed25519:recovery-administrator:v1"
administratorPublicKey: exactly 32 bytes
nonce: exactly 24 bytes
ciphertextLength: positive safe integer
ciphertextSha256: exactly 32 bytes
```

Canonical-CBOR encoding of this metadata, excluding `ciphertextSha256`, is the XChaCha20-Poly1305
AAD. Encrypt the canonical keyring with `RecoveryKitWrappingKey` and a fresh random 24-byte nonce.
The ciphertext includes the 16-byte authentication tag. `ciphertextLength` and
`ciphertextSha256` describe the exact ciphertext.

The server stores and returns the metadata plus ciphertext as base64url fields in JSON. It treats
the ciphertext as opaque but validates canonical field shapes, exact byte lengths, declared
length, checksum, current Vault binding, and uniqueness.

After decryption, the client must compare every inner Vault/recovery identifier with the
authenticated outer metadata before importing a key.

## 8.3 `.awsm-recovery` file

The file is binary:

```text
8 bytes   ASCII "AWSMREC1"
4 bytes   unsigned big-endian canonical-CBOR header length
N bytes   canonical-CBOR public metadata from section 8.2
M bytes   exact Recovery Kit ciphertext
```

There are no extra fields, padding, footer, phrase words, phrase entropy, private key, Account
email, server origin, Vault name, browser name, or user content.

The filename is:

```text
awsm-recovery-<vault-id>.awsm-recovery
```

Readers require the magic, bounded header length, canonical metadata, exact ciphertext length,
checksum, EOF after ciphertext, and successful AEAD/keyring validation. Unknown fields or formats
fail closed.

The server copy and downloaded file contain the same public metadata and ciphertext bytes. A file
may substitute for downloading the encrypted Recovery Kit from the server, but it never
substitutes for the 12 words.

# 9. Device Identity, Certificate, and Key Envelopes

## 9.1 Device keys

Each extension installation creates:

- one random lowercase UUID `deviceId`;
- one Ed25519 signing keypair for authentication and proof of possession; and
- one X25519 keypair for receiving Vault epoch keys.

Private keys are wrapped at rest by the existing non-extractable device-local AES-KW key boundary.
Raw private-key bytes may exist only during creation, unwrap, or a signing/decapsulation operation
and are wiped immediately afterward. Public keys are exactly 32 bytes.

Supported `clientKind` values are exactly `ChromeExtension` and `FirefoxExtension`. `displayName`
is user-editable, trimmed, 1 through 64 Unicode scalar values, and server-visible. Default to a
plain browser-derived label such as `Chrome extension` or `Firefox extension`; do not include host
names, OS account names, full user-agent strings, or hardware identifiers.

## 9.2 Device certificate

Canonical-CBOR certificate content contains exactly:

```text
version: 1
certificateId: lowercase UUID
vaultId: lowercase UUID
recoveryGenerationId: lowercase UUID
deviceId: lowercase UUID
displayName: validated string
clientKind: "ChromeExtension" | "FirefoxExtension"
signingAlgorithm: "sign:ed25519:device:v1"
signingPublicKey: exactly 32 bytes
wrappingAlgorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1"
wrappingPublicKey: exactly 32 bytes
issuedAt: canonical UTC RFC 3339 timestamp
```

The recovery administrator Ed25519 key signs the exact canonical bytes. The signature is exactly
64 bytes. The server rejects unknown fields, a non-current recovery generation, duplicate
certificate/Device IDs, invalid keys, a future `issuedAt` beyond five minutes, a Vault mismatch, or
an invalid signature.

Enrollment also includes a Device proof signature over canonical CBOR:

```text
domain: "awsm:device-enrollment-proof:v1"
certificateSha256: SHA-256 of exact certificate bytes
certificateSignatureSha256: SHA-256 of the administrator signature
accountSessionId: current Account ApiSession UUID
```

The certified Device signing key signs those bytes. This prevents enrollment with a copied
certificate but no Device private key.

## 9.3 Per-Device epoch envelope

For every `(Device, key epoch)` pair, create one envelope.

1. Generate a fresh ephemeral X25519 keypair.
2. Compute the X25519 shared secret with the Device wrapping public key and reject an all-zero
   result.
3. Derive a 32-byte wrapping key with HKDF-SHA256:
   - IKM: shared secret;
   - salt: raw 16 bytes of `keyEpochId`;
   - info: UTF-8 `awsm:device-key-envelope:v1`.
4. Encrypt the exact 32-byte epoch root key with XChaCha20-Poly1305 and a random 24-byte nonce.
5. Authenticate canonical metadata containing version, Vault ID, recovery generation ID, key epoch
   ID, Device ID, algorithm, ephemeral public key, and nonce.
6. Sign the metadata plus ciphertext SHA-256 with the active recovery administrator Ed25519 key.
7. Wipe ephemeral secret, shared secret, wrapping key, and plaintext epoch root bytes.

The server validates field shapes, current recovery authority, administrator signature, Device
certificate binding, and uniqueness. It cannot validate or decrypt the wrapped root key.

# 10. Canonical Rails Data Model

Rewrite the canonical initial schema and regenerate `db/schema.rb`. Do not add a migration from the
discarded schema.

## 10.1 Accounts and sessions

`accounts`:

- `id` UUID primary key;
- `email` normalized unique string, not null;
- `password_digest` string, not null;
- timestamps.

Delete all Account key/KDF/envelope columns.

`browser_sessions`:

- UUID primary key;
- `account_id` foreign key, not null;
- `ip_address` string, nullable;
- `user_agent` string, nullable;
- timestamps.

`api_sessions`:

- UUID primary key;
- `account_id` foreign key, not null;
- `vault_device_id` nullable foreign key;
- `scope`, exactly `Account` or `VaultDevice`;
- `confirmed_at`, not null;
- `revoked_at`, nullable;
- timestamps.

Constraint: Account scope has no `vault_device_id`; VaultDevice scope has one.

Keep `session_credentials`, but point it to `api_session_id`. Keep kinds `Access` and `Refresh`,
digests, expiry, consumption, and revocation fields.

Delete `account_sessions` and `signup_registrations`.

## 10.2 Vault authority

`vault_replicas` keeps its synchronization head/generation fields and gains:

- `active_key_epoch_id`, nullable until initial attach completes;
- `active_recovery_generation_id`, nullable until initial attach completes; and
- `replaced_at`, nullable.

Delete every `account_key_id` and Account-slot column/constraint/index.

Replace the unconditional unique `account_id` index with a partial unique index allowing exactly
one `Active` Vault Replica per Account. A `Provisional` replacement may coexist only during the
full-re-encryption workflow. Valid states become exactly `Provisional`, `Active`, and `Replaced`.
Normal initial attach still refuses a second active or provisional Vault.

`recovery_generations`:

- client-generated UUID primary key;
- `vault_replica_id`, not null;
- non-negative `ordinal`, not null and unique per Vault;
- algorithm identifiers from section 8;
- `administrator_public_key`, 32 bytes;
- `kit_nonce`, 24 bytes;
- `kit_ciphertext`, nullable only after retirement cleanup;
- `kit_ciphertext_length`;
- `kit_ciphertext_sha256`, 32 bytes;
- `activated_at`, nullable;
- `retired_at`, nullable;
- timestamps.

Exactly one active recovery generation exists per active Vault. Retiring one deletes its server
Recovery Kit ciphertext in the same transaction after the replacement is durable; keep only its
public identifier/key/timestamps for audit and certificate validation history.

`vault_key_epochs`:

- client-generated UUID primary key;
- `vault_replica_id`, not null;
- non-negative contiguous `ordinal`, unique per Vault;
- `recovery_generation_id`, not null;
- `activated_at`, not null;
- `retired_at`, nullable;
- timestamps.

Exactly one epoch is active. Old epoch rows remain because historical Objects name them.

`vault_devices`:

- client-generated UUID `device_id` as primary key;
- `vault_replica_id`, not null;
- `certificate_id`, unique;
- `recovery_generation_id`, not null;
- display/client/algorithm/public-key fields from section 9;
- exact `certificate_cbor`;
- 64-byte `certificate_signature`;
- `enrolled_at`, not null;
- `revoked_at`, nullable;
- `revocation_reason`, nullable and exactly `Removed`, `FutureProtection`, or
  `VaultReencrypted`;
- timestamps.

`device_key_envelopes`:

- UUID primary key;
- `vault_device_id`, not null;
- `vault_key_epoch_id`, not null;
- `recovery_generation_id`, not null;
- algorithm, ephemeral public key, nonce, ciphertext, ciphertext SHA-256;
- exact signed metadata and 64-byte administrator signature;
- timestamps;
- unique `(vault_device_id, vault_key_epoch_id)`.

Add `key_epoch_id`, not null, to `opaque_records`. It is operational cryptographic metadata, not
content. The server accepts new records only for the Vault's current active epoch. Existing
historical records retain their original epoch.

## 10.3 Database constraints

Use database check constraints for enums, byte lengths, non-negative ordinals/counts, session
scope/binding, active-state consistency, and nullable retired ciphertext. Use unique indexes for
all identity and one-active-record invariants. Model validations supplement rather than replace
database constraints.

All foreign keys remain Account/Vault scoped. No endpoint may locate a Device, epoch, certificate,
envelope, or Recovery Kit globally and then authorize after the fact.

# 11. Public HTTP Contract

Update OpenAPI first in each RED slice and keep JSON field names exactly as listed here.

## 11.1 Server information

`GET /api/server-information` returns:

```json
{
  "service": "AWSM Coordination Server",
  "protocolVersion": "1",
  "capabilities": {
    "accountPassword": true,
    "accountVaultLimit": 1,
    "completeReplicaSynchronization": true,
    "deviceEnrollment": "RecoveryPhrase",
    "deviceRevocation": true
  },
  "registration": {
    "enabled": true,
    "signUpUrl": "https://coordination.example/sign_up"
  }
}
```

When disabled, `registration` contains exactly `{ "enabled": false }`.

Reset the sole pre-release protocol contract to its canonical initial version. Do not bump
`protocolVersion`, add a compatibility capability, or describe the removed Account envelope.

## 11.2 Account enrollment discovery

Add `GET /api/account/vault-enrollment`, Account scope.

Empty:

```json
{ "state": "Empty" }
```

Attached:

```json
{
  "state": "Attached",
  "vaultId": "uuid",
  "recoveryKit": {
    "...": "the complete section 8.2 public envelope and base64url ciphertext"
  }
}
```

Return only the active Recovery Kit. Never return retired ciphertext, Device private data, Vault
name, Object metadata, or synchronization head data to Account scope.

## 11.3 Initial attach

Keep `POST /api/vaults`, Account scope, but replace its body with:

```text
vaultId
recoveryGeneration { public Recovery Kit metadata and ciphertext }
keyEpoch { keyEpochId, ordinal: 0 }
deviceCertificate { exact CBOR, administrator signature }
deviceKeyEnvelope { exact signed envelope for epoch 0 }
deviceProofSignature
```

Require an idempotency key. Replaying the exact successful request returns the same result.
Reusing the key with different bytes fails. The operation atomically creates the provisional Vault,
recovery generation, epoch, Device, envelope, and VaultDevice session. Existing generation upload
and completion then activate the Vault through the normal verified synchronization path.

If any active/provisional Vault already belongs to the Account, return `ACCOUNT_VAULT_LIMIT`,
HTTP 409. Do not treat the submitted recovery package as a server backup.

## 11.4 Device challenge and session

Add:

```text
POST /api/device-session-challenges
POST /api/device-sessions
```

Both require an Account-scoped bearer credential.

Challenge request:

```json
{ "vaultId": "uuid", "deviceId": "uuid" }
```

Challenge response:

```json
{
  "challenge": "43-character unpadded base64url of 32 random bytes",
  "expiresAt": "RFC 3339 timestamp"
}
```

Store only a namespaced SHA-256-derived Redis key with a 60-second TTL. Its value binds the current
Account ApiSession UUID, Account UUID, Vault UUID, and Device UUID. Consume exactly once with
`GETDEL`. Extend `Coordination::EphemeralCoordination`; do not add another Redis client or persist
challenges in PostgreSQL.

The Device signs canonical CBOR:

```text
domain: "awsm:device-session-challenge:v1"
accountSessionId
vaultId
deviceId
challenge
```

Completion request contains `vaultId`, `deviceId`, `challenge`, and base64url 64-byte `signature`.
Successful completion returns the standard session response with `scope: "VaultDevice"` and fresh
access/refresh credentials. Malformed, expired, replayed, wrong-session, wrong-Device, revoked, or
bad-signature challenges all return `AUTHENTICATION_FAILED`.

Redis failure returns `AUTHENTICATION_UNAVAILABLE`, HTTP 503, retryable, without affecting Account
login or password change.

## 11.5 New Device enrollment

Add `POST /api/vaults/{vaultId}/devices`, Account scope. Its body contains:

- current-recovery-generation Device certificate and administrator signature;
- one signed Device key envelope for every epoch in the Recovery Kit;
- Device proof signature bound to the current Account ApiSession; and
- an idempotency key.

The submitted epoch IDs must exactly equal the server's complete ordered epoch set. The server
validates all public signatures and bindings in one transaction. Success creates the Device and
returns a VaultDevice-scoped session. It never accepts a certificate signed by a retired recovery
administrator.

## 11.6 Device management

Add, VaultDevice scope:

```text
GET    /api/vaults/{vaultId}/devices
DELETE /api/vaults/{vaultId}/devices/{deviceId}
POST   /api/vaults/{vaultId}/future-protections
POST   /api/vaults/{vaultId}/replacement-candidates
POST   /api/vaults/{vaultId}/replacement-candidates/{replacementVaultId}/activate
```

Device listing returns only public certificate facts, enrollment/revocation timestamps, and
whether the row represents the current Device. Do not return key-envelope ciphertext in the list.

Existing synchronization, transfer, recovery, purge, and Cable endpoints remain structurally the
same except that they require VaultDevice scope, resolve the bound Vault, and carry `keyEpochId`
where an encrypted record is declared.

# 12. Object Encryption and Key Epochs

## 12.1 Canonical envelope replacement

Add `keyEpochId` to the authenticated plaintext header of:

- every compact encrypted Object envelope;
- every chunk-framed Artifact wrapper;
- every encrypted Event;
- every Vault Generation Object; and
- every authoritative encrypted projection currently covered by synchronization/export.

The value is a lowercase UUID and participates in canonical encoding and AAD. Reject a missing,
unknown, malformed, or unexpected epoch before decryption.

Derive Object keys from the root key belonging to the named epoch. Include raw Vault ID and raw key
epoch ID bytes in every HKDF context before the existing Object-type/object-ID context. Reconcile
the exact domain construction in `key-derivation.md`; do not concatenate ambiguous variable-length
strings.

This is the only canonical pre-release Object format. Reset its declared initial format/version as
needed; do not retain a reader for Objects without `keyEpochId`.

## 12.2 Writes and stale Devices

The server accepts uploads/commits only when declared `keyEpochId` equals the Vault's active epoch.
This prevents a still-offline remaining Device from publishing post-rotation content under a key
known to the removed Device.

Before pushing any local work, a Device must fetch public Vault authority and compare its active
epoch. If stale:

1. download and validate its signed envelope for the new epoch;
2. unwrap and install the new epoch locally;
3. identify authoritative records created locally but never accepted remotely;
4. replay their semantic Commands through the Runtime to produce new immutable records under the
   active epoch and new Object/Event IDs;
5. preserve the old records only as unreachable local inputs until the replay validates;
6. atomically replace the local head with the replayed head; and
7. let normal Vacuum remove unreachable old-epoch local records later.

Never rewrite ciphertext in place, reuse a nonce, reuse an Object ID for different bytes, or upload
an old-epoch post-rotation record. If semantic replay cannot be proven equivalent, stop with a
blocking export-first conflict rather than losing or weakening content.

## 12.3 Export, Import, and recovery

Complete and Selective Exports include the exact epoch metadata and encrypted keyring necessary for
their current package boundary. Import validates every epoch reference and installs fresh
device-local protection; it never imports a synchronized Device identity or server session.

Update Complete Export/Import, selective export closure, storage relief, remote retrieval, Vacuum,
stale-Replica recovery, Generation recovery, and server switching to preserve and validate epoch
IDs. No path may assume one global Vault Root Key after this plan.

# 13. Extension Surfaces and Local Persistence

## 13.1 Remove extension signup

Delete the extension Account-signup form, password confirmation, signup mode, signup Command,
`AccountAuthenticationService.signup`, account-envelope crypto, and internal/external server-switch
signup branch.

On an unconfigured server choice, show:

- **Log in**;
- **Create account on this server** only when discovery reports registration enabled; and
- **Use without synchronization**.

**Create account on this server** opens the exact discovered `signUpUrl` in a normal browser tab.
The extension does not inject content, prefill credentials, receive a callback, poll browser
cookies, or infer signup completion. The user returns and logs in.

Rename the current extension `signup` entrypoint to a synchronization-setup entrypoint. Remove the
old path/manifest entry instead of keeping an alias.

## 13.2 Required extension states

Provide live, accessible states for:

- Account login;
- Account login failure;
- registration disabled/enabled;
- no synchronized Vault;
- choose new versus existing local Vault;
- Recovery Phrase reveal;
- `.awsm-recovery` download success/failure;
- full 12-word confirmation;
- initial attach progress/failure/success;
- Recovery Phrase entry on a fresh Device;
- invalid phrase;
- Device enrollment/bootstrap progress;
- Device list;
- ordinary removal confirmation;
- future-protection explanation, new phrase reveal/download/confirmation, and rotation progress;
- full re-encryption warnings, export gate, progress, activation, and purge-pending state;
- stale local key epoch replay/conflict;
- revoked current Device; and
- offline/server-unavailable behavior.

All long-lived surfaces subscribe before fetching and reconcile through canonical Runtime state per
the repository live-UI policy. Lock, Account logout, Vault replacement, Device revocation, and
active-Vault change immediately discard decrypted/context-bound UI.

## 13.3 Local stores

Replace `account_keys`, discarded Account envelope fields, wrapped Account Encryption Key, and
Account Vault slot records.

Add canonical local records for:

- Account session metadata and protected Account refresh credential;
- VaultDevice session metadata and protected Device refresh credential;
- Device certificate/public metadata;
- device-local wrapped Ed25519 and X25519 private keys;
- local protected epoch root keys keyed by `(vaultId, keyEpochId)`;
- active epoch and recovery generation IDs;
- encrypted Recovery Kit metadata/ciphertext;
- Device-enrollment/bootstrap Jobs;
- future-protection Jobs; and
- full-replacement Jobs/checkpoints.

Use one new canonical IndexedDB store graph with `DATABASE_VERSION = 1`. Since this is pre-release,
delete and recreate development/test browser databases and profiles. Do not write an
`onupgradeneeded` branch that reads or converts the discarded Account stores. If retaining the
existing database name would force an upgrade branch, select one new canonical database name and
update every consumer atomically.

Recovery Phrase text/entropy and recovery administrator private material have no repository
interface and no persistent store.

# 14. Device Revocation

## 14.1 Ordinary Remove Device

Any active VaultDevice may remove another Device. Removing the current Device is allowed only
through an explicit **Remove this Device** flow that first confirms local-only consequences and
signs out afterward.

In one server transaction:

1. lock the Vault and target Device;
2. require the target to be active;
3. mark it revoked with reason `Removed`;
4. revoke its ApiSessions and credentials;
5. invalidate outstanding challenges and transfer tickets where practical;
6. commit; and
7. publish an advisory Device-authority invalidation.

Do not rotate keys or the Recovery Phrase. Warn:

> This stops future server access. It cannot remove Vault data or keys already saved on that
> Device. Anyone with the current Recovery Phrase can enroll again.

The removed Device remains able to open whatever local data and keys it already has.

## 14.2 Protect future content

This is a stronger ceremony and requires a newly generated Recovery Phrase.

The initiating active Device:

1. fetches and validates the complete active Device/epoch authority;
2. generates a new 12-word phrase and requires `.awsm-recovery` handling plus full re-entry;
3. generates a new recovery generation and recovery administrator key;
4. generates a fresh 32-byte epoch root key and the next contiguous epoch;
5. builds a new Recovery Kit containing every historical epoch key plus the new active epoch;
6. creates new certificates under the new recovery administrator for every remaining active Device
   except the target;
7. creates a signed new-epoch envelope for each remaining Device;
8. submits one idempotent compare-and-swap request naming the expected current recovery generation,
   expected active epoch, and target Device; and
9. retains old local material until the server returns and a refetch validates the new authority.

The server atomically:

- verifies the initiating Device session and all expected-current IDs;
- verifies that the submitted remaining Device set exactly equals active Devices minus target;
- validates every new certificate, envelope, Recovery Kit field, and signature;
- activates the new recovery generation and epoch;
- retires the old recovery generation and deletes its server Recovery Kit ciphertext;
- revokes the target with reason `FutureProtection`;
- revokes all old Device sessions, including the initiator, so every remaining Device must prove
  current authority again;
- removes old recovery-generation Device key envelopes after the new set is durable; and
- commits before publishing invalidation.

After success:

- the old phrase cannot sign a certificate accepted by the server;
- the old epoch decrypts history but not newly accepted Objects;
- remaining Devices fetch their new certificate/envelope and obtain a fresh Device session;
- the initiating Device saves the new encrypted Recovery Kit locally and wipes the new phrase;
- the UI permanently warns that a removed Device still retains historical plaintext/keys; and
- no Object is re-encrypted solely by this mode.

If compare-and-swap fails, discard the submitted phrase/recovery secrets and restart after refetch.
Never merge two concurrent rotations.

# 15. Maximum-Security Full Re-encryption

## 15.1 User contract

Name this optional mode **Re-encrypt synchronized Vault**. Explain before entry:

- it creates a cryptographically independent replacement Vault;
- every reachable authoritative Object and identifier changes;
- every other Device is revoked and must enroll again with the new Recovery Phrase;
- the old synchronized server copy is purged without a Recovery Snapshot after activation;
- the operation can be expensive and requires enough local storage to hold source and replacement;
- a verified Complete Export is mandatory first; and
- it cannot erase copies already downloaded or exported by another party.

This is not ordinary key rotation and not a promise of remote erasure.

## 15.2 Preconditions

Do not start until:

1. the initiating Device has a current VaultDevice session and all source epoch keys;
2. the complete active source generation and all reachable Artifact bytes are locally available
   and verified;
3. no local synchronization, Vacuum, Import, Export, storage-relief, or server-switch Job is active;
4. a Complete Export has been produced through the production Runtime and verified by immediate
   read-back;
5. the user explicitly confirms that the export is safely stored;
6. a fresh Recovery Phrase and `.awsm-recovery` file have been created; and
7. the user has re-entered the full new phrase.

Use the test-only Download Host from the existing Roadmap initiative to automate the native-save
boundary. Do not replace the shipped Download Host.

## 15.3 Client rewrite

Create:

- a fresh `replacementVaultId`;
- fresh epoch-zero root/recovery/Device keys;
- fresh Device and certificate IDs for the initiating installation; and
- a deterministic in-Job old-to-new identifier map.

Decrypt source records only inside the trusted Runtime. Reconstruct a logically equivalent Vault by
creating new immutable Artifacts, Bundle Descriptors, Events, Collections, and Vault Generation
records under new globally unique IDs. Rewrite every internal reference through the map. Preserve
user-visible content and semantic timestamps where the owning specification permits, but do not
claim identity continuity. Validate the replacement by rebuilding all Projections and comparing
the canonical user-visible model and Artifact plaintext checksums with the source.

The mapping and plaintext are sensitive Job state. Keep them local, protect persistent checkpoints,
and delete them on success or explicit abort. Never upload the mapping.

## 15.4 Server staging and activation

Create one `Provisional` replacement Vault Replica bound to the same Account while the source stays
`Active`. Upload and verify the replacement through normal bounded transfer and Generation
contracts using its fresh IDs/epoch.

Activation is one compare-and-swap transaction:

1. require the expected source Vault/head/generation and completed replacement;
2. mark the replacement `Active`;
3. mark the source `Replaced` and all its Devices revoked with `VaultReencrypted`;
4. revoke every source Device session/credential/ticket;
5. make the replacement Device session authoritative;
6. enqueue a dedicated source purge with **no Recovery Snapshot**; and
7. commit before invalidation.

Before activation, failure leaves the source active and the candidate abortable. After activation,
the replacement is authoritative and the UI reports source purge progress; it never rolls back to
the source.

The purge removes every source generation membership, opaque record, transfer, recovery ciphertext,
Device envelope, and byte-store object once reachability and replacement activation are rechecked.
It must not delete bytes referenced by the replacement or another server record. Retry safely until
complete and expose sanitized progress.

Only after replacement activation, local validation, and server purge scheduling may the extension
delete source keys and source local records. Other Devices see revocation and must bootstrap the
replacement with the new phrase.

# 16. Server Switching

Server switching no longer creates an Account from the extension.

The candidate server flow is:

1. discover candidate registration and capabilities;
2. if no candidate Account exists, offer to open its `/sign_up` page and stop;
3. log into the candidate Account with its conventional password;
4. require the same one-Vault state classification as today;
5. publish the active Vault's Recovery Kit, recovery authority, epochs, current Device certificate,
   Device envelopes, and opaque synchronized generation to an empty candidate Account;
6. prove the current Device key and obtain a candidate VaultDevice session;
7. verify the candidate copy before promoting local server context; and
8. revoke the prior server sessions after successful promotion.

Device certificates bind to Vault rather than Account/server identifiers so a current certificate
is portable. Account IDs and credentials remain server-local. A candidate with a conflicting active
Vault still uses the existing explicit compare/export/discard protections; it never merges key
authorities silently.

Update candidate Jobs/checkpoints to store Account and VaultDevice sessions separately. Remove
`mode: "Signup"` and all Account Encryption Key assumptions.

# 17. Failure Outcomes, Logging, and Operational Behavior

Reuse existing outcomes where semantics already match. Add only these stable outcomes if absent:

| Outcome                       | HTTP | Retryable | Meaning                                        |
| ----------------------------- | ---- | --------- | ---------------------------------------------- |
| `REGISTRATION_DISABLED`       | 404  | false     | HTML/API registration is not available         |
| `AUTHORIZATION_FAILED`        | 403  | false     | valid session has insufficient scope           |
| `RECOVERY_PHRASE_INVALID`     | 422  | false     | local-only UI/domain outcome; never from Rails |
| `RECOVERY_GENERATION_CHANGED` | 409  | false     | rotation/enrollment CAS is stale               |
| `KEY_EPOCH_CHANGED`           | 409  | false     | writer must refetch/replay under active epoch  |
| `DEVICE_REVOKED`              | 401  | false     | current Device authority was removed           |
| `DEVICE_ENROLLMENT_INVALID`   | 422  | false     | certificate/envelope/proof failed              |
| `VAULT_REPLACEMENT_CONFLICT`  | 409  | false     | replacement source/candidate CAS failed        |

Do not send `RECOVERY_PHRASE_INVALID` to the server because the server never receives a phrase.
Map local AEAD failure, inner/outer mismatch, invalid phrase, and wrong recovery file to the same
generic user-facing recovery failure.

Add Rails parameter filtering for `password`, `password_confirmation`, and
`current_password`. Existing credential filters remain. Request-body logging must not serialize
certificate signatures, Device challenges, Recovery Kit ciphertext, or key envelopes.

Safe operational reports may include only fixed component/operation names and generated error IDs.
Public Account, Vault, and Device UUIDs may appear only where existing structured operational
policy explicitly permits them; never include raw cryptographic bytes.

Redis-only Device-challenge failure degrades Device-session creation but leaves Account web/API
login and HTTP polling by already authenticated Devices available. Update readiness component prose
without making Redis authoritative.

# 18. Required Automated and Manual Tests

## 18.1 Rails web authentication

Prove:

- enabled signup renders and creates `Account` plus `BrowserSession`;
- production-default disabled signup is 404 for GET and POST;
- discovery exactly matches registration configuration and configured public origin;
- duplicate signup uses the generic 422 message;
- CSRF rejection for every mutating HTML route;
- login success/failure, dummy-digest unknown-email path, logout, and cookie flags;
- Account page requires login and contains no Vault key/recovery data;
- password rules are exactly presence, confirmation, and bcrypt 72-byte maximum;
- password change requires current password;
- success changes only `password_digest`, revokes every browser/API session, and forces login;
- filtered logs contain no credential sentinel; and
- there is no reset/email route or mail delivery.

## 18.2 Protocol and authorization

Prove:

- `/api/accounts` and `/api/authentication-parameters` do not route;
- API login sends `password` and returns no Account key/KDF/envelope field;
- Account and VaultDevice scopes refresh without promotion;
- every Vault/transfer/Cable endpoint rejects Account scope;
- a Device session cannot access another Account/Vault;
- revoked Device credentials fail even when their token row was not preloaded;
- initial attach is atomic and idempotent;
- one active synchronized Vault per Account is enforced under concurrency;
- Device challenges are 256-bit, TTL-bound, hashed in Redis, exact-session/Device bound, and atomic
  one-use;
- challenge replay, expiry, wrong signature, wrong Device, and Redis failure map safely; and
- no sensitive sentinel appears in logs, errors, Redis keys/values, or response details.

## 18.3 Cryptographic vectors

Create deterministic fixture vectors with fixed non-secret test entropy/keys/nonces and prove:

- 128-bit entropy encodes to 12 BIP39 English words and checksum validation round-trips;
- whitespace/NFKD normalization and invalid word/checksum rejection;
- exact HKDF outputs for both recovery domains;
- Recovery Kit canonical bytes, AAD, encryption, checksum, and decryption;
- `.awsm-recovery` byte-for-byte encoding and strict parsing;
- Ed25519 Device certificate signature and tamper rejection for every bound field;
- Device proof and session challenge signatures;
- X25519 shared-secret, HKDF, XChaCha envelope unwrap, wrong-Device failure, low-order rejection,
  and tamper rejection;
- multi-epoch Recovery Kit ordering/validation;
- every mutable secret buffer is passed through the wipe boundary on success and injected failure;
  and
- no production fixture contains a real user phrase or key.

## 18.4 Runtime and persistence

Prove:

- Account password never reaches a crypto function;
- phrase/entropy has no persistence call;
- restart restores protected Device identity and epoch keys but no phrase;
- returning Device challenge login works after restart;
- fresh Device recovery installs all epochs and bootstraps the active generation;
- corrupted server Recovery Kit/certificate/envelope/Object fails before state activation;
- new Objects carry the active `keyEpochId`;
- old-epoch historical Objects remain readable;
- stale-epoch unpublished work is replayed under the active epoch before upload;
- unreplayable stale work stops export-first without deletion;
- Export, Import, Vacuum, storage relief, remote retrieval, and recovery preserve epoch bindings;
- two open UI surfaces update after Device/recovery/epoch/session mutations without reload; and
- logout and revocation immediately discard decrypted/context-bound UI.

## 18.5 Pairing interaction E2E

Extend the existing separate `test:e2e:coordination` suite. Do not fold these journeys into the
ordinary local capture E2E.

For each ordered pair:

| Source package | Fresh package |
| -------------- | ------------- |
| Chrome         | Chrome        |
| Firefox        | Firefox       |
| Chrome         | Firefox       |
| Firefox        | Chrome        |

run a production-shaped packaged-extension journey:

1. create the Account through the real Rails `/sign_up` HTML form;
2. log the source extension into the Account;
3. create/choose a Vault, generate and confirm the phrase, and attach;
4. capture representative page content and wait for server synchronization;
5. launch a clean second browser profile and log into the same Account;
6. prove wrong phrase failure without server mutation;
7. enter/confirm the right test phrase and enroll the second Device;
8. bootstrap and compare Vault name, Library state, Events, Objects, Artifact bytes, generation, and
   cursor;
9. mutate on the second Device and prove live convergence on the first without reload;
10. restart both browser processes and prove returning-Device challenge login and convergence; and
11. assert the server never receives the phrase/key sentinels.

The test harness may obtain a deterministic test phrase from a test-only injected entropy source,
but shipped builds must use real randomness and must not contain the fixture seed.

## 18.6 Revocation E2E

Using two packaged clients, prove:

- ordinary removal immediately blocks target server access and refresh;
- the removed Device can still read already downloaded local history;
- the unchanged phrase can re-enroll after ordinary removal;
- future protection rotates phrase/recovery/epoch, blocks the old phrase, and preserves old-history
  readability on the removed Device;
- newly captured content after rotation is not decryptable with old epoch test keys;
- remaining Devices receive new authority and sync;
- an offline remaining Device replays unpublished work before sync;
- concurrent rotation loses safely through compare-and-swap;
- full re-encryption is blocked without verified Complete Export and new phrase confirmation;
- candidate failure before activation leaves the source authoritative;
- activation revokes every source Device, bootstraps only the replacement Device, and schedules
  no-snapshot source purge;
- old server records/bytes disappear after purge while replacement records remain; and
- warnings explicitly state that downloaded copies cannot be erased.

## 18.7 Rendered visual evidence

Capture and inspect desktop and narrow screenshots for every state in section 13.2, including
focus, disabled, loading, validation, error, success, confirmation, and destructive warnings.
Verify meaningful dimensions, keyboard order, accessible names, error association, word wrapping,
no clipped phrase words, and no accidental phrase persistence after navigation/back/reload.

# 19. Documentation and Roadmap Reconciliation

## 19.1 Evergreen documentation rule

This direction supersedes the old Account-key, extension-signup, and single-client recovery
direction everywhere outside `docs/plans/`.

At implementation completion, every non-plan document SHALL describe how the resulting system
behaves at that time. Non-plan documentation is canonical reference material, not an implementation
diary. Therefore:

- rewrite superseded prose in place instead of appending historical notes, transition sections,
  before/after comparisons, deprecated alternatives, or compatibility explanations;
- remove statements that the behavior implemented by this plan is future, proposed, deferred,
  optional, or unresolved;
- remove discarded terminology, request/response examples, diagrams, threat models, assumptions,
  open questions, and Roadmap dependencies rather than qualifying them as old;
- make each architecture document, specification, README, Vision passage, operations guide,
  testing guide, example, and generated API artifact internally consistent with the one canonical
  behavior;
- keep the Roadmap forward-looking and limited to work still unimplemented after this plan;
- update or replace review records such as `docs/architecture/consistency-review.md` so they review
  the current canonical documentation and do not preserve the superseded design as history; and
- do not add a changelog, migration guide, compatibility note, deprecated section, or historical
  appendix outside `docs/plans/`.

Only implementation plans under `docs/plans/` and their TDD evidence preserve historical decisions.
Do not rewrite their historical body to pretend it originally specified the new design. Add a short
prominent superseded notice to an older plan when readers could otherwise mistake it for current
implementation guidance, linking to this plan and relying on the repository's document-authority
rules. The notice is metadata; the old plan remains an honest historical record.

## 19.2 Required document rewrite

Update every affected current document and stale claim. At minimum:

- design principles and zero-knowledge architecture distinguish Account authentication from Vault
  recovery;
- system overview and Coordination Server architecture define Account and VaultDevice authority;
- glossary defines Recovery Phrase, Recovery Kit, Device, Device certificate, key epoch, Account
  session, and VaultDevice session;
- key derivation removes Account password/Account Encryption Key and owns the recovery/epoch
  domains;
- Object encryption owns `keyEpochId`;
- synchronization owns first attach, new Device bootstrap, stale epoch, revocation, and rotation;
- protocol/OpenAPI owns every route, field, scope, and outcome;
- Export/Import/Backup/Restore/Vacuum specifications own multi-epoch and full replacement behavior;
- testing strategy owns the four-direction packaged pairing and revocation matrices;
- deployment/operations owns registration configuration and safe session/challenge behavior;
- README and Coordination Server README explain server signup and extension login;
- Plans 09 and 10 plus their evidence receive a brief superseded notice where they describe
  extension signup, derived authentication secrets, Account Encryption Keys, Account Vault slots,
  password recovery, or server-switch signup, without rewriting their historical body;
- fixtures/examples contain no removed fields; and
- current code/document searches have no stale `authenticationSecret`, `accountKeyEnvelope`,
  `accountKeyId`, `Account Encryption Key`, `Account Vault slot`, extension signup, or
  authentication-parameters claims outside preserved plans/evidence.

## 19.3 Roadmap rewrite

While this approved plan is unimplemented, replace the Roadmap's separate **Device Trust and
Revocation** and **Account Credential Lifecycle and Recovery** discovery entries with one Approved
entry linking to this plan. Keep only genuinely deferred work in separate entries.

After implementation and evidence:

1. remove the completed approved entry entirely;
2. do not add a completed section;
3. add a Discovery entry for alternative Account authentication and reset methods, explicitly
   preserving Vault-key separation;
4. retain production signup abuse controls under Production Coordination Server Hardening; and
5. remove duplicate device/recovery questions resolved here.

# 20. Mandatory TDD and Evidence Workflow

Create:

```text
docs/plans/15-rails-account-recovery-phrase-device-sync-tdd-evidence.md
```

Record:

- date, branch, and commit;
- clean/dirty baseline without host-local paths or secrets;
- Rails generator version/conventions inspected;
- exact dependency versions and verified licenses;
- each RED test and the behavior absent before implementation;
- corresponding GREEN implementation and REFACTOR notes;
- schema reset and stale-format deletion evidence;
- deterministic non-secret crypto vectors;
- phrase non-persistence and memory-wipe fault injection;
- Account versus VaultDevice authorization matrix;
- every ordered Chrome/Firefox pairing journey;
- ordinary removal, future protection, offline stale epoch, and full replacement journeys;
- complete-export gate and no-snapshot purge evidence;
- rendered screenshots inspected for desktop and narrow states;
- exact commands, exit statuses, and sanitized relevant results; and
- every explicitly approved deviation.

Never record a password, phrase, word sequence, entropy, private/public key bytes, signature,
challenge, token, Recovery Kit bytes, Account/Vault/Device production identifier, private URL,
database content, or hosted operational data.

Follow RED → GREEN → REFACTOR for every implementation slice. Do not reconstruct RED evidence after
the code passes.

# 21. Cold-Start Implementation Order

An implementer starting cold SHALL proceed in this order:

1. Read repository `AGENTS.md`, any local override, this plan, every dependency named in the header,
   and the relevant nested `AGENTS.md` files completely.
2. Inspect `git status --short --ignored`; preserve unrelated user changes and ignored local state.
3. Create the Plan 15 TDD evidence file and record the sanitized baseline.
4. Write a repository-wide inventory of removed Account-envelope/signup terms, routes, schema
   columns, local stores, Commands, entrypoints, fixtures, and documentation.
5. Add RED Rails HTML authentication/registration/password-change request and system specs.
6. Port Rails 8 generator conventions to `Account`/`BrowserSession`; implement registration
   configuration and web surfaces.
7. Add RED API login/session-scope tests; replace Account authentication payloads and canonical
   Account/BrowserSession/ApiSession schema.
8. Delete API and extension Account signup, authentication-parameters, Account crypto, Account
   envelope, Account Vault slot, and their stores/tests.
9. Add `@scure/bip39`, verify licensing, and write RED deterministic recovery derivation, Recovery
   Kit, file, certificate, proof, and Device-envelope vectors.
10. Implement the small pure cryptographic modules and strict canonical decoders; keep UI and
    persistence out of them.
11. Write RED Rails model/request tests for recovery generations, epochs, Devices, envelopes,
    Account discovery, initial attach, challenge login, and new-Device enrollment.
12. Implement the canonical Rails schema and Account/VaultDevice authorization boundaries.
13. Write RED local persistence/restart tests; replace the IndexedDB graph with Account session,
    Device session, Device identity, epoch-key, Recovery Kit, and Job stores.
14. Implement first-Device setup and initial attach behind Runtime Commands/Events, then render and
    inspect every state.
15. Implement returning-Device challenge login.
16. Implement fresh-Device phrase recovery, enrollment, full bootstrap, and restart behavior.
17. Add `keyEpochId` to the sole canonical Object/Artifact/Event/Generation format and reconcile all
    derivations, storage, synchronization, Export, Import, Vacuum, recovery, and server-switch
    consumers in one format replacement.
18. Implement Device listing and ordinary removal with live invalidation.
19. Write RED rotation/CAS/multi-Device/offline tests; implement future protection and stale-epoch
    replay.
20. Write RED export-gated clone-and-replace tests; implement full re-encryption, activation, and
    no-snapshot source purge.
21. Replace server-switch signup/key assumptions and prove empty/conflicting candidate behavior.
22. Extend `test:e2e:coordination` with the four ordered browser pairing cases and revocation
    journeys. Keep ordinary capture E2E independent.
23. Recreate only explicitly identified repository-owned pre-release databases, browser profiles,
    proof volumes, and fixtures. Never mutate hosted state.
24. Run focused tests after every slice, then the complete Rails, extension, synchronization proof,
    coordination E2E, Chrome, Firefox, and cross-browser suites.
25. Rewrite every non-plan document as evergreen current-system documentation, add only concise
    superseded notices to affected historical plans/evidence, reconcile the Roadmap, run stale-term
    searches, format changed files, inspect rendered UI evidence, review the full diff, and finish
    the evidence record.

Do not begin UI wiring before the pure cryptographic vectors and server scope boundary are GREEN.
Do not begin full re-encryption before ordinary enrollment, epoch rotation, Export, and multi-client
sync are GREEN.

# 22. Required Verification Commands

Discover the final commands from current manifests, but the completed implementation SHALL run at
least:

```bash
cd apps/coordination-server
mise exec -- bundle exec rspec
mise exec -- bin/rubocop
mise exec -- bin/bundler-audit
mise exec -- bin/brakeman --quiet --no-pager --exit-on-warn --exit-on-error
mise exec -- bin/ci
```

```bash
cd ../..
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:sync-proof
corepack pnpm test:e2e:coordination
corepack pnpm test:e2e:chrome
corepack pnpm test:e2e:firefox
corepack pnpm test:e2e:cross-browser
```

```bash
docker compose config
docker compose -f compose.sync-proof.yml config
docker compose -f compose.sync-proof.yml -f compose.browser-proof.yml config
```

```bash
docker build -f apps/coordination-server/Dockerfile -t awsm-coordination-server .
docker run --rm --entrypoint test awsm-coordination-server \
  -r /docs/specifications/protocol/http-api.openapi.yaml
```

Format and check every changed supported file with repository-pinned tools:

```bash
corepack pnpm exec prettier --write <changed supported files>
corepack pnpm exec prettier --check <changed supported files>
git diff --check
```

Run final stale-language searches, expanding patterns when implementation discovers more names:

```bash
rg -n \
  'authenticationSecret|authentication-parameters|accountKeyEnvelope|accountKeyId|account_key_id|Account Encryption Key|Account Vault slot|account_slot_|signup_registrations|mode: "Signup"|extension-owned signup' \
  README.md VISION.md ROADMAP.md docs/architecture docs/specifications apps
```

```bash
rg -n \
  'Recovery Phrase|Recovery Kit|keyEpochId|VaultDevice|Device revocation|sign_up|registration' \
  README.md ROADMAP.md docs apps
```

Every remaining old-term match must be a deliberately reconciled historical statement in an
implementation plan or its TDD evidence. It must never remain in current code, README, Vision,
Roadmap, architecture, specification, operation, test, fixture, example, generated contract, or
compatibility fallback.

# 23. Acceptance Criteria

This plan is complete only when:

- Rails owns configurable signup and conventional Account password authentication;
- the extension offers login and an external signup link but cannot create an Account;
- password change revokes all sessions without touching Vault cryptography;
- Account passwords are absent from every Vault KDF and envelope;
- Account key/KDF/envelope/slot code, schema, API, storage, tests, and current documentation are
  absent;
- the server has no path to an unwrapped Vault key;
- a generated 12-word English BIP39 Recovery Phrase is confirmed and never persisted;
- the encrypted Recovery Kit and `.awsm-recovery` file follow the exact canonical contract;
- first attach creates a certified Device and epoch-zero synchronized Vault atomically;
- fresh Chrome and Firefox installations enroll with Account login plus Recovery Phrase;
- returning Devices authenticate with one-use signed challenges;
- Account sessions cannot access Vault data and every Vault endpoint requires the bound active
  Device;
- all authoritative encrypted Objects identify and authenticate their key epoch;
- ordinary removal blocks server access without claiming historical erasure;
- future protection rotates recovery authority and content epoch, blocks old recovery, and protects
  newly accepted content;
- stale remaining Devices safely replay unpublished work under the active epoch;
- full re-encryption is export-gated, clone-and-replace, revokes other Devices, and purges the old
  server Vault without a Recovery Snapshot;
- Chrome→Chrome, Firefox→Firefox, Chrome→Firefox, and Firefox→Chrome coordination E2E journeys pass;
- server switching uses login only and preserves the new Device/recovery authority;
- all visible states have desktop/narrow rendered evidence;
- all pre-release data/format replacements have one canonical reader/writer and no migration;
- every non-plan document is evergreen and describes only current behavior or genuinely unresolved
  future work, while plans/evidence alone preserve history;
- no hosted server was inspected or mutated as part of implementation;
- required checks pass without introduced warnings; and
- the sanitized TDD evidence contains real RED, GREEN, REFACTOR, interaction, revocation, and final
  verification records.

# 24. Fixed Decisions Checklist

Before reporting implementation complete, verify every item:

- [x] Rails receives the Account password; the password is not a Vault secret.
- [x] `Account` is canonical; no parallel `User` model is introduced.
- [x] Rails web signup replaces extension Account signup.
- [x] Production registration defaults disabled and is advertised by server information.
- [x] There is no email verification or password reset in this scope.
- [x] Password validation stays at Rails/bcrypt defaults selected in this plan.
- [x] Password change revokes every browser and API session.
- [x] Account and VaultDevice API authority are separate.
- [x] The Account Encryption Key and Account Vault slot are deleted.
- [x] One Account has at most one active synchronized Vault.
- [x] A fresh Device uses Account login plus Recovery Phrase, not another Device's approval.
- [x] Recovery uses 12 random English BIP39 words encoding 128-bit entropy.
- [x] BIP39 is used only as human encoding; AWSM uses domain-separated HKDF.
- [x] The phrase is never persisted, uploaded, logged, or included in the recovery file.
- [x] Full phrase re-entry gates initial attach, recovery, and rotation.
- [x] Device authentication uses Ed25519 and Device key wrapping uses X25519/HKDF/XChaCha.
- [x] Every authoritative encrypted Object binds `keyEpochId`.
- [x] Ordinary removal does not claim key rotation or remote erasure.
- [x] Future protection rotates Recovery Phrase authority and content-key epoch.
- [x] Full re-encryption creates new Vault/Object identities and purges without a Recovery Snapshot.
- [x] All four ordered Chrome/Firefox pairing directions are E2E tested.
- [x] Coordination interaction E2E remains separate from ordinary capture E2E.
- [x] No compatibility or old development-data preservation is implemented.
- [x] Non-plan documentation is evergreen; only plans and their evidence preserve history.
- [x] Only permissively licensed recovery/cryptographic client code is incorporated.
- [x] Hosted deployment remains out of scope.
