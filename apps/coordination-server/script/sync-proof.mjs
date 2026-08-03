import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const primaryBaseUrl = process.env.AWSM_PROOF_BASE_URL;
const peerBaseUrl = process.env.AWSM_PROOF_PEER_BASE_URL;
assert(primaryBaseUrl, "AWSM_PROOF_BASE_URL is required");
assert(peerBaseUrl, "AWSM_PROOF_PEER_BASE_URL is required");

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
  return {
    bytes: Buffer.concat([prefix, header, payload]),
    ciphertextDigest,
  };
}

async function request(
  baseUrl,
  credential,
  method,
  path,
  body,
  { expected = [200], headers: extraHeaders = {} } = {},
) {
  const requestId = randomUUID();
  const headers = {
    "Awsm-Protocol-Version": "1",
    "Awsm-Request-ID": requestId,
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
  assert.match(response.headers.get("Awsm-Request-ID") ?? "", /^[0-9a-f-]{36}$/u);
  const payload = response.status === 204 ? null : await response.json();
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${path}: expected ${expected}, got ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return { payload, response };
}

async function signUpAndSignIn(prefix) {
  const username = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 19)}`;
  const password = `opaque host proof ${randomUUID()}`;
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
  assert.equal(session.account.username, username);
  return { username, password, session };
}

const owner = await signUpAndSignIn("proof_owner");
const refreshed = (
  await request(primaryBaseUrl, undefined, "POST", "/api/session/refresh", {
    refresh_token: owner.session.refresh_token,
  })
).payload;
assert.equal(refreshed.account.username, owner.username);
assert.equal(refreshed.session_id, owner.session.session_id);

const replica = (
  await request(
    primaryBaseUrl,
    refreshed.access_token,
    "POST",
    "/api/replicas",
    {},
    {
      expected: [201],
    },
  )
).payload;
assert.match(replica.replica_handle, /^[0-9a-f-]{36}$/u);
assert.match(replica.locator_salt, /^[A-Za-z0-9_-]{43}$/u);
assert.deepEqual(replica.capabilities, [
  "awsm.replica.hint.read",
  "awsm.replica.hint.write",
  "awsm.replica.inventory.read",
  "awsm.replica.item.read",
  "awsm.replica.item.write",
  "awsm.replica.manage",
]);
assert.equal(replica.stored_bytes, 0);
assert.equal(replica.quota_bytes, null);

const listed = (await request(primaryBaseUrl, refreshed.access_token, "GET", "/api/replicas"))
  .payload;
assert.deepEqual(listed.replicas, [replica]);

const reader = await signUpAndSignIn("proof_reader");
const unavailable = await request(
  primaryBaseUrl,
  reader.session.access_token,
  "GET",
  `/api/replicas/${replica.replica_handle}/inventory`,
  undefined,
  { expected: [404] },
);
assert.equal(unavailable.payload.outcome, "replica_not_found");

const grant = (
  await request(
    primaryBaseUrl,
    refreshed.access_token,
    "POST",
    `/api/replicas/${replica.replica_handle}/grants`,
    {
      username: reader.username,
      capabilities: [
        "awsm.replica.hint.read",
        "awsm.replica.inventory.read",
        "awsm.replica.item.read",
      ],
      grantable_capabilities: [],
    },
    { expected: [201] },
  )
).payload;
assert.equal(grant.replica_handle, replica.replica_handle);
assert.equal(grant.username, reader.username);

const readerReplicas = (
  await request(primaryBaseUrl, reader.session.access_token, "GET", "/api/replicas")
).payload;
assert.deepEqual(readerReplicas.replicas, [{ ...replica, capabilities: grant.capabilities }]);

const opaque = compactEnvelope(Buffer.alloc(16, 0x5a));
const itemId = storageItemId(opaque.bytes);
const locator = digest(Buffer.concat([Buffer.from("proof locator\0"), itemId]));
const admitted = (
  await request(
    primaryBaseUrl,
    refreshed.access_token,
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
  )
).payload;
assert.deepEqual(admitted, {
  storage_item_id: base64Url(itemId),
  byte_length: opaque.bytes.byteLength,
  admission: "stored",
  hint_cursor: 1,
});

const hint = (
  await request(
    peerBaseUrl,
    reader.session.access_token,
    "GET",
    `/api/replicas/${replica.replica_handle}/hint`,
  )
).payload;
assert.deepEqual(hint, { hint_cursor: 1 });
const inventory = (
  await request(
    peerBaseUrl,
    reader.session.access_token,
    "GET",
    `/api/replicas/${replica.replica_handle}/inventory?limit=1`,
  )
).payload;
assert.equal(inventory.snapshot_cursor, 1);
assert.equal(inventory.next_position, null);
assert.deepEqual(inventory.items, [
  {
    storage_item_id: base64Url(itemId),
    locator: base64Url(locator),
    storage_class: "compact",
    byte_length: opaque.bytes.byteLength,
    ciphertext_digest: base64Url(opaque.ciphertextDigest),
  },
]);

const read = await fetch(
  `${peerBaseUrl}/api/replicas/${replica.replica_handle}/items/${base64Url(itemId)}`,
  {
    headers: {
      Authorization: `Bearer ${reader.session.access_token}`,
      "Awsm-Protocol-Version": "1",
      "Awsm-Request-ID": randomUUID(),
    },
  },
);
assert.equal(read.status, 200);
assert.equal(read.headers.get("Awsm-Storage-Item-ID"), base64Url(itemId));
assert.equal(read.headers.get("Awsm-Storage-Class"), "compact");
assert.deepEqual(Buffer.from(await read.arrayBuffer()), opaque.bytes);

const writeDenied = await request(
  peerBaseUrl,
  reader.session.access_token,
  "POST",
  `/api/replicas/${replica.replica_handle}/hint`,
  {},
  { expected: [403] },
);
assert.equal(writeDenied.payload.outcome, "access_denied");

await request(
  primaryBaseUrl,
  refreshed.access_token,
  "DELETE",
  `/api/replicas/${replica.replica_handle}/grants/${grant.grant_id}`,
  undefined,
  { expected: [204] },
);
const revoked = await request(
  peerBaseUrl,
  reader.session.access_token,
  "GET",
  `/api/replicas/${replica.replica_handle}/inventory`,
  undefined,
  { expected: [404] },
);
assert.equal(revoked.payload.outcome, "replica_not_found");

process.stdout.write(
  "opaque Hosted Replica proof rotated a Host session, enforced Grant isolation, and transferred only verified opaque bytes across Host processes\n",
);
