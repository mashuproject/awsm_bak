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

async function packagedExtension(testInfo: TestInfo, name: string): Promise<PackagedExtension> {
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

async function popupForActiveTab(client: PackagedExtension, activePage?: Page): Promise<Page> {
  if (activePage !== undefined) await activePage.bringToFront();
  const popup = await extensionPage(client, "popup.html");
  if (activePage !== undefined) {
    await popup.evaluate(async (activeUrl) => {
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
      const activeTab = tabs.find((tab) => tab.id !== undefined && tab.url === activeUrl);
      if (activeTab?.id === undefined) throw new Error("Active fixture tab missing.");
      await extensionApi.tabs.update(activeTab.id, { active: true });
      const nativeQuery = extensionApi.tabs.query.bind(extensionApi.tabs);
      extensionApi.tabs.query = async (query: unknown) =>
        typeof query === "object" && query !== null && "active" in query && query.active === true
          ? [activeTab]
          : nativeQuery(query);
      const nativeSendMessage = extensionApi.runtime.sendMessage.bind(extensionApi.runtime);
      extensionApi.runtime.sendMessage = (message: unknown, ...rest: unknown[]) =>
        nativeSendMessage(
          typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "CaptureActivePage"
            ? { ...message, tabId: activeTab.id }
            : message,
          ...rest,
        );
    }, activePage.url());
    await popup.reload();
  }
  return popup;
}

async function appRequest<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    (request) =>
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
        extensionApi.runtime.sendMessage(request, (response) => {
          if (response?.ok && response.value !== undefined) resolveValue(response.value);
          else reject(new Error(JSON.stringify(response?.error ?? response)));
        });
      }),
    message,
  );
}

async function createLocalVault(popup: Page): Promise<void> {
  await popup.getByRole("button", { name: "Continue without sync" }).click();
  await popup.getByLabel("Vault name").fill("Field Notes");
  await popup.getByRole("button", { name: "Create Vault" }).click();
  await expect(popup.getByRole("button", { name: "Archive this page" })).toBeVisible();
}

async function assertInteractiveTargets(page: Page): Promise<void> {
  const controls = page.locator(
    'button:visible, a[href]:visible, input:visible, select:visible, summary:visible, [tabindex="0"]:visible',
  );
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box, `interactive target ${index} has no rendered box`).not.toBeNull();
    expect(box?.width, `interactive target ${index} is too narrow`).toBeGreaterThanOrEqual(24);
    expect(box?.height, `interactive target ${index} is too short`).toBeGreaterThanOrEqual(24);
  }
}

test("renders packaged popup and Library design states", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  const client = await packagedExtension(testInfo, "product-surfaces");
  try {
    const popup = await popupForActiveTab(client);
    await expect(popup.getByRole("heading", { name: "Choose how AWSM starts" })).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-first-use.png", {
      fullPage: true,
    });

    await createLocalVault(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-local-ready.png", {
      fullPage: true,
    });

    const library = await extensionPage(client, "library.html", {
      width: 1280,
      height: 900,
    });
    await expect(library.getByRole("heading", { name: "Field Notes" })).toBeVisible();
    await expect(library.locator("#sidebar-vault-name")).toHaveText("Field Notes");
    await expect(
      library.locator(
        "#manage-vaults, #show-archive, #show-deleted, #storage-settings, #account-settings",
      ),
    ).toHaveText([
      "Manage or switch Vault",
      "Library",
      "Deleted",
      "Storage & maintenance",
      "Account & synchronization",
    ]);
    const storageBox = await library.locator("#storage-settings").boundingBox();
    const accountBox = await library.locator("#account-settings").boundingBox();
    expect(storageBox).not.toBeNull();
    expect(accountBox).not.toBeNull();
    expect(accountBox?.x).toBe(storageBox?.x);
    expect((accountBox?.x ?? 0) + (accountBox?.width ?? 0)).toBeLessThanOrEqual(224);
    expect(accountBox?.y).toBeGreaterThan((storageBox?.y ?? 0) + (storageBox?.height ?? 0));
    await assertInteractiveTargets(library);
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-empty-wide-shell.png", {
      animations: "allow",
      fullPage: true,
    });

    await library.getByRole("button", { name: "Settings" }).click();
    await expect(library.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-settings-wide.png", {
      fullPage: true,
    });
    await library.keyboard.press("Escape");

    await library.setViewportSize({ width: 390, height: 844 });
    const menu = library.getByRole("button", { name: "Menu", exact: true });
    await menu.click();
    await expect(library.getByRole("button", { name: "Close menu" })).toBeFocused();
    await expect(library.getByRole("complementary", { name: "Library sections" })).toBeVisible();
    await assertInteractiveTargets(library);
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-empty-narrow-drawer.png", {
      fullPage: true,
    });
    await library.keyboard.press("Escape");
    await expect(menu).toBeFocused();

    const fixture = await client.context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    const capturePopup = await popupForActiveTab(client, fixture);
    await expect(capturePopup.getByRole("button", { name: "Archive this page" })).toBeVisible();
    await expectReadableContrast(capturePopup);
    await expect(capturePopup).toHaveScreenshot("popup-current-page-ready.png", {
      fullPage: true,
    });
    await capturePopup
      .getByRole("button", { name: "Archive this page" })
      .click({ noWaitAfter: true });
    await expect(capturePopup.getByRole("progressbar")).toBeVisible();
    await expectReadableContrast(capturePopup);
    await expect(capturePopup).toHaveScreenshot("popup-capture-working.png", {
      fullPage: true,
    });
    await expect(capturePopup.getByRole("link", { name: /Open in library:/u })).toBeVisible({
      timeout: 60_000,
    });
    await expectReadableContrast(capturePopup);
    await expect(capturePopup).toHaveScreenshot("popup-capture-success.png", {
      fullPage: true,
    });

    await library.setViewportSize({ width: 1280, height: 900 });
    await library.reload();
    await expect(library.locator(".library-card")).toHaveCount(1);
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-populated-grid.png", {
      fullPage: true,
    });
    await library.getByLabel("Sort archive").selectOption("TitleAscending");
    await library.getByRole("button", { name: "Compact list" }).click();
    await expect(library.locator(".library-row")).toHaveCount(1);
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-compact-title-list.png", {
      fullPage: true,
    });
    await library.locator(".library-row").click();
    await expect(library.getByRole("heading", { name: "AWSM tall fixture" })).toBeVisible();
    await expectReadableContrast(library);
    await expect(library).toHaveScreenshot("library-collection-history.png", {
      fullPage: true,
    });
  } finally {
    await client.context.close();
  }
});

