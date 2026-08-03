import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium, expect, type Page, type TestInfo, test } from "@playwright/test";

import { startEphemeralHttpsProxy } from "./https-proxy";

const extensionBuildPath = resolve(process.env.AWSM_EXTENSION_BUILD ?? ".output/chrome-mv3-e2e");
const proofOrigin = "http://127.0.0.1:3300/";

interface PackagedExtension {
  readonly context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
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
    ignoreHTTPSErrors: true,
    args: [
      "--ignore-certificate-errors",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  return { context, extensionId };
}

async function popup(client: PackagedExtension): Promise<Page> {
  const page = await client.context.newPage();
  await page.setViewportSize({ width: 400, height: 700 });
  await page.goto(`chrome-extension://${client.extensionId}/popup.html`);
  return page;
}

async function captureFixture(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Recovered capture</title><main>Fresh credential proof.</main>",
    );
  });
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Recovered capture fixture did not bind TCP.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      ),
  };
}

async function captureActivePage(popupPage: Page, activePage: Page): Promise<void> {
  await activePage.bringToFront();
  await popupPage.evaluate(async (activeUrl) => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: {
          runtime: { sendMessage(message: unknown, ...rest: unknown[]): unknown };
          tabs: {
            query(value: unknown): Promise<readonly { id?: number; url?: string }[]>;
            update(id: number, value: { active: true }): Promise<unknown>;
          };
        };
      }
    ).chrome;
    const tabs = await extensionApi.tabs.query({});
    const activeTab = tabs.find((tab) => tab.id !== undefined && tab.url === activeUrl);
    if (activeTab?.id === undefined) throw new Error("Recovered capture fixture tab is missing.");
    await extensionApi.tabs.update(activeTab.id, { active: true });
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
}

async function createHostAccount(): Promise<{
  readonly username: string;
  readonly password: string;
}> {
  const username = `recovery_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const password = `hosted recovery proof ${randomUUID()}`;
  const response = await fetch(new URL("sign_up", proofOrigin), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      "account[username]": username,
      "account[password]": password,
      "account[password_confirmation]": password,
    }),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return { username, password };
}

test("recovers a fresh local Client from a real opaque Hosted Replica without saving a Remote", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe("chromium");
  const proxy = await startEphemeralHttpsProxy({ origin: proofOrigin });
  const account = await createHostAccount();
  const owner = await packagedExtension(testInfo, "owner");
  const recovered = await packagedExtension(testInfo, "recovered");
  const fixture = await captureFixture();
  try {
    const ownerPopup = await popup(owner);
    await ownerPopup.getByLabel("Vault name").fill("Hosted recovery proof");
    await ownerPopup.getByRole("button", { name: "Create Vault" }).click();
    const phrase = await ownerPopup
      .getByRole("textbox", { name: "Recovery Phrase", exact: true })
      .inputValue();
    expect(phrase.trim()).not.toBe("");
    await ownerPopup.getByLabel("Type the Recovery Phrase to continue").fill(phrase);
    await ownerPopup.getByRole("button", { name: "Confirm Recovery Phrase" }).click();
    await expect(ownerPopup.getByRole("heading", { name: "Archive this page" })).toBeVisible();

    await ownerPopup.getByRole("button", { name: "Vault settings" }).click();
    await ownerPopup.getByRole("button", { name: "Connect Hosted Replica" }).click();
    await ownerPopup.getByLabel("Hosted Replica address").fill(proxy.endpoint);
    await ownerPopup.getByLabel("Connection name").fill("proof host");
    await ownerPopup.getByLabel("Account username").fill(account.username);
    await ownerPopup.getByLabel("Account password").fill(account.password);
    await ownerPopup.getByRole("button", { name: "Connect Hosted Replica", exact: true }).click();
    await expect(ownerPopup.getByRole("heading", { name: "Vault settings" })).toBeVisible();
    await expect(ownerPopup.getByText("proof host", { exact: true })).toBeVisible();
    await ownerPopup.getByRole("button", { name: "Store compact Vault state" }).click();
    await expect(ownerPopup.locator("#announcer")).toHaveText(
      "Compact Vault state stored. Large Capture artifacts remain on demand.",
    );
    await ownerPopup.getByRole("button", { name: "Rename Hosted Replica" }).click();
    await expect(ownerPopup.getByRole("heading", { name: "Rename Hosted Replica" })).toBeVisible();
    await ownerPopup.getByLabel("Connection name").fill("proof host renamed");
    await ownerPopup.getByRole("button", { name: "Save Remote name" }).click();
    await expect(ownerPopup.getByRole("heading", { name: "Vault settings" })).toBeVisible();
    await expect(ownerPopup.getByText("proof host renamed", { exact: true })).toBeVisible();
    const mirroredOwnerPopup = await popup(owner);
    await mirroredOwnerPopup.getByRole("button", { name: "Vault settings" }).click();
    await expect(mirroredOwnerPopup.getByText("proof host renamed", { exact: true })).toBeVisible();
    await ownerPopup.getByRole("button", { name: "Pause Remote" }).click();
    await expect(ownerPopup.getByText("Paused locally", { exact: true })).toBeVisible();
    await expect(mirroredOwnerPopup.getByText("Paused locally", { exact: true })).toBeVisible();
    await expect(ownerPopup.getByRole("button", { name: "Resume Remote" })).toBeVisible();
    await expect(ownerPopup.getByRole("button", { name: "Store compact Vault state" })).toHaveCount(
      0,
    );
    await expect(ownerPopup.locator("#announcer")).toHaveText(
      "Hosted Replica paused locally. It will not be contacted until resumed.",
    );
    await ownerPopup.getByRole("button", { name: "Resume Remote" }).click();
    await expect(ownerPopup.getByText("Available", { exact: true })).toBeVisible();

    const recoveredPopup = await popup(recovered);
    await recoveredPopup.getByRole("button", { name: "Recover a Hosted Vault" }).click();
    await recoveredPopup.getByLabel("Hosted Replica address").fill(proxy.endpoint);
    await recoveredPopup.getByLabel("Account username").fill(account.username);
    await recoveredPopup.getByLabel("Account password").fill(account.password);
    await recoveredPopup.getByLabel("Recovery Phrase").fill(phrase);
    await recoveredPopup.getByRole("button", { name: "Recover Hosted Vault" }).click();
    await expect(recoveredPopup.getByRole("heading", { name: "Archive this page" })).toBeVisible();
    await expect(recoveredPopup.getByText("Vault · Hosted recovery proof")).toBeVisible();
    await expect(recoveredPopup.getByLabel("Account password")).toHaveCount(0);
    await expect(recoveredPopup.getByLabel("Recovery Phrase")).toHaveCount(0);

    const activePage = await recovered.context.newPage();
    await activePage.goto(fixture.url);
    await captureActivePage(recoveredPopup, activePage);
    await recoveredPopup.getByRole("button", { name: "Archive this page" }).click();
    await expect(recoveredPopup.getByText("Recovered capture")).toBeVisible();

    await recoveredPopup.getByRole("button", { name: "Vault settings" }).click();
    await expect(
      recoveredPopup.getByText("No Hosted Replicas are configured on this Client."),
    ).toBeVisible();
  } finally {
    await Promise.all([owner.context.close(), recovered.context.close()]);
    await fixture.close();
    await proxy.close();
  }
});
