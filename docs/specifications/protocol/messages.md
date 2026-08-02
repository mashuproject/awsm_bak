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

An accepted explicit reaping request returns:

```text
{
  "replica_handle": string,
  "state": "reaping",
  "reaping_job_id": string
}
```

The job ID is Host-local operational state. It is not a Vault lifecycle record and does not imply
that any other Replica has changed.

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

Resumable stream preparation and Account-authenticated capability renewal return:

```text
{
  "upload_handle": string,
  "accepted_offset": integer,
  "maximum_part_length": integer,
  "transfer_capability": string
}
```

The bearer transfer capability is Host-local, random, short-lived, and stored only as a digest.
Renewal rotates it and returns the same upload handle and current accepted offset. An accepted part
or exact part retry returns:

```text
{"accepted_offset": integer}
```

Finalization returns the ordinary Admission result only after complete outer verification and
atomic promotion. Upload and transfer identifiers never enter Vault state.

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
