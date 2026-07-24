import type { RuntimeErrorId } from "../../domain/contracts";

export interface ActiveCaptureTab {
  readonly id?: number;
  readonly url?: string;
}

export interface CaptureHost {
  getActiveTab(): Promise<ActiveCaptureTab | undefined>;
  hasCapturePermission(): Promise<boolean>;
}

export interface CapturePreflight {
  readonly tabId: number;
  readonly url: string;
}

export class CaptureHostError extends Error {
  readonly id: RuntimeErrorId;

  constructor(id: RuntimeErrorId, message: string) {
    super(message);
    this.name = "CaptureHostError";
    this.id = id;
  }
}

function supportedPageUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function preflightCapture(
  host: CaptureHost,
  vaultUnlocked: boolean,
): Promise<CapturePreflight> {
  if (!vaultUnlocked) {
    throw new CaptureHostError("VAULT_LOCKED", "Unlock the Vault before capturing a page.");
  }
  const tab = await host.getActiveTab();
  if (tab?.id === undefined || !Number.isInteger(tab.id) || !supportedPageUrl(tab.url)) {
    throw new CaptureHostError(
      "UNSUPPORTED_URL",
      "Only active HTTP and HTTPS pages can be captured.",
    );
  }
  if (!(await host.hasCapturePermission())) {
    throw new CaptureHostError("PERMISSION_DENIED", "Chrome did not grant capture permission.");
  }
  return { tabId: tab.id, url: tab.url };
}
