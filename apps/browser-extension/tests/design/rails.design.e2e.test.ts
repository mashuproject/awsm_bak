import { expect, test } from "@playwright/test";

import { expectReadableContrast } from "./contrast-audit";

const localOrigin = "http://127.0.0.1:3300";

test("renders the complete landing at desktop, narrow, and reduced motion", async ({
  browser,
  page,
}) => {
  let sessionStatusRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/session/status") sessionStatusRequests += 1;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  expect(sessionStatusRequests).toBe(0);
  await expect(
    page.getByRole("heading", {
      name: "Archive what should matter.",
      exact: true,
    }),
  ).toBeVisible();
  const getAwsm = page.getByRole("link", { name: "Get AWSM" }).first();
  await expect(getAwsm).toHaveCSS("min-height", "44px");
  await getAwsm.hover();
  await expect(getAwsm).toHaveCSS("translate", "-2px -2px");
  await expect(getAwsm).toHaveScreenshot("get-awsm-hover.png");
  await page.mouse.down();
  await expect(getAwsm).toHaveCSS("translate", "3px 3px");
  await expect(getAwsm).toHaveScreenshot("get-awsm-pressed.png");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.evaluate(() => window.scrollTo(0, 0));
  await getAwsm.focus();
  await expect(getAwsm).toHaveCSS("outline-width", "3px");
  await expect(getAwsm).toHaveScreenshot("get-awsm-focus.png");
  await page.locator('a[href="#how-it-works"]').click();
  await expect
    .poll(async () => {
      const stickyHeaderBottom = await page.locator(".site-header").evaluate((element) => {
        return element.getBoundingClientRect().bottom;
      });
      const sectionTop = await page.locator("#how-it-works").evaluate((element) => {
        return element.getBoundingClientRect().top;
      });
      return sectionTop >= stickyHeaderBottom && sectionTop < stickyHeaderBottom + 32;
    })
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("h1").hover();
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
  const reducedGetAwsm = reduced.getByRole("link", { name: "Get AWSM" }).first();
  await reducedGetAwsm.hover();
  await expect(reducedGetAwsm).toHaveCSS("translate", "0px");
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
  await expect(page.getByText("What can the Coordination Server see?")).toBeVisible();
  await expect(
    page.getByText("Why do I need both an Account password and a Recovery Phrase?"),
  ).toBeVisible();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-expanded-trust-faq.png", {
    fullPage: true,
  });

  const noJavaScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJavaScript.newPage();
  await staticPage.goto(`${localOrigin}/`);
  await expect(staticPage.getByText("Chrome and Chromium browsers")).toBeVisible();
  await expect(staticPage.getByRole("heading", { name: "Firefox" })).toBeVisible();
  await expect(
    staticPage.getByText("Why do I need both an Account password and a Recovery Phrase?"),
  ).toBeVisible();
  await noJavaScript.close();
});

test("renders trust, Account, validation, and design-reference surfaces", async ({ page }) => {
  let sessionStatusRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/session/status") sessionStatusRequests += 1;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [path, heading, screenshot] of [
    ["/privacy", "What stays local. What a server can see.", "privacy.png"],
    ["/security", "The server coordinates. The client holds the keys.", "security.png"],
    ["/glossary", "The language of your archive.", "glossary.png"],
    ["/session/new", "Sign in", "sign-in.png"],
    ["/design-system", "AWSM Bright Utility Kit", "design-system.png"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectReadableContrast(page);
    await expect(page).toHaveScreenshot(screenshot, { fullPage: true });
  }

  await page.goto("/glossary");
  await page.locator('.glossary-index a[href="#complete-export"]').hover();
  await expect(page.locator("#complete-export")).toHaveCSS(
    "background-color",
    "rgb(244, 235, 216)",
  );
  await page.mouse.move(0, 0);
  await expect(page.locator("#complete-export")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.goto("/");
  await page.locator('a.term-link[href="/glossary#complete-export"]').click();
  await expect(page).toHaveURL(/\/glossary#complete-export$/);
  await expect
    .poll(async () => {
      const stickyHeaderBottom = await page.locator(".site-header").evaluate((element) => {
        return element.getBoundingClientRect().bottom;
      });
      const definitionTop = await page.locator("#complete-export").evaluate((element) => {
        return element.getBoundingClientRect().top;
      });
      return definitionTop > stickyHeaderBottom && definitionTop < stickyHeaderBottom + 64;
    })
    .toBe(true);
  await expect(page.locator("#complete-export")).toHaveCSS(
    "background-color",
    "rgb(255, 240, 184)",
  );

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
  await expect(page.getByText("reader@example.test")).toBeVisible();
  await expect(page.getByRole("link", { name: "Account for reader@example.test" })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Set up sync" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(sessionStatusRequests).toBe(1);

  await page.getByRole("link", { name: "Privacy" }).first().click();
  await expect(
    page.getByRole("heading", {
      name: "What stays local. What a server can see.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Account for reader@example.test" })).toHaveCount(2);
  expect(sessionStatusRequests).toBe(1);

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-signed-in.png", {
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toContainText("Account");
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-signed-in-narrow-menu.png", {
    fullPage: true,
  });

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(2);
  await expect(page.getByText("Signed in as")).toBeHidden();
});

test("renders a non-personal loading shell before private session status resolves", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "awsm_browser_session_hint",
      value: "loading-shell-hint",
      url: localOrigin,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  let resolveStatus: (() => void) | undefined;
  const statusReady = new Promise<void>((resolve) => {
    resolveStatus = resolve;
  });
  await page.route("**/session/status", async (route) => {
    await statusReady;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"authenticated":false}',
    });
  });

  await page.goto("/");
  const banner = page.locator('[data-public-session-target="banner"]');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Signed in as")).toBeHidden();
  await expectReadableContrast(page);
  await expect(page).toHaveScreenshot("landing-session-loading.png", {
    fullPage: true,
  });

  resolveStatus?.();
  await expect(banner).toBeHidden();
  await context.close();
});

test("fails closed when the public session hint is stale or status is unavailable", async ({
  browser,
}) => {
  for (const responseKind of ["unauthenticated", "server-error", "malformed"] as const) {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "awsm_browser_session_hint",
        value: `hint-${responseKind}`,
        url: localOrigin,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    if (responseKind === "server-error") {
      await page.route("**/session/status", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: "{}",
        }),
      );
    } else if (responseKind === "malformed") {
      await page.route("**/session/status", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"authenticated":true,"account":{"email":"<img src=x>"}}',
        }),
      );
    }

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(2);
    await expect(page.getByText("Signed in as")).toBeHidden();
    await expect.poll(() => browserErrors).toEqual([]);
    if (responseKind === "server-error") {
      await expectReadableContrast(page);
      await expect(page).toHaveScreenshot("landing-session-failure.png", {
        fullPage: true,
      });
    }

    if (responseKind === "unauthenticated") {
      await expect
        .poll(async () => {
          return (await context.cookies()).some(
            (cookie) => cookie.name === "awsm_browser_session_hint",
          );
        })
        .toBe(false);
    }

    await context.close();
  }
});
