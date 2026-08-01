# Bundle Descriptor Specification

**Document:** `docs/specifications/bundle/manifest.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/bundle/artifact.md`

# 1. Purpose

The Bundle Descriptor is Vault Object type `1`. It commits to one Capture's identity, intrinsic
provenance, Artifact references, and exact acquisition outcome. It contains no payload bytes or
local availability.

# 2. Body codec

```text
{
  0: 1,                  // bundleDescriptorFormat
  1: bundleId,           // generated 32-byte ID
  2: capturedAt,         // signed Unix milliseconds; provenance, not causality
  3: originalUrl,        // normalized absolute URL
  4: finalUrl,           // normalized absolute URL
  5: captureProfileKey,  // canonical scoped key
  6: adapterKey,         // canonical scoped key
  7: adapterRevision,    // nonnegative integer
  8: title,              // captured title or null
  9: artifactRefs,       // canonical set by Artifact ID
  10: warnings,          // canonical warning set
  11: provenance         // canonical profile-owned map
}
```

The base profile key is `awsm.capture.web-page-snapshot`. The base adapter and provenance schema
are owned by `docs/specifications/bundle/page-snapshot.md`. URL normalization removes fragments but
retains query parameters. The Descriptor's Required Feature Set determines all understood fields
and profile behavior.

For that base profile, a Direct Capture uses adapter key `awsm.adapter.browser-web-page`, revision
`1`, and the exact format-only profile provenance defined by the page-snapshot specification.
Profile provenance is parsed under the named profile; it is not an unrestricted byte extension.

# 3. Artifact reference codec

```text
{
  0: artifactId, // Artifact Object ID; dependency type 5
  1: role        // canonical scoped role key
}
```

Roles are unique within one Descriptor. The referenced Artifact Object owns kind, media type,
length, digest, representation, and wrapper contract; none are duplicated here.

# 4. Warning codec

```text
{
  0: warningKey, // canonical scoped key
  1: detail      // profile-owned canonical bytes; empty when none
}
```

Warnings record only accepted acquisition facts required to interpret missing optional output or a
known truncation. They contain no error stack, local path, session, credential, or network secret.

# 5. Excluded state

The Descriptor never includes storage paths, wrapper availability, opaque item IDs, Remote names,
package coverage, Collection organization, lifecycle state, search state, or Account policy.

# 6. Provenance codec

Direct Capture provenance is:

```text
{
  0: 1,                // provenanceKind = Direct Capture
  1: profileProvenance // exact profile-owned canonical bytes
}
```

Event Re-authoring provenance is:

```text
{
  0: 2,                    // provenanceKind = Re-authored Capture
  1: sourceVaultId,
  2: sourceGenerationId,
  3: sourceRecordId,
  4: sourceBundleId,
  5: sourceDescriptorId,
  6: profileProvenance
}
```

The trusted Client verifies the source Record, Descriptor, and complete Capture closure before
authoring. The protected source IDs are provenance commitments, not typed dependencies in the
target Generation and do not keep predecessor history reachable.

# 7. Validation

A validator authenticates the Vault Object, recomputes its Object ID, validates the exact profile,
checks unique roles and warning consistency, resolves every typed Artifact dependency, and verifies
the complete graph before Bundle registration.

# References

- `docs/specifications/bundle/artifact.md`
- `docs/specifications/bundle/page-snapshot.md`
- `docs/specifications/runtime/capture.md`
