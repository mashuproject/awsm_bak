import { randomUUID } from "node:crypto";
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
import { startEphemeralHttpsProxy } from "../hosted-recovery/https-proxy";
import { expectReadableContrast } from "./contrast-audit";

const extensionBuildPath = resolve(process.env.AWSM_EXTENSION_BUILD ?? ".output/chrome-mv3-e2e");
const proofOrigin = "http://127.0.0.1:3300/";

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
      ignoreHTTPSErrors: true,
      args: [
        "--ignore-certificate-errors",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  return { context, extensionId };
}

async function createHostAccount(): Promise<{
  readonly username: string;
  readonly password: string;
}> {
  const username = `design_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const password = `design hosted replica ${randomUUID()}`;
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
      return sizes.length > 0 && sizes.every(({ width, height }) => width >= 44 && height >= 44);
    })
    .toBe(true);
}

test("renders the canonical local-Vault and Library surfaces", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe("chromium");
  const proxy = await startEphemeralHttpsProxy({ origin: proofOrigin });
  const account = await createHostAccount();
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

    await popup.getByRole("button", { name: "Use existing Hosted Replica" }).click();
    await expect(
      popup.getByRole("heading", { name: "Use an existing Hosted Replica" }),
    ).toBeVisible();
    await expect(popup.getByLabel("Hosted Replica address")).toBeVisible();
    await expect(popup.getByLabel("Connection name")).toBeVisible();
    await expect(popup.getByLabel("Account username")).toBeVisible();
    await expect(popup.getByLabel("Account password")).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-attachment.png", { fullPage: true });
    await popup.setViewportSize({ width: 360, height: 700 });
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-attachment-narrow.png", {
      fullPage: true,
    });
    await popup.setViewportSize({ width: 400, height: 700 });
    await popup.getByRole("button", { name: "Cancel existing Hosted Replica" }).click();
    await expect(popup.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await popup.getByRole("button", { name: "Connect Hosted Replica" }).click();
    await popup.getByLabel("Hosted Replica address").fill(proxy.endpoint);
    await popup.getByLabel("Connection name").fill("Design archive");
    await popup.getByLabel("Account username").fill(account.username);
    await popup.getByLabel("Account password").fill(account.password);
    await popup.getByRole("button", { name: "Connect Hosted Replica", exact: true }).click();
    await expect(popup.getByRole("heading", { name: "Vault settings" })).toBeVisible();
    await expect(popup.getByText("Design archive", { exact: true })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Rename Hosted Replica" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Pause Remote" })).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-management.png", {
      fullPage: true,
      mask: [popup.getByText(proxy.endpoint, { exact: true })],
    });

    await popup.getByRole("button", { name: "Use existing Hosted Replica" }).click();
    await popup.getByLabel("Hosted Replica address").fill(proxy.endpoint);
    await popup.getByLabel("Connection name").fill("Recovered design archive");
    await popup.getByLabel("Account username").fill(account.username);
    await popup.getByLabel("Account password").fill(account.password);
    await popup.getByRole("button", { name: "Show existing Hosted Replicas" }).click();
    await expect(popup.getByRole("heading", { name: "Choose a Hosted Replica" })).toBeVisible();
    await expect(popup.getByRole("button", { name: /^Use Hosted Replica/ })).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    const replicaOption = popup.getByRole("button", { name: /^Use Hosted Replica/ });
    await expect(replicaOption).toBeVisible();
    await expect(popup).toHaveScreenshot("popup-hosted-replica-selection.png", {
      fullPage: true,
      mask: [replicaOption],
    });
    await popup.setViewportSize({ width: 360, height: 700 });
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-selection-narrow.png", {
      fullPage: true,
      mask: [replicaOption],
    });
    await popup.setViewportSize({ width: 400, height: 700 });
    await popup.getByRole("button", { name: "Cancel Hosted Replica selection" }).click();
    await expect(popup.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await popup.getByRole("button", { name: "Remove Remote from this Client" }).click();
    await expect(
      popup.getByRole("heading", { name: "Remove Hosted Replica from this Client" }),
    ).toBeVisible();
    await expect(
      popup.getByText(
        "This only removes this Client’s local connection. It does not contact the Replica Host or delete its stored bytes.",
      ),
    ).toBeVisible();
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-retirement.png", { fullPage: true });
    await popup.setViewportSize({ width: 360, height: 700 });
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-retirement-narrow.png", {
      fullPage: true,
    });
    await popup.setViewportSize({ width: 400, height: 700 });
    await popup.getByRole("button", { name: "Cancel Remote removal" }).click();
    await expect(popup.getByRole("heading", { name: "Vault settings" })).toBeVisible();

    await popup.getByRole("button", { name: "Rename Hosted Replica" }).click();
    await expect(popup.getByRole("heading", { name: "Rename Hosted Replica" })).toBeVisible();
    await expect(popup.getByLabel("Connection name")).toHaveValue("Design archive");
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-rename.png", { fullPage: true });
    await popup.setViewportSize({ width: 360, height: 700 });
    await assertInteractiveTargets(popup);
    await expectReadableContrast(popup);
    await expect(popup).toHaveScreenshot("popup-hosted-replica-rename-narrow.png", {
      fullPage: true,
    });
    await popup.setViewportSize({ width: 400, height: 700 });
    await popup.getByRole("button", { name: "Cancel Remote rename" }).click();
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
    await Promise.all([client.context.close(), proxy.close()]);
  }
});
