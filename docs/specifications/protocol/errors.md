# Opaque Replica Protocol Outcomes

**Document:** `docs/specifications/protocol/errors.md`

**Version:** 1.0

**Status:** Draft target contract

**Depends On:**

- `docs/specifications/protocol/protocol.md`
- `docs/specifications/protocol/messages.md`

# 1. Purpose

Stable outcomes let a Client distinguish retryable transport and Host-policy failure from local
cryptographic or semantic validation. The Host never reports a guess about protected Vault state.

# 2. Outcome registry

| Outcome                   | Retryable | Meaning                                            |
| ------------------------- | --------- | -------------------------------------------------- |
| `authentication_required` | no        | no valid Channel Principal session                 |
| `access_denied`           | no        | no required Host-local Grant                       |
| `replica_not_found`       | no        | absent or non-disclosed Hosted Replica             |
| `item_not_found`          | no        | absent or non-disclosed opaque item                |
| `item_integrity_conflict` | no        | claimed ID exists with different bytes             |
| `outer_envelope_invalid`  | no        | malformed or unverifiable outer storage envelope   |
| `range_invalid`           | no        | range cannot be served under the stream contract   |
| `upload_incomplete`       | yes       | resumable bytes are missing                        |
| `upload_expired`          | no        | create a new resumable upload                      |
| `quota_exceeded`          | no        | Host policy rejected additional bytes              |
| `rate_limited`            | yes       | retry after Host guidance                          |
| `cursor_invalid`          | no        | cursor is unknown, expired, or outside the Replica |
| `request_conflict`        | no        | a Host-local conditional mutation lost its race    |
| `service_unavailable`     | yes       | temporary Host failure                             |
| `protocol_invalid`        | no        | strict request schema or framing violation         |

Normal successful reads, creation, management, `stored`, and `already_present` results use their
own success response rather than an error wrapper.

# 3. Retry behavior

Retryable outcomes use exponential backoff with jitter and honor a bounded `retry_after_seconds`
when present. Authentication refresh, changed credentials, new upload creation, quota action, or
user choice are not automatic retries of the same failed request.

An ambiguous network failure after immutable admission is safely retried because identical bytes
are idempotent. The Client recomputes and retains the exact item ID and bytes; it never reconstructs
a different randomized envelope merely to probe whether the first write succeeded.

# 4. Local validation outcomes

Signature failure, unsupported Required Feature, invalid Vault Event, dependency failure, Key
Epoch conflict, Vacuum divergence, or corrupt decrypted content are Client-side results. An opaque
Host MUST NOT expose corresponding outcome codes because it cannot observe those facts.

# 5. Disclosure

Authentication and cross-principal lookup failures may intentionally share HTTP status and
diagnostic wording. `request_id` is a Host-local support identifier. Responses omit Account names,
other Replica handles, stored inventories, implementation exceptions, paths, and secrets.

# 6. Invariants

- Clients branch on stable outcome strings, never diagnostic prose.
- An unknown outcome fails the current operation conservatively.
- A retry cannot weaken validation or change immutable request bytes.
- Host outcomes never become Vault Events.

# References

- `docs/specifications/protocol/messages.md`
