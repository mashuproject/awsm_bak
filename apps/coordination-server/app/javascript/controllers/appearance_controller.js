import { Controller } from "@hotwired/stimulus"

const STORAGE_KEY = "awsm.appearance"

export default class extends Controller {
  static targets = ["select"]

  connect() {
    this.mode = this.readMode()
    if (this.hasSelectTarget) this.selectTarget.value = this.mode
    this.apply()
    this.media = window.matchMedia("(prefers-color-scheme: dark)")
    this.onMediaChange = () => {
      if (this.mode === "system") this.apply()
    }
    this.media.addEventListener("change", this.onMediaChange)
  }

  disconnect() {
    this.media?.removeEventListener("change", this.onMediaChange)
  }

  change(event) {
    const next = event.target.value
    this.mode = ["system", "light", "dark"].includes(next) ? next : "system"
    window.localStorage.setItem(STORAGE_KEY, this.mode)
    this.apply()
  }

  readMode() {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return ["system", "light", "dark"].includes(stored) ? stored : "system"
  }

  apply() {
    if (this.mode === "system") {
      document.documentElement.removeAttribute("data-awsm-theme")
      document.documentElement.style.colorScheme = "light dark"
    } else {
      document.documentElement.dataset.awsmTheme = this.mode
      document.documentElement.style.colorScheme = this.mode
    }
  }
}
