import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, type Page, type TestInfo, test } from "@playwright/test";

import { expectReadableContrast } from "../design/contrast-audit";

const extensionBuildPath = resolve(
  process.env.AWSM_CANONICAL_EXTENSION_BUILD ?? ".output/canonical-surface/chrome-mv3",
);

async function packagedCanonicalExtension(testInfo: TestInfo): Promise<{
  readonly context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  readonly extensionId: string;
}> {
  const extensionPath = testInfo.outputPath("canonical-extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(testInfo.outputPath("canonical-profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  return { context, extensionId };
}

async function popup(
  client: Awaited<ReturnType<typeof packagedCanonicalExtension>>,
): Promise<Page> {
  const page = await client.context.newPage();
  await page.setViewportSize({ width: 400, height: 700 });
  await page.goto(`chrome-extension://${client.extensionId}/popup.html`);
  return page;
}

async function assertInteractiveTargets(page: Page): Promise<void> {
  const controls = page.locator(
    'button:visible, input:visible, textarea:visible, [tabindex="0"]:visible',
  );
  await expect
    .poll(async () => {
      const dimensions = await controls.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
      return (
        dimensions.length > 0 &&
        dimensions.every(({ width, height }) => width >= 44 && height >= 44)
      );
    })
    .toBe(true);
}

test("runs the canonical local Vault ceremony through a packaged extension", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  expect(browserName).toBe("chromium");
  const client = await packagedCanonicalExtension(testInfo);
  try {
    const first = await popup(client);
    await expect(first.getByRole("heading", { name: "Create your local Vault" })).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-create.png"),
      fullPage: true,
    });

    await first.getByLabel("Vault name").fill("Field Notes");
    await first.getByRole("button", { name: "Create Vault" }).click();
    await expect(first.getByRole("heading", { name: "Protect your Vault" })).toBeVisible();
    const recoveryPhrase = await first
      .getByRole("textbox", { name: "Recovery Phrase", exact: true })
      .inputValue();
    expect(recoveryPhrase).not.toHaveLength(0);
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-recovery.png"),
      fullPage: true,
    });

    await first.getByLabel("Type the Recovery Phrase to continue").fill(recoveryPhrase);
    await first.getByRole("button", { name: "Confirm Recovery Phrase" }).click();
    await expect(first.getByRole("heading", { name: "Archive this page" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Archive this page" })).toBeEnabled();
    const announcerBox = await first.locator("#announcer").boundingBox();
    expect(announcerBox?.width).toBeLessThanOrEqual(1);
    expect(announcerBox?.height).toBeLessThanOrEqual(1);
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);

    await first.setViewportSize({ width: 360, height: 700 });
    await expect(first.getByRole("button", { name: "Archive this page" })).toBeVisible();
    await expectReadableContrast(first);
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-capture-narrow.png"),
      fullPage: true,
    });

    const second = await popup(client);
    await expect(second.getByRole("heading", { name: "Archive this page" })).toBeVisible();
    await expect(second.getByText("Vault · Field Notes")).toBeVisible();
  } finally {
    await client.context.close();
  }
});
