import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { download as downloadGeckodriver } from "geckodriver";
import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const chromeBuild = resolve(
  packageRoot,
  process.env.AWSM_CHROME_EXTENSION_BUILD ?? ".output/chrome-mv3",
);
const firefoxBuild = resolve(
  packageRoot,
  process.env.AWSM_FIREFOX_SIGNED_XPI ??
    process.env.AWSM_FIREFOX_EXTENSION_BUILD ??
    ".output/firefox-mv3",
);
const signedFirefoxInstall = process.env.AWSM_FIREFOX_SIGNED_XPI !== undefined;
const firefoxExtensionId = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const serverOrigin = "http://127.0.0.1:3300";
const fixtureUrl = "http://127.0.0.1:4174/fixture";
const wrongRecoveryPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const browserConfiguration = JSON.parse(
  await readFile(new URL("../firefox-feasibility/browsers.json", import.meta.url), "utf8"),
);
async function chromeRequest(page, request) {
  return page.evaluate(
    ({ message }) =>
      new Promise((resolveValue, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          if (response?.ok) resolveValue(response.value);
          else reject(new Error(JSON.stringify(response?.error ?? response)));
        });
      }),
    { message: request },
  );
}
async function chromeRawRequest(page, request) {
  return page.evaluate(
    ({ message }) =>
      new Promise((resolveValue) => {
        chrome.runtime.sendMessage(message, (response) =>
          resolveValue({
            response,
            lastError: chrome.runtime.lastError?.message,
          }),
        );
      }),
    { message: request },
  );
}
async function chromeFaultStatus(page) {
  return page.evaluate(
    () =>
      new Promise((resolveValue) => {
        chrome.runtime.sendMessage(
          { type: "awsm:test-fault-control", action: "status" },
          (response) => resolveValue(response),
        );
      }),
  );
}
async function chromeSynchronizationJob(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-client");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("synchronization_jobs", "readonly");
    const value = await new Promise((resolveValue, reject) => {
      const request = transaction.objectStore("synchronization_jobs").get("active");
      request.addEventListener("success", () => resolveValue(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    database.close();
    return value;
  });
}
async function firefoxRequest(driver, request) {
  const response = await driver.executeAsyncScript(
    `
      const [request, done] = arguments;
      browser.runtime.sendMessage(request).then(
        response => done(JSON.parse(JSON.stringify(response))),
        error => done({ thrown: String(error) }),
      );
    `,
    request,
  );
  if (response.thrown !== void 0) throw new Error(response.thrown);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.value;
}
async function firefoxFaultStatus(driver) {
  return driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    browser.runtime.sendMessage({
      type: "awsm:test-fault-control",
      action: "status",
    }).then(
      response => done(JSON.parse(JSON.stringify(response))),
      error => done({ thrown: String(error) }),
    );
  `);
}
async function launchChrome(profile) {
  const extensionPath = resolve(profile, "extension");
  await cp(chromeBuild, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(resolve(profile, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return { context, popup, extensionId };
}
async function launchFirefox(profile, reset = true) {
  if (reset) await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  const browserProfile = resolve(profile, "browser-profile");
  await mkdir(browserProfile, { recursive: true });
  const geckodriverBinary = await downloadGeckodriver(
    browserConfiguration.geckodriver.version,
    resolve(packageRoot, ".output/firefox-browsers/geckodriver"),
  );
  const options = new firefox.Options()
    .setBinary(resolve(packageRoot, browserConfiguration.stable.executable))
    .addArguments("-headless", "-profile", browserProfile);
  if (!signedFirefoxInstall) options.setPreference("xpinstall.signatures.required", false);
  const service = new firefox.ServiceBuilder(geckodriverBinary).addArguments(
    "--allow-system-access",
  );
  return new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
}
async function firefoxPopupUrl(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(
      "return WebExtensionPolicy.getByID(arguments[0]).getURL('popup.html');",
      firefoxExtensionId,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}
async function installedFirefox(profile, reset = true) {
  const driver = await launchFirefox(profile, reset);
  expect(await driver.installAddon(firefoxBuild, !signedFirefoxInstall)).toBe(firefoxExtensionId);
  return { driver, popupUrl: await firefoxPopupUrl(driver) };
}
async function answerFirefoxPermissionPrompt(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.wait(
      async () =>
        driver.executeScript(`
          const panel = globalThis.PopupNotifications?.panel;
          return panel && panel.state !== "closed" &&
            !!document.getElementById("addon-webext-permissions-notification");
        `),
      1e4,
    );
    await driver.executeScript(`
      document.getElementById("addon-webext-permissions-notification").button.click();
    `);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}
async function configureFirefox(driver, popupUrl) {
  const setupUrl = popupUrl.replace(/popup\.html$/u, "sync-setup.html");
  await driver.get(setupUrl);
  await driver.findElement(By.css("#server-choice details")).click();
  const origin = await driver.findElement(By.css('input[name="server-origin"]'));
  await origin.sendKeys(serverOrigin);
  await driver.findElement(By.css('#server-form button[type="submit"]')).click();
  await answerFirefoxPermissionPrompt(driver);
  await driver.wait(
    async () =>
      (await firefoxRequest(driver, { type: "GetState" })).account.configuration.serverOrigin ===
      serverOrigin,
    2e4,
  );
}
async function createRailsAccount(context, email, password) {
  const signup = await context.newPage();
  try {
    await signup.goto(`${serverOrigin}/sign_up`);
    await signup.getByLabel("Email").fill(email);
    await signup.getByLabel("Password", { exact: true }).fill(password);
    await signup.getByLabel("Confirm password").fill(password);
    await Promise.all([
      signup.waitForURL(`${serverOrigin}/account`),
      signup.getByRole("button", { name: "Create Account" }).click(),
    ]);
  } finally {
    await signup.close();
  }
}
async function createRailsAccountFirefox(driver, email, password) {
  await driver.get(`${serverOrigin}/sign_up`);
  await driver.findElement(By.id("account_email")).sendKeys(email);
  await driver.findElement(By.id("account_password")).sendKeys(password);
  await driver.findElement(By.id("account_password_confirmation")).sendKeys(password);
  await driver.findElement(By.css('input[type="submit"]')).click();
  await driver.wait(until.urlIs(`${serverOrigin}/account`), 2e4);
}
async function waitForChromeSync(page) {
  let vaultId;
  await expect
    .poll(async () => {
      const state = await chromeRequest(page, { type: "GetState" });
      vaultId = state.workspace.activeVaultId;
      return `${state.account.vaultSyncState}:${state.account.errorId ?? "ok"}`;
    })
    .toBe("UpToDate:ok");
  if (vaultId === void 0) throw new Error("Chrome did not activate the synchronized Vault.");
  return vaultId;
}
async function waitForFirefoxSync(driver) {
  let vaultId;
  await driver.wait(async () => {
    const state = await firefoxRequest(driver, { type: "GetState" });
    vaultId = state.workspace.activeVaultId;
    return state.account.vaultSyncState === "UpToDate" && state.account.errorId === void 0;
  }, 12e4);
  if (vaultId === void 0) throw new Error("Firefox did not activate the synchronized Vault.");
  return vaultId;
}
async function waitForFirefoxLibrary(driver, vaultId, title) {
  let last;
  try {
    await driver.wait(async () => {
      const [state, groups] = await Promise.all([
        firefoxRequest(driver, { type: "GetState" }),
        firefoxRequest(driver, { type: "ListLibrary", expectedVaultId: vaultId }),
      ]);
      last = { state, groups };
      return JSON.stringify(groups).includes(title);
    }, 12e4);
  } catch (error) {
    throw new Error(`Firefox Library did not converge: ${JSON.stringify(last)}`, {
      cause: error,
    });
  }
}
async function waitForChromeLibrary(page, vaultId, title) {
  await expect
    .poll(
      async () =>
        JSON.stringify(
          await chromeRequest(page, {
            type: "ListLibrary",
            expectedVaultId: vaultId,
          }),
        ),
      { timeout: 12e4 },
    )
    .toContain(title);
}
async function chromeReplicaSnapshot(page, vaultId) {
  return page.evaluate(async (expectedVaultId) => {
    const normalize = (value) => {
      if (Array.isArray(value)) return value.map(normalize);
      const keys = value && typeof value === "object" ? Object.keys(value) : [];
      if (
        value instanceof Uint8Array ||
        (keys.length > 0 && keys.every((key) => /^(?:0|[1-9][0-9]*)$/u.test(key)))
      )
        return {
          bytes: btoa(
            String.fromCharCode(
              ...Array.from(value instanceof Uint8Array ? value : keys.map((key) => value[key])),
            ),
          ),
        };
      if (value instanceof ArrayBuffer)
        return { bytes: btoa(String.fromCharCode(...new Uint8Array(value))) };
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, normalize(value[key])]),
        );
      return value;
    };
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open("awsm-client");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const readStore = async (name) => {
      const transaction = database.transaction(name, "readonly");
      const values = await new Promise((resolveValues, reject) => {
        const request = transaction.objectStore(name).getAll();
        request.addEventListener("success", () => resolveValues(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      return values
        .map(normalize)
        .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    };
    const [events, objects, generations, heads, jobs] = await Promise.all([
      readStore("events"),
      readStore("objects"),
      readStore("vault_generations"),
      readStore("vault_head"),
      readStore("synchronization_jobs"),
    ]);
    database.close();
    const authoritativeObjectIds = new Set(heads.flatMap((head) => head.appendedObjectIds ?? []));
    const authoritativeEventIds = new Set(heads.flatMap((head) => head.appendedEventIds ?? []));
    const directory = await (await navigator.storage.getDirectory())
      .getDirectoryHandle("awsm-vault-objects")
      .then((root) => root.getDirectoryHandle(expectedVaultId));
    const artifacts = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      const bytes = await (await handle.getFile()).arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      artifacts.push({
        name,
        byteLength: bytes.byteLength,
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      });
    }
    return {
      events: events.filter((event) => authoritativeEventIds.has(event.eventId)),
      objects: objects.filter((object) => authoritativeObjectIds.has(object.objectId)),
      generations,
      heads,
      artifacts: artifacts
        .filter((artifact) => authoritativeObjectIds.has(artifact.name.replace(/\.artifact$/u, "")))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      cursor: jobs.find((job) => job.vaultId === expectedVaultId)?.snapshotCursor,
    };
  }, vaultId);
}
async function firefoxReplicaSnapshot(driver, vaultId) {
  return driver
    .executeAsyncScript(
      `
      const [expectedVaultId, done] = arguments;
      (async () => {
        const normalize = value => {
          if (Array.isArray(value)) return value.map(normalize);
          const keys = value && typeof value === "object" ? Object.keys(value) : [];
          if (
            value instanceof Uint8Array ||
            (keys.length > 0 && keys.every(key => /^(?:0|[1-9][0-9]*)$/.test(key)))
          )
            return {
              bytes: btoa(String.fromCharCode(
                ...Array.from(value instanceof Uint8Array ? value : keys.map(key => value[key])),
              )),
            };
          if (value instanceof ArrayBuffer)
            return { bytes: btoa(String.fromCharCode(...new Uint8Array(value))) };
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.keys(value).sort().map(key => [key, normalize(value[key])]),
            );
          return value;
        };
        const database = await new Promise((resolveDatabase, reject) => {
          const request = indexedDB.open("awsm-client");
          request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
          request.addEventListener("error", () => reject(request.error), { once: true });
        });
        const readStore = async name => {
          const transaction = database.transaction(name, "readonly");
          const values = await new Promise((resolveValues, reject) => {
            const request = transaction.objectStore(name).getAll();
            request.addEventListener("success", () => resolveValues(request.result), { once: true });
            request.addEventListener("error", () => reject(request.error), { once: true });
          });
          return values.map(normalize).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)));
        };
        const [events, objects, generations, heads, jobs] = await Promise.all([
          readStore("events"),
          readStore("objects"),
          readStore("vault_generations"),
          readStore("vault_head"),
          readStore("synchronization_jobs"),
        ]);
        database.close();
        const authoritativeObjectIds = new Set(
          heads.flatMap(head => head.appendedObjectIds ?? []),
        );
        const authoritativeEventIds = new Set(
          heads.flatMap(head => head.appendedEventIds ?? []),
        );
        const root = await navigator.storage.getDirectory();
        const objectsRoot = await root.getDirectoryHandle("awsm-vault-objects");
        const directory = await objectsRoot.getDirectoryHandle(expectedVaultId);
        const artifacts = [];
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== "file") continue;
          const bytes = await (await handle.getFile()).arrayBuffer();
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          artifacts.push({
            name,
            byteLength: bytes.byteLength,
            sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""),
          });
        }
        return {
          events: events.filter(event => authoritativeEventIds.has(event.eventId)),
          objects: objects.filter(object => authoritativeObjectIds.has(object.objectId)),
          generations,
          heads,
          artifacts: artifacts
            .filter(artifact => authoritativeObjectIds.has(artifact.name.replace(/\\.artifact$/, "")))
            .sort((left, right) => left.name.localeCompare(right.name)),
          cursor: jobs.find(job => job.vaultId === expectedVaultId)?.snapshotCursor,
        };
      })().then(value => done(JSON.parse(JSON.stringify(value))), error => done({ error: String(error) }));
    `,
      vaultId,
    )
    .then((value) => {
      if (value.error !== void 0) throw new Error(value.error);
      return value;
    });
}
async function expectMatchingReplicas(first, second) {
  await expect.poll(first, { timeout: 12e4 }).toEqual(await second());
}
async function captureInChrome(client, vaultId) {
  const fixture = await client.context.newPage();
  await fixture.goto(fixtureUrl);
  await fixture.evaluate(() => {
    document.title = "Chrome cross-browser capture";
  });
  const tabId = await client.popup.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
    if (tab?.id === void 0) throw new Error("Chrome fixture tab is unavailable.");
    return tab.id;
  }, fixture.url());
  await chromeRequest(client.popup, {
    type: "CaptureActivePage",
    expectedVaultId: vaultId,
    tabId,
  });
  await expect
    .poll(async () => (await chromeRequest(client.popup, { type: "GetState" })).latestJob?.state)
    .toBe("Succeeded");
  await fixture.close();
}
async function captureInFirefox(
  driver,
  popupUrl,
  vaultId,
  title = "Firefox cross-browser capture",
) {
  await driver.get(popupUrl);
  const popupHandle = await driver.getWindowHandle();
  const tabId = await driver.executeAsyncScript(
    `
      const [url, done] = arguments;
      browser.tabs.create({ url, active: true }).then(tab => done(tab.id), error => done({ error: String(error) }));
    `,
    fixtureUrl,
  );
  const fixtureHandle = (await driver.getAllWindowHandles()).find(
    (handle) => handle !== popupHandle,
  );
  if (fixtureHandle === void 0) throw new Error("Firefox fixture tab is unavailable.");
  await driver.switchTo().window(fixtureHandle);
  await driver.wait(until.titleIs("AWSM tall fixture"), 1e4);
  await driver.executeScript("document.title = arguments[0];", title);
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeScript(
      `
        WebExtensionPolicy.getByID(arguments[0]).extension.tabManager
          .addActiveTabPermission(gBrowser.selectedTab);
      `,
      firefoxExtensionId,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
  await driver.switchTo().window(popupHandle);
  await firefoxRequest(driver, {
    type: "CaptureActivePage",
    expectedVaultId: vaultId,
    tabId,
  });
  await driver.wait(
    async () =>
      (await firefoxRequest(driver, { type: "GetState" })).latestJob?.state === "Succeeded",
    6e4,
  );
}
test("recovers a fresh Chrome Device and converges in both directions", async ({
  browserName: _browserName,
}, testInfo) => {
  const sourceProfile = testInfo.outputPath("chrome-source");
  const freshProfile = testInfo.outputPath("chrome-fresh");
  let source = await launchChrome(sourceProfile);
  let fresh = await launchChrome(freshProfile);
  const email = `chrome-pair-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  try {
    await createRailsAccount(source.context, email, password);
    for (const client of [source, fresh])
      await chromeRequest(client.popup, {
        type: "ConfigureSyncServer",
        serverOrigin,
      });
    await chromeRequest(source.popup, { type: "LoginAccount", email, password });
    const prepared = await chromeRequest(source.popup, {
      type: "PrepareAccountVault",
      newVaultName: "Chrome pairing Vault",
    });
    await chromeRequest(source.popup, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const sourceVaultId = await waitForChromeSync(source.popup);
    await captureInChrome(source, sourceVaultId);
    await waitForChromeSync(source.popup);

    await chromeRequest(fresh.popup, { type: "LoginAccount", email, password });
    await expect(
      chromeRequest(fresh.popup, {
        type: "RecoverAccountVault",
        recoveryPhrase: wrongRecoveryPhrase,
        confirmationPhrase: wrongRecoveryPhrase,
      }),
    ).rejects.toThrow(/RECOVERY_PHRASE_INVALID/u);
    await chromeRequest(fresh.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    const freshVaultId = await waitForChromeSync(fresh.popup);
    expect(freshVaultId).toBe(sourceVaultId);
    await waitForChromeLibrary(fresh.popup, freshVaultId, "Chrome cross-browser capture");

    const fixture = await fresh.context.newPage();
    await fixture.goto(fixtureUrl);
    await fixture.evaluate(() => {
      document.title = "Fresh Chrome pairing capture";
    });
    const tabId = await fresh.popup.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (tab?.id === void 0) throw new Error("Fresh Chrome fixture tab is unavailable.");
      return tab.id;
    }, fixture.url());
    await chromeRequest(fresh.popup, {
      type: "CaptureActivePage",
      expectedVaultId: freshVaultId,
      tabId,
    });
    await expect
      .poll(async () => (await chromeRequest(fresh.popup, { type: "GetState" })).latestJob?.state)
      .toBe("Succeeded");
    await waitForChromeSync(fresh.popup);
    await waitForChromeLibrary(source.popup, sourceVaultId, "Fresh Chrome pairing capture");
    await expectMatchingReplicas(
      () => chromeReplicaSnapshot(source.popup, sourceVaultId),
      () => chromeReplicaSnapshot(fresh.popup, freshVaultId),
    );

    await chromeRequest(source.popup, { type: "LogoutAccount" });
    await chromeRequest(fresh.popup, { type: "LogoutAccount" });
    await source.context.close();
    await fresh.context.close();
    source = await launchChrome(sourceProfile);
    fresh = await launchChrome(freshProfile);
    for (const client of [source, fresh]) {
      await chromeRequest(client.popup, { type: "LoginAccount", email, password });
      await chromeRequest(client.popup, {
        type: "UnlockDevice",
        expectedVaultId: sourceVaultId,
      });
      await waitForChromeSync(client.popup);
      await waitForChromeLibrary(client.popup, sourceVaultId, "Fresh Chrome pairing capture");
    }
    await expectMatchingReplicas(
      () => chromeReplicaSnapshot(source.popup, sourceVaultId),
      () => chromeReplicaSnapshot(fresh.popup, sourceVaultId),
    );
  } finally {
    await fresh.context.close();
    await source.context.close();
  }
});

