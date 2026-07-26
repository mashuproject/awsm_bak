import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../browser-extension/node_modules/@playwright/test/index.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const sourcePath = resolve(packageRoot, "assets/icons/keeper.svg");
const generatedRoot = resolve(packageRoot, "assets/icons/generated");
const extensionPublic = resolve(repositoryRoot, "apps/browser-extension/public");
const railsPublic = resolve(repositoryRoot, "apps/coordination-server/public");
const source = await readFile(sourcePath, "utf8");

await mkdir(generatedRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${source}`,
  );
  const mark = page.locator("svg");
  for (const size of [16, 32, 48, 128, 512]) {
    await page.setViewportSize({ width: size, height: size });
    const bytes = await mark.screenshot({ omitBackground: true });
    await Promise.all([
      writeFile(resolve(generatedRoot, `icon-${size}.png`), bytes),
      writeFile(resolve(extensionPublic, `icon-${size}.png`), bytes),
      ...(size === 512 ? [writeFile(resolve(railsPublic, "icon.png"), bytes)] : []),
    ]);
  }
  await writeFile(resolve(railsPublic, "icon.svg"), source);
} finally {
  await browser.close();
}
