# Desktop Runtime Command Boundary

**Document:** `docs/specifications/runtime/desktop-command.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/event/commands.md`
- `docs/specifications/runtime/runtime.md`
- `docs/specifications/runtime/storage.md`

## 1. Scope

This document defines the local boundary between a paired browser extension and the reference Go
desktop Runtime. It does not make the desktop process a Replica Host, and it does not replace the
Vault Event, synchronization, or cryptographic specifications.

The Wails window uses the same boundary in-process. It must not create a second Vault domain model.
The extension is an API Client of the desktop process; pairing does not create Vault membership or
copy protected Vault bytes into extension storage.

## 2. Grant and command endpoint

The extension requests loopback permission from an explicit user action and pairs with the desktop
process at `http://127.0.0.1:37373`. Pairing and command requests use a revocable local API Grant.
The current grant scope is exactly `runtime.vault`.

The command endpoint is:

```text
POST /api/awsm/runtime/command
Authorization: Bearer <Runtime API Grant>
Content-Type: application/json
```

The body is one tagged `CanonicalApplicationRequest`. The Vault-management commands currently
implemented by the Go slice are `GetState`, Vault creation and selection, Recovery Phrase
ceremonies, `RecoverMember`, Fork, `CloseVault`, `VacuumVault`, and Hosted Replica metadata
configuration. Capture remains available for extension-owned local Vaults, but the
extension-to-desktop Capture Bundle bridge is not implemented.
Unsupported desktop capabilities return a canonical application error rather than pretending that
the operation succeeded. Desktop page acquisition is intentionally unsupported.

Successful responses use:

```json
{"ok":true,"value":{}}
```

Command failures use an HTTP-success application envelope so the Client can distinguish them from
transport and authorization failures:

```json
{"ok":false,"error":{"id":"ERROR_ID","message":"Plain-language explanation."}}
```

The endpoint rejects malformed JSON, unknown fields on decoded command forms, and trailing JSON
values. It never logs request bodies, Recovery Phrases, keys, or bearer tokens.

The current Go slice supports Hosted Replica metadata configuration only. Attachment, materialization,
and synchronization Commands return explicit unavailable errors until their authenticated Host and
Event/DAG services are implemented; they never report a fabricated successful sync.

## 3. Backend selection

When connected, the extension may render local and desktop-owned Vault summaries together. The
Vault ID selects the backend for every subsequent Command. A local and desktop backend with the
same Vault ID is an identity collision and is not merged. Selection is a presentation choice; it
does not synchronize, copy, or re-encrypt Vault data.

## 4. One-use move ceremony

Moving a Vault between Client Installations is not synchronization. The source creates a one-use
transfer:

```text
POST /api/awsm/runtime/transfers
Authorization: Bearer <Runtime API Grant>
Content-Type: application/json

{"vaultId":"..."}
```

The response contains `transferId`, `vaultId`, and a one-use 32-byte secret encoded as unpadded
base64url. The move payload is reserved for the current Complete Export plus the sealed local
credential envelope, produced by the source Runtime and encrypted with XChaCha20-Poly1305. The
authenticated outer bytes
are:

```text
AWSMTR1 || 24-byte nonce || ciphertext and authentication tag
```

The source stages the bytes with:

```text
PUT /api/awsm/runtime/transfers/{transferId}
Authorization: Bearer <Runtime API Grant>
Awsm-Transfer-Secret: <one-use secret>
Content-Type: application/octet-stream
```

The desktop verifies the envelope, stores the decrypted package as a local Transfer Artifact, and
returns its byte length and SHA-256 digest. A staged transfer can be listed by its non-secret
summary. The Wails user explicitly accepts or rejects it. Acceptance imports the package before a
separate source action retires the source Vault; rejection deletes the staged artifact. Neither
action creates a Vault Event, and transfer artifacts are not synchronized or included in ordinary
Vault Export or Backup.

The current Go slice stages arbitrary Runtime-owned bytes but its acceptance path understands only
its small internal Vault transfer snapshot; it does not yet parse or activate the browser Complete
Export format. Until that integration is implemented and tested, this is a verified staging
ceremony rather than a claim of complete cross-runtime Vault move parity.

An unsubmitted transfer is discarded on desktop process restart. A staged transfer survives restart
until acceptance or rejection, subject to local storage integrity checks. A secret, plaintext
package, or decrypted local credential never appears in a management summary or diagnostic log.
