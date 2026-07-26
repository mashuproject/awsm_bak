import { expect, type Page } from "@playwright/test";

interface ContrastFailure {
  readonly background: string;
  readonly contrast: number;
  readonly foreground: string;
  readonly minimum: number;
  readonly selector: string;
  readonly text: string;
}

export async function expectReadableContrast(page: Page): Promise<void> {
  const failures = await page.locator("body").evaluate((body) => {
    const parseColor = (value: string): [number, number, number, number] | undefined => {
      const match = value.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u,
      );
      if (match === null) return undefined;
      return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? 1 : Number(match[4]),
      ];
    };
    const composite = (
      foreground: [number, number, number, number],
      background: [number, number, number, number],
    ): [number, number, number, number] => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) /
          alpha,
        alpha,
      ];
    };
    const effectiveBackground = (element: Element): [number, number, number, number] => {
      let background: [number, number, number, number] = [255, 255, 255, 1];
      const layers: [number, number, number, number][] = [];
      for (
        let current: Element | null = element;
        current !== null;
        current = current.parentElement
      ) {
        const layer = parseColor(getComputedStyle(current).backgroundColor);
        if (layer !== undefined && layer[3] > 0) layers.push(layer);
      }
      for (const layer of layers.reverse()) background = composite(layer, background);
      return background;
    };
    const luminance = ([red, green, blue]: readonly [number, number, number, number]): number => {
      const linearize = (channel: number): number => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
    };
    const ratio = (
      foreground: [number, number, number, number],
      background: [number, number, number, number],
    ): number => {
      const foregroundLuminance = luminance(composite(foreground, background));
      const backgroundLuminance = luminance(background);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    };
    const selector = (element: Element): string => {
      if (element.id !== "") return `#${CSS.escape(element.id)}`;
      const classes = [...element.classList].slice(0, 2).map((name) => `.${CSS.escape(name)}`);
      return `${element.localName}${classes.join("")}`;
    };
    const compact = [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "label",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      ".eyebrow",
      ".awsm-badge",
    ].join(",");
    const results: ContrastFailure[] = [];
    for (const element of body.querySelectorAll("*")) {
      const directText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replaceAll(/\s+/gu, " ")
        .trim();
      if (directText === "") continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0
      )
        continue;
      const foreground = parseColor(style.color);
      if (foreground === undefined) continue;
      const background = effectiveBackground(element);
      const contrast = ratio(foreground, background);
      const minimum = element.closest(compact) === null ? 7 : 4.5;
      if (contrast + Number.EPSILON < minimum) {
        results.push({
          background: `rgb(${background.slice(0, 3).map(Math.round).join(" ")})`,
          contrast: Number(contrast.toFixed(2)),
          foreground: style.color,
          minimum,
          selector: selector(element),
          text: directText.slice(0, 80),
        });
      }
    }
    return results;
  });
  expect(failures, "visible text must satisfy the AWSM WCAG contrast contract").toEqual([]);
}
