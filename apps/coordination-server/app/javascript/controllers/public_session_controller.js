import { Controller } from "@hotwired/stimulus";

const HINT_COOKIE = "awsm_browser_session_hint";
const statusRequests = new Map();

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

function validStatusPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.authenticated === false) return Object.keys(payload).length === 1;
  if (payload.authenticated !== true) return false;

  const keys = Object.keys(payload).sort();
  const account = payload.account;
  return (
    keys.join(",") === "account,authenticated,csrfToken" &&
    account &&
    typeof account === "object" &&
    !Array.isArray(account) &&
    Object.keys(account).length === 1 &&
    typeof account.email === "string" &&
    account.email.length > 0 &&
    typeof payload.csrfToken === "string" &&
    payload.csrfToken.length > 0
  );
}

async function requestStatus(hint) {
  const response = await fetch("/session/status", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Session status failed");

  const payload = await response.json();
  if (!validStatusPayload(payload)) throw new Error("Session status was malformed");
  return payload;
}

function statusFor(hint) {
  if (statusRequests.has(hint)) return statusRequests.get(hint);

  const pending = requestStatus(hint).catch((error) => {
    statusRequests.delete(hint);
    throw error;
  });
  statusRequests.set(hint, pending);
  return pending;
}

export default class extends Controller {
  static targets = [
    "headerAccountLink",
    "footerAccountLink",
    "banner",
    "email",
    "accountLink",
    "setupSyncLink",
    "signOutForm",
  ];

  connect() {
    this.connected = true;
    this.showAnonymous();

    const hint = readCookie(HINT_COOKIE);
    if (!hint) return;

    this.showLoading();
    statusFor(hint)
      .then((payload) => {
        if (!this.connected || readCookie(HINT_COOKIE) !== hint) return;
        if (payload.authenticated) this.showAuthenticated(payload);
        else this.showAnonymous();
      })
      .catch(() => {
        if (this.connected) this.showAnonymous();
      });
  }

  disconnect() {
    this.connected = false;
  }

  showLoading() {
    if (!this.hasBannerTarget) return;

    this.bannerTarget.hidden = false;
    this.bannerTarget.setAttribute("aria-hidden", "true");
    this.bannerTarget.setAttribute("aria-busy", "true");
    this.bannerTarget.classList.add("signed-in-banner--loading");
  }

  showAnonymous() {
    for (const target of [this.headerAccountLinkTarget, this.footerAccountLinkTarget]) {
      target.textContent = "Sign in";
      target.href = "/session/new";
      target.removeAttribute("aria-label");
    }

    if (!this.hasBannerTarget) return;
    this.bannerTarget.hidden = true;
    this.bannerTarget.setAttribute("aria-hidden", "true");
    this.bannerTarget.removeAttribute("aria-busy");
    this.bannerTarget.classList.remove("signed-in-banner--loading");
    if (this.hasEmailTarget) this.emailTarget.textContent = "";
    if (this.hasSignOutFormTarget) this.signOutFormTarget.replaceChildren();
  }

  showAuthenticated(payload) {
    for (const target of [this.headerAccountLinkTarget, this.footerAccountLinkTarget]) {
      target.textContent = "Account";
      target.href = "/account";
      target.setAttribute("aria-label", `Account for ${payload.account.email}`);
    }

    if (!this.hasBannerTarget) return;
    this.emailTarget.textContent = payload.account.email;
    this.signOutFormTarget.replaceChildren(this.buildSignOutForm(payload.csrfToken));
    this.bannerTarget.hidden = false;
    this.bannerTarget.setAttribute("aria-hidden", "false");
    this.bannerTarget.removeAttribute("aria-busy");
    this.bannerTarget.classList.remove("signed-in-banner--loading");
  }

  buildSignOutForm(csrfToken) {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/session";
    form.className = "button_to";

    form.append(
      this.hiddenInput("_method", "delete"),
      this.hiddenInput("authenticity_token", csrfToken),
    );

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "awsm-button awsm-button--quiet";
    button.textContent = "Sign out";
    form.append(button);
    return form;
  }

  hiddenInput(name, value) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    return input;
  }
}
