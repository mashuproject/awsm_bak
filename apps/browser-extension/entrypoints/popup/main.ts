import { browser } from "wxt/browser";
import { AppClientError, sendRequest } from "../../src/app/client";
import type { AppState } from "../../src/app/protocol";
import { navigateFromPopup } from "../../src/ui/popup-navigation";
import { popupView } from "../../src/ui/popup-view";
import {
  RECENT_CAPTURE_DURATION_MS,
  recentCaptureTimerProgress,
} from "../../src/ui/recent-capture-timer";
import { requestSynchronizationPermission } from "../../src/ui/synchronization-permission";

function requiredElement(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error("Popup shell is incomplete.");
  return node;
}

const app = requiredElement("#app");
const announcer = requiredElement("#announcer");
const popupLifetime = browser.runtime.connect({ name: "awsm:popup-lifetime" });
let visibleRecentCaptureJobId: string | undefined;
let renderedState: AppState | undefined;
let suggestedVaultName: string | undefined;
let captureRequestPending = false;
let activePageContext: { readonly title: string; readonly host: string } | undefined;
let recentTimerInterval: number | undefined;
let recentTimerState:
  | {
      readonly jobId: string;
      readonly startedAt: number;
      pausedAt: number | undefined;
      pausedTotalMs: number;
      hovered: boolean;
      focused: boolean;
    }
  | undefined;

function expectedVaultId(): string {
  const vaultId = renderedState?.workspace.activeVaultId;
  if (vaultId === undefined) throw new Error("No active Vault is selected.");
  return vaultId;
}

function dismissSeenCapture(jobId: string): Promise<AppState> {
  if (visibleRecentCaptureJobId === jobId) visibleRecentCaptureJobId = undefined;
  popupLifetime.postMessage({ vaultId: expectedVaultId(), jobId: null });
  return sendRequest<AppState>({
    type: "DismissRecentCapture",
    expectedVaultId: expectedVaultId(),
    jobId,
  });
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function request(type: "GetState" | "WakeSynchronization" | "UnlockDevice"): Promise<AppState> {
  return type === "GetState" || type === "WakeSynchronization"
    ? sendRequest<AppState>({ type })
    : sendRequest<AppState>({ type, expectedVaultId: expectedVaultId() });
}

function errorText(error: unknown): string {
  return error instanceof AppClientError ? error.message : "The operation could not be completed.";
}

function heading(subtitle: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const brand = element("div", undefined, "popup-brand");
  const mark = element("img") as HTMLImageElement;
  mark.src = browser.runtime.getURL("/icon-48.png");
  mark.alt = "";
  mark.setAttribute("aria-hidden", "true");
  brand.append(mark, element("p", "AWSM", "eyebrow"));
  fragment.append(brand, element("h1", subtitle));
  return fragment;
}

function status(
  message: string,
  kind: "info" | "success" | "warning" | "error" = "info",
): HTMLElement {
  const node = element("p", message, `status status--${kind}`);
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  return node;
}

async function regenerateVaultName(input?: HTMLInputElement): Promise<void> {
  const suggestion = await sendRequest<{ readonly name: string }>({
    type: "SuggestVaultName",
  });
  suggestedVaultName = suggestion.name;
  if (input !== undefined) {
    input.value = suggestion.name;
    input.focus();
    input.select();
  }
}

function createVaultForm(state: AppState, secondary: boolean): HTMLFormElement {
  const form = element("form");
  const nameLabel = element("label", "Vault name");
  const name = element("input");
  name.name = "vault-name";
  name.required = true;
  name.maxLength = 64;
  name.value = suggestedVaultName ?? "";
  nameLabel.append(name);
  const regenerate = element("button", "Generate another name");
  regenerate.type = "button";
  regenerate.addEventListener("click", () => {
    regenerate.disabled = true;
    void regenerateVaultName(name).finally(() => {
      regenerate.disabled = false;
    });
  });
  const actions = element("div", undefined, "actions");
  const submit = element("button", "Create Vault", "primary");
  submit.type = "submit";
  actions.append(submit);
  if (secondary) {
    const cancel = element("button", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => form.closest("dialog")?.close());
    actions.append(cancel);
  }
  form.append(nameLabel, regenerate, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    void sendRequest<AppState>({
      type: "CreateVault",
      name: name.value,
      ...(state.workspace.activeVaultId === undefined
        ? {}
        : { expectedActiveVaultId: state.workspace.activeVaultId }),
    }).then(
      (next) => {
        suggestedVaultName = undefined;
        form.closest("dialog")?.close();
        announcer.textContent = `Created and selected ${name.value}`;
        render(next);
      },
      (cause) => refresh(errorText(cause)),
    );
  });
  return form;
}

