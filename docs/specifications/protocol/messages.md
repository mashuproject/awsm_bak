# Opaque Replica Protocol Resources

**Document:** `docs/specifications/protocol/messages.md`

**Version:** 1.0

**Status:** Draft target contract

**Depends On:**

- `docs/specifications/protocol/protocol.md`

# 1. Purpose

This document fixes the transport-neutral resource fields that the target executable HTTP API must
represent. JSON names below are normative API names; protected Vault serialization remains CBOR.

# 2. Encodings

Thirty-two-byte opaque IDs and digests use unpadded base64url. Byte lengths and cursors are JSON
safe nonnegative integers. Timestamps appear only in Host policy resources and use RFC 3339 UTC.
Unknown properties are rejected.

# 3. Hosted Replica summary

```text
{
  "replica_handle": string,
  "capabilities": string[],
  "quota_bytes": integer | null,
  "stored_bytes": integer
}
```

The handle is Host-local and opaque. Capabilities are the exact keys from
`docs/specifications/vault/replica.md`. This resource contains no Vault ID, label, member, or
Generation.

# 4. Inventory page

```text
{
  "snapshot_cursor": integer,
  "next_position": string | null,
  "items": [
    {
      "storage_item_id": base64url32,
      "storage_class": "compact" | "streamable",
      "byte_length": integer,
      "ciphertext_digest": base64url32
    }
  ]
}
```

Items are strictly ordered and duplicate-free. `next_position: null` completes this snapshot. A
later pull obtains a new snapshot cursor; a cursor is never a Vault clock.

# 5. Admission result

```text
{
  "storage_item_id": base64url32,
  "byte_length": integer,
  "admission": "stored" | "already_present",
  "hint_cursor": integer
}
```

Resumable stream preparation additionally returns an opaque `upload_handle`, accepted byte offset,
maximum part length, and short-lived transfer capability. Finalization returns the ordinary
Admission result only after complete outer verification.

# 6. Read metadata

```text
{
  "storage_item_id": base64url32,
  "storage_class": "compact" | "streamable",
  "byte_length": integer,
  "ciphertext_digest": base64url32,
  "accepted_range": {"start": integer, "end_exclusive": integer} | null
}
```

The binary response body is exact stored outer bytes or the stated range. HTTP content metadata
must agree with this resource or equivalent headers.

# 7. Wake Hint

```text
{"hint_cursor": integer}
```

It is an advisory indication that inventory may have changed. It carries no item list or protected
identifier.

# 8. Outcome

```text
{
  "outcome": string,
  "retryable": boolean,
  "request_id": string,
  "retry_after_seconds": integer | null
}
```

Only `errors.md` may add outcome-specific safe fields. Diagnostic prose is not machine-readable.

# References

- `docs/specifications/protocol/errors.md`
- `docs/specifications/vault/replica.md`
