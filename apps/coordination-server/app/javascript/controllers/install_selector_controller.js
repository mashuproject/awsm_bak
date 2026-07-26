import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["root", "tab", "panel"]

  connect() {
    this.rootTarget.dataset.enhanced = "true"
    this.activate(this.tabTargets[0])
  }

  select(event) {
    this.activate(event.currentTarget)
  }

  activate(selected) {
    for (const tab of this.tabTargets) {
      const active = tab === selected
      tab.setAttribute("aria-selected", String(active))
      tab.tabIndex = active ? 0 : -1
    }
    for (const panel of this.panelTargets) {
      panel.hidden = panel.id !== selected.dataset.panel
    }
  }
}
