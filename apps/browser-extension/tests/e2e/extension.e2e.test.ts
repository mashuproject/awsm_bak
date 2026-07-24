import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { BlobWriter } from "@zip.js/zip.js";
import { writeArtifactEnvelope } from "../../src/crypto/artifact-envelope";
import { deriveContextKeyFromCryptoKey } from "../../src/crypto/hkdf";
import type { ArtifactReferenceV1, CaptureMetadataV1 } from "../../src/domain/artifact-graph";
import {
  encodeStructuredContentSequence,
  normalizedTextFromBlocks,
} from "../../src/domain/structured-content";
import type {
  StoredArtifactObjectV1,
  StoredEvent,
  StoredObjectV1,
} from "../../src/drivers/indexeddb";
import type { ArtifactStore } from "../../src/runtime/artifact";
import {
  type PreparedCaptureArtifact,
  prepareCaptureRegistration,
} from "../../src/runtime/capture/registration";
import {
  VaultExportService,
  type VaultExportSource,
  writeVaultPackage,
} from "../../src/runtime/export";
import { createPageSnapshotBlob } from "../../src/runtime/page-snapshot";

declare const chrome: {
  readonly downloads: {
    download(options: {
      readonly url: string;
      readonly filename: string;
      readonly saveAs: boolean;
    }): Promise<number>;
    search(options: unknown): Promise<
      readonly {
        readonly id: number;
        readonly filename?: string;
        readonly mime?: string;
      }[]
    >;
    readonly onDeterminingFilename: {
      addListener(
        listener: (
          item: { readonly url: string },
          suggest: (suggestion?: {
            readonly filename: string;
            readonly conflictAction: "uniquify";
          }) => void,
        ) => void,
      ): void;
      removeListener(listener: unknown): void;
    };
  };
  readonly offscreen: {
    createDocument(options: {
      readonly url: string;
      readonly reasons: readonly string[];
      readonly justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  readonly runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

import {
  prepareVaultNameChange,
  type VaultRecordsV1,
  type VaultRepository,
  VaultService,
} from "../../src/runtime/vault";

const extensionBuildPath = resolve(process.env.AWSM_EXTENSION_BUILD ?? ".output/chrome-mv3");

async function preparePortableArtifact(
  encrypted: Map<string, Uint8Array>,
  rootKey: CryptoKey,
  vaultId: string,
  plaintext: Uint8Array,
  role: ArtifactReferenceV1["role"],
  kind: ArtifactReferenceV1["kind"],
  mimeType: string,
  acquiredAt: string,
): Promise<PreparedCaptureArtifact> {
  const objectId = crypto.randomUUID();
  const key = await deriveContextKeyFromCryptoKey(rootKey, {
    vaultId,
    domain: "vault:artifact:v1",
    contextId: objectId,
    keyVersion: 1,
  });
  const chunks: Uint8Array[] = [];
  const summary = await writeArtifactEnvelope({
    objectId,
    key,
    noncePrefix: crypto.getRandomValues(new Uint8Array(16)),
    plaintext: (async function* () {
      yield plaintext;
    })(),
    write: (chunk) => {
      chunks.push(Uint8Array.from(chunk));
    },
  });
  const wrapper = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    wrapper.set(chunk, offset);
    offset += chunk.byteLength;
  }
  encrypted.set(objectId, wrapper);
  const object: StoredArtifactObjectV1 = {
    version: 1,
    objectId,
    objectType: "Artifact",
    envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
    envelopeByteLength: summary.envelopeByteLength,
    envelopeChecksumAlgorithm: "hash:sha256:v1",
    envelopeChecksum: summary.envelopeChecksum,
  };
  return {
    object,
    reference: {
      artifactVersion: 1,
      artifactObjectId: objectId,
      kind,
      role,
      mimeType,
      acquiredAt,
      plaintextByteLength: summary.plaintextByteLength,
      checksumAlgorithm: "hash:sha256:v1",
      plaintextChecksum: summary.plaintextChecksum,
    },
  };
}

async function extensionPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

async function packagedAccountContext(
  testInfo: TestInfo,
  name: string,
): Promise<{
  context: BrowserContext;
  extensionId: string;
  popup: Page;
  worker: import("@playwright/test").Worker;
}> {
  const extensionPath = testInfo.outputPath(`${name}-extension`);
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  // Headless Chromium cannot display either the optional-origin prompt or the toolbar gesture that
  // grants activeTab for scripting. This permission exists only in the disposable E2E copy; the
  // shipping manifest remains unchanged and is checked by build.
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(testInfo.outputPath(`${name}-profile`), {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  return {
    context,
    extensionId,
    popup: await extensionPopup(context, extensionId),
    worker,
  };
}

async function toolbarPopup(
  client: Awaited<ReturnType<typeof packagedAccountContext>>,
): Promise<Page> {
  await client.worker.evaluate(async () => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: { action: { openPopup(): Promise<void> } };
      }
    ).chrome;
    await extensionApi.action.openPopup();
  });
  return extensionPopup(client.context, client.extensionId);
}

async function downloadBytes(page: Page, button: Locator): Promise<Uint8Array> {
  const existingIds = await page.evaluate(async () =>
    (await chrome.downloads.search({})).map((download) => download.id),
  );
  await button.click();
  await expect
    .poll(async () =>
      page.evaluate(async (excluded) => {
        const download = (
          await chrome.downloads.search({
            limit: 10,
            orderBy: ["-startTime"],
            state: "complete",
          })
        ).find((candidate) => !excluded.includes(candidate.id));
        return download?.filename;
      }, existingIds),
    )
    .not.toBeUndefined();
  const filename = await page.evaluate(async (excluded) => {
    const download = (
      await chrome.downloads.search({
        limit: 10,
        orderBy: ["-startTime"],
        state: "complete",
      })
    ).find((candidate) => !excluded.includes(candidate.id));
    return download?.filename;
  }, existingIds);
  if (filename === undefined) throw new Error("The browser download is unavailable.");
  return Uint8Array.from(await readFile(filename));
}

async function artifactStorageSnapshot(
  page: Page,
  vaultId: string,
): Promise<{
  readonly filenames: readonly string[];
  readonly remoteOnlyArtifactIds: readonly string[];
}> {
  return page.evaluate(async (expectedVaultId) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    const transaction = database.transaction("artifact_availability", "readonly");
    const availability = await new Promise<
      readonly { readonly vaultId: string; readonly artifactObjectId: string }[]
    >((resolveRows, reject) => {
      const request = transaction.objectStore("artifact_availability").getAll();
      request.addEventListener(
        "success",
        () =>
          resolveRows(
            request.result as readonly {
              readonly vaultId: string;
              readonly artifactObjectId: string;
            }[],
          ),
        { once: true },
      );
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    database.close();
    const root = await navigator.storage.getDirectory();
    const objects = await root.getDirectoryHandle("awsm-vault-objects");
    const directory = await objects.getDirectoryHandle(expectedVaultId);
    const filenames: string[] = [];
    for await (const [name] of directory.entries()) filenames.push(name);
    return {
      filenames: filenames.toSorted(),
      remoteOnlyArtifactIds: availability
        .filter((row) => row.vaultId === expectedVaultId)
        .map((row) => row.artifactObjectId)
        .toSorted(),
    };
  }, vaultId);
}

async function archiveFixture(
  client: Awaited<ReturnType<typeof packagedAccountContext>>,
  fixture: Page,
  expectedCaptureCount: number,
): Promise<void> {
  await fixture.bringToFront();
  const popup = await toolbarPopup(client);
  await popup.evaluate(async (fixtureUrl) => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: {
          runtime: {
            sendMessage(message: unknown, ...rest: unknown[]): unknown;
          };
          tabs: {
            query(value: unknown): Promise<readonly { id?: number; url?: string }[]>;
            update(id: number, value: { active: true }): Promise<unknown>;
          };
        };
      }
    ).chrome;
    const tabs = await extensionApi.tabs.query({});
    const fixtureTab = tabs.find((tab) => tab.id !== undefined && tab.url === fixtureUrl);
    if (fixtureTab?.id === undefined)
      throw new Error(
        `The fixture tab ${fixtureUrl} is unavailable among ${JSON.stringify(tabs.map((tab) => tab.url))}.`,
      );
    await extensionApi.tabs.update(fixtureTab.id, { active: true });
    const nativeQuery = extensionApi.tabs.query.bind(extensionApi.tabs);
    extensionApi.tabs.query = async (query: unknown) => {
      if (typeof query === "object" && query !== null && "active" in query && query.active === true)
        return [fixtureTab];
      return nativeQuery(query);
    };
    const nativeSendMessage = extensionApi.runtime.sendMessage.bind(extensionApi.runtime);
    extensionApi.runtime.sendMessage = (message: unknown, ...rest: unknown[]) => {
      const corrected =
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CaptureActivePage"
          ? { ...message, tabId: fixtureTab.id }
          : message;
      return nativeSendMessage(corrected, ...rest);
    };
  }, fixture.url());
  await expect(popup.getByRole("button", { name: "Archive this page" })).toBeVisible();
  let captured = false;
  for (let attempt = 0; attempt < 2 && !captured; attempt += 1) {
    const serverOrigin = (
      await appRequest<{
        account: { configuration: { serverOrigin?: string } };
      }>(popup, { type: "GetState" })
    ).account.configuration.serverOrigin;
    if (serverOrigin !== undefined) await waitForSynchronizedState(popup, serverOrigin);
    const priorCaptureJobId = (
      await appRequest<{ latestJob?: { jobId: string } }>(popup, {
        type: "GetState",
      })
    ).latestJob?.jobId;
    await popup.getByRole("button", { name: "Archive this page" }).click({ noWaitAfter: true });
    let terminal:
      | {
          readonly jobId: string;
          readonly state: string;
          readonly errorId?: string;
        }
      | undefined;
    await expect
      .poll(
        async () => {
          const latest = (
            await appRequest<{
              latestJob?: { jobId: string; state: string; errorId?: string };
            }>(popup, { type: "GetState" })
          ).latestJob;
          if (
            latest?.jobId === priorCaptureJobId ||
            latest === undefined ||
            (latest.state !== "Succeeded" && latest.state !== "Failed")
          )
            return false;
          terminal = latest;
          return true;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    captured = terminal?.state === "Succeeded";
    if (!captured && (terminal?.errorId !== "PAGE_SNAPSHOT_FAILED" || attempt > 0))
      throw new Error(
        `Capture failed at the authoritative Host boundary: ${JSON.stringify(terminal)}`,
      );
  }
  const observer = await client.context.newPage();
  await observer.goto(`chrome-extension://${client.extensionId}/library.html`);
  await expect(observer.getByRole("main")).toBeVisible();
  const activeVaultId = (
    await appRequest<{ workspace: { readonly activeVaultId?: string } }>(observer, {
      type: "GetState",
    })
  ).workspace.activeVaultId;
  if (activeVaultId === undefined) throw new Error("The captured Vault is not active.");
  await expect
    .poll(
      async () => {
        const groups = await appRequest<readonly { readonly captures: readonly unknown[] }[]>(
          observer,
          { type: "ListLibrary", expectedVaultId: activeVaultId },
        );
        return groups.reduce((total, group) => total + group.captures.length, 0);
      },
      { timeout: 60_000 },
    )
    .toBe(expectedCaptureCount);
  await observer.close();
  await popup.close();
  await Promise.all(
    client.context
      .pages()
      .filter((page) => page.url() === `chrome-extension://${client.extensionId}/popup.html`)
      .map((page) => page.close()),
  );
}

async function setCoordinationServerUnavailable(
  client: Awaited<ReturnType<typeof packagedAccountContext>>,
  unavailable: boolean,
): Promise<void> {
  await client.context.setOffline(unavailable);
  let keepalive = client.context
    .pages()
    .find((page) =>
      page.url().includes(`chrome-extension://${client.extensionId}/popup.html?keepalive=1`),
    );
  if (unavailable && keepalive === undefined) {
    keepalive = await client.context.newPage();
    await keepalive.goto(`chrome-extension://${client.extensionId}/popup.html?keepalive=1`);
    await keepalive.evaluate(() => {
      interface KeepalivePort {
        postMessage(value: unknown): void;
        disconnect(): void;
      }
      const scope = globalThis as typeof globalThis & {
        __awsmOfflineKeepalive?: { port: KeepalivePort; timer: number };
        chrome: {
          runtime: { connect(input: { name: string }): KeepalivePort };
        };
      };
      const port = scope.chrome.runtime.connect({
        name: "awsm:popup-lifetime",
      });
      port.postMessage({ keepalive: true });
      const timer = window.setInterval(() => port.postMessage({ keepalive: true }), 5_000);
      scope.__awsmOfflineKeepalive = { port, timer };
    });
  }
  const worker =
    client.context.serviceWorkers()[0] ?? (await client.context.waitForEvent("serviceworker"));
  await worker.evaluate((block) => {
    const worker = globalThis as typeof globalThis & {
      __awsmOriginalFetch?: typeof fetch;
    };
    worker.__awsmOriginalFetch ??= worker.fetch.bind(worker);
    worker.fetch = block
      ? (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.origin === "http://127.0.0.1:3300")
            return Promise.reject(new TypeError("Coordination Server unavailable"));
          return worker.__awsmOriginalFetch?.(input, init) as Promise<Response>;
        }
      : worker.__awsmOriginalFetch;
  }, unavailable);
  if (!unavailable && keepalive !== undefined) {
    await keepalive.evaluate(() => {
      interface KeepalivePort {
        disconnect(): void;
      }
      const scope = globalThis as typeof globalThis & {
        __awsmOfflineKeepalive?: { port: KeepalivePort; timer: number };
      };
      if (scope.__awsmOfflineKeepalive !== undefined) {
        window.clearInterval(scope.__awsmOfflineKeepalive.timer);
        scope.__awsmOfflineKeepalive.port.disconnect();
        delete scope.__awsmOfflineKeepalive;
      }
    });
    await keepalive.close();
  }
}

async function corruptRemoteArtifactObjects(artifactObjectIds: readonly string[]): Promise<void> {
  const rails = [
    "require 'json'",
    "require 'digest'",
    "JSON.parse(ENV.fetch('AWSM_CORRUPT_OBJECT_IDS')).each do |object_id|",
    "  record = OpaqueRecord.find_by!(object_id: object_id)",
    "  path = Coordination::DiskStore.path(record.storage_key)",
    "  File.open(path, 'r+b') do |file|",
    "    first = file.read(1).unpack1('C')",
    "    file.seek(0)",
    "    file.write([first ^ 0xff].pack('C'))",
    "  end",
    "  raise 'proof-server corruption failed' if Digest::SHA256.file(path).digest == record.sha256",
    "end",
  ].join("; ");
  await new Promise<void>((resolveValue, reject) => {
    execFile(
      "docker",
      [
        "compose",
        "-f",
        resolve("../..", "compose.sync-proof.yml"),
        "exec",
        "-T",
        "-e",
        `AWSM_CORRUPT_OBJECT_IDS=${JSON.stringify(artifactObjectIds)}`,
        "coordination-proof",
        "bin/rails",
        "runner",
        rails,
      ],
      (error, _stdout, stderr) => {
        if (error === null) resolveValue();
        else
          reject(
            new Error(`Failed to corrupt proof-server Artifacts: ${stderr}`, {
              cause: error,
            }),
          );
      },
    );
  });
}

async function appRequest<T>(page: Page, request: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ message }) =>
      new Promise<T>((resolveValue, reject) => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              runtime: {
                sendMessage(
                  value: unknown,
                  callback: (response: { ok: boolean; value?: T; error?: unknown }) => void,
                ): void;
              };
            };
          }
        ).chrome;
        extensionApi.runtime.sendMessage(
          message,
          (response: { ok: boolean; value?: T; error?: unknown }) => {
            if (response?.ok && response.value !== undefined) resolveValue(response.value);
            else reject(new Error(JSON.stringify(response?.error ?? response)));
          },
        );
      }),
    { message: request },
  );
}

async function faultControl(
  page: Page,
  action: "arm" | "arm-authentication-expiry" | "status" | "release",
  checkpoint?: string,
  failureId?: string,
): Promise<{
  ok: boolean;
  reached?: boolean;
  rejects?: boolean;
  lastFailure?: { message: string; id?: string; status?: number };
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(
        async ({
          action: requestedAction,
          checkpoint: requestedCheckpoint,
          failureId: requestedFailureId,
        }) => {
          const extensionApi = (
            globalThis as unknown as {
              chrome: {
                runtime: {
                  sendMessage(value: unknown): Promise<unknown>;
                };
              };
            }
          ).chrome;
          const response: unknown = await extensionApi.runtime.sendMessage({
            type: "awsm:test-fault-control",
            action: requestedAction,
            ...(requestedCheckpoint === undefined ? {} : { checkpoint: requestedCheckpoint }),
            ...(requestedFailureId === undefined ? {} : { failureId: requestedFailureId }),
          });
          if (
            typeof response !== "object" ||
            response === null ||
            !("ok" in response) ||
            response.ok !== true
          )
            throw new Error("Fault control did not receive a background response.");
          return response as {
            ok: boolean;
            reached?: boolean;
            rejects?: boolean;
            lastFailure?: {
              message: string;
              id?: string;
              status?: number;
            };
          };
        },
        { action, checkpoint, failureId },
      );
    } catch (error) {
      if (
        attempt === 2 ||
        !(error instanceof Error) ||
        !/message port closed|receiving end does not exist/iu.test(error.message)
      )
        throw error;
      await page.waitForTimeout(100);
    }
  }
  throw new Error("Fault control retry exhausted.");
}

async function stopExtensionWorker(
  context: BrowserContext,
  page: Page,
  extensionId: string,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const workerUrl = `chrome-extension://${extensionId}/background.js`;
  const versionId = new Promise<string>((resolveVersion) => {
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const version = versions.find((candidate) => candidate.scriptURL === workerUrl);
      if (version !== undefined) resolveVersion(version.versionId);
    });
  });
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopWorker", { versionId: await versionId });
  await cdp.detach();
}

async function synchronizationJob(
  page: Page,
): Promise<{ jobId: string; state: string; stage?: string; errorId?: string } | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    const transaction = database.transaction("synchronization_jobs", "readonly");
    const value = await new Promise<unknown>((resolveValue, reject) => {
      const request = transaction.objectStore("synchronization_jobs").get("active");
      request.addEventListener("success", () => resolveValue(request.result), {
        once: true,
      });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    database.close();
    if (
      typeof value !== "object" ||
      value === null ||
      !("jobId" in value) ||
      typeof value.jobId !== "string" ||
      !("state" in value) ||
      typeof value.state !== "string"
    )
      return undefined;
    return {
      jobId: value.jobId,
      state: value.state,
      ...(typeof Reflect.get(value, "stage") === "string"
        ? { stage: Reflect.get(value, "stage") as string }
        : {}),
      ...(typeof Reflect.get(value, "errorId") === "string"
        ? { errorId: Reflect.get(value, "errorId") as string }
        : {}),
    };
  });
}

async function waitForSynchronizedState(page: Page, serverOrigin: string): Promise<string> {
  let vaultId: string | undefined;
  await expect
    .poll(
      async () => {
        const state = await appRequest<{
          account: {
            vaultSyncState: string;
            errorId?: string;
            configuration: { serverOrigin?: string };
          };
          workspace: { activeVaultId?: string };
        }>(page, { type: "GetState" });
        vaultId = state.workspace.activeVaultId;
        return {
          serverOrigin: state.account.configuration.serverOrigin,
          synchronization:
            state.account.errorId === undefined
              ? state.account.vaultSyncState
              : `${state.account.vaultSyncState}:${state.account.errorId}`,
          hasVault: vaultId !== undefined,
        };
      },
      { timeout: 120_000 },
    )
    .toEqual({ serverOrigin, synchronization: "UpToDate", hasVault: true });
  if (vaultId === undefined) throw new Error("The synchronized Vault was not selected.");
  return vaultId;
}

async function createSynchronizedClient(
  testInfo: TestInfo,
  name: string,
  serverOrigin: string,
  email: string,
  password: string,
): Promise<
  Awaited<ReturnType<typeof packagedAccountContext>> & {
    readonly vaultId: string;
  }
> {
  const client = await packagedAccountContext(testInfo, name);
  await appRequest(client.popup, { type: "ConfigureSyncServer", serverOrigin });
  await appRequest(client.popup, {
    type: "SignupAccount",
    email,
    password,
    recoveryAcknowledged: true,
    newVaultName: name,
  });
  return {
    ...client,
    vaultId: await waitForSynchronizedState(client.popup, serverOrigin),
  };
}

async function loginSynchronizedClient(
  testInfo: TestInfo,
  name: string,
  serverOrigin: string,
  email: string,
  password: string,
): Promise<
  Awaited<ReturnType<typeof packagedAccountContext>> & {
    readonly vaultId: string;
  }
> {
  const client = await packagedAccountContext(testInfo, name);
  await appRequest(client.popup, { type: "ConfigureSyncServer", serverOrigin });
  await appRequest(client.popup, { type: "LoginAccount", email, password });
  return {
    ...client,
    vaultId: await waitForSynchronizedState(client.popup, serverOrigin),
  };
}

async function switchPackagedClient(
  page: Page,
  vaultId: string,
  candidateOrigin: string,
  mode: "Login" | "Signup",
  email: string,
  password: string,
): Promise<void> {
  await appRequest(page, {
    type: "BeginServerSwitch",
    candidateOrigin,
    expectedVaultId: vaultId,
  });
  await appRequest(page, {
    type: mode === "Login" ? "LoginServerSwitchCandidate" : "SignupServerSwitchCandidate",
    email,
    password,
  });
  await waitForSynchronizedState(page, candidateOrigin);
}

