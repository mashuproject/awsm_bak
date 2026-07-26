# Protocol Outcomes and Error Specification

**Document:** `specifications/protocol/errors.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- protocol.md
- messages.md

---

# 1. Purpose

This specification defines protocol outcomes, retry behavior, and error reporting.

Every protocol request SHALL produce exactly one Outcome.

Outcomes are transport-independent.

---

# 2. Design Goals

The outcome model MUST provide:

- deterministic client behavior
- retry guidance
- canonical error validation
- machine-readable responses
- human-readable diagnostics

---

# 3. Outcome Structure

Every Outcome SHALL contain:

- Outcome Code
- Outcome Category
- Retry Recommendation

Optional:

- Reason
- Details
- Related Object Identifier

---

# 4. Outcome Categories

The standard categories are:

SUCCESS

RETRY

REJECTED

FATAL

UNKNOWN

Future categories MAY be introduced.

---

# 5. SUCCESS

The requested operation completed.

Examples:

- Object accepted
- Download completed
- Authentication successful

Clients SHOULD continue normal processing.

---

# 6. RETRY

The request was not completed.

Retry may succeed.

Examples:

- temporary storage unavailable
- network interruption
- lock contention
- server overload

Clients SHOULD retry according to server guidance.

---

# 7. REJECTED

The request was understood but cannot succeed without modification.

Examples:

- invalid schema
- authorization failure
- malformed object
- unsupported protocol feature

Automatic retry SHOULD NOT occur.

---

# 8. FATAL

The session cannot continue.

Examples:

- protocol violation
- integrity failure
- cryptographic failure
- unrecoverable corruption

Clients SHOULD terminate the current session.

---

# 9. UNKNOWN

The receiver cannot classify the request.

Clients SHOULD log the outcome.

---

# 10. Retry Recommendations

Retry recommendations include:

NEVER

IMMEDIATE

EXPONENTIAL_BACKOFF

AFTER_TIMESTAMP

MANUAL

Clients SHOULD honor retry recommendations.

---

# 11. Standard Outcome Codes

Examples:

OBJECT_ACCEPTED

OBJECT_ALREADY_EXISTS

OBJECT_NOT_FOUND

OBJECT_CORRUPTED

SCHEMA_INVALID

CHECKSUM_FAILED

AUTHENTICATION_FAILED

DEVICE_REVOKED

PROTOCOL_VERSION_UNSUPPORTED

QUOTA_EXCEEDED

SERVER_BUSY

RATE_LIMITED

UNKNOWN_OBJECT_TYPE

UNKNOWN_MESSAGE_TYPE

VAULT_GENERATION_SUPERSEDED

Future codes MAY be introduced.

`VAULT_GENERATION_SUPERSEDED` is stable. It means the submitted authoritative work names a generation that is no longer active. The client MUST NOT retry that history against the new generation as an automatic merge.

For a fenced change read, the response identifies the current opaque Generation and Delivery
Cursor. A stale client MUST atomically quarantine its local Replica against that authority before
offering explicit recovery. It MAY read current Vault authority to obtain the authenticated
predecessor identifier required to verify the encrypted Generation, but MUST NOT activate the
server Replica locally until the explicit recovery ceremony commits.

---

# 12. Diagnostics

Human-readable diagnostics MAY be included.

Clients MUST NOT parse diagnostic text.

Clients SHALL rely upon Outcome Codes.

---

# 13. Unknown Codes

Unknown Outcome Codes MUST be preserved.

Clients SHOULD treat unknown codes conservatively.

---

# 14. Invariants

Outcome Codes are stable.

Diagnostics are optional.

Machine-readable fields are normative.

---

# References

protocol.md

messages.md
