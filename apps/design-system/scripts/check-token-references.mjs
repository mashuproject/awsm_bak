import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

export function findUnknownTokenReferences(css, declaredTokens) {
  const references = new Set(
    [...css.matchAll(/var\(\s*(--awsm-[a-z0-9-]+)/g)].map((match) => match[1]),
  );

  return [...references].filter((reference) => !declaredTokens.has(reference)).sort();
}

async function cssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await cssFiles(path)));
    else if (entry.isFile() && extname(entry.name) === ".css") files.push(path);
  }

  return files;
}

async function run() {
  const files = await cssFiles(repositoryRoot);
  const declaredTokens = new Set();
  const contents = new Map();

  for (const file of files) {
    const css = await readFile(file, "utf8");
    contents.set(file, css);
    for (const match of css.matchAll(/(--awsm-[a-z0-9-]+)\s*:/g)) declaredTokens.add(match[1]);
  }

  const findings = [];
  for (const [file, css] of contents) {
    for (const token of findUnknownTokenReferences(css, declaredTokens)) {
      findings.push(`${file.replace(`${repositoryRoot}/`, "")}: ${token}`);
    }
  }

  if (findings.length > 0) {
    throw new Error(`Unknown AWSM design token references:\n${findings.join("\n")}`);
  }

  process.stdout.write(`Checked ${files.length} CSS files; all AWSM token references are declared.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
