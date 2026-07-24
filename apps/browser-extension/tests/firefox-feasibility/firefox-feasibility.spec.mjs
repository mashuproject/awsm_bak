import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { download as downloadGeckodriver } from "geckodriver";
import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION_DIRECTORY = resolve(PACKAGE_ROOT, ".output/firefox-feasibility/firefox-mv3");
const DRIVER_CACHE = resolve(PACKAGE_ROOT, ".output/firefox-browsers/geckodriver");
const DOWNLOAD_ROOT = resolve(PACKAGE_ROOT, ".output/firefox-feasibility-downloads");
const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const browserConfiguration = JSON.parse(
  await readFile(new URL("./browsers.json", import.meta.url), "utf8"),
);

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("The fixture server did not expose a TCP port.");
    }
    return address.port;
  });
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function startFixtures() {
  let crossOriginRequests = 0;
  const crossOriginServer = createServer((_request, response) => {
    crossOriginRequests += 1;
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
    });
    response.end("cross-origin body must not be acquired");
  });
  const crossOriginPort = await listen(crossOriginServer);

  const pageServer = createServer((request, response) => {
    if (request.url === "/authenticated") {
      if (request.headers.cookie !== "awsm-firefox-gate=present") {
        response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        response.end("missing fixture cookie");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("authenticated fixture");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "awsm-firefox-gate=present; Path=/; SameSite=Lax",
    });
    response.end(`<!doctype html>
      <html>
        <head><title>AWSM deterministic Firefox fixture</title></head>
        <body>
          <main id="fixture">initial markup</main>
          <input id="live-input" value="initial input">
          <textarea id="live-textarea">initial textarea</textarea>
          <select id="live-select">
            <option value="first">First</option>
            <option value="second">Second</option>
          </select>
          <input id="live-check" type="checkbox">
          <script>
            document.querySelector("#fixture").textContent = "rendered-after-load";
            document.querySelector("#live-input").value = "live input";
            document.querySelector("#live-textarea").value = "live textarea";
            document.querySelector("#live-select").value = "second";
            document.querySelector("#live-check").checked = true;
          </script>
        </body>
      </html>`);
  });
  const pagePort = await listen(pageServer);
  const pageUrl = new URL(`http://127.0.0.1:${pagePort}/`);
  pageUrl.searchParams.set("crossOrigin", `http://127.0.0.1:${crossOriginPort}/resource`);

  return {
    pageUrl: pageUrl.href,
    getCrossOriginRequests: () => crossOriginRequests,
    async stop() {
      await Promise.all([close(pageServer), close(crossOriginServer)]);
    },
  };
}