async function interruptServerSwitchAt(
  client: Awaited<ReturnType<typeof packagedAccountContext>>,
  testInfo: TestInfo,
  page: Page,
  vaultId: string,
  candidateOrigin: string,
  email: string,
  password: string,
  checkpoint: string,
  captureName: string,
): Promise<void> {
  await appRequest(page, {
    type: "BeginServerSwitch",
    candidateOrigin,
    expectedVaultId: vaultId,
  });
  await faultControl(page, "arm", checkpoint);
  const switching = appRequest(page, {
    type: "LoginServerSwitchCandidate",
    email,
    password,
  }).catch(() => undefined);
  await expect
    .poll(
      async () => {
        const [fault, state] = await Promise.all([
          faultControl(page, "status"),
          appRequest<{
            readonly serverSwitch?: {
              readonly state: string;
              readonly errorId?: string;
              readonly direction?: string;
            };
          }>(page, { type: "GetState" }),
        ]);
        if (state.serverSwitch?.state === "Failed")
          throw new Error(
            `Server Switch failed before ${checkpoint}: ${JSON.stringify({
              switch: state.serverSwitch,
              failure: fault.lastFailure,
            })}`,
          );
        return fault.reached;
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  const visual = await client.context.newPage();
  await visual.goto(`chrome-extension://${client.extensionId}/library.html`);
  await visual.getByRole("button", { name: "Settings" }).click();
  await expect(visual.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await visual.screenshot({
    path: testInfo.outputPath(`${captureName}-desktop.png`),
  });
  await visual.setViewportSize({ width: 420, height: 800 });
  await visual.screenshot({
    path: testInfo.outputPath(`${captureName}-narrow.png`),
  });
  await visual.close();
  await stopExtensionWorker(client.context, page, client.extensionId);
  void switching;
  await page.reload();
  await waitForSynchronizedState(page, candidateOrigin);
}

async function switchWithApplyingCapture(
  client: Awaited<ReturnType<typeof packagedAccountContext>>,
  testInfo: TestInfo,
  page: Page,
  vaultId: string,
  candidateOrigin: string,
  email: string,
  password: string,
  captureName: string,
): Promise<void> {
  await appRequest(page, {
    type: "BeginServerSwitch",
    candidateOrigin,
    expectedVaultId: vaultId,
  });
  await faultControl(page, "arm", "server-switch:after-classification");
  const switching = appRequest(page, {
    type: "LoginServerSwitchCandidate",
    email,
    password,
  });
  await expect
    .poll(async () => (await faultControl(page, "status")).reached, {
      timeout: 120_000,
    })
    .toBe(true);
  const visual = await client.context.newPage();
  await visual.goto(`chrome-extension://${client.extensionId}/library.html`);
  await visual.getByRole("button", { name: "Settings" }).click();
  await expect(visual.getByText("Combining compatible append-only history…")).toBeVisible();
  await visual.screenshot({
    path: testInfo.outputPath(`${captureName}-desktop.png`),
  });
  await visual.setViewportSize({ width: 420, height: 800 });
  await visual.screenshot({
    path: testInfo.outputPath(`${captureName}-narrow.png`),
  });
  await visual.close();
  await faultControl(page, "release");
  await switching.catch(() => undefined);
  await waitForSynchronizedState(page, candidateOrigin);
}

async function activeGeneration(page: Page): Promise<{
  readonly generationId: string;
  readonly generationNumber: number;
}> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    const transaction = database.transaction("vault_head", "readonly");
    const values = await new Promise<unknown[]>((resolveValues, reject) => {
      const request = transaction.objectStore("vault_head").getAll();
      request.addEventListener("success", () => resolveValues(request.result), {
        once: true,
      });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    database.close();
    const value = values[0];
    if (
      typeof value !== "object" ||
      value === null ||
      typeof Reflect.get(value, "generationId") !== "string" ||
      typeof Reflect.get(value, "generationNumber") !== "number"
    )
      throw new Error("The active Generation is unavailable.");
    return {
      generationId: Reflect.get(value, "generationId") as string,
      generationNumber: Reflect.get(value, "generationNumber") as number,
    };
  });
}

async function extractNewestCapture(page: Page, vaultId: string): Promise<void> {
  const groups = await appRequest<
    readonly {
      readonly captures: readonly {
        readonly bundleId: string;
        readonly capturedAt: string;
      }[];
    }[]
  >(page, { type: "ListLibrary", expectedVaultId: vaultId });
  const bundleId = groups
    .flatMap((group) => group.captures)
    .toSorted((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0]?.bundleId;
  if (bundleId === undefined) throw new Error("A newest Capture is required.");
  await appRequest(page, {
    type: "ExtractCaptures",
    expectedVaultId: vaultId,
    bundleIds: [bundleId],
  });
  const state = await appRequest<{
    account: { configuration: { serverOrigin?: string } };
  }>(page, {
    type: "GetState",
  });
  if (state.account.configuration.serverOrigin === undefined)
    throw new Error("The synchronized origin is unavailable.");
  await waitForSynchronizedState(page, state.account.configuration.serverOrigin);
}

async function vacuumDeleted(page: Page, vaultId: string): Promise<void> {
  await appRequest(page, { type: "VacuumVault", expectedVaultId: vaultId });
  const state = await appRequest<{
    account: { configuration: { serverOrigin?: string } };
  }>(page, {
    type: "GetState",
  });
  if (state.account.configuration.serverOrigin === undefined)
    throw new Error("The synchronized origin is unavailable.");
  await waitForSynchronizedState(page, state.account.configuration.serverOrigin);
}

async function sharedDeletedBase(testInfo: TestInfo, name: string) {
  const password = "x";
  const sourceEmail = `${name}-source-${crypto.randomUUID()}@example.test`;
  const candidateEmail = `${name}-candidate-${crypto.randomUUID()}@example.test`;
  const client = await createSynchronizedClient(
    testInfo,
    `${name}-primary`,
    "http://127.0.0.1:3300",
    sourceEmail,
    password,
  );
  const page = await client.context.newPage();
  await page.goto(`chrome-extension://${client.extensionId}/library.html`);
  const fixture = await client.context.newPage();
  await fixture.goto("http://127.0.0.1:4174/fixture");
  for (let captureNumber = 1; captureNumber <= 3; captureNumber += 1) {
    await fixture.evaluate((number) => {
      document.title = `Shared baseline capture ${String(number)}`;
      document.body.dataset.baselineCapture = String(number);
    }, captureNumber);
    await archiveFixture(client, fixture, captureNumber);
  }
  const groups = await appRequest<
    readonly { readonly captures: readonly { readonly bundleId: string }[] }[]
  >(page, { type: "ListLibrary", expectedVaultId: client.vaultId });
  const baselineBundleIds = groups.flatMap((group) =>
    group.captures.map((capture) => capture.bundleId),
  );
  if (baselineBundleIds.length !== 3)
    throw new Error(
      `The shared Server Switch baseline expected three Captures, found ${String(baselineBundleIds.length)}.`,
    );
  await appRequest(page, {
    type: "ExtractCaptures",
    expectedVaultId: client.vaultId,
    bundleIds: [baselineBundleIds[0]],
  });
  await waitForSynchronizedState(page, "http://127.0.0.1:3300");
  await appRequest(page, {
    type: "DeleteCaptures",
    expectedVaultId: client.vaultId,
    bundleIds: [baselineBundleIds[1]],
  });
  await waitForSynchronizedState(page, "http://127.0.0.1:3300");
  await switchPackagedClient(
    page,
    client.vaultId,
    "http://127.0.0.1:3301",
    "Signup",
    candidateEmail,
    password,
  );
  return {
    client,
    page,
    fixture,
    password,
    sourceEmail,
    candidateEmail,
    baselineBundleIds,
  };
}

test("takes a first-time self-hosted user through capture, sync, Vacuum, and stale recovery", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(900_000);
  expect(browserName).toBe("chromium");
  const email = `journey-${crypto.randomUUID()}@example.test`;
  const password = "correct horse archive battery";
  const first = await packagedAccountContext(testInfo, "journey-first");
  let second: Awaited<ReturnType<typeof packagedAccountContext>> | undefined;
  let disconnectedSecondGeneration: Awaited<ReturnType<typeof activeGeneration>> | undefined;
  let vaultId: string | undefined;
  try {
    await test.step("choose the self-hosted server and create the Account", async () => {
      await first.popup.close();
      const setupTab = await first.context.newPage();
      const setupPopup = await toolbarPopup(first);
      const signupOpened = first.context.waitForEvent("page");
      await setupPopup.getByRole("link", { name: "Set up synchronization" }).click();
      const signup = await signupOpened;
      await signup.waitForLoadState("domcontentloaded");
      await expect(signup.getByRole("heading", { name: "Choose synchronization" })).toBeVisible();
      await signup.setViewportSize({ width: 1280, height: 900 });
      await signup.screenshot({
        path: testInfo.outputPath("signup-server-choice-wide.png"),
      });
      await signup.setViewportSize({ width: 390, height: 844 });
      await signup.screenshot({
        path: testInfo.outputPath("signup-server-choice-narrow.png"),
      });
      await signup.getByText("Use a self-hosted server", { exact: true }).click();
      await signup
        .getByRole("textbox", { name: "Self-hosted server origin" })
        .fill("http://127.0.0.1:3300");
      await signup.getByRole("button", { name: "Use self-hosted server" }).click();
      await expect(signup.getByRole("heading", { name: "Create your Account" })).toBeVisible();
      await signup.setViewportSize({ width: 1280, height: 900 });
      await signup.screenshot({
        path: testInfo.outputPath("signup-account-wide.png"),
      });
      await signup.setViewportSize({ width: 390, height: 844 });
      await signup.screenshot({
        path: testInfo.outputPath("signup-account-narrow.png"),
      });
      await signup.getByRole("textbox", { name: "Email" }).fill(email);
      await signup.getByLabel("Password", { exact: true }).fill(password);
      await signup.getByLabel("Confirm password").fill(password);
      await signup.getByLabel(/no password recovery/u).check();
      await signup.getByLabel("Vault name").fill("First Journey Archive");
      await signup.getByRole("button", { name: "Create Account" }).click();
      await expect(signup.getByRole("status")).toHaveText(
        "Account created. Returning to your page…",
        { timeout: 120_000 },
      );
      await signup.waitForEvent("close");
      await setupTab.goto(`chrome-extension://${first.extensionId}/library.html`);
      const state = await appRequest<{
        account: {
          accountState: string;
          vaultSyncState: string;
          configuration: { mode: string; serverOrigin?: string };
        };
        workspace: { activeVaultId?: string };
      }>(setupTab, { type: "GetState" });
      expect(state.account).toMatchObject({
        accountState: "Authenticated",
        configuration: {
          mode: "Configured",
          serverOrigin: "http://127.0.0.1:3300",
        },
      });
      vaultId = state.workspace.activeVaultId;
      expect(vaultId).toBeTruthy();
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ account: { vaultSyncState: string } }>(setupTab, {
                type: "GetState",
              })
            ).account.vaultSyncState,
          { timeout: 120_000 },
        )
        .toBe("UpToDate");
      await setupTab.close();
    });

    const firstFixture = await first.context.newPage();
    const firstLibrary = await first.context.newPage();
    await test.step("capture two versions and extract a Collection", async () => {
      await firstFixture.goto("http://127.0.0.1:4174/fixture");
      await archiveFixture(first, firstFixture, 1);
      await firstLibrary.goto(`chrome-extension://${first.extensionId}/library.html`);
      await expect(firstLibrary.getByText("1 capture", { exact: false }).first()).toBeVisible({
        timeout: 60_000,
      });
      await firstFixture.evaluate(() => {
        const band = document.querySelector<HTMLElement>(".red");
        if (band === null) throw new Error("Fixture mutation target is missing.");
        band.textContent = "second synchronized capture";
        band.style.background = "#5146a5";
      });
      await archiveFixture(first, firstFixture, 2);
      await waitForSynchronizedState(firstLibrary, "http://127.0.0.1:3300");
      await firstLibrary.bringToFront();
      await expect(firstLibrary.getByText("2 captures", { exact: false })).toBeVisible({
        timeout: 60_000,
      });
      await firstLibrary.locator(".card").click();
      await firstLibrary
        .getByRole("checkbox", { name: /Select capture from/u })
        .first()
        .check({ timeout: 60_000 });
      await firstLibrary.getByRole("button", { name: "Extract to new collection" }).click();
      await expect(firstLibrary.locator(".library-card")).toHaveCount(2);
    });

    await test.step("bootstrap Browser B and synchronize Collection management both ways", async () => {
      second = await packagedAccountContext(testInfo, "journey-second");
      await second.popup.close();
      const setupTab = await second.context.newPage();
      const setupPopup = await toolbarPopup(second);
      await appRequest(setupPopup, {
        type: "ConfigureSyncServer",
        serverOrigin: "http://127.0.0.1:3300",
      });
      await setupPopup.reload();
      await setupPopup.getByRole("textbox", { name: "Email" }).fill(email);
      await setupPopup.getByLabel("Password").fill(password);
      await setupPopup.getByRole("button", { name: "Sign in" }).click();
      await expect
        .poll(
          async () => {
            const state = await appRequest<{
              account: { vaultSyncState: string };
              workspace: { activeVaultId?: string };
            }>(setupPopup, { type: "GetState" });
            return {
              sync: state.account.vaultSyncState,
              vaultId: state.workspace.activeVaultId,
            };
          },
          { timeout: 120_000 },
        )
        .toEqual({ sync: "UpToDate", vaultId });
      await setupPopup.close();
      await setupTab.close();

      const secondLibrary = await second.context.newPage();
      await secondLibrary.goto(`chrome-extension://${second.extensionId}/library.html`);
      await expect(secondLibrary.locator(".library-card")).toHaveCount(2, {
        timeout: 60_000,
      });
      await secondLibrary
        .locator(".library-card")
        .first()
        .getByRole("button", { name: "Merge with…" })
        .click();
      const merge = secondLibrary.getByRole("dialog", {
        name: /Merge collections into/u,
      });
      await merge.getByRole("checkbox").check();
      await merge.getByRole("button", { name: "Merge into this collection" }).click();
      await expect(secondLibrary.locator(".library-card")).toHaveCount(1);
      await expect(firstLibrary.locator(".library-card")).toHaveCount(1, {
        timeout: 60_000,
      });
    });

    await test.step("disconnect Browser B and Vacuum from Browser A", async () => {
      if (second === undefined) throw new Error("Browser B is unavailable.");
      await setCoordinationServerUnavailable(second, true);
      const offlineProbe = await second.context.newPage();
      await offlineProbe.goto(`chrome-extension://${second.extensionId}/library.html`);
      disconnectedSecondGeneration = await activeGeneration(offlineProbe);
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ account: { vaultSyncState: string } }>(offlineProbe, {
                type: "GetState",
              })
            ).account.vaultSyncState,
          { timeout: 60_000 },
        )
        .toBe("Offline");
      await offlineProbe.close();

      await firstLibrary.locator(".card").click();
      await firstLibrary.locator(".version").first().click();
      const priorSynchronizationJobId = (await synchronizationJob(firstLibrary))?.jobId;
      firstLibrary.once("dialog", (dialog) => void dialog.accept());
      await firstLibrary.getByRole("button", { name: "Delete capture" }).click();
      await firstLibrary.getByText("Deleted (1)", { exact: true }).click();
      await expect
        .poll(
          async () => {
            const job = await synchronizationJob(firstLibrary);
            return job?.jobId !== priorSynchronizationJobId && job?.state === "Succeeded";
          },
          { timeout: 120_000 },
        )
        .toBe(true);
      const preVacuumGeneration = await activeGeneration(firstLibrary);
      await faultControl(firstLibrary, "arm-authentication-expiry", "vacuum:before-candidate");
      await expect
        .poll(() => faultControl(firstLibrary, "status"))
        .toMatchObject({
          ok: true,
          reached: false,
          rejects: true,
        });
      firstLibrary.once("dialog", (dialog) => void dialog.accept());
      await firstLibrary.getByRole("button", { name: "Vacuum Vault" }).click();
      await expect(
        firstLibrary.getByText("Vault Vacuum could not be completed safely."),
      ).toBeVisible({ timeout: 120_000 });
      await expect(firstLibrary.getByText("Deleted (1)", { exact: true })).toBeVisible();
      const authenticationState = await appRequest<{
        account: { accountState: string; vaultSyncState: string };
      }>(firstLibrary, { type: "GetState" });
      expect(authenticationState.account).toMatchObject({
        accountState: "SignedOut",
        vaultSyncState: "AuthenticationRequired",
      });
      await firstLibrary.getByRole("button", { name: "Settings" }).click();
      await expect(firstLibrary.getByText("Sign-in required", { exact: true })).toBeVisible();
      await firstLibrary.screenshot({
        path: testInfo.outputPath("journey-vacuum-authentication-required.png"),
      });
      await firstLibrary.keyboard.press("Escape");
      await faultControl(firstLibrary, "release");
      const login = await toolbarPopup(first);
      await login.getByRole("textbox", { name: "Email" }).fill(email);
      await login.getByLabel("Password").fill(password);
      await login.getByRole("button", { name: "Sign in" }).click();
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ account: { vaultSyncState: string } }>(login, {
                type: "GetState",
              })
            ).account.vaultSyncState,
          { timeout: 120_000 },
        )
        .toBe("UpToDate");
      await login.close();
      firstLibrary.once("dialog", (dialog) => void dialog.accept());
      await firstLibrary.getByRole("button", { name: "Vacuum Vault" }).click();
      await expect
        .poll(
          async () => {
            const failed = await firstLibrary
              .getByText("Vault Vacuum could not be completed safely.")
              .isVisible();
            if (failed) {
              const diagnostic = await faultControl(firstLibrary, "status");
              throw new Error(
                `The resumed synchronized Vacuum failed (${JSON.stringify(diagnostic.lastFailure)})`,
              );
            }
            const [deleted, generation] = await Promise.all([
              appRequest<readonly unknown[]>(firstLibrary, {
                type: "ListDeleted",
                expectedVaultId: vaultId,
              }),
              activeGeneration(firstLibrary),
            ]);
            return {
              vacuumed:
                deleted.length === 0 &&
                generation.generationNumber === preVacuumGeneration.generationNumber + 1,
              failed,
            };
          },
          { timeout: 120_000 },
        )
        .toEqual({ vacuumed: true, failed: false });
      if (await firstLibrary.getByText("Vault Vacuum could not be completed safely.").isVisible()) {
        throw new Error("The visible synchronized Vacuum failed.");
      }
      let stableSynchronizationJobId: string | undefined;
      let stableSynchronizationReads = 0;
      await expect
        .poll(
          async () => {
            const state = await appRequest<{
              account: { vaultSyncState: string };
            }>(firstLibrary, {
              type: "GetState",
            });
            const job = await synchronizationJob(firstLibrary);
            if (job?.state === "Failed")
              throw new Error(`Post-Vacuum synchronization failed: ${JSON.stringify(job)}`);
            if (state.account.vaultSyncState !== "UpToDate" || job?.state !== "Succeeded") {
              stableSynchronizationJobId = undefined;
              stableSynchronizationReads = 0;
              return undefined;
            }
            if (stableSynchronizationJobId === job.jobId) stableSynchronizationReads += 1;
            else {
              stableSynchronizationJobId = job.jobId;
              stableSynchronizationReads = 1;
            }
            return stableSynchronizationReads >= 3 ? job : undefined;
          },
          { timeout: 120_000, intervals: [500, 1_000, 1_000] },
        )
        .toMatchObject({ state: "Succeeded" });
      const stableJobId = (await synchronizationJob(firstLibrary))?.jobId;
      for (let index = 0; index < 3; index += 1)
        await appRequest(firstLibrary, { type: "GetState" });
      expect((await synchronizationJob(firstLibrary))?.jobId).toBe(stableJobId);
      await firstLibrary.getByRole("button", { name: "Settings" }).click();
      await expect(firstLibrary.getByText("Up to date", { exact: true })).toBeVisible();
      await firstLibrary.screenshot({
        path: testInfo.outputPath("journey-vacuum-up-to-date.png"),
      });
      await firstLibrary.keyboard.press("Escape");
    });

    await test.step("review the Export warning and resolve Browser B's stale Replica", async () => {
      if (second === undefined) throw new Error("Browser B is unavailable.");
      const secondClient = second;
      const staleLibrary = await secondClient.context.newPage();
      await staleLibrary.goto(`chrome-extension://${secondClient.extensionId}/library.html`);
      expect(await activeGeneration(staleLibrary)).toEqual(disconnectedSecondGeneration);
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ account: { vaultSyncState: string } }>(staleLibrary, {
                type: "GetState",
              })
            ).account.vaultSyncState,
          { timeout: 120_000 },
        )
        .toBe("Offline");
      await staleLibrary.getByRole("button", { name: "Settings" }).click();
      const settings = staleLibrary.getByRole("dialog", {
        name: "Settings",
      });
      await expect(settings.getByText("Offline", { exact: true })).toBeVisible();
      await expect(settings.getByRole("button", { name: "Retry synchronization" })).toBeVisible();
      await staleLibrary.screenshot({
        path: testInfo.outputPath("journey-offline-retry.png"),
      });
      await setCoordinationServerUnavailable(second, false);
      await settings.getByRole("button", { name: "Retry synchronization" }).click();
      try {
        await expect
          .poll(
            async () =>
              (
                await appRequest<{
                  account: { vaultSyncState: string; errorId?: string };
                }>(staleLibrary, { type: "GetState" })
              ).account.vaultSyncState,
            { timeout: 120_000 },
          )
          .toBe("Conflict");
      } catch (error) {
        const [current, job, localGeneration, sourceGeneration, diagnostic] = await Promise.all([
          appRequest<{
            account: { vaultSyncState: string; errorId?: string };
          }>(staleLibrary, { type: "GetState" }),
          synchronizationJob(staleLibrary),
          activeGeneration(staleLibrary),
          activeGeneration(firstLibrary),
          faultControl(staleLibrary, "status"),
        ]);
        throw new Error(
          `Stale discovery did not conflict (${JSON.stringify({
            state: current.account,
            jobState: job?.state,
            jobStage: job?.stage,
            jobErrorId: job?.errorId,
            localGenerationNumber: localGeneration.generationNumber,
            sourceGenerationNumber: sourceGeneration.generationNumber,
            generationsEqual: localGeneration.generationId === sourceGeneration.generationId,
            diagnostic: diagnostic.lastFailure,
          })})`,
          { cause: error },
        );
      }
      if (!(await settings.isVisible()))
        await staleLibrary.getByRole("button", { name: "Settings" }).click();
      await expect(staleLibrary.getByRole("button", { name: "Resolve stale Vault" })).toBeVisible({
        timeout: 120_000,
      });
      await expect(staleLibrary.getByText(/2 captures/u)).toBeVisible();
      await staleLibrary.screenshot({
        path: testInfo.outputPath("journey-stale-conflict.png"),
      });
      await settings.getByRole("button", { name: "Close Settings", exact: true }).click();
      await staleLibrary.getByRole("button", { name: "Resolve stale Vault" }).click();
      const discard = staleLibrary.getByRole("dialog", {
        name: "Resolve stale synchronized Vault",
      });
      await discard.getByLabel("Export passphrase", { exact: true }).fill(password);
      await discard.getByLabel("Confirm export passphrase").fill(password);
      await discard.getByRole("button", { name: "Export encrypted Vault" }).click();
      await expect(discard.getByRole("button", { name: "Export downloaded" })).toBeVisible({
        timeout: 120_000,
      });
      const recoveryPackagePath = await staleLibrary.evaluate(async () => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              downloads: {
                search(query: {
                  readonly limit: 1;
                  readonly orderBy: readonly ["-startTime"];
                  readonly state: "complete";
                }): Promise<readonly { readonly filename?: string }[]>;
              };
            };
          }
        ).chrome;
        const downloads = await extensionApi.downloads.search({
          limit: 1,
          orderBy: ["-startTime"],
          state: "complete",
        });
        const exported = downloads[0];
        if (exported?.filename === undefined)
          throw new Error("The completed Recovery Export download is unavailable.");
        return exported.filename;
      });
      expect((await readFile(recoveryPackagePath)).byteLength).toBeGreaterThan(0);
      await staleLibrary.setViewportSize({ width: 390, height: 844 });
      await staleLibrary.screenshot({
        path: testInfo.outputPath("journey-stale-export-success-narrow.png"),
        fullPage: true,
      });
      const interruptDiscardAt = async (checkpoint: string): Promise<void> => {
        const activeDiscard = staleLibrary.getByRole("dialog", {
          name: "Resolve stale synchronized Vault",
        });
        await faultControl(staleLibrary, "arm", checkpoint);
        const skipExport = activeDiscard.getByLabel(
          "I understand that I am declining the recommended encrypted Export.",
        );
        const overwrite = activeDiscard.getByLabel(
          "I understand that the stale synchronized Vault will be completely overwritten by server data.",
        );
        if (await skipExport.isEnabled()) {
          await skipExport.check();
          await overwrite.check();
        }
        await activeDiscard
          .getByRole("button", {
            name: "Discard stale local Replica and use server data",
          })
          .click();
        await expect
          .poll(async () => (await faultControl(staleLibrary, "status")).reached, {
            timeout: 120_000,
          })
          .toBe(true);
        await stopExtensionWorker(secondClient.context, staleLibrary, secondClient.extensionId);
        await staleLibrary.reload();
      };
      for (const checkpoint of [
        "stale-discard:prepare-server-replacement",
        "stale-discard:server-replacement-prepared",
        "stale-discard:before-activation",
      ]) {
        await interruptDiscardAt(checkpoint);
        await expect(staleLibrary.getByRole("button", { name: "Resolve stale Vault" })).toBeVisible(
          {
            timeout: 120_000,
          },
        );
        await expect(staleLibrary.getByText(/2 captures/u)).toBeVisible();
        await staleLibrary.getByRole("button", { name: "Resolve stale Vault" }).click();
      }
      await interruptDiscardAt("stale-discard:after-activation");
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ account: { vaultSyncState: string } }>(staleLibrary, {
                type: "GetState",
              })
            ).account.vaultSyncState,
          { timeout: 120_000 },
        )
        .toBe("UpToDate");
      await staleLibrary.setViewportSize({ width: 1280, height: 900 });
      await expect(staleLibrary.getByText("1 capture", { exact: false })).toBeVisible();
      const state = await appRequest<{
        workspace: { vaults: readonly unknown[] };
      }>(staleLibrary, {
        type: "GetState",
      });
      expect(state.workspace.vaults).toHaveLength(1);
    });

    await test.step("publish the Vault to an empty second self-hosted server", async () => {
      if (vaultId === undefined) throw new Error("The first Journey Vault is unavailable.");
      await firstLibrary.bringToFront();
      const reliefEstimate = await appRequest<{
        readonly candidateArtifacts: number;
        readonly candidateBytes: number;
      }>(firstLibrary, {
        type: "GetStorageReliefEstimate",
        expectedVaultId: vaultId,
      });
      expect(reliefEstimate.candidateArtifacts).toBeGreaterThanOrEqual(2);
      firstLibrary.once("dialog", (dialog) => void dialog.accept());
      await firstLibrary.getByRole("button", { name: "Reduce device storage" }).click();
      await expect
        .poll(
          async () =>
            (
              await appRequest<{
                readonly latestStorageReliefJob?: { readonly state: string };
              }>(firstLibrary, { type: "GetState" })
            ).latestStorageReliefJob?.state,
          { timeout: 120_000 },
        )
        .toBe("Succeeded");
      const remoteSource = await artifactStorageSnapshot(firstLibrary, vaultId);
      expect(remoteSource.remoteOnlyArtifactIds).toHaveLength(reliefEstimate.candidateArtifacts);
      for (const artifactObjectId of remoteSource.remoteOnlyArtifactIds)
        expect(remoteSource.filenames).not.toContain(`${artifactObjectId}.artifact`);
      await faultControl(firstLibrary, "arm", "synchronization:before-reconciliation-commit");
      await appRequest(firstLibrary, { type: "WakeSynchronization" });
      await expect
        .poll(async () => (await faultControl(firstLibrary, "status")).reached, {
          timeout: 120_000,
        })
        .toBe(true);
      await firstLibrary.getByRole("button", { name: "Settings" }).click();
      const settings = firstLibrary.getByRole("dialog", {
        name: "Settings",
      });
      await settings
        .getByRole("textbox", { name: "Change synchronization server" })
        .fill("http://127.0.0.1:3301");
      await settings.getByLabel(/verify and reconcile the candidate/u).check();
      await settings.getByRole("button", { name: "Change server" }).click();
      await expect(settings).toBeHidden({ timeout: 60_000 });
      await firstLibrary.getByRole("button", { name: "Settings" }).click();
      const candidate = firstLibrary.getByRole("dialog", {
        name: "Settings",
      });
      await expect(candidate.getByText(/current server remains active/u)).toBeVisible();
      await firstLibrary.screenshot({
        path: testInfo.outputPath("server-switch-login-desktop.png"),
      });
      await firstLibrary.setViewportSize({ width: 420, height: 800 });
      await firstLibrary.screenshot({
        path: testInfo.outputPath("server-switch-login-narrow.png"),
      });
      await firstLibrary.setViewportSize({ width: 1280, height: 900 });
      await candidate.getByRole("textbox", { name: "Email" }).fill("switch@example.test");
      await candidate.getByLabel("Password").fill(password);
      await faultControl(firstLibrary, "arm", "server-switch:after-classification");
      await candidate.getByRole("button", { name: "Create account" }).click();
      await expect
        .poll(async () => (await faultControl(firstLibrary, "status")).reached, {
          timeout: 120_000,
        })
        .toBe(true);
      const progress = await first.context.newPage();
      await progress.goto(`chrome-extension://${first.extensionId}/library.html`);
      await progress.getByRole("button", { name: "Settings" }).click();
      await expect(
        progress.getByText("Publishing this Vault to the candidate server…"),
      ).toBeVisible();
      await progress.screenshot({
        path: testInfo.outputPath("server-switch-publish-desktop.png"),
      });
      await progress.setViewportSize({ width: 420, height: 800 });
      await progress.screenshot({
        path: testInfo.outputPath("server-switch-publish-narrow.png"),
      });
      await progress.close();
      await faultControl(firstLibrary, "release");
      await expect(candidate).toBeHidden({ timeout: 120_000 });
      await expect(
        firstLibrary.getByRole("heading", { name: "First Journey Archive" }),
      ).toBeVisible();
      await expect(firstLibrary.getByText("1 capture", { exact: false }).first()).toBeVisible();
      const state = await appRequest<{
        account: {
          accountState: string;
          configuration: { serverOrigin?: string };
          vaultSyncState: string;
        };
        serverSwitch?: unknown;
      }>(firstLibrary, { type: "GetState" });
      expect(state).toMatchObject({
        account: {
          accountState: "Authenticated",
          configuration: { serverOrigin: "http://127.0.0.1:3301" },
        },
      });
      expect(state.serverSwitch).toBeUndefined();
      expect(
        (
          await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(firstLibrary, {
            type: "GetState",
          })
        ).remoteOnlyArtifactCount,
      ).toBe(reliefEstimate.candidateArtifacts);
      const promotedStorage = await artifactStorageSnapshot(firstLibrary, vaultId);
      expect(promotedStorage.remoteOnlyArtifactIds).toEqual(remoteSource.remoteOnlyArtifactIds);
      for (const artifactObjectId of promotedStorage.remoteOnlyArtifactIds)
        expect(promotedStorage.filenames).not.toContain(`${artifactObjectId}.artifact`);
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ account: { vaultSyncState: string } }>(firstLibrary, {
                type: "GetState",
              })
            ).account.vaultSyncState,
          { timeout: 120_000 },
        )
        .toBe("UpToDate");
      await firstLibrary.getByRole("button", { name: "Settings" }).click();
      await firstLibrary.screenshot({
        path: testInfo.outputPath("journey-server-changed.png"),
      });
      await firstLibrary.keyboard.press("Escape");
      const groups = await appRequest<
        readonly {
          readonly captures: readonly { readonly bundleId: string }[];
        }[]
      >(firstLibrary, { type: "ListLibrary", expectedVaultId: vaultId });
      const bundleId = groups.flatMap((group) => group.captures).at(0)?.bundleId;
      if (bundleId === undefined) throw new Error("The switched Capture is unavailable.");
      await firstLibrary.goto(
        `chrome-extension://${first.extensionId}/library.html?bundleId=${bundleId}`,
      );
      await expect(firstLibrary.getByRole("img", { name: /Full-page screenshot/u })).toBeVisible({
        timeout: 120_000,
      });
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(firstLibrary, {
                type: "GetState",
              })
            ).remoteOnlyArtifactCount,
        )
        .toBe(reliefEstimate.candidateArtifacts - 1);
      const primary = firstLibrary.locator(".artifact-row").filter({
        has: firstLibrary.locator("strong", { hasText: /^MHTML$/u }),
      });
      expect(
        (await downloadBytes(firstLibrary, primary.getByRole("button", { name: "Download" })))
          .byteLength,
      ).toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(firstLibrary, {
                type: "GetState",
              })
            ).remoteOnlyArtifactCount,
        )
        .toBe(0);
    });
  } finally {
    await second?.context.close();
    await first.context.close();
  }
});

