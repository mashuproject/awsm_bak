import { expect, test } from "@playwright/test";

import { expectReadableContrast } from "./contrast-audit";

const localOrigin = "http://127.0.0.1:3300";

test("renders the complete landing at desktop, narrow, and reduced motion", async ({
  browser,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Keep what matters. Even when the web moves on.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Install AWSM" }).first()).toHaveCSS(
    "min-height",
    "44px",
  );
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-desktop.png", {
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toContainText("Privacy");
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-narrow-menu.png", {
    fullPage: true,
  });

  const reduced = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  await reduced.goto(localOrigin);
  await expect(reduced.locator(".hero-art__keeper")).toHaveCSS("animation-duration", "0s");
  await expectReadableContrast(reduced);
  await expect(reduced).toHaveScreenshot("landing-reduced-motion.png", {
    fullPage: true,
  });
  await reduced.close();
});

test("keeps installation guidance complete with and without JavaScript", async ({
  browser,
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/#install-awsm");
  await page.getByRole("tab", { name: "Firefox" }).click();
  await expect(page.locator("#firefox-install")).toContainText(
    /temporary development installation/iu,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("install-firefox.png", {
    fullPage: true,
  });
  await page.getByText("Can the Coordination Server read a Vault?").click();
  await page.getByText("Account password or Recovery Phrase?").click();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-expanded-trust-faq.png", {
    fullPage: true,
  });

  const noJavaScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJavaScript.newPage();
  await staticPage.goto(`${localOrigin}/`);
  await expect(staticPage.getByText("Chrome and Chromium browsers")).toBeVisible();
  await expect(staticPage.getByRole("heading", { name: "Firefox" })).toBeVisible();
  await expect(staticPage.getByText("Account password or Recovery Phrase?")).toBeVisible();
  await noJavaScript.close();
});

test("renders trust, Account, validation, and design-reference surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [path, heading, screenshot] of [
    ["/privacy", "What stays local. What a server can see.", "privacy.png"],
    ["/security", "The server coordinates. The client holds the keys.", "security.png"],
    ["/session/new", "Sign in", "sign-in.png"],
    ["/design-system", "AWSM Bright Utility Kit", "design-system.png"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectReadableContrast(page);
    await expect(page).toHaveScreenshot(screenshot, { fullPage: true });
  }

  await page.goto("/sign_up");
  await expect(page.getByRole("heading", { name: "Create your Account" })).toBeVisible();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("sign-up-resting.png", {
    fullPage: true,
  });
  await page.getByLabel("Email").fill("reader@example.test");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password").fill("different");
  await page.getByRole("button", { name: "Create Account" }).click();
  const errorSummary = page
    .getByRole("alert")
    .filter({ hasText: "Check the highlighted details." });
  await expect(errorSummary).toBeVisible();
  await expect(errorSummary).toBeFocused();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("sign-up-validation.png", {
    fullPage: true,
  });

  const accountPassword = "design system account password";
  await page.getByLabel("Password", { exact: true }).fill(accountPassword);
  await page.getByLabel("Confirm password").fill(accountPassword);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Your Account" })).toBeVisible();
  await page.locator("time").evaluate((node) => {
    node.textContent = "Preview account";
  });
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("account.png", { fullPage: true });

  await page.getByRole("link", { name: "Change password" }).click();
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("password-change.png", {
    fullPage: true,
  });

  await page.goto("/");
  await expect(page.getByText("Signed in as")).toBeVisible();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-signed-in.png", {
    fullPage: true,
  });
});
