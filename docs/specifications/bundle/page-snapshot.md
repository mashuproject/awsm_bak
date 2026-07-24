# Page Snapshot Container Specification

**Document:** `specifications/bundle/page-snapshot.md`

**Version:** 1.0

**Status:** Draft

**Depends On:** `artifact.md`, `manifest.md`, `../runtime/capture.md`

---

# 1. Purpose

The AWSM page snapshot is the browser-independent authoritative representation of a captured web
page. It preserves a frozen rendered DOM, accessible same-origin frame documents, permitted
resource bodies, and explicit omissions. It is inert preservation data, not a recorded web
application or executable replay.

# 2. Artifact Contract

`WebPageSnapshot-v1` requires exactly one `PRIMARY` Artifact with Kind `CAPTURE` and MIME type
`application/vnd.awsm.web-page+zip`. The plaintext is a streamed ZIP64-capable archive. MHTML is
derived only when a user downloads it and is never stored or synchronized.

# 3. Members

Members occur in this exact order:

```text
documents/000000.html
documents/000001.html
...
resources/000000.bin
resources/000001.bin
...
manifest.cbor
```

The top document is `documents/000000.html`; descendant documents use frame-tree preorder.
Resources use first DOM-reference order followed by breadth-first CSS dependency discovery. The
archive has no directory entries, comments, encryption, unknown members, absolute or traversing
paths, or duplicate names. Every member uses the Capture timestamp. Textual media use DEFLATE level
6; already-compressed and binary media use STORE.

# 4. Manifest

`manifest.cbor` is canonical CBOR and contains exactly version `1`, Capture Profile ID, Capture
timestamp, original and final URLs, top document ID `d000000`, ordered document records, ordered
resource records, and ordered omission records.

Document IDs and Resource IDs are their zero-padded six-digit sequence positions. Each captured
member record binds its exact member name, byte length, and 32-byte SHA-256 checksum. Document
records also bind URLs, parent document, UTF-8 HTML media type, and scroll offsets. Resource records
bind owner document, requested/final URLs, media type, optional content language, status,
acquisition source (`Embedded`, `Cache`, or `Network`), and compression.

Omissions bind an owner document, absolute URL, subject (`Frame`, `Resource`, `Media`, or
`FileInput`), and typed reason. Unknown fields or variants are rejected. A captured record and an
omission cannot claim the same successful subject.

# 5. Acquisition and Limits

Capture freezes rendered DOM and live form state before screenshot and network acquisition. File
input paths and bodies are excluded. Open shadow roots are represented declaratively. Same-origin
accessible frames are captured; inaccessible frames are replaced with inert omission markers.

Resource acquisition permits `data:` and accessible `blob:` bodies plus credentialed same-origin
HTTP(S) GET. HTTP acquisition tries the authenticated cache before ordinary network access, follows
at most ten observable same-origin redirects, and never stores cookies, authorization material,
request headers, or audio/video bodies.

Each document, resource, and the required top document is limited to 64 MiB. The manifest is
limited to 16 MiB, the complete uncompressed member set to 512 MiB, documents to 1,024, resources
to 50,000, and ZIP entries to 100,000. Optional over-limit content becomes a typed omission;
oversized required top-document capture fails.

# 6. Streaming and Validation

The final ZIP, encrypted Artifact, resource set, and MHTML derivative SHALL NOT be accumulated in
one in-memory buffer. Construction streams to a temporary OPFS file; encryption consumes that file;
cleanup occurs after success, cancellation, failure, and startup reconciliation.

Readers reject non-canonical CBOR, member order or namespace changes, unknown/duplicate/encrypted
entries, unsupported compression, size or count violations, unresolved IDs, contradictory
omissions, and length or checksum mismatch before accepting the `PRIMARY`.

# 7. MHTML Derivative

The download derivative uses deterministic MIME boundaries and Content-IDs derived from the
`PRIMARY` checksum and member identities, CRLF line endings, and 76-column base64. It removes
scripts, inline event handlers, meta refresh, active JavaScript URLs, and form submission; disables
form controls; maps captured documents and resources to `cid:`; makes missing automatic references
inert; and applies a restrictive Content Security Policy. Ordinary HTTP(S) anchors remain explicit
external navigation with `noopener noreferrer`. The filename is
`awsm-<first-eight-Bundle-ID-characters>-page.mhtml`.