test("fast-forwards a candidate server from an exact recovered predecessor", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "candidate-behind");
  try {
    const base = await activeGeneration(setup.page);
    await vacuumDeleted(setup.page, setup.client.vaultId);
    const successor = await activeGeneration(setup.page);
    expect(successor.generationNumber).toBe(base.generationNumber + 1);
    await interruptServerSwitchAt(
      setup.client,
      testInfo,
      setup.page,
      setup.client.vaultId,
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
      "server-switch:after-remote-activation",
      "server-switch-fast-forward-candidate",
    );
    expect(await activeGeneration(setup.page)).toEqual(successor);
  } finally {
    await setup.client.context.close();
  }
});

test("fast-forwards a stale local Replica from a candidate successor", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "candidate-ahead");
  let stale: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    stale = await loginSynchronizedClient(
      testInfo,
      "candidate-ahead-stale",
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
    );
    const stalePage = await stale.context.newPage();
    await stalePage.goto(`chrome-extension://${stale.extensionId}/library.html`);
    const base = await activeGeneration(stalePage);
    const reliefEstimate = await appRequest<{
      readonly candidateArtifacts: number;
      readonly candidateBytes: number;
    }>(stalePage, {
      type: "GetStorageReliefEstimate",
      expectedVaultId: stale.vaultId,
    });
    expect(reliefEstimate.candidateArtifacts).toBeGreaterThanOrEqual(2);
    stalePage.once("dialog", (dialog) => void dialog.accept());
    await stalePage.getByRole("button", { name: "Reduce device storage" }).click();
    await expect
      .poll(
        async () =>
          (
            await appRequest<{
              readonly latestStorageReliefJob?: { readonly state: string };
            }>(stalePage, { type: "GetState" })
          ).latestStorageReliefJob?.state,
        { timeout: 120_000 },
      )
      .toBe("Succeeded");
    const remoteOnlyBefore = await artifactStorageSnapshot(stalePage, stale.vaultId);
    expect(remoteOnlyBefore.remoteOnlyArtifactIds).toHaveLength(reliefEstimate.candidateArtifacts);
    for (const artifactObjectId of remoteOnlyBefore.remoteOnlyArtifactIds)
      expect(remoteOnlyBefore.filenames).not.toContain(`${artifactObjectId}.artifact`);
    await vacuumDeleted(setup.page, setup.client.vaultId);
    const successor = await activeGeneration(setup.page);
    expect(successor.generationNumber).toBe(base.generationNumber + 1);
    await interruptServerSwitchAt(
      stale,
      testInfo,
      stalePage,
      stale.vaultId,
      "http://127.0.0.1:3301",
      setup.candidateEmail,
      setup.password,
      "server-switch:before-local-activation",
      "server-switch-fast-forward-local",
    );
    expect(await activeGeneration(stalePage)).toEqual(successor);
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(stalePage, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(0);
    const localAfter = await artifactStorageSnapshot(stalePage, stale.vaultId);
    expect(localAfter.remoteOnlyArtifactIds).toEqual([]);
    const authoritativeArtifactIds = await stalePage.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open("awsm-vault");
        request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const transaction = database.transaction("objects", "readonly");
      const values = await new Promise<readonly { objectId?: string; objectType?: string }[]>(
        (resolveValues, reject) => {
          const request = transaction.objectStore("objects").getAll();
          request.addEventListener(
            "success",
            () =>
              resolveValues(
                request.result as readonly {
                  objectId?: string;
                  objectType?: string;
                }[],
              ),
            { once: true },
          );
          request.addEventListener("error", () => reject(request.error), {
            once: true,
          });
        },
      );
      database.close();
      return values
        .filter(
          (value): value is { objectId: string; objectType: "Artifact" } =>
            value.objectType === "Artifact" && typeof value.objectId === "string",
        )
        .map((value) => value.objectId)
        .toSorted();
    });
    expect(authoritativeArtifactIds.length).toBeGreaterThan(0);
    for (const artifactObjectId of authoritativeArtifactIds)
      expect(localAfter.filenames).toContain(`${artifactObjectId}.artifact`);
  } finally {
    await stale?.context.close();
    await setup.client.context.close();
  }
});

test("unions independent append-only Events in the same Generation", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "union");
  let source: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  let freshCandidate: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    const candidateFailures: string[] = [];
    setup.client.context.on("response", (response) => {
      if (response.status() >= 400 && response.url().startsWith("http://127.0.0.1:3301/"))
        candidateFailures.push(
          `${String(response.status())} ${response.request().method()} ${response.url()}`,
        );
    });
    source = await loginSynchronizedClient(
      testInfo,
      "union-source-branch",
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
    );
    const sourcePage = await source.context.newPage();
    await sourcePage.goto(`chrome-extension://${source.extensionId}/library.html`);
    const candidateFixture = await setup.client.context.newPage();
    await candidateFixture.goto("http://127.0.0.1:4174/fixture");
    await candidateFixture.evaluate(() => {
      document.title = "Candidate-only capture";
      document.body.dataset.branch = "candidate";
    });
    await archiveFixture(setup.client, candidateFixture, 3);
    try {
      await extractNewestCapture(setup.page, setup.client.vaultId);
    } catch (error) {
      const diagnostic = await faultControl(setup.page, "status");
      throw new Error(
        `Candidate Collection synchronization failed (${candidateFailures.join(", ") || "no failed response observed"}; ${JSON.stringify(diagnostic.lastFailure)})`,
        { cause: error },
      );
    }
    await waitForSynchronizedState(setup.page, "http://127.0.0.1:3301");
    const sourceFixture = await source.context.newPage();
    await sourceFixture.goto("http://127.0.0.1:4174/fixture");
    await sourceFixture.evaluate(() => {
      document.title = "Source-only capture";
      document.body.dataset.branch = "source";
    });
    await archiveFixture(source, sourceFixture, 3);
    try {
      await extractNewestCapture(sourcePage, source.vaultId);
    } catch (error) {
      const diagnostic = await faultControl(sourcePage, "status");
      throw new Error(
        `Source Collection synchronization failed (${JSON.stringify(diagnostic.lastFailure)})`,
        { cause: error },
      );
    }
    await waitForSynchronizedState(sourcePage, "http://127.0.0.1:3300");
    await switchWithApplyingCapture(
      source,
      testInfo,
      sourcePage,
      source.vaultId,
      "http://127.0.0.1:3301",
      setup.candidateEmail,
      setup.password,
      "server-switch-union",
    );
    const groups = await appRequest<
      readonly {
        readonly collectionId: string;
        readonly captures: readonly unknown[];
      }[]
    >(sourcePage, {
      type: "ListLibrary",
      expectedVaultId: source.vaultId,
    });
    expect(groups.reduce((total, group) => total + group.captures.length, 0)).toBe(4);
    expect(new Set(groups.map((group) => group.collectionId)).size).toBe(4);
    freshCandidate = await loginSynchronizedClient(
      testInfo,
      "union-fresh-candidate",
      "http://127.0.0.1:3301",
      setup.candidateEmail,
      setup.password,
    );
    const freshPage = await freshCandidate.context.newPage();
    await freshPage.goto(`chrome-extension://${freshCandidate.extensionId}/library.html`);
    const freshGroups = await appRequest<
      readonly {
        readonly collectionId: string;
        readonly captures: readonly unknown[];
      }[]
    >(freshPage, {
      type: "ListLibrary",
      expectedVaultId: freshCandidate.vaultId,
    });
    expect(freshGroups.reduce((total, group) => total + group.captures.length, 0)).toBe(4);
    expect(new Set(freshGroups.map((group) => group.collectionId)).size).toBe(4);
  } finally {
    await freshCandidate?.context.close();
    await source?.context.close();
    await setup.client.context.close();
  }
});

test("reports sibling successor Generations as a conflict without changing servers", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "sibling-conflict");
  let sibling: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    sibling = await loginSynchronizedClient(
      testInfo,
      "sibling-conflict-second",
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
    );
    const siblingPage = await sibling.context.newPage();
    await siblingPage.goto(`chrome-extension://${sibling.extensionId}/library.html`);
    await vacuumDeleted(setup.page, setup.client.vaultId);
    await vacuumDeleted(siblingPage, sibling.vaultId);
    const localSuccessor = await activeGeneration(setup.page);
    const remoteSuccessor = await activeGeneration(siblingPage);
    expect(remoteSuccessor.generationId).not.toBe(localSuccessor.generationId);
    await appRequest(setup.page, {
      type: "BeginServerSwitch",
      candidateOrigin: "http://127.0.0.1:3300",
      expectedVaultId: setup.client.vaultId,
    });
    const state = await appRequest<{
      account: { configuration: { serverOrigin?: string } };
      serverSwitch?: { state: string; reason?: string };
    }>(setup.page, {
      type: "LoginServerSwitchCandidate",
      email: setup.sourceEmail,
      password: setup.password,
    });
    expect(state).toMatchObject({
      account: { configuration: { serverOrigin: "http://127.0.0.1:3301" } },
      serverSwitch: { state: "Conflict", reason: "DivergedGeneration" },
    });
    expect(await activeGeneration(setup.page)).toEqual(localSuccessor);
    await setup.page.getByRole("button", { name: "Settings" }).click();
    await expect(setup.page.getByRole("heading", { name: "Server switch conflict" })).toBeVisible();
    const dialogText = await setup.page.getByRole("dialog", { name: "Settings" }).innerText();
    expect(dialogText).not.toMatch(/(?:Generation|Object|Event|Account|key) ID|ciphertext/iu);
    await setup.page.screenshot({
      path: testInfo.outputPath("server-switch-conflict-desktop.png"),
    });
    await setup.page.setViewportSize({ width: 420, height: 800 });
    await setup.page.screenshot({
      path: testInfo.outputPath("server-switch-conflict-narrow.png"),
    });
  } finally {
    await sibling?.context.close();
    await setup.client.context.close();
  }
});

