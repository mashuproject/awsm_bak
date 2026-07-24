import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, type TestInfo } from "@playwright/test";

const extensionBuildPath = resolve(process.env.AWSM_EXTENSION_BUILD ?? ".output/chrome-mv3");

export interface PackagedClient {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly popup: Page;
  readonly worker: import("@playwright/test").Worker;
  readonly vaultId: string;
}

export async function appRequest<T>(page: Page, request: Record<string, unknown>): Promise<T> {
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
        extensionApi.runtime.sendMessage(message, (response) => {
          if (response?.ok && response.value !== undefined) resolveValue(response.value);
          else reject(new Error(JSON.stringify(response?.error ?? response)));
        });
      }),
    { message: request },
  );
}

export interface LocalAuthoritySnapshot {
  readonly objectCount: number;
  readonly eventCount: number;
  readonly generationCount: number;
  readonly head: {
    readonly generationId: string;
    readonly generationNumber: number;
    readonly appendedObjectIds: readonly string[];
    readonly appendedEventIds: readonly string[];
  };
}

export async function localAuthoritySnapshot(page: Page): Promise<LocalAuthoritySnapshot> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      const transaction = database.transaction(
        ["objects", "events", "vault_generations", "vault_head"],
        "readonly",
      );
      const count = (storeName: string) =>
        new Promise<number>((resolveCount, reject) => {
          const request = transaction.objectStore(storeName).count();
          request.addEventListener("success", () => resolveCount(request.result), { once: true });
          request.addEventListener("error", () => reject(request.error), { once: true });
        });
      const head = new Promise<LocalAuthoritySnapshot["head"]>((resolveHead, reject) => {
        const request = transaction.objectStore("vault_head").getAll();
        request.addEventListener(
          "success",
          () => resolveHead(request.result[0] as LocalAuthoritySnapshot["head"]),
          { once: true },
        );
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      const [objectCount, eventCount, generationCount, storedHead] = await Promise.all([
        count("objects"),
        count("events"),
        count("vault_generations"),
        head,
      ]);
      return { objectCount, eventCount, generationCount, head: storedHead };
    } finally {
      database.close();
    }
  });
}

export async function faultControl(
  page: Page,
  action: "arm" | "arm-authentication-expiry" | "status" | "release",
  checkpoint?: string,
  failureId?: string,
): Promise<{
  ok: boolean;
  reached?: boolean;
  lastFailure?: { message: string; id?: string; status?: number };
}> {
  return page.evaluate(
    ({ requestedAction, requestedCheckpoint, requestedFailureId }) =>
      new Promise((resolveValue, reject) => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              runtime: {
                sendMessage(value: unknown, callback: (response: unknown) => void): void;
                lastError?: { message?: string };
              };
            };
          }
        ).chrome;
        extensionApi.runtime.sendMessage(
          {
            type: "awsm:test-fault-control",
            action: requestedAction,
            ...(requestedCheckpoint === undefined ? {} : { checkpoint: requestedCheckpoint }),
            ...(requestedFailureId === undefined ? {} : { failureId: requestedFailureId }),
          },
          (response) => {
            if (extensionApi.runtime.lastError !== undefined)
              reject(new Error(extensionApi.runtime.lastError.message ?? "Fault control failed"));
            else
              resolveValue(
                response as {
                  ok: boolean;
                  reached?: boolean;
                  lastFailure?: {
                    message: string;
                    id?: string;
                    status?: number;
                  };
                },
              );
          },
        );
      }),
    {
      requestedAction: action,
      requestedCheckpoint: checkpoint,
      requestedFailureId: failureId,
    },
  );
}

export async function freeBrowserStorage(
  page: Page,
  vaultId: string,
): Promise<{
  readonly filenames: readonly string[];
  readonly remoteOnlyArtifactIds: readonly string[];
}> {
  const estimate = await appRequest<{
    readonly candidateArtifacts: number;
    readonly candidateBytes: number;
  }>(page, { type: "GetStorageReliefEstimate", expectedVaultId: vaultId });
  expect(estimate.candidateArtifacts).toBeGreaterThan(0);
  await appRequest(page, {
    type: "StartStorageRelief",
    expectedVaultId: vaultId,
    candidateArtifacts: estimate.candidateArtifacts,
    candidateBytes: estimate.candidateBytes,
  });
  await expect
    .poll(
      async () =>
        (
          await appRequest<{
            readonly latestStorageReliefJob?: { readonly state: string };
          }>(page, { type: "GetState" })
        ).latestStorageReliefJob?.state,
      { timeout: 120_000 },
    )
    .toBe("Succeeded");
  return page.evaluate(async (expectedVaultId) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-vault");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      const transaction = database.transaction("artifact_availability", "readonly");
      const remoteOnlyArtifactIds = await new Promise<readonly string[]>(
        (resolveValues, reject) => {
          const request = transaction.objectStore("artifact_availability").getAll();
          request.addEventListener(
            "success",
            () =>
              resolveValues(
                request.result
                  .filter((value) => Reflect.get(value, "vaultId") === expectedVaultId)
                  .map((value) => String(Reflect.get(value, "artifactObjectId")))
                  .toSorted(),
              ),
            { once: true },
          );
          request.addEventListener("error", () => reject(request.error), { once: true });
        },
      );
      const root = await navigator.storage.getDirectory();
      const objects = await root.getDirectoryHandle("awsm-vault-objects");
      const directory = await objects.getDirectoryHandle(expectedVaultId);
      const filenames: string[] = [];
      for await (const [name] of directory.entries()) filenames.push(name);
      return { filenames: filenames.toSorted(), remoteOnlyArtifactIds };
    } finally {
      database.close();
    }
  }, vaultId);
}

