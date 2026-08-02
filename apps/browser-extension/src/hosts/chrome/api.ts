import { type Browser, browser } from "wxt/browser";
import { base64ToBytes, bytesToBase64 } from "../../app/base64";
import type { CaptureMetadataV1 } from "../../domain/artifact-graph";
import type { CapturePageCommandV1 } from "../../domain/contracts";
import type { StructuredBlockV1 } from "../../domain/structured-content";
import type {
  SnapshotDocumentSource,
  SnapshotOmissionV1,
  SnapshotResourceSource,
} from "../../runtime/page-snapshot";
import { rewriteCssUrls } from "../../runtime/page-snapshot";
import type {
  CapturedTile,
  PageDimensions,
  ScreenshotHost,
  ScreenshotPlan,
  ScreenshotTile,
} from "../shared/screenshot";
import type { CaptureHost } from "./capture";

interface MeasuredPage extends PageDimensions {
  readonly scrollX: number;
  readonly scrollY: number;
}

interface PageMetadata {
  readonly finalUrl: string;
  readonly title: string;
  readonly contentType: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface CollectedPageSnapshot {
  readonly metadata: CaptureMetadataV1;
  readonly documents: readonly SnapshotDocumentSource[];
  readonly resources: readonly SnapshotResourceSource[];
  readonly omissions: readonly SnapshotOmissionV1[];
  readonly structuredBlocks: readonly StructuredBlockV1[];
  readonly contentWarnings: readonly (
    | "STRUCTURED_CONTENT_EXTRACTION_FAILED"
    | "TEXT_EXTRACTION_FAILED"
  )[];
}

function firstResult<T>(results: readonly Browser.scripting.InjectionResult<T>[]): T {
  const result = results[0]?.result;
  if (result === undefined) throw new Error("The active page did not return capture metadata.");
  return result;
}

export class ChromeCaptureHost implements CaptureHost {
  constructor(
    private readonly browserName = "Chrome",
    private readonly browserVersion = navigator.userAgent.match(/Chrome\/([^ ]+)/u)?.[1] ??
      "unknown",
  ) {}

  async getActiveTab(): Promise<{ readonly id?: number; readonly url?: string } | undefined> {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab === undefined
      ? undefined
      : {
          ...(tab.id === undefined ? {} : { id: tab.id }),
          ...(tab.url === undefined ? {} : { url: tab.url }),
        };
  }

  async getTab(tabId: number): Promise<{ readonly id?: number; readonly url?: string }> {
    const tab = await browser.tabs.get(tabId);
    return {
      ...(tab.id === undefined ? {} : { id: tab.id }),
      ...(tab.url === undefined ? {} : { url: tab.url }),
    };
  }

  hasCapturePermission(): Promise<boolean> {
    return browser.permissions.contains({
      permissions: ["activeTab", "scripting"],
    });
  }

