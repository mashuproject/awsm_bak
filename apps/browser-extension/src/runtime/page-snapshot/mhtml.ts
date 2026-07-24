import type { PageSnapshotManifestV1, ValidatedPageSnapshot } from "./contracts";
import { rewriteCssUrls } from "./css";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentId(kind: "document" | "resource", id: string, checksum: Uint8Array): string {
  return `${kind}-${id}-${hex(checksum).slice(0, 24)}@awsm.invalid`;
}

function replaceCapturedReference(
  value: string,
  documents: ReadonlyMap<string, string>,
  resources: ReadonlyMap<string, string>,
): string | undefined {
  if (value.startsWith("awsm-document:")) {
    const id = value.slice("awsm-document:".length);
    const cid = documents.get(id);
    return cid === undefined ? undefined : `cid:${cid}`;
  }
  if (value.startsWith("awsm-resource:")) {
    const id = value.slice("awsm-resource:".length);
    const cid = resources.get(id);
    return cid === undefined ? undefined : `cid:${cid}`;
  }
  return value;
}

function sanitizeDocument(
  html: string,
  manifest: PageSnapshotManifestV1,
  documentIds: ReadonlyMap<string, string>,
  resourceIds: ReadonlyMap<string, string>,
): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of parsed.querySelectorAll("script,base,object,embed")) element.remove();
  for (const meta of parsed.querySelectorAll("meta[http-equiv]")) {
    if (meta.getAttribute("http-equiv")?.toLowerCase() === "refresh") meta.remove();
  }
  for (const form of parsed.querySelectorAll("form")) {
    form.removeAttribute("action");
    form.removeAttribute("method");
    form.setAttribute("data-awsm-disabled", "");
    for (const control of form.querySelectorAll("button,input,select,textarea"))
      control.setAttribute("disabled", "");
  }
  const safeCss = (css: string): string =>
    rewriteCssUrls(css, (value) => {
      const rewritten = replaceCapturedReference(value, documentIds, resourceIds);
      return rewritten?.startsWith("cid:") === true ? rewritten : undefined;
    });
  for (const style of parsed.querySelectorAll("style"))
    style.textContent = safeCss(style.textContent);
  for (const styled of parsed.querySelectorAll("[style]")) {
    const value = styled.getAttribute("style");
    if (value !== null) styled.setAttribute("style", safeCss(value));
  }
  const automatic = new Set([
    "audio:src",
    "embed:src",
    "iframe:src",
    "img:src",
    "input:src",
    "link:href",
    "object:data",
    "script:src",
    "source:src",
    "track:src",
    "video:poster",
    "video:src",
  ]);
  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (!["action", "background", "data", "formaction", "href", "poster", "src"].includes(name))
        continue;
      const rewritten = replaceCapturedReference(attribute.value, documentIds, resourceIds);
      const key = `${element.localName}:${name}`;
      if (rewritten === undefined || /^\s*javascript:/iu.test(rewritten)) {
        element.removeAttribute(attribute.name);
        element.setAttribute(`data-awsm-omitted-${name}`, attribute.value);
      } else if (element.localName === "a" && name === "href") {
        try {
          const target = new URL(rewritten, manifest.finalUrl);
          if (target.protocol === "http:" || target.protocol === "https:") {
            element.setAttribute("href", target.href);
            element.setAttribute("target", "_blank");
            element.setAttribute("rel", "noopener noreferrer");
          } else if (target.protocol !== "cid:") {
            element.removeAttribute("href");
          }
        } catch {
          element.removeAttribute("href");
        }
      } else if (automatic.has(key) && !rewritten.startsWith("cid:")) {
        element.removeAttribute(attribute.name);
        element.setAttribute(`data-awsm-omitted-${name}`, attribute.value);
      } else {
        element.setAttribute(attribute.name, rewritten);
      }
    }
  }
  const head = parsed.head ?? parsed.createElement("head");
  if (head.parentElement === null) parsed.documentElement.prepend(head);
  const csp = parsed.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    "default-src 'none'; img-src cid: data:; style-src cid: 'unsafe-inline'; font-src cid:; media-src cid:; frame-src cid:; form-action 'none'; navigate-to http: https:",
  );
  head.prepend(csp);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

