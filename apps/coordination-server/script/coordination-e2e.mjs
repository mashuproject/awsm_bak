import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const primaryBaseUrl = process.env.AWSM_COORDINATION_E2E_BASE_URL;
const peerBaseUrl = process.env.AWSM_COORDINATION_E2E_PEER_BASE_URL;
const composeFile = process.env.AWSM_COORDINATION_E2E_COMPOSE_FILE;
assert(primaryBaseUrl, "AWSM_COORDINATION_E2E_BASE_URL is required");
assert(peerBaseUrl, "AWSM_COORDINATION_E2E_PEER_BASE_URL is required");
assert(composeFile, "AWSM_COORDINATION_E2E_COMPOSE_FILE is required");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function storageItemId(bytes) {
  const framing = Buffer.alloc(12);
  framing.writeUInt32BE(1, 0);
  framing.writeBigUInt64BE(BigInt(bytes.byteLength), 4);
  return digest(Buffer.concat([Buffer.from("awsm:storage-item-id:v1\0"), framing, bytes]));
}

function compactEnvelope(payload) {
  const ciphertextDigest = digest(payload);
  const header = Buffer.concat([
    Buffer.from([0xa6, 0x00, 0x01, 0x01, 0x01, 0x02, 0x58, 0x40]),
    randomBytes(64),
    Buffer.from([0x03, payload.byteLength, 0x04, 0x58, 0x20]),
    ciphertextDigest,
    Buffer.from([0x05, 0x00]),
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write("AWSMSE\x01\x00", 0, "binary");
  prefix.writeUInt32BE(header.byteLength, 8);
  return { bytes: Buffer.concat([prefix, header, payload]), ciphertextDigest };
}

function compose(...args) {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
}

async function request(
  baseUrl,
  credential,
  method,
  path,
  body,
  { expected = [200], headers: extraHeaders = {} } = {},
) {
  const headers = {
    "Awsm-Protocol-Version": "1",
    "Awsm-Request-ID": randomUUID(),
    ...extraHeaders,
  };
  if (credential !== undefined) headers.Authorization = `Bearer ${credential}`;
  if (body !== undefined && !(body instanceof Uint8Array))
    headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  assert.equal(response.headers.get("Awsm-Protocol-Version"), "1");
  const payload = response.status === 204 ? null : await response.json();
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${path}: expected ${expected}, got ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return { payload, response };
}

async function assertReady(baseUrl) {
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ready",
    components: { database: "ready", opaqueByteStorage: "ready" },
  });
}

const username = `e2e_owner_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
const password = `opaque continuity proof ${randomUUID()}`;
const signup = await fetch(`${primaryBaseUrl}/sign_up`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    "account[username]": username,
    "account[password]": password,
    "account[password_confirmation]": password,
  }),
  redirect: "manual",
});
assert.equal(signup.status, 302);
const session = (
  await request(primaryBaseUrl, undefined, "POST", "/api/sessions", { username, password })
).payload;

await assertReady(primaryBaseUrl);
await assertReady(peerBaseUrl);
const replica = (
  await request(
    primaryBaseUrl,
    session.access_token,
    "POST",
    "/api/replicas",
    {},
    {
      expected: [201],
    },
  )
).payload;
const opaque = compactEnvelope(Buffer.alloc(16, 0x6b));
const itemId = storageItemId(opaque.bytes);
const locator = digest(Buffer.concat([Buffer.from("e2e locator\0"), itemId]));
await request(
  primaryBaseUrl,
  session.access_token,
  "PUT",
  `/api/replicas/${replica.replica_handle}/items/${base64Url(itemId)}`,
  opaque.bytes,
  {
    expected: [201],
    headers: {
      "Content-Type": "application/octet-stream",
      "Awsm-Opaque-Locator": base64Url(locator),
    },
  },
);

const peerBeforeStop = (
  await request(
    peerBaseUrl,
    session.access_token,
    "GET",
    `/api/replicas/${replica.replica_handle}/inventory`,
  )
).payload;
assert.equal(peerBeforeStop.snapshot_cursor, 1);
assert.deepEqual(
  peerBeforeStop.items.map((item) => item.storage_item_id),
  [base64Url(itemId)],
);

compose("stop", "coordination-e2e");
await assertReady(peerBaseUrl);
const peerItem = await fetch(
  `${peerBaseUrl}/api/replicas/${replica.replica_handle}/items/${base64Url(itemId)}`,
  {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Awsm-Protocol-Version": "1",
      "Awsm-Request-ID": randomUUID(),
    },
  },
);
assert.equal(peerItem.status, 200);
assert.deepEqual(Buffer.from(await peerItem.arrayBuffer()), opaque.bytes);

compose("up", "--detach", "--wait", "coordination-e2e");
await assertReady(primaryBaseUrl);
const primaryAfterRestart = (
  await request(
    primaryBaseUrl,
    session.access_token,
    "GET",
    `/api/replicas/${replica.replica_handle}/inventory`,
  )
).payload;
assert.deepEqual(primaryAfterRestart, peerBeforeStop);

process.stdout.write(
  "coordination E2E preserved opaque Hosted Replica access and bytes across independent Host-process failover and restart\n",
);