test("preserves the source context across candidate authentication and Vault failures", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const password = "correct horse archive battery";
  const sourceEmail = `failure-source-${crypto.randomUUID()}@example.test`;
  const candidateEmail = `failure-candidate-${crypto.randomUUID()}@example.test`;
  const source = await createSynchronizedClient(
    testInfo,
    "failure-source",
    "http://127.0.0.1:3300",
    sourceEmail,
    password,
  );
  const candidate = await createSynchronizedClient(
    testInfo,
    "failure-candidate",
    "http://127.0.0.1:3301",
    candidateEmail,
    password,
  );
  try {
    const library = await source.context.newPage();
    await library.goto(`chrome-extension://${source.extensionId}/library.html`);
    await appRequest(library, {
      type: "BeginServerSwitch",
      candidateOrigin: "http://127.0.0.1:3301",
      expectedVaultId: source.vaultId,
    });
    await expect(
      appRequest(library, {
        type: "LoginServerSwitchCandidate",
        email: candidateEmail,
        password: "definitely incorrect password",
      }),
    ).rejects.toThrow("AUTHENTICATION_FAILED");
    await expect(
      appRequest(library, {
        type: "LoginServerSwitchCandidate",
        email: `unknown-${crypto.randomUUID()}@example.test`,
        password,
      }),
    ).rejects.toThrow("AUTHENTICATION_FAILED");
    const fixture = await source.context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    await archiveFixture(source, fixture, 1);
    await waitForSynchronizedState(library, "http://127.0.0.1:3300");
    await expect(
      appRequest(library, {
        type: "LoginServerSwitchCandidate",
        email: candidateEmail,
        password,
      }),
    ).rejects.toThrow("SERVER_SWITCH_VAULT_MISMATCH");
    const failed = await appRequest<{
      account: {
        accountState: string;
        configuration: { serverOrigin?: string };
      };
      serverSwitch?: { state: string; errorId?: string };
    }>(library, { type: "GetState" });
    expect(failed).toMatchObject({
      account: {
        accountState: "Authenticated",
        configuration: { serverOrigin: "http://127.0.0.1:3300" },
      },
      serverSwitch: {
        state: "Failed",
        errorId: "SERVER_SWITCH_VAULT_MISMATCH",
      },
    });
    await library.getByRole("button", { name: "Settings" }).click();
    await expect(
      library.getByText("This Account already contains a different Vault"),
    ).toBeVisible();
    await library.screenshot({
      path: testInfo.outputPath("server-switch-vault-mismatch.png"),
    });
    await waitForSynchronizedState(library, "http://127.0.0.1:3300");
  } finally {
    await candidate.context.close();
    await source.context.close();
  }
});

test("reauthenticates a candidate switch before and after remote application", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(900_000);
  expect(browserName).toBe("chromium");
  const password = "correct horse archive battery";
  const beforeSourceEmail = `reauth-before-source-${crypto.randomUUID()}@example.test`;
  const beforeCandidateEmail = `reauth-before-candidate-${crypto.randomUUID()}@example.test`;
  const before = await createSynchronizedClient(
    testInfo,
    "reauth-before",
    "http://127.0.0.1:3300",
    beforeSourceEmail,
    password,
  );
  let after: Awaited<ReturnType<typeof sharedDeletedBase>> | undefined;
  try {
    const beforePage = await before.context.newPage();
    await beforePage.goto(`chrome-extension://${before.extensionId}/library.html`);
    await appRequest(beforePage, {
      type: "BeginServerSwitch",
      candidateOrigin: "http://127.0.0.1:3301",
      expectedVaultId: before.vaultId,
    });
    await faultControl(
      beforePage,
      "arm-authentication-expiry",
      "server-switch:after-candidate-authentication",
    );
    const expiredBefore = await appRequest<{
      account: { configuration: { serverOrigin?: string } };
      serverSwitch?: { jobId: string; state: string };
    }>(beforePage, {
      type: "SignupServerSwitchCandidate",
      email: beforeCandidateEmail,
      password,
    });
    expect(expiredBefore).toMatchObject({
      account: { configuration: { serverOrigin: "http://127.0.0.1:3300" } },
      serverSwitch: { state: "AuthenticationRequired" },
    });
    const beforeJobId = expiredBefore.serverSwitch?.jobId;
    await faultControl(beforePage, "release");
    await appRequest(beforePage, {
      type: "LoginServerSwitchCandidate",
      email: beforeCandidateEmail,
      password,
    });
    await waitForSynchronizedState(beforePage, "http://127.0.0.1:3301");
    expect(
      (
        await appRequest<{ serverSwitch?: { jobId: string } }>(beforePage, {
          type: "GetState",
        })
      ).serverSwitch,
    ).toBeUndefined();
    expect(beforeJobId).toBeDefined();

    after = await sharedDeletedBase(testInfo, "reauth-after");
    await vacuumDeleted(after.page, after.client.vaultId);
    await appRequest(after.page, {
      type: "BeginServerSwitch",
      candidateOrigin: "http://127.0.0.1:3300",
      expectedVaultId: after.client.vaultId,
    });
    await faultControl(
      after.page,
      "arm-authentication-expiry",
      "server-switch:after-remote-activation",
    );
    const expiredAfter = await appRequest<{
      account: { configuration: { serverOrigin?: string } };
      serverSwitch?: { jobId: string; state: string };
    }>(after.page, {
      type: "LoginServerSwitchCandidate",
      email: after.sourceEmail,
      password: after.password,
    });
    expect(expiredAfter).toMatchObject({
      account: { configuration: { serverOrigin: "http://127.0.0.1:3301" } },
      serverSwitch: { state: "AuthenticationRequired" },
    });
    const afterJobId = expiredAfter.serverSwitch?.jobId;
    await faultControl(after.page, "release");
    await appRequest(after.page, {
      type: "LoginServerSwitchCandidate",
      email: after.sourceEmail,
      password: after.password,
    });
    await waitForSynchronizedState(after.page, "http://127.0.0.1:3300");
    expect(afterJobId).toBeDefined();
  } finally {
    await after?.client.context.close();
    await before.context.close();
  }
});

