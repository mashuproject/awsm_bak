async function loadReport(): Promise<unknown> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const report = await browser.runtime.sendMessage({
      type: "awsm:get-firefox-feasibility-report",
    });
    if (report !== undefined) return report;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The Firefox feasibility report was not produced within 30 seconds.");
}

const output = document.querySelector("#report");
if (!(output instanceof HTMLElement)) throw new Error("The report output is missing.");
const report = await loadReport();
output.dataset.ready = "true";
output.textContent = JSON.stringify(report, null, 2);

export {};