export async function corruptRemoteArtifactObjects(
  artifactObjectIds: readonly string[],
): Promise<void> {
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
            new Error(`Failed to corrupt proof-server Artifacts: ${stderr}`, { cause: error }),
          );
      },
    );
  });
}

async function packagedContext(testInfo: TestInfo, name: string) {
  const extensionPath = testInfo.outputPath(`${name}-extension`);
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(testInfo.outputPath(`${name}-profile`), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return { context, extensionId, popup, worker };
}

async function toolbarPopup(client: Omit<PackagedClient, "vaultId">): Promise<Page> {
  await client.worker.evaluate(async () => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: { action: { openPopup(): Promise<void> } };
      }
    ).chrome;
    await extensionApi.action.openPopup();
  });
  const popup = await client.context.newPage();
  await popup.goto(`chrome-extension://${client.extensionId}/popup.html`);
  return popup;
}

export async function waitForSynchronizedState(page: Page, serverOrigin: string): Promise<string> {
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
  if (vaultId === undefined) throw new Error("The synchronized Vault is unavailable.");
  return vaultId;
}

export async function createSynchronizedClient(
  testInfo: TestInfo,
  name: string,
  serverOrigin: string,
  email: string,
  password: string,
): Promise<PackagedClient> {
  const client = await packagedContext(testInfo, name);
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

export async function loginSynchronizedClient(
  testInfo: TestInfo,
  name: string,
  serverOrigin: string,
  email: string,
  password: string,
): Promise<PackagedClient> {
  const client = await packagedContext(testInfo, name);
  await appRequest(client.popup, { type: "ConfigureSyncServer", serverOrigin });
  await appRequest(client.popup, { type: "LoginAccount", email, password });
  return {
    ...client,
    vaultId: await waitForSynchronizedState(client.popup, serverOrigin),
  };
}

export async function archiveFixture(
  client: Omit<PackagedClient, "vaultId">,
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
    if (fixtureTab?.id === undefined) throw new Error(`Fixture tab ${fixtureUrl} is unavailable.`);
    await extensionApi.tabs.update(fixtureTab.id, { active: true });
    const nativeQuery = extensionApi.tabs.query.bind(extensionApi.tabs);
    extensionApi.tabs.query = async (query: unknown) => {
      if (typeof query === "object" && query !== null && Reflect.get(query, "active") === true)
        return [fixtureTab];
      return nativeQuery(query);
    };
    const nativeSendMessage = extensionApi.runtime.sendMessage.bind(extensionApi.runtime);
    extensionApi.runtime.sendMessage = (message: unknown, ...rest: unknown[]) =>
      nativeSendMessage(
        typeof message === "object" &&
          message !== null &&
          Reflect.get(message, "type") === "CaptureActivePage"
          ? { ...message, tabId: fixtureTab.id }
          : message,
        ...rest,
      );
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
    const priorJobId = (
      await appRequest<{ latestJob?: { jobId: string } }>(popup, {
        type: "GetState",
      })
    ).latestJob?.jobId;
    await popup.getByRole("button", { name: "Archive this page" }).click({ noWaitAfter: true });
    let terminal: { jobId: string; state: string; errorId?: string } | undefined;
    await expect
      .poll(
        async () => {
          const latest = (
            await appRequest<{
              latestJob?: { jobId: string; state: string; errorId?: string };
            }>(popup, { type: "GetState" })
          ).latestJob;
          if (
            latest === undefined ||
            latest.jobId === priorJobId ||
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
      throw new Error(`Capture failed: ${JSON.stringify(terminal)}`);
  }
  const observer = await client.context.newPage();
  await observer.goto(`chrome-extension://${client.extensionId}/library.html`);
  const vaultId = (
    await appRequest<{ workspace: { activeVaultId?: string } }>(observer, {
      type: "GetState",
    })
  ).workspace.activeVaultId;
  if (vaultId === undefined) throw new Error("The captured Vault is unavailable.");
  await expect
    .poll(
      async () => {
        const groups = await appRequest<readonly { captures: readonly unknown[] }[]>(observer, {
          type: "ListLibrary",
          expectedVaultId: vaultId,
        });
        return groups.reduce((total, group) => total + group.captures.length, 0);
      },
      { timeout: 60_000 },
    )
    .toBe(expectedCaptureCount);
  await observer.close();
  await popup.close();
}

export async function switchClient(
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

export async function activeGeneration(page: Page): Promise<{
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

export async function vacuumDeleted(page: Page, vaultId: string): Promise<void> {
  await appRequest(page, { type: "VacuumVault", expectedVaultId: vaultId });
  const origin = (
    await appRequest<{ account: { configuration: { serverOrigin?: string } } }>(page, {
      type: "GetState",
    })
  ).account.configuration.serverOrigin;
  if (origin === undefined) throw new Error("The synchronized origin is unavailable.");
  await waitForSynchronizedState(page, origin);
}

export async function extractNewestCapture(page: Page, vaultId: string): Promise<void> {
  const groups = await appRequest<
    readonly { captures: readonly { bundleId: string; capturedAt: string }[] }[]
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
  const origin = (
    await appRequest<{ account: { configuration: { serverOrigin?: string } } }>(page, {
      type: "GetState",
    })
  ).account.configuration.serverOrigin;
  if (origin === undefined) throw new Error("The synchronized origin is unavailable.");
  await waitForSynchronizedState(page, origin);
}

export async function sharedDeletedBase(testInfo: TestInfo, name: string) {
  const password = "correct horse archive battery";
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
  for (let index = 1; index <= 3; index += 1) {
    await fixture.evaluate((number) => {
      document.title = `Shared baseline capture ${String(number)}`;
      document.body.dataset.baselineCapture = String(number);
    }, index);
    await archiveFixture(client, fixture, index);
  }
  const groups = await appRequest<readonly { captures: readonly { bundleId: string }[] }[]>(page, {
    type: "ListLibrary",
    expectedVaultId: client.vaultId,
  });
  const bundleIds = groups.flatMap((group) => group.captures.map((capture) => capture.bundleId));
  if (bundleIds.length !== 3) throw new Error("The shared baseline requires three Captures.");
  await appRequest(page, {
    type: "ExtractCaptures",
    expectedVaultId: client.vaultId,
    bundleIds: [bundleIds[0]],
  });
  await appRequest(page, {
    type: "DeleteCaptures",
    expectedVaultId: client.vaultId,
    bundleIds: [bundleIds[1]],
  });
  await waitForSynchronizedState(page, "http://127.0.0.1:3300");
  await switchClient(
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
    bundleIds,
  };
}

export async function stopExtensionWorker(
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

export async function interruptSwitch(
  client: PackagedClient,
  testInfo: TestInfo,
  page: Page,
  candidateOrigin: string,
  email: string,
  password: string,
  checkpoint: string,
  screenshotName: string,
): Promise<void> {
  await appRequest(page, {
    type: "BeginServerSwitch",
    candidateOrigin,
    expectedVaultId: client.vaultId,
  });
  await faultControl(page, "arm", checkpoint);
  const switching = appRequest(page, {
    type: "LoginServerSwitchCandidate",
    email,
    password,
  }).catch(() => undefined);
  await expect
    .poll(async () => (await faultControl(page, "status")).reached, {
      timeout: 120_000,
    })
    .toBe(true);
  const visual = await client.context.newPage();
  await visual.goto(`chrome-extension://${client.extensionId}/library.html`);
  await visual.getByRole("button", { name: "Settings" }).click();
  await visual.screenshot({
    path: testInfo.outputPath(`${screenshotName}-desktop.png`),
  });
  await visual.setViewportSize({ width: 420, height: 800 });
  await visual.screenshot({
    path: testInfo.outputPath(`${screenshotName}-narrow.png`),
  });
  await visual.close();
  await stopExtensionWorker(client.context, page, client.extensionId);
  void switching;
  await page.reload();
  await waitForSynchronizedState(page, candidateOrigin);
}

export async function applyUnionWithVisuals(
  client: PackagedClient,
  testInfo: TestInfo,
  page: Page,
  candidateOrigin: string,
  email: string,
  password: string,
): Promise<void> {
  await appRequest(page, {
    type: "BeginServerSwitch",
    candidateOrigin,
    expectedVaultId: client.vaultId,
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
    path: testInfo.outputPath("server-switch-union-desktop.png"),
  });
  await visual.setViewportSize({ width: 420, height: 800 });
  await visual.screenshot({
    path: testInfo.outputPath("server-switch-union-narrow.png"),
  });
  await visual.close();
  await faultControl(page, "release");
  await switching.catch(() => undefined);
  await waitForSynchronizedState(page, candidateOrigin);
}
