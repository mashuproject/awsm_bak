import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

import { expectReadableContrast } from "./contrast-audit";

const extensionBuildPath = resolve(process.env.AWSM_EXTENSION_BUILD ?? ".output/chrome-mv3-e2e");

interface PackagedExtension {
  readonly context: BrowserContext;
  readonly extensionId: string;
}

async function packagedExtension(testInfo: TestInfo): Promise<PackagedExtension> {
  const extensionPath = testInfo.outputPath("canonical-surfaces-extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath("canonical-surfaces-profile"),
    {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    },
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  return { context, extensionId };
}

async function extensionPage(
  client: PackagedExtension,
  path: string,
  viewport = { width: 400, height: 700 },
): Promise<Page> {
  const page = await client.context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${client.extensionId}/${path}`);
  return page;
}

async function assertInteractiveTargets(page: Page): Promise<void> {
  const controls = page.locator(
    'button:visible, a[href]:visible, input:visible, textarea:visible, select:visible, [tabindex="0"]:visible',
  );
  await expect
    .poll(async () => {
      const sizes = await controls.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
      return sizes.length > 0 && sizes.every(({ width, height }) => width >= 24 && height >= 24);
    })
    .toBe(true);
}

test("renders the canonical local-Vault and Library surfaces", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe("chromium");
  const client = await packagedExtension(testInfo);
  try {
    const popup = await extensionPage(client, "popup.html");
    await expect(popup.getByRole("heading", { name: "Create your local Vault" })).toBeVisible();
    await expect(
      popup.getByText("It stays private to this Client unless you later connect a Replica Host."),
    ).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-first-use.png", { fullPage: true });

    await popup.getByRole("button", { name: "Recover a Hosted Vault" }).click();
    await expect(popup.getByRole("heading", { name: "Recover a Hosted Vault" })).toBeVisible();
    await expect(popup.getByLabel("Hosted Replica address")).toBeVisible();
    await expect(popup.getByLabel("Account username")).toBeVisible();
    await expect(popup.getByLabel("Account password")).toBeVisible();
    await expect(popup.getByLabel("Recovery Phrase")).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-recovery.png", { fullPage: true });
    await popup.setViewportSize({ width: 360, height: 700 });
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-recovery-narrow.png", { fullPage: true });
    await popup.getByRole("button", { name: "Back to create Vault" }).click();
    await expect(popup.getByRole("heading", { name: "Create your local Vault" })).toBeVisible();
    await popup.setViewportSize({ width: 400, height: 700 });

    await popup.getByLabel("Vault name").fill("Field Notes");
    await popup.getByRole("button", { name: "Create Vault" }).click();
    await expect(popup.getByRole("heading", { name: "Protect your Vault" })).toBeVisible();
    const phrase = popup.getByRole("textbox", { name: "Recovery Phrase", exact: true });
    const recoveryPhrase = await phrase.inputValue();
    expect(recoveryPhrase.trim()).not.toBe("");
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-recovery-phrase.png", {
      fullPage: true,
      mask: [phrase],
    });

    await popup.getByLabel("Type the Recovery Phrase to continue").fill(recoveryPhrase);
    await popup.getByRole("button", { name: "Confirm Recovery Phrase" }).click();
    await expect(popup.getByRole("heading", { name: "Archive this page" })).toBeVisible();
    await expect(popup.getByText("Vault · Field Notes")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Open Library" })).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-local-ready.png", { fullPage: true });

    await popup.getByRole("button", { name: "Vault settings" }).click();
    await expect(popup.getByRole("heading", { name: "Vault settings" })).toBeVisible();
    await expect(
      popup.getByText("Your Host Account does not grant access to its contents."),
    ).toBeVisible();
    await expect(popup.getByRole("button", { name: "Vacuum this Vault" })).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-vault-settings.png", { fullPage: true });

    await popup.getByRole("button", { name: "Connect Hosted Replica" }).click();
    await expect(popup.getByRole("heading", { name: "Connect a Hosted Replica" })).toBeVisible();
    await expect(popup.getByLabel("Hosted Replica address")).toBeVisible();
    await expect(popup.getByLabel("Account username")).toBeVisible();
    await expect(popup.getByLabel("Account password")).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-setup.png", { fullPage: true });
    await popup.getByRole("button", { name: "Cancel Hosted Replica setup" }).click();
    await expect(popup.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    const library = await extensionPage(client, "library.html", { width: 1280, height: 900 });
    await expect(library.getByRole("heading", { name: "Library" })).toBeVisible();
    await expect(library.getByText("Vault · Field Notes")).toBeVisible();
    await expect(library.getByRole("heading", { name: "Captures" })).toBeVisible();
    await expect(library.getByText("Capture a page from the popup to add it here.")).toBeVisible();
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-empty-wide.png", { fullPage: true });

    await library.setViewportSize({ width: 390, height: 844 });
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-empty-narrow.png", { fullPage: true });
  } finally {
    await client.context.close();
  }
});
