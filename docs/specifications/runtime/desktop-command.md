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

The body is one tagged `CanonicalApplicationRequest`. The Go Runtime implements `GetState`, Vault
creation and selection, Recovery Phrase ceremonies, `RecoverMember`, state-only Fork from the
authenticated Library checkpoint, `CloseVault`, authenticated Administrator `RotateKeyEpoch`, `VacuumVault`, `ListLibrary`, Storage Relief/GC
through the Runtime API, the read-only `GetAuthorityState` projection, Hosted Replica
creation/attachment/materialization, receiver pull, and Artifact hydration. Capture remains an
extension-only surface; the extension-to-desktop Capture Bundle bridge is not implemented.
Unsupported desktop capabilities return a canonical application error rather than pretending that
the operation succeeded. Desktop page acquisition is intentionally unsupported.

The same boundary exposes these portability Commands:

```json
{"type":"ExportComplete","expectedVaultId":"...","passphrase":"..."}
{"type":"ImportComplete","passphrase":"...","package":"<unpadded-base64url>"}
```

`ExportComplete` returns `{ "package": "<unpadded-base64url>" }`. `ImportComplete` atomically
installs a readable Replica without importing a Client Credential private key. The current Go
implementation accepts the browser Complete Export container for authenticated multi-Key-Epoch
and adopted-Vacuum closures, including Feature Manifest and Streamable Artifact wrappers. Commands
never log passphrases, package bytes, keys, or bearer tokens.

The Wails Vault view exposes these same Commands through its Authority, Complete Export and Import
panels and its Library list. An Open Vault with an unambiguous active Administrator exposes an
explicitly confirmed `RotateKeyEpoch` action; the Runtime authors the type-12 Authority Event,
stores recipient Key Envelopes, advances the current Key Epoch, and refreshes the projection.
`GetAuthorityState` is derived from authenticated Authority and
Lifecycle Events on every request, including active Invitation and Invitation conflict state; it
is not a second persisted authority source. The panel keeps
the package encrypted, requires an explicit passphrase for each operation, and refreshes the live
Vault projection after a successful Import. A locally available
Artifact row offers an explicit confirmation before issuing `StorageRelief`; after the Runtime
commits the eviction, the view refetches Library state and shows the returned loss warning and
`Needs hydration` state. The Hosted Replica panel can create or attach an existing Host Replica,
inspect opaque Replica candidates before selecting one, rename, pause/resume, materialize, pull,
and retire local Remote bindings. Retirement does not contact or delete the Hosted Replica. The
Wails view does not claim that another Replica exists.

Successful responses use:

```json
{ "ok": true, "value": {} }
```

Command failures use an HTTP-success application envelope so the Client can distinguish them from
transport and authorization failures:

```json
{
  "ok": false,
  "error": { "id": "ERROR_ID", "message": "Plain-language explanation." }
}
```

The endpoint rejects malformed JSON, unknown fields on decoded command forms, and trailing JSON
values. It never logs request bodies, Recovery Phrases, keys, or bearer tokens.

Hosted Replica Commands authenticate the Host channel, validate capabilities and opaque responses,
and never treat Host state as Vault authority. An unavailable or malformed Remote returns a failed
status without advancing local state.

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

The Go acceptance path validates and activates an authenticated opaque-closure package, including
canonical Replica state, referenced opaque items, and trusted local secrets. This move path remains
separate from the Complete Export Commands: move packages retain local authoring secrets, while
Complete Import deliberately produces an authoring-free readable Replica.

An unsubmitted transfer is discarded on desktop process restart. A staged transfer survives restart
until acceptance or rejection, subject to local storage integrity checks. A secret, plaintext
package, or decrypted local credential never appears in a management summary or diagnostic log.