test("removes and future-protects synchronized Devices", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(300_000);
  const source = await launchChrome(testInfo.outputPath("chrome-source"));
  const removed = await launchChrome(testInfo.outputPath("chrome-removed"));
  const reenrolled = await launchChrome(testInfo.outputPath("chrome-reenrolled"));
  const protectedFresh = await launchChrome(testInfo.outputPath("chrome-protected-fresh"));
  const clients = [source, removed, reenrolled, protectedFresh];
  const email = `chrome-revocation-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  try {
    await createRailsAccount(source.context, email, password);
    for (const client of clients)
      await chromeRequest(client.popup, {
        type: "ConfigureSyncServer",
        serverOrigin,
      });
    await chromeRequest(source.popup, { type: "LoginAccount", email, password });
    const prepared = await chromeRequest(source.popup, {
      type: "PrepareAccountVault",
      newVaultName: "Device revocation Vault",
    });
    await chromeRequest(source.popup, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const vaultId = await waitForChromeSync(source.popup);
    await captureInChrome(source, vaultId);
    await waitForChromeSync(source.popup);

    await chromeRequest(removed.popup, { type: "LoginAccount", email, password });
    await chromeRequest(removed.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    await waitForChromeSync(removed.popup);
    await waitForChromeLibrary(removed.popup, vaultId, "Chrome cross-browser capture");
    const removableDevice = (
      await chromeRequest(source.popup, {
        type: "ListVaultDevices",
        expectedVaultId: vaultId,
      })
    ).find((device) => !device.current && !device.revoked);
    if (removableDevice === void 0) throw new Error("The removable Device is unavailable.");
    await chromeRequest(source.popup, {
      type: "RemoveVaultDevice",
      expectedVaultId: vaultId,
      deviceId: removableDevice.deviceId,
    });
    const blockedResponse = await chromeRawRequest(removed.popup, {
      type: "WakeSynchronization",
      expectedVaultId: vaultId,
    });
    expect(blockedResponse.response ?? blockedResponse.lastError).toBeDefined();
    await waitForChromeLibrary(removed.popup, vaultId, "Chrome cross-browser capture");

    await chromeRequest(reenrolled.popup, { type: "LoginAccount", email, password });
    await chromeRequest(reenrolled.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    await waitForChromeSync(reenrolled.popup);
    const reenrolledDevice = (
      await chromeRequest(source.popup, {
        type: "ListVaultDevices",
        expectedVaultId: vaultId,
      })
    ).find((device) => !device.current && !device.revoked);
    if (reenrolledDevice === void 0) throw new Error("The re-enrolled Device is unavailable.");
    const protection = await chromeRequest(source.popup, {
      type: "PrepareFutureProtection",
      expectedVaultId: vaultId,
      targetDeviceId: reenrolledDevice.deviceId,
    });
    try {
      await chromeRequest(source.popup, {
        type: "ConfirmFutureProtection",
        protectionId: protection.protectionId,
        recoveryPhrase: protection.recoveryPhrase,
      });
    } catch (error) {
      throw new Error(
        `Future Protection activation failed: ${JSON.stringify(await chromeFaultStatus(source.popup))}`,
        { cause: error },
      );
    }
    await waitForChromeSync(source.popup);

    await chromeRequest(protectedFresh.popup, { type: "LoginAccount", email, password });
    await expect(
      chromeRequest(protectedFresh.popup, {
        type: "RecoverAccountVault",
        recoveryPhrase: prepared.recoveryPhrase,
        confirmationPhrase: prepared.recoveryPhrase,
      }),
    ).rejects.toThrow(/RECOVERY_PHRASE_INVALID/u);
    await chromeRequest(protectedFresh.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: protection.recoveryPhrase,
      confirmationPhrase: protection.recoveryPhrase,
    });
    await waitForChromeSync(protectedFresh.popup);

    const fixture = await source.context.newPage();
    await fixture.goto(fixtureUrl);
    await fixture.evaluate(() => {
      document.title = "Future-protected Chrome capture";
    });
    const tabId = await source.popup.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (tab?.id === void 0) throw new Error("Future-protection fixture tab is unavailable.");
      return tab.id;
    }, fixture.url());
    await chromeRequest(source.popup, {
      type: "CaptureActivePage",
      expectedVaultId: vaultId,
      tabId,
    });
    await expect
      .poll(async () => (await chromeRequest(source.popup, { type: "GetState" })).latestJob?.state)
      .toBe("Succeeded");
    await fixture.close();
    await waitForChromeSync(source.popup);
    await waitForChromeLibrary(protectedFresh.popup, vaultId, "Future-protected Chrome capture");
    for (const stale of [removed, reenrolled]) {
      const staleLibrary = JSON.stringify(
        await chromeRequest(stale.popup, {
          type: "ListLibrary",
          expectedVaultId: vaultId,
        }),
      );
      expect(staleLibrary).toContain("Chrome cross-browser capture");
      expect(staleLibrary).not.toContain("Future-protected Chrome capture");
    }
    await expectMatchingReplicas(
      () => chromeReplicaSnapshot(source.popup, vaultId),
      () => chromeReplicaSnapshot(protectedFresh.popup, vaultId),
    );
  } finally {
    await Promise.all(clients.map((client) => client.context.close()));
  }
});

test("replays offline unpublished work after Future Protection", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(300_000);
  const source = await launchChrome(testInfo.outputPath("chrome-source"));
  const offline = await launchChrome(testInfo.outputPath("chrome-offline"));
  const target = await launchChrome(testInfo.outputPath("chrome-target"));
  const clients = [source, offline, target];
  const email = `chrome-stale-epoch-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  let offlineNetwork = false;
  try {
    await createRailsAccount(source.context, email, password);
    for (const client of clients)
      await chromeRequest(client.popup, { type: "ConfigureSyncServer", serverOrigin });
    await chromeRequest(source.popup, { type: "LoginAccount", email, password });
    const prepared = await chromeRequest(source.popup, {
      type: "PrepareAccountVault",
      newVaultName: "Offline replay Vault",
    });
    await chromeRequest(source.popup, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const vaultId = await waitForChromeSync(source.popup);
    await chromeRequest(offline.popup, { type: "LoginAccount", email, password });
    await chromeRequest(offline.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    await waitForChromeSync(offline.popup);
    const devicesBeforeTarget = await chromeRequest(source.popup, {
      type: "ListVaultDevices",
      expectedVaultId: vaultId,
    });
    await chromeRequest(target.popup, { type: "LoginAccount", email, password });
    await chromeRequest(target.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    await waitForChromeSync(target.popup);
    const priorDeviceIds = new Set(devicesBeforeTarget.map((device) => device.deviceId));
    const targetDevice = (
      await chromeRequest(source.popup, {
        type: "ListVaultDevices",
        expectedVaultId: vaultId,
      })
    ).find((device) => !device.current && !device.revoked && !priorDeviceIds.has(device.deviceId));
    if (targetDevice === void 0) throw new Error("A Future Protection target is unavailable.");

    const fixture = await offline.context.newPage();
    await fixture.goto(fixtureUrl);
    await fixture.evaluate(() => {
      document.title = "Offline stale-epoch capture";
    });
    const tabId = await offline.popup.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (tab?.id === void 0) throw new Error("Offline fixture tab is unavailable.");
      return tab.id;
    }, fixture.url());
    await offline.context.setOffline(true);
    offlineNetwork = true;
    await chromeRequest(offline.popup, {
      type: "CaptureActivePage",
      expectedVaultId: vaultId,
      tabId,
    });
    await expect
      .poll(async () => (await chromeRequest(offline.popup, { type: "GetState" })).latestJob?.state)
      .toBe("Succeeded");
    await expect
      .poll(
        async () =>
          (await chromeRequest(offline.popup, { type: "GetState" })).account.vaultSyncState,
      )
      .toBe("Offline");
    await fixture.close();

    const protection = await chromeRequest(source.popup, {
      type: "PrepareFutureProtection",
      expectedVaultId: vaultId,
      targetDeviceId: targetDevice.deviceId,
    });
    await chromeRequest(source.popup, {
      type: "ConfirmFutureProtection",
      protectionId: protection.protectionId,
      recoveryPhrase: protection.recoveryPhrase,
    });
    await waitForChromeSync(source.popup);

    await offline.context.setOffline(false);
    offlineNetwork = false;
    await expect
      .poll(() =>
        offline.popup.evaluate(async (origin) => {
          try {
            return (await fetch(`${origin}/ready`)).ok;
          } catch {
            return false;
          }
        }, serverOrigin),
      )
      .toBe(true);
    try {
      await chromeRequest(offline.popup, {
        type: "RetrySynchronization",
      });
    } catch (error) {
      throw new Error(
        `Offline stale-epoch wake failed: ${JSON.stringify(await chromeFaultStatus(offline.popup))}`,
        { cause: error },
      );
    }
    try {
      await waitForChromeSync(offline.popup);
    } catch (error) {
      throw new Error(
        `Offline stale-epoch replay stalled: ${JSON.stringify({
          job: await chromeSynchronizationJob(offline.popup),
          fault: await chromeFaultStatus(offline.popup),
        })}`,
        { cause: error },
      );
    }
    await waitForChromeLibrary(source.popup, vaultId, "Offline stale-epoch capture");
    await expectMatchingReplicas(
      () => chromeReplicaSnapshot(source.popup, vaultId),
      () => chromeReplicaSnapshot(offline.popup, vaultId),
    );
  } finally {
    if (offlineNetwork) await offline.context.setOffline(false).catch(() => undefined);
    await Promise.all(clients.map((client) => client.context.close()));
  }
});

