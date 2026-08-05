import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  fileURLToPath(new URL("../../../runtime-go/cmd/awsm/frontend/", import.meta.url)),
);

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/awsm/runtime/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(join(root, relative));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }
  try {
    statSync(path);
  } catch {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": path.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8",
  });
  createReadStream(path).pipe(response);
}).listen(4174, "127.0.0.1");