async function writeText(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  value: string,
): Promise<void> {
  await writer.write(encoder.encode(value));
}

async function writeBase64(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  source: Uint8Array | Blob,
): Promise<void> {
  let carry = new Uint8Array();
  const reader = (source instanceof Blob ? source : new Blob([Uint8Array.from(source)]))
    .stream()
    .getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const combined = new Uint8Array(carry.byteLength + chunk.byteLength);
      combined.set(carry);
      combined.set(chunk, carry.byteLength);
      const complete = combined.byteLength - (combined.byteLength % 57);
      for (let index = 0; index < complete; index += 57) {
        let binary = "";
        for (const byte of combined.subarray(index, index + 57))
          binary += String.fromCharCode(byte);
        await writeText(writer, `${btoa(binary)}\r\n`);
      }
      carry = combined.slice(complete);
    }
  } finally {
    reader.releaseLock();
  }
  if (carry.byteLength > 0) {
    let binary = "";
    for (const byte of carry) binary += String.fromCharCode(byte);
    await writeText(writer, `${btoa(binary)}\r\n`);
  }
}

export async function deriveMhtml(
  snapshot: ValidatedPageSnapshot,
  primaryChecksum: Uint8Array,
  output: WritableStream<Uint8Array>,
): Promise<void> {
  const boundary = `----=_AWSM_${hex(primaryChecksum).slice(0, 32)}`;
  const documentIds = new Map(
    snapshot.manifest.documents.map((record) => [
      record.id,
      contentId("document", record.id, record.sha256),
    ]),
  );
  const resourceIds = new Map(
    snapshot.manifest.resources.map((record) => [
      record.id,
      contentId("resource", record.id, record.sha256),
    ]),
  );
  const writer = output.getWriter();
  try {
    await writeText(
      writer,
      [
        "MIME-Version: 1.0",
        `Content-Type: multipart/related; boundary="${boundary}"; type="text/html"`,
        `X-AWSM-Page-Snapshot-SHA256: ${hex(primaryChecksum)}`,
        "",
        "",
      ].join("\r\n"),
    );
    for (const record of snapshot.manifest.documents) {
      const blob = snapshot.members.get(record.member);
      if (blob === undefined) throw new Error(`Snapshot member ${record.member} is missing.`);
      const sanitized = encoder.encode(
        sanitizeDocument(await blob.text(), snapshot.manifest, documentIds, resourceIds),
      );
      await writeText(
        writer,
        [
          `--${boundary}`,
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          `Content-Location: ${record.finalUrl}`,
          `Content-ID: <${documentIds.get(record.id)}>`,
          "",
        ].join("\r\n"),
      );
      await writeText(writer, "\r\n");
      await writeBase64(writer, sanitized);
    }
    for (const record of snapshot.manifest.resources) {
      const source = snapshot.members.get(record.member);
      if (source === undefined) throw new Error(`Snapshot member ${record.member} is missing.`);
      const bytes: Uint8Array | Blob =
        record.mediaType.toLowerCase() === "text/css"
          ? encoder.encode(
              rewriteCssUrls(await source.text(), (value) => {
                if (!value.startsWith("awsm-resource:")) return undefined;
                const cid = resourceIds.get(value.slice("awsm-resource:".length));
                return cid === undefined ? undefined : `cid:${cid}`;
              }),
            )
          : source;
      await writeText(
        writer,
        [
          `--${boundary}`,
          `Content-Type: ${record.mediaType || "application/octet-stream"}`,
          "Content-Transfer-Encoding: base64",
          `Content-Location: ${record.finalUrl}`,
          `Content-ID: <${resourceIds.get(record.id)}>`,
          "",
        ].join("\r\n"),
      );
      await writeText(writer, "\r\n");
      await writeBase64(writer, bytes);
    }
    await writeText(writer, `--${boundary}--\r\n`);
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}