test("renders Account onboarding, signup, progress, success, and settings states", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(240_000);
  expect(browserName).toBe("chromium");
  const client = await packagedAccountContext(testInfo, "account-visual");
  try {
    await client.popup.setViewportSize({ width: 420, height: 760 });
    await expect(
      client.popup.getByRole("heading", { name: "Choose how AWSM starts" }),
    ).toBeVisible();
    const localOnly = client.popup.getByRole("button", {
      name: "Continue without sync",
    });
    const synchronization = client.popup.getByRole("link", {
      name: "Set up synchronization",
    });
    await expect(localOnly).toHaveClass(/\bprimary\b/u);
    await expect(synchronization).not.toHaveClass(/\bprimary\b/u);
    expect(
      await localOnly.evaluate(
        (primary, secondary) =>
          Boolean(
            primary.compareDocumentPosition(secondary as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        await synchronization.elementHandle(),
      ),
    ).toBe(true);
    await client.popup.screenshot({
      path: testInfo.outputPath("account-server-choice-desktop.png"),
    });
    await client.popup.setViewportSize({ width: 340, height: 700 });
    const [localOnlyBox, synchronizationBox] = await Promise.all([
      localOnly.boundingBox(),
      synchronization.boundingBox(),
    ]);
    expect(localOnlyBox?.width).toBe(synchronizationBox?.width);
    await client.popup.screenshot({
      path: testInfo.outputPath("account-server-choice-narrow.png"),
    });
    await client.popup.setViewportSize({ width: 420, height: 760 });
    const signupOpened = client.context.waitForEvent("page");
    await client.popup.getByRole("link", { name: "Set up synchronization" }).click();
    const signup = await signupOpened;
    await signup.waitForLoadState("domcontentloaded");
    await signup.getByText("Use a self-hosted server", { exact: true }).click();
    await signup
      .getByRole("textbox", { name: "Self-hosted server origin" })
      .fill("http://127.0.0.1:3300");
    await signup.getByRole("button", { name: "Use self-hosted server" }).click();
    await expect(client.popup.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await client.popup.getByRole("textbox", { name: "Email" }).focus();
    await client.popup.screenshot({
      path: testInfo.outputPath("account-login-focus.png"),
    });

    await signup.setViewportSize({ width: 720, height: 900 });
    await expect(signup.getByRole("heading", { name: "Create your Account" })).toBeVisible();
    await signup.getByRole("textbox", { name: "Email" }).focus();
    await signup.screenshot({
      path: testInfo.outputPath("account-signup-focus.png"),
    });
    await signup.setViewportSize({ width: 360, height: 760 });
    await signup.screenshot({
      path: testInfo.outputPath("account-signup-narrow.png"),
    });
    await signup.setViewportSize({ width: 720, height: 900 });
    await signup
      .getByRole("textbox", { name: "Email" })
      .fill(`visual-${crypto.randomUUID()}@example.test`);
    await signup.getByLabel("Password", { exact: true }).fill("correct horse archive battery");
    await signup.getByLabel("Confirm password").fill("incorrect horse archive battery");
    await signup.getByLabel(/no password recovery/u).check();
    await signup.getByRole("button", { name: "Create Account" }).click();
    await expect(signup.getByRole("alert")).toHaveText("Passwords do not match.");
    await signup.screenshot({
      path: testInfo.outputPath("account-signup-validation.png"),
    });
    await signup.getByLabel("Confirm password").fill("correct horse archive battery");
    await signup.getByRole("button", { name: "Create Account" }).click();
    await expect(signup.getByRole("status")).toContainText("Creating Account");
    await expect(signup.getByRole("button", { name: "Create Account" })).toBeDisabled();
    await signup.screenshot({
      path: testInfo.outputPath("account-signup-progress.png"),
    });
    await expect(signup.getByRole("status")).toHaveText(
      "Account created. Returning to your page…",
      {
        timeout: 90_000,
      },
    );
    await expect(signup.locator("#signup-form")).toBeHidden();
    await expect.poll(() => signup.evaluate(() => window.scrollY)).toBe(0);
    await signup.screenshot({
      path: testInfo.outputPath("account-signup-success.png"),
    });

    const library = await client.context.newPage();
    await library.goto(`chrome-extension://${client.extensionId}/library.html`);
    await expect(library.getByRole("button", { name: "Settings" })).toBeVisible();
    await library.getByRole("button", { name: "Settings" }).click();
    const settingsDialog = library.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();
    await expect(
      settingsDialog.getByRole("button", {
        name: "Close Settings",
        exact: true,
      }),
    ).toBeVisible();
    await expect(settingsDialog.getByText("Up to date", { exact: true })).toBeVisible();
    await library.screenshot({
      path: testInfo.outputPath("account-settings.png"),
    });
    await library.setViewportSize({ width: 360, height: 760 });
    expect(await settingsDialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
      true,
    );
    await library.screenshot({
      path: testInfo.outputPath("account-settings-narrow.png"),
    });
    await library
      .getByRole("textbox", { name: "Change synchronization server" })
      .fill("http://127.0.0.1:3300");
    await library.getByLabel(/verify and reconcile the candidate/u).check();
    await library.getByRole("button", { name: "Change server" }).click();
    await expect(
      library.getByText("Enter a different synchronization server. This server is already active."),
    ).toBeVisible();
    await library.getByRole("button", { name: "Reset this device" }).click();
    const resetDialog = library.getByRole("dialog", {
      name: "Reset this device?",
    });
    await expect(resetDialog).toBeVisible();
    await expect(
      resetDialog.getByRole("button", { name: "Close Reset this device?" }),
    ).toBeVisible();
    await library.screenshot({
      path: testInfo.outputPath("account-reset-narrow.png"),
    });
    await library.setViewportSize({ width: 900, height: 760 });
    await library.screenshot({
      path: testInfo.outputPath("account-reset-wide.png"),
    });
    const resetConfirmation = resetDialog.getByRole("textbox", {
      name: 'Type "RESET" to continue',
    });
    const resetButton = resetDialog.getByRole("button", {
      name: "Permanently reset this device",
    });
    await expect(resetButton).toBeDisabled();
    await resetConfirmation.fill("RESET");
    await expect(resetButton).toBeEnabled();
    await resetButton.click();
    await expect(resetDialog.getByRole("status")).toContainText("Local data deleted", {
      timeout: 60_000,
    });
    await expect
      .poll(() =>
        library.evaluate(async () => ({
          databases: (await indexedDB.databases()).map((database) => database.name),
          files: await (async () => {
            const names: string[] = [];
            for await (const [name] of (await navigator.storage.getDirectory()).entries())
              names.push(name);
            return names;
          })(),
        })),
      )
      .toEqual({ databases: [], files: [] });
  } finally {
    await client.context.close();
  }
});

test("offers in-tab sign in when signup cannot create the Account", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  const email = `existing-${crypto.randomUUID()}@example.test`;
  const password = "x";
  const first = await packagedAccountContext(testInfo, "existing-account-first");
  let second: Awaited<ReturnType<typeof packagedAccountContext>> | undefined;
  try {
    const firstOpened = first.context.waitForEvent("page");
    await first.popup.getByRole("link", { name: "Set up synchronization" }).click();
    const firstSignup = await firstOpened;
    await firstSignup.getByText("Use a self-hosted server", { exact: true }).click();
    await firstSignup
      .getByRole("textbox", { name: "Self-hosted server origin" })
      .fill("http://127.0.0.1:3300");
    await firstSignup.getByRole("button", { name: "Use self-hosted server" }).click();
    await firstSignup.getByRole("textbox", { name: "Email" }).fill(email);
    await firstSignup.getByLabel("Password", { exact: true }).fill(password);
    await firstSignup.getByLabel("Confirm password").fill(password);
    await firstSignup.getByLabel(/no password recovery/u).check();
    await firstSignup.getByLabel("Vault name").fill("Existing Account Archive");
    await firstSignup.getByRole("button", { name: "Create Account" }).click();
    await expect.poll(() => firstSignup.isClosed()).toBe(true);

    second = await packagedAccountContext(testInfo, "existing-account-second");
    const secondOpened = second.context.waitForEvent("page");
    await second.popup.getByRole("link", { name: "Set up synchronization" }).click();
    const signup = await secondOpened;
    await signup.getByText("Use a self-hosted server", { exact: true }).click();
    await signup
      .getByRole("textbox", { name: "Self-hosted server origin" })
      .fill("http://127.0.0.1:3300");
    await signup.getByRole("button", { name: "Use self-hosted server" }).click();
    await signup.getByRole("textbox", { name: "Email" }).fill(email);
    await signup.getByLabel("Password", { exact: true }).fill(password);
    await signup.getByLabel("Confirm password").fill(password);
    await signup.getByLabel(/no password recovery/u).check();
    await signup.getByRole("button", { name: "Create Account" }).click();
    await expect(signup.getByRole("alert")).toContainText("may already exist");
    await expect(signup.getByRole("button", { name: "Create Account" })).toBeHidden();
    await expect(signup.getByRole("button", { name: "Sign in instead" })).toBeVisible();
    await signup.setViewportSize({ width: 720, height: 900 });
    await signup.screenshot({
      path: testInfo.outputPath("existing-account-wide.png"),
    });
    await signup.setViewportSize({ width: 360, height: 760 });
    await signup.screenshot({
      path: testInfo.outputPath("existing-account-narrow.png"),
    });

    await signup.getByRole("button", { name: "Sign in instead" }).click();
    await expect(signup.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(signup.getByRole("textbox", { name: "Email" })).toHaveValue(email);
    await expect(signup.getByLabel("Confirm password")).toBeHidden();
    await signup.setViewportSize({ width: 720, height: 900 });
    await signup.screenshot({
      path: testInfo.outputPath("existing-account-signin-wide.png"),
    });
    await signup.setViewportSize({ width: 360, height: 760 });
    await signup.screenshot({
      path: testInfo.outputPath("existing-account-signin-narrow.png"),
    });
    await signup.getByLabel("Password", { exact: true }).fill(password);
    await signup.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => signup.isClosed()).toBe(true);
    await expect(second.popup.getByRole("button", { name: "Archive this page" })).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await second?.context.close();
    await first.context.close();
  }
});

async function chooseLocalOnlyOnFirstLaunch(popup: Page): Promise<void> {
  const decision = popup.getByRole("button", { name: "Continue without sync" });
  const vaultName = popup.getByRole("textbox", { name: "Vault name" });
  await expect(decision.or(vaultName)).toBeVisible();
  if (await decision.isVisible()) await decision.click();
  await expect(vaultName).toBeVisible();
}

async function setLatestImportJobForVisual(
  page: Page,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(async (next) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    const transaction = database.transaction("import_jobs", "readwrite");
    const store = transaction.objectStore("import_jobs");
    const jobs = await new Promise<Record<string, unknown>[]>((resolveJobs, reject) => {
      const request = store.getAll();
      request.addEventListener("success", () => resolveJobs(request.result), {
        once: true,
      });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    const current = jobs[0];
    if (current === undefined || typeof current.jobId !== "string") {
      throw new Error("Import Job is unavailable for rendered-state inspection.");
    }
    const updated: Record<string, unknown> = {
      ...current,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    if (next.errorId === null) delete updated.errorId;
    store.put(updated, current.jobId);
    await new Promise<void>((resolveTransaction, reject) => {
      transaction.addEventListener("complete", () => resolveTransaction(), {
        once: true,
      });
      transaction.addEventListener("error", () => reject(transaction.error), {
        once: true,
      });
      transaction.addEventListener("abort", () => reject(transaction.error), {
        once: true,
      });
    });
    database.close();
  }, patch);
}

async function seedStaleAccountVisual(page: Page, vaultId: string): Promise<void> {
  await page.evaluate(async (activeVaultId) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    const stores = [
      "account_configuration",
      "account_metadata",
      "account_keys",
      "account_secrets",
      "account_vault",
      "synchronization_jobs",
    ];
    const transaction = database.transaction(stores, "readwrite");
    const accountId = "01900000-0000-7000-8000-000000000801";
    const sessionId = "01900000-0000-7000-8000-000000000802";
    const accountKeyId = "01900000-0000-7000-8000-000000000803";
    const remoteGenerationId = "01900000-0000-7000-8000-000000000804";
    transaction.objectStore("account_configuration").put(
      {
        version: 1,
        mode: "Configured",
        serverOrigin: "https://awsm.invalid",
      },
      "active",
    );
    transaction.objectStore("account_metadata").put(
      {
        version: 1,
        accountId,
        sessionId,
        email: "archive@example.test",
        accountKeyId,
        accountKeyEnvelope: {},
      },
      "active",
    );
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    transaction.objectStore("account_keys").put(wrappingKey, "account-wrapping");
    transaction.objectStore("account_keys").put(sessionKey, "session-storage");
    transaction.objectStore("account_secrets").put(
      {
        version: 1,
        accountId,
        sessionId,
        wrappedAccountEncryptionKey: new Uint8Array(40),
        refreshNonce: new Uint8Array(12),
        refreshCiphertext: new Uint8Array(16),
      },
      "active",
    );
    transaction.objectStore("account_vault").put(
      {
        version: 1,
        accountId,
        vaultId: activeVaultId,
        accountKeyId,
        accountSlot: {},
        remoteGenerationId,
        remoteGenerationNumber: 2,
        deliveryCursor: 8,
      },
      "active",
    );
    transaction.objectStore("synchronization_jobs").put(
      {
        version: 1,
        jobId: "01900000-0000-7000-8000-000000000805",
        accountId,
        vaultId: activeVaultId,
        generationId: remoteGenerationId,
        generationNumber: 2,
        state: "Conflict",
        stage: "Checkpoint",
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z",
        snapshotCursor: 8,
        completedItems: 0,
        totalItems: 0,
        processedBytes: 0,
        totalBytes: 0,
        retryCount: 0,
        errorId: "SYNCHRONIZATION_CONFLICT",
        attachIdempotencyKey: "01900000-0000-7000-8000-000000000806",
      },
      "active",
    );
    await new Promise<void>((resolveTransaction, reject) => {
      transaction.addEventListener("complete", () => resolveTransaction(), {
        once: true,
      });
      transaction.addEventListener("error", () => reject(transaction.error), {
        once: true,
      });
      transaction.addEventListener("abort", () => reject(transaction.error), {
        once: true,
      });
    });
    database.close();
  }, vaultId);
}

test("captures a page snapshot and full-page screenshot, then derives MHTML offline", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(browserName).toBe("chromium");
  const extensionPath = testInfo.outputPath("extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  // Headless Chrome cannot issue the toolbar user gesture that grants activeTab.
  // This permission exists only in the disposable E2E copy, never in the shipping manifest.
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(testInfo.outputPath("chrome-profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const consoleErrors: string[] = [];
  const watchPage = (page: Page): void => {
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
  };
  context.on("page", watchPage);
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const extensionId = new URL(worker.url()).host;
    await Promise.all(context.pages().map((page) => page.close()));
    const fixturePage = await context.newPage();
    await fixturePage.goto("http://127.0.0.1:4174/fixture");
    await expect(fixturePage.locator("body")).toHaveAttribute(
      "data-live-fixture",
      "executed-only-on-live-page",
    );
    await worker.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: { action: { openPopup(): Promise<void> } };
        }
      ).chrome;
      await extensionApi.action.openPopup();
    });
    const popup = await extensionPopup(context, extensionId);
    await popup.setViewportSize({ width: 360, height: 600 });
    await chooseLocalOnlyOnFirstLaunch(popup);
    await popup.screenshot({
      path: testInfo.outputPath("popup-onboarding.png"),
    });
    await popup.locator("body").press("Tab");
    await expect(popup.getByRole("textbox", { name: "Vault name" })).toBeFocused();
    await popup.keyboard.press("Tab");
    await expect(popup.getByRole("button", { name: "Generate another name" })).toBeFocused();
    await popup.keyboard.press("Tab");
    await expect(popup.getByRole("button", { name: "Create Vault" })).toBeFocused();
    await expect(popup.getByRole("link", { name: "Import existing Vault" })).toBeVisible();
    await popup.keyboard.press("Enter");
    await expect(popup.getByRole("button", { name: "Archive this page" })).toBeVisible();
    await popup.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query(value: unknown): Promise<readonly { id?: number; url?: string }[]>;
              update(id: number, value: unknown): Promise<unknown>;
            };
            runtime: {
              sendMessage(value: unknown, callback: (response: unknown) => void): void;
            };
          };
        }
      ).chrome;
      const tabs = await extensionApi.tabs.query({ currentWindow: true });
      const fixtureTab = tabs.find(
        (tab) => tab.id !== undefined && tab.url === "http://127.0.0.1:4174/fixture",
      );
      if (fixtureTab?.id === undefined) throw new Error("The fixture tab is unavailable.");
      await extensionApi.tabs.update(fixtureTab.id, { active: true });
      const state = await new Promise<{
        workspace: { activeVaultId?: string };
      }>((resolve) =>
        extensionApi.runtime.sendMessage({ type: "GetState" }, (response) => {
          const result = response as {
            value: { workspace: { activeVaultId?: string } };
          };
          resolve(result.value);
        }),
      );
      if (state.workspace.activeVaultId === undefined) throw new Error("No active Vault.");
      extensionApi.runtime.sendMessage(
        {
          type: "CaptureActivePage",
          expectedVaultId: state.workspace.activeVaultId,
          tabId: fixtureTab.id,
        },
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const completedPopup = popup;
    const recoverableCaptureFailure = completedPopup.getByText(
      /Capture failed \(PAGE_SNAPSHOT_FAILED\)/u,
    );
    await expect
      .poll(
        async () =>
          (await completedPopup.getByText("Archived: AWSM tall fixture").isVisible()) ||
          (await recoverableCaptureFailure.isVisible()),
        { timeout: 60_000 },
      )
      .toBe(true);
    if (await recoverableCaptureFailure.isVisible()) {
      await completedPopup.getByRole("button", { name: "Archive this page" }).click();
    }
    await expect(completedPopup.getByText("Archived: AWSM tall fixture")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      completedPopup.getByRole("img", {
        name: "Screenshot thumbnail for AWSM tall fixture",
      }),
    ).toBeVisible();
    const capturePreview = completedPopup.getByRole("link", {
      name: "Open archived capture: AWSM tall fixture",
    });
    await expect(capturePreview).toHaveAttribute("href", /library\.html\?vaultId=[^&]+&bundleId=/u);
    const captureHref = await capturePreview.getAttribute("href");
    if (captureHref === null) throw new Error("The recent Capture link is unavailable.");
    const previewTimer = completedPopup.getByRole("progressbar", {
      name: "Time until recent capture preview closes",
    });
    await expect(previewTimer).toBeVisible();
    await expect(previewTimer).toHaveAttribute("aria-valuemax", "8000");
    await completedPopup.screenshot({
      path: testInfo.outputPath("popup-recent-capture.png"),
    });
    const capturePageOpened = context.waitForEvent("page", {
      predicate: (page) => page.url().startsWith(captureHref),
    });
    await capturePreview.click();
    const directCapturePage = await capturePageOpened;
    await expect(
      directCapturePage.getByRole("heading", { name: "AWSM tall fixture" }),
    ).toBeVisible();
    await expect(
      directCapturePage.getByRole("img", { name: /Full-page screenshot/u }),
    ).toBeVisible();
    await expect(
      directCapturePage.getByRole("link", {
        name: "Visit original site for AWSM tall fixture",
      }),
    ).toHaveAttribute("href", "http://127.0.0.1:4174/fixture");
    await directCapturePage.close();
    const reopenedPopup = await extensionPopup(context, extensionId);
    await expect(reopenedPopup.getByText("Archived: AWSM tall fixture")).toHaveCount(0);
    await expect(reopenedPopup.getByRole("button", { name: "Archive this page" })).toBeVisible();
    const libraryPageOpened = context.waitForEvent("page", {
      predicate: (page) => page.url() === `chrome-extension://${extensionId}/library.html`,
    });
    await reopenedPopup.getByRole("link", { name: "Open library" }).click();
    const openedLibrary = await libraryPageOpened;
    await expect(openedLibrary.locator("header h1")).toBeVisible();
    await openedLibrary.close();
    const capturePopup = await extensionPopup(context, extensionId);
    await fixturePage.evaluate(() => {
      const redBand = document.querySelector<HTMLElement>(".red");
      if (redBand === null) throw new Error("The evolving fixture band is unavailable.");
      redBand.style.background = "#7b4fc4";
      redBand.textContent = "purple evolution landmark";
    });
    await capturePopup.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query(value: unknown): Promise<readonly { id?: number; url?: string }[]>;
              update(id: number, value: unknown): Promise<unknown>;
            };
            runtime: {
              sendMessage(value: unknown, callback: (response: unknown) => void): void;
            };
          };
        }
      ).chrome;
      const tabs = await extensionApi.tabs.query({ currentWindow: true });
      const fixtureTab = tabs.find(
        (tab) => tab.id !== undefined && tab.url === "http://127.0.0.1:4174/fixture",
      );
      if (fixtureTab?.id === undefined) throw new Error("The fixture tab is unavailable.");
      await extensionApi.tabs.update(fixtureTab.id, { active: true });
      const state = await new Promise<{
        workspace: { activeVaultId?: string };
      }>((resolve) =>
        extensionApi.runtime.sendMessage({ type: "GetState" }, (response) => {
          const result = response as {
            value: { workspace: { activeVaultId?: string } };
          };
          resolve(result.value);
        }),
      );
      if (state.workspace.activeVaultId === undefined) throw new Error("No active Vault.");
      extensionApi.runtime.sendMessage(
        {
          type: "CaptureActivePage",
          expectedVaultId: state.workspace.activeVaultId,
          tabId: fixtureTab.id,
        },
        () => undefined,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    });
    await capturePopup.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
    await fixturePage.evaluate(() => history.pushState({}, "", "/fixture?different=1"));
    const popupAfterUrlChange = await extensionPopup(context, extensionId);
    await expect(popupAfterUrlChange.getByText("Archived: AWSM tall fixture")).toHaveCount(0);
    await popupAfterUrlChange.close();

    await context.setOffline(true);
    const library = await context.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Vault" }).click();
    await expect(
      library.getByRole("dialog", { name: "Settings" }).getByRole("button", {
        name: "Import Vault",
      }),
    ).toBeVisible();
    await library.getByRole("tab", { name: "Account & sync" }).click();
    await library
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Close Settings" })
      .click();
    await library.locator(".card").click();
    const firstSelection = library.getByRole("checkbox", { name: /Select capture from/u }).first();
    await firstSelection.check();
    await library.getByRole("button", { name: "Extract to new collection" }).click();
    await expect(library.locator(".library-card")).toHaveCount(2);
    await expect(library.getByRole("button", { name: "Undo" })).toBeVisible();
    await library.getByRole("button", { name: "Undo" }).click();
    await expect(library.locator(".library-card")).toHaveCount(1);
    await expect(library.getByText(/2 captures/u)).toBeVisible();

    await library.locator(".card").click();
    await library
      .getByRole("checkbox", { name: /Select capture from/u })
      .first()
      .check();
    await library.getByRole("button", { name: "Extract to new collection" }).click();
    await expect(library.locator(".library-card")).toHaveCount(2);
    const sourceCollection = library.locator(".library-card").first();
    const destinationCollection = library.locator(".library-card").nth(1);
    await library.evaluate(() => {
      const [source, destination] = document.querySelectorAll<HTMLElement>(".library-card");
      if (source === undefined || destination === undefined)
        throw new Error("Collection cards missing");
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
      destination.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }),
      );
    });
    await expect(destinationCollection).toHaveClass(/library-card--merge-target/u);
    await sourceCollection.dispatchEvent("dragend");
    await expect(destinationCollection).not.toHaveClass(/library-card--merge-target/u);
    await sourceCollection.dragTo(destinationCollection);
    await expect(library.locator(".library-card")).toHaveCount(1);
    await library.getByRole("button", { name: "Undo" }).click();
    await expect(library.locator(".library-card")).toHaveCount(2);

    await library.locator(".library-card .card").first().click();
    await library.getByRole("button", { name: "Move to collection…" }).click();
    const moveDialog = library.getByRole("dialog");
    await expect(moveDialog).toBeVisible();
    await moveDialog.getByRole("radio").check();
    await moveDialog.getByRole("button", { name: "Move to collection" }).click();
    await expect(library.locator(".library-card")).toHaveCount(1);
    await expect(library.getByText(/2 captures/u)).toBeVisible();
    const originalSite = library.getByRole("link", {
      name: "Visit original site for AWSM tall fixture",
    });
    await expect(originalSite).toHaveAttribute("href", "http://127.0.0.1:4174/fixture");
    await expect(originalSite).toHaveAttribute("target", "_blank");
    const latestThumbnail = library.getByRole("img", {
      name: "Latest screenshot thumbnail for AWSM tall fixture",
    });
    await expect(latestThumbnail).toBeVisible();
    const thumbnailDimensions = await latestThumbnail.evaluate((node) => {
      const image = node as HTMLImageElement;
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(thumbnailDimensions).toEqual({ width: 640, height: 360 });
    const collectionThumbnails = library.locator(".card__preview--stack .card__thumbnail");
    await expect(collectionThumbnails).toHaveCount(2);
    const collectionSources = await collectionThumbnails.evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src),
    );
    expect(new Set(collectionSources).size).toBe(2);
    await expect(library.locator(".card")).toBeVisible();
    await library.locator(".card").click();
    await expect(library.getByRole("heading", { name: "AWSM tall fixture" })).toBeVisible();
    await expect(library.getByText("2 captures", { exact: true })).toBeVisible();
    await expect(library.locator(".version__thumbnail")).toHaveCount(2);
    await library.locator(".version").first().click();
    await expect(library.getByRole("heading", { name: "AWSM tall fixture" })).toBeVisible();
    const image = library.getByRole("img", { name: /Full-page screenshot/u });
    await expect(image).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    const dimensions = await image.evaluate((node) => {
      const imageNode = node as HTMLImageElement;
      return { width: imageNode.naturalWidth, height: imageNode.naturalHeight };
    });
    expect(dimensions.height).toBeGreaterThan(1_800);
    expect(dimensions.width).toBeGreaterThan(500);
    const imageSourceBeforeSelection = await image.getAttribute("src");
    const selectedTitle = await library
      .getByRole("heading", { name: "AWSM tall fixture" })
      .evaluate((heading) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(heading);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString();
      });
    expect(selectedTitle).toBe("AWSM tall fixture");
    await worker.evaluate(async () => {
      await (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome.runtime.sendMessage({ type: "AppStateChanged" });
    });
    await library.waitForTimeout(1_000);
    await expect
      .poll(() => library.evaluate(() => window.getSelection()?.toString()))
      .toBe("AWSM tall fixture");
    await expect(image).toHaveAttribute("src", imageSourceBeforeSelection ?? "");
    await expect(library.getByText("Loading screenshot…", { exact: true })).toHaveCount(0);
    await library.evaluate(() => window.getSelection()?.removeAllRanges());
    await library.waitForTimeout(1_000);
    await expect(image).toBeVisible({ timeout: 60_000 });
    await expect(library.getByText("Loading screenshot…", { exact: true })).toHaveCount(0, {
      timeout: 60_000,
    });
    const colors = await image.evaluate(async (node) => {
      const imageNode = node as HTMLImageElement;
      const bitmap = await createImageBitmap(await (await fetch(imageNode.src)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas unavailable");
      context.drawImage(bitmap, 0, 0);
      const samples = [350, 1_050, 1_750].map((y) =>
        Array.from(context.getImageData(Math.floor(canvas.width / 4), y, 1, 1).data),
      );
      bitmap.close();
      return samples;
    });
    const [red, green, blue] = colors;
    if (
      (red?.[0] ?? 0) <= (red?.[1] ?? 0) + 40 ||
      (green?.[1] ?? 0) <= (green?.[0] ?? 0) + 40 ||
      (blue?.[2] ?? 0) <= (blue?.[0] ?? 0) + 40
    ) {
      throw new Error(`Unexpected screenshot landmarks: ${JSON.stringify({ colors, dimensions })}`);
    }
    expect(red?.[0]).toBeGreaterThan((red?.[1] ?? 0) + 40);
    expect(green?.[1]).toBeGreaterThan((green?.[0] ?? 0) + 40);
    expect(blue?.[2]).toBeGreaterThan((blue?.[0] ?? 0) + 40);

    const artifactPanel = library.getByRole("region", {
      name: "Capture Artifacts",
    });
    const [screenshotBox, artifactBox] = await Promise.all([
      image.boundingBox(),
      artifactPanel.boundingBox(),
    ]);
    if (screenshotBox === null || artifactBox === null)
      throw new Error("Capture detail geometry is unavailable.");
    expect(screenshotBox.y).toBeLessThan(artifactBox.y);
    await expect(artifactPanel.locator(".artifact-row")).toHaveCount(5);
    const structuredArtifact = artifactPanel.locator(".artifact-row").filter({
      has: library.locator("strong", { hasText: /^Structured content$/u }),
    });
    await expect(structuredArtifact.getByRole("button", { name: "Inspect" })).toBeVisible();
    await structuredArtifact.getByRole("button", { name: "Inspect" }).focus();
    await expect(structuredArtifact.getByRole("button", { name: "Inspect" })).toBeFocused();
    await structuredArtifact.getByRole("button", { name: "Inspect" }).click();
    const inspection = structuredArtifact.locator(".artifact-inspection");
    await expect(inspection).toBeVisible();
    await expect(inspection.getByRole("heading", { name: "Structured content" })).toBeVisible();
    await expect(library.locator(".snackbar")).toHaveCount(0, {
      timeout: 15_000,
    });
    await library.setViewportSize({ width: 1280, height: 900 });
    await library.screenshot({
      path: testInfo.outputPath("artifact-detail-wide.png"),
      fullPage: true,
    });
    await library.setViewportSize({ width: 390, height: 844 });
    const artifactNarrowGeometry = await artifactPanel.evaluate((panel) => ({
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelWidth: panel.getBoundingClientRect().width,
      viewportWidth: window.innerWidth,
    }));
    expect(artifactNarrowGeometry.documentOverflow).toBeLessThanOrEqual(0);
    expect(artifactNarrowGeometry.panelWidth).toBeLessThan(artifactNarrowGeometry.viewportWidth);
    await library.screenshot({
      path: testInfo.outputPath("artifact-detail-narrow.png"),
      fullPage: true,
    });
    await library.setViewportSize({ width: 1280, height: 720 });

    const storageAudit = await library.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open("awsm-vault");
        request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const storeNames = Array.from(database.objectStoreNames);
      const transaction = database.transaction(storeNames, "readonly");
      const values = await Promise.all(
        storeNames.map(
          (storeName) =>
            new Promise<unknown[]>((resolveValues, reject) => {
              const request = transaction.objectStore(storeName).getAll();
              request.addEventListener("success", () => resolveValues(request.result), {
                once: true,
              });
              request.addEventListener("error", () => reject(request.error), {
                once: true,
              });
            }),
        ),
      );
      database.close();
      return {
        serialized: JSON.stringify(values),
        localStorageEntries: localStorage.length,
        cacheEntries: (await caches.keys()).length,
      };
    });
    for (const plaintext of [
      "http://127.0.0.1:4174/fixture",
      "AWSM tall fixture",
      "MIME-Version: 1.0",
      "red landmark",
    ]) {
      expect(storageAudit.serialized).not.toContain(plaintext);
    }
    expect(storageAudit.localStorageEntries).toBe(0);
    expect(storageAudit.cacheEntries).toBe(0);

    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Vault" }).click();
    await library
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Export Vault" })
      .click();
    const exportDialog = library.getByRole("dialog", {
      name: "Export encrypted Vault",
    });
    await expect(exportDialog).toBeVisible();
    await expect(
      exportDialog.getByText(/not saved and does not unlock the local Vault/u),
    ).toBeVisible();
    await library.screenshot({
      path: testInfo.outputPath("export-dialog-wide.png"),
    });
    await library.setViewportSize({ width: 720, height: 900 });
    await library.screenshot({
      path: testInfo.outputPath("export-dialog-narrow.png"),
    });
    await expect(exportDialog.getByLabel("Export passphrase", { exact: true })).toBeVisible();
    await expect(exportDialog.getByLabel("Confirm export passphrase")).toBeVisible();
    await exportDialog.getByLabel("Export passphrase", { exact: true }).fill("too short");
    await exportDialog.getByLabel("Confirm export passphrase").fill("too short");
    await exportDialog.getByRole("button", { name: "Export Vault" }).click();
    await expect(
      exportDialog.getByText("Use at least 12 characters and no more than 1,024 UTF-8 bytes."),
    ).toBeVisible();
    await expect(exportDialog.getByLabel("Export passphrase", { exact: true })).toBeFocused();
    await exportDialog
      .getByLabel("Export passphrase", { exact: true })
      .fill("correct horse battery staple");
    await exportDialog
      .getByLabel("Confirm export passphrase")
      .fill("correct horse battery stapler");
    await exportDialog.getByRole("button", { name: "Export Vault" }).click();
    await expect(exportDialog.getByText("The passphrases do not match.")).toBeVisible();
    await expect(exportDialog.getByLabel("Confirm export passphrase")).toBeFocused();
    await exportDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(exportDialog).not.toBeVisible();
    await library.setViewportSize({ width: 1280, height: 720 });

    await expect(library.locator("iframe, object, embed")).toHaveCount(0);
    await expect(library.locator("body")).not.toHaveAttribute(
      "data-live-fixture",
      "executed-only-on-live-page",
    );
    const primaryArtifact = library
      .locator(".artifact-row")
      .filter({ has: library.locator("strong", { hasText: /^MHTML$/u }) });
    await primaryArtifact.getByRole("button", { name: "Download" }).click();
    await expect
      .poll(async () =>
        library.evaluate(async () => {
          const extensionApi = (
            globalThis as unknown as {
              chrome: {
                downloads: {
                  search(query: unknown): Promise<readonly unknown[]>;
                };
              };
            }
          ).chrome;
          const downloads = await extensionApi.downloads.search({
            limit: 1,
            orderBy: ["-startTime"],
            state: "complete",
          });
          return downloads[0] !== undefined;
        }),
      )
      .toBe(true);
    await expect(library.getByRole("status")).toContainText(
      /Downloaded awsm-[0-9a-f]{8}-page\.mhtml/u,
    );
    const mhtmlDownloadRecord = await library.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            downloads: {
              search(query: unknown): Promise<readonly { filename?: string; mime?: string }[]>;
            };
          };
        }
      ).chrome;
      const downloads = await extensionApi.downloads.search({
        limit: 1,
        orderBy: ["-startTime"],
        state: "complete",
      });
      return downloads[0];
    });
    expect(mhtmlDownloadRecord?.mime).toBe("multipart/related");
    if (mhtmlDownloadRecord?.filename === undefined)
      throw new Error("The MHTML download is unavailable.");
    const mhtml = await readFile(mhtmlDownloadRecord.filename, "utf8");
    expect(mhtml).toContain("MIME-Version: 1.0");
    expect(mhtml).toContain("Content-Transfer-Encoding: base64");
    expect(mhtml).toContain("X-AWSM-Page-Snapshot-SHA256:");
    const firstPart = mhtml.match(
      /Content-Type: text\/html; charset=utf-8\r\n[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/u,
    )?.[1];
    if (firstPart === undefined) throw new Error("The derived MHTML document part is missing.");
    const inertHtml = Buffer.from(firstPart.replaceAll(/\s/gu, ""), "base64").toString("utf8");
    expect(inertHtml).toContain("Content-Security-Policy");
    expect(inertHtml).not.toMatch(/<script\b|onload\s*=|javascript:/iu);
    await expect(library.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      "AWSM tall fixture",
    );
    await library.getByRole("button", { name: "Library", exact: true }).click();
    await expect(library.locator(".deleted-section")).not.toHaveAttribute("open", "");
    library.once("dialog", async (dialog) => dialog.dismiss());
    await library.getByRole("button", { name: "Delete AWSM tall fixture collection" }).click();
    await expect(library.getByText("2 captures", { exact: false })).toBeVisible();
    library.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("remain accessible and restorable in Deleted");
      expect(dialog.message()).toContain("Vault Vacuum");
      await dialog.accept();
    });
    await library.getByRole("button", { name: "Delete AWSM tall fixture collection" }).click();
    await expect(library.getByText(/No captures yet/u)).toBeVisible();
    await library.getByText("Deleted (2)", { exact: true }).click();
    await expect(library.getByText("2 captures", { exact: false })).toBeVisible();
    await library.locator(".card").click();
    await expect(library.getByRole("heading", { name: "AWSM tall fixture" })).toBeVisible();
    await expect(library.locator(".version__thumbnail")).toHaveCount(2);
    await library.getByRole("button", { name: "← Deleted" }).click();
    library.once("dialog", async (dialog) => dialog.dismiss());
    await library.getByRole("button", { name: "Restore AWSM tall fixture collection" }).click();
    await expect(library.getByText("2 captures", { exact: false })).toBeVisible();
    library.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Restore “AWSM tall fixture” (2 captures)");
      await dialog.accept();
    });
    await library.getByRole("button", { name: "Restore AWSM tall fixture collection" }).click();
    await expect(library.getByText("Deleted is empty.")).toBeVisible();
    await expect(library.getByText("2 captures", { exact: false })).toBeVisible();
    await expect(library.getByRole("button", { name: "Vacuum Vault" })).toHaveCount(0);
    await library.locator(".card").click();
    await library.locator(".version").first().click();
    library.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("remain accessible and restorable in Deleted");
      await dialog.accept();
    });
    await library.getByRole("button", { name: "Delete capture" }).click();
    await expect(library.getByText("Deleted (1)", { exact: true })).toBeVisible();
    await library.getByText("Deleted (1)", { exact: true }).click();
    await library.locator(".deleted-section .card").click();
    await expect(library.getByRole("img", { name: /Full-page screenshot/u })).toBeVisible();
    const deletedPrimaryArtifact = library
      .locator(".artifact-row")
      .filter({ has: library.locator("strong", { hasText: /^MHTML$/u }) });
    await deletedPrimaryArtifact.getByRole("button", { name: "Download" }).click();
    await expect(deletedPrimaryArtifact.getByRole("button", { name: "Download" })).toBeEnabled({
      timeout: 60_000,
    });
    library.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Restore “AWSM tall fixture” (1 capture)");
      await dialog.accept();
    });
    await library.getByRole("button", { name: "Restore capture" }).click();
    await expect(library.getByText("Deleted is empty.")).toBeVisible();
    await library.locator(".card").click();
    await library.locator(".version").first().click();
    library.once("dialog", async (dialog) => dialog.accept());
    await library.getByRole("button", { name: "Delete capture" }).click();
    await expect(library.getByText("Deleted (1)", { exact: true })).toBeVisible();
    const objectsBeforeVacuum = await library.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open("awsm-vault");
        request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const transaction = database.transaction("objects", "readonly");
      const count = await new Promise<number>((resolveCount, reject) => {
        const request = transaction.objectStore("objects").count();
        request.addEventListener("success", () => resolveCount(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      database.close();
      return count;
    });
    await library.getByText("Deleted (1)", { exact: true }).click();
    await expect(
      library.locator(".deleted-section .card").getByText("1 capture", { exact: false }),
    ).toBeVisible();
    library.once("dialog", async (dialog) => dialog.dismiss());
    await library.getByRole("button", { name: "Vacuum Vault" }).click();
    await expect(
      library.locator(".deleted-section .card").getByText("1 capture", { exact: false }),
    ).toBeVisible();
    library.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("permanently remove 1 deleted capture");
      expect(dialog.message()).toContain("has no undo");
      await dialog.accept();
    });
    await library.getByRole("button", { name: "Vacuum Vault" }).click();
    await expect(library.getByText("Deleted is empty.")).toBeVisible();
    await library.locator(".card").click();
    await expect(library.getByRole("img", { name: /Full-page screenshot/u })).toBeVisible();
    const vacuumStorage = await library.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open("awsm-vault");
        request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const transaction = database.transaction("objects", "readonly");
      const count = await new Promise<number>((resolveCount, reject) => {
        const request = transaction.objectStore("objects").count();
        request.addEventListener("success", () => resolveCount(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const generationTransaction = database.transaction(
        ["vault_head", "vault_generations"],
        "readonly",
      );
      const head = await new Promise<Record<string, unknown>>((resolveHead, reject) => {
        const request = generationTransaction.objectStore("vault_head").getAll();
        request.addEventListener("success", () => resolveHead(request.result[0]), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const generationCount = await new Promise<number>((resolveCount, reject) => {
        const request = generationTransaction.objectStore("vault_generations").count();
        request.addEventListener("success", () => resolveCount(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      database.close();
      return { objectCount: count, head, generationCount };
    });
    expect(vacuumStorage.objectCount).toBeLessThan(objectsBeforeVacuum);
    expect(vacuumStorage.generationCount).toBe(1);
    expect(vacuumStorage.head).toMatchObject({
      version: 1,
      generationNumber: 1,
    });
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("frees synchronized browser storage and restores remote Artifacts on demand", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(300_000);
  expect(browserName).toBe("chromium");
  const password = "correct horse storage battery";
  const email = `storage-${crypto.randomUUID()}@example.test`;
  const client = await createSynchronizedClient(
    testInfo,
    "storage-relief",
    "http://127.0.0.1:3300",
    email,
    password,
  );
  try {
    const fixture = await client.context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    await archiveFixture(client, fixture, 1);
    const desktop = await client.context.newPage();
    const narrow = await client.context.newPage();
    await desktop.setViewportSize({ width: 1280, height: 900 });
    await narrow.setViewportSize({ width: 390, height: 844 });
    await Promise.all([
      desktop.goto(`chrome-extension://${client.extensionId}/library.html`),
      narrow.goto(`chrome-extension://${client.extensionId}/library.html`),
    ]);
    await waitForSynchronizedState(desktop, "http://127.0.0.1:3300");
    const groups = await appRequest<
      readonly { readonly captures: readonly { readonly bundleId: string }[] }[]
    >(desktop, { type: "ListLibrary", expectedVaultId: client.vaultId });
    const bundleId = groups.flatMap((group) => group.captures).at(0)?.bundleId;
    if (bundleId === undefined) throw new Error("The storage-relief Capture is unavailable.");
    await desktop.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    const localScreenshot = desktop.getByRole("img", {
      name: /Full-page screenshot/u,
    });
    await expect(localScreenshot).toBeVisible();
    const originalScreenshotPixels = await localScreenshot.evaluate(async (node) => {
      const image = node as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("The screenshot pixel context is unavailable.");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        width: canvas.width,
        height: canvas.height,
        digest: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))),
      };
    });
    expect(originalScreenshotPixels.width).toBeGreaterThan(0);
    expect(originalScreenshotPixels.height).toBeGreaterThan(0);
    const localPrimary = desktop
      .locator(".artifact-row")
      .filter({ has: desktop.locator("strong", { hasText: /^MHTML$/u }) });
    const originalPrimaryBytes = await downloadBytes(
      desktop,
      localPrimary.getByRole("button", { name: "Download" }),
    );
    expect(originalPrimaryBytes.byteLength).toBeGreaterThan(0);
    await desktop.goto(`chrome-extension://${client.extensionId}/library.html`);
    const estimate = await appRequest<{
      readonly candidateArtifacts: number;
      readonly candidateBytes: number;
    }>(desktop, {
      type: "GetStorageReliefEstimate",
      expectedVaultId: client.vaultId,
    });
    expect(estimate.candidateArtifacts).toBeGreaterThanOrEqual(2);
    expect(estimate.candidateBytes).toBeGreaterThan(0);
    await expect(desktop.getByRole("heading", { name: "Device storage" })).toBeVisible();
    await expect(narrow.getByRole("heading", { name: "Device storage" })).toBeVisible();
    await expect(desktop.getByText(/removed from this device/u)).toBeVisible();
    await expect(narrow.getByText(/removed from this device/u)).toBeVisible();
    await desktop.screenshot({
      path: testInfo.outputPath("storage-relief-estimate-desktop.png"),
      fullPage: true,
    });
    await narrow.screenshot({
      path: testInfo.outputPath("storage-relief-estimate-narrow.png"),
      fullPage: true,
    });
    let confirmation = "";
    desktop.once("dialog", async (dialog) => {
      confirmation = dialog.message();
      await dialog.accept();
    });
    await faultControl(desktop, "arm", "storage-relief:after-synchronization");
    await desktop.getByRole("button", { name: "Reduce device storage" }).click();
    expect(confirmation).toContain(
      "verify each encrypted server copy before removing its local copy",
    );
    expect(confirmation).toContain("require your Account and a connection");
    await expect
      .poll(async () => (await faultControl(desktop, "status")).reached, {
        timeout: 120_000,
      })
      .toBe(true);
    await expect(
      desktop.getByRole("progressbar", { name: "Storage cleanup progress" }),
    ).toBeVisible();
    await expect(
      narrow.getByRole("progressbar", { name: "Storage cleanup progress" }),
    ).toBeVisible();
    const desktopCancel = desktop.getByRole("button", { name: "Cancel" });
    const narrowCancel = narrow.getByRole("button", { name: "Cancel" });
    await desktop.bringToFront();
    await desktop.keyboard.press("Tab");
    await desktopCancel.focus();
    await expect(desktopCancel).toBeFocused();
    await expect(desktop.getByRole("status")).toContainText(/Storage cleanup/u);
    await desktop.screenshot({
      path: testInfo.outputPath("storage-relief-running-desktop.png"),
      fullPage: true,
    });
    await narrow.bringToFront();
    await narrow.keyboard.press("Tab");
    await narrowCancel.focus();
    await expect(narrowCancel).toBeFocused();
    await expect(narrow.getByRole("status")).toContainText(/Storage cleanup/u);
    await narrow.screenshot({
      path: testInfo.outputPath("storage-relief-running-narrow.png"),
      fullPage: true,
    });
    await faultControl(desktop, "release");
    await expect
      .poll(
        async () =>
          (
            await appRequest<{
              readonly latestStorageReliefJob?: { readonly state: string };
            }>(desktop, { type: "GetState" })
          ).latestStorageReliefJob?.state,
        { timeout: 120_000 },
      )
      .toBe("Succeeded");
    await expect(desktop.getByText(/^Removed /u)).toBeVisible();
    await expect(narrow.getByText(/^Removed /u)).toBeVisible();
    await expect(desktop.getByRole("status")).toContainText("Device storage reduction completed");
    await expect(narrow.getByRole("status")).toContainText("Device storage reduction completed");
    const remoteState = await appRequest<{
      readonly remoteOnlyArtifactCount?: number;
    }>(desktop, {
      type: "GetState",
    });
    expect(remoteState.remoteOnlyArtifactCount).toBe(estimate.candidateArtifacts);
    const evictedStorage = await artifactStorageSnapshot(desktop, client.vaultId);
    expect(evictedStorage.remoteOnlyArtifactIds).toHaveLength(estimate.candidateArtifacts);
    for (const artifactObjectId of evictedStorage.remoteOnlyArtifactIds)
      expect(evictedStorage.filenames).not.toContain(`${artifactObjectId}.artifact`);
    expect(evictedStorage.filenames.length).toBeGreaterThan(0);
    await desktop.bringToFront();
    await desktop.keyboard.press("Tab");
    await desktop.getByRole("heading", { name: "Device storage" }).focus();
    await expect(desktop.getByRole("heading", { name: "Device storage" })).toBeFocused();
    await desktop.screenshot({
      path: testInfo.outputPath("storage-relief-success-desktop.png"),
      fullPage: true,
    });
    await narrow.bringToFront();
    await narrow.screenshot({
      path: testInfo.outputPath("storage-relief-success-narrow.png"),
      fullPage: true,
    });

    await appRequest(desktop, { type: "RetrySynchronization" });
    await waitForSynchronizedState(desktop, "http://127.0.0.1:3300");
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(estimate.candidateArtifacts);

    await desktop.getByRole("button", { name: "Settings" }).click();
    await desktop.getByRole("tab", { name: "Vault" }).click();
    await desktop
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Export Vault" })
      .click();
    const exportDialog = desktop.getByRole("dialog", {
      name: "Export encrypted Vault",
    });
    await exportDialog.getByLabel("Export passphrase", { exact: true }).fill(password);
    await exportDialog.getByLabel("Confirm export passphrase").fill(password);
    await exportDialog.getByRole("button", { name: "Export Vault" }).click();
    await expect(exportDialog).not.toBeVisible({ timeout: 120_000 });
    await expect
      .poll(
        async () =>
          (
            await appRequest<{
              readonly latestExportJob?: { readonly state: string };
              readonly remoteOnlyArtifactCount?: number;
            }>(desktop, { type: "GetState" })
          ).latestExportJob?.state,
        { timeout: 120_000 },
      )
      .toBe("Succeeded");
    const exportState = await appRequest<{
      readonly latestExportJob?: {
        readonly state: string;
        readonly stage: string;
        readonly errorId?: string;
      };
    }>(desktop, { type: "GetState" });
    expect(exportState.latestExportJob).toMatchObject({
      state: "Succeeded",
      stage: "Download",
    });
    const exportedPackagePath = await desktop.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            downloads: {
              search(query: {
                readonly limit: 1;
                readonly orderBy: readonly ["-startTime"];
                readonly state: "complete";
              }): Promise<
                readonly {
                  readonly filename?: string;
                  readonly mime?: string;
                }[]
              >;
            };
          };
        }
      ).chrome;
      const downloads = await extensionApi.downloads.search({
        limit: 1,
        orderBy: ["-startTime"],
        state: "complete",
      });
      const exported = downloads[0];
      if (exported?.filename === undefined)
        throw new Error("The completed Vault Package download is unavailable.");
      return exported.filename;
    });
    expect((await readFile(exportedPackagePath)).byteLength).toBeGreaterThan(0);
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(estimate.candidateArtifacts);

    await setCoordinationServerUnavailable(client, true);
    const offlineDetail = await client.context.newPage();
    await offlineDetail.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    await expect(
      offlineDetail.getByText("Stored on server · retrieved when opened").first(),
    ).toBeVisible();
    await expect(
      offlineDetail.getByText("This screenshot is stored on the server. Reconnect and try again."),
    ).toBeVisible();
    await offlineDetail.screenshot({
      path: testInfo.outputPath("storage-relief-offline-detail-desktop.png"),
      fullPage: true,
    });
    await offlineDetail.setViewportSize({ width: 390, height: 844 });
    await offlineDetail.screenshot({
      path: testInfo.outputPath("storage-relief-offline-detail-narrow.png"),
      fullPage: true,
    });
    await offlineDetail.close();
    await setCoordinationServerUnavailable(client, false);
    await appRequest(desktop, { type: "RetrySynchronization" });
    await waitForSynchronizedState(desktop, "http://127.0.0.1:3300");
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(estimate.candidateArtifacts);

    await desktop.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    await expect(desktop.getByRole("img", { name: /Full-page screenshot/u })).toBeVisible({
      timeout: 120_000,
    });
    const restoredScreenshotPixels = await desktop
      .getByRole("img", { name: /Full-page screenshot/u })
      .evaluate(async (node) => {
        const image = node as HTMLImageElement;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("The restored pixel context is unavailable.");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        return {
          width: canvas.width,
          height: canvas.height,
          digest: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))),
        };
      });
    expect(restoredScreenshotPixels).toEqual(originalScreenshotPixels);
    await desktop.screenshot({
      path: testInfo.outputPath("storage-relief-restored-detail-desktop.png"),
      fullPage: true,
    });
    await desktop.setViewportSize({ width: 390, height: 844 });
    await desktop.screenshot({
      path: testInfo.outputPath("storage-relief-restored-detail-narrow.png"),
      fullPage: true,
    });
    await desktop.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(
        async () =>
          (
            await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
              type: "GetState",
            })
          ).remoteOnlyArtifactCount,
      )
      .toBe(estimate.candidateArtifacts - 1);
    await expect.poll(async () => narrow.getByText(/^Removed /u).isVisible()).toBe(true);

    const remotePrimary = desktop
      .locator(".artifact-row")
      .filter({ has: desktop.locator("strong", { hasText: /^MHTML$/u }) });
    expect(
      await downloadBytes(desktop, remotePrimary.getByRole("button", { name: "Download" })),
    ).toEqual(originalPrimaryBytes);
    await expect
      .poll(
        async () =>
          (
            await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
              type: "GetState",
            })
          ).remoteOnlyArtifactCount,
      )
      .toBe(0);

    await desktop.goto(`chrome-extension://${client.extensionId}/library.html`);
    const repeatEstimate = await appRequest<{
      readonly candidateArtifacts: number;
      readonly candidateBytes: number;
    }>(desktop, {
      type: "GetStorageReliefEstimate",
      expectedVaultId: client.vaultId,
    });
    expect(repeatEstimate).toEqual(estimate);
    const priorReliefJobId = (
      await appRequest<{
        readonly latestStorageReliefJob?: { readonly jobId: string };
      }>(desktop, {
        type: "GetState",
      })
    ).latestStorageReliefJob?.jobId;
    desktop.once("dialog", async (dialog) => dialog.accept());
    await desktop.getByRole("button", { name: "Reduce device storage" }).click();
    await expect
      .poll(
        async () => {
          const job = (
            await appRequest<{
              readonly latestStorageReliefJob?: {
                readonly jobId: string;
                readonly state: string;
              };
            }>(desktop, { type: "GetState" })
          ).latestStorageReliefJob;
          return job?.jobId !== priorReliefJobId ? job?.state : undefined;
        },
        { timeout: 120_000 },
      )
      .toBe("Succeeded");
    const repeatedStorage = await artifactStorageSnapshot(desktop, client.vaultId);
    expect(repeatedStorage.remoteOnlyArtifactIds).toHaveLength(estimate.candidateArtifacts);
    for (const artifactObjectId of repeatedStorage.remoteOnlyArtifactIds)
      expect(repeatedStorage.filenames).not.toContain(`${artifactObjectId}.artifact`);

    await narrow.getByRole("button", { name: "Settings" }).click();
    let signOutWarning = "";
    narrow.once("dialog", async (dialog) => {
      signOutWarning = dialog.message();
      await dialog.accept();
    });
    await narrow.getByRole("button", { name: "Sign out" }).click();
    expect(signOutWarning).toMatch(/remote-only Artifacts? depends? on this Account/u);
    await expect
      .poll(
        async () =>
          (
            await appRequest<{
              readonly account: { readonly accountState: string };
            }>(narrow, {
              type: "GetState",
            })
          ).account.accountState,
      )
      .toBe("SignedOut");

    await desktop.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    await expect(desktop.getByText("Sign in to retrieve this screenshot.")).toBeVisible();
    const compactArtifact = desktop.locator(".artifact-row").filter({
      has: desktop.locator("strong", { hasText: /^Extracted text$/u }),
    });
    await compactArtifact.getByRole("button", { name: "Inspect" }).click();
    await expect(desktop.locator(".artifact-inspection:visible")).toBeVisible();

    await desktop.goto(`chrome-extension://${client.extensionId}/library.html`);
    await appRequest(desktop, { type: "LoginAccount", email, password });
    await waitForSynchronizedState(desktop, "http://127.0.0.1:3300");
    await setCoordinationServerUnavailable(client, true);
    await desktop.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    await expect(
      desktop.getByText("This screenshot is stored on the server. Reconnect and try again."),
    ).toBeVisible();
    await desktop.goto(`chrome-extension://${client.extensionId}/library.html`);
    await setCoordinationServerUnavailable(client, false);
    await appRequest(desktop, { type: "RetrySynchronization" });
    await waitForSynchronizedState(desktop, "http://127.0.0.1:3300");

    await faultControl(
      desktop,
      "arm",
      "artifact-retrieval:after-partial-local-write",
      "STORAGE_QUOTA_EXCEEDED",
    );
    await desktop.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    await expect(desktop.getByRole("img", { name: /Full-page screenshot/u })).toBeVisible({
      timeout: 120_000,
    });
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(estimate.candidateArtifacts);
    const transientStorage = await artifactStorageSnapshot(desktop, client.vaultId);
    expect(transientStorage.remoteOnlyArtifactIds).toHaveLength(estimate.candidateArtifacts);
    for (const artifactObjectId of transientStorage.remoteOnlyArtifactIds)
      expect(transientStorage.filenames).not.toContain(`${artifactObjectId}.artifact`);
    await desktop.goto(`chrome-extension://${client.extensionId}/library.html`);
    await faultControl(desktop, "release");

    const imported = await packagedAccountContext(testInfo, "storage-relief-import");
    try {
      await imported.popup.close();
      const importedLibrary = await imported.context.newPage();
      await importedLibrary.goto(
        `chrome-extension://${imported.extensionId}/library.html?import=1`,
      );
      const importDialog = importedLibrary.getByRole("dialog", {
        name: "Import encrypted Vault",
      });
      await importDialog.getByLabel("Vault Package").setInputFiles(exportedPackagePath);
      await importDialog.getByRole("button", { name: "Continue" }).click();
      await importDialog.getByLabel("Export passphrase").fill(password);
      await importDialog.getByRole("button", { name: "Import Vault" }).click();
      await expect(importDialog).not.toBeVisible({ timeout: 120_000 });
      const importedState = await appRequest<{
        readonly workspace: { readonly activeVaultId?: string };
        readonly remoteOnlyArtifactCount?: number;
      }>(importedLibrary, { type: "GetState" });
      if (importedState.workspace.activeVaultId === undefined)
        throw new Error("The imported Vault is not active.");
      expect(importedState.remoteOnlyArtifactCount).toBe(0);
      const importedStorage = await artifactStorageSnapshot(
        importedLibrary,
        importedState.workspace.activeVaultId,
      );
      expect(importedStorage.remoteOnlyArtifactIds).toEqual([]);
      expect(importedStorage.filenames.length).toBeGreaterThanOrEqual(estimate.candidateArtifacts);
      await importedLibrary.getByRole("button", { name: "Unlock on this device" }).click();
      await importedLibrary.goto(
        `chrome-extension://${imported.extensionId}/library.html?bundleId=${bundleId}`,
      );
      const importedPrimary = importedLibrary.locator(".artifact-row").filter({
        has: importedLibrary.locator("strong", { hasText: /^MHTML$/u }),
      });
      expect(
        await downloadBytes(
          importedLibrary,
          importedPrimary.getByRole("button", { name: "Download" }),
        ),
      ).toEqual(originalPrimaryBytes);
    } finally {
      await imported.context.close();
    }

    const preCorruptionStorage = await artifactStorageSnapshot(desktop, client.vaultId);
    expect(preCorruptionStorage.remoteOnlyArtifactIds).toEqual(
      transientStorage.remoteOnlyArtifactIds,
    );
    for (const artifactObjectId of preCorruptionStorage.remoteOnlyArtifactIds)
      expect(preCorruptionStorage.filenames).not.toContain(`${artifactObjectId}.artifact`);
    await corruptRemoteArtifactObjects(preCorruptionStorage.remoteOnlyArtifactIds);
    const artifactReadResult = await desktop.evaluate(
      async ({ expectedVaultId, expectedBundleId }) => {
        const extensionApi = (
          globalThis as typeof globalThis & {
            chrome: {
              runtime: {
                sendMessage(message: unknown, callback: (response: unknown) => void): void;
              };
            };
          }
        ).chrome;
        const send = (message: unknown): Promise<unknown> =>
          new Promise((resolveResponse) =>
            extensionApi.runtime.sendMessage(message, resolveResponse),
          );
        const opened = (await send({
          type: "OpenArtifact",
          expectedVaultId,
          bundleId: expectedBundleId,
          role: "SCREENSHOT_FULL",
        })) as {
          ok: boolean;
          value?: { sessionId: string };
          error?: { id: string };
        };
        if (!opened.ok || opened.value === undefined) return { stage: "open", response: opened };
        for (;;) {
          const next = (await send({
            type: "ReadArtifactChunk",
            expectedVaultId,
            sessionId: opened.value.sessionId,
          })) as {
            ok: boolean;
            value?: { done: boolean };
            error?: { id: string };
          };
          if (!next.ok) return { stage: "read", response: next };
          if (next.value?.done === true) return { stage: "done", response: next };
        }
      },
      { expectedVaultId: client.vaultId, expectedBundleId: bundleId },
    );
    expect(artifactReadResult).toEqual({
      stage: "open",
      response: {
        ok: false,
        error: expect.objectContaining({
          id: "REMOTE_ARTIFACT_INTEGRITY_FAILED",
        }),
      },
    });
    await desktop.goto(
      `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
    );
    await expect(desktop.getByText("Screenshot failed integrity verification.")).toBeVisible({
      timeout: 120_000,
    });
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(desktop, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(estimate.candidateArtifacts);
    expect(await desktop.getByRole("img", { name: /Full-page screenshot/u }).isVisible()).toBe(
      false,
    );
  } finally {
    await client.context.close();
  }
});

test("resumes every packaged storage-relief removal boundary and preserves partial cancellation", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const password = "correct horse restart battery";
  const client = await createSynchronizedClient(
    testInfo,
    "storage-relief-restart",
    "http://127.0.0.1:3300",
    `storage-restart-${crypto.randomUUID()}@example.test`,
    password,
  );
  try {
    const fixture = await client.context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    await archiveFixture(client, fixture, 1);
    const library = await client.context.newPage();
    await library.goto(`chrome-extension://${client.extensionId}/library.html`);
    await waitForSynchronizedState(library, "http://127.0.0.1:3300");
    const groups = await appRequest<
      readonly { readonly captures: readonly { readonly bundleId: string }[] }[]
    >(library, { type: "ListLibrary", expectedVaultId: client.vaultId });
    const bundleId = groups.flatMap((group) => group.captures).at(0)?.bundleId;
    if (bundleId === undefined) throw new Error("The restart Capture is unavailable.");

    const estimate = async (): Promise<{
      readonly candidateArtifacts: number;
      readonly candidateBytes: number;
    }> =>
      appRequest(library, {
        type: "GetStorageReliefEstimate",
        expectedVaultId: client.vaultId,
      });
    const start = async (): Promise<void> => {
      library.once("dialog", (dialog) => void dialog.accept());
      await library.getByRole("button", { name: "Reduce device storage" }).click();
    };
    const restoreHeavyArtifacts = async (): Promise<void> => {
      await library.goto(
        `chrome-extension://${client.extensionId}/library.html?bundleId=${bundleId}`,
      );
      await expect(library.getByRole("img", { name: /Full-page screenshot/u })).toBeVisible({
        timeout: 120_000,
      });
      const primary = library
        .locator(".artifact-row")
        .filter({ has: library.locator("strong", { hasText: /^MHTML$/u }) });
      expect(
        (await downloadBytes(library, primary.getByRole("button", { name: "Download" })))
          .byteLength,
      ).toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            (
              await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(library, {
                type: "GetState",
              })
            ).remoteOnlyArtifactCount,
          { timeout: 120_000 },
        )
        .toBe(0);
      await library.goto(`chrome-extension://${client.extensionId}/library.html`);
    };

    const initialEstimate = await estimate();
    expect(initialEstimate.candidateArtifacts).toBeGreaterThanOrEqual(2);
    for (const checkpoint of [
      "storage-relief:after-verified-checkpoint",
      "storage-relief:after-evicting-checkpoint",
      "storage-relief:after-wrapper-removed",
      "storage-relief:after-remote-only-commit",
    ]) {
      expect(await estimate()).toEqual(initialEstimate);
      await faultControl(library, "arm", checkpoint);
      await start();
      await expect
        .poll(async () => (await faultControl(library, "status")).reached, {
          timeout: 120_000,
        })
        .toBe(true);
      await stopExtensionWorker(client.context, library, client.extensionId);
      await library.reload();
      await expect
        .poll(
          async () =>
            (
              await appRequest<{
                readonly latestStorageReliefJob?: { readonly state: string };
              }>(library, { type: "GetState" })
            ).latestStorageReliefJob?.state,
          { timeout: 120_000 },
        )
        .toBe("Succeeded");
      const storage = await artifactStorageSnapshot(library, client.vaultId);
      expect(storage.remoteOnlyArtifactIds).toHaveLength(initialEstimate.candidateArtifacts);
      for (const artifactObjectId of storage.remoteOnlyArtifactIds)
        expect(storage.filenames).not.toContain(`${artifactObjectId}.artifact`);
      await restoreHeavyArtifacts();
    }

    await faultControl(library, "arm", "storage-relief:after-remote-only-commit");
    await start();
    await expect
      .poll(async () => (await faultControl(library, "status")).reached, {
        timeout: 120_000,
      })
      .toBe(true);
    await expect
      .poll(
        async () =>
          (
            await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(library, {
              type: "GetState",
            })
          ).remoteOnlyArtifactCount,
      )
      .toBe(1);
    const running = await appRequest<{
      readonly latestStorageReliefJob?: { readonly jobId: string };
    }>(library, { type: "GetState" });
    if (running.latestStorageReliefJob === undefined)
      throw new Error("The cancellable storage-relief Job is unavailable.");
    const cancel = library.getByRole("button", { name: "Cancel" });
    await cancel.focus();
    await expect(cancel).toBeFocused();
    await library.keyboard.press("Enter");
    await expect(library.getByRole("status")).toContainText("Cancelling storage cleanup");
    await faultControl(library, "release");
    await expect
      .poll(
        async () =>
          (
            await appRequest<{
              readonly latestStorageReliefJob?: {
                readonly jobId: string;
                readonly state: string;
                readonly cancellationRequested: boolean;
              };
            }>(library, { type: "GetState" })
          ).latestStorageReliefJob,
        { timeout: 120_000 },
      )
      .toMatchObject({
        jobId: running.latestStorageReliefJob.jobId,
        state: "Cancelled",
        cancellationRequested: true,
      });
    await expect(library.getByRole("button", { name: "Reduce device storage" })).toBeFocused();
    await expect(library.getByRole("status")).toContainText("Storage cleanup cancelled");
    expect((await estimate()).candidateArtifacts).toBe(initialEstimate.candidateArtifacts - 1);
    const cancelledStorage = await artifactStorageSnapshot(library, client.vaultId);
    expect(cancelledStorage.remoteOnlyArtifactIds).toHaveLength(1);
    await stopExtensionWorker(client.context, library, client.extensionId);
    await library.reload();
    await expect
      .poll(
        async () =>
          (
            await appRequest<{
              readonly latestStorageReliefJob?: {
                readonly jobId: string;
                readonly state: string;
              };
            }>(library, { type: "GetState" })
          ).latestStorageReliefJob,
      )
      .toMatchObject({
        jobId: running.latestStorageReliefJob.jobId,
        state: "Cancelled",
      });
    expect(
      (
        await appRequest<{ readonly remoteOnlyArtifactCount?: number }>(library, {
          type: "GetState",
        })
      ).remoteOnlyArtifactCount,
    ).toBe(1);
  } finally {
    await client.context.close();
  }
});

