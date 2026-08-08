import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { download as downloadGeckodriver } from "geckodriver";
import { By, until } from "selenium-webdriver";
import { Context, Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION_PATH = resolve(
  PACKAGE_ROOT,
  process.env.AWSM_FIREFOX_SIGNED_XPI ??
    process.env.AWSM_FIREFOX_EXTENSION_BUILD ??
    ".output/firefox-mv3",
);
const SIGNED_INSTALL = process.env.AWSM_FIREFOX_SIGNED_XPI !== undefined;
const DRIVER_CACHE = resolve(PACKAGE_ROOT, ".output/firefox-browsers/geckodriver");
const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const browserConfiguration = JSON.parse(
  await readFile(new URL("../firefox-feasibility/browsers.json", import.meta.url), "utf8"),
);

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

async function startFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Firefox canonical fixture</title>
      <main id="rendered">Stored locally.</main><input id="live" value="preserved">`);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

async function createDriver(lane) {
  const configuration = browserConfiguration[lane];
  const geckodriverBinary = await downloadGeckodriver(
    browserConfiguration.geckodriver.version,
    DRIVER_CACHE,
  );
  const options = new Options()
    .setBinary(resolve(PACKAGE_ROOT, configuration.executable))
    .addArguments("-headless");
  if (!SIGNED_INSTALL) options.setPreference("xpinstall.signatures.required", false);
  const service = new ServiceBuilder(geckodriverBinary)
    .addArguments("--allow-system-access")
    .build();
  return Driver.createSession(options, service);
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

async function grantActiveTab(driver) {
  await driver.setContext(Context.CHROME);
  try {
    await driver.executeScript(
      `
        WebExtensionPolicy.getByID(arguments[0]).extension.tabManager
          .addActiveTabPermission(gBrowser.selectedTab);
      `,
      FIREFOX_EXTENSION_ID,
    );
  } finally {
    await driver.setContext(Context.CONTENT);
  }
}

async function restartBackground(driver) {
  await driver.setContext(Context.CHROME);
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
    await driver.setContext(Context.CONTENT);
  }
}

const lanes = process.env.AWSM_FIREFOX_LANE ? [process.env.AWSM_FIREFOX_LANE] : ["stable", "esr"];

for (const lane of lanes) {
  test(`creates, captures, and reopens a local Vault in Firefox ${lane}`, async () => {
    const fixture = await startFixture();
    const driver = await createDriver(lane);
    try {
      if (process.env.AWSM_FIREFOX_NARROW === "true")
        await driver.manage().window().setRect({ width: 520, height: 760 });
      expect(await driver.installAddon(EXTENSION_PATH, !SIGNED_INSTALL)).toBe(FIREFOX_EXTENSION_ID);
      await driver.setContext(Context.CHROME);
      const popupUrl = await driver.executeScript(
        "return WebExtensionPolicy.getByID(arguments[0]).getURL('popup.html');",
        FIREFOX_EXTENSION_ID,
      );
      const libraryUrl = await driver.executeScript(
        "return WebExtensionPolicy.getByID(arguments[0]).getURL('library.html');",
        FIREFOX_EXTENSION_ID,
      );
      await driver.setContext(Context.CONTENT);
      await driver.get(popupUrl);
      await driver.wait(
        until.elementLocated(By.xpath("//h1[normalize-space()='Create your local Vault']")),
        10_000,
      );
      await driver.findElement(By.id("awsm-vault-name")).sendKeys("Firefox Field Notes");
      await driver.findElement(By.xpath("//button[normalize-space()='Create Vault']")).click();
      await driver.wait(
        until.elementLocated(By.xpath("//h1[normalize-space()='Protect your Vault']")),
        10_000,
      );
      const phraseField = await driver.findElement(By.id("awsm-recovery-phrase"));
      const recoveryPhrase = await driver.executeScript("return arguments[0].value;", phraseField);
      expect(recoveryPhrase.trim()).not.toBe("");
      await driver
        .findElement(By.id("awsm-type-the-recovery-phrase-to-continue"))
        .sendKeys(recoveryPhrase);
      await driver
        .findElement(By.xpath("//button[normalize-space()='Confirm Recovery Phrase']"))
        .click();
      await driver.wait(
        until.elementLocated(By.xpath("//h1[normalize-space()='Archive this page']")),
        10_000,
      );

      const initial = await send(driver, { type: "GetState" });
      expect(typeof initial.selectedVaultId).toBe("string");
      expect(initial.vaults).toHaveLength(1);
      expect(initial.vaults[0].label).toBe("Firefox Field Notes");
      const vaultId = initial.selectedVaultId;

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
      await driver.wait(until.titleIs("Firefox canonical fixture"), 10_000);
      await grantActiveTab(driver);
      await driver.switchTo().window(popupHandle);

      const capture = await send(driver, {
        type: "CaptureActivePage",
        expectedVaultId: vaultId,
        tabId: fixtureTabId,
      });
      const library = await send(driver, { type: "ListLibrary", expectedVaultId: vaultId });
      expect(library).toHaveLength(1);
      expect(library[0]).toMatchObject({
        bundleId: capture.bundleId,
        title: "Firefox canonical fixture",
        lifecycle: "Active",
        availableLocally: true,
      });

      await driver.get(libraryUrl);
      await driver.wait(
        until.elementLocated(By.xpath("//h1[normalize-space()='Library']")),
        10_000,
      );
      await driver.wait(
        until.elementLocated(By.xpath("//*[normalize-space()='Firefox canonical fixture']")),
        10_000,
      );
      await restartBackground(driver);
      const reopened = await send(driver, { type: "ListLibrary", expectedVaultId: vaultId });
      expect(reopened).toHaveLength(1);
      expect(reopened[0].bundleId).toBe(capture.bundleId);
    } finally {
      await driver.quit();
      await fixture.stop();
    }
  });
}