  async collectMetadata(
    tabId: number,
    command: CapturePageCommandV1,
    capturedAt: string,
    clientVersion: string,
  ): Promise<CaptureMetadataV1> {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (): PageMetadata => {
        const root = document.documentElement;
        const body = document.body;
        return {
          finalUrl: location.href,
          title: document.title || location.hostname,
          contentType: document.contentType || "text/html",
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0),
          documentHeight: Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0),
        };
      },
    });
    const page = firstResult(results);
    return {
      version: 1,
      originalUrl: command.observedUrl,
      finalUrl: page.finalUrl,
      title: page.title,
      capturedAt,
      contentType: page.contentType,
      viewport: { width: page.viewportWidth, height: page.viewportHeight },
      document: { width: page.documentWidth, height: page.documentHeight },
      browserName: this.browserName,
      browserVersion: this.browserVersion,
      extensionVersion: clientVersion,
      captureProfileId: "WebPageSnapshot-v1",
      captureProfileVersion: 1,
    };
  }

  async collectPageSnapshot(
    tabId: number,
    input: { readonly observedUrl: string },
    capturedAt: string,
    clientVersion: string,
    onFrozen: () => Promise<void> = async () => undefined,
  ): Promise<CollectedPageSnapshot> {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        interface CollectedDocument {
          parentId?: string;
          originalUrl: string;
          finalUrl: string;
          html: string;
          scrollX: number;
          scrollY: number;
        }
        interface InventoryResource {
          id: string;
          ownerDocumentId: string;
          requestedUrl: string;
        }
        interface InventoryOmission {
          ownerDocumentId: string;
          url: string;
          subject: "Frame" | "Resource" | "Media" | "FileInput";
          reason:
            | "InaccessibleFrame"
            | "CrossOrigin"
            | "UnsupportedScheme"
            | "MediaBodyExcluded"
            | "FileBodyExcluded";
        }
        const documents: CollectedDocument[] = [];
        const resources: InventoryResource[] = [];
        const omissions: InventoryOmission[] = [];
        const structuredBlocks: StructuredBlockV1[] = [];
        const resourceIds = new Map<string, string>();
        const topOrigin = location.origin;
        const serializeDoctype = (doctype: DocumentType | null): string =>
          doctype === null
            ? "<!doctype html>"
            : `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ""}${
                !doctype.publicId && doctype.systemId ? " SYSTEM" : ""
              }${doctype.systemId ? ` "${doctype.systemId}"` : ""}>`;
        const inventoryUrl = (
          raw: string,
          ownerDocumentId: string,
        ): { replacement?: string; omission?: InventoryOmission } => {
          let url: URL;
          try {
            url = new URL(
              raw,
              documents[Number(ownerDocumentId.slice(1))]?.finalUrl ?? location.href,
            );
          } catch {
            return {
              omission: {
                ownerDocumentId,
                url: documents[Number(ownerDocumentId.slice(1))]?.finalUrl ?? location.href,
                subject: "Resource",
                reason: "UnsupportedScheme",
              },
            };
          }
          if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === topOrigin) {
            let id = resourceIds.get(url.href);
            if (id === undefined) {
              id = `r${String(resourceIds.size).padStart(6, "0")}`;
              resourceIds.set(url.href, id);
              resources.push({ id, ownerDocumentId, requestedUrl: url.href });
            }
            return { replacement: `awsm-resource:${id}` };
          }
          return {
            omission: {
              ownerDocumentId,
              url: url.href,
              subject: "Resource",
              reason:
                url.protocol === "http:" || url.protocol === "https:"
                  ? "CrossOrigin"
                  : "UnsupportedScheme",
            },
          };
        };
        const copyLiveState = (
          originalRoot: ParentNode,
          clonedRoot: ParentNode,
          ownerDocumentId: string,
        ): void => {
          const originals = [originalRoot, ...originalRoot.querySelectorAll("*")];
          const clones = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
          for (const [index, original] of originals.entries()) {
            const clone = clones[index];
            if (!(original instanceof Element) || !(clone instanceof Element)) continue;
            if (original instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
              if (original.type === "file") {
                clone.removeAttribute("value");
                omissions.push({
                  ownerDocumentId,
                  url: documents[Number(ownerDocumentId.slice(1))]?.finalUrl ?? location.href,
                  subject: "FileInput",
                  reason: "FileBodyExcluded",
                });
              } else {
                clone.setAttribute("value", original.value);
                if (original.checked) clone.setAttribute("checked", "");
                else clone.removeAttribute("checked");
              }
            } else if (
              original instanceof HTMLTextAreaElement &&
              clone instanceof HTMLTextAreaElement
            ) {
              clone.textContent = original.value;
            } else if (
              original instanceof HTMLSelectElement &&
              clone instanceof HTMLSelectElement
            ) {
              for (const [optionIndex, option] of [...original.options].entries()) {
                if (option.selected) clone.options[optionIndex]?.setAttribute("selected", "");
                else clone.options[optionIndex]?.removeAttribute("selected");
              }
            } else if (original instanceof HTMLDetailsElement) {
              if (original.open) clone.setAttribute("open", "");
              else clone.removeAttribute("open");
            }
            if (original.shadowRoot?.mode === "open") {
              const template = document.createElement("template");
              template.setAttribute("shadowrootmode", "open");
              for (const child of original.shadowRoot.childNodes)
                template.content.append(child.cloneNode(true));
              clone.prepend(template);
            }
          }
        };
        const collectDocument = (source: Document, parentId: string | undefined): string => {
          const index = documents.length;
          const id = `d${String(index).padStart(6, "0")}`;
          const finalUrl = source.location.href;
          const entry: CollectedDocument = {
            ...(parentId === undefined ? {} : { parentId }),
            originalUrl: finalUrl,
            finalUrl,
            html: "",
            scrollX: source.defaultView?.scrollX ?? 0,
            scrollY: source.defaultView?.scrollY ?? 0,
          };
          documents.push(entry);
          const clone = source.documentElement.cloneNode(true) as HTMLElement;
          const originalElements = [...source.documentElement.querySelectorAll("*")];
          const clonedElements = [...clone.querySelectorAll("*")];
          for (const [elementIndex, original] of originalElements.entries()) {
            const cloned = clonedElements[elementIndex];
            if (!(cloned instanceof Element)) continue;
            if (
              (original instanceof HTMLIFrameElement || original instanceof HTMLFrameElement) &&
              (cloned instanceof HTMLIFrameElement || cloned instanceof HTMLFrameElement)
            ) {
              try {
                const frameDocument = original.contentDocument;
                if (frameDocument === null || frameDocument.location.origin !== topOrigin)
                  throw new Error("inaccessible");
                const frameId = collectDocument(frameDocument, id);
                cloned.setAttribute("src", `awsm-document:${frameId}`);
              } catch {
                let frameUrl = finalUrl;
                try {
                  frameUrl = new URL(original.getAttribute("src") ?? "", finalUrl).href;
                } catch {
                  // Retain the owning document URL for an unparseable frame location.
                }
                cloned.removeAttribute("src");
                cloned.setAttribute("data-awsm-omitted-frame", frameUrl);
                omissions.push({
                  ownerDocumentId: id,
                  url: frameUrl,
                  subject: "Frame",
                  reason:
                    frameUrl.startsWith("http:") || frameUrl.startsWith("https:")
                      ? "InaccessibleFrame"
                      : "UnsupportedScheme",
                });
              }
              continue;
            }
            if (
              (original instanceof HTMLImageElement ||
                (original instanceof HTMLSourceElement &&
                  original.parentElement instanceof HTMLPictureElement)) &&
              original.getAttribute("srcset")
            ) {
              const selected =
                original instanceof HTMLImageElement ? original.currentSrc || original.src : "";
              cloned.removeAttribute("srcset");
              if (selected) {
                const inventory = inventoryUrl(selected, id);
                if (inventory.replacement) cloned.setAttribute("src", inventory.replacement);
                else cloned.removeAttribute("src");
                if (inventory.omission) omissions.push(inventory.omission);
              }
            }
            const attributes =
              original instanceof HTMLLinkElement &&
              !["stylesheet", "icon"].includes(original.rel.toLowerCase())
                ? []
                : [
                    "src",
                    "poster",
                    ...(original instanceof HTMLLinkElement ||
                    original.namespaceURI === "http://www.w3.org/2000/svg"
                      ? ["href", "xlink:href"]
                      : []),
                  ];
            for (const attribute of attributes) {
              const raw = original.getAttribute(attribute);
              if (!raw) continue;
              if (
                (original instanceof HTMLMediaElement && attribute === "src") ||
                (original instanceof HTMLSourceElement &&
                  !(original.parentElement instanceof HTMLPictureElement))
              ) {
                cloned.removeAttribute(attribute);
                omissions.push({
                  ownerDocumentId: id,
                  url: new URL(raw, finalUrl).href,
                  subject: "Media",
                  reason: "MediaBodyExcluded",
                });
                continue;
              }
              const inventory = inventoryUrl(raw, id);
              if (inventory.replacement) cloned.setAttribute(attribute, inventory.replacement);
              else {
                cloned.removeAttribute(attribute);
                if (inventory.omission) omissions.push(inventory.omission);
              }
            }
            if (original instanceof HTMLAnchorElement) {
              const href = original.getAttribute("href");
              if (href) {
                try {
                  const url = new URL(href, finalUrl);
                  if (url.protocol === "http:" || url.protocol === "https:")
                    cloned.setAttribute("href", url.href);
                } catch {
                  cloned.removeAttribute("href");
                }
              }
            }
          }
          copyLiveState(source.documentElement, clone, id);
          entry.html = `${serializeDoctype(source.doctype)}\n${clone.outerHTML}`;
          return id;
        };
        collectDocument(document, undefined);
        let approximateStructuredBytes = 0;
        let blockIndex = 0;
        let structuredContentFailed = false;
        const links = (candidate: HTMLElement) =>
          [...candidate.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap((anchor) => {
            try {
              const url = new URL(anchor.href);
              return url.protocol === "http:" || url.protocol === "https:"
                ? [
                    {
                      text: (anchor.innerText || anchor.textContent || "").trim(),
                      href: url.href,
                    },
                  ]
                : [];
            } catch {
              return [];
            }
          });
        const appendBlock = (block: StructuredBlockV1): void => {
          if (structuredContentFailed) return;
          approximateStructuredBytes += JSON.stringify(block).length * 2;
          if (approximateStructuredBytes > 8 * 1024 * 1024) {
            structuredContentFailed = true;
            structuredBlocks.length = 0;
            return;
          }
          structuredBlocks.push(block);
        };
        for (const candidate of document.querySelectorAll(
          "h1,h2,h3,h4,h5,h6,p,blockquote,li,pre,table",
        )) {
          if (!(candidate instanceof HTMLElement)) continue;
          if (
            candidate.closest("[hidden],[aria-hidden='true']") !== null ||
            !candidate.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
            })
          )
            continue;
          const text = (candidate.innerText || candidate.textContent || "").trim();
          if (text.length === 0) continue;
          blockIndex += 1;
          const blockId = `B${String(blockIndex).padStart(6, "0")}`;
          const tag = candidate.tagName.toLowerCase();
          if (/^h[1-6]$/u.test(tag)) {
            appendBlock({
              blockVersion: 1,
              blockId,
              kind: "Heading",
              level: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6,
              text,
              links: links(candidate),
            });
          } else if (tag === "blockquote") {
            appendBlock({
              blockVersion: 1,
              blockId,
              kind: "Quote",
              text,
              links: links(candidate),
            });
          } else if (tag === "li") {
            let depth = 0;
            for (
              let parent = candidate.parentElement?.closest("li");
              parent !== null && parent !== undefined;
              parent = parent.parentElement?.closest("li")
            )
              depth += 1;
            appendBlock({
              blockVersion: 1,
              blockId,
              kind: "ListItem",
              ordered: candidate.parentElement?.tagName.toLowerCase() === "ol",
              depth,
              text,
              links: links(candidate),
            });
          } else if (tag === "pre") {
            appendBlock({
              blockVersion: 1,
              blockId,
              kind: "Preformatted",
              text,
            });
          } else if (tag === "table") {
            const rows = [...candidate.querySelectorAll("tr")]
              .map((row) =>
                [...row.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").trim()),
              )
              .filter((row) => row.length > 0);
            if (rows.length > 0) appendBlock({ blockVersion: 1, blockId, kind: "Table", rows });
          } else {
            appendBlock({
              blockVersion: 1,
              blockId,
              kind: "Paragraph",
              text,
              links: links(candidate),
            });
          }
        }
        const root = document.documentElement;
        const body = document.body;
        return {
          documents,
          resources,
          omissions,
          structuredBlocks,
          structuredContentFailed,
          page: {
            finalUrl: location.href,
            title: document.title || location.hostname,
            contentType: document.contentType || "text/html",
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            documentWidth: Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0),
            documentHeight: Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0),
          },
        };
      },
    });
    const collected = firstResult(results);
    await onFrozen();
    const metadata: CaptureMetadataV1 = {
      version: 1,
      originalUrl: input.observedUrl,
      finalUrl: collected.page.finalUrl,
      title: collected.page.title,
      capturedAt,
      contentType: collected.page.contentType,
      viewport: {
        width: collected.page.viewportWidth,
        height: collected.page.viewportHeight,
      },
      document: {
        width: collected.page.documentWidth,
        height: collected.page.documentHeight,
      },
      browserName: this.browserName,
      browserVersion: this.browserVersion,
      extensionVersion: clientVersion,
      captureProfileId: "WebPageSnapshot-v1",
      captureProfileVersion: 1,
    };
    const encoder = new TextEncoder();
    const documentByteLengths = collected.documents.map(
      (document) => encoder.encode(document.html).byteLength,
    );
    if ((documentByteLengths[0] ?? 0) > 64 * 1024 * 1024)
      throw Object.assign(new Error("The top document exceeds 64 MiB."), {
        id: "PAGE_SNAPSHOT_TOO_LARGE",
      });
    const excludedDocumentIds = new Set(
      collected.documents.flatMap((_document, index) =>
        index > 0 && (documentByteLengths[index] ?? 0) > 64 * 1024 * 1024
          ? [`d${String(index).padStart(6, "0")}`]
          : [],
      ),
    );
    for (const [index, document] of collected.documents.entries()) {
      if (document.parentId !== undefined && excludedDocumentIds.has(document.parentId))
        excludedDocumentIds.add(`d${String(index).padStart(6, "0")}`);
    }
    const documentIdMap = new Map<string, string>();
    for (const [index] of collected.documents.entries()) {
      const oldId = `d${String(index).padStart(6, "0")}`;
      if (!excludedDocumentIds.has(oldId))
        documentIdMap.set(oldId, `d${String(documentIdMap.size).padStart(6, "0")}`);
    }
    const collectedDocuments = collected.documents.flatMap((document, index) => {
      const oldId = `d${String(index).padStart(6, "0")}`;
      if (excludedDocumentIds.has(oldId)) return [];
      return [
        {
          ...document,
          ...(document.parentId === undefined
            ? {}
            : { parentId: documentIdMap.get(document.parentId) }),
          html: document.html.replace(
            /awsm-document:(d\d{6})/gu,
            (_match, targetId: string) =>
              documentIdMap.get(targetId) ?? "about:blank#awsm-omitted-oversized-frame",
          ),
        },
      ];
    });
    const remapOwner = (ownerDocumentId: string): string | undefined =>
      documentIdMap.get(ownerDocumentId);
    const collectedResources = collected.resources.flatMap((resource) => {
      const referencedBy = collected.documents.findIndex(
        (document, index) =>
          !excludedDocumentIds.has(`d${String(index).padStart(6, "0")}`) &&
          document.html.includes(`awsm-resource:${resource.id}`),
      );
      const ownerDocumentId =
        remapOwner(resource.ownerDocumentId) ??
        (referencedBy < 0 ? undefined : remapOwner(`d${String(referencedBy).padStart(6, "0")}`));
      return ownerDocumentId === undefined ? [] : [{ ...resource, ownerDocumentId }];
    });
    const collectedOmissions: SnapshotOmissionV1[] = collected.omissions.flatMap((omission) => {
      const ownerDocumentId = remapOwner(omission.ownerDocumentId);
      return ownerDocumentId === undefined ? [] : [{ ...omission, ownerDocumentId }];
    });
    for (const [index, document] of collected.documents.entries()) {
      const oldId = `d${String(index).padStart(6, "0")}`;
      if (
        !excludedDocumentIds.has(oldId) ||
        document.parentId === undefined ||
        excludedDocumentIds.has(document.parentId)
      )
        continue;
      const ownerDocumentId = remapOwner(document.parentId);
      if (ownerDocumentId !== undefined)
        collectedOmissions.push({
          ownerDocumentId,
          url: document.finalUrl,
          subject: "Frame",
          reason: "CaptureBudgetExceeded",
        });
    }
    const resources: SnapshotResourceSource[] = [];
    const omissions: SnapshotOmissionV1[] = [...collectedOmissions];
    const capturedResourceIds = new Map<string, string>();
    const inventoryQueue = [...collectedResources];
    const inventoryIdsByUrl = new Map(
      inventoryQueue.map((record) => [record.requestedUrl, record.id]),
    );
    const discoverCss = (css: string, baseUrl: string, ownerDocumentId: string): string =>
      rewriteCssUrls(css, (raw) => {
        let dependency: URL;
        try {
          dependency = new URL(raw, baseUrl);
        } catch {
          return undefined;
        }
        if (
          dependency.protocol !== "data:" &&
          dependency.protocol !== "blob:" &&
          dependency.origin !== new URL(collected.page.finalUrl).origin
        ) {
          omissions.push({
            ownerDocumentId,
            url: dependency.href,
            subject: "Resource",
            reason:
              dependency.protocol === "http:" || dependency.protocol === "https:"
                ? "CrossOrigin"
                : "UnsupportedScheme",
          });
          return undefined;
        }
        let id = inventoryIdsByUrl.get(dependency.href);
        if (id === undefined) {
          id = `r${String(inventoryQueue.length).padStart(6, "0")}`;
          inventoryIdsByUrl.set(dependency.href, id);
          inventoryQueue.push({
            id,
            ownerDocumentId,
            requestedUrl: dependency.href,
          });
        }
        return `awsm-resource:${id}`;
      });
    const fetchSameOrigin = async (
      initial: URL,
    ): Promise<{
      readonly response: Response;
      readonly acquisition: "Cache" | "Network";
    }> => {
      const attempt = async (
        cache: RequestCache,
        acquisition: "Cache" | "Network",
      ): Promise<{
        readonly response: Response;
        readonly acquisition: "Cache" | "Network";
      }> => {
        let current = initial;
        for (let redirects = 0; redirects <= 10; redirects += 1) {
          const response = await fetch(current, {
            method: "GET",
            credentials: "include",
            redirect: "manual",
            cache,
            mode: "same-origin",
          });
          if (
            response.type === "opaqueredirect" ||
            (response.status >= 300 && response.status < 400)
          ) {
            if (redirects === 10) throw new Error("redirect limit");
            const location = response.headers.get("location");
            if (location === null) throw new Error("unobservable redirect");
            const next = new URL(location, current);
            if (next.origin !== initial.origin) throw new Error("cross-origin redirect");
            current = next;
            continue;
          }
          if (!response.ok || new URL(response.url || current.href).origin !== initial.origin)
            throw new Error("fetch failed");
          return { response, acquisition };
        }
        throw new Error("redirect limit");
      };
      try {
        return await attempt("only-if-cached", "Cache");
      } catch {
        return attempt("default", "Network");
      }
    };
    let capturedBytes = collectedDocuments.reduce(
      (total, document) => total + encoder.encode(document.html).byteLength,
      0,
    );
    for (const inventory of inventoryQueue) {
      let url: URL;
      try {
        url = new URL(inventory.requestedUrl);
        if (url.protocol === "data:") {
          const response = await fetch(url);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const mediaType = response.headers.get("content-type") ?? "application/octet-stream";
          const storedBytes =
            mediaType.split(";")[0]?.trim().toLowerCase() === "text/css"
              ? new TextEncoder().encode(
                  discoverCss(new TextDecoder().decode(bytes), url.href, inventory.ownerDocumentId),
                )
              : bytes;
          resources.push({
            ownerDocumentId: inventory.ownerDocumentId,
            requestedUrl: `urn:awsm:data:sha256:${digest}`,
            finalUrl: `urn:awsm:data:sha256:${digest}`,
            bytes: storedBytes,
            mediaType,
            status: 200,
            acquisition: "Embedded",
            compression: "Store",
          });
          capturedResourceIds.set(
            inventory.id,
            `r${String(resources.length - 1).padStart(6, "0")}`,
          );
          capturedBytes += bytes.byteLength;
          continue;
        }
        if (url.protocol === "blob:") {
          const injected = await browser.scripting.executeScript({
            target: { tabId },
            args: [url.href],
            func: async (
              blobUrl: string,
            ): Promise<{
              readonly bytes: number[];
              readonly mediaType: string;
            }> => {
              const blob = await (await fetch(blobUrl)).blob();
              if (blob.size > 64 * 1024 * 1024) throw new Error("resource too large");
              return {
                bytes: [...new Uint8Array(await blob.arrayBuffer())],
                mediaType: blob.type || "application/octet-stream",
              };
            },
          });
          const embedded = firstResult(injected);
          const bytes = Uint8Array.from(embedded.bytes);
          if (capturedBytes + bytes.byteLength > 512 * 1024 * 1024) {
            omissions.push({
              ownerDocumentId: inventory.ownerDocumentId,
              url: url.href,
              subject: "Resource",
              reason: "CaptureBudgetExceeded",
            });
            continue;
          }
          resources.push({
            ownerDocumentId: inventory.ownerDocumentId,
            requestedUrl: url.href,
            finalUrl: url.href,
            bytes,
            mediaType: embedded.mediaType,
            status: 200,
            acquisition: "Embedded",
            compression: "Store",
          });
          capturedResourceIds.set(
            inventory.id,
            `r${String(resources.length - 1).padStart(6, "0")}`,
          );
          capturedBytes += bytes.byteLength;
          continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported");
        const acquired = await fetchSameOrigin(url);
        const response = acquired.response;
        const bytes = await response.blob();
        if (bytes.size > 64 * 1024 * 1024) {
          omissions.push({
            ownerDocumentId: inventory.ownerDocumentId,
            url: url.href,
            subject: "Resource",
            reason: "ResourceTooLarge",
          });
          continue;
        }
        if (capturedBytes + bytes.size > 512 * 1024 * 1024) {
          omissions.push({
            ownerDocumentId: inventory.ownerDocumentId,
            url: url.href,
            subject: "Resource",
            reason: "CaptureBudgetExceeded",
          });
          continue;
        }
        const mediaType =
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ||
          "application/octet-stream";
        const contentLanguage = response.headers.get("content-language")?.trim();
        const storedBytes =
          mediaType === "text/css"
            ? new Blob([discoverCss(await bytes.text(), response.url, inventory.ownerDocumentId)])
            : bytes;
        resources.push({
          ownerDocumentId: inventory.ownerDocumentId,
          requestedUrl: url.href,
          finalUrl: response.url,
          bytes: storedBytes,
          mediaType,
          ...(contentLanguage ? { contentLanguage } : {}),
          status: response.status,
          acquisition: acquired.acquisition,
          compression: /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/u.test(
            mediaType,
          )
            ? "Deflate"
            : "Store",
        });
        capturedResourceIds.set(inventory.id, `r${String(resources.length - 1).padStart(6, "0")}`);
        capturedBytes += bytes.size;
      } catch {
        omissions.push({
          ownerDocumentId: inventory.ownerDocumentId,
          url: inventory.requestedUrl,
          subject: "Resource",
          reason: "FetchFailed",
        });
      }
    }
    const compactResources = await Promise.all(
      resources.map(async (resource): Promise<SnapshotResourceSource> => {
        if (resource.mediaType.toLowerCase() !== "text/css") return resource;
        const css =
          resource.bytes instanceof Blob
            ? await resource.bytes.text()
            : new TextDecoder().decode(resource.bytes);
        return {
          ...resource,
          bytes: new TextEncoder().encode(
            css.replace(/awsm-resource:(r\d{6})/gu, (_match, id: string) => {
              const captured = capturedResourceIds.get(id);
              return captured === undefined
                ? "about:blank#awsm-omitted-resource"
                : `awsm-resource:${captured}`;
            }),
          ),
        };
      }),
    );
    return {
      metadata,
      documents: collectedDocuments.map((document) => ({
        ...(document.parentId === undefined ? {} : { parentId: document.parentId }),
        originalUrl: document.originalUrl,
        finalUrl: document.finalUrl,
        bytes: new TextEncoder().encode(
          document.html.replace(/awsm-resource:(r\d{6})/gu, (_match, id: string) => {
            const captured = capturedResourceIds.get(id);
            return captured === undefined
              ? "about:blank#awsm-omitted-resource"
              : `awsm-resource:${captured}`;
          }),
        ),
        scrollX: document.scrollX,
        scrollY: document.scrollY,
      })),
      resources: compactResources,
      omissions,
      structuredBlocks: collected.structuredBlocks,
      contentWarnings: collected.structuredContentFailed
        ? ["STRUCTURED_CONTENT_EXTRACTION_FAILED", "TEXT_EXTRACTION_FAILED"]
        : [],
    };
  }
}

