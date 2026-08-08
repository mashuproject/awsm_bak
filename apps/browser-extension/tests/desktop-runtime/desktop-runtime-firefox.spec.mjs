import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { download as downloadGeckodriver } from "geckodriver";
import { By, until } from "selenium-webdriver";
import { Context, Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const RUNTIME_ROOT = resolve(REPOSITORY_ROOT, "apps/runtime-go");
const EXTENSION_PATH = resolve(
  PACKAGE_ROOT,
  process.env.AWSM_FIREFOX_EXTENSION_BUILD ?? ".output/firefox-mv3-e2e",
);
const DRIVER_CACHE = resolve(PACKAGE_ROOT, ".output/firefox-browsers/geckodriver");
const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const browserConfiguration = JSON.parse(
  await readFile(new URL("../firefox-feasibility/browsers.json", import.meta.url), "utf8"),
);

function spawnFixture(dataDirectory) {
  const child = spawn("go", ["run", "./cmd/e2e-fixture", "--data-dir", dataDirectory], {
    cwd: RUNTIME_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[runtime-fixture] ${chunk}`));
  const lines = [];
  const waiters = [];
  let closed = false;
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line === "") continue;
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter(line);
    }
  });
  const nextLine = () => {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (closed) return Promise.reject(new Error("Runtime fixture closed before responding."));
    return new Promise((resolveLine, rejectLine) => {
      waiters.push(resolveLine);
      child.once("close", () => rejectLine(new Error("Runtime fixture closed before responding.")));
    });
  };
  child.once("close", () => {
    closed = true;
  });
  return {
    child,
    async ready() {
      const value = JSON.parse(await nextLine());
      if (value.event !== "ready" || typeof value.address !== "string") {
        throw new Error("Runtime fixture did not report readiness.");
      }
      return value;
    },
    async command(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
      return JSON.parse(await nextLine());
    },
    async close() {
      if (!closed) {
        await this.command({ command: "shutdown" });
      }
      if (!closed) await once(child, "close");
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
    .addArguments("-headless")
    .setPreference("xpinstall.signatures.required", false);
  const service = new ServiceBuilder(geckodriverBinary)
    .addArguments("--allow-system-access")
    .build();
  return Driver.createSession(options, service);
}

async function installExtension(driver, testInfo) {
  const extensionPath = testInfo.outputPath("desktop-runtime-firefox-extension");
  await cp(EXTENSION_PATH, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // The permission prompt has a unit-tested seam. Pre-grant loopback in this
  // browser proof so it exercises the real pairing transport deterministically.
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  expect(await driver.installAddon(extensionPath, true)).toBe(FIREFOX_EXTENSION_ID);
}

async function extensionUrls(driver) {
  await driver.setContext(Context.CHROME);
  const popupUrl = await driver.executeScript(
    "return WebExtensionPolicy.getByID(arguments[0]).getURL('popup.html');",
    FIREFOX_EXTENSION_ID,
  );
  await driver.setContext(Context.CONTENT);
  return { popupUrl };
}

async function createVault(driver) {
  await driver.wait(
    until.elementLocated(By.xpath("//h1[normalize-space()='Create your local Vault']")),
    20_000,
  );
  await driver.findElement(By.id("awsm-vault-name")).sendKeys("Firefox Desktop Runtime");
  await driver.findElement(By.xpath("//button[normalize-space()='Create Vault']")).click();
  await driver.wait(
    until.elementLocated(By.xpath("//h1[normalize-space()='Protect your Vault']")),
    20_000,
  );
  const phraseField = await driver.findElement(By.id("awsm-recovery-phrase"));
  const recoveryPhrase = await driver.executeScript("return arguments[0].value;", phraseField);
  await driver
    .findElement(By.id("awsm-type-the-recovery-phrase-to-continue"))
    .sendKeys(recoveryPhrase);
  await driver
    .findElement(By.xpath("//button[normalize-space()='Confirm Recovery Phrase']"))
    .click();
  await driver.wait(
    until.elementLocated(By.xpath("//h1[normalize-space()='Archive this page']")),
    20_000,
  );
}

async function assertEncryptedGrantState(driver) {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const request = indexedDB.open("awsm");
    request.onerror = () => done({ error: String(request.error) });
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("installation_state", "readonly")
        .objectStore("installation_state").getAll();
      read.onerror = () => done({ error: String(read.error) });
      read.onsuccess = () => {
        const seen = new Set();
        const containsString = (value) => {
          if (typeof value === "string") return true;
          if (value === null || typeof value !== "object" || value instanceof Uint8Array || seen.has(value)) return false;
          seen.add(value);
          return Object.values(value).some(containsString);
        };
        done({ containsString: read.result.some(containsString) });
      };
    };
  `);
  expect(result.error).toBeUndefined();
  expect(result.containsString).toBe(false);
}

const lanes = process.env.AWSM_FIREFOX_LANE ? [process.env.AWSM_FIREFOX_LANE] : ["stable", "esr"];

for (const lane of lanes) {
  test(`pairs the extension with the Runtime and recovers revocation in Firefox ${lane}`, async ({
    browser: _browser,
  }, testInfo) => {
    const dataDirectory = await mkdtemp(resolve(REPOSITORY_ROOT, ".tmp-runtime-firefox-e2e-"));
    const fixture = spawnFixture(dataDirectory);
    const driver = await createDriver(lane);
    try {
      await fixture.ready();
      await installExtension(driver, testInfo);
      const { popupUrl } = await extensionUrls(driver);
      await driver.get(popupUrl);
      await createVault(driver);
      await driver.findElement(By.xpath("//button[normalize-space()='Vault settings']")).click();
      await driver.wait(
        until.elementLocated(By.xpath("//h2[normalize-space()='Desktop Runtime']")),
        20_000,
      );
      const approval = fixture.command({ command: "approve-next" });
      await driver
        .findElement(By.xpath("//button[normalize-space()='Connect Desktop Runtime']"))
        .click();
      await expect(approval).resolves.toMatchObject({ ok: true });
      await driver.wait(
        until.elementLocated(
          By.xpath("//*[contains(normalize-space(.), 'Connected · runtime.vault')]"),
        ),
        20_000,
      );
      await assertEncryptedGrantState(driver);

      await expect(fixture.command({ command: "revoke-all" })).resolves.toMatchObject({ ok: true });
      await driver.get(popupUrl);
      await driver
        .wait(
          until.elementLocated(By.xpath("//button[normalize-space()='Vault settings']")),
          20_000,
        )
        .then((button) => button.click());
      await driver.wait(
        until.elementLocated(
          By.xpath("//*[normalize-space()='Desktop Runtime access was revoked.']"),
        ),
        20_000,
      );
    } finally {
      await driver.quit();
      await fixture.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
}