async function createDriver(lane) {
  const configuration = browserConfiguration[lane];
  const browserBinary = resolve(PACKAGE_ROOT, configuration.executable);
  const downloadDirectory = resolve(DOWNLOAD_ROOT, lane);
  await rm(downloadDirectory, { recursive: true, force: true });
  await mkdir(downloadDirectory, { recursive: true });
  const geckodriverBinary = await downloadGeckodriver(
    browserConfiguration.geckodriver.version,
    DRIVER_CACHE,
  );

  const options = new firefox.Options()
    .setBinary(browserBinary)
    .addArguments("-headless")
    .setPreference("browser.download.folderList", 2)
    .setPreference("browser.download.dir", downloadDirectory)
    .setPreference("browser.download.useDownloadDir", true)
    .setPreference("browser.download.alwaysOpenPanel", false)
    .setPreference("browser.helperApps.neverAsk.saveToDisk", "text/plain")
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

async function clickExtensionAction(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const reportUrl = await driver.executeScript(
      "return WebExtensionPolicy.getByID(arguments[0]).getURL('report.html');",
      FIREFOX_EXTENSION_ID,
    );
    const action = await driver.wait(
      until.elementLocated(
        By.css(
          `[data-extensionid="${FIREFOX_EXTENSION_ID}"] .unified-extensions-item-action-button`,
        ),
      ),
      10_000,
    );
    await action.click();
    return reportUrl;
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function terminateBackground(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeAsyncScript(
      `
        const done = arguments[arguments.length - 1];
        const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
        const before = extension.backgroundState;
        extension
          .terminateBackground({
            ignoreDevToolsAttached: true,
            disableResetIdleForTest: true,
          })
          .then(() => done({ before, after: extension.backgroundState }))
          .catch(error => done({ error: String(error) }));
      `,
      FIREFOX_EXTENSION_ID,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function extensionProcessId(driver) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(
      "return WebExtensionPolicy.getByID(arguments[0]).extension.parentMessageManager?.osPid;",
      FIREFOX_EXTENSION_ID,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function processProportionalBytes(pid) {
  const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
  const proportionalKiB = Number(/^Pss:\s+(\d+)\s+kB$/mu.exec(rollup)?.[1]);
  if (!Number.isFinite(proportionalKiB)) {
    throw new Error(`Could not read proportional-set memory for process ${pid}.`);
  }
  return proportionalKiB * 1024;
}

async function runMemoryProof(driver, extensionPid) {
  const warmup = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    browser.runtime
      .sendMessage({
        type: "awsm:run-firefox-bounded-memory-proof",
        sourceBytes: 2 * 1024 * 1024,
      })
      .then(done)
      .catch(error => done({ error: String(error) }));
  `);
  if (warmup.error) throw new Error(`Bounded-memory warmup failed: ${warmup.error}`);
  const baseline = await processProportionalBytes(extensionPid);
  let settled = false;
  const operation = driver
    .executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.runtime
        .sendMessage({ type: "awsm:run-firefox-bounded-memory-proof" })
        .then(done)
        .catch(error => done({ error: String(error) }));
    `)
    .finally(() => {
      settled = true;
    });
  let peak = baseline;
  while (!settled) {
    peak = Math.max(peak, await processProportionalBytes(extensionPid));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const result = await operation;
  peak = Math.max(peak, await processProportionalBytes(extensionPid));
  return { baseline, peak, growth: peak - baseline, result };
}

for (const lane of ["stable", "esr"]) {
  test(`passes retained Firefox Host feasibility assertions in ${lane}`, async () => {
    const configuration = browserConfiguration[lane];
    const manifest = JSON.parse(
      await readFile(resolve(EXTENSION_DIRECTORY, "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      manifest_version: 3,
      permissions: ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"],
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_EXTENSION_ID,
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["none"] },
        },
      },
      background: { scripts: ["background.js"] },
    });
    expect(manifest).not.toHaveProperty("minimum_chrome_version");
    expect(manifest.permissions).not.toContain("pageCapture");
    expect(manifest.permissions).not.toContain("offscreen");
    expect(manifest.background).not.toHaveProperty("service_worker");

    const fixtures = await startFixtures();
    const driver = await createDriver(lane);
    try {
      const capabilities = await driver.getCapabilities();
      expect(capabilities.get("browserVersion")).toBe(configuration.webdriverVersion);
      const installedId = await driver.installAddon(EXTENSION_DIRECTORY, true);
      expect(installedId).toBe(FIREFOX_EXTENSION_ID);

      await driver.get(fixtures.pageUrl);
      await driver.wait(until.titleIs("AWSM deterministic Firefox fixture"), 10_000);
      const reportUrl = await clickExtensionAction(driver);

      try {
        await driver.wait(async () => (await driver.getAllWindowHandles()).length > 1, 10_000);
      } catch {
        await driver.switchTo().newWindow("tab");
        await driver.get(reportUrl);
      }
      const handles = await driver.getAllWindowHandles();
      await driver.switchTo().window(handles.at(-1));
      const reportElement = await driver.wait(
        until.elementLocated(By.css("#report[data-ready='true']")),
        20_000,
      );
      const report = JSON.parse(await reportElement.getText());

      expect(report.error).toBeUndefined();
      expect(report.extensionId).toBe(FIREFOX_EXTENSION_ID);
      expect(report.startupCount).toBeGreaterThanOrEqual(1);
      expect(report.assertions).toEqual({
        collectorRenderedDom: true,
        collectorLiveFormState: true,
        sameOriginAuthenticatedGet: true,
        crossOriginBlocked: true,
        opfsAvailable: true,
        zipStreamed: true,
        screenshotStitched: true,
        downloadObserved: true,
        successCleanup: true,
        failureCleanup: true,
      });
      expect(fixtures.getCrossOriginRequests()).toBe(0);

      const extensionPid = await extensionProcessId(driver);
      expect(typeof extensionPid).toBe("number");
      const memory = await runMemoryProof(driver, extensionPid);
      expect(memory.result.error).toBeUndefined();
      expect(memory.result.sourceBytes).toBe(144 * 1024 * 1024);
      expect(memory.result.archiveBytes).toBeGreaterThan(memory.result.sourceBytes);
      expect(memory.result.cleaned).toBe(true);
      expect(memory.growth).toBeLessThan(memory.result.sourceBytes + 96 * 1024 * 1024);
      expect(memory.growth).toBeLessThan(memory.result.sourceBytes + memory.result.archiveBytes);

      const lifecycle = await terminateBackground(driver);
      expect(lifecycle).toEqual({ before: "running", after: "stopped" });
      await driver.navigate().refresh();
      const resumedReportElement = await driver.wait(
        until.elementLocated(By.css("#report[data-ready='true']")),
        20_000,
      );
      const resumedReport = JSON.parse(await resumedReportElement.getText());
      expect(resumedReport.startupCount).toBeGreaterThan(report.startupCount);
    } finally {
      await driver.quit();
      await fixtures.stop();
    }
  });
}