test("renders export-first stale Replica discard at desktop and narrow widths", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  expect(browserName).toBe("chromium");
  const extensionPath = testInfo.outputPath("stale-discard-extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath("stale-discard-profile"),
    {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    },
  );
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const popup = await extensionPopup(context, extensionId);
    await popup.getByRole("button", { name: "Continue without sync" }).click();
    await popup.getByRole("button", { name: "Create Vault" }).click();
    await expect(popup.getByRole("button", { name: "Archive this page" })).toBeVisible();
    const state = await popup.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage(value: unknown, callback: (response: unknown) => void): void;
            };
          };
        }
      ).chrome;
      return new Promise<{ workspace: { activeVaultId?: string } }>((resolveState) => {
        extensionApi.runtime.sendMessage({ type: "GetState" }, (response) => {
          resolveState((response as { value: { workspace: { activeVaultId?: string } } }).value);
        });
      });
    });
    if (state.workspace.activeVaultId === undefined) throw new Error("No active Vault.");
    const library = await context.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    await seedStaleAccountVisual(library, state.workspace.activeVaultId);
    await library.reload();
    const resolveButton = library.getByRole("button", {
      name: "Resolve stale Vault",
    });
    await expect(resolveButton).toBeVisible();
    await resolveButton.click();
    const dialog = library.getByRole("dialog", {
      name: "Resolve stale synchronized Vault",
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: "Discard stale local Replica and use server data",
      }),
    ).toBeDisabled();
    await library.setViewportSize({ width: 1280, height: 900 });
    await library.screenshot({
      path: testInfo.outputPath("stale-discard-desktop.png"),
    });
    await dialog.getByLabel(/declining the recommended encrypted Export/u).check();
    await expect(
      dialog.getByRole("button", {
        name: "Discard stale local Replica and use server data",
      }),
    ).toBeDisabled();
    await dialog.getByLabel(/completely overwritten by server data/u).check();
    await expect(
      dialog.getByRole("button", {
        name: "Discard stale local Replica and use server data",
      }),
    ).toBeEnabled();
    await library.setViewportSize({ width: 390, height: 844 });
    const discardAction = dialog.getByRole("button", {
      name: "Discard stale local Replica and use server data",
    });
    await discardAction.scrollIntoViewIfNeeded();
    const discardBox = await discardAction.boundingBox();
    expect(
      discardBox === null ? Number.POSITIVE_INFINITY : discardBox.y + discardBox.height,
    ).toBeLessThanOrEqual(844);
    await library.screenshot({
      path: testInfo.outputPath("stale-discard-narrow-confirmed.png"),
    });
    const replacementVaultId = await library.evaluate(async (expectedActiveVaultId) => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage(value: unknown, callback: (response: unknown) => void): void;
            };
          };
        }
      ).chrome;
      return new Promise<string>((resolveVaultId, reject) => {
        extensionApi.runtime.sendMessage(
          {
            type: "CreateVault",
            expectedActiveVaultId,
            name: "Discard failure fixture",
          },
          (response) => {
            const result = response as {
              ok: boolean;
              value?: { workspace: { activeVaultId?: string } };
            };
            const activeVaultId = result.value?.workspace.activeVaultId;
            if (!result.ok || activeVaultId === undefined)
              reject(new Error("Vault replacement failed"));
            else resolveVaultId(activeVaultId);
          },
        );
      });
    }, state.workspace.activeVaultId);
    await dialog
      .getByRole("button", {
        name: "Discard stale local Replica and use server data",
      })
      .click();
    await expect(dialog.getByText(/active Vault changed|context changed/iu)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await library.screenshot({
      path: testInfo.outputPath("stale-discard-failure.png"),
    });
    await library.close();

    const busyLibrary = await context.newPage();
    await busyLibrary.goto(`chrome-extension://${extensionId}/library.html`);
    await seedStaleAccountVisual(busyLibrary, replacementVaultId);
    await busyLibrary.reload();
    await busyLibrary.getByRole("button", { name: "Resolve stale Vault" }).click();
    const busyDialog = busyLibrary.getByRole("dialog", {
      name: "Resolve stale synchronized Vault",
    });
    await busyDialog.getByLabel(/declining the recommended encrypted Export/u).check();
    await busyDialog.getByLabel(/completely overwritten by server data/u).check();
    await busyDialog
      .getByRole("button", {
        name: "Discard stale local Replica and use server data",
      })
      .click();
    await expect(busyDialog.getByText(/Keep this page open/u)).toBeVisible();
    await busyLibrary.screenshot({
      path: testInfo.outputPath("stale-discard-busy.png"),
    });
  } finally {
    await context.close();
  }
});