test("renders every synchronization setup step in the packaged extension", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(300_000);
  expect(browserName).toBe("chromium");
  const client = await packagedExtension(testInfo, "synchronization-steps");
  const email = "design-system@example.test";
  const password = "correct horse design battery";
  try {
    const setup = await extensionPage(client, "sync-setup.html", {
      width: 1100,
      height: 900,
    });
    await expect(setup.getByRole("heading", { name: "Set up synchronization" })).toBeVisible();
    await expectReadableContrast(setup);
    await expect(setup).toHaveScreenshot("sync-server-step.png", {
      fullPage: true,
    });
    await setup.getByText("Use a self-hosted server").click();
    await setup.getByLabel("Self-hosted server origin").fill("http://127.0.0.1:3300");
    await setup.getByRole("button", { name: "Use self-hosted server" }).click();
    await expect(setup.getByRole("button", { name: "Log in" })).toBeVisible();
    await expectReadableContrast(setup);
    await expect(setup).toHaveScreenshot("sync-account-step.png", {
      fullPage: true,
    });

    const registration = await client.context.newPage();
    await registration.goto("http://127.0.0.1:3300/sign_up");
    await registration.getByLabel("Email").fill(email);
    await registration.getByLabel("Password", { exact: true }).fill(password);
    await registration.getByLabel("Confirm password").fill(password);
    await registration.getByRole("button", { name: "Create Account" }).click();
    await expect(registration.getByRole("heading", { name: "Your Account" })).toBeVisible();

    await setup.getByLabel("Email").fill(email);
    await setup.getByLabel("Password").fill(password);
    await setup.getByRole("button", { name: "Log in" }).click();
    await expect(setup.getByRole("button", { name: "Continue to Recovery Phrase" })).toBeVisible();
    await setup.getByLabel("Vault name").fill("Synchronized Field Notes");
    await expectReadableContrast(setup);
    await expect(setup).toHaveScreenshot("sync-vault-step.png", {
      fullPage: true,
    });
    await setup.getByRole("button", { name: "Continue to Recovery Phrase" }).click();
    const recoveryPhrase = setup.locator("output#recovery-phrase");
    await expect(recoveryPhrase).not.toHaveText("");
    const phrase = await recoveryPhrase.textContent();
    expect(phrase).not.toBeNull();
    await expectReadableContrast(setup);
    await expect(setup).toHaveScreenshot("sync-recovery-step.png", {
      fullPage: true,
      mask: [recoveryPhrase],
    });
    await setup
      .locator("#recovery-confirmation-form")
      .getByLabel("Enter all 12 words again")
      .fill(phrase ?? "");
    await setup.getByRole("button", { name: "Confirm and start synchronization" }).click();
    await expect
      .poll(
        async () => {
          const current = await appRequest<{
            workspace: { activeVaultId?: string };
            account: { vaultSyncState: string };
          }>(setup, { type: "GetState" });
          return {
            hasVault: current.workspace.activeVaultId !== undefined,
            synchronization: current.account.vaultSyncState,
          };
        },
        { timeout: 120_000 },
      )
      .toEqual({ hasVault: true, synchronization: "UpToDate" });
    await expect(setup.getByRole("heading", { name: "Your Devices" })).toBeVisible({
      timeout: 15_000,
    });
    await expectReadableContrast(setup);
    await expect(setup).toHaveScreenshot("sync-complete-dashboard.png", {
      fullPage: true,
    });
    await assertInteractiveTargets(setup);

    const state = await appRequest<{
      workspace: { activeVaultId?: string };
      account: { vaultSyncState: string };
    }>(setup, { type: "GetState" });
    expect(state.workspace.activeVaultId).toBeDefined();
    expect(state.account.vaultSyncState).toBe("UpToDate");
  } finally {
    await client.context.close();
  }
});
