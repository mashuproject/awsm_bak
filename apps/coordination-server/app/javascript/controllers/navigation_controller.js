import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["menu", "toggle"]

  connect() {
    this.closeOnWide = window.matchMedia("(min-width: 901px)")
    this.closeOnWide.addEventListener("change", this.reset)
  }

  disconnect() {
    this.closeOnWide.removeEventListener("change", this.reset)
  }

  toggle() {
    const open = this.menuTarget.dataset.open !== "true"
    this.menuTarget.dataset.open = String(open)
    this.toggleTarget.setAttribute("aria-expanded", String(open))
  }

  reset = () => {
    this.menuTarget.removeAttribute("data-open")
    this.toggleTarget.setAttribute("aria-expanded", "false")
  }
}
