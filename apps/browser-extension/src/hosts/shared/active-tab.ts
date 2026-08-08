import { browser } from "wxt/browser";

export async function getActiveCaptureTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}
