import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  connect() {
    window.addEventListener("hashchange", this.reveal);
    document.fonts.ready.then(this.reveal);
  }

  disconnect() {
    window.removeEventListener("hashchange", this.reveal);
  }

  preview(event) {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;

    this.removePreview();
    const target = document.getElementById(link.hash.slice(1));
    if (!target || !this.element.contains(target)) return;

    target.classList.add("is-previewed");
    this.previewedTarget = target;
  }

  clearPreview(event) {
    const link = event.target.closest('a[href^="#"]');
    if (link?.contains(event.relatedTarget)) return;

    this.removePreview();
  }

  reveal = () => {
    const identifier = window.location.hash.slice(1);
    if (!identifier) return;

    const target = document.getElementById(identifier);
    if (!target || !this.element.contains(target)) return;

    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  };

  removePreview() {
    this.previewedTarget?.classList.remove("is-previewed");
    this.previewedTarget = null;
  }
}
