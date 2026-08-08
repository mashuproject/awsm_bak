import { access, cp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  // This test opens popup.html directly instead of invoking the browser action; grant only its
  // loopback capture fixture origin in the copied test artifact.
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.host_permissions = ["http://127.0.0.1/*"];
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
  activePage?: Page,
): Promise<Page> {
  if (activePage !== undefined) await activePage.bringToFront();
  const page = await client.context.newPage();
  if (activePage !== undefined) await activePage.bringToFront();
  await page.setViewportSize({ width: 400, height: 700 });
  await page.goto(`chrome-extension://${client.extensionId}/popup.html`);
  if (activePage !== undefined) {
    await page.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              sendMessage(message: unknown, ...rest: unknown[]): unknown;
            };
            tabs: {
              query(
                value: unknown,
              ): Promise<readonly { id?: number; url?: string; active?: boolean }[]>;
              update(id: number, value: { active: true }): Promise<unknown>;
            };
          };
        }
      ).chrome;
      const tabs = await extensionApi.tabs.query({});
      const activeTab = tabs.find((tab) => tab.id !== undefined && tab.active);
      if (activeTab?.id === undefined) throw new Error("Active Capture fixture tab is missing.");
      await extensionApi.tabs.update(activeTab.id, { active: true });
    });
  }
  return page;
}