test("exports a Vault and imports it into a fresh Workspace", async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe("chromium");
  const extensionPath = testInfo.outputPath("portable-extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const packagePath = testInfo.outputPath("portable-vault.awsm");
  const selectivePackagePath = testInfo.outputPath("selective-vault.awsm");
  const invalidPackagePath = testInfo.outputPath("invalid-vault.awsm");
  class MemoryVaultRepository implements VaultRepository {
    records: VaultRecordsV1 | undefined;
    async load(): Promise<VaultRecordsV1 | undefined> {
      return this.records;
    }
    async setManualLock(): Promise<void> {}
  }
  const repository = new MemoryVaultRepository();
  const preparer = new VaultService(repository);
  const prepared = await preparer.prepareCreate({
    name: "Portable Archive",
    createdAt: "2026-07-19T03:00:00.000Z",
  });
  repository.records = prepared.records;
  const vault = new VaultService(repository, prepared.records.metadata.vaultId);
  vault.activatePrepared(prepared);
  const created = await prepareVaultNameChange({
    rootKey: prepared.rootKey,
    eventType: "VaultCreated",
    vaultId: prepared.records.metadata.vaultId,
    deviceId: prepared.records.metadata.deviceId,
    eventId: crypto.randomUUID(),
    timestamp: prepared.records.metadata.createdAt,
    name: prepared.name,
  });
  const capturedAt = "2026-07-19T03:00:30.000Z";
  const metadata: CaptureMetadataV1 = {
    version: 1,
    originalUrl: "https://fixture.test/portable",
    finalUrl: "https://fixture.test/portable",
    title: "Portable Fixture",
    capturedAt,
    contentType: "text/html",
    viewport: { width: 800, height: 600 },
    document: { width: 800, height: 1200 },
    browserName: "Chrome",
    browserVersion: "149",
    extensionVersion: "0.1.0",
    captureProfileId: "WebPageSnapshot-v1",
    captureProfileVersion: 1,
  };
  const blocks = [
    {
      blockVersion: 1 as const,
      blockId: "B000001",
      kind: "Paragraph" as const,
      text: "Portable fixture text",
      links: [],
    },
  ];
  const encryptedArtifacts = new Map<string, Uint8Array>();
  const primary = new Uint8Array(
    await (
      await createPageSnapshotBlob({
        capturedAt,
        originalUrl: metadata.originalUrl,
        finalUrl: metadata.finalUrl,
        documents: [
          {
            originalUrl: metadata.originalUrl,
            finalUrl: metadata.finalUrl,
            bytes: new TextEncoder().encode(
              "<!doctype html><html><title>Portable Fixture</title><body>Portable fixture text</body></html>",
            ),
            scrollX: 0,
            scrollY: 0,
          },
        ],
        resources: [
          {
            ownerDocumentId: "d000000",
            requestedUrl: "https://fixture.test/portable.bin",
            finalUrl: "https://fixture.test/portable.bin",
            bytes: new Uint8Array(32 * 1024 * 1024).fill(0x20),
            mediaType: "application/octet-stream",
            status: 200,
            acquisition: "Network",
            compression: "Store",
          },
        ],
        omissions: [],
      })
    ).blob.arrayBuffer(),
  );
  const artifacts = await Promise.all([
    preparePortableArtifact(
      encryptedArtifacts,
      prepared.rootKey,
      prepared.records.metadata.vaultId,
      primary,
      "PRIMARY",
      "CAPTURE",
      "application/vnd.awsm.web-page+zip",
      capturedAt,
    ),
    preparePortableArtifact(
      encryptedArtifacts,
      prepared.rootKey,
      prepared.records.metadata.vaultId,
      normalizedTextFromBlocks(blocks),
      "TEXT_EXTRACTED",
      "TEXT",
      "text/plain;charset=utf-8",
      capturedAt,
    ),
    preparePortableArtifact(
      encryptedArtifacts,
      prepared.rootKey,
      prepared.records.metadata.vaultId,
      encodeStructuredContentSequence(blocks),
      "CONTENT_STRUCTURED",
      "STRUCTURED_CONTENT",
      "application/cbor-seq",
      capturedAt,
    ),
  ]);
  const registration = await prepareCaptureRegistration({
    rootKey: prepared.rootKey,
    vaultId: prepared.records.metadata.vaultId,
    deviceId: prepared.records.metadata.deviceId,
    commandId: crypto.randomUUID(),
    bundleId: crypto.randomUUID(),
    descriptorObjectId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    collectionId: crypto.randomUUID(),
    capturedAt,
    metadata,
    artifacts,
    warnings: ["OPTIONAL_METADATA_UNAVAILABLE"],
    clientVersion: "0.1.0",
  });
  const head = {
    ...prepared.records.head,
    appendedEventIds: [created.event.eventId, registration.event.eventId].toSorted(),
    appendedObjectIds: registration.objects.map((object) => object.objectId).toSorted(),
  };
  const events = new Map<string, StoredEvent>([
    [created.event.eventId, created.event],
    [registration.event.eventId, registration.event],
  ]);
  const objects = new Map<string, StoredObjectV1>(
    registration.objects.map((object) => [object.objectId, object]),
  );
  const source: VaultExportSource = {
    getVaultHead: () => Promise.resolve(head),
    getVaultGeneration: () => Promise.resolve(prepared.records.generation),
    getStoredEvent: (eventId) => Promise.resolve(events.get(eventId)),
    getStoredObject: (objectId) => Promise.resolve(objects.get(objectId)),
    listAuthoritativeIds: () =>
      Promise.resolve({
        eventIds: [...events.keys()].toSorted(),
        objectIds: [...objects.keys()].toSorted(),
      }),
  };
  const exportService = new VaultExportService(source, vault, prepared.records.metadata.vaultId, {
    openEncrypted: (_vaultId: string, objectId: string) => {
      const bytes = encryptedArtifacts.get(objectId);
      if (bytes === undefined) return Promise.reject(new Error("Artifact is missing."));
      return Promise.resolve(new Blob([Uint8Array.from(bytes).buffer]).stream());
    },
  } as unknown as ArtifactStore);
  const exportOptions = {
    packageId: crypto.randomUUID(),
    createdAt: "2026-07-19T03:01:00.000Z",
    passphrase: "portable package passphrase",
    salt: crypto.getRandomValues(new Uint8Array(16)),
    nonce: crypto.getRandomValues(new Uint8Array(24)),
  };
  const exported = await exportService.prepare(exportOptions);
  const output = new BlobWriter("application/vnd.awsm.vault+zip");
  await writeVaultPackage(output, exported.entries);
  await writeFile(packagePath, new Uint8Array(await (await output.getData()).arrayBuffer()));
  const selective = await exportService.prepare({
    ...exportOptions,
    packageId: crypto.randomUUID(),
    nonce: crypto.getRandomValues(new Uint8Array(24)),
    omitArtifactObjectIds: new Set([artifacts[0].object.objectId]),
  });
  const selectiveOutput = new BlobWriter("application/vnd.awsm.vault+zip");
  await writeVaultPackage(selectiveOutput, selective.entries);
  await writeFile(
    selectivePackagePath,
    new Uint8Array(await (await selectiveOutput.getData()).arrayBuffer()),
  );
  await writeFile(invalidPackagePath, new TextEncoder().encode("not a Vault Package"));
  const launch = (profile: string) =>
    chromium.launchPersistentContext(testInfo.outputPath(profile), {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });

  const destination = await launch("portable-destination-profile");
  try {
    const worker =
      destination.serviceWorkers()[0] ?? (await destination.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const observer = await destination.newPage();
    await observer.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(
      observer.getByRole("heading", {
        name: "Create or import your first Vault",
      }),
    ).toBeVisible();
    const library = await destination.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html?import=1`);
    const dialog = library.getByRole("dialog", {
      name: "Import encrypted Vault",
    });
    await expect(dialog).toBeVisible();
    await library.setViewportSize({ width: 1280, height: 900 });
    await library.screenshot({
      path: testInfo.outputPath("import-select-wide.png"),
      fullPage: true,
    });
    await dialog.getByLabel("Vault Package").setInputFiles(packagePath);
    await library.screenshot({
      path: testInfo.outputPath("import-select-file-wide.png"),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Continue" })
      .evaluate((button) => (button as HTMLElement).click());
    if (
      await dialog
        .getByRole("progressbar")
        .isVisible()
        .catch(() => false)
    ) {
      await library.screenshot({
        path: testInfo.outputPath("import-acquire-wide.png"),
        fullPage: true,
      });
    }
    await observer.getByRole("button", { name: "Cancel Import" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await library.screenshot({
      path: testInfo.outputPath("import-cancellation-restored-wide.png"),
      fullPage: true,
    });
    await library.getByRole("button", { name: "Import existing Vault" }).click();
    await dialog.getByLabel("Vault Package").setInputFiles(packagePath);
    await dialog.getByRole("button", { name: "Continue" }).click();
    const passphrase = dialog.getByLabel("Export passphrase");
    await expect(passphrase).toBeVisible({ timeout: 30_000 });
    await expect(observer.getByText(/Import · Authenticate/u)).toBeVisible();
    await expect(observer.getByRole("button", { name: "Cancel Import" })).toBeVisible();
    await library.setViewportSize({ width: 390, height: 844 });
    await library.screenshot({
      path: testInfo.outputPath("import-authenticate-narrow.png"),
      fullPage: true,
    });
    await passphrase.fill("incorrect package passphrase");
    await dialog.getByRole("button", { name: "Import Vault" }).click();
    await expect(dialog.getByRole("alert")).toContainText("could not be authenticated");
    await expect(dialog.getByLabel("Export passphrase")).toBeFocused();
    await library.screenshot({
      path: testInfo.outputPath("import-authentication-error-narrow.png"),
      fullPage: true,
    });
    await dialog.getByLabel("Export passphrase").fill("portable package passphrase");
    await dialog.getByRole("button", { name: "Import Vault" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(library.getByRole("heading", { name: "Portable Archive" })).toBeVisible();
    await expect(observer.getByRole("heading", { name: "Portable Archive" })).toBeVisible();
    await expect(library.getByRole("button", { name: "Unlock on this device" })).toBeVisible();
    await library.getByRole("button", { name: "Unlock on this device" }).click();
    await expect(library.getByText("Portable Fixture")).toBeVisible();
    await library.getByText("Portable Fixture").click();
    await library
      .locator("article.artifact-row")
      .filter({ hasText: "Extracted text" })
      .getByRole("button", { name: "Inspect" })
      .click();
    await expect(library.getByText("Portable fixture text")).toBeVisible();
    await expect(library.getByText(/OPTIONAL_METADATA_UNAVAILABLE/u)).toBeVisible();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Vault" }).click();
    await library
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Export Vault" })
      .click();
    const reexportDialog = library.getByRole("dialog", {
      name: "Export encrypted Vault",
    });
    await reexportDialog
      .getByLabel("Export passphrase", { exact: true })
      .fill("re-exported package passphrase");
    await reexportDialog
      .getByLabel("Confirm export passphrase")
      .fill("re-exported package passphrase");
    await faultControl(library, "arm", "export-download:before-download", "EXPORT_DOWNLOAD_FAILED");
    await reexportDialog.getByRole("button", { name: "Export Vault" }).click();
    await expect(reexportDialog).not.toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        appRequest<{
          readonly latestExportJob?: {
            readonly state: string;
            readonly stage: string;
            readonly errorId?: string;
          };
        }>(library, { type: "GetState" }).then((state) => state.latestExportJob),
      )
      .toMatchObject({
        state: "Failed",
        stage: "Download",
        errorId: "EXPORT_DOWNLOAD_FAILED",
      });
    await faultControl(library, "release");
    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Vault" }).click();
    await library
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Export Vault" })
      .click();
    const retryDialog = library.getByRole("dialog", {
      name: "Export encrypted Vault",
    });
    await retryDialog
      .getByLabel("Export passphrase", { exact: true })
      .fill("re-exported package passphrase");
    await retryDialog
      .getByLabel("Confirm export passphrase")
      .fill("re-exported package passphrase");
    await retryDialog.getByRole("button", { name: "Export Vault" }).click();
    await expect(retryDialog).not.toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        library.evaluate(
          () =>
            new Promise((resolve) => {
              const extensionApi = (
                globalThis as unknown as {
                  chrome: {
                    runtime: {
                      sendMessage(value: unknown, callback: (response: unknown) => void): void;
                    };
                  };
                }
              ).chrome;
              extensionApi.runtime.sendMessage({ type: "GetState" }, (response) => {
                resolve(
                  (response as { value: { latestExportJob?: unknown } }).value.latestExportJob,
                );
              });
            }),
        ),
      )
      .toMatchObject({
        state: "Succeeded",
      });
    await expect(library.getByText("The last encrypted Vault Export was downloaded.")).toBeVisible({
      timeout: 30_000,
    });
    const reexportedFilename = await library.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            downloads: {
              search(query: unknown): Promise<readonly { filename?: string }[]>;
            };
          };
        }
      ).chrome;
      const downloads = await extensionApi.downloads.search({
        limit: 1,
        orderBy: ["-startTime"],
        state: "complete",
      });
      return downloads[0]?.filename;
    });
    if (reexportedFilename === undefined)
      throw new Error("The re-exported Vault Package download is unavailable.");
    expect((await readFile(reexportedFilename)).byteLength).toBeGreaterThan(0);
    await library.setViewportSize({ width: 1280, height: 900 });
    await library.screenshot({
      path: testInfo.outputPath("import-success-wide.png"),
      fullPage: true,
    });
    const expectTerminalImportFailure = async (
      sourcePath: string,
      expectedMessage: RegExp,
      screenshotName: string,
      authenticated: boolean,
    ): Promise<void> => {
      await library.getByRole("button", { name: "Settings" }).click();
      await library.getByRole("tab", { name: "Vault" }).click();
      await library
        .getByRole("dialog", { name: "Settings" })
        .getByRole("button", { name: "Import Vault" })
        .click();
      const failureDialog = library.getByRole("dialog", {
        name: "Import encrypted Vault",
      });
      await failureDialog.getByLabel("Vault Package").setInputFiles(sourcePath);
      await failureDialog.getByRole("button", { name: "Continue" }).click();
      await failureDialog.getByLabel("Export passphrase").fill("portable package passphrase");
      await failureDialog.getByRole("button", { name: "Import Vault" }).click();
      if (authenticated) {
        await expect(failureDialog).not.toBeVisible({ timeout: 30_000 });
        await expect(
          library.locator("#vault-management .notice.error").filter({ hasText: expectedMessage }),
        ).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(failureDialog.getByRole("alert")).toContainText(expectedMessage, {
          timeout: 30_000,
        });
      }
      await library.screenshot({
        path: testInfo.outputPath(screenshotName),
        fullPage: true,
      });
      if (!authenticated)
        await failureDialog.getByRole("button", { name: "Close", exact: true }).click();
    };
    await library.setViewportSize({ width: 390, height: 844 });
    await expectTerminalImportFailure(
      packagePath,
      /already exists/u,
      "import-collision-actual-narrow.png",
      true,
    );
    await expectTerminalImportFailure(
      selectivePackagePath,
      /only Complete Vault Packages/u,
      "import-selective-actual-narrow.png",
      true,
    );
    await expectTerminalImportFailure(
      invalidPackagePath,
      /incomplete, corrupt, or unsupported/u,
      "import-invalid-actual-narrow.png",
      false,
    );
  } finally {
    await destination.close();
  }

  const populatedDestination = await launch("portable-populated-destination-profile");
  try {
    const worker =
      populatedDestination.serviceWorkers()[0] ??
      (await populatedDestination.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const popup = await extensionPopup(populatedDestination, extensionId);
    await chooseLocalOnlyOnFirstLaunch(popup);
    await popup.getByRole("textbox", { name: "Vault name" }).fill("Existing Vault");
    await popup.getByRole("button", { name: "Create Vault" }).click();
    await expect(popup.getByText(/Vault · Existing Vault/u)).toBeVisible();
    const library = await populatedDestination.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Vault" }).click();
    await library
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "Import Vault" })
      .click();
    const dialog = library.getByRole("dialog", {
      name: "Import encrypted Vault",
    });
    await dialog.getByLabel("Vault Package").setInputFiles(packagePath);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByLabel("Export passphrase").fill("portable package passphrase");
    await dialog.getByRole("button", { name: "Import Vault" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    await expect(library.getByRole("heading", { name: "Existing Vault" })).toBeVisible();
    const switchToImported = library.getByRole("button", {
      name: "Switch to imported Vault",
    });
    await expect(switchToImported).toBeVisible();
    await library.screenshot({
      path: testInfo.outputPath("import-success-existing-active-wide.png"),
      fullPage: true,
    });
    await switchToImported.click();
    await expect(library.getByRole("heading", { name: "Portable Archive" })).toBeVisible();
    await expect(library.getByRole("button", { name: "Unlock on this device" })).toBeVisible();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(library.getByRole("heading", { name: "Portable Archive" })).toBeVisible();
    for (const stage of ["Validate", "Prepare", "Rebuild", "Commit"] as const) {
      await setLatestImportJobForVisual(library, {
        state: "Running",
        stage,
        completedEntries: stage === "Validate" ? 0 : 2,
        totalEntries: 5,
        processedBytes: stage === "Prepare" ? 16 * 1024 * 1024 : 0,
        totalBytes: stage === "Prepare" ? 32 * 1024 * 1024 : 0,
        cancellationRequested: stage === "Commit",
        errorId: null,
      });
      await library.reload();
      await expect(library.getByText(new RegExp(`Import · ${stage}`, "u"))).toBeVisible();
      const cancelImport = library.getByRole("button", {
        name: "Cancel Import",
      });
      await expect(cancelImport).toBeVisible();
      await expect(library.getByRole("button", { name: "Unlock on this device" })).toBeDisabled();
      if (stage === "Commit") await expect(cancelImport).toBeDisabled();
      await library.screenshot({
        path: testInfo.outputPath(`import-${stage.toLowerCase()}-progress-wide.png`),
        fullPage: true,
      });
    }
    const failureStates = [
      ["IMPORT_PACKAGE_INVALID", "invalid"],
      ["SELECTIVE_IMPORT_UNSUPPORTED", "selective"],
      ["VAULT_ALREADY_EXISTS", "collision"],
      ["STORAGE_QUOTA_EXCEEDED", "quota"],
    ] as const;
    await library.setViewportSize({ width: 390, height: 844 });
    for (const [errorId, screenshotName] of failureStates) {
      await setLatestImportJobForVisual(library, {
        state: "Failed",
        stage: "Commit",
        cancellationRequested: false,
        errorId,
      });
      await library.reload();
      await expect(library.locator("#vault-management .notice.error")).toBeVisible();
      await library.screenshot({
        path: testInfo.outputPath(`import-${screenshotName}-failure-narrow.png`),
        fullPage: true,
      });
    }
    await setLatestImportJobForVisual(library, {
      state: "Succeeded",
      stage: "Commit",
      cancellationRequested: false,
      errorId: null,
    });
    await library.reload();
    await library.setViewportSize({ width: 1280, height: 900 });
    await expect(library.getByRole("heading", { name: "Portable Archive" })).toBeVisible();
    await expect(library.getByRole("button", { name: "Unlock on this device" })).toBeVisible();
  } finally {
    await populatedDestination.close();
  }
});

test("creates, captures, switches, locks, renames, and deep-links across isolated Vaults", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const extensionPath = testInfo.outputPath("extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(testInfo.outputPath("chrome-profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    await Promise.all(context.pages().map((page) => page.close()));
    const fixture = await context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    const popup = await extensionPopup(context, extensionId);
    await chooseLocalOnlyOnFirstLaunch(popup);
    const activateFixture = async (): Promise<void> => {
      await popup.evaluate(async () => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                query(value: unknown): Promise<readonly { id?: number; url?: string }[]>;
                update(id: number, value: unknown): Promise<unknown>;
              };
            };
          }
        ).chrome;
        const tabs = await extensionApi.tabs.query({ currentWindow: true });
        const target = tabs.find((tab) => tab.url === "http://127.0.0.1:4174/fixture");
        if (target?.id === undefined) throw new Error("Fixture tab is unavailable.");
        await extensionApi.tabs.update(target.id, { active: true });
      });
    };
    const name = popup.getByRole("textbox", { name: "Vault name" });
    await expect(name).toBeVisible();
    await name.fill("Vault A");
    await popup.getByRole("button", { name: "Create Vault" }).click();
    await expect(popup.getByText(/Vault · Vault A/u)).toBeVisible();

    await activateFixture();
    await popup.getByRole("button", { name: "Archive this page" }).click();
    await expect(popup.getByRole("link", { name: /Open archived capture/u })).toBeVisible({
      timeout: 30_000,
    });

    const vaultALibrary = await context.newPage();
    await vaultALibrary.goto(`chrome-extension://${extensionId}/library.html`);
    await vaultALibrary.getByRole("button", { name: "Settings" }).click();
    await vaultALibrary.getByRole("tab", { name: "Vault" }).click();
    await vaultALibrary.getByRole("button", { name: "Create another Vault" }).click();
    const createDialog = vaultALibrary.getByRole("dialog", {
      name: "Create another Vault",
    });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole("textbox", { name: "Vault name" }).fill("Vault B");
    await createDialog.getByRole("button", { name: "Create Vault" }).click();
    await expect(popup.getByText(/Vault · Vault B/u)).toBeVisible();
    await vaultALibrary.close();
    const liveLibraryB = await context.newPage();
    await liveLibraryB.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(liveLibraryB.getByRole("heading", { name: "Vault B" })).toBeVisible();

    await activateFixture();
    await popup.getByRole("button", { name: "Archive this page" }).click();
    await expect(popup.getByRole("link", { name: /Open archived capture/u })).toBeVisible({
      timeout: 30_000,
    });
    await expect(liveLibraryB.getByText("AWSM tall fixture", { exact: true })).toBeVisible();
    await liveLibraryB.close();

    const state = await popup.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome;
      const response = (await extensionApi.runtime.sendMessage({
        type: "GetState",
      })) as {
        value: {
          workspace: {
            activeVaultId: string;
            vaults: readonly { vaultId: string; name: string }[];
          };
        };
      };
      return response.value.workspace;
    });
    const vaultA = state.vaults.find((vault) => vault.name === "Vault A");
    const vaultB = state.vaults.find((vault) => vault.name === "Vault B");
    if (vaultA === undefined || vaultB === undefined) throw new Error("Expected both Vaults.");
    expect(state.activeVaultId).toBe(vaultB.vaultId);

    const scopedObjectCounts = await popup.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open("awsm-vault");
        request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const transaction = database.transaction("objects", "readonly");
      const keys = await new Promise<IDBValidKey[]>((resolveKeys, reject) => {
        const request = transaction.objectStore("objects").getAllKeys();
        request.addEventListener("success", () => resolveKeys(request.result), {
          once: true,
        });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      database.close();
      return keys.reduce<Record<string, number>>((counts, key) => {
        if (Array.isArray(key) && typeof key[0] === "string") {
          counts[key[0]] = (counts[key[0]] ?? 0) + 1;
        }
        return counts;
      }, {});
    });
    expect(scopedObjectCounts).toMatchObject({
      [vaultA.vaultId]: 6,
      [vaultB.vaultId]: 6,
    });

    const switchLibrary = await context.newPage();
    await switchLibrary.goto(`chrome-extension://${extensionId}/library.html`);
    await switchLibrary.getByRole("button", { name: "Settings" }).click();
    await switchLibrary.getByRole("tab", { name: "Vault" }).click();
    await switchLibrary.getByRole("button", { name: "Switch to Vault A" }).click();
    await popup.reload();
    await expect(popup.getByText("Vault · Vault A", { exact: true })).toBeVisible();
    await switchLibrary.close();
    const libraryA = await context.newPage();
    await libraryA.goto(`chrome-extension://${extensionId}/library.html`);
    await expect(libraryA.getByRole("heading", { name: "Vault A" })).toBeVisible();
    await expect(libraryA.getByRole("button", { name: "Rename Vault A" })).toHaveCount(0);
    await libraryA.screenshot({
      path: testInfo.outputPath("vault-title-locked-desktop.png"),
    });
    await popup.getByRole("button", { name: "Unlock on this device" }).click();
    await expect(popup.getByText(/Vault · Vault A/u)).toBeVisible();

    await libraryA.reload();
    await libraryA.getByRole("button", { name: "Settings" }).click();
    await libraryA.getByRole("tab", { name: "Vault" }).click();
    const settings = libraryA.getByRole("dialog", { name: "Settings" });
    const renameInput = settings.getByRole("textbox", { name: "Vault name" });
    await renameInput.fill("Vault A Renamed");
    await settings.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(libraryA.getByRole("heading", { name: "Vault A Renamed" })).toBeVisible();
    await popup.reload();
    await expect(popup.getByText("Vault · Vault A Renamed", { exact: true })).toBeVisible();
    await libraryA.screenshot({
      path: testInfo.outputPath("vault-title-success-desktop.png"),
    });
    await libraryA.setViewportSize({ width: 390, height: 844 });
    const narrowLayout = await libraryA.evaluate(() => {
      const header = document.querySelector("header")?.getBoundingClientRect();
      const main = document.querySelector("main")?.getBoundingClientRect();
      if (header === undefined || main === undefined) {
        throw new Error("Library layout is incomplete.");
      }
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        leftEdges: [header.left, main.left],
      };
    });
    expect(narrowLayout.overflow).toBeLessThanOrEqual(0);
    expect(Math.max(...narrowLayout.leftEdges) - Math.min(...narrowLayout.leftEdges)).toBeLessThan(
      1,
    );
    await libraryA.screenshot({
      path: testInfo.outputPath("vault-title-selected-narrow.png"),
    });

    const deepLinkLibrary = await context.newPage();
    await deepLinkLibrary.goto(
      `chrome-extension://${extensionId}/library.html?vaultId=${encodeURIComponent(vaultB.vaultId)}&bundleId=00000000-0000-4000-8000-000000000999`,
    );
    await expect(
      deepLinkLibrary.getByRole("heading", { name: /Switch to Vault B/u }),
    ).toBeVisible();
    await expect(
      deepLinkLibrary.getByRole("button", { name: "Switch to this Vault" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("worker termination during acquisition leaves no partial authoritative capture", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const extensionPath = testInfo.outputPath("extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(testInfo.outputPath("chrome-profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    await Promise.all(context.pages().map((page) => page.close()));
    const fixturePage = await context.newPage();
    await fixturePage.goto("http://127.0.0.1:4174/fixture");
    const cdp = await context.newCDPSession(fixturePage);
    const serviceWorkerVersion = new Promise<string>((resolveVersion) => {
      cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
        const extensionVersion = versions.find((version) => version.scriptURL === worker.url());
        if (extensionVersion !== undefined) resolveVersion(extensionVersion.versionId);
      });
    });
    await cdp.send("ServiceWorker.enable");
    const serviceWorkerVersionId = await serviceWorkerVersion;
    const popup = await extensionPopup(context, extensionId);
    await chooseLocalOnlyOnFirstLaunch(popup);
    await popup.getByRole("button", { name: "Create Vault" }).click();
    await expect(popup.getByRole("button", { name: "Archive this page" })).toBeVisible();
    await popup.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query(value: unknown): Promise<readonly { id?: number; url?: string }[]>;
              update(id: number, value: unknown): Promise<unknown>;
            };
            runtime: {
              sendMessage(value: unknown, callback: (response: unknown) => void): void;
            };
          };
        }
      ).chrome;
      const tabs = await extensionApi.tabs.query({ currentWindow: true });
      const fixtureTab = tabs.find(
        (tab) => tab.id !== undefined && tab.url === "http://127.0.0.1:4174/fixture",
      );
      if (fixtureTab?.id === undefined) throw new Error("The fixture tab is unavailable.");
      await extensionApi.tabs.update(fixtureTab.id, { active: true });
      const state = await new Promise<{
        workspace: { activeVaultId?: string };
      }>((resolve) =>
        extensionApi.runtime.sendMessage({ type: "GetState" }, (response) => {
          const result = response as {
            value: { workspace: { activeVaultId?: string } };
          };
          resolve(result.value);
        }),
      );
      if (state.workspace.activeVaultId === undefined) throw new Error("No active Vault.");
      extensionApi.runtime.sendMessage(
        {
          type: "CaptureActivePage",
          expectedVaultId: state.workspace.activeVaultId,
          tabId: fixtureTab.id,
        },
        () => undefined,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    });
    await expect
      .poll(() =>
        popup.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
            const request = indexedDB.open("awsm-vault");
            request.addEventListener("success", () => resolveDatabase(request.result), {
              once: true,
            });
            request.addEventListener("error", () => reject(request.error), {
              once: true,
            });
          });
          const transaction = database.transaction("capture_jobs", "readonly");
          const jobs = await new Promise<readonly { state?: unknown }[]>((resolveJobs, reject) => {
            const request = transaction.objectStore("capture_jobs").getAll();
            request.addEventListener("success", () => resolveJobs(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), {
              once: true,
            });
          });
          database.close();
          return jobs.at(-1)?.state;
        }),
      )
      .toBe("Running");
    await cdp.send("ServiceWorker.stopWorker", {
      versionId: serviceWorkerVersionId,
    });
    await popup.close();
    const restartedPopup = await extensionPopup(context, extensionId);
    await expect(restartedPopup.getByText(/CAPTURE_INTERRUPTED/u)).toBeVisible({
      timeout: 30_000,
    });
    const counts = await restartedPopup.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open("awsm-vault");
        request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      const names = ["objects", "events", "library_projection", "command_outcomes"];
      const transaction = database.transaction(names, "readonly");
      const values = await Promise.all(
        names.map(
          (name) =>
            new Promise<number>((resolveCount, reject) => {
              const request = transaction.objectStore(name).count();
              request.addEventListener("success", () => resolveCount(request.result), {
                once: true,
              });
              request.addEventListener("error", () => reject(request.error), {
                once: true,
              });
            }),
        ),
      );
      database.close();
      return values;
    });
    expect(counts).toEqual([0, 1, 0, 0]);
  } finally {
    await context.close();
  }
});