test("loses concurrent Future Protection safely through compare-and-swap", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(300_000);
  const first = await launchChrome(testInfo.outputPath("chrome-first"));
  const second = await launchChrome(testInfo.outputPath("chrome-second"));
  const target = await launchChrome(testInfo.outputPath("chrome-target"));
  const clients = [first, second, target];
  const email = `chrome-rotation-cas-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  try {
    await createRailsAccount(first.context, email, password);
    for (const client of clients)
      await chromeRequest(client.popup, { type: "ConfigureSyncServer", serverOrigin });
    await chromeRequest(first.popup, { type: "LoginAccount", email, password });
    const prepared = await chromeRequest(first.popup, {
      type: "PrepareAccountVault",
      newVaultName: "Rotation CAS Vault",
    });
    await chromeRequest(first.popup, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const vaultId = await waitForChromeSync(first.popup);
    await chromeRequest(second.popup, { type: "LoginAccount", email, password });
    await chromeRequest(second.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    await waitForChromeSync(second.popup);
    const beforeTarget = new Set(
      (
        await chromeRequest(first.popup, {
          type: "ListVaultDevices",
          expectedVaultId: vaultId,
        })
      ).map((device) => device.deviceId),
    );
    await chromeRequest(target.popup, { type: "LoginAccount", email, password });
    await chromeRequest(target.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    await waitForChromeSync(target.popup);
    const targetDevice = (
      await chromeRequest(first.popup, {
        type: "ListVaultDevices",
        expectedVaultId: vaultId,
      })
    ).find((device) => !device.current && !device.revoked && !beforeTarget.has(device.deviceId));
    if (targetDevice === void 0) throw new Error("The concurrent rotation target is unavailable.");

    const [firstProtection, secondProtection] = await Promise.all([
      chromeRequest(first.popup, {
        type: "PrepareFutureProtection",
        expectedVaultId: vaultId,
        targetDeviceId: targetDevice.deviceId,
      }),
      chromeRequest(second.popup, {
        type: "PrepareFutureProtection",
        expectedVaultId: vaultId,
        targetDeviceId: targetDevice.deviceId,
      }),
    ]);
    const outcomes = await Promise.all([
      chromeRawRequest(first.popup, {
        type: "ConfirmFutureProtection",
        protectionId: firstProtection.protectionId,
        recoveryPhrase: firstProtection.recoveryPhrase,
      }),
      chromeRawRequest(second.popup, {
        type: "ConfirmFutureProtection",
        protectionId: secondProtection.protectionId,
        recoveryPhrase: secondProtection.recoveryPhrase,
      }),
    ]);
    const succeeded = outcomes.filter((outcome) => outcome.response?.ok === true);
    const rejected = outcomes.filter((outcome) => outcome.response?.ok === false);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].response.error.id).toBe("RECOVERY_GENERATION_CHANGED");
  } finally {
    await Promise.all(clients.map((client) => client.context.close()));
  }
});

test("replaces a synchronized Vault behind the Complete Export gate", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(300_000);
  const source = await launchChrome(testInfo.outputPath("chrome-source"));
  const stale = await launchChrome(testInfo.outputPath("chrome-stale"));
  const fresh = await launchChrome(testInfo.outputPath("chrome-fresh"));
  const clients = [source, stale, fresh];
  const email = `chrome-replacement-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  try {
    await createRailsAccount(source.context, email, password);
    for (const client of clients)
      await chromeRequest(client.popup, { type: "ConfigureSyncServer", serverOrigin });
    await chromeRequest(source.popup, { type: "LoginAccount", email, password });
    const initial = await chromeRequest(source.popup, {
      type: "PrepareAccountVault",
      newVaultName: "Replacement source Vault",
    });
    await chromeRequest(source.popup, {
      type: "ConfirmInitialVault",
      setupId: initial.setupId,
      recoveryPhrase: initial.recoveryPhrase,
    });
    const sourceVaultId = await waitForChromeSync(source.popup);
    await captureInChrome(source, sourceVaultId);
    await waitForChromeSync(source.popup);
    await chromeRequest(stale.popup, { type: "LoginAccount", email, password });
    await chromeRequest(stale.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: initial.recoveryPhrase,
      confirmationPhrase: initial.recoveryPhrase,
    });
    await waitForChromeSync(stale.popup);

    const blocked = await chromeRawRequest(source.popup, {
      type: "PrepareVaultReplacement",
      expectedVaultId: sourceVaultId,
      safelyStoredConfirmed: true,
    });
    expect(blocked.response).toMatchObject({
      ok: false,
      error: { id: "VAULT_REPLACEMENT_EXPORT_REQUIRED" },
    });
    await chromeRequest(source.popup, {
      type: "ExportVault",
      expectedVaultId: sourceVaultId,
      passphrase: "replacement export passphrase",
    });
    await expect
      .poll(
        async () =>
          (await chromeRequest(source.popup, { type: "GetState" })).latestExportJob?.state,
      )
      .toBe("Succeeded");
    const replacement = await chromeRequest(source.popup, {
      type: "PrepareVaultReplacement",
      expectedVaultId: sourceVaultId,
      safelyStoredConfirmed: true,
    });
    const activationPattern = "**/replacement-candidates/*/activate";
    await source.context.route(activationPattern, (route) => route.abort("failed"));
    const interrupted = await chromeRawRequest(source.popup, {
      type: "ConfirmVaultReplacement",
      replacementId: replacement.replacementId,
      recoveryPhrase: replacement.recoveryPhrase,
    });
    expect(interrupted.response).toEqual({
      ok: false,
      error: {
        id: "SYNCHRONIZATION_INTERRUPTED",
        message: "The synchronization server is unavailable. Local data remains usable.",
      },
    });
    const interruptedState = await chromeRequest(source.popup, { type: "GetState" });
    expect(interruptedState.workspace.activeVaultId).toBe(sourceVaultId);
    expect(interruptedState.vaultReplacement).toMatchObject({
      sourceVaultId,
      state: "Running",
      stage: "ActivateRemote",
    });
    await source.context.unroute(activationPattern);
    await chromeRequest(source.popup, {
      type: "RetryVaultReplacement",
      expectedVaultId: sourceVaultId,
    });
    const replacedState = await chromeRequest(source.popup, { type: "GetState" });
    const replacementVaultId = replacedState.workspace.activeVaultId;
    expect(replacementVaultId).toBe(replacedState.vaultReplacement?.targetVaultId);
    expect(replacementVaultId).not.toBe(sourceVaultId);
    await expect
      .poll(async () => {
        const state = await chromeRequest(source.popup, { type: "GetState" });
        if (state.vaultReplacement?.state === "Running")
          await chromeRequest(source.popup, {
            type: "RetryVaultReplacement",
            expectedVaultId: replacementVaultId,
          });
        return (await chromeRequest(source.popup, { type: "GetState" })).vaultReplacement?.state;
      })
      .toBe("Succeeded");
    await waitForChromeLibrary(source.popup, replacementVaultId, "Chrome cross-browser capture");

    const staleBlocked = await chromeRawRequest(stale.popup, {
      type: "WakeSynchronization",
      expectedVaultId: sourceVaultId,
    });
    expect(staleBlocked.response ?? staleBlocked.lastError).toBeDefined();
    await waitForChromeLibrary(stale.popup, sourceVaultId, "Chrome cross-browser capture");

    await chromeRequest(fresh.popup, { type: "LoginAccount", email, password });
    await expect(
      chromeRequest(fresh.popup, {
        type: "RecoverAccountVault",
        recoveryPhrase: initial.recoveryPhrase,
        confirmationPhrase: initial.recoveryPhrase,
      }),
    ).rejects.toThrow(/RECOVERY_PHRASE_INVALID/u);
    await chromeRequest(fresh.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: replacement.recoveryPhrase,
      confirmationPhrase: replacement.recoveryPhrase,
    });
    await waitForChromeSync(fresh.popup);
    await waitForChromeLibrary(fresh.popup, replacementVaultId, "Chrome cross-browser capture");
    await expectMatchingReplicas(
      () => chromeReplicaSnapshot(source.popup, replacementVaultId),
      () => chromeReplicaSnapshot(fresh.popup, replacementVaultId),
    );
  } finally {
    await Promise.all(clients.map((client) => client.context.close()));
  }
});