async function captureFixture(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Captured fixture</title><main>Stored locally.</main>");
  });
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Capture fixture did not bind TCP.");
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
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
  await expect(access(resolve(extensionBuildPath, "sync-setup.html"))).rejects.toThrow();
  const offscreenHtml = await readFile(resolve(extensionBuildPath, "offscreen.html"), "utf8");
  const offscreenScript = offscreenHtml.match(/<script[^>]+src="([^"?]+)"/u)?.[1];
  if (offscreenScript === undefined) throw new Error("Packaged offscreen script is missing.");
  const offscreenSource = await readFile(
    resolve(extensionBuildPath, offscreenScript.replace(/^\//u, "")),
    "utf8",
  );
  expect(offscreenSource).not.toContain("awsm:prepare-vault-export-download");
  expect(offscreenSource).not.toContain("awsm:prepare-mhtml-download");
  const client = await packagedCanonicalExtension(testInfo);
  const fixture = await captureFixture();
  try {
    const activePage = await client.context.newPage();
    await activePage.goto(fixture.url);
    const first = await popup(client, activePage);
    await expect(first.getByRole("heading", { name: "Create your local Vault" })).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await expect(first.locator(".canonical-popup__brand")).toBeInViewport();
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-create.png"),
    });

    await first.getByRole("button", { name: "Recover a Hosted Vault" }).click();
    await expect(first.getByRole("heading", { name: "Recover a Hosted Vault" })).toBeVisible();
    await expect(first.getByLabel("Hosted Replica address")).toBeVisible();
    await expect(first.getByLabel("Account username")).toBeVisible();
    await expect(first.getByLabel("Account password")).toBeVisible();
    await expect(first.getByLabel("Recovery Phrase")).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-hosted-recovery.png"),
    });
    await first.setViewportSize({ width: 360, height: 700 });
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-hosted-recovery-narrow.png"),
    });
    await first.getByLabel("Hosted Replica address").fill("http://sync.example.test/");
    await first.getByLabel("Account username").fill("archive_reader");
    await first.getByLabel("Account password").fill("correct horse battery staple");
    await first.getByLabel("Recovery Phrase").fill("twelve private words");
    await first.getByRole("button", { name: "Recover Hosted Vault" }).click();
    await expect(
      first.locator(".canonical-popup__status--error", {
        hasText: "Enter a canonical HTTPS Replica Host address.",
      }),
    ).toBeVisible();
    await expect(first.getByLabel("Account password")).toHaveValue("");
    await expect(first.getByLabel("Recovery Phrase")).toHaveValue("");
    await expectReadableContrast(first);
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-hosted-recovery-validation-error.png"),
    });
    await first.getByRole("button", { name: "Back to create Vault" }).click();
    await expect(first.getByRole("heading", { name: "Create your local Vault" })).toBeVisible();
    await first.setViewportSize({ width: 400, height: 700 });

    await first.getByLabel("Vault name").fill("Field Notes");
    await first.getByRole("button", { name: "Create Vault" }).click();
    await expect(first.getByRole("heading", { name: "Protect your Vault" })).toBeVisible();
    const recoveryPhrase = await first
      .getByRole("textbox", { name: "Recovery Phrase", exact: true })
      .inputValue();
    expect(recoveryPhrase).not.toHaveLength(0);
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-recovery.png"),
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

    const openLibrary = first.getByRole("button", { name: "Open Library" });
    await expect(openLibrary).toBeVisible();
    const libraryOpened = client.context.waitForEvent("page");
    await openLibrary.click();
    const library = await libraryOpened;
    await library.setViewportSize({ width: 1_024, height: 700 });
    await expect(library.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(library.getByText("Vault · Field Notes")).toBeVisible();
    await expect(library.getByText("Capture a page from the popup to add it here.")).toBeVisible();

    await activePage.bringToFront();
    await first.getByRole("button", { name: "Archive this page" }).click();
    await expect(first.getByRole("heading", { name: "Recent captures" })).toBeVisible();
    await expect(first.getByText("Captured fixture")).toBeVisible();
    await expect(library.getByLabel("Captures").getByText("Captured fixture")).toBeVisible();
    await expect(library.getByText("Available locally")).toBeVisible();

    await first.setViewportSize({ width: 360, height: 700 });
    await expect(first.getByRole("button", { name: "Archive this page" })).toBeVisible();
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-capture-narrow.png"),
    });

    const second = await popup(client);
    await expect(second.getByRole("heading", { name: "Archive this page" })).toBeVisible();
    await expect(second.getByText("Vault · Field Notes")).toBeVisible();

    await expectReadableContrast(library);
    await library.screenshot({ path: testInfo.outputPath("canonical-library.png") });
    await library.setViewportSize({ width: 360, height: 700 });
    await expect(library.getByLabel("Captures").getByText("Captured fixture")).toBeVisible();
    await expectReadableContrast(library);
    await library.screenshot({ path: testInfo.outputPath("canonical-library-narrow.png") });

    await first.setViewportSize({ width: 400, height: 700 });
    const vaultSettings = first.getByRole("button", { name: "Vault settings" });
    await expect(vaultSettings).toBeVisible();
    await vaultSettings.click();
    await expect(first.getByRole("heading", { name: "Vault settings" })).toBeVisible();
    await expect(first.getByText("Vault · Field Notes")).toBeVisible();
    await expect(first.getByRole("button", { name: "Change Recovery Phrase" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Fork this Vault" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Vacuum this Vault" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Close Vault" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Close Vault" })).toHaveCSS(
      "background-color",
      "rgb(169, 46, 34)",
    );
    await expect(first.getByRole("button", { name: "Connect Hosted Replica" })).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-settings.png"),
    });

    await first.getByRole("button", { name: "Connect Hosted Replica" }).click();
    await expect(first.getByRole("heading", { name: "Connect a Hosted Replica" })).toBeVisible();
    await expect(first.getByLabel("Hosted Replica address")).toBeVisible();
    await expect(first.getByLabel("Account username")).toBeVisible();
    await expect(first.getByLabel("Account password")).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-hosted-replica-setup.png"),
    });
    await first.getByLabel("Hosted Replica address").fill("http://sync.example.test/");
    await first.getByLabel("Account username").fill("archive_reader");
    await first.getByLabel("Account password").fill("correct horse battery staple");
    await first.getByRole("button", { name: "Connect Hosted Replica", exact: true }).click();
    await expect(
      first.locator(".canonical-popup__status--error", {
        hasText: "Enter a canonical HTTPS Replica Host address.",
      }),
    ).toBeVisible();
    await expectReadableContrast(first);
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-hosted-replica-validation-error.png"),
    });
    await first.getByRole("button", { name: "Cancel Hosted Replica setup" }).click();
    await expect(first.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await first.getByRole("button", { name: "Change Recovery Phrase" }).click();
    await expect(
      first.getByRole("heading", { name: "Replace your Recovery Phrase" }),
    ).toBeVisible();
    await expect(
      first.getByRole("textbox", { name: "New Recovery Phrase", exact: true }),
    ).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-recovery-replacement.png"),
    });
    await first.getByRole("button", { name: "Cancel Recovery Phrase replacement" }).click();
    await expect(first.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await first.getByRole("button", { name: "Fork this Vault" }).click();
    await expect(first.getByRole("heading", { name: "Fork this Vault" })).toBeVisible();
    await expect(
      first.getByRole("textbox", { name: "Recovery Phrase", exact: true }),
    ).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-fork.png"),
    });
    await first.getByRole("button", { name: "Cancel Vault fork" }).click();
    await expect(first.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await first.getByRole("button", { name: "Vacuum this Vault" }).click();
    await expect(first.getByRole("heading", { name: "Vacuum this Vault?" })).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-vacuum.png"),
    });
    await first.getByRole("button", { name: "Cancel Vacuum" }).click();
    await expect(first.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await first.getByRole("button", { name: "Close Vault" }).click();
    await expect(first.getByRole("heading", { name: "Close this Vault?" })).toBeVisible();
    await first.evaluate(() => window.scrollTo(0, 0));
    await expect(first.locator(".canonical-popup__brand")).toBeInViewport();
    expect(
      (await first.locator(".canonical-popup__brand").boundingBox())?.y,
    ).toBeGreaterThanOrEqual(0);
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.screenshot({
      path: testInfo.outputPath("canonical-popup-closure.png"),
    });
    await first.getByRole("button", { name: "Confirm closure" }).click();
    await expect(first.getByRole("heading", { name: "Vault is closed" })).toBeVisible();
    await expect(first.getByRole("button", { name: "Archive this page" })).toHaveCount(0);
    await expect(first.getByText("This Vault is closed.")).toBeVisible();
    await expect(first.getByRole("heading", { name: "Recent captures" })).toBeVisible();
    await expect(first.getByText("Captured fixture")).toBeVisible();
    await expect(first.getByRole("button", { name: "Vault settings" })).toBeVisible();
    await assertInteractiveTargets(first);
    await expectReadableContrast(first);
    await first.evaluate(() => window.scrollTo(0, 0));
    await expect(first.locator(".canonical-popup__brand")).toBeInViewport();
    await first.locator("main").screenshot({
      path: testInfo.outputPath("canonical-popup-closed.png"),
    });

    await library.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      for await (const [name] of root.entries()) names.push(name);
      await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
    });
    await library.setViewportSize({ width: 1_024, height: 700 });
    await library.reload();
    await expect(library.getByText("Not available locally")).toBeVisible();
    const retrieve = library.getByRole("button", { name: "Retrieve Capture" });
    await expect(retrieve).toBeVisible();
    await assertInteractiveTargets(library);
    await expectReadableContrast(library);
    await library.evaluate(() => window.scrollTo(0, 0));
    await library.screenshot({ path: testInfo.outputPath("canonical-library-unavailable.png") });
    await retrieve.click();
    await expect(
      library.locator(".canonical-library__status--error", {
        hasText: "No configured Replica Host could supply this Capture.",
      }),
    ).toBeVisible();
    await expect(retrieve).toBeEnabled();
    await expect(library.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expectReadableContrast(library);
    await library.evaluate(() => window.scrollTo(0, 0));
    await library.screenshot({
      path: testInfo.outputPath("canonical-library-unavailable-error.png"),
      fullPage: true,
    });
    await library.setViewportSize({ width: 360, height: 700 });
    await expect(retrieve).toBeVisible();
    await expectReadableContrast(library);
    await library.evaluate(() => window.scrollTo(0, 0));
    await library.screenshot({
      path: testInfo.outputPath("canonical-library-unavailable-narrow.png"),
    });
  } finally {
    await client.context.close();
    await fixture.close();
  }
});
