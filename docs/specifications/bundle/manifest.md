# Bundle Descriptor Specification

**Document:** `specifications/bundle/manifest.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `bundle.md`
- `artifact.md`

---

# 1. Purpose

The Bundle Descriptor is the compact authoritative description of a Bundle. It contains Capture
metadata and references every Artifact but never embeds Artifact payload bytes. Within general
product language, Manifest remains the descriptive metadata concept; this persisted Bundle format
uses the precise name Bundle Descriptor.

# 2. Canonical Record

The descriptor SHALL be canonical CBOR and contain exactly:

```text
descriptorVersion: 1
bundleId: canonical UUID
createdAt: canonical UTC timestamp
clientVersion: non-empty string
captureProfileId: WebPageSnapshot-v1
captureAdapterVersion: 1
metadata: CaptureMetadataV1
artifacts: ArtifactReferenceV1[]
```

Artifact references SHALL be sorted by Artifact Object ID and have unique Object IDs and Roles. The
descriptor SHALL contain mandatory `PRIMARY`. It SHALL reject unknown fields and enforce all
Role/Kind/MIME and metadata contracts.

Warnings SHALL NOT be duplicated in the descriptor. `BundleRegistered` owns accepted warning
facts, and its warning set SHALL exactly match absent optional Roles and any successful screenshot
truncation condition.

# 3. Encryption and Storage

The descriptor is encrypted with the standard compact Object envelope using Object type
`BundleDescriptor`, key domain `vault:bundle-descriptor:v1`, Bundle ID as context ID, and the
descriptor Object UUID as envelope Object ID. Its maximum encrypted/decrypted allocation is 16 MiB.

The descriptor SHALL NOT contain Artifact wrapper lengths/checksums, OPFS paths, filenames,
availability, package coverage, or Export omission state. Those belong to their owning storage and
portability contracts.

Device-local wrapper availability therefore never changes descriptor validity or Artifact reference
coverage. A remote-only wrapper is still a required Bundle member and MUST be included by Complete
Export, Backup, synchronization, and server switching according to their owning contracts.

# 4. Validation

Readers SHALL authenticate and decode the descriptor before trusting metadata or Artifact
references. They SHALL reject unknown versions/fields, non-canonical CBOR, invalid identifiers,
unsorted or duplicate references, invalid required Role coverage, or any mismatch with the
`BundleRegistered` dependency closure.

# References

- `bundle.md`
- `artifact.md`
- `../event/event.md`
- `../runtime/capture.md`
