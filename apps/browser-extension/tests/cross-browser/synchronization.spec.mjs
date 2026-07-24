import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { download as downloadGeckodriver } from "geckodriver";
import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const chromeBuild = resolve(packageRoot, ".output/chrome-mv3");
const firefoxBuild = resolve(
  packageRoot,
  process.env.AWSM_FIREFOX_SIGNED_XPI ?? ".output/firefox-mv3",
);
const signedFirefoxInstall = process.env.AWSM_FIREFOX_SIGNED_XPI !== undefined;
const firefoxExtensionId = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const serverOrigin = "http://127.0.0.1:3300";
const fixtureUrl = "http://127.0.0.1:4174/fixture";
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
async function firefoxRequest(driver, request) {
  const response = await driver.executeAsyncScript(
    `
      const [request, done] = arguments;
      browser.runtime.sendMessage(request).then(done, error => done({ thrown: String(error) }));
    `,
    request,
  );
  if (response.thrown !== void 0) throw new Error(response.thrown);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.value;
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
async function launchFirefox(profile) {
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  const geckodriverBinary = await downloadGeckodriver(
    browserConfiguration.geckodriver.version,
    resolve(packageRoot, ".output/firefox-browsers/geckodriver"),
  );
  const options = new firefox.Options()
    .setBinary(resolve(packageRoot, browserConfiguration.stable.executable))
    .addArguments("-headless")
    .setPreference("xpinstall.signatures.required", false);
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
  const signupUrl = popupUrl.replace(/popup\.html$/u, "signup.html");
  await driver.get(signupUrl);
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
async function captureInFirefox(driver, popupUrl, vaultId) {
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
  await driver.executeScript('document.title = "Firefox cross-browser capture";');
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
    await chromeRequest(chromeClient.popup, {
      type: "ConfigureSyncServer",
      serverOrigin,
    });
    await chromeRequest(chromeClient.popup, {
      type: "SignupAccount",
      email,
      password,
      recoveryAcknowledged: true,
      newVaultName: "Cross-browser Vault",
    });
    const chromeVaultId = await waitForChromeSync(chromeClient.popup);
    await configureFirefox(firefoxDriver, popupUrl);
    await firefoxRequest(firefoxDriver, {
      type: "LoginAccount",
      email,
      password,
    });
    const firefoxVaultId = await waitForFirefoxSync(firefoxDriver);
    expect(firefoxVaultId).toBe(chromeVaultId);
    const chromeLibrary = await chromeClient.context.newPage();
    await chromeLibrary.goto(`chrome-extension://${chromeClient.extensionId}/library.html`);
    const firefoxLibraryUrl = popupUrl.replace(/popup\.html$/u, "library.html");
    await firefoxDriver.get(firefoxLibraryUrl);
    await captureInChrome(chromeClient, chromeVaultId);
    await waitForChromeSync(chromeClient.popup);
    await firefoxDriver.wait(
      until.elementLocated(
        By.xpath("//*[contains(normalize-space(), 'Chrome cross-browser capture')]"),
      ),
      12e4,
    );
    await captureInFirefox(firefoxDriver, popupUrl, firefoxVaultId);
    await waitForFirefoxSync(firefoxDriver);
    await expect(chromeLibrary.getByText("Firefox cross-browser capture")).toBeVisible();
  } finally {
    await firefoxDriver.quit();
    await chromeClient.context.close();
  }
});
