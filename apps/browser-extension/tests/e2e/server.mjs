import { createServer } from "node:http";

const fixture = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><link rel="icon" href="data:,"><title>AWSM tall fixture</title>
<style>
html,body{margin:0} body{font:20px sans-serif} header{position:fixed;inset:0 0 auto;height:60px;background:#111;color:#fff;z-index:5}
.band{height:700px;display:grid;place-items:center}.red{background:#d43b32}.green{background:#2f9d58}.blue{background:#3269cf}
</style></head><body data-archive-script="not-executed">
<header>Fixed header appears once</header><main><section class="band red">red landmark</section><section class="band green"><p>green landmark</p></section><section class="band blue">blue landmark</section></main>
<script>document.body.dataset.liveFixture = "executed-only-on-live-page";</script></body></html>`;

createServer((request, response) => {
  if (request.url === "/api/server-information") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        service: "AWSM Coordination Server",
        protocolVersion: "1",
        capabilities: {
          accountPassword: true,
          accountVaultLimit: 1,
          completeReplicaSynchronization: true,
        },
      }),
    );
    return;
  }
  if (request.url === "/fixture") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture);
    return;
  }
  response.writeHead(404);
  response.end("not found");
}).listen(4174, "127.0.0.1");
