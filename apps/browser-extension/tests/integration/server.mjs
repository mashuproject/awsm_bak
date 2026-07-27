import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("../../.output/integration/", import.meta.url).pathname;
const dependencyRoots = {
  "/vendor/cborg/": `${realpathSync(new URL("../../node_modules/cborg", import.meta.url).pathname)}/`,
  "/vendor/noble-hashes/": `${realpathSync(new URL("../../node_modules/@noble/hashes", import.meta.url).pathname)}/`,
  "/vendor/libsodium-wrappers-sumo/": `${realpathSync(new URL("../../node_modules/libsodium-wrappers-sumo", import.meta.url).pathname)}/`,
  "/vendor/libsodium-sumo/": `${realpathSync(new URL("../../../../node_modules/.pnpm/libsodium-sumo@0.8.4/node_modules/libsodium-sumo", import.meta.url).pathname)}/`,
  "/vendor/zipjs/": `${realpathSync(new URL("../../node_modules/@zip.js/zip.js", import.meta.url).pathname)}/`,
  "/vendor/transformers/": `${realpathSync(new URL("../../node_modules/@huggingface/transformers/dist", import.meta.url).pathname)}/`,
  "/vendor/onnxruntime/": `${realpathSync(new URL("../../node_modules/onnxruntime-web/dist", import.meta.url).pathname)}/`,
  "/vendor/onnxruntime-common/": `${realpathSync(new URL("../../../../node_modules/.pnpm/onnxruntime-common@1.24.0-dev.20251116-b39e144322/node_modules/onnxruntime-common", import.meta.url).pathname)}/`,
};
const modelProofRoot = process.env.AWSM_SEARCH_MODEL_PROOF_DIR;
if (modelProofRoot !== undefined) dependencyRoots["/model/"] = `${realpathSync(modelProofRoot)}/`;

const index = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>AWSM integration harness</title>
  <script type="importmap">{"imports":{"@huggingface/transformers":"/vendor/transformers/transformers.web.js","onnxruntime-web/webgpu":"/vendor/onnxruntime/ort.webgpu.min.mjs","onnxruntime-common":"/vendor/onnxruntime-common/dist/esm/index.js","@zip.js/zip.js":"/vendor/zipjs/index.js","@noble/hashes/sha2.js":"/vendor/noble-hashes/sha2.js","cborg":"/vendor/cborg/cborg.js","libsodium-wrappers-sumo":"/vendor/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-wrappers.mjs","libsodium-sumo":"/vendor/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs"}}</script></head>
  <body><output id="result" aria-live="polite">running</output>
  <script type="module" src="/tests/integration/browser/harness.js"></script></body>
</html>`;

const types = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(index);
    return;
  }
  const dependency = Object.entries(dependencyRoots).find(([prefix]) =>
    url.pathname.startsWith(prefix),
  );
  const selectedRoot = dependency?.[1] ?? root;
  const relative = normalize(
    dependency === undefined ? url.pathname : url.pathname.slice(dependency[0].length),
  ).replace(/^[/\\]+/u, "");
  let path = join(selectedRoot, relative);
  if (existsSync(path) && statSync(path).isDirectory()) {
    response.writeHead(302, { location: `${url.pathname.replace(/\/$/u, "")}/index.js` });
    response.end();
    return;
  } else if (!existsSync(path) && extname(path) === "") {
    path = `${path}.js`;
  }
  if (!path.startsWith(selectedRoot) || !existsSync(path)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": types[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
}).listen(4173, "127.0.0.1");