test("recovers a fresh Firefox Device and converges in both directions", async ({
  browserName: _browserName,
}, testInfo) => {
  const sourceProfile = testInfo.outputPath("firefox-source");
  const freshProfile = testInfo.outputPath("firefox-fresh");
  let source = await installedFirefox(sourceProfile);
  let fresh = await installedFirefox(freshProfile);
  const email = `firefox-pair-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  try {
    await createRailsAccountFirefox(source.driver, email, password);
    await configureFirefox(source.driver, source.popupUrl);
    await configureFirefox(fresh.driver, fresh.popupUrl);
    await firefoxRequest(source.driver, { type: "LoginAccount", email, password });
    const prepared = await firefoxRequest(source.driver, {
      type: "PrepareAccountVault",
      newVaultName: "Firefox pairing Vault",
    });
    await firefoxRequest(source.driver, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const sourceVaultId = await waitForFirefoxSync(source.driver);
    await captureInFirefox(source.driver, source.popupUrl, sourceVaultId);
    await waitForFirefoxSync(source.driver);

    await firefoxRequest(fresh.driver, { type: "LoginAccount", email, password });
    await expect(
      firefoxRequest(fresh.driver, {
        type: "RecoverAccountVault",
        recoveryPhrase: wrongRecoveryPhrase,
        confirmationPhrase: wrongRecoveryPhrase,
      }),
    ).rejects.toThrow(/RECOVERY_PHRASE_INVALID/u);
    await firefoxRequest(fresh.driver, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    const freshVaultId = await waitForFirefoxSync(fresh.driver);
    expect(freshVaultId).toBe(sourceVaultId);
    await waitForFirefoxLibrary(fresh.driver, freshVaultId, "Firefox cross-browser capture");
    await captureInFirefox(
      fresh.driver,
      fresh.popupUrl,
      freshVaultId,
      "Fresh Firefox pairing capture",
    );
    await waitForFirefoxSync(fresh.driver);
    await waitForFirefoxLibrary(source.driver, sourceVaultId, "Fresh Firefox pairing capture");
    await expectMatchingReplicas(
      () => firefoxReplicaSnapshot(source.driver, sourceVaultId),
      () => firefoxReplicaSnapshot(fresh.driver, freshVaultId),
    );

    if (!signedFirefoxInstall) {
      testInfo.annotations.push({
        type: "restart",
        description:
          "Firefox process-restart coverage requires an AMO-signed XPI; temporary add-ons cannot retain a writable extension IndexedDB origin across reinstall.",
      });
      return;
    }
    await firefoxRequest(source.driver, { type: "LogoutAccount" });
    await firefoxRequest(fresh.driver, { type: "LogoutAccount" });
    await source.driver.quit();
    await fresh.driver.quit();
    source = await installedFirefox(sourceProfile, false);
    fresh = await installedFirefox(freshProfile, false);
    for (const client of [source, fresh]) {
      await client.driver.get(client.popupUrl);
      await client.driver.wait(async () => {
        const state = await firefoxRequest(client.driver, { type: "GetState" });
        return state.workspace.activeVaultId === sourceVaultId;
      }, 2e4);
      try {
        await firefoxRequest(client.driver, { type: "LoginAccount", email, password });
      } catch (error) {
        throw new Error(
          `Firefox returning-Device login failed: ${JSON.stringify(await firefoxFaultStatus(client.driver))}`,
          { cause: error },
        );
      }
      await firefoxRequest(client.driver, {
        type: "UnlockDevice",
        expectedVaultId: sourceVaultId,
      });
      await waitForFirefoxSync(client.driver);
      await waitForFirefoxLibrary(client.driver, sourceVaultId, "Fresh Firefox pairing capture");
    }
    await expectMatchingReplicas(
      () => firefoxReplicaSnapshot(source.driver, sourceVaultId),
      () => firefoxReplicaSnapshot(fresh.driver, sourceVaultId),
    );
  } finally {
    await fresh.driver.quit();
    await source.driver.quit();
  }
});

test("recovers a fresh Chrome Device from Firefox authority", async ({
  browserName: _browserName,
}, testInfo) => {
  const source = await installedFirefox(testInfo.outputPath("firefox-source"));
  const fresh = await launchChrome(testInfo.outputPath("chrome-fresh"));
  const email = `firefox-chrome-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  try {
    await createRailsAccountFirefox(source.driver, email, password);
    await configureFirefox(source.driver, source.popupUrl);
    await chromeRequest(fresh.popup, {
      type: "ConfigureSyncServer",
      serverOrigin,
    });
    await firefoxRequest(source.driver, { type: "LoginAccount", email, password });
    const prepared = await firefoxRequest(source.driver, {
      type: "PrepareAccountVault",
      newVaultName: "Firefox to Chrome Vault",
    });
    await firefoxRequest(source.driver, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const sourceVaultId = await waitForFirefoxSync(source.driver);
    await captureInFirefox(source.driver, source.popupUrl, sourceVaultId);
    await waitForFirefoxSync(source.driver);

    await chromeRequest(fresh.popup, { type: "LoginAccount", email, password });
    await expect(
      chromeRequest(fresh.popup, {
        type: "RecoverAccountVault",
        recoveryPhrase: wrongRecoveryPhrase,
        confirmationPhrase: wrongRecoveryPhrase,
      }),
    ).rejects.toThrow(/RECOVERY_PHRASE_INVALID/u);
    await chromeRequest(fresh.popup, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    const freshVaultId = await waitForChromeSync(fresh.popup);
    expect(freshVaultId).toBe(sourceVaultId);
    await waitForChromeLibrary(fresh.popup, freshVaultId, "Firefox cross-browser capture");
    await captureInChrome(fresh, freshVaultId);
    await waitForChromeSync(fresh.popup);
    await waitForFirefoxLibrary(source.driver, sourceVaultId, "Chrome cross-browser capture");
    await expectMatchingReplicas(
      () => firefoxReplicaSnapshot(source.driver, sourceVaultId),
      () => chromeReplicaSnapshot(fresh.popup, freshVaultId),
    );
  } finally {
    await fresh.context.close();
    await source.driver.quit();
  }
});

test("synchronizes live from Chrome to Firefox and Firefox to Chrome", async ({
  browserName: _browserName,
}, testInfo) => {
  const chromeProfile = testInfo.outputPath("chrome");
  const firefoxProfile = testInfo.outputPath("firefox");
  const email = `cross-browser-${crypto.randomUUID()}@example.test`;
  const password = "cross browser archive password";
  const chromeClient = await launchChrome(chromeProfile);
  const firefoxDriver = await launchFirefox(firefoxProfile);
  try {
    expect(await firefoxDriver.installAddon(firefoxBuild, !signedFirefoxInstall)).toBe(
      firefoxExtensionId,
    );
    const popupUrl = await firefoxPopupUrl(firefoxDriver);
    await firefoxDriver.get(popupUrl);
    await createRailsAccount(chromeClient.context, email, password);
    await chromeRequest(chromeClient.popup, {
      type: "ConfigureSyncServer",
      serverOrigin,
    });
    await chromeRequest(chromeClient.popup, {
      type: "LoginAccount",
      email,
      password,
    });
    const prepared = await chromeRequest(chromeClient.popup, {
      type: "PrepareAccountVault",
      newVaultName: "Cross-browser Vault",
    });
    await chromeRequest(chromeClient.popup, {
      type: "ConfirmInitialVault",
      setupId: prepared.setupId,
      recoveryPhrase: prepared.recoveryPhrase,
    });
    const chromeVaultId = await waitForChromeSync(chromeClient.popup);
    await configureFirefox(firefoxDriver, popupUrl);
    await firefoxRequest(firefoxDriver, {
      type: "LoginAccount",
      email,
      password,
    });
    await expect(
      firefoxRequest(firefoxDriver, {
        type: "RecoverAccountVault",
        recoveryPhrase: wrongRecoveryPhrase,
        confirmationPhrase: wrongRecoveryPhrase,
      }),
    ).rejects.toThrow(/RECOVERY_PHRASE_INVALID/u);
    await firefoxRequest(firefoxDriver, {
      type: "RecoverAccountVault",
      recoveryPhrase: prepared.recoveryPhrase,
      confirmationPhrase: prepared.recoveryPhrase,
    });
    const firefoxVaultId = await waitForFirefoxSync(firefoxDriver);
    expect(firefoxVaultId).toBe(chromeVaultId);
    const chromeLibrary = await chromeClient.context.newPage();
    await chromeLibrary.goto(`chrome-extension://${chromeClient.extensionId}/library.html`);
    const firefoxLibraryUrl = popupUrl.replace(/popup\.html$/u, "library.html");
    await firefoxDriver.get(firefoxLibraryUrl);
    await captureInChrome(chromeClient, chromeVaultId);
    await waitForChromeSync(chromeClient.popup);
    await waitForFirefoxLibrary(firefoxDriver, firefoxVaultId, "Chrome cross-browser capture");
    await firefoxDriver.wait(
      until.elementLocated(
        By.xpath("//*[contains(normalize-space(), 'Chrome cross-browser capture')]"),
      ),
      12e4,
    );
    await captureInFirefox(firefoxDriver, popupUrl, firefoxVaultId);
    await waitForFirefoxSync(firefoxDriver);
    await expect(
      chromeLibrary.locator("article.library-card").filter({
        has: chromeLibrary.locator("strong", {
          hasText: /^Firefox cross-browser capture$/u,
        }),
      }),
    ).toBeVisible();
    await expectMatchingReplicas(
      () => chromeReplicaSnapshot(chromeClient.popup, chromeVaultId),
      () => firefoxReplicaSnapshot(firefoxDriver, firefoxVaultId),
    );
  } finally {
    await firefoxDriver.quit();
    await chromeClient.context.close();
  }
});
