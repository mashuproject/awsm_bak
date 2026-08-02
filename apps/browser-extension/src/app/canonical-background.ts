import { browser } from "wxt/browser";

import { CanonicalIndexedDb } from "../drivers/indexeddb/canonical-database";
import { NORMAL_STORAGE_REALM } from "../drivers/indexeddb/canonical-schema";
import { ChromeCaptureHost } from "../hosts/chrome/api";
import { FirefoxCaptureHost } from "../hosts/firefox/api";
import { CanonicalOpfsArtifactStore } from "../hosts/shared/canonical-artifact-store";
import {
  CanonicalBrowserPageCapture,
  type CanonicalBrowserPageCapturePort,
} from "../hosts/shared/canonical-browser-page-capture";
import type { CanonicalArtifactStore } from "../runtime/artifact/canonical-store";
import { CanonicalCaptureService } from "../runtime/capture/canonical-service";
import { CanonicalClientRuntime } from "../runtime/client/canonical-runtime";
import { CanonicalLibraryProjectionService } from "../runtime/library/canonical-projection";
import { CanonicalVaultService } from "../runtime/vault/canonical-service";
import { CanonicalApplication } from "./canonical-application";
import {
  CANONICAL_APPLICATION_STATE_CHANGED,
  installCanonicalApplicationMessageHandler,
} from "./canonical-application-host";

export interface CanonicalBackgroundApplicationOptions {
  readonly vaults: CanonicalVaultService;
  readonly artifacts: CanonicalArtifactStore;
  readonly pageCapture: CanonicalBrowserPageCapturePort;
  readonly now?: () => number;
  readonly createCaptureCommandId?: () => string;
  readonly notifyStateChanged?: () => void | Promise<void>;
}

export function createCanonicalBackgroundApplication(
  input: CanonicalBackgroundApplicationOptions,
): CanonicalApplication {
  const captures = new CanonicalCaptureService(input.vaults, input.artifacts);
  const library = new CanonicalLibraryProjectionService(input.vaults, input.artifacts);
  const runtime = new CanonicalClientRuntime(input.vaults, captures, library);
  return new CanonicalApplication(
    runtime,
    input.now,
    input.pageCapture,
    input.createCaptureCommandId,
    input.notifyStateChanged,
  );
}

function browserPageCapture(): CanonicalBrowserPageCapture {
  const firefox = browser.runtime.getManifest().browser_specific_settings?.gecko !== undefined;
  return new CanonicalBrowserPageCapture(
    firefox ? new FirefoxCaptureHost() : new ChromeCaptureHost(),
    browser.runtime.getManifest().version,
  );
}

export function startCanonicalBackground(): void {
  const storage = new CanonicalIndexedDb();
  const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
  const application = createCanonicalBackgroundApplication({
    vaults,
    artifacts: new CanonicalOpfsArtifactStore(),
    pageCapture: browserPageCapture(),
    notifyStateChanged: () =>
      browser.runtime.sendMessage(CANONICAL_APPLICATION_STATE_CHANGED).catch(() => undefined),
  });
  installCanonicalApplicationMessageHandler(browser.runtime, application);
}
