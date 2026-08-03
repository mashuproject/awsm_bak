import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type createServer as createHttpServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface EphemeralHttpsProxy {
  readonly endpoint: string;
  close(): Promise<void>;
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Ephemeral HTTPS proxy did not bind TCP.");
  }
  return address.port;
}

async function close(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/**
 * Terminates a self-signed, loopback-only TLS connection for browser proof. Production adapters
 * still receive a canonical HTTPS endpoint; only this local test bridge forwards to the HTTP
 * Rails proof origin.
 */
export async function startEphemeralHttpsProxy(input: {
  readonly origin: string;
}): Promise<EphemeralHttpsProxy> {
  const origin = new URL(input.origin);
  if (origin.protocol !== "http:" || origin.pathname !== "/" || origin.search !== "") {
    throw new TypeError("Ephemeral HTTPS proxy requires a canonical HTTP origin URL");
  }
  const directory = await mkdtemp(join(tmpdir(), "awsm-hosted-recovery-"));
  const keyPath = join(directory, "key.pem");
  const certificatePath = join(directory, "certificate.pem");
  try {
    await execFile("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]);
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
    const server = createHttpsServer({ key, cert }, (incoming, outgoing) => {
      const upstream = request(
        {
          protocol: origin.protocol,
          hostname: origin.hostname,
          port: origin.port,
          method: incoming.method,
          path: incoming.url ?? "/",
          headers: { ...incoming.headers, host: origin.host },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.once("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    });
    const port = await listen(server);
    return {
      endpoint: `https://127.0.0.1:${port}/`,
      async close(): Promise<void> {
        try {
          await close(server);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
