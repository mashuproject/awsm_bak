import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const designPath = resolve(repositoryRoot, "DESIGN.md");
const outputPath = resolve(packageRoot, "src/tokens.css");
const checkOnly = process.argv.includes("--check");

const source = await readFile(designPath, "utf8");
const match = source.match(/^---\n([\s\S]*?)\n---\n/);
if (match === null)
  throw new Error("DESIGN.md must begin with YAML front matter.");
const design = parse(match[1]);

for (const group of [
  "colors",
  "typography",
  "rounded",
  "spacing",
  "components",
  "contrast",
]) {
  if (design[group] === null || typeof design[group] !== "object") {
    throw new Error(`DESIGN.md is missing the required ${group} token group.`);
  }
}

function colorTokenReference(value, context) {
  const match = /^\{colors\.([a-zA-Z0-9-]+)\}$/.exec(value);
  if (match === null || typeof design.colors[match[1]] !== "string") {
    throw new Error(`${context} must reference one declared color token.`);
  }
  return match[1];
}

function relativeLuminance(value, context) {
  if (!/^#[0-9A-F]{6}$/i.test(value)) {
    throw new Error(`${context} must be a six-digit hexadecimal color.`);
  }
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foregroundName, backgroundName, context) {
  const foreground = relativeLuminance(
    design.colors[foregroundName],
    `${context} foreground`,
  );
  const background = relativeLuminance(
    design.colors[backgroundName],
    `${context} background`,
  );
  return (
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05)
  );
}

function requireContrast(foregroundName, backgroundName, minimum, context) {
  const ratio = contrastRatio(foregroundName, backgroundName, context);
  if (ratio + Number.EPSILON < minimum) {
    throw new Error(
      `${context} contrast is ${ratio.toFixed(2)}:1; required minimum is ${minimum}:1.`,
    );
  }
}

const normalTextMinimum = Number(design.contrast.normalTextMinimum);
const extendedTextMinimum = Number(design.contrast.extendedTextMinimum);
if (
  !Number.isFinite(normalTextMinimum) ||
  normalTextMinimum < 4.5 ||
  !Number.isFinite(extendedTextMinimum) ||
  extendedTextMinimum < 7
) {
  throw new Error(
    "DESIGN.md contrast thresholds must be at least 4.5:1 for normal text and 7:1 for extended text.",
  );
}
const extendedTextComponents = new Set(
  design.contrast.extendedTextComponents,
);
for (const [name, component] of Object.entries(design.components)) {
  if (component.backgroundColor === undefined || component.textColor === undefined)
    continue;
  const foreground = colorTokenReference(
    component.textColor,
    `components.${name}.textColor`,
  );
  const background = colorTokenReference(
    component.backgroundColor,
    `components.${name}.backgroundColor`,
  );
  requireContrast(
    foreground,
    background,
    extendedTextComponents.has(name)
      ? extendedTextMinimum
      : normalTextMinimum,
    `Component ${name}`,
  );
}
for (const [index, pair] of design.contrast.auditedPairs.entries()) {
  if (
    typeof pair.foreground !== "string" ||
    typeof pair.background !== "string" ||
    design.colors[pair.foreground] === undefined ||
    design.colors[pair.background] === undefined ||
    !Number.isFinite(Number(pair.minimum))
  ) {
    throw new Error(`contrast.auditedPairs[${index}] is malformed.`);
  }
  requireContrast(
    pair.foreground,
    pair.background,
    Number(pair.minimum),
    `Audited pair ${pair.use ?? index}`,
  );
}

function tokenName(value) {
  return String(value)
    .replaceAll(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
}

function cssValue(value) {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string")
    throw new Error(`Unsupported primitive token value: ${value}`);
  return value.replaceAll(/\{([a-zA-Z0-9_.-]+)\}/g, (_whole, path) => {
    const parts = path.split(".");
    if (parts.length !== 2)
      throw new Error(`Unsupported token reference: {${path}}`);
    const [group, key] = parts;
    if (design[group]?.[key] === undefined)
      throw new Error(`Unresolved token reference: {${path}}`);
    return `var(--awsm-${tokenName(key)})`;
  });
}

const lines = [
  "/* Generated from DESIGN.md. Do not edit directly. */",
  ":root {",
  ...Object.entries(design.colors).map(
    ([name, value]) => `  --awsm-${tokenName(name)}: ${cssValue(value)};`,
  ),
  ...Object.entries(design.spacing).map(
    ([name, value]) => `  --awsm-space-${tokenName(name)}: ${cssValue(value)};`,
  ),
  ...Object.entries(design.rounded).map(
    ([name, value]) =>
      `  --awsm-radius-${tokenName(name)}: ${cssValue(value)};`,
  ),
  "  --awsm-border: 2px solid var(--awsm-ink);",
  "  --awsm-shadow-hard: 4px 4px 0 var(--awsm-ink);",
  "  --awsm-duration-press: 80ms;",
  "  --awsm-duration-component: 180ms;",
  "  --awsm-duration-reveal: 420ms;",
  "  --awsm-duration-hero: 900ms;",
  "  --awsm-ease-out: cubic-bezier(0.16, 1, 0.3, 1);",
  "  --awsm-ease-expressive: cubic-bezier(0.34, 1.56, 0.64, 1);",
  "}",
  ...Object.entries(design.typography).flatMap(([name, value]) => [
    `.awsm-type-${tokenName(name)} {`,
    `  font-family: ${cssValue(value.fontFamily)};`,
    `  font-size: ${cssValue(value.fontSize)};`,
    `  font-weight: ${cssValue(value.fontWeight)};`,
    `  line-height: ${cssValue(value.lineHeight)};`,
    `  letter-spacing: ${cssValue(value.letterSpacing)};`,
    "}",
  ]),
  "",
].join("\n");

const fontPath = resolve(
  packageRoot,
  "assets/fonts/bricolage-grotesque-latin-wght-normal.woff2",
);
const licensePath = resolve(packageRoot, "assets/fonts/OFL.txt");
await Promise.all([readFile(fontPath), readFile(licensePath, "utf8")]);

if (checkOnly) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== lines)
    throw new Error("Generated design tokens are stale. Run design:generate.");
} else {
  await writeFile(outputPath, lines);
}