async function refresh(error?: string): Promise<void> {
  try {
    const [state, tabs] = await Promise.all([
      request("GetState"),
      browser.tabs.query({ active: true, currentWindow: true }).catch(() => []),
    ]);
    const tab = tabs[0];
    try {
      const url = tab?.url === undefined ? undefined : new URL(tab.url);
      activePageContext =
        tab?.title !== undefined && url !== undefined && ["http:", "https:"].includes(url.protocol)
          ? { title: tab.title, host: url.host }
          : undefined;
    } catch {
      activePageContext = undefined;
    }
    render(state, error);
  } catch (cause) {
    app.replaceChildren(heading("Local archive"), status(errorText(cause), "error"));
    app.setAttribute("aria-busy", "false");
  }
}

function render(state: AppState, transientError?: string): void {
  if (recentTimerInterval !== undefined) window.clearInterval(recentTimerInterval);
  recentTimerInterval = undefined;
  renderedState = state;
  const view = popupView(state);
  if (view.screen !== "ready" || view.recentCapture === undefined) recentTimerState = undefined;
  visibleRecentCaptureJobId = view.screen === "ready" ? view.recentCapture?.jobId : undefined;
  popupLifetime.postMessage({
    vaultId: state.workspace.activeVaultId ?? null,
    jobId: visibleRecentCaptureJobId ?? null,
  });
  const content = document.createDocumentFragment();
  content.append(
    heading(
      view.screen === "server-choice"
        ? "Archive what should matter"
        : view.screen === "permission-required"
          ? "Allow synchronization"
          : view.screen === "login"
            ? "Sign in"
            : view.screen === "account-setup"
              ? "Finish setup"
              : view.screen === "stale-replica"
                ? "Resolve stale Vault"
                : view.screen === "onboarding"
                  ? "Create your local Vault"
                  : "Archive this page",
    ),
  );
  const activeVault = state.workspace.vaults.find((vault) => vault.active);
  if (activeVault !== undefined)
    content.append(element("p", `Vault · ${activeVault.name}`, "vault-context"));
  if (view.screen === "ready" && activePageContext !== undefined) {
    const pageContext = element("div", undefined, "page-context");
    pageContext.append(
      element("strong", activePageContext.title),
      element("span", activePageContext.host),
    );
    content.append(pageContext);
  }
  if (transientError !== undefined) content.append(status(transientError, "error"));

  if (view.screen === "server-choice") {
    content.append(
      element(
        "p",
        "Start with a local archive on this device. Synchronization is optional; if you enable it, Vault content stays end-to-end encrypted.",
      ),
    );
    const localOnly = element("button", "Continue without sync", "primary");
    localOnly.type = "button";
    localOnly.addEventListener("click", () => {
      localOnly.disabled = true;
      void sendRequest<AppState>({ type: "ChooseLocalOnly" }).then(render, (cause) =>
        refresh(errorText(cause)),
      );
    });
    const setup = element("a", "Set up synchronization");
    setup.href = browser.runtime.getURL("/sync-setup.html");
    setup.target = "_blank";
    setup.addEventListener("click", (event) => {
      event.preventDefault();
      void browser.tabs.create({ url: setup.href });
    });
    const actions = element("div", undefined, "actions onboarding-actions");
    actions.append(
      localOnly,
      setup,
      element("p", `Hosted service · ${view.hostedOrigin}`, "muted"),
    );
    content.append(actions);
  } else if (view.screen === "permission-required") {
    content.append(
      element(
        "p",
        `Firefox permission is required before AWSM can exchange encrypted data with ${view.serverOrigin}. Local Vault features remain available.`,
      ),
    );
    const allow = element("button", "Allow synchronization", "primary");
    allow.type = "button";
    allow.addEventListener("click", () => {
      allow.disabled = true;
      void requestSynchronizationPermission(view.serverOrigin).then(
        (granted) =>
          granted
            ? sendRequest<AppState>({ type: "WakeSynchronization" }).then(render)
            : refresh("Synchronization permission was not granted."),
        (cause) => refresh(errorText(cause)),
      );
    });
    content.append(allow);
  } else if (view.screen === "login") {
    content.append(element("p", `Sign in to synchronize through ${view.serverOrigin}.`));
    const login = element("form");
    const emailLabel = element("label", "Email");
    const email = element("input");
    email.type = "email";
    email.name = "email";
    email.autocomplete = "email";
    email.required = true;
    emailLabel.append(email);
    const passwordLabel = element("label", "Password");
    const password = element("input");
    password.type = "password";
    password.name = "password";
    password.autocomplete = "current-password";
    password.required = true;
    passwordLabel.append(password);
    const signIn = element("button", "Sign in", "primary");
    signIn.type = "submit";
    login.append(emailLabel, passwordLabel, signIn);
    login.addEventListener("submit", (event) => {
      event.preventDefault();
      signIn.disabled = true;
      const pending = sendRequest<AppState>({
        type: "LoginAccount",
        email: email.value,
        password: password.value,
      });
      password.value = "";
      void pending.then(render, (cause) => refresh(errorText(cause)));
    });
    content.append(login);
    const configuration = state.account.configuration;
    if (configuration.mode === "Configured" && configuration.registration.enabled) {
      const createAccount = element("a", "Create account on this server");
      createAccount.href = configuration.registration.signUpUrl;
      createAccount.target = "_blank";
      createAccount.rel = "noreferrer";
      createAccount.addEventListener("click", (event) => {
        event.preventDefault();
        void browser.tabs.create({ url: createAccount.href });
      });
      content.append(createAccount);
    }
  } else if (view.screen === "account-setup") {
    content.append(element("p", "Choose which local Vault this Account should synchronize."));
    const finish = element("a", "Finish Account setup");
    finish.href = browser.runtime.getURL("/sync-setup.html");
    finish.target = "_blank";
    finish.addEventListener("click", (event) => {
      event.preventDefault();
      void browser.tabs.create({ url: finish.href });
    });
    content.append(finish);
  } else if (view.screen === "stale-replica") {
    content.append(
      status(
        "This device has unpublished work from an older Vault Generation. It remains readable, but changes are paused to avoid restoring content removed by Vacuum.",
        "warning",
      ),
    );
    const resolve = element("a", "Review and discard stale local Replica");
    resolve.href = `${browser.runtime.getURL("/library.html")}?resolveStale=1`;
    resolve.target = "_blank";
    resolve.addEventListener("click", (event) => {
      event.preventDefault();
      void browser.tabs.create({ url: resolve.href });
    });
    content.append(resolve);
  } else if (view.screen === "onboarding") {
    content.append(
      element("p", "Your captures are encrypted locally. No account or server is required."),
    );
    if (suggestedVaultName === undefined) {
      content.append(status("Generating a Vault name…"));
      void regenerateVaultName().then(
        () => render(state),
        (cause) => refresh(errorText(cause)),
      );
    } else {
      content.append(createVaultForm(state, false));
      const importExisting = element("a", "Import existing Vault");
      importExisting.href = `${browser.runtime.getURL("/library.html")}?import=1`;
      importExisting.target = "_blank";
      importExisting.addEventListener("click", (event) => {
        event.preventDefault();
        void browser.tabs.create({ url: importExisting.href });
      });
      content.append(importExisting);
    }
  } else if (view.screen === "locked") {
    content.append(element("p", "Unlock the Vault before capturing or opening the library."));
    const device = element("button", "Unlock on this device", "primary");
    device.addEventListener("click", () => {
      device.disabled = true;
      void request("UnlockDevice").then(
        (next) => render(next),
        (cause) => refresh(errorText(cause)),
      );
    });
    content.append(device);
  } else if (view.screen === "capturing") {
    content.append(status(`Capturing: ${view.stage}…`));
    announcer.textContent = `Capture stage ${view.stage}`;
    window.setTimeout(() => void refresh(), 500);
  } else {
    if (view.recentCapture !== undefined) {
      const recentCapture = view.recentCapture;
      const cardGroup = element("div", undefined, "recent-capture-group");
      const card = element("a", undefined, "recent-capture");
      card.href = `${browser.runtime.getURL("/library.html")}?vaultId=${encodeURIComponent(recentCapture.vaultId)}&bundleId=${encodeURIComponent(recentCapture.bundleId)}`;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.setAttribute("aria-label", `Open in library: ${recentCapture.title}`);
      card.addEventListener("click", (event) => {
        event.preventDefault();
        navigateFromPopup({
          open: () => browser.tabs.create({ url: card.href }),
          dismiss: () => dismissSeenCapture(recentCapture.jobId),
        });
      });
      const title = element("p", undefined, "recent-capture__title");
      title.append(document.createTextNode("Archived: "), element("strong", recentCapture.title));
      const action = element("span", "Open in library", "recent-capture__action");
      const progress = element("div", undefined, "recent-capture__progress");
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", "Time until recent capture preview closes");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", String(RECENT_CAPTURE_DURATION_MS));
      card.append(title);
      if (recentCapture.screenshotBase64 !== undefined) {
        const thumbnail = element("img", undefined, "recent-capture__thumbnail");
        thumbnail.src = `data:image/webp;base64,${recentCapture.screenshotBase64}`;
        thumbnail.alt = `Screenshot thumbnail for ${recentCapture.title}`;
        card.append(thumbnail);
      }
      if (recentCapture.warnings.length > 0) {
        card.append(status("The full-page screenshot was unavailable.", "warning"));
      }
      card.append(action);
      cardGroup.append(card, progress);
      content.append(
        cardGroup,
        status(
          "Captured pages preserve filled form values. File contents are not included.",
          "success",
        ),
      );
      if (recentTimerState?.jobId !== recentCapture.jobId) {
        recentTimerState = {
          jobId: recentCapture.jobId,
          startedAt: performance.now(),
          pausedAt: undefined,
          pausedTotalMs: 0,
          hovered: false,
          focused: false,
        };
      }
      const setPaused = (kind: "hovered" | "focused", paused: boolean): void => {
        const timer = recentTimerState;
        if (timer === undefined || timer.jobId !== recentCapture.jobId) return;
        timer[kind] = paused;
        const shouldPause = timer.hovered || timer.focused;
        if (shouldPause && timer.pausedAt === undefined) timer.pausedAt = performance.now();
        else if (!shouldPause && timer.pausedAt !== undefined) {
          timer.pausedTotalMs += performance.now() - timer.pausedAt;
          timer.pausedAt = undefined;
        }
      };
      cardGroup.addEventListener("mouseenter", () => setPaused("hovered", true));
      cardGroup.addEventListener("mouseleave", () => setPaused("hovered", false));
      cardGroup.addEventListener("focusin", () => setPaused("focused", true));
      cardGroup.addEventListener("focusout", (event) => {
        if (!(event.relatedTarget instanceof Node) || !cardGroup.contains(event.relatedTarget))
          setPaused("focused", false);
      });
      const updateTimer = (): void => {
        const timer = recentTimerState;
        if (timer === undefined || timer.jobId !== recentCapture.jobId) return;
        const now = performance.now();
        const pausedMs = timer.pausedAt === undefined ? 0 : now - timer.pausedAt;
        const state = recentCaptureTimerProgress({
          elapsedMs: now - timer.startedAt - timer.pausedTotalMs - pausedMs,
          paused: timer.pausedAt !== undefined,
        });
        progress.style.setProperty("--recent-progress", String(state.ratio));
        progress.setAttribute("aria-valuenow", String(state.elapsedMs));
        progress.setAttribute(
          "aria-valuetext",
          `${timer.pausedAt === undefined ? "" : "Paused, "}${Math.ceil(state.remainingMs / 1_000)} seconds remaining`,
        );
        if (!state.expired) return;
        if (recentTimerInterval !== undefined) window.clearInterval(recentTimerInterval);
        recentTimerInterval = undefined;
        recentTimerState = undefined;
        void dismissSeenCapture(recentCapture.jobId).then(
          (next) => render(next),
          (cause) => refresh(errorText(cause)),
        );
      };
      updateTimer();
      recentTimerInterval = window.setInterval(updateTimer, 100);
    } else if (view.notice === "capture-succeeded") {
      content.append(
        status(
          "Page archived in your Vault. Captured pages preserve filled form values. File contents are not included.",
          "success",
        ),
      );
    } else if (view.notice === "screenshot-warning") {
      content.append(
        status(
          "Page archived. The full-page screenshot was unavailable. Captured pages preserve filled form values. File contents are not included.",
          "warning",
        ),
      );
    } else if (view.notice !== undefined) {
      content.append(status(`Capture failed (${view.notice}). Retry when ready.`, "error"));
    }
    const capture = element("button", "Archive this page", "primary");
    capture.disabled = captureRequestPending;
    capture.addEventListener("click", () => {
      capture.disabled = true;
      captureRequestPending = true;
      announcer.textContent = "Capture started";
      render(state);
      void browser.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) =>
          sendRequest<{ readonly bundleId: string }>({
            type: "CaptureActivePage",
            expectedVaultId: expectedVaultId(),
            ...(tab?.id === undefined ? {} : { tabId: tab.id }),
          }),
        )
        .then(
          () => {
            captureRequestPending = false;
            return refresh();
          },
          (cause) => {
            captureRequestPending = false;
            return refresh(errorText(cause));
          },
        );
      void refresh();
    });
    const library = element("a", "Open library");
    library.href = browser.runtime.getURL("/library.html");
    library.target = "_blank";
    library.addEventListener("click", (event) => {
      event.preventDefault();
      const open = (): Promise<unknown> => browser.tabs.create({ url: library.href });
      if (view.recentCapture === undefined) {
        void open();
        return;
      }
      const jobId = view.recentCapture.jobId;
      navigateFromPopup({
        open,
        dismiss: () => dismissSeenCapture(jobId),
      });
    });
    const settings = element("a", "Settings");
    settings.href = `${browser.runtime.getURL("/library.html")}?settings=1`;
    settings.target = "_blank";
    settings.addEventListener("click", (event) => {
      event.preventDefault();
      void browser.tabs.create({ url: settings.href });
    });
    const actions = element("div", undefined, "actions");
    const secondary = element("div", undefined, "popup-secondary-actions");
    secondary.append(library, settings);
    actions.append(capture, secondary);
    content.append(actions);
  }
  app.replaceChildren(content);
  app.setAttribute("aria-busy", "false");
  if (view.screen === "ready" && view.recentCapture !== undefined) window.scrollTo(0, 0);
}

let refreshRequested = false;
let refreshRunning = false;

function reconcile(): void {
  refreshRequested = true;
  if (refreshRunning) return;
  refreshRunning = true;
  void (async () => {
    while (refreshRequested) {
      refreshRequested = false;
      await refresh();
    }
  })().finally(() => {
    refreshRunning = false;
    if (refreshRequested) reconcile();
  });
}

function wakeSynchronization(): void {
  void request("WakeSynchronization").catch(() => undefined);
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "AppStateChanged"
  ) {
    announcer.textContent = "Vault state updated";
    reconcile();
  }
  return undefined;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    wakeSynchronization();
    reconcile();
  }
});
window.addEventListener("focus", () => {
  wakeSynchronization();
  reconcile();
});
window.addEventListener("online", wakeSynchronization);

wakeSynchronization();
reconcile();
