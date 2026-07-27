import { once } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { download as downloadGeckodriver } from "geckodriver";
import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION_PATH = resolve(
  PACKAGE_ROOT,
  process.env.AWSM_FIREFOX_SIGNED_XPI ??
    process.env.AWSM_FIREFOX_EXTENSION_BUILD ??
    ".output/firefox-mv3",
);
const SIGNED_INSTALL = process.env.AWSM_FIREFOX_SIGNED_XPI !== undefined;
const DRIVER_CACHE = resolve(PACKAGE_ROOT, ".output/firefox-browsers/geckodriver");
const DOWNLOAD_ROOT = resolve(PACKAGE_ROOT, ".output/firefox-production-downloads");
const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const browserConfiguration = JSON.parse(
  await readFile(new URL("../firefox-feasibility/browsers.json", import.meta.url), "utf8"),
);

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

async function startFixture() {
  let informationRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/api/server-information") {
      informationRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          service: "AWSM Coordination Server",
          protocolVersion: "1",
          capabilities: {
            accountPassword: true,
            accountVaultLimit: 1,
            completeReplicaSynchronization: true,
            deviceEnrollment: "RecoveryPhrase",
            deviceRevocation: true,
          },
          accountPolicy: { inactiveRetentionDays: 365 },
          registration: { enabled: false },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>Firefox production fixture</title></head>
      <body><main id="rendered">initial</main><input id="live" value="initial">
      <script>rendered.textContent = "rendered"; live.value = "preserved";</script></body></html>`);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    origin: `http://127.0.0.1:${port}`,
    informationRequests: () => informationRequests,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

async function answerPermissionPrompt(driver, accept) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    let prompt;
    try {
      prompt = await driver.wait(
        async () =>
          driver.executeScript(`
          const panel = globalThis.PopupNotifications?.panel;
          if (!panel || panel.state === "closed") return null;
          const notification =
            document.getElementById("addon-webext-permissions-notification") ||
            panel.querySelector("popupnotification");
          if (!notification) return null;
          return {
            id: notification.id,
            label: notification.getAttribute("label") || "",
            text: panel.textContent || "",
          };
        `),
        10_000,
      );
    } catch (error) {
      const diagnostics = await driver.executeScript(`
        const panel = globalThis.PopupNotifications?.panel;
        return {
          panelState: panel?.state,
          panelText: panel?.textContent,
          panelMarkup: panel?.innerHTML,
          permissionIds: [...document.querySelectorAll('[id*="permission"]')].map(node => node.id),
        };
      `);
      await driver.setContext(firefox.Context.CONTENT);
      diagnostics.page = await driver.executeScript(`
        const status = document.querySelector("#status");
        return {
          text: status?.textContent,
          role: status?.getAttribute("role"),
          tone: status?.dataset.tone,
        };
      `);
      await driver.setContext(firefox.Context.CHROME);
      throw new Error(
        `Firefox native permission prompt was not found: ${JSON.stringify(diagnostics)}`,
        {
          cause: error,
        },
      );
    }
    expect(`${prompt.label}\n${prompt.text}`).toContain("AWSM");
    await driver.executeScript(
      `
        const [accept] = arguments;
        const panel = globalThis.PopupNotifications?.panel;
        const notification =
          document.getElementById("addon-webext-permissions-notification") ||
          panel?.querySelector("popupnotification");
        const button = accept ? notification.button : notification.secondaryButton;
        if (!button) throw new Error("Firefox permission response button is unavailable.");
        button.click();
      `,
      accept,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function requestServerFromSetup(driver, origin, accept) {
  const setupUrl = await driver.executeScript('return browser.runtime.getURL("/sync-setup.html");');
  await driver.get(setupUrl);
  const details = await driver.findElement(By.css("#server-choice details"));
  await details.click();
  const originInput = await driver.findElement(By.css('input[name="server-origin"]'));
  await originInput.clear();
  await originInput.sendKeys(origin);
  const submit = await driver.findElement(By.css('#server-form button[type="submit"]'));
  await submit.click();
  await answerPermissionPrompt(driver, accept);
}

async function createDriver(lane) {
  const configuration = browserConfiguration[lane];
  const downloadDirectory = resolve(DOWNLOAD_ROOT, lane);
  await rm(downloadDirectory, { recursive: true, force: true });
  await mkdir(downloadDirectory, { recursive: true });
  const geckodriverBinary = await downloadGeckodriver(
    browserConfiguration.geckodriver.version,
    DRIVER_CACHE,
  );
  const options = new firefox.Options()
    .setBinary(resolve(PACKAGE_ROOT, configuration.executable))
    .addArguments("-headless")
    .setPreference("browser.download.folderList", 2)
    .setPreference("browser.download.dir", downloadDirectory)
    .setPreference("browser.download.useDownloadDir", true)
    .setPreference("browser.download.alwaysOpenPanel", false)
    .setPreference("browser.helperApps.neverAsk.saveToDisk", "multipart/related");
  if (!SIGNED_INSTALL) options.setPreference("xpinstall.signatures.required", false);
  const service = new firefox.ServiceBuilder(geckodriverBinary).addArguments(
    "--allow-system-access",
  );
  return {
    downloadDirectory,
    driver: await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build(),
  };
}

async function send(driver, request) {
  const response = await driver.executeAsyncScript(
    `
      const [request, done] = arguments;
      browser.runtime.sendMessage(request).then(done, error => done({ thrown: String(error) }));
    `,
    request,
  );
  if (response.thrown) throw new Error(response.thrown);
  if (!response.ok) throw new Error(`${response.error.id}: ${response.error.message}`);
  return response.value;
}

async function grantActiveTabForProductionHostSmoke(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeScript(
      `
        WebExtensionPolicy.getByID(arguments[0]).extension.tabManager
          .addActiveTabPermission(gBrowser.selectedTab);
      `,
      FIREFOX_EXTENSION_ID,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function restartBackground(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeAsyncScript(
      `
        const done = arguments[arguments.length - 1];
        WebExtensionPolicy.getByID(arguments[0]).extension
          .terminateBackground({
            ignoreDevToolsAttached: true,
            disableResetIdleForTest: true,
          })
          .then(() => done(true), error => done({ error: String(error) }));
      `,
      FIREFOX_EXTENSION_ID,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

const lanes = process.env.AWSM_FIREFOX_LANE ? [process.env.AWSM_FIREFOX_LANE] : ["stable", "esr"];

for (const lane of lanes) {
  test(`gates Firefox ${lane} synchronization on native data and origin consent`, async () => {
    const fixture = await startFixture();
    const { driver } = await createDriver(lane);
    try {
      if (process.env.AWSM_FIREFOX_NARROW === "true")
        await driver.manage().window().setRect({ width: 520, height: 760 });
      expect(await driver.installAddon(EXTENSION_PATH, !SIGNED_INSTALL)).toBe(FIREFOX_EXTENSION_ID);
      await driver.setContext(firefox.Context.CHROME);
      const popupUrl = await driver.executeScript(
        "return WebExtensionPolicy.getByID(arguments[0]).getURL('popup.html');",
        FIREFOX_EXTENSION_ID,
      );
      await driver.setContext(firefox.Context.CONTENT);
      await driver.get(popupUrl);

      await requestServerFromSetup(driver, fixture.origin, false);
      await driver.wait(
        async () => driver.findElement(By.css('#server-form button[type="submit"]')).isEnabled(),
        10_000,
      );
      expect(fixture.informationRequests()).toBe(0);
      expect((await send(driver, { type: "GetState" })).account.configuration).toEqual({
        mode: "Unconfigured",
      });

      const submit = await driver.findElement(By.css('#server-form button[type="submit"]'));
      await submit.click();
      await answerPermissionPrompt(driver, true);
      await driver.wait(
        async () =>
          (await send(driver, { type: "GetState" })).account.configuration.mode === "Configured",
        10_000,
      );
      expect(fixture.informationRequests()).toBe(1);
      const configured = await send(driver, { type: "GetState" });
      expect(configured.account.configuration).toEqual({
        mode: "Configured",
        serverOrigin: fixture.origin,
        registration: { enabled: false },
      });
      expect(configured.account.vaultSyncState).toBe("AuthenticationRequired");

      const removed = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        browser.permissions.remove({
          data_collection: [
            "websiteContent",
            "browsingActivity",
            "authenticationInfo",
            "personallyIdentifyingInfo",
          ],
        }).then(done, error => done({ error: String(error) }));
      `);
      expect(removed).toBe(true);
      expect((await send(driver, { type: "GetState" })).account.vaultSyncState).toBe(
        "PermissionRequired",
      );
      await expect(send(driver, { type: "WakeSynchronization" })).rejects.toThrow(
        "SERVER_PERMISSION_DENIED",
      );
      expect(fixture.informationRequests()).toBe(1);

      await driver.get(popupUrl);
      await driver.wait(
        until.elementLocated(By.xpath("//button[normalize-space()='Allow synchronization']")),
        10_000,
      );
      if (process.env.AWSM_FIREFOX_PERMISSION_SCREENSHOT !== undefined)
        await writeFile(
          resolve(process.env.AWSM_FIREFOX_PERMISSION_SCREENSHOT),
          await driver.takeScreenshot(),
          "base64",
        );
      await driver.wait(async () => {
        try {
          await driver
            .findElement(By.xpath("//button[normalize-space()='Allow synchronization']"))
            .click();
          return true;
        } catch (error) {
          if (error?.name === "StaleElementReferenceError" || error?.name === "NoSuchElementError")
            return false;
          throw error;
        }
      }, 10_000);
      await answerPermissionPrompt(driver, true);
      await driver.wait(
        async () =>
          (await send(driver, { type: "GetState" })).account.vaultSyncState ===
          "AuthenticationRequired",
        10_000,
      );
    } finally {
      await driver.quit();
      await fixture.stop();
    }
  });

  test(`captures, lists, and downloads MHTML in Firefox ${lane}`, async () => {
    const fixture = await startFixture();
    const { driver, downloadDirectory } = await createDriver(lane);
    try {
      if (process.env.AWSM_FIREFOX_NARROW === "true")
        await driver.manage().window().setRect({ width: 520, height: 760 });
      expect(await driver.installAddon(EXTENSION_PATH, !SIGNED_INSTALL)).toBe(FIREFOX_EXTENSION_ID);
      await driver.setContext(firefox.Context.CHROME);
      const popupUrl = await driver.executeScript(
        "return WebExtensionPolicy.getByID(arguments[0]).getURL('popup.html');",
        FIREFOX_EXTENSION_ID,
      );
      await driver.setContext(firefox.Context.CONTENT);
      await driver.get(popupUrl);
      const initial = await send(driver, { type: "GetState" });
      expect(initial.account.configuration).toEqual({ mode: "Unconfigured" });
      await expect(
        send(driver, {
          type: "ConfigureSyncServer",
          serverOrigin: "https://sync.invalid",
        }),
      ).rejects.toThrow("SERVER_PERMISSION_DENIED");
      await send(driver, { type: "ChooseLocalOnly" });
      const created = await send(driver, {
        type: "CreateVault",
        name: "Firefox Smoke Vault",
      });
      const vaultId = created.workspace.activeVaultId;
      expect(typeof vaultId).toBe("string");
      const popupHandle = await driver.getWindowHandle();
      const fixtureTabId = await driver.executeAsyncScript(
        `
          const [url, done] = arguments;
          browser.tabs.create({ url, active: true }).then(tab => done(tab.id), error => done({ error: String(error) }));
        `,
        fixture.url,
      );
      const fixtureHandle = (await driver.getAllWindowHandles()).find(
        (handle) => handle !== popupHandle,
      );
      expect(fixtureHandle).toBeDefined();
      await driver.switchTo().window(fixtureHandle);
      await driver.wait(until.titleIs("Firefox production fixture"), 10_000);
      await grantActiveTabForProductionHostSmoke(driver);
      await driver.switchTo().window(popupHandle);
      const capture = await send(driver, {
        type: "CaptureActivePage",
        expectedVaultId: vaultId,
        tabId: fixtureTabId,
      });
      const library = await send(driver, {
        type: "ListLibrary",
        expectedVaultId: vaultId,
      });
      expect(library).toHaveLength(1);
      expect(library[0].captures).toHaveLength(1);
      expect(library[0].captures[0]).toMatchObject({
        bundleId: capture.bundleId,
        title: "Firefox production fixture",
      });
      const libraryPageUrl = await driver.executeScript(
        'return browser.runtime.getURL("/library.html");',
      );
      await driver.get(libraryPageUrl);
      await driver.wait(
        async () =>
          (
            await send(driver, {
              type: "GetSearchState",
              expectedVaultId: vaultId,
            })
          ).coverage.keywordCaptures === 1,
        30_000,
      );
      const search = await send(driver, {
        type: "SearchLibrary",
        expectedVaultId: vaultId,
        query: "Firefox production fixture",
        clientInstanceId: "abcdefghijklmnopqrstuv",
        scope: "Active",
        filters: { hosts: [], collectionIds: [] },
        pageSize: 50,
      });
      expect(search.results).toHaveLength(1);
      expect(search.results[0]).toMatchObject({
        bundleId: capture.bundleId,
        title: "Firefox production fixture",
        match: "ExactTitle",
      });
      await driver.wait(async () => {
        try {
          await driver.findElement(By.css("#account-settings")).click();
          return (await driver.findElements(By.css("dialog[open]"))).length === 1;
        } catch (error) {
          if (error?.name === "StaleElementReferenceError" || error?.name === "NoSuchElementError")
            return false;
          throw error;
        }
      }, 10_000);
      await driver.wait(
        until.elementLocated(By.xpath("//*[contains(normalize-space(), 'Local only')]")),
        10_000,
      );
      expect(
        await driver.findElements(By.xpath("//button[normalize-space()='Connect server']")),
      ).toHaveLength(1);
      if (process.env.AWSM_FIREFOX_SCREENSHOT !== undefined)
        await writeFile(
          resolve(process.env.AWSM_FIREFOX_SCREENSHOT),
          await driver.takeScreenshot(),
          "base64",
        );
      let download;
      try {
        download = await send(driver, {
          type: "DownloadMhtml",
          expectedVaultId: vaultId,
          bundleId: capture.bundleId,
        });
      } catch (error) {
        const diagnostics = await driver.executeAsyncScript(`
          const done = arguments[arguments.length - 1];
          browser.downloads.search({}).then(
            items => done({ items, runtimeOrigin: new URL(browser.runtime.getURL("/")).origin }),
            cause => done({ error: String(cause) }),
          );
        `);
        throw new Error(`${String(error)} ${JSON.stringify(diagnostics)}`);
      }
      await driver.wait(async () => (await readdir(downloadDirectory)).includes(download.filename));
      const mhtml = await readFile(resolve(downloadDirectory, download.filename), "utf8");
      const encodedDocument = mhtml.split(/\r?\n\r?\n/u)[2]?.split(/\r?\n--/u)[0];
      expect(encodedDocument).toBeDefined();
      const documentHtml = Buffer.from(encodedDocument.replaceAll(/\s/gu, ""), "base64").toString(
        "utf8",
      );
      expect(documentHtml).toContain("Firefox production fixture");
      expect(documentHtml).toContain('value="preserved"');
      if (process.env.AWSM_FIREFOX_EXPORT === "true") {
        const exported = await send(driver, {
          type: "ExportVault",
          expectedVaultId: vaultId,
          passphrase: "firefox-production-export-passphrase",
        });
        await driver.wait(async () =>
          (await readdir(downloadDirectory)).includes(exported.filename),
        );
        expect(
          (await readFile(resolve(downloadDirectory, exported.filename))).byteLength,
        ).toBeGreaterThan(0);
        await send(driver, { type: "ResetLocalDevice" });
        await restartBackground(driver);
        const libraryUrl = await driver.executeScript(
          'return browser.runtime.getURL("/library.html?import=1");',
        );
        await driver.get(libraryUrl);
        const fileInput = await driver.wait(
          until.elementLocated(By.css('input[type="file"]')),
          10_000,
        );
        await fileInput.sendKeys(resolve(downloadDirectory, exported.filename));
        await driver.findElement(By.xpath("//button[normalize-space()='Continue']")).click();
        const passphrase = await driver.wait(
          until.elementLocated(By.css('input[type="password"]')),
          10_000,
        );
        await passphrase.sendKeys("firefox-production-export-passphrase");
        await driver.findElement(By.xpath("//button[normalize-space()='Import Vault']")).click();
        await driver.wait(async () => {
          const state = await send(driver, { type: "GetState" });
          return (
            state.latestImportJob?.state === "Succeeded" &&
            state.workspace.vaults.some((vault) => vault.name === "Firefox Smoke Vault")
          );
        }, 20_000);
      }
    } finally {
      await driver.quit();
      await fixture.stop();
    }
  });
}