export class ChromeScreenshotHost implements ScreenshotHost {
  private originalScroll = { x: 0, y: 0 };
  readonly tabId: number;
  readonly windowId: number;

  private constructor(tabId: number, windowId: number) {
    this.tabId = tabId;
    this.windowId = windowId;
  }

  static async create(tabId: number): Promise<ChromeScreenshotHost> {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) throw new Error("The capture tab has no window.");
    return new ChromeScreenshotHost(tabId, tab.windowId);
  }

  async measure(): Promise<PageDimensions> {
    const results = await browser.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (): MeasuredPage => {
        const root = document.documentElement;
        const body = document.body;
        return {
          documentWidth: Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0),
          documentHeight: Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };
      },
    });
    const measured = firstResult(results);
    this.originalScroll = { x: measured.scrollX, y: measured.scrollY };
    return measured;
  }

  async prepareTile(tile: ScreenshotTile, hideRepeatedFixedElements: boolean): Promise<void> {
    await browser.scripting.executeScript({
      target: { tabId: this.tabId },
      args: [tile.scrollX, tile.scrollY, hideRepeatedFixedElements],
      func: async (x: number, y: number, hideFixed: boolean): Promise<void> => {
        const marker = "data-awsm-capture-hidden-v1";
        const original = "data-awsm-capture-visibility-v1";
        for (const element of document.querySelectorAll<HTMLElement>(`[${marker}]`)) {
          element.style.visibility = element.getAttribute(original) ?? "";
          element.removeAttribute(marker);
          element.removeAttribute(original);
        }
        window.scrollTo(x, y);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (hideFixed) {
          for (const element of document.querySelectorAll<HTMLElement>("body *")) {
            const position = getComputedStyle(element).position;
            if (position === "fixed" || position === "sticky") {
              element.setAttribute(original, element.style.visibility);
              element.setAttribute(marker, "");
              element.style.visibility = "hidden";
            }
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      },
    });
  }

  async captureVisible(): Promise<Uint8Array> {
    const dataUrl = await browser.tabs.captureVisibleTab(this.windowId, {
      format: "png",
    });
    return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  }

  async stitch(
    plan: ScreenshotPlan,
    tiles: readonly CapturedTile[],
  ): Promise<import("../shared/screenshot").StitchedScreenshot> {
    const contexts = await browser.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length === 0) {
      await browser.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Stitch screenshot tiles and encode lossy WebP previews.",
      });
    }
    const port = browser.runtime.connect({
      name: `awsm:screenshot:${crypto.randomUUID()}`,
    });
    let requestSequence = 0;
    const send = (message: Record<string, unknown>): Promise<void> => {
      requestSequence += 1;
      const sequence = requestSequence;
      return new Promise((resolve, reject) => {
        const disconnected = (): void => reject(new Error("Screenshot stitcher disconnected."));
        const acknowledged = (value: unknown): void => {
          if (
            typeof value === "object" &&
            value !== null &&
            "acknowledged" in value &&
            value.acknowledged === sequence
          ) {
            port.onMessage.removeListener(acknowledged);
            port.onDisconnect.removeListener(disconnected);
            resolve();
          }
        };
        port.onMessage.addListener(acknowledged);
        port.onDisconnect.addListener(disconnected);
        port.postMessage({ ...message, sequence });
      });
    };
    const outputParts = new Map<"Full" | "Thumbnail", ArrayBuffer[]>([
      ["Full", []],
      ["Thumbnail", []],
    ]);
    const completed = new Promise<void>((resolve, reject) => {
      port.onMessage.addListener((value: unknown) => {
        if (typeof value !== "object" || value === null || !("outputId" in value)) return;
        const outputId = value.outputId;
        if (typeof outputId !== "number") return;
        if ("kind" in value && (value.kind === "Full" || value.kind === "Thumbnail")) {
          if ("chunkBase64" in value && typeof value.chunkBase64 === "string") {
            outputParts
              .get(value.kind)
              ?.push(Uint8Array.from(base64ToBytes(value.chunkBase64)).buffer);
          }
          port.postMessage({ outputAcknowledged: outputId });
          return;
        }
        if ("done" in value && value.done === true) {
          port.postMessage({ outputAcknowledged: outputId });
          resolve();
        }
      });
      port.onDisconnect.addListener(() => reject(new Error("Screenshot output was interrupted.")));
    });
    try {
      await send({ operation: "Start", plan });
      const chunkBytes = 192 * 1024;
      for (const tile of tiles) {
        await send({ operation: "TileStart", geometry: tile.geometry });
        for (let offset = 0; offset < tile.imageBytes.byteLength; offset += chunkBytes) {
          await send({
            operation: "TileChunk",
            chunkBase64: bytesToBase64(
              tile.imageBytes.subarray(
                offset,
                Math.min(offset + chunkBytes, tile.imageBytes.byteLength),
              ),
            ),
          });
        }
        await send({ operation: "TileEnd" });
      }
      await send({ operation: "Finish" });
      await completed;
      return {
        webpBlob: new Blob(outputParts.get("Full"), { type: "image/webp" }),
        thumbnailWebpBlob: new Blob(outputParts.get("Thumbnail"), {
          type: "image/webp",
        }),
      };
    } finally {
      port.disconnect();
      await browser.offscreen.closeDocument();
    }
  }

  async restore(): Promise<void> {
    await browser.scripting.executeScript({
      target: { tabId: this.tabId },
      args: [this.originalScroll.x, this.originalScroll.y],
      func: (x: number, y: number): void => {
        const marker = "data-awsm-capture-hidden-v1";
        const original = "data-awsm-capture-visibility-v1";
        for (const element of document.querySelectorAll<HTMLElement>(`[${marker}]`)) {
          element.style.visibility = element.getAttribute(original) ?? "";
          element.removeAttribute(marker);
          element.removeAttribute(original);
        }
        window.scrollTo(x, y);
      },
    });
  }

  now(): number {
    return Date.now();
  }

  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
