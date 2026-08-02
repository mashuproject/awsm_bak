import {
  createPageSnapshotBlob,
  type SnapshotDocumentSource,
  type SnapshotOmissionV1,
  type SnapshotResourceSource,
} from "../../runtime/page-snapshot";

export interface CanonicalBrowserCaptureTab {
  readonly id?: number;
  readonly url?: string;
}

export interface CanonicalBrowserCollectedPageSnapshot {
  readonly metadata: {
    readonly finalUrl: string;
    readonly title: string;
  };
  readonly documents: readonly SnapshotDocumentSource[];
  readonly resources: readonly SnapshotResourceSource[];
  readonly omissions: readonly SnapshotOmissionV1[];
}

export interface CanonicalBrowserPageCaptureHost {
  getActiveTab(): Promise<CanonicalBrowserCaptureTab | undefined>;
  getTab(tabId: number): Promise<CanonicalBrowserCaptureTab>;
  hasCapturePermission(): Promise<boolean>;
  collectPageSnapshot(
    tabId: number,
    input: { readonly observedUrl: string },
    capturedAt: string,
    clientVersion: string,
  ): Promise<CanonicalBrowserCollectedPageSnapshot>;
}

export interface CanonicalBrowserPageCapturePort {
  captureActivePage(tabId?: number): Promise<{
    readonly originalUrl: string;
    readonly finalUrl: string;
    readonly title: string;
    readonly capturedAt: number;
    readonly primary: { readonly blob: Blob };
  }>;
}

export class CanonicalBrowserPageCaptureError extends Error {
  readonly id: "UNSUPPORTED_URL" | "PERMISSION_DENIED";

  constructor(id: "UNSUPPORTED_URL" | "PERMISSION_DENIED", message: string) {
    super(message);
    this.name = "CanonicalBrowserPageCaptureError";
    this.id = id;
  }
}

function canonicalHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CanonicalBrowserPageCaptureError(
      "UNSUPPORTED_URL",
      "Only active HTTP and HTTPS pages can be captured.",
    );
  }
  url.hash = "";
  return url.toString();
}

export class CanonicalBrowserPageCapture implements CanonicalBrowserPageCapturePort {
  constructor(
    private readonly host: CanonicalBrowserPageCaptureHost,
    private readonly clientVersion: string,
    private readonly now: () => number = Date.now,
  ) {}

  async captureActivePage(tabId?: number): Promise<{
    readonly originalUrl: string;
    readonly finalUrl: string;
    readonly title: string;
    readonly capturedAt: number;
    readonly primary: { readonly blob: Blob };
  }> {
    const tab =
      tabId === undefined ? await this.host.getActiveTab() : await this.host.getTab(tabId);
    if (tab?.id === undefined || !Number.isInteger(tab.id) || tab.url === undefined) {
      throw new CanonicalBrowserPageCaptureError(
        "UNSUPPORTED_URL",
        "Only active HTTP and HTTPS pages can be captured.",
      );
    }
    const originalUrl = canonicalHttpUrl(tab.url);
    if (!(await this.host.hasCapturePermission())) {
      throw new CanonicalBrowserPageCaptureError(
        "PERMISSION_DENIED",
        "The browser did not grant capture permission.",
      );
    }
    const capturedAt = this.now();
    if (!Number.isSafeInteger(capturedAt) || !Number.isFinite(new Date(capturedAt).valueOf())) {
      throw new TypeError("Capture time is not a valid millisecond timestamp");
    }
    const collected = await this.host.collectPageSnapshot(
      tab.id,
      { observedUrl: originalUrl },
      new Date(capturedAt).toISOString(),
      this.clientVersion,
    );
    const finalUrl = canonicalHttpUrl(collected.metadata.finalUrl);
    const snapshot = await createPageSnapshotBlob({
      capturedAt,
      originalUrl,
      finalUrl,
      documents: collected.documents,
      resources: collected.resources,
      omissions: collected.omissions,
    });
    return {
      originalUrl,
      finalUrl,
      title: collected.metadata.title,
      capturedAt,
      primary: { blob: snapshot.blob },
    };
  }
}
